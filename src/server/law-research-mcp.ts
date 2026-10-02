import type { EvidenceArticle, InterpretationFailure, IssueEvidence, LawCurrency, LawResearchAbsent, LawResearchData, LawResearchRequest, ResearchIssue } from "@/lib/law-research";
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
const MAX_STATUS_LAWS = 4;
/** Every issue the combined answer did not cover shares this budget; one it cannot reach is reported, never dropped. */
const ISSUE_BUDGET_MS = 15_000;
/** The upstream search AND-matches words, so only a keyword-length question is usable as written. */
const SHORT_QUERY_TERMS = 4;
const EXCERPT_CHARS = 600;

/**
 * Whether each cited article is in force today: the law's 법제처 status (`현행` or not)
 * plus the 시행일 printed on the article text. Nothing is marked current unless both agree.
 */
async function withCurrency(articles: Array<{ law: string; jo: string }>, text: string, enrichment: ResearchEnrichment | undefined,
  context: { requestId: string; signal?: AbortSignal }): Promise<EvidenceArticle[]> {
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
    return [law, exact?.status] as const;
  })));
  // Today in Korea, the calendar 시행일 are stated in.
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10).replaceAll("-", "");
  return articles.map((article) => {
    const status = statuses.get(article.law);
    const date = effective.get(`${article.law}\0${article.jo}`);
    const currency: LawCurrency = status === undefined ? "unconfirmed"
      : status !== "현행" ? "not_current"
      : date && date.length === 8 && date > today ? "upcoming"
      : date ? "current" : "unconfirmed";
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
    supplement: { status: supplement.length ? "found" : "none", articles: supplement },
  });
}

async function fullResearch(
  query: string,
  context: { requestId: string; signal?: AbortSignal },
): Promise<LawResearchData | LawResearchAbsent> {
  // An interpretation may be unavailable without taking away the original
  // question's existing search path. It never supplies factual evidence.
  // The cause is logged (never the question) so a recurring fallback can be traced:
  // a provider quota, a schema rejection and a malformed answer look alike to the user.
  const interpretationStarted = Date.now();
  let interpretationFailure: InterpretationFailure | undefined;
  const interpretation = await interpretResearchQuery(query, context).catch((error: unknown) => {
    const failure = error instanceof ApiError ? error : undefined;
    console.warn("[research] interpretation unavailable, searching the question as written", {
      requestId: context.requestId,
      operation: "research-interpretation",
      code: failure?.code ?? (error instanceof Error ? error.name : "UNKNOWN"),
      status: failure?.status,
      retryAfterMs: failure?.retryAfterMs,
      durationMs: Date.now() - interpretationStarted,
    });
    interpretationFailure = failure?.code === "AI_RATE_LIMITED" ? "rate-limited" : "unavailable";
    return undefined;
  });
  if (context.signal?.aborted) throw new ApiError("LAW_REQUEST_ABORTED", "요청이 취소되었습니다.", 499);
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
    const alternative = issues[1]?.query
      ?? (interpretation && query !== issues[0].query && questionTerms(query).length <= SHORT_QUERY_TERMS ? query : undefined);
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
  context: { requestId: string; signal?: AbortSignal },
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
