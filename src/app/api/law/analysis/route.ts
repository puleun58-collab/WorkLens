import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LAW_ANALYSIS_BODY_MAX_BYTES, LAW_ANALYSIS_CASE_MAX_CHARS, LAW_ANALYSIS_CASE_PATTERN,
  LAW_ANALYSIS_JO_PATTERN, LAW_ANALYSIS_LAW_NAME_MAX_CHARS, LAW_ANALYSIS_TEXT_MAX_CHARS,
  normalizeAnalysisDate, normalizeCaseNumber } from "@/lib/law-analysis";
import { ApiError, apiError, ok, readBoundedJson, requireSameSite, runBoundedOperation } from "@/server/http";
import { runLegalAnalysis } from "@/server/law-analysis-mcp";
import { assessCitationClaims } from "@/server/citation-claim-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const lawName = z.string().trim().min(1).max(LAW_ANALYSIS_LAW_NAME_MAX_CHARS).refine((value) => !/[\p{Cc}]/u.test(value));
const jo = z.string().trim().regex(LAW_ANALYSIS_JO_PATTERN);
const analysisRequest = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("verify_citations"), text: z.string().trim().min(1).max(LAW_ANALYSIS_TEXT_MAX_CHARS) }).strict(),
  z.object({ mode: z.literal("cite_check"), caseNumber: z.string().transform(normalizeCaseNumber)
    .pipe(z.string().min(1).max(LAW_ANALYSIS_CASE_MAX_CHARS).regex(LAW_ANALYSIS_CASE_PATTERN)) }).strict(),
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
    // verify_citations only: the upstream verifier establishes existence. A
    // second, local check judges whether each verified citation's article
    // text actually supports the input sentence's claim. If this whole check
    // throws, the field is omitted and the existence result stands alone —
    // never inflated, never downgraded by a failed check.
    if (result.found && parsed.data.mode === "verify_citations") {
      try {
        const claimSupport = await assessCitationClaims(parsed.data.text, result.text, { requestId, signal: request.signal });
        // An empty assessment list means nothing was verified to assess; omit
        // the field so the response contract is unchanged for those calls.
        if (claimSupport.length) return ok({ ...result, claimSupport }, 200, requestId);
      } catch {
        // Fall through with the unassessed existence result.
      }
    }
    return ok(result, 200, requestId);
  } catch (error) {
    return apiError(error, requestId);
  }
}
