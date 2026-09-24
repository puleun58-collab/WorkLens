import { randomUUID } from "node:crypto";
import { z } from "zod";
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
  try {
    requireSameSite(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new ApiError("CONTENT_TYPE_REQUIRED", "JSON 요청만 허용됩니다.", 415);
    }
    const parsed = lawRequestSchema.safeParse(await readBoundedJson(request, MAX_LAW_BODY_BYTES));
    if (!parsed.success) throw new ApiError("LAW_INVALID_REQUEST", `검색어를 1~${LAW_QUERY_MAX_CHARS}자로 입력하세요.`, 400);
    const result = await runBoundedOperation(() => searchLaw(parsed.data.query, { requestId, signal: request.signal }));
    return ok(result, 200, requestId);
  } catch (error) {
    return apiError(error, requestId);
  }
}
