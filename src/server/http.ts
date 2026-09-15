import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

/** The only remaining server endpoint is the optional Local AI layer. */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Local AI requests carry the documents the browser already parsed, so the
 * ceiling is sized for evidence rather than a control-plane command.
 */
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Reads a request body with a hard byte ceiling, checking the declared
 * Content-Length first and then enforcing the same cap while streaming so a
 * chunked body cannot force unbounded allocation before validation runs.
 */
export async function readBoundedJson(request: Request, maxBytes = MAX_REQUEST_BODY_BYTES): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError("REQUEST_BODY_TOO_LARGE", "요청 본문이 너무 큽니다.", 413);
  }
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ApiError("REQUEST_BODY_TOO_LARGE", "요청 본문이 너무 큽니다.", 413);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (size === 0) return null;

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
}

/**
 * A grounded completion amplifies: one claim per evidence node. Results are
 * capped before serialization so a response cannot exhaust the worker heap.
 */
const MAX_RESULT_BYTES = 24 * 1024 * 1024;
const MAX_CONCURRENT_OPERATIONS = 4;
let activeOperations = 0;

export async function runBoundedOperation<T>(
  operation: () => Promise<T> | T,
  validateResult = true,
): Promise<T> {
  if (activeOperations >= MAX_CONCURRENT_OPERATIONS) {
    throw new ApiError("OPERATION_CAPACITY", "동시 작업 한도에 도달했습니다. 잠시 후 다시 시도하세요.", 429);
  }
  activeOperations += 1;
  try {
    const result = await operation();
    if (validateResult) assertResultWithinLimit(result);
    return result;
  } finally {
    activeOperations -= 1;
  }
}

export function assertResultWithinLimit(result: unknown): void {
  const size = new TextEncoder().encode(JSON.stringify(result) ?? "").byteLength;
  if (size > MAX_RESULT_BYTES) {
    throw new ApiError("RESULT_TOO_LARGE", "결과가 너무 커서 반환할 수 없습니다. 파일 수를 줄여 다시 시도하세요.", 413);
  }
}

/**
 * Rejects cross-site callers. The endpoint is stateless, so there is no cookie
 * or session to protect; this only keeps other origins from using the
 * deployment as a free proxy to a user's Local AI provider.
 */
export function requireSameOrigin(request: Request): void {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError("CROSS_SITE_REQUEST", "교차 사이트 요청을 거부했습니다.", 403);
  }
  const origin = request.headers.get("origin");
  if (!origin) throw new ApiError("ORIGIN_REQUIRED", "요청 출처가 필요합니다.", 403);
  let expected: string;
  try {
    const configuredOrigin = process.env.WORKLENS_ORIGIN;
    expected = configuredOrigin ? new URL(configuredOrigin).origin : new URL(request.url).origin;
  } catch {
    throw new ApiError("ORIGIN_INVALID", "요청 출처를 확인할 수 없습니다.", 403);
  }
  if (origin !== expected) throw new ApiError("ORIGIN_MISMATCH", "요청 출처가 일치하지 않습니다.", 403);
}

export function ok<T>(data: T, status = 200): NextResponse {
  assertResultWithinLimit(data);
  return NextResponse.json({ data, requestId: randomUUID() }, { status, headers: NO_STORE_HEADERS });
}

export function apiError(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, retryable: error.status >= 500 }, requestId: randomUUID() },
      { status: error.status, headers: NO_STORE_HEADERS },
    );
  }
  console.error("WorkLens API unhandled error", error);
  return NextResponse.json(
    { error: { code: "INTERNAL_ERROR", message: "요청 처리 중 오류가 발생했습니다.", retryable: true }, requestId: randomUUID() },
    { status: 500, headers: NO_STORE_HEADERS },
  );
}

/**
 * Cookie-authenticated endpoints compare against the request's own origin
 * rather than the configured public origin, so local Worker runs and preview
 * deployments are not rejected while cross-site callers still are.
 */
export function requireSameSite(request: Request): void {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError("CROSS_SITE_REQUEST", "교차 사이트 요청을 거부했습니다.", 403);
  }
  const origin = request.headers.get("origin");
  if (!origin) throw new ApiError("ORIGIN_REQUIRED", "요청 출처가 필요합니다.", 403);
  if (origin !== new URL(request.url).origin) {
    throw new ApiError("ORIGIN_MISMATCH", "요청 출처가 일치하지 않습니다.", 403);
  }
}
