import type { LawResearchAbsent, LawResearchData, LawResearchRequest } from "@/lib/law-research";
import { ApiError } from "@/server/http";
import { classifyLawToolResult } from "@/server/law-analysis-mcp";
import { callLawTool } from "@/server/law-mcp";
import { mcpReviewSources, reviewContract } from "@/server/contract-review";

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
  const result = (() => {
    switch (request.task) {
      case "full_research":
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
    failureMessage: "법령 리서치 서비스가 요청을 처리하지 못했습니다.",
  });
  if (classification.kind === "absent") {
    if (classification.marker === "INVALID_ARGUMENT") {
      throw new ApiError("LAW_MCP_ERROR", "법령 리서치 서비스가 요청을 처리하지 못했습니다.", 502);
    }
    return { found: false, task: request.task, marker: "NOT_FOUND", text };
  }
  return { found: true, task: request.task, text, markers: classification.markers };
}
