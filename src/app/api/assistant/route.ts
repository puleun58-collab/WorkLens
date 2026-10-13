import { randomUUID } from "node:crypto";
import { z } from "zod";
import { GATE_LABELS, LEVEL_LABELS } from "@/lib/ax/policy";
import { hasInventedMetric, selectEvidence, validCitations } from "@/lib/assistant/evidence";
import type { AssistantContextNote } from "@/lib/assistant/prompt";
import {
  classifyQuestion,
  clarifyResponse,
  executionRequestResponse,
  INJECTION_RESPONSE,
  NO_EVIDENCE_RESPONSE,
  OUT_OF_SCOPE_RESPONSE,
} from "@/lib/assistant/topics";
import { runGroqAi } from "@/server/groq";
import { ApiError, apiError, ok, readBoundedJson, requireSameSite, runBoundedOperation } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AI_BODY_BYTES = 16 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const requestsByClient = new Map<string, { startedAt: number; count: number }>();

const LEVEL_VALUES = new Set<string>(LEVEL_LABELS);
const GATE_VALUES = new Set<string>(Object.values(GATE_LABELS));

const assistantRequestSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  context: z.object({
    taskName: z.string().trim().min(1).max(120),
    levelLabel: z.string().trim().min(1).max(40),
    gateLabel: z.string().trim().min(1).max(40),
    scopeNote: z.string().trim().min(1).max(300),
  }).strict().optional(),
}).strict();

/**
 * Client-provided context is untrusted input: only known policy labels pass through,
 * and the model still treats it as a user claim, never as authoritative policy output.
 */
function sanitizeContext(context: z.infer<typeof assistantRequestSchema>["context"]): AssistantContextNote | undefined {
  if (!context) return undefined;
  if (!LEVEL_VALUES.has(context.levelLabel) || !GATE_VALUES.has(context.gateLabel)) return undefined;
  return { ...context };
}

export async function POST(request: Request) {
  const requestId = randomUUID();
  try {
    requireSameSite(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new ApiError("CONTENT_TYPE_REQUIRED", "JSON 요청만 허용됩니다.", 415);
    }
    enforceRateLimit(request);
    const parsed = assistantRequestSchema.safeParse(await readBoundedJson(request, MAX_AI_BODY_BYTES));
    if (!parsed.success) throw new ApiError("INVALID_REQUEST", "질문을 확인해 주세요.", 400);
    const { question } = parsed.data;
    const context = sanitizeContext(parsed.data.context);

    const topic = classifyQuestion(question);
    if (topic === "injection") return ok({ answer: INJECTION_RESPONSE, sources: [], relatedScreens: [], kind: "rejected" as const }, 200, requestId);
    if (topic === "out-of-scope") return ok({ answer: OUT_OF_SCOPE_RESPONSE, sources: [], relatedScreens: [], kind: "rejected" as const }, 200, requestId);
    if (topic === "clarify") {
      return ok({ answer: clarifyResponse(question), sources: [], relatedScreens: [], kind: "clarify" as const }, 200, requestId);
    }
    if (topic === "execution-request") {
      return ok({ answer: executionRequestResponse(question), sources: [], relatedScreens: [], kind: "guidance" as const }, 200, requestId);
    }

    const evidence = selectEvidence(question);
    if (!evidence.length) return ok({ answer: NO_EVIDENCE_RESPONSE, sources: [], relatedScreens: [], kind: "no-evidence" as const }, 200, requestId);

    const result = await runBoundedOperation(() => runGroqAi(
      { kind: "assistant", question, evidence, ...(context ? { context } : {}) },
      { requestId },
    ));
    if (result.kind !== "assistant") throw new ApiError("INVALID_PROVIDER_OUTPUT", "AI 응답 형식이 올바르지 않습니다.", 502);

    // Server-side verification: citations must come from the provided evidence,
    // and quantitative claims must be grounded. Otherwise fall back safely.
    if (!validCitations(result.citedIds, evidence) || hasInventedMetric(result.answer, evidence, question)) {
      return ok({ answer: NO_EVIDENCE_RESPONSE, sources: [], relatedScreens: [], kind: "no-evidence" as const }, 200, requestId);
    }
    // Separate evidence by kind: policy/diagnosis → "참고 근거", menu → "관련 화면", guide → hidden
    const cited = result.citedIds
      .map((id) => evidence.find((entry) => entry.id === id))
      .filter((entry) => entry !== undefined);
    const sources = cited
      .filter((entry) => entry.kind === "policy" || entry.kind === "diagnosis")
      .map((entry) => ({ screen: entry.screen, title: entry.title }));
    const relatedScreens = cited
      .filter((entry) => entry.kind === "menu")
      .map((entry) => ({ screen: entry.screen, title: entry.title }));
    // guide kind: shown in answer body only, no separate UI section
    return ok({ answer: result.answer, sources, relatedScreens, kind: "answer" as const }, 200, requestId);
  } catch (error) {
    return apiError(error, requestId);
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
