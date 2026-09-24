import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DECISION_DOMAINS, type DecisionDomain } from "@/lib/decision-domain";
import { ApiError, apiError, ok, readBoundedJson, requireSameSite, runBoundedOperation } from "@/server/http";
import { getDecisionText } from "@/server/decision-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const textRequest = z.object({
  domain: z.enum(DECISION_DOMAINS.map(({ value }) => value) as [DecisionDomain, ...DecisionDomain[]]),
  id: z.string().regex(/^\d{1,32}$/u),
  full: z.literal(true).optional(),
}).strict();

export async function POST(request: Request) {
  const requestId = randomUUID();
  try {
    requireSameSite(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new ApiError("CONTENT_TYPE_REQUIRED", "JSON 요청만 허용됩니다.", 415);
    }
    const parsed = textRequest.safeParse(await readBoundedJson(request, 2 * 1024));
    if (!parsed.success) throw new ApiError("LAW_INVALID_REQUEST", "결정례 범위와 검색 결과의 일련번호를 확인하세요.", 400);
    const { domain, id, full } = parsed.data;
    const result = await runBoundedOperation(() => getDecisionText(domain, id, full, { requestId, signal: request.signal }));
    return ok(result, 200, requestId);
  } catch (error) {
    return apiError(error, requestId);
  }
}
