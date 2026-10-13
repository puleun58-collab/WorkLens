import { randomUUID } from "node:crypto";
import { z } from "zod";
import { GATE_LABELS, LEVEL_LABELS } from "@/lib/ax/policy";
import { hasInventedMetric, selectEvidence, validCitations } from "@/lib/assistant/evidence";
import type { AssistantContextNote } from "@/lib/assistant/prompt";
import {
  clarifyOptions,
  clarifyResponse,
  classifyQuestion,
  executionRequestResponse,
  isTaskSpecificQuestion,
  resolveClarifyFollowUp,
  INJECTION_RESPONSE,
  NO_EVIDENCE_RESPONSE,
  OUT_OF_SCOPE_RESPONSE,
  type ClarifyState,
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
    taskId: z.string().trim().min(1).max(120).optional(),
  }).strict().optional(),
  // Follow-up answer to a pending clarification ("첫 번째요").
  clarify: z.object({
    clarifyId: z.string().trim().min(1).max(120),
    originalQuestion: z.string().trim().min(1).max(1000),
    options: z.array(z.string().trim().min(1).max(120)).min(1).max(5),
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

    // Resolve a follow-up answer ("첫 번째요") against a pending clarification.
    // The clarify payload is client-generated; validate it matches known options.
    const clarifyInput = parsed.data.clarify;
    let clarifyState: ClarifyState | undefined;
    let effectiveQuestion = question;
    if (clarifyInput) {
      const knownOptions = clarifyOptions(clarifyInput.originalQuestion);
      const optionsValid = clarifyInput.options.length === knownOptions.length
        && clarifyInput.options.every((option, i) => option === knownOptions[i]);
      if (optionsValid) {
        clarifyState = {
          originalQuestion: clarifyInput.originalQuestion,
          options: clarifyInput.options,
          clarifyId: clarifyInput.clarifyId,
        };
        const resolution = resolveClarifyFollowUp(question, clarifyState);
        if (resolution.kind === "select") {
          // Re-ask the original question with the selected intent made explicit.
          effectiveQuestion = `${clarifyInput.originalQuestion} (${resolution.option}에 대해 질문)`;
        } else if (resolution.kind === "affirm" && clarifyState.options.length === 1) {
          effectiveQuestion = `${clarifyInput.originalQuestion} (${clarifyState.options[0]}에 대해 질문)`;
        } else if (resolution.kind === "deny") {
          return ok({ answer: "어떤 의미로 질문하신 건지 다시 알려주세요.", sources: [], relatedScreens: [], kind: "clarify" as const }, 200, requestId);
        } else {
          // Not a selection: treat as a new question, drop the stale clarification.
          clarifyState = undefined;
        }
      }
    }

    const topic = classifyQuestion(effectiveQuestion);
    if (topic === "injection") return ok({ answer: INJECTION_RESPONSE, sources: [], relatedScreens: [], kind: "rejected" as const }, 200, requestId);
    if (topic === "out-of-scope") return ok({ answer: OUT_OF_SCOPE_RESPONSE, sources: [], relatedScreens: [], kind: "rejected" as const }, 200, requestId);
    if (topic === "clarify") {
      const options = clarifyOptions(effectiveQuestion);
      return ok({
        answer: clarifyResponse(effectiveQuestion),
        sources: [],
        relatedScreens: [],
        kind: "clarify" as const,
        clarify: {
          clarifyId: randomUUID(),
          originalQuestion: effectiveQuestion,
          options,
        },
      }, 200, requestId);
    }
    if (topic === "execution-request") {
      return ok({ answer: executionRequestResponse(effectiveQuestion), sources: [], relatedScreens: [], kind: "guidance" as const }, 200, requestId);
    }

    // Task-specific questions need the selected task's diagnosis data.
    // Without user consent, ask for it instead of answering from general policy.
    if (isTaskSpecificQuestion(effectiveQuestion) && !context) {
      return ok({
        answer: "현재 선택된 업무의 진단 정보를 사용해 설명할까요? 답변에 필요한 진단 정보 일부가 AI 처리에 사용됩니다.",
        sources: [],
        relatedScreens: [],
        kind: "consent" as const,
      }, 200, requestId);
    }

    const evidence = selectEvidence(effectiveQuestion);
    if (!evidence.length) return ok({ answer: NO_EVIDENCE_RESPONSE, sources: [], relatedScreens: [], kind: "no-evidence" as const }, 200, requestId);

    const result = await runBoundedOperation(() => runGroqAi(
      { kind: "assistant", question: effectiveQuestion, evidence, ...(context ? { context } : {}), ...(clarifyState ? { clarify: clarifyState } : {}) },
      { requestId },
    ));
    if (result.kind !== "assistant") throw new ApiError("INVALID_PROVIDER_OUTPUT", "AI 응답 형식이 올바르지 않습니다.", 502);

    // Server-side verification: citations must come from the provided evidence,
    // and quantitative claims must be grounded. Otherwise fall back safely.
    if (!validCitations(result.citedIds, evidence) || hasInventedMetric(result.answer, evidence, effectiveQuestion)) {
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

/**
 * Per-client rate limiting for the assistant API.
 *
 * SCOPE AND LIMITATIONS (Cloudflare deployment):
 * - This is an in-memory per-instance limit. It does NOT guarantee a global
 *   limit across multiple instances: each instance tracks its own Map, and a
 *   restart clears all counters.
 * - Client identity uses `cf-connecting-ip` first. Cloudflare overwrites this
 *   header at the edge, so clients cannot spoof it when the request actually
 *   passes through Cloudflare. `x-forwarded-for` is only a fallback and CAN be
 *   spoofed by direct clients; it is not trusted for strong identity.
 * - The limit is enforced BEFORE the AI provider call (see POST flow), so a
 *   limited client never consumes provider budget.
 * - This is a cost-abuse backstop, not a security boundary. For stronger
 *   guarantees, use Cloudflare Rate Limiting rules at the edge.
 */
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
