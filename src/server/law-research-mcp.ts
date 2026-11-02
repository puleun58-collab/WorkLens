import { asksLawSystem, sameLawFamily } from "@/lib/research-scope";
import { lawNamesInQuery, parseExplicitIdentities } from "@/lib/law-identity";
import { citesParent } from "@/lib/research-citations";
import { followupDetailText, retrieveResearchFollowup } from "@/server/research-followup";
import { mcpAnnexReader, retrieveAnnexes } from "@/server/research-annex";
import type { EvidenceArticle, InterpretationFailure, IssueEvidence, LawCurrency, LawResearchAbsent, LawResearchData, LawResearchRequest, ResearchIssue } from "@/lib/law-research";
import type { LawRequestStats } from "@/lib/law-observability";
import { researchResult, type ResearchDecision } from "@/lib/law-research-parse";
import {
  isLawName, questionTermsRelationLess, questionSubjectTerms, questionTerms, questionTermsSubjectLess, rankPrecedent, relationshipSupported, researchDecisionDomain, researchEvidenceSources, titleMatches,
  type PrecedentRelevance, type ResearchAdoptionCandidate, type ResearchAdoptionVerdict, type ResearchEnrichment, type SupplementArticle,
} from "@/lib/research-relevance";
import { assessProcedureEvidence } from "@/lib/procedure-evidence";
import { classifyLawToolResult } from "@/server/law-analysis-mcp";
import { callLawTool, searchLaw } from "@/server/law-mcp";
import { mcpReviewSources, reviewContract } from "@/server/contract-review";
import { interpretResearchQuery, verifyResearchAdoption } from "@/server/groq";
import { ApiError } from "@/server/http";
import {
  enrichResearch, explicitArticlePairs, lookupIssue, mcpEnrichmentSources, rereadShownArticles, sharedSources,
  type EnrichmentSources, type IssueLookup,
} from "@/server/research-enrichment";
import { compareOrdinances, mcpOrdinanceSources } from "@/server/ordinance-compare";
import { assessActionBasis } from "@/lib/action-basis-evidence";
import { assessAmendment } from "@/lib/amendment-evidence";
import { assessDispute } from "@/lib/dispute-evidence";
import { assessLawSystem, delegatingDetailBlocks, askedArticles } from "@/lib/law-system-evidence";
import { integratedEvidenceStatus } from "@/lib/research-status";

const RESEARCH_FAILURE = "법령 리서치 서비스가 요청을 처리하지 못했습니다.";

/** 요청 단위 관측 누적(실제 MCP 재시도 횟수)을 함께 실어 보내는 요청 context. */
type ResearchContext = { requestId: string; signal?: AbortSignal; stats?: LawRequestStats };
const MAX_STATUS_LAWS = 4;
/** Every issue the combined answer did not cover shares this budget; one it cannot reach is reported, never dropped. */
const ISSUE_BUDGET_MS = 15_000;
/** The upstream search AND-matches words, so only a keyword-length question is usable as written. */
const SHORT_QUERY_TERMS = 4;
const EXCERPT_CHARS = 600;

/**
 * Whether each cited article is in force today. A law being `현행` does not make
 * the retrieved article text current: the search can return an older version's
 * body. So `current` requires the 시행일 printed on the retrieved text to be the
 * 시행일 of the law's current version, as the 법제처 index states it in the same
 * search response — no extra lookup. An older retrieved version is officially a
 * past version (`not_current`); missing or disagreeing version metadata can
 * confirm nothing (`unconfirmed`), and a failed lookup confirms nothing either.
 */
async function withCurrency(articles: Array<{ law: string; jo: string }>, text: string, enrichment: ResearchEnrichment | undefined,
  context: ResearchContext): Promise<EvidenceArticle[]> {
  if (!articles.length) return [];
  const effective = new Map<string, string>();
  for (const article of researchResult(text).sections.flatMap((section) => section.articles ?? [])) {
    if (article.effective) effective.set(`${article.law}\0${article.jo}`, article.effective.replace(/\D/gu, ""));
  }
  for (const article of enrichment?.supplement?.articles ?? []) {
    if (article.effectiveDate) effective.set(`${article.law}\0${article.jo}`, article.effectiveDate);
  }
  const chainKeys = new Set(researchResult(text).sections.flatMap((section) => section.articles ?? [])
    .map((article) => `${article.law}\0${article.jo}`));
  const supplementStage = new Map<string, "supplement" | "issue" | "reread" | "retry">((enrichment?.supplement?.articles ?? [])
    .map((article) => [`${article.law}\0${article.jo}`, article.stage ?? "supplement"] as const));
  // Version/stage metadata must belong to the exact selected original, not
  // another fetched body that happens to share law + article number.
  const selectedVersions = new Map<string, Set<string>>();
  const selectedStages = new Map<string, EvidenceArticle["stage"]>();
  for (const review of enrichment?.adoptionReviews ?? []) {
    if (!review.verification) continue;
    for (const article of review.articles) {
      if (!article.adopted) continue;
      const key = `${article.law}\0${article.jo}`;
      const dates = selectedVersions.get(key) ?? new Set<string>();
      dates.add(article.effectiveDate?.replace(/\D/gu, "") ?? "");
      selectedVersions.set(key, dates);
      if (["chain", "supplement", "issue", "reread", "retry"].includes(article.stage)) {
        selectedStages.set(key, article.stage as EvidenceArticle["stage"]);
      }
    }
  }
  for (const [key, dates] of selectedVersions) {
    if (dates.size === 1 && !dates.has("")) effective.set(key, [...dates][0]);
    else effective.delete(key);
  }
  const laws = [...new Set(articles.map((article) => article.law))].slice(0, MAX_STATUS_LAWS);
  const statuses = new Map(await Promise.all(laws.map(async (law) => {
    const found = await searchLaw(law, context).catch(() => undefined);
    const exact = found?.found ? found.laws.find((entry) => entry.name === law) : undefined;
    const versionDate = exact?.effectiveDate?.replace(/\D/gu, "");
    return [law, {
      status: exact?.status,
      ...(versionDate && versionDate.length === 8 ? { versionDate } : {}),
    }] as const;
  })));
  // Today in Korea, the calendar 시행일 are stated in.
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10).replaceAll("-", "");
  return articles.map((article) => {
    const { status, versionDate } = statuses.get(article.law) ?? {};
    const raw = effective.get(`${article.law}\0${article.jo}`);
    const date = raw && raw.length === 8 ? raw : undefined;
    const currency: LawCurrency = status === undefined ? "unconfirmed"
      : status !== "현행" ? "not_current"
      : date === undefined ? "unconfirmed"
      : date > today ? "upcoming"
      : versionDate === undefined ? "unconfirmed"
      : date === versionDate ? "current"
      : date < versionDate ? "not_current"
      : "unconfirmed";
    const key = `${article.law}\0${article.jo}`;
    return { ...article, currency, stage: selectedStages.get(key)
      ?? (chainKeys.has(key) ? "chain" as const : supplementStage.get(key) ?? "supplement" as const) };
  });
}

type ChainResult =
  | { kind: "found"; text: string; markers: string[]; enrichment?: ResearchEnrichment }
  | { kind: "absent"; text: string }
  | { kind: "failed"; error: unknown };

/**
 * Which of the known sources address one issue, judged by that issue's own terms: cases
 * are re-ranked from their (cached) summaries, articles by the shared excerpt rule.
 */
async function issueSources(
  issueQuery: string,
  chain: { text: string; enrichment?: ResearchEnrichment; listed: Map<string, ResearchDecision>;
    reviews: Map<string, NonNullable<ResearchEnrichment["adoptionReviews"]>[number]>;
    cases: Map<string, ResearchAdoptionCandidate> },
  lookup: IssueLookup | undefined,
  sources: EnrichmentSources,
  summaries: Map<string, string>,
  requestTerms: readonly string[] = [],
  fallback = false,
  originalQuery?: string,
): Promise<{ articles: Array<{ law: string; jo: string }>; precedents: string[]; decisions?: string[] }> {
  const terms = questionTerms(issueQuery);
  const relevance: Record<string, PrecedentRelevance> = {};
  await Promise.all(Object.keys(chain.enrichment?.precedents ?? {}).map(async (id) => {
    const summary = await sources.summary(id).catch(() => undefined);
    if (summary?.text) summaries.set(id, summary.text);
    if (summary?.text) chain.cases.set(`${id}\0${summary.text}`, { ...chain.listed.get(id),
      id: "", kind: "precedent", precedentId: id, text: summary.text, stage: "chain", partial: summary.excerpt });
    relevance[id] = rankPrecedent(terms, { title: chain.listed.get(id)?.title, ...(summary ? { summary: summary.text, excerpt: summary.excerpt } : {}) });
    if (summary?.excerpt) relevance[id] = { ...relevance[id], rank: "unknown" };
  }));
  for (const hit of lookup?.precedents ?? []) {
    summaries.set(hit.id, hit.summary);
    chain.cases.set(`${hit.id}\0${hit.summary}`, { id: "", kind: "precedent", precedentId: hit.id,
      title: hit.title, caseNumber: hit.caseNumber, body: hit.body, date: hit.date,
      text: hit.summary, stage: "issue", partial: hit.excerpt });
    relevance[hit.id] = rankPrecedent(terms, { title: hit.title, summary: hit.summary, excerpt: hit.excerpt });
    if (hit.excerpt) relevance[hit.id] = { ...relevance[hit.id], rank: "unknown" };
  }
  const supplement = [...(chain.enrichment?.supplement?.articles ?? []), ...(lookup?.articles ?? [])];
  return researchEvidenceSources(chain.text, issueQuery, {
    ...chain.enrichment,
    precedents: relevance,
    // Citation is judged on the summaries actually read for this issue, not on term lists alone.
    precedentExcerpts: Object.fromEntries(summaries),
    supplement: { status: supplement.length ? "found" : "none", articles: supplement },
  }, requestTerms, { fallback, originalQuery, review: (review) => {
    if (!review.articles.length && !review.precedents.length) return;
    const previous = chain.reviews.get(issueQuery);
    chain.reviews.set(issueQuery, { query: issueQuery,
      articles: [...new Map([...(previous?.articles ?? []), ...review.articles]
        .map((article) => [`${article.law}\0${article.jo}\0${article.stage}`, article])).values()],
      precedents: [...new Map([...(previous?.precedents ?? []), ...review.precedents].map((entry) => [entry.id, entry])).values()] });
  } });
}

async function fullResearch(
  query: string,
  context: ResearchContext,
): Promise<LawResearchData | LawResearchAbsent> {
  // An interpretation may be unavailable without taking away the original
  // question's existing search path. It never supplies factual evidence.
  // Groq logs the final failure once, with the request ID; this layer only selects the fallback.
  let interpretationFailure: InterpretationFailure | undefined;
  const interpretation = await interpretResearchQuery(query, context).catch((error: unknown) => {
    const failure = error instanceof ApiError ? error : undefined;
    interpretationFailure = failure?.code === "AI_RATE_LIMITED" ? "rate-limited"
      : failure?.code === "AI_TIMEOUT" ? "timeout" : "unavailable";
    return undefined;
  });
  if (context.signal?.aborted) throw new ApiError("LAW_REQUEST_ABORTED", "요청이 취소되었습니다.", 499);
  // A reading that found no issue to look into is itself the answer: searching the
  // raw sentence anyway adopted whatever merely shared a word with it (an unrelated
  // statute confirmed as "matched" for a question the reading called unidentifiable).
  // The follow-up question carries the response; no source is confirmed or denied.
  if (interpretation && !interpretation.issues.length) {
    return { found: false, task: "full_research", marker: "NOT_FOUND", text: "", interpretation };
  }
  // Each issue carries its own short search phrase; the question is searched as written only when it could not be read.
  const issues: Array<ResearchIssue | { label?: undefined; query: string }> = interpretation?.issues.length ? interpretation.issues : [{ query }];
  const sources = sharedSources(mcpEnrichmentSources(context));

  const searchedQueries = new Set<string>();
  // The question's own law names (and, for a single issue or a
  // relation-less phrase, its explicit law+article pairs) are inherited
  // into every chain search. The retry plan must compare against the
  // inherited form: comparing a bare phrase against post-inheritance
  // entries would re-search a phrase this request already searched.
  const inheritSearchQuery = (input: string) => {
    const originalNames = questionTerms(query).filter(isLawName).filter((law) => !["시행령", "시행규칙", "법령"].includes(law));
    // One structured identity for the question's own pairs (a spaced
    // official name stays joined); the token-derived pairs remain the
    // fallback when the raw parse finds nothing.
    const parsedPairs = parseExplicitIdentities(query);
    const originalPairs = parsedPairs.length ? parsedPairs : explicitArticlePairs(questionTerms(query));
    const inherited = [...originalNames, ...(issues.length === 1 || questionTermsRelationLess(input)
      ? originalPairs.map((pair) => `${pair.law} ${pair.jo}`) : [])];
    return [...new Set([...inherited, input])].join(" ").trim();
  };
  // A per-issue retry chain's precedents and interpretations are discarded by
  // design (only its articles are merged), so a retry skips the precedent
  // summaries and the interpretation retry that the main chain needs. Its
  // article paths — chain text and supplement lookup — are unchanged, and
  // the same adoption rules judge what it returns.
  const search = async (searchQuery: string, light = false): Promise<ChainResult> => {
    searchQuery = inheritSearchQuery(searchQuery);
    searchedQueries.add(searchQuery);
    try {
      const { text, isError } = await callLawTool("legal_research", { task: "full_research", query: searchQuery }, context);
      const classification = classifyLawToolResult(text, isError, { failureMessage: RESEARCH_FAILURE });
      if (classification.kind === "absent") return { kind: "absent", text };
      const enrichment = await enrichResearch("full_research", searchQuery, text, sources, undefined,
        { ...(light ? { skipPrecedentSummaries: true, skipInterpretationRetry: true } : {}),
          extraNamed: [...new Set([...lawNamesInQuery(query), ...questionTerms(query).filter(isLawName)])] }).catch(() => undefined);
      return { kind: "found", text, markers: classification.markers, ...(enrichment ? { enrichment } : {}) };
    } catch (error) {
      if (context.signal?.aborted) throw error;
      return { kind: "failed", error };
    }
  };
  let chain = await search(issues[0].query);
  if (chain.kind === "absent") {
    // One retry for a genuine absence: the next issue's phrase, or the question itself when it is keyword-short.
    // When the question could not be read it was searched as written; the retry then uses its own
    // subject terms — words the user wrote, never an invented legal term — because the upstream
    // search AND-matches a long everyday sentence into nothing. Either way the retry's results
    // pass through the same source verification; nothing is adopted on the search alone.
    const refinedTerms = !interpretation ? questionTerms(query) : [];
    const alternative = issues[1]?.query
      ?? (interpretation && query !== issues[0].query && questionTerms(query).length <= SHORT_QUERY_TERMS ? query : undefined)
      ?? (refinedTerms.length >= 1 && refinedTerms.length <= SHORT_QUERY_TERMS && refinedTerms.join(" ") !== issues[0].query
        ? refinedTerms.join(" ") : undefined);
    if (alternative) {
      const second = await search(alternative);
      if (second.kind === "found") chain = second;
    }
  }
  // Without an interpretation there is nothing else to search: the chain's own outcome stands.
  if (!interpretation && chain.kind === "failed") throw chain.error;
  if (!interpretation && chain.kind === "absent") return { found: false, task: "full_research", marker: "NOT_FOUND", text: chain.text, ...(interpretationFailure ? { interpretationFailure } : {}) };

  const found = chain.kind === "found" ? chain : undefined;
  // "인가" as a question ending ("무엇인가?") is not a licensing intent:
  // strip a trailing 인가-ending before testing, so an everyday question
  // does not open an action-basis followup whose missing/failed report
  // would then demote the status.
  const followupQuery = query.replace(/(인가요|인가)[?？\s]*$/u, "");
  const followupMode = asksLawSystem(query) ? "law_system" as const
    : /정지|처분|허가|인가/u.test(followupQuery) ? "action_basis" as const : undefined;
  const followup = followupMode ? await retrieveResearchFollowup(followupMode, query, found?.text ?? "", found?.enrichment, sources) : undefined;
  const annexes = followup ? await retrieveAnnexes(query, followup.articles, mcpAnnexReader(context)) : [];
  if (found && followup?.articles.length) {
    found.text += followupDetailText(followup.articles);
    const base = found.enrichment?.supplement?.articles ?? [];
    found.enrichment = { ...found.enrichment, supplement: { status: "found", articles: [...base,
      ...followup.articles.filter((a) => !base.some((b) => b.law === a.law && b.jo === a.jo))],
      ...(found.enrichment?.supplement?.partialFailure || followup.report.failed ? { partialFailure: true } : {}) } };
  }
  let lawSystem = followupMode === "law_system" ? assessLawSystem(found?.text ?? followupDetailText(followup?.articles ?? []), query) : undefined;
  const document = researchResult(found?.text ?? "");
  const known = {
    text: found?.text ?? "",
    cases: new Map<string, ResearchAdoptionCandidate>(),
    reviews: new Map<string, NonNullable<ResearchEnrichment["adoptionReviews"]>[number]>(),
    ...(found?.enrichment ? { enrichment: found.enrichment } : {}),
    listed: new Map(document.sections.filter((section) => section.status === "available" && researchDecisionDomain(section.heading) === "precedent")
      .flatMap((section) => section.decisions?.entries ?? []).map((entry) => [entry.id, entry] as const)),
  };
  const rememberDecisions = (enrichment: ResearchEnrichment | undefined, stage: string) => {
    for (const original of Object.values(enrichment?.decisionOriginals ?? {})) {
      const domain = original.domain === "tribunal" ? "admin_appeal" as const : original.domain;
      const key = `${domain}:${original.id}`;
      known.cases.set(`${key}\0${original.text}`, { ...original, id: "", kind: domain === "precedent" ? "precedent" : "decision",
        domain, decisionId: original.id, decisionKey: key, stage,
        ...(domain === "precedent" ? { precedentId: original.id } : {}) });
    }
  };
  rememberDecisions(found?.enrichment, "chain");
  const shownArticles = document.sections.flatMap((section) => section.articles ?? []);
  const summaries = new Map<string, string>();
  const retrievedArticles: SupplementArticle[] = [];
  const started = Date.now();
  const expired = () => Date.now() - started > ISSUE_BUDGET_MS;
  // Search terms are still available to lexical matching, but only the
  // original question establishes facts, parties and named-law constraints.
  const requestTerms = questionTerms(query);
  const judged = await Promise.all(issues.map(async (issue) => {
    // An issue without a label is the unread question itself: it is judged by
    // the fallback rule (F), not by the interpreted-issue majority rule.
    const fallback = issue.label === undefined;
    let adopted = await issueSources(issue.query, known, undefined, sources, summaries, requestTerms, fallback, query);
    let lookup: IssueLookup | undefined;
    // F1 M2: the gate used to require precedents to be empty as well, so an issue covered only by
    // precedents never reached the supplement lookup — and the question's law-name inheritance (F2)
    // could not rescue its missing articles. Precedents cover status, not articles, so the gate is
    // articles==0 alone; the shared issue budget and timeout reporting are unchanged.
    // An unread question has no short phrase of its own, so its lookup query is
    // its subject words only — the whole everyday sentence is never sent.
    if (!adopted.articles.length) {
      const lookupQuery = fallback ? questionSubjectTerms(query).join(" ") : issue.query;
      if (lookupQuery) {
        // A lookup failure degrades to "no lookup", never to a failed request:
        // the chain's own adoption still stands, and the issue status below
        // falls back to the chain outcome.
        const questionIdentities = parseExplicitIdentities(query);
        lookup = await lookupIssue(lookupQuery, shownArticles, sources, expired,
          [...new Set([...lawNamesInQuery(query), ...questionTerms(query).filter(isLawName)])], questionTerms(query),
          questionIdentities.length ? questionIdentities : undefined)
          .catch(() => undefined);
        if (lookup?.status === "found") adopted = await issueSources(issue.query, known, lookup, sources, summaries, requestTerms, fallback, query);
      }
    }
    // A title-matched preview can omit the operative clause even when lexical
    // matching provisionally adopts it. Use the existing bounded re-read for
    // that preview too: final adoption requires the obtained original, not a
    // display truncation or title match.
    const unreadAdopted = adopted.articles.some((ref) => shownArticles.some((article) =>
      article.law === ref.law && article.jo === ref.jo && /\.{3}|…|⋯|중략/u.test(article.excerpt)));
    if ((!adopted.articles.length || unreadAdopted) && !expired()) {
      const candidateTerms = [...new Set([...questionTerms(issue.query), ...questionTerms(query)])];
      // A re-read failure degrades to "no candidate", never to a failed request.
      const reread = await rereadShownArticles(shownArticles, candidateTerms, sources, expired).catch(() => []);
      const fresh = reread.filter((article) => !(lookup?.articles ?? [])
        .some((shown) => shown.law === article.law && shown.jo === article.jo));
      retrievedArticles.push(...reread);
      // A lookup that found precedents but no adoptable article must not
      // lose those precedents when a re-read lands articles: the re-read
      // replaces the adoption, so the lookup's precedents ride along.
      if (fresh.length) {
        adopted = await issueSources(issue.query, known, { status: "found", articles: fresh, precedents: lookup?.precedents ?? [] },
          sources, summaries, requestTerms, fallback, query);
      }
    }
    // Only the relation issue receives the verified pair and its citing counterpart.
    // A sibling substantive issue must pass normal topical adoption.
    if (followupMode === "law_system" && followup && (issues.length === 1 || asksLawSystem(issue.query) || questionTermsRelationLess(issue.query))) {
      const parsedPairs = parseExplicitIdentities(query);
      const pairs = parsedPairs.length ? parsedPairs : explicitArticlePairs(questionTerms(query));
      const linked = followup.articles.filter((article) => pairs.some((p) => sameLawFamily(p.law, article.law)
        && (article.jo === p.jo && !/시행령|시행규칙/u.test(article.law) || citesParent(article.body, p.jo))));
      adopted.articles = [...new Map([...adopted.articles, ...linked.map(({ law, jo }) => ({ law, jo }))]
        .map((a) => [`${a.law}\0${a.jo}`, a])).values()];
    }
    const covered = adopted.articles.length > 0 || adopted.precedents.length > 0;
    // When the combined search failed, "nothing found" by the issue lookup alone is not a confirmed absence.
    const status: IssueEvidence["status"] = covered ? "found"
      : lookup?.status === "failed" || lookup?.status === "timeout" ? lookup.status
      : chain.kind === "failed" ? "failed" : "none";
    return { issue, lookup, adopted, status };
  }));

  // V4 M3-lite: an issue that still has no article after the main chain and its own
  // lookup has no article source left except a chain search of its own. Precedents
  // never supply articles (the M2 principle), so the gate is articles==0 alone.
  // Bounded: at most one retry search per empty issue, at most three per
  // request, only while the main chain succeeded (a failed main chain already
  // reports searchFailed — retrying it per issue would multiply upstream
  // failures) and the shared budget has not expired. A phrase this request
  // already chain-searched (the first issue's phrase, or the absent-retry's
  // alternative) is never searched again — the plan below drops such issues
  // before capping, so a searched phrase cannot waste another issue's slot.
  // A subject-less issue ("피해자 보호") cannot name its regime upstream,
  // so its retry is qualified with the request's own subject words
  // ("직장 괴롭힘 피해자 보호") — user words only, nothing invented.
  // Retry previews truncate the same way the main chain's do, so a retry
  // that adopts nothing re-reads its title-matched articles before giving
  // up on the issue. Retry precedents are ignored — the per-issue lookup
  // already searched precedents — and only articles are merged, into the
  // supplement, so the displayed text stays the main chain's and the UI can
  // show them through the existing supplement path. A retry that finds
  // nothing, or fails, leaves the issue's status as the lookup left it (the
  // same silence as the main chain's absent-retry). Adoption still uses the
  // same relevance rules; nothing is adopted on the search alone.
  const retryArticles = new Map<string, SupplementArticle>();
  const retryPlan = judged
    .filter((item) => !item.adopted.articles.length && item.issue.label !== undefined)
    .map((item) => {
      const qualified = [...questionSubjectTerms(query), item.issue.query].join(" ").trim();
      const phrase = questionTermsSubjectLess(item.issue.query) && qualified !== item.issue.query ? qualified : item.issue.query;
      return { item, phrase };
    })
    .filter(({ phrase }) => !searchedQueries.has(inheritSearchQuery(phrase)))
    .slice(0, 3);
  if (found && retryPlan.length) {
    await Promise.all(retryPlan.map(async ({ item, phrase }) => {
      if (expired()) return;
      const retry = await search(phrase, true);
      if (retry.kind !== "found" || expired()) return;
      const retryDocument = researchResult(retry.text);
      rememberDecisions(retry.enrichment, "retry");
      const retryKnown = {
        text: retry.text,
        reviews: known.reviews,
        cases: known.cases,
        ...(retry.enrichment ? { enrichment: retry.enrichment } : {}),
        listed: new Map(retryDocument.sections.filter((section) => section.status === "available" && researchDecisionDomain(section.heading) === "precedent")
          .flatMap((section) => section.decisions?.entries ?? []).map((entry) => [entry.id, entry] as const)),
      };
      const retryTextArticles = retryDocument.sections.flatMap((section) => section.articles ?? []);
      retrievedArticles.push(...retryTextArticles.map((article) => ({ law: article.law, jo: article.jo,
        title: article.title ?? "", excerpt: article.excerpt, effectiveDate: article.effective,
        stage: "retry" as const, matched: [] })), ...(retry.enrichment?.supplement?.articles ?? []));
      let retryAdopted = await issueSources(item.issue.query, retryKnown, undefined, sources, summaries, requestTerms, false, query);
      if (!retryAdopted.articles.length && !expired()) {
        const candidateTerms = [...new Set([...questionTerms(item.issue.query), ...questionTerms(query)])];
        const reread = await rereadShownArticles(retryTextArticles, candidateTerms, sources, expired).catch(() => []);
        retrievedArticles.push(...reread);
        if (reread.length) {
          retryAdopted = await issueSources(item.issue.query, retryKnown, { status: "found", articles: reread, precedents: [] },
            sources, summaries, requestTerms, false, query);
        }
      }
      if (!retryAdopted.articles.length) return;
      const issueTerms = questionTerms(item.issue.query);
      const merged = [...item.adopted.articles];
      for (const article of retryAdopted.articles) {
        const key = `${article.law}\0${article.jo}`;
        if (merged.some((a) => a.law === article.law && a.jo === article.jo)) continue;
        merged.push(article);
        if (retryArticles.has(key)) continue;
        const supplement = retry.enrichment?.supplement?.articles.find((a) => a.law === article.law && a.jo === article.jo);
        const textArticle = retryTextArticles.find((a) => a.law === article.law && a.jo === article.jo);
        if (supplement) retryArticles.set(key, supplement);
        else if (textArticle) retryArticles.set(key, {
          law: article.law, jo: article.jo, title: textArticle.title ?? "",
          excerpt: textArticle.excerpt ?? "", matched: titleMatches(issueTerms, article.law, textArticle.title ?? ""), stage: "retry",
          ...(textArticle.effective?.replace(/\D/gu, "").length === 8 ? { effectiveDate: textArticle.effective.replace(/\D/gu, "") } : {}),
        });
      }
      if (merged.length > item.adopted.articles.length) {
        item.adopted = { articles: merged, precedents: item.adopted.precedents };
        item.status = "found";
      }
    }));
  }

  // A retry that lands a delegating subordinate article after the
  // law-system assessment must not leave a stale verdict behind: only a
  // retry article that itself cites an asked parent article, in detail
  // format, can add a delegating block, and the assessment then re-runs
  // on the same final evidence set. An unrelated retry article cannot
  // lift the verdict — assessLawSystem still filters by law family and
  // still requires the direct citation.
  if (followupMode === "law_system" && lawSystem && found && retryArticles.size) {
    const retryText = [...retryArticles.values()]
      .filter((article) => /시행령|시행규칙$/u.test(article.law))
      .map((article) => `[${/시행규칙$/u.test(article.law) ? "시행규칙" : "시행령"}] ${article.law} ${article.jo} (${article.title || "제목 미제공"})\n${article.excerpt}`)
      .join("\n");
    const blocks = retryText ? delegatingDetailBlocks(retryText, askedArticles(query, undefined), found.text) : "";
    if (blocks) lawSystem = assessLawSystem(found.text + blocks, query);
  }

  // Final adoption is a single batch over the originals this request already
  // obtained. Lexical matches above guide existing retrieval only; neither a
  // chain union nor a law-system followup can bypass this final gate.
  const candidateMap = new Map<string, ResearchAdoptionCandidate>();
  const explicitPairs = parseExplicitIdentities(query);
  const directActionRefs = followupMode === "action_basis"
    ? assessActionBasis(query, found?.text ?? "", { supplement: { status: "found",
      articles: (followup?.articles ?? []).map((article) => ({ ...article, excerpt: article.body })) } })
      .items.flatMap((item) => [...(item.basisRefs ?? []), ...(item.requirementRefs ?? [])]).filter((ref) => !ref.note)
    : [];
  const fullFollowupArticles = [...(followup?.articles ?? [])].sort((a, b) => {
    const priority = (article: typeof a) => {
      if (explicitPairs.some((pair) => pair.jo === article.jo && sameLawFamily(pair.law, article.law))) return 0;
      if (followupMode === "law_system" && explicitPairs.some((pair) =>
        sameLawFamily(pair.law, article.law) && citesParent(article.body, pair.jo))) return 1;
      if (directActionRefs.some((ref) => ref.law === article.law && ref.jo === article.jo && ref.excerpt === article.body)) return 1;
      return 2;
    };
    return priority(a) - priority(b);
  });
  const rawArticles = [
    // Followup already fetched these complete bodies. Its display excerpt is
    // capped separately and must not replace the actual verification source.
    ...fullFollowupArticles.map((article) => ({ ...article, excerpt: article.body })),
    ...shownArticles.map((article) => ({ ...article, effectiveDate: article.effective, stage: "chain" })),
    ...(found?.enrichment?.supplement?.articles ?? []).map((article) => ({ ...article, excerpt: article.original ?? article.excerpt })),
    ...judged.flatMap((item) => item.lookup?.articles ?? []).map((article) => ({ ...article, excerpt: article.original ?? article.excerpt })),
    ...retrievedArticles.map((article) => ({ ...article, excerpt: article.original ?? article.excerpt })),
    ...[...known.reviews.values()].flatMap((review) => review.articles),
  ];
  for (const article of rawArticles) {
    if (!article.excerpt.trim()) continue;
    const key = `article\0${article.law}\0${article.jo}\0${article.effectiveDate ?? ""}\0${article.excerpt}`;
    if (candidateMap.has(key)) continue;
    candidateMap.set(key, { id: `c${candidateMap.size + 1}`, kind: "article", law: article.law, jo: article.jo,
      title: article.title, text: article.excerpt, effectiveDate: article.effectiveDate,
      stage: article.stage ?? "supplement", partial: /\.{3}|…|⋯|중략/u.test(article.excerpt) });
  }
  for (const candidate of known.cases.values()) {
    const decisionKey = candidate.decisionKey ?? `precedent:${candidate.precedentId}`;
    const key = `${decisionKey}\0${candidate.text}`;
    if (!candidateMap.has(key)) candidateMap.set(key, { ...candidate, id: `c${candidateMap.size + 1}`,
      domain: candidate.domain ?? "precedent", decisionId: candidate.decisionId ?? candidate.precedentId, decisionKey,
      partial: candidate.partial || /\.{3}|…|⋯|중략/u.test(candidate.text) });
  }
  // Stable sorting retains explicit/delegation/action priority assigned above,
  // while incomplete previews cannot consume the budget before full originals.
  const candidates = [...candidateMap.values()].sort((a, b) => Number(Boolean(a.partial)) - Number(Boolean(b.partial)));
  let selections: ResearchAdoptionVerdict[] = [];
  let verification: "verified" | "unavailable" = "verified";
  if (candidates.length) {
    try { selections = await verifyResearchAdoption(query, issues, candidates, context); }
    catch (error) {
      if (context.signal?.aborted) throw error;
      verification = "unavailable";
    }
  }
  const identities = parseExplicitIdentities(query);
  const requestedCandidateIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.kind !== "article" || !candidate.law || !candidate.jo) continue;
    const parsedIdentity = identities.some((pair) => pair.jo === candidate.jo
      && pair.law.replace(/\s+/gu, "") === candidate.law!.replace(/\s+/gu, ""));
    // The general token parser deliberately excludes two-letter method words,
    // and therefore also excludes 민법/형법. Here the already-fetched official
    // name supplies the identity: require that literal name + its own article
    // in the user's text, not an AI phrase or an unpaired article elsewhere.
    const lawPattern = [...candidate.law.replace(/\s+/gu, "")]
      .map((char) => char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("\\s*");
    const joPattern = [...candidate.jo].join("\\s*");
    if (parsedIdentity || new RegExp(`(?:^|[^\\p{L}\\p{N}_])${lawPattern}\\s*(?:상\\s*)?${joPattern}(?!\\d|\\s*의\\s*\\d)`, "u").test(query)) {
      requestedCandidateIds.add(candidate.id);
    }
  }
  const semanticArticles: SupplementArticle[] = [];
  for (const [issueIndex, item] of judged.entries()) {
    const byCandidate = new Map(selections.filter((selection) => selection.issueIndex === issueIndex)
      .map((selection) => [selection.candidateId, selection]));
    const review: NonNullable<ResearchEnrichment["adoptionReviews"]>[number] = {
      query: item.issue.query, issueIndex, verification, articles: [], precedents: [],
    };
    const adopted: typeof item.adopted = { articles: [], precedents: [] };
    let direct = false;
    const identityKeys = new Set<string>();
    for (const candidate of candidates) {
      const proposed = byCandidate.get(candidate.id);
      // The model's selection is re-checked against the user's own words: a
      // rule confined to an unmentioned party/relationship, or a bare purpose
      // clause the question does not ask about, is not evidence for it.
      const mismatch = proposed && (!relationshipSupported(`${candidate.law ?? ""} ${proposed.quote || candidate.text}`, query)
        || candidate.kind === "article" && candidate.title?.replace(/\s+/gu, "") === "목적" && !query.includes("목적"));
      const selection = mismatch ? undefined : proposed;
      const identity = requestedCandidateIds.has(candidate.id)
        && (issues.length === 1 || questionTermsRelationLess(item.issue.query) || item.issue.query.includes(candidate.jo!))
        && !identityKeys.has(`${candidate.law}\0${candidate.jo}`);
      const accepted = Boolean(selection) || identity;
      const role = identity ? "identity" as const : selection?.role;
      const reason = identity ? "사용자 원문에 명시된 법률·조문의 공식 원문을 확인했습니다."
        : mismatch ? "원질문의 당사자·법률관계 또는 질문 범위와 맞지 않아 근거로 채택하지 않았습니다."
        : selection?.reason ?? (candidate.partial ? "일부 원문만 확보되어 직접·보충 관련성을 확정하지 않았습니다."
        : verification === "unavailable" ? "원문은 확보했으나 관련성 검증을 완료하지 못해 추가 확인이 필요합니다."
        : "원질문과 이 쟁점을 뒷받침하는 직접·보충 관련성이 확인되지 않았습니다.");
      if (candidate.kind === "article" && candidate.law && candidate.jo) {
        review.articles.push({ law: candidate.law, jo: candidate.jo, title: candidate.title,
          excerpt: candidate.text, effectiveDate: candidate.effectiveDate, stage: candidate.stage,
          adopted: accepted, role, quote: selection?.quote ?? (identity ? candidate.text : undefined), reason, window: selection?.window });
        if (accepted) {
          if (!adopted.articles.some((article) => article.law === candidate.law && article.jo === candidate.jo)) {
            adopted.articles.push({ law: candidate.law, jo: candidate.jo });
          }
          const alreadyInChain = shownArticles.some((article) => article.law === candidate.law && article.jo === candidate.jo
            && article.excerpt === candidate.text
            && (article.effective?.replace(/\D/gu, "") ?? "") === (candidate.effectiveDate?.replace(/\D/gu, "") ?? ""));
          if (!alreadyInChain) semanticArticles.push({ law: candidate.law, jo: candidate.jo, title: candidate.title ?? "", excerpt: candidate.text,
            effectiveDate: candidate.effectiveDate?.replace(/\D/gu, ""), matched: [],
            ...(candidate.stage === "chain" ? {} : { stage: candidate.stage as SupplementArticle["stage"] }) });
          identityKeys.add(`${candidate.law}\0${candidate.jo}`);
        }
      } else if (candidate.precedentId) {
        review.precedents.push({ id: candidate.precedentId, key: candidate.decisionKey, domain: "precedent", title: candidate.title, body: candidate.body,
          date: candidate.date, caseNumber: candidate.caseNumber, excerpt: candidate.text, partial: candidate.partial,
          adopted: accepted, role: selection?.role, quote: selection?.quote, reason, window: selection?.window });
        if (accepted && !adopted.precedents.includes(candidate.precedentId)) adopted.precedents.push(candidate.precedentId);
      } else if (candidate.decisionId && candidate.decisionKey && candidate.domain) {
        (review.decisions ??= []).push({ key: candidate.decisionKey, domain: candidate.domain, id: candidate.decisionId,
          title: candidate.title, body: candidate.body, date: candidate.date, caseNumber: candidate.caseNumber,
          excerpt: candidate.text, partial: candidate.partial, source: candidate.source,
          adopted: accepted, role: selection?.role, quote: selection?.quote, reason, window: selection?.window });
        if (accepted) {
          const refs = adopted.decisions ??= [];
          if (!refs.includes(candidate.decisionKey)) refs.push(candidate.decisionKey);
        }
      }
      if (accepted && role !== "supporting") direct = true;
    }
    item.adopted = adopted;
    item.status = direct ? "found"
      : item.lookup?.status === "failed" || item.lookup?.status === "timeout" ? item.lookup.status
      : item.status === "failed" || item.status === "timeout" ? item.status
      : chain.kind === "failed" ? "failed" : "none";
    if (candidates.length) known.reviews.set(item.issue.query, review);
  }

  const coveredCount = judged.filter((item) => item.status === "found").length;
  if (!found && !coveredCount && !candidates.length) {
    if (chain.kind === "failed") throw chain.error;
    return { found: false, task: "full_research", marker: "NOT_FOUND", text: chain.kind === "absent" ? chain.text : "", interpretation };
  }

  // Sources an issue lookup contributed join the answer's own, each shown once however many issues cite it.
  const lookupArticles = new Map<string, SupplementArticle>();
  const precedentEntries: Record<string, { title?: string; caseNumber?: string; body?: string; date?: string }> = {};
  for (const { lookup, adopted } of judged) {
    for (const article of lookup?.articles ?? []) {
      if (adopted.articles.some((item) => item.law === article.law && item.jo === article.jo)) lookupArticles.set(`${article.law}\0${article.jo}`, article);
    }
    for (const hit of lookup?.precedents ?? []) {
      if (adopted.precedents.includes(hit.id) && !known.listed.has(hit.id)) {
        precedentEntries[hit.id] = { ...(hit.title ? { title: hit.title } : {}), ...(hit.caseNumber ? { caseNumber: hit.caseNumber } : {}),
          ...(hit.body ? { body: hit.body } : {}), ...(hit.date ? { date: hit.date } : {}) };
      }
    }
  }
  const baseSupplement = found?.enrichment?.supplement;
  const supplementArticles = [...(baseSupplement?.articles ?? []),
    ...[...lookupArticles.values(), ...retryArticles.values(), ...semanticArticles].filter((article, index, all) =>
      !baseSupplement?.articles.some((item) => item.law === article.law && item.jo === article.jo
        && item.excerpt === article.excerpt && item.effectiveDate === article.effectiveDate)
      && all.findIndex((item) => item.law === article.law && item.jo === article.jo
        && item.excerpt === article.excerpt && item.effectiveDate === article.effectiveDate) === index)];
  // The merged supplement keeps the main chain's incompleteness: a partial
  // failure that merging would otherwise silently drop. The UI surfaces it
  // through the existing partial notice (overall status only — the shared
  // supplement cannot be attributed to one issue, so no per-issue demotion).
  const supplementIncomplete = baseSupplement?.partialFailure === true || baseSupplement?.status === "failed";
  const enrichment: ResearchEnrichment | undefined = found?.enrichment || supplementArticles.length || known.reviews.size ? {
    ...found?.enrichment,
    ...(known.reviews.size ? { adoptionReviews: [...known.reviews.values()] } : {}),
    ...(supplementArticles.length ? { supplement: { status: "found" as const, articles: supplementArticles,
      ...(supplementIncomplete ? { partialFailure: true as const } : {}) } } : {}),
  } : undefined;
  const articles = [...new Map(judged.flatMap(({ adopted }) => adopted.articles).map((article) => [`${article.law}\0${article.jo}`, article])).values()];
  const precedents = [...new Set(judged.flatMap(({ adopted }) => adopted.precedents))];
  const decisions = [...new Set(judged.flatMap(({ adopted }) => adopted.decisions ?? []))];
  const selectedPrecedentTexts = new Map([...known.reviews.values()].flatMap((review) => review.precedents)
    .filter((entry) => entry.adopted && entry.excerpt).map((entry) => [entry.id, entry.excerpt!]));
  const precedentExcerpts = Object.fromEntries(precedents.flatMap((id) => {
    const text = selectedPrecedentTexts.get(id);
    return text ? [[id, text.slice(0, EXCERPT_CHARS)]] : [];
  }));
  const text = found?.text ?? "";
  // Policy decision (2026-10-28 integrated directive): a question that
  // names no law is precedent-seeking — a directly-adopted precedent is
  // its adopted evidence, so precedent coverage admits matched. A
  // law-seeking question still needs an adopted statute article, and a
  // precedent-covered issue caps it.
  const lawSeeking = questionTerms(query).filter(isLawName).length > 0;
  const hasDirectArticle = [...known.reviews.values()].some((review) => review.articles.some((article) =>
    article.adopted && (article.role === "direct" || article.role === "identity")));
  const hasDirectDecision = [...known.reviews.values()].some((review) =>
    review.precedents.some((entry) => entry.adopted && entry.role === "direct")
    || review.decisions?.some((entry) => entry.adopted && entry.role === "direct"));
  const relationCapped = Boolean(lawSystem && lawSystem.status !== "matched")
    || Boolean(followup && (followup.report.failed || followup.report.limited || followup.report.missing))
    || annexes.some((a) => a.status !== "verified")
    || judged.some((item) => item.status === "found" && lawSeeking
      && !known.reviews.get(item.issue.query)?.articles.some((article) =>
        article.adopted && (article.role === "direct" || article.role === "identity")))
    || supplementIncomplete || judged.some((item) => item.lookup?.partialFailure);
  return {
    found: true, task: "full_research", text, markers: found?.markers ?? [],
    ...(lawSystem ? { lawSystem } : {}),
    ...(followup ? { followup: followup.report } : {}),
    ...(annexes.length ? { annexes } : {}),
    ...(enrichment ? { enrichment } : {}),
    evidence: {
      status: integratedEvidenceStatus(coveredCount, issues.length, hasDirectArticle, relationCapped, !lawSeeking && hasDirectDecision),
      articles: await withCurrency(articles, text, enrichment, context),
      precedents,
      ...(decisions.length ? { decisions } : {}),
      ...(Object.keys(precedentExcerpts).length ? { precedentExcerpts } : {}),
      issues: judged.map(({ issue, adopted, status, lookup }) => ({ ...(issue.label ? { label: issue.label } : {}), status, ...adopted,
        ...(lookup?.partialFailure ? { lookupPartial: true as const } : {}) })),
      ...(Object.keys(precedentEntries).length ? { precedentEntries } : {}),
      ...(chain.kind === "failed" ? { searchFailed: true as const } : {}),
    },
    ...(interpretation ? { interpretation } : {}),
    ...(interpretationFailure ? { interpretationFailure } : {}),
  };
}

export async function runLegalResearch(
  request: LawResearchRequest,
  context: ResearchContext,
): Promise<LawResearchData | LawResearchAbsent> {
  // Document review decides the document's type and each clause's issue before
  // any search, then searches only the areas of law that fit (see contract-review).
  if (request.task === "document_review") {
    // File ranges carry explicit gaps; the profile and lookup memo span them all.
    const input = "document" in request ? request.document.segments : request.text;
    const review = await reviewContract(input, mcpReviewSources(context), Date.now, context.signal,
      "document" in request ? request.document.classificationContext : undefined);
    return { found: true, task: request.task, text: "", markers: [], review };
  }
  if (request.task === "full_research") return fullResearch(request.query, context);
  const result = (() => {
    switch (request.task) {
      case "action_basis":
      case "procedure_detail":
        return callLawTool("legal_research", { task: request.task, query: request.query }, context);
      case "law_system":
        return callLawTool("legal_research", { task: request.task, query: request.query,
          ...(request.articles ? { articles: request.articles } : {}) }, context);
      case "dispute_prep":
        return callLawTool("legal_research", { task: request.task, query: request.query,
          ...(request.domain ? { domain: request.domain } : {}) }, context);
      case "amendment_track":
        return callLawTool("legal_research", { task: request.task, query: request.query,
          ...(request.scenario ? { scenario: request.scenario } : {}),
          ...(request.mst ? { mst: request.mst } : {}),
          ...(request.lawId ? { lawId: request.lawId } : {}),
          ...(request.fromDate ? { fromDate: request.fromDate.replaceAll("-", "") } : {}),
          ...(request.toDate ? { toDate: request.toDate.replaceAll("-", "") } : {}),
          includeHistory: request.includeHistory ?? false }, context);
      case "ordinance_compare":
        // The chain covers the parent law and delegation; regions are searched separately (never AND-joined into this query).
        return callLawTool("legal_research", { task: request.task, query: request.query,
          ...(request.parentLaw ? { parentLaw: request.parentLaw } : {}) }, context);
    }
  })();
  const [{ text, isError }, comparison] = await Promise.all([
    result,
    request.task === "ordinance_compare"
      ? compareOrdinances(request.query, request.regions, mcpOrdinanceSources(context), request.parentLaw).catch(() => undefined)
      : undefined,
  ]);
  const classification = classifyLawToolResult(text, isError, {
    failureMessage: RESEARCH_FAILURE,
  });
  if (classification.kind === "absent") {
    // An empty parent-law chain does not erase ordinances the per-region search did find.
    if (comparison?.regions.some((region) => region.status === "found")) {
      return { found: true, task: request.task, text, markers: ["NOT_FOUND"], comparison };
    }
    return { found: false, task: request.task, marker: "NOT_FOUND", text };
  }
  // 절차·서식: the server judges the returned text requirement by requirement;
  // the UI displays this verdict. Other tasks keep their previous responses.
  if (request.task === "procedure_detail" || request.task === "law_system" || request.task === "action_basis") {
    const sources = sharedSources(mcpEnrichmentSources(context));
    let enrichment = request.task === "action_basis"
      ? await enrichResearch(request.task, request.query, text, sources).catch(() => undefined) : undefined;
    const followup = await retrieveResearchFollowup(request.task, request.query, text, enrichment, sources,
      request.task === "law_system" ? request.articles : undefined);
    const annexes = await retrieveAnnexes(request.query, followup.articles, mcpAnnexReader(context), request.task);
    const combinedText = text + followupDetailText(followup.articles);
    if (followup.articles.length) {
      const existing = enrichment?.supplement?.articles ?? [];
      enrichment = { ...enrichment, supplement: { status: "found", articles: [...existing,
        ...followup.articles.filter((a) => !existing.some((b) => b.law === a.law && b.jo === a.jo))],
        ...(followup.report.failed || enrichment?.supplement?.partialFailure ? { partialFailure: true } : {}) } };
    }
    const incomplete = followup.report.failed > 0 || followup.report.limited || followup.report.missing > 0 || annexes.some((a) => a.status !== "verified");
    const common = { found: true as const, task: request.task, text: combinedText, markers: classification.markers,
      followup: followup.report, ...(annexes.length ? { annexes } : {}), ...(enrichment ? { enrichment } : {}) };
    if (request.task === "law_system") {
      const lawSystem = assessLawSystem(combinedText, request.query, request.articles);
      return { ...common, lawSystem };
    }
    if (request.task === "procedure_detail") {
      const procedure = assessProcedureEvidence(request.query, researchResult(combinedText), combinedText, annexes);
      if (incomplete || procedure.requirements.some((r) => r.kind === "forms") && (!annexes.length || annexes.some((a) => a.status !== "verified"))) {
        procedure.incomplete = true;
        if (procedure.overall === "matched") procedure.overall = "partial";
      }
      return { ...common, procedure };
    }
    const actionBasis = assessActionBasis(request.query, combinedText, enrichment, annexes);
    // Basis, requested requirements, annex originals and appeal sources are
    // assessed independently above. Only additional reads may remain optional
    // after all those checks pass; never promote an assessor's partial result.
    if (annexes.some((a) => a.relevance === "direct" && a.status !== "verified") && actionBasis.status === "matched") actionBasis.status = "partial";
    return { ...common, actionBasis };
  }
  if (request.task === "dispute_prep") {
    return { found: true, task: request.task, text, markers: classification.markers, dispute: assessDispute(request.query, text) };
  }
  if (request.task === "amendment_track") {
    return { found: true, task: request.task, text, markers: classification.markers, amendment: assessAmendment(text) };
  }
  return { found: true, task: request.task, text, markers: classification.markers, ...(comparison ? { comparison } : {}) };
}
