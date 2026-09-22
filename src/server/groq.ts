import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AiApiRequest, AiApiResult } from "@/lib/ai/api";
import { buildExtractMessages, EXTRACT_RESPONSE_SCHEMA, parseExtractResponse } from "@/lib/ai/extract-prompt";
import { buildPolishMessages, parsePolishResponse, POLISH_RESPONSE_SCHEMA } from "@/lib/ai/polish-prompt";
import { BRIEF_RESPONSE_SCHEMA, buildMessages, CLAIM_RESPONSE_SCHEMA, parseModelResponse } from "@/lib/ai/prompt";
import { workerEnv } from "@/server/cf-env";
import { ApiError } from "@/server/http";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "openai/gpt-oss-20b";
const REQUEST_TIMEOUT_MS = 30_000;

type Message = { role: "system" | "user"; content: string };
type JsonSchema = Record<string, unknown>;

export interface GroqRequestContext {
  requestId: string;
}

interface ProviderErrorMetadata {
  providerCode?: string;
  providerType?: string;
  providerRequestId?: string;
  providerReason?: "unsupported_parameter" | "unsupported_response_format" | "invalid_request" | "model_restriction" | "payload_constraint" | "provider_rejected";
}

const claimContentSchema = z.object({
  claims: z.array(z.object({
    text: z.string(),
    sources: z.array(z.string()),
    confidence: z.enum(["high", "medium", "low"]),
  }).strict()),
}).strict();
/**
 * Same fields the provider schema requires. `confidence` and `role` are read
 * as strings and normalised when parsed, so a label the model invents degrades
 * that one claim's presentation instead of failing the whole response.
 */
const briefContentSchema = z.object({
  claims: z.array(z.object({
    text: z.string(),
    sources: z.array(z.string()),
    confidence: z.string(),
    section: z.string(),
    role: z.string(),
  }).strict()),
}).strict();
const polishContentSchema = z.object({
  changed: z.boolean(),
  revisedText: z.string(),
  reasons: z.array(z.string()),
}).strict();
const extractContentSchema = z.object({
  field: z.string(),
  value: z.string().nullable(),
  sources: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
}).strict();

export async function runGroqAi(
  request: AiApiRequest,
  context: GroqRequestContext = { requestId: randomUUID() },
): Promise<AiApiResult> {
  const started = Date.now();
  const specification = requestSpecification(request);
  const raw = await complete(specification.messages, specification.schema, specification.schemaName, specification.maxTokens, {
    requestId: context.requestId,
    operation: request.kind === "claims" ? request.request.operation : request.kind,
  });
  const result = parseResult(request, raw.choices[0].message.content);
  console.info("[AI][Groq]", {
    kind: request.kind,
    model: GROQ_MODEL,
    durationMs: Date.now() - started,
    promptTokens: raw.usage?.prompt_tokens,
    completionTokens: raw.usage?.completion_tokens,
    totalTokens: raw.usage?.total_tokens,
  });
  return result;
}

function requestSpecification(request: AiApiRequest): {
  messages: Message[];
  schema: JsonSchema;
  schemaName: string;
  maxTokens: number;
} {
  switch (request.kind) {
    case "claims":
      // Brief writes the longest object of any operation — five claims with a
      // section each — and this model spends completion tokens on reasoning
      // before it emits any of it. A budget that fits Ask truncates Brief mid
      // object, which the provider reports as a schema validation failure.
      return request.request.operation === "brief"
        ? { messages: buildMessages(request.request, request.items), schema: BRIEF_RESPONSE_SCHEMA, schemaName: "worklens_brief", maxTokens: 3_000 }
        : { messages: buildMessages(request.request, request.items), schema: CLAIM_RESPONSE_SCHEMA, schemaName: "worklens_claims", maxTokens: 1_200 };
    case "polish":
      return { messages: buildPolishMessages(request.text, request.mode), schema: POLISH_RESPONSE_SCHEMA, schemaName: "worklens_polish", maxTokens: 900 };
    case "extract":
      return { messages: buildExtractMessages(request.field, request.items), schema: EXTRACT_RESPONSE_SCHEMA, schemaName: "worklens_extract", maxTokens: 500 };
  }
}

function parseResult(request: AiApiRequest, content: string): AiApiResult {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    throw new ApiError("INVALID_PROVIDER_OUTPUT", "AI 응답 형식이 올바르지 않습니다.", 502);
  }
  switch (request.kind) {
    case "claims": {
      const validated = (request.request.operation === "brief" ? briefContentSchema : claimContentSchema).safeParse(payload);
      if (!validated.success) throw new ApiError("INVALID_PROVIDER_OUTPUT", "AI 응답 형식이 올바르지 않습니다.", 502);
      const parsed = parseModelResponse(JSON.stringify(validated.data));
      if (!parsed.envelope) throw new ApiError("INVALID_PROVIDER_OUTPUT", "AI 응답 형식이 올바르지 않습니다.", 502);
      return { kind: "claims", claims: parsed.claims };
    }
    case "polish": {
      const validated = polishContentSchema.safeParse(payload);
      if (!validated.success) throw new ApiError("INVALID_PROVIDER_OUTPUT", "AI 응답 형식이 올바르지 않습니다.", 502);
      return { kind: "polish", proposal: parsePolishResponse(JSON.stringify(validated.data), request.text) };
    }
    case "extract": {
      const validated = extractContentSchema.safeParse(payload);
      if (!validated.success) throw new ApiError("INVALID_PROVIDER_OUTPUT", "AI 응답 형식이 올바르지 않습니다.", 502);
      return { kind: "extract", proposal: parseExtractResponse(JSON.stringify(validated.data), request.field, request.items) };
    }
  }
}

async function complete(
  messages: Message[],
  schema: JsonSchema,
  schemaName: string,
  maxTokens: number,
  context: GroqRequestContext & { operation: string },
): Promise<GroqCompletion> {
  const apiKey = workerEnv().GROQ_API_KEY;
  if (!apiKey) throw new ApiError("AI_NOT_CONFIGURED", "AI 서비스가 구성되지 않았습니다.", 503);
  const body = JSON.stringify({
    model: GROQ_MODEL,
    messages,
    temperature: 0,
    max_completion_tokens: maxTokens,
    response_format: {
      type: "json_schema",
      json_schema: { name: schemaName, strict: true, schema },
    },
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(GROQ_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (response.ok) return parseCompletion(await response.json());
      const retryable = response.status === 429 || response.status >= 500;
      if (attempt === 0 && retryable) {
        const retryAfter = retryDelay(response.headers.get("retry-after"));
        if (retryAfter <= 1_500) {
          await delay(retryAfter);
          continue;
        }
      }
      throw await providerError(response, context);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ApiError("AI_TIMEOUT", "AI 응답 시간이 초과되었습니다. 다시 시도하세요.", 504);
      }
      if (attempt === 0) {
        await delay(250);
        continue;
      }
      throw new ApiError("AI_PROVIDER_UNAVAILABLE", "AI 서비스에 연결할 수 없습니다. 잠시 후 다시 시도하세요.", 503);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ApiError("AI_PROVIDER_UNAVAILABLE", "AI 서비스에 연결할 수 없습니다. 잠시 후 다시 시도하세요.", 503);
}

const groqCompletionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string() }),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().finite().optional(),
    completion_tokens: z.number().finite().optional(),
    total_tokens: z.number().finite().optional(),
  }).optional(),
});

type GroqCompletion = z.infer<typeof groqCompletionSchema>;

function parseCompletion(value: unknown): GroqCompletion {
  const parsed = groqCompletionSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError("INVALID_PROVIDER_OUTPUT", "AI 응답 형식이 올바르지 않습니다.", 502);
  }
  return parsed.data;
}

const groqErrorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    type: z.string().optional(),
    code: z.union([z.string(), z.number()]).optional(),
  }).passthrough(),
}).passthrough();

async function providerError(
  response: Response,
  context: GroqRequestContext & { operation: string },
): Promise<ApiError> {
  const metadata = await providerErrorMetadata(response);
  console.error("[AI][Groq] provider rejected request", {
    status: response.status,
    providerCode: metadata.providerCode,
    providerType: metadata.providerType,
    providerRequestId: metadata.providerRequestId,
    providerReason: metadata.providerReason,
    requestId: context.requestId,
    operation: context.operation,
    timestamp: new Date().toISOString(),
  });
  if (response.status === 429) return new ApiError("AI_RATE_LIMITED", "AI 사용 한도에 도달했습니다. 잠시 후 다시 시도하세요.", 429);
  if (response.status === 401 || response.status === 403) return new ApiError("AI_NOT_CONFIGURED", "AI 서비스 인증 구성이 올바르지 않습니다.", 503);
  if (response.status >= 500) return new ApiError("AI_PROVIDER_UNAVAILABLE", "AI 서비스가 일시적으로 응답하지 않습니다.", 503);
  return new ApiError("AI_PROVIDER_REJECTED", "AI 서비스가 요청을 처리하지 못했습니다.", 502);
}

async function providerErrorMetadata(response: Response): Promise<ProviderErrorMetadata> {
  const providerRequestId = response.headers.get("x-request-id")
    ?? response.headers.get("x-groq-request-id")
    ?? response.headers.get("request-id")
    ?? undefined;
  try {
    const parsed = groqErrorSchema.safeParse(JSON.parse(await response.text()));
    if (!parsed.success) return { providerRequestId };
    const providerCode = parsed.data.error.code === undefined ? undefined : String(parsed.data.error.code).slice(0, 120);
    const providerType = parsed.data.error.type?.slice(0, 120);
    return {
      providerCode,
      providerType,
      providerRequestId,
      providerReason: classifyProviderReason(parsed.data.error.message, providerCode, providerType),
    };
  } catch {
    return { providerRequestId };
  }
}

function classifyProviderReason(
  message?: string,
  code?: string,
  type?: string,
): ProviderErrorMetadata["providerReason"] {
  const diagnostic = `${code ?? ""} ${type ?? ""} ${message ?? ""}`.toLocaleLowerCase("en-US");
  if (/(response[_ -]?format|json[_ -]?schema|structured output)/u.test(diagnostic)) return "unsupported_response_format";
  if (/(unsupported|unknown|unrecognized).{0,40}(parameter|argument|field)/u.test(diagnostic)) return "unsupported_parameter";
  if (/(model).{0,60}(not supported|not allowed|restricted|permission|access)/u.test(diagnostic)) return "model_restriction";
  if (/(payload|request body|too large|maximum context|context length|token limit)/u.test(diagnostic)) return "payload_constraint";
  if (/(invalid_request|invalid request|bad request|validation)/u.test(diagnostic)) return "invalid_request";
  return "provider_rejected";
}

function retryDelay(value: string | null): number {
  if (!value) return 250;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1_000) : 2_000;
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}
