import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, apiError, ok, readBoundedJson, requireSameSite, runBoundedOperation } from "@/server/http";
import { getLawText } from "@/server/law-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LAW_BODY_BYTES = 2 * 1024;
const identifier = z.string().regex(/^\d{6}$/u);
const articleNumber = z.string().regex(/^제[1-9]\d{0,3}조(?:의[1-9]\d?)?$/u);
const lawTextRequestSchema = z.union([
  z.object({ mst: identifier, jo: articleNumber.optional() }).strict(),
  z.object({ lawId: identifier, jo: articleNumber.optional() }).strict(),
]);

export async function POST(request: Request) {
  const requestId = randomUUID();
  try {
    requireSameSite(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new ApiError("CONTENT_TYPE_REQUIRED", "JSON 요청만 허용됩니다.", 415);
    }
    const parsed = lawTextRequestSchema.safeParse(await readBoundedJson(request, MAX_LAW_BODY_BYTES));
    if (!parsed.success) throw new ApiError("LAW_INVALID_REQUEST", "법령 식별자와 조문 번호를 확인하세요.", 400);
    const { jo } = parsed.data;
    const identifier = "mst" in parsed.data ? { mst: parsed.data.mst } : { lawId: parsed.data.lawId };
    const result = await runBoundedOperation(() => getLawText(identifier, jo, { requestId, signal: request.signal }));
    return ok(result, 200, requestId);
  } catch (error) {
    return apiError(error, requestId);
  }
}
