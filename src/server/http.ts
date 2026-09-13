import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { SessionError } from "@/server/session";
import { WorkspaceError } from "@/server/workspace-store";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

/** Control-plane JSON bodies are tiny; anything larger is rejected before allocation. */
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

/**
 * Reads a request body with a hard byte ceiling, checking the declared
 * Content-Length first and then enforcing the same cap while streaming so a
 * chunked body cannot force unbounded allocation before validation runs.
 */
export async function readBoundedJson(request: Request, maxBytes = MAX_REQUEST_BODY_BYTES): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WorkspaceError("REQUEST_BODY_TOO_LARGE", "요청 본문이 너무 큽니다.", 413);
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
      throw new WorkspaceError("REQUEST_BODY_TOO_LARGE", "요청 본문이 너무 큽니다.", 413);
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
 * Derived operations amplify: a bounded document can yield a finding per cell.
 * Results are capped before serialization so a response cannot exhaust the heap.
 */
const MAX_RESULT_BYTES = 24 * 1024 * 1024;
const MAX_CONCURRENT_OPERATIONS = 4;
let activeOperations = 0;

export async function runBoundedOperation<T>(
  operation: () => Promise<T> | T,
  validateResult = true,
): Promise<T> {
  if (activeOperations >= MAX_CONCURRENT_OPERATIONS) {
    throw new WorkspaceError("OPERATION_CAPACITY", "동시 작업 한도에 도달했습니다. 잠시 후 다시 시도하세요.", 429);
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

export function assertBinaryResultWithinLimit(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes > MAX_RESULT_BYTES) {
    throw new WorkspaceError("RESULT_TOO_LARGE", "내보내기 결과가 너무 큽니다. 파일 수를 줄여 다시 시도하세요.", 413);
  }
}

export function assertResultWithinLimit(result: unknown): void {
  const size = Buffer.byteLength(JSON.stringify(result) ?? "");
  if (size > MAX_RESULT_BYTES) {
    throw new WorkspaceError(
      "RESULT_TOO_LARGE",
      "결과가 너무 커서 반환할 수 없습니다. 파일 수를 줄여 다시 시도하세요.",
      413,
    );
  }
}

export function ok<T>(data: T, status = 200): NextResponse {
  assertResultWithinLimit(data);
  return NextResponse.json({ data, requestId: randomUUID() }, { status, headers: NO_STORE_HEADERS });
}

export function apiError(error: unknown): NextResponse {
  if (error instanceof SessionError || error instanceof WorkspaceError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, retryable: error.status >= 500 }, requestId: randomUUID() },
      { status: error.status, headers: NO_STORE_HEADERS },
    );
  }
  const message = error instanceof Error && error.message ? error.message : "요청을 처리할 수 없습니다.";
  const safeMessage = /지원|파일|PDF|Excel|XLSX|세션|크기|형식|문서/.test(message)
    ? message
    : "요청 처리 중 오류가 발생했습니다.";
  return NextResponse.json(
    { error: { code: "INTERNAL_ERROR", message: safeMessage, retryable: true }, requestId: randomUUID() },
    { status: 500, headers: NO_STORE_HEADERS },
  );
}
