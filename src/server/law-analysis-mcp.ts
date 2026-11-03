import { normalizeAnalysisDate, type LawAnalysisAbsent, type LawAnalysisData, type LawAnalysisRequest, type LawScheduledVersion, type LawTemporalMetadata } from "@/lib/law-analysis";
import { ApiError } from "@/server/http";
import { callLawTool } from "@/server/law-mcp";

const markerPattern = /\[([A-Z][A-Z_]+)\]/gu;

/** Only leading status markers classify the whole result; inline section failures are still partial results. */
export function classifyLawToolResult(
  text: string,
  isError: boolean,
  options: { acceptErrorPrefix?: string; failureMessage?: string } = {},
): { kind: "found"; markers: string[] } | { kind: "absent"; marker: "NOT_FOUND" } {
  const failed = () => new ApiError("LAW_MCP_ERROR", options.failureMessage ?? "검증·분석 서비스가 요청을 처리하지 못했습니다.", 502);
  if (!text.trim()) throw failed();
  const leading = text.trimStart();
  if (leading.startsWith("[NOT_FOUND]") || leading.startsWith("[LAW_NOT_FOUND]")) {
    return { kind: "absent", marker: "NOT_FOUND" };
  }
  if (leading.startsWith("[INVALID_ARGUMENT]")) throw failed();
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
/** Expand each official staged commencement; a single MST/act number may have several dates. */
export function scheduledLawVersions(source: string, lawName: string, referenceDate: string): LawScheduledVersion[] {
  const versions = new Map<string, LawScheduledVersion>();
  for (const line of source.split(/\r?\n/u)) {
    const match = /^🔜\s*「([^」]+)」\s*개정 시행예정\s*\(([^,]+),\s*(\d{4}-\d{2}-\d{2})\s*공포\s*(제[^,\s]+호),\s*시행\s*([^)]+)\)[^\n]*get_law_text\(mst="(\d+)"/u.exec(line);
    if (!match || match[1].replace(/\s/gu, "") !== lawName.replace(/\s/gu, "")) continue;
    for (const date of match[5].matchAll(/\d{4}-\d{2}-\d{2}/gu)) {
      const normalized = normalizeAnalysisDate(date[0]);
      if (!normalized) continue;
      const effectiveDate = normalized.replace(/-/gu, "");
      if (effectiveDate <= referenceDate) continue;
      const version: LawScheduledVersion = { lawName: match[1], mst: match[6], effectiveDate,
        promulgationDate: match[3].replace(/-/gu, ""), promulgationNumber: match[4], revision: match[2], line };
      versions.set(`${version.mst}:${effectiveDate}`, version);
    }
  }
  return [...versions.values()].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.mst.localeCompare(b.mst));
}

async function temporalMetadata(
  request: Extract<LawAnalysisRequest, { mode: "applicable_law" }>,
  text: string,
  context: { requestId: string; signal?: AbortSignal },
): Promise<LawTemporalMetadata | undefined> {
  const count = /시행\s*예정\s*개정\s*(\d+)건/u.exec(text);
  if (!count || Number(count[1]) === 0) return undefined;
  const selectedName = /^\s*(.+?)\s*\[시행\s+\d{4}[.-]\d{2}[.-]\d{2}\]/mu.exec(text)?.[1];
  if (!selectedName) return { futureVersions: [], futureComplete: false,
    futureError: "선택 법령의 정확한 제명을 확인하지 못해 시행 예정 목록을 확정하지 않았습니다." };
  try {
    const result = await callLawTool("search_law", { query: selectedName }, context);
    const classification = classifyLawToolResult(result.text, result.isError);
    // The upstream count describes the published schedule, not the remainder after the user's reference date.
    const publishedVersions = classification.kind === "found"
      ? scheduledLawVersions(result.text, selectedName, "") : [];
    const referenceDate = request.date.replace(/-/gu, "");
    const futureVersions = publishedVersions.filter((version) => version.effectiveDate > referenceDate);
    return { futureVersions, futureSourceText: result.text,
      futureComplete: publishedVersions.length === Number(count[1]) };
  } catch (error) {
    if (context.signal?.aborted) throw error;
    return { futureVersions: [], futureComplete: false,
      futureError: "공식 시행 예정 목록을 조회하지 못했습니다. 분석 원자료의 일부 안내만 보존합니다." };
  }
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
  const temporal = request.mode === "applicable_law" ? await temporalMetadata(request, text, context) : undefined;
  return { found: true, mode: request.mode, text, markers: classification.markers, ...(temporal ? { temporal } : {}) };
}
