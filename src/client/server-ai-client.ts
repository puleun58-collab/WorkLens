import { z } from "zod";
import type { AiRequest } from "@/domain/ai";
import type { PolishMode, PolishProposal } from "@/domain/polish";
import type { AiApiRequest, AiApiResult, ServerAiErrorCode, ServerAiFailure } from "@/lib/ai/api";
import type { ExtractProposal } from "@/lib/ai/extract-prompt";
import type { EvidenceItem, ModelClaim } from "@/lib/ai/prompt";

const CLIENT_TIMEOUT_MS = 35_000;
let activeController: AbortController | undefined;

const confidenceSchema = z.enum(["high", "medium", "low"]);
const aiResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("claims"),
    claims: z.array(z.object({
      text: z.string(),
      handles: z.array(z.string()),
      confidence: confidenceSchema,
      presentation: z.object({
        role: z.enum(["summary", "insight"]),
        section: z.string().optional(),
      }).optional(),
    })),
  }),
  z.object({
    kind: z.literal("polish"),
    proposal: z.object({
      changed: z.boolean(),
      revisedText: z.string(),
      reasons: z.array(z.string()),
    }),
  }),
  z.object({
    kind: z.literal("extract"),
    proposal: z.object({
      field: z.string(),
      value: z.string().nullable(),
      handles: z.array(z.string()),
      confidence: confidenceSchema,
    }),
  }),
]);
const successEnvelopeSchema = z.object({ data: aiResultSchema });
const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.string() }),
  requestId: z.string().optional(),
});

const MESSAGES: Record<ServerAiErrorCode, string> = {
  BUSY: "다른 AI 작업이 진행 중입니다.",
  CANCELLED: "AI 작업을 중지했습니다.",
  TIMEOUT: "AI 응답 시간이 초과되었습니다. 다시 시도하세요.",
  CONFIGURATION: "AI 서비스 설정을 확인할 수 없습니다.",
  RATE_LIMITED: "AI 사용 한도에 도달했습니다. 잠시 후 다시 시도하세요.",
  PROVIDER_UNAVAILABLE: "AI 서비스에 일시적으로 연결할 수 없습니다.",
  PROVIDER_REJECTED: "AI 서비스가 요청을 처리하지 못했습니다.",
  OPERATION_CAPACITY: "AI 작업이 많습니다. 잠시 후 다시 시도하세요.",
  INVALID_OUTPUT: "AI 응답을 안전하게 확인하지 못했습니다.",
  INVALID_REQUEST: "AI 요청 형식이 올바르지 않습니다.",
  GROUNDING_REJECTED: "AI 답변을 문서 근거와 연결하지 못했습니다.",
  NO_EVIDENCE: "선택한 문서에서 답변 근거를 찾지 못했습니다.",
};

export { MESSAGES as SERVER_AI_MESSAGES };

const FAILURE_DETAIL: Record<ServerAiErrorCode, string> = {
  CONFIGURATION: "AI 설정 오류",
  RATE_LIMITED: "사용 한도",
  OPERATION_CAPACITY: "작업 대기 필요",
  TIMEOUT: "응답 지연",
  PROVIDER_UNAVAILABLE: "AI 서비스 일시 오류",
  PROVIDER_REJECTED: "AI 요청 처리 실패",
  INVALID_OUTPUT: "AI 응답 형식 오류",
  INVALID_REQUEST: "AI 요청 오류",
  GROUNDING_REJECTED: "근거 연결 실패",
  NO_EVIDENCE: "관련 근거 없음",
  BUSY: "다른 AI 작업 진행 중",
  CANCELLED: "작업 중지됨",
};

/** Stable, user-facing reason shared by every feature that invokes server AI. */
export function aiFailureDetail(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
  return typeof code === "string" && Object.hasOwn(FAILURE_DETAIL, code)
    ? FAILURE_DETAIL[code as ServerAiErrorCode]
    : "AI 처리 오류";
}

export function logAiFailure(error: unknown): void {
  const failure = error as Partial<ServerAiFailure>;
  console.warn("[worklens] AI failure", {
    operation: failure.operation,
    code: failure.code,
    serverCode: failure.serverCode,
    requestId: failure.requestId,
    occurredAt: failure.occurredAt,
  });
}
export type { ServerAiFailure };

export async function generateServerAi(request: AiRequest, items: EvidenceItem[]): Promise<ModelClaim[]> {
  const result = await send({ kind: "claims", request, items });
  if (result.kind !== "claims") throw failure("INVALID_OUTPUT", "claims");
  return result.claims;
}

export async function polishServerAi(text: string, mode: PolishMode): Promise<PolishProposal> {
  const result = await send({ kind: "polish", text, mode });
  if (result.kind !== "polish") throw failure("INVALID_OUTPUT", "polish");
  return result.proposal;
}

export async function extractServerAi(field: string, items: EvidenceItem[]): Promise<ExtractProposal> {
  const result = await send({ kind: "extract", field, items });
  if (result.kind !== "extract") throw failure("INVALID_OUTPUT", "extract");
  return result.proposal;
}

export function interruptServerAi(): void {
  activeController?.abort();
}

async function send(request: AiApiRequest): Promise<AiApiResult> {
  if (activeController) throw failure("BUSY", request.kind);
  const controller = new AbortController();
  activeController = controller;
  const timer = setTimeout(() => controller.abort("timeout"), CLIENT_TIMEOUT_MS);
  try {
    const response = await fetch("/api/ai", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw responseFailure(payload, response.status, request.kind);
    const parsed = successEnvelopeSchema.safeParse(payload);
    if (!parsed.success) throw failure("INVALID_OUTPUT", request.kind);
    return parsed.data.data;
  } catch (error) {
    if (isFailure(error)) throw error;
    if (controller.signal.aborted) {
      throw failure(controller.signal.reason === "timeout" ? "TIMEOUT" : "CANCELLED", request.kind);
    }
    throw failure("PROVIDER_UNAVAILABLE", request.kind);
  } finally {
    clearTimeout(timer);
    if (activeController === controller) activeController = undefined;
  }
}

function responseFailure(
  payload: unknown,
  status: number,
  operation: AiApiRequest["kind"],
): ServerAiFailure {
  const parsed = errorEnvelopeSchema.safeParse(payload);
  const serverCode = parsed.success ? parsed.data.error.code : "";
  const mapped: ServerAiErrorCode = serverCode === "OPERATION_CAPACITY"
    ? "OPERATION_CAPACITY"
    : serverCode === "AI_RATE_LIMITED"
      ? "RATE_LIMITED"
      : serverCode === "AI_NOT_CONFIGURED"
        ? "CONFIGURATION"
        : serverCode === "AI_TIMEOUT"
          ? "TIMEOUT"
          : serverCode === "INVALID_PROVIDER_OUTPUT" || serverCode === "RESULT_TOO_LARGE"
            ? "INVALID_OUTPUT"
            : serverCode === "INVALID_AI_REQUEST" || serverCode === "CONTENT_TYPE_REQUIRED" || serverCode === "REQUEST_BODY_TOO_LARGE"
              ? "INVALID_REQUEST"
              : serverCode === "AI_PROVIDER_REJECTED"
                ? "PROVIDER_REJECTED"
                : serverCode === "AI_PROVIDER_UNAVAILABLE"
                  ? "PROVIDER_UNAVAILABLE"
                  : status === 429
                    ? "RATE_LIMITED"
                    : status === 400 || status === 413 || status === 415
                      ? "INVALID_REQUEST"
                      : status === 504
                        ? "TIMEOUT"
                        : "PROVIDER_UNAVAILABLE";
  return failure(mapped, operation, {
    requestId: parsed.success ? parsed.data.requestId : undefined,
    serverCode: serverCode || undefined,
  });
}

function failure(
  code: ServerAiErrorCode,
  operation?: AiApiRequest["kind"],
  diagnostic: Pick<ServerAiFailure, "requestId" | "serverCode"> = {},
): ServerAiFailure {
  return { code, message: MESSAGES[code], operation, occurredAt: new Date().toISOString(), ...diagnostic };
}

function isFailure(value: unknown): value is ServerAiFailure {
  return typeof value === "object"
    && value !== null
    && "code" in value
    && "message" in value
    && typeof value.code === "string"
    && typeof value.message === "string";
}
