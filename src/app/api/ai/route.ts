import { parseAiApiRequest } from "@/server/ai-request";
import { runGroqAi } from "@/server/groq";
import { ApiError, apiError, ok, readBoundedJson, requireSameSite, runBoundedOperation } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AI_BODY_BYTES = 24 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;
const requestsByClient = new Map<string, { startedAt: number; count: number }>();

export async function POST(request: Request) {
  try {
    requireSameSite(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new ApiError("CONTENT_TYPE_REQUIRED", "JSON 요청만 허용됩니다.", 415);
    }
    enforceRateLimit(request);
    const input = parseAiApiRequest(await readBoundedJson(request, MAX_AI_BODY_BYTES));
    const result = await runBoundedOperation(() => runGroqAi(input));
    return ok(result);
  } catch (error) {
    return apiError(error);
  }
}

function enforceRateLimit(request: Request): void {
  const now = Date.now();
  const client = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim()
    ?? "local";
  const current = requestsByClient.get(client);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    requestsByClient.set(client, { startedAt: now, count: 1 });
  } else {
    current.count += 1;
    if (current.count > RATE_LIMIT) {
      throw new ApiError("AI_RATE_LIMITED", "요청이 너무 많습니다. 잠시 후 다시 시도하세요.", 429);
    }
  }

  if (requestsByClient.size > 1_000) {
    for (const [key, window] of requestsByClient) {
      if (now - window.startedAt >= RATE_WINDOW_MS) requestsByClient.delete(key);
    }
  }
}
