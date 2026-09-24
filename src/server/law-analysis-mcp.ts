import type { LawAnalysisAbsent, LawAnalysisData, LawAnalysisRequest } from "@/lib/law-analysis";
import { ApiError } from "@/server/http";
import { callLawTool } from "@/server/law-mcp";

const markerPattern = /\[([A-Z][A-Z_]+)\]/gu;

/** Only leading status markers classify the whole result; inline section failures are still partial results. */
export function classifyLawToolResult(
  text: string,
  isError: boolean,
  options: { acceptErrorPrefix?: string; failureMessage?: string } = {},
): { kind: "found"; markers: string[] } | { kind: "absent"; marker: "NOT_FOUND" | "INVALID_ARGUMENT" } {
  const failed = () => new ApiError("LAW_MCP_ERROR", options.failureMessage ?? "검증·분석 서비스가 요청을 처리하지 못했습니다.", 502);
  if (!text.trim()) throw failed();
  const leading = text.trimStart();
  if (leading.startsWith("[NOT_FOUND]") || leading.startsWith("[LAW_NOT_FOUND]")) {
    return { kind: "absent", marker: "NOT_FOUND" };
  }
  if (leading.startsWith("[INVALID_ARGUMENT]")) {
    return { kind: "absent", marker: "INVALID_ARGUMENT" };
  }
  if (leading.startsWith("[RATE_LIMITED]")) {
    throw new ApiError("LAW_RATE_LIMITED", "법령 검색 요청이 많습니다. 잠시 후 다시 시도하세요.", 429);
  }
  if (leading.startsWith("[REQUEST_TIMEOUT]")) {
    throw new ApiError("LAW_UPSTREAM_TIMEOUT", "법령 검색 응답 시간이 초과되었습니다. 다시 시도하세요.", 504);
  }
  if (leading.startsWith("[UPSTREAM_NO_DATA]")) {
    throw new ApiError("LAW_UPSTREAM_NO_DATA", "법제처가 자료를 반환하지 않았습니다. 자료가 없다는 뜻은 아니므로 잠시 후 다시 시도하세요.", 502);
  }
  if (["[EXTERNAL_API_ERROR]", "[PARSE_ERROR]", "[INVALID_PARAMETER]", "[ANNEX_BODY_UNAVAILABLE]", "[ERROR]"].some((marker) => leading.startsWith(marker))) {
    throw failed();
  }
  if (isError && !(options.acceptErrorPrefix && leading.startsWith(options.acceptErrorPrefix))) {
    throw failed();
  }
  return { kind: "found", markers: [...new Set(Array.from(text.matchAll(markerPattern), (match) => match[1]))] };
}
export async function runLegalAnalysis(
  request: LawAnalysisRequest,
  context: { requestId: string; signal?: AbortSignal },
): Promise<LawAnalysisData | LawAnalysisAbsent> {
  const result = (() => {
    switch (request.mode) {
      case "verify_citations":
        return callLawTool("legal_analysis", { mode: request.mode, text: request.text, maxCitations: 15 }, context);
      case "cite_check":
        return callLawTool("legal_analysis", { mode: request.mode, caseNumber: request.caseNumber, display: 20, deepScan: true }, context);
      case "applicable_law":
        return callLawTool("legal_analysis", { mode: request.mode, lawName: request.lawName, date: request.date,
          ...(request.jo ? { jo: request.jo } : {}) }, context);
      case "impact_map":
        return callLawTool("legal_analysis", { mode: request.mode, lawName: request.lawName, jo: request.jo,
          includeOrdinances: true, includeMermaid: false }, context);
    }
  })();
  const { text, isError } = await result;
  const classification = classifyLawToolResult(text, isError, {
    ...(request.mode === "verify_citations" ? { acceptErrorPrefix: "[HALLUCINATION_DETECTED]" } : {}),
  });
  if (classification.kind === "absent") {
    return { found: false, mode: request.mode, marker: classification.marker, text };
  }
  return { found: true, mode: request.mode, text, markers: classification.markers };
}
