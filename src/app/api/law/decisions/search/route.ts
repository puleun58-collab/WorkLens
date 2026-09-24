import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DECISION_DOMAINS, type DecisionDomain } from "@/lib/decision-domain";
import { ApiError, apiError, ok, readBoundedJson, requireSameSite, runBoundedOperation } from "@/server/http";
import { LAW_QUERY_MAX_CHARS } from "@/server/law-mcp";
import { searchDecisions } from "@/server/decision-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const searchRequest = z.object({
  domain: z.enum(DECISION_DOMAINS.map(({ value }) => value) as [DecisionDomain, ...DecisionDomain[]]),
  query: z.string().trim().min(1).max(LAW_QUERY_MAX_CHARS),
  page: z.number().int().min(1).max(1000).optional(),
}).strict();

export async function POST(request: Request) {
  const requestId = randomUUID();
  try {
    requireSameSite(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new ApiError("CONTENT_TYPE_REQUIRED", "JSON 요청만 허용됩니다.", 415);
    }
    const parsed = searchRequest.safeParse(await readBoundedJson(request, 2 * 1024));
    if (!parsed.success) throw new ApiError("LAW_INVALID_REQUEST", "검색 범위·검색어·페이지를 확인하세요.", 400);
    const { domain, query, page = 1 } = parsed.data;
    const result = await runBoundedOperation(() => searchDecisions(domain, query, page, { requestId, signal: request.signal }));
    return ok(result, 200, requestId);
  } catch (error) {
    return apiError(error, requestId);
  }
}
