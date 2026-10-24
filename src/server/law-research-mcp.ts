import type { EvidenceArticle, InterpretationFailure, IssueEvidence, LawCurrency, LawResearchAbsent, LawResearchData, LawResearchRequest, ResearchIssue } from "@/lib/law-research";
import type { LawRequestStats } from "@/lib/law-observability";
import { researchResult, type ResearchDecision } from "@/lib/law-research-parse";
import {
  questionTerms, rankPrecedent, researchEvidenceSources,
  type PrecedentRelevance, type ResearchEnrichment, type SupplementArticle,
} from "@/lib/research-relevance";
import { classifyLawToolResult } from "@/server/law-analysis-mcp";
import { callLawTool, searchLaw } from "@/server/law-mcp";
import { mcpReviewSources, reviewContract } from "@/server/contract-review";
import { interpretResearchQuery } from "@/server/groq";
import { ApiError } from "@/server/http";
import {
  enrichResearch, lookupIssue, mcpEnrichmentSources, sharedSources,
  type EnrichmentSources, type IssueLookup,
} from "@/server/research-enrichment";
import { compareOrdinances, mcpOrdinanceSources } from "@/server/ordinance-compare";

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
    return { ...article, currency };
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
  chain: { text: string; enrichment?: ResearchEnrichment; listed: Map<string, ResearchDecision> },
  lookup: IssueLookup | undefined,
  sources: EnrichmentSources,
  summaries: Map<string, string>,
): Promise<{ articles: Array<{ law: string; jo: string }>; precedents: string[] }> {
  const terms = questionTerms(issueQuery);
  const relevance: Record<string, PrecedentRelevance> = {};
  await Promise.all(Object.keys(chain.enrichment?.precedents ?? {}).map(async (id) => {
    const summary = await sources.summary(id).catch(() => undefined);
    if (summary?.text) summaries.set(id, summary.text);
    relevance[id] = rankPrecedent(terms, { title: chain.listed.get(id)?.title, ...(summary ? { summary: summary.text, excerpt: summary.excerpt } : {}) });
  }));
  for (const hit of lookup?.precedents ?? []) {
    summaries.set(hit.id, hit.summary);
    relevance[hit.id] = rankPrecedent(terms, { title: hit.title, summary: hit.summary, excerpt: hit.excerpt });
  }
  const supplement = [...(chain.enrichment?.supplement?.articles ?? []), ...(lookup?.articles ?? [])];
  return researchEvidenceSources(chain.text, issueQuery, {
    ...chain.enrichment,
    precedents: relevance,
    // Citation is judged on the summaries actually read for this issue, not on term lists alone.
    precedentExcerpts: Object.fromEntries(summaries),
    supplement: { status: supplement.length ? "found" : "none", articles: supplement },
  });
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

  const search = async (searchQuery: string): Promise<ChainResult> => {
    try {
      const { text, isError } = await callLawTool("legal_research", { task: "full_research", query: searchQuery }, context);
      const classification = classifyLawToolResult(text, isError, { failureMessage: RESEARCH_FAILURE });
      if (classification.kind === "absent") return { kind: "absent", text };
      const enrichment = await enrichResearch("full_research", searchQuery, text, sources).catch(() => undefined);
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
  const document = researchResult(found?.text ?? "");
  const known = {
    text: found?.text ?? "",
    ...(found?.enrichment ? { enrichment: found.enrichment } : {}),
    listed: new Map(document.sections.filter((section) => section.status === "available")
      .flatMap((section) => section.decisions?.entries ?? []).map((entry) => [entry.id, entry] as const)),
  };
  const shownArticles = document.sections.flatMap((section) => section.articles ?? []);
  const summaries = new Map<string, string>();
  const started = Date.now();
  const expired = () => Date.now() - started > ISSUE_BUDGET_MS;
  const judged = await Promise.all(issues.map(async (issue) => {
    let adopted = await issueSources(issue.query, known, undefined, sources, summaries);
    let lookup: IssueLookup | undefined;
    // Only an interpreted issue has a short phrase of its own; a question that could not be read is never sent whole.
    if (!adopted.articles.length && !adopted.precedents.length && issue.label !== undefined) {
      lookup = await lookupIssue(issue.query, shownArticles, sources, expired);
      if (lookup.status === "found") adopted = await issueSources(issue.query, known, lookup, sources, summaries);
    }
    const covered = adopted.articles.length > 0 || adopted.precedents.length > 0;
    // When the combined search failed, "nothing found" by the issue lookup alone is not a confirmed absence.
    const status: IssueEvidence["status"] = covered ? "found"
      : lookup?.status === "failed" || lookup?.status === "timeout" ? lookup.status
      : chain.kind === "failed" ? "failed" : "none";
    return { issue, lookup, adopted, status };
  }));

  const coveredCount = judged.filter((item) => item.status === "found").length;
  if (!found && !coveredCount) {
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
    ...[...lookupArticles.values()].filter((article) => !baseSupplement?.articles.some((item) => item.law === article.law && item.jo === article.jo))];
  const enrichment: ResearchEnrichment | undefined = found?.enrichment || supplementArticles.length ? {
    ...found?.enrichment,
    ...(supplementArticles.length ? { supplement: { status: "found" as const, articles: supplementArticles } } : {}),
  } : undefined;
  const articles = [...new Map(judged.flatMap(({ adopted }) => adopted.articles).map((article) => [`${article.law}\0${article.jo}`, article])).values()];
  const precedents = [...new Set(judged.flatMap(({ adopted }) => adopted.precedents))];
  const precedentExcerpts = Object.fromEntries(precedents.flatMap((id) => {
    const text = summaries.get(id);
    return text ? [[id, text.slice(0, EXCERPT_CHARS)]] : [];
  }));
  const text = found?.text ?? "";
  return {
    found: true, task: "full_research", text, markers: found?.markers ?? [],
    ...(enrichment ? { enrichment } : {}),
    evidence: {
      status: coveredCount === issues.length ? "matched" : coveredCount ? "partial" : "unverified",
      articles: await withCurrency(articles, text, enrichment, context),
      precedents,
      ...(Object.keys(precedentExcerpts).length ? { precedentExcerpts } : {}),
      issues: judged.map(({ issue, adopted, status }) => ({ ...(issue.label ? { label: issue.label } : {}), status, ...adopted })),
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
  // Action-basis enrichment keeps its previous behavior; full research is handled above.
  if (request.task === "action_basis") {
    const enrichment = await enrichResearch(request.task, request.query, text, mcpEnrichmentSources(context)).catch(() => undefined);
    if (enrichment) return { found: true, task: request.task, text, markers: classification.markers, enrichment };
  }
  return { found: true, task: request.task, text, markers: classification.markers, ...(comparison ? { comparison } : {}) };
}
