import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, apiError, ok, readBoundedJson, requireSameSite, runBoundedOperation } from "@/server/http";
import { getLawText } from "@/server/law-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LAW_BODY_BYTES = 2 * 1024;
/**
 * MST는 법령 일련번호라 구 법령 버전은 6자리보다 짧을 수 있다
 * (예: 1965년 시행 민법 MST 58432 — 시점별 적용 분석이 실제로 반환하는 값).
 * lawId는 앞자리 0을 포함하는 고정 6자리 코드라 그대로 둔다.
 */
const mstIdentifier = z.string().regex(/^\d{1,6}$/u);
const lawIdIdentifier = z.string().regex(/^\d{6}$/u);
const articleNumber = z.string().regex(/^제[1-9]\d{0,3}조(?:의[1-9]\d?)?$/u);
const lawTextRequestSchema = z.union([
  z.object({ mst: mstIdentifier, jo: articleNumber.optional() }).strict(),
  z.object({ lawId: lawIdIdentifier, jo: articleNumber.optional() }).strict(),
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
