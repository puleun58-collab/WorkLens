import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LAW_ANALYSIS_BODY_MAX_BYTES, LAW_ANALYSIS_CASE_MAX_CHARS, LAW_ANALYSIS_CASE_PATTERN,
  LAW_ANALYSIS_JO_PATTERN, LAW_ANALYSIS_LAW_NAME_MAX_CHARS, LAW_ANALYSIS_TEXT_MAX_CHARS,
  normalizeAnalysisDate } from "@/lib/law-analysis";
import { ApiError, apiError, ok, readBoundedJson, requireSameSite, runBoundedOperation } from "@/server/http";
import { runLegalAnalysis } from "@/server/law-analysis-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const lawName = z.string().trim().min(1).max(LAW_ANALYSIS_LAW_NAME_MAX_CHARS).refine((value) => !/[\p{Cc}]/u.test(value));
const jo = z.string().trim().regex(LAW_ANALYSIS_JO_PATTERN);
const analysisRequest = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("verify_citations"), text: z.string().trim().min(1).max(LAW_ANALYSIS_TEXT_MAX_CHARS) }).strict(),
  z.object({ mode: z.literal("cite_check"), caseNumber: z.string().trim().min(1).max(LAW_ANALYSIS_CASE_MAX_CHARS).regex(LAW_ANALYSIS_CASE_PATTERN) }).strict(),
  z.object({ mode: z.literal("applicable_law"), lawName, date: z.string().transform(normalizeAnalysisDate).pipe(z.string()), jo: jo.optional() }).strict(),
  z.object({ mode: z.literal("impact_map"), lawName, jo }).strict(),
]);

export async function POST(request: Request) {
  const requestId = randomUUID();
  try {
    requireSameSite(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new ApiError("CONTENT_TYPE_REQUIRED", "JSON 요청만 허용됩니다.", 415);
    }
    const parsed = analysisRequest.safeParse(await readBoundedJson(request, LAW_ANALYSIS_BODY_MAX_BYTES));
    if (!parsed.success) throw new ApiError("LAW_INVALID_REQUEST", "검증·분석 입력을 확인하세요.", 400);
    const result = await runBoundedOperation(() => runLegalAnalysis(parsed.data, { requestId, signal: request.signal }));
    return ok(result, 200, requestId);
  } catch (error) {
    return apiError(error, requestId);
  }
}
