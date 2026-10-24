import { randomUUID } from "node:crypto";
import { z } from "zod";
import { classifyLawError, formatLawLog, type LawOutcomeClass, type LawRequestStats } from "@/lib/law-observability";
import { ApiError, apiError, ok, readBoundedJson, requireSameSite, runBoundedOperation } from "@/server/http";
import { LAW_QUERY_MAX_CHARS, searchLaw } from "@/server/law-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LAW_BODY_BYTES = 2 * 1024;
/** Only a query: the tool, upstream URL and credentials are fixed on the server. */
const lawRequestSchema = z.object({
  query: z.string().trim().min(1).max(LAW_QUERY_MAX_CHARS),
}).strict();

export async function POST(request: Request) {
  const requestId = randomUUID();
  const startMs = Date.now();
  // 운영 관측: 메타데이터만 로그 (검색어 등 PII 제외).
  // retries는 callLawTool이 실제 재시도할 때마다 stats에 누적한 실제 값이다.
  const stats: LawRequestStats = { retries: 0 };
  const observe = (outcome: LawOutcomeClass, httpStatus: number, errorCode?: string) => {
    console.log(formatLawLog({
      requestId, task: "law_search", startMs, endMs: Date.now(), httpStatus, outcome, retries: stats.retries,
      ...(errorCode ? { errorCode } : {}),
    }));
  };
  try {
    requireSameSite(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new ApiError("CONTENT_TYPE_REQUIRED", "JSON 요청만 허용됩니다.", 415);
    }
    const parsed = lawRequestSchema.safeParse(await readBoundedJson(request, MAX_LAW_BODY_BYTES));
    if (!parsed.success) throw new ApiError("LAW_INVALID_REQUEST", `검색어를 1~${LAW_QUERY_MAX_CHARS}자로 입력하세요.`, 400);
    const result = await runBoundedOperation(() => searchLaw(parsed.data.query, { requestId, signal: request.signal, stats }));
    observe(result.found ? "success" : "no_data", 200);
    return ok(result, 200, requestId);
  } catch (error) {
    const code = error instanceof ApiError ? error.code : undefined;
    observe(classifyLawError(code), error instanceof ApiError ? error.status : 500, code);
    return apiError(error, requestId);
  }
}
