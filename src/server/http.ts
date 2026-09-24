import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

/** Shared helpers for the remaining control-plane endpoints (admin, 용어 사전). */
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
 * Every remaining endpoint is a small control-plane command, so the default
 * ceiling stays tiny; callers that need less pass their own limit.
 */
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

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
 * Results are capped before serialization so a response cannot exhaust the
 * worker heap.
 */
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
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

export function ok<T>(data: T, status = 200, requestId = randomUUID()): NextResponse {
  assertResultWithinLimit(data);
  return NextResponse.json({ data, requestId }, { status, headers: NO_STORE_HEADERS });
}

export function apiError(error: unknown, requestId = randomUUID()): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, retryable: error.status >= 500 }, requestId },
      { status: error.status, headers: NO_STORE_HEADERS },
    );
  }
  console.error("WorkLens API unhandled error", { requestId, error });
  return NextResponse.json(
    { error: { code: "INTERNAL_ERROR", message: "요청 처리 중 오류가 발생했습니다.", retryable: true }, requestId },
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
  const expected = new URL(request.url).origin;
  if (origin !== expected && !isLocalLoopbackAlias(origin, expected)) {
    throw new ApiError("ORIGIN_MISMATCH", "요청 출처가 일치하지 않습니다.", 403);
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * `next dev` reports its request URL as `localhost` even when the browser opened
 * `127.0.0.1`. Only in development, treat those two exact hosts as one origin —
 * same protocol and same port required; any other host, port or environment keeps
 * the strict comparison above.
 */
function isLocalLoopbackAlias(origin: string, expected: string): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  let actual: URL;
  try {
    actual = new URL(origin);
  } catch {
    return false;
  }
  const own = new URL(expected);
  return actual.origin === origin && actual.protocol === own.protocol && actual.port === own.port
    && LOOPBACK_HOSTS.has(actual.hostname) && LOOPBACK_HOSTS.has(own.hostname);
}
