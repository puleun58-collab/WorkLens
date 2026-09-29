import type { LawResearchAbsent, LawResearchData, LawResearchRequest } from "@/lib/law-research";
import { researchEvidenceSources } from "@/lib/research-relevance";
import { classifyLawToolResult } from "@/server/law-analysis-mcp";
import { callLawTool } from "@/server/law-mcp";
import { mcpReviewSources, reviewContract } from "@/server/contract-review";
import { interpretResearchQuery } from "@/server/groq";
import { ApiError } from "@/server/http";
import { enrichResearch, mcpEnrichmentSources } from "@/server/research-enrichment";

const RESEARCH_FAILURE = "법령 리서치 서비스가 요청을 처리하지 못했습니다.";

async function fullResearch(
  query: string,
  context: { requestId: string; signal?: AbortSignal },
): Promise<LawResearchData | LawResearchAbsent> {
  // An interpretation may be unavailable without taking away the original
  // question's existing search path. It never supplies factual evidence.
  const interpretation = await interpretResearchQuery(query, context).catch(() => undefined);
  if (context.signal?.aborted) throw new ApiError("LAW_REQUEST_ABORTED", "요청이 취소되었습니다.", 499);
  // The upstream search AND-matches words, so issues are searched one at a time,
  // never joined: the primary issue first, then (once) the user's own wording.
  const issue = interpretation?.issues[0]?.slice(0, 500) || query;
  const attempt = async (searchQuery: string) => {
    const { text, isError } = await callLawTool("legal_research", { task: "full_research", query: searchQuery }, context);
    const classification = classifyLawToolResult(text, isError, { failureMessage: RESEARCH_FAILURE });
    if (classification.kind === "absent") return { found: false as const, task: "full_research" as const, marker: "NOT_FOUND" as const, text };
    const enrichment = await enrichResearch("full_research", issue, text, mcpEnrichmentSources(context)).catch(() => undefined);
    const issues = interpretation?.issues ?? [query];
    const matched = issues.map((item) => researchEvidenceSources(text, item, enrichment));
    const matchedCount = matched.filter((sources) => sources.articles.length || sources.precedents.length).length;
    const status = matchedCount === issues.length ? "matched" as const : matchedCount ? "partial" as const : "unverified" as const;
    const articles = [...new Map(matched.flatMap((sources) => sources.articles).map((article) => [`${article.law}\0${article.jo}`, article])).values()];
    const precedents = [...new Set(matched.flatMap((sources) => sources.precedents))];
    const precedentExcerpts = precedents.length ? Object.fromEntries(precedents.flatMap((id) => enrichment?.precedentExcerpts?.[id]
      ? [[id, enrichment.precedentExcerpts[id]]] : [])) : undefined;
    return { found: true as const, task: "full_research" as const, text, markers: classification.markers,
      ...(enrichment ? { enrichment } : {}), evidence: { status, articles, precedents,
        ...(precedentExcerpts && Object.keys(precedentExcerpts).length ? { precedentExcerpts } : {}) } };
  };
  const first = await attempt(issue);
  if (!interpretation || (first.found && first.evidence.status === "matched")) {
    return { ...first, ...(interpretation ? { interpretation } : {}) };
  }
  // One alternative retrieval only. A failed second lookup never erases an official first response.
  const alternative = issue !== query ? query : interpretation.searchTerms.find((term) => term !== issue);
  if (!alternative) {
    return { ...first, interpretation };
  }
  const second = await attempt(alternative).catch((error: unknown) => {
    if (context.signal?.aborted) throw error;
    return undefined;
  });
  const score: Record<"unverified" | "partial" | "matched", number> = { unverified: 0, partial: 1, matched: 2 };
  const selected = second?.found && (!first.found || score[second.evidence.status] > score[first.evidence.status]) ? second : first;
  return { ...selected, interpretation };
}

export async function runLegalResearch(
  request: LawResearchRequest,
  context: { requestId: string; signal?: AbortSignal },
): Promise<LawResearchData | LawResearchAbsent> {
  // Document review decides the document's type and each clause's issue before
  // any search, then searches only the areas of law that fit (see contract-review).
  if (request.task === "document_review") {
    const review = await reviewContract(request.text, mcpReviewSources(context));
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
        return callLawTool("legal_research", { task: request.task, query: request.query,
          ...(request.parentLaw ? { parentLaw: request.parentLaw } : {}) }, context);
    }
  })();
  const { text, isError } = await result;
  const classification = classifyLawToolResult(text, isError, {
    failureMessage: RESEARCH_FAILURE,
  });
  if (classification.kind === "absent") {
    return { found: false, task: request.task, marker: "NOT_FOUND", text };
  }
  // Action-basis enrichment keeps its previous behavior; full research is handled above.
  if (request.task === "action_basis") {
    const enrichment = await enrichResearch(request.task, request.query, text, mcpEnrichmentSources(context)).catch(() => undefined);
    if (enrichment) return { found: true, task: request.task, text, markers: classification.markers, enrichment };
  }
  return { found: true, task: request.task, text, markers: classification.markers };
}
