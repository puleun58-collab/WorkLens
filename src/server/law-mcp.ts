import { z } from "zod";
import { workerEnv } from "@/server/cf-env";
import { ApiError } from "@/server/http";

/**
 * Server-only client for the public Korean Law MCP (Streamable HTTP, stateless).
 * Exactly one tool is reachable: `search_law`. The MCP URL and the 법제처 key come
 * from server configuration only; the key travels in the `apikey` header, never in
 * the URL, a log line or a response.
 */
export const LAW_QUERY_MAX_CHARS = 200;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

export interface LawSearchEntry {
  name: string;
  status?: string;
  lawId?: string;
  mst?: string;
  promulgationDate?: string;
  effectiveDate?: string;
  kind?: string;
}

export type LawSearchResult =
  | { found: true; laws: LawSearchEntry[]; text: string }
  /** The MCP explicitly reported no data; never an outage and never invented content. */
  | { found: false; marker: "NOT_FOUND"; text: string };

const rpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  result: z.object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
    isError: z.boolean().optional(),
  }).passthrough().optional(),
  error: z.object({ code: z.number().optional(), message: z.string().optional() }).passthrough().optional(),
}).passthrough();

export async function searchLaw(query: string, context: { requestId: string; signal?: AbortSignal }): Promise<LawSearchResult> {
  const { LAW_OC: key, LAW_MCP_URL: endpoint } = workerEnv();
  if (!key || !endpoint) throw new ApiError("LAW_NOT_CONFIGURED", "법령 검색 서비스가 구성되지 않았습니다.", 503);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ApiError("LAW_NOT_CONFIGURED", "법령 검색 서비스가 구성되지 않았습니다.", 503);
  }
  if (url.protocol !== "https:") throw new ApiError("LAW_NOT_CONFIGURED", "법령 검색 서비스가 구성되지 않았습니다.", 503);

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), REQUEST_TIMEOUT_MS);
  const onClientAbort = () => controller.abort(new DOMException("client aborted", "AbortError"));
  context.signal?.addEventListener("abort", onClientAbort, { once: true });
  let upstreamStatus: number | undefined;
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", apikey: key },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_law", arguments: { query } } }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof DOMException && controller.signal.reason.name === "TimeoutError") {
        throw new ApiError("LAW_UPSTREAM_TIMEOUT", "법령 검색 응답 시간이 초과되었습니다. 다시 시도하세요.", 504);
      }
      if (context.signal?.aborted) throw new ApiError("LAW_REQUEST_ABORTED", "요청이 취소되었습니다.", 499);
      void error;
      throw new ApiError("LAW_UPSTREAM_UNAVAILABLE", "법령 검색 서비스에 연결할 수 없습니다.", 503);
    }
    upstreamStatus = response.status;
    if (response.status === 401 || response.status === 403) throw new ApiError("LAW_AUTH_FAILED", "법령 검색 인증에 실패했습니다.", 502);
    if (response.status === 429) throw new ApiError("LAW_RATE_LIMITED", "법령 검색 요청이 많습니다. 잠시 후 다시 시도하세요.", 429);
    if (!response.ok) throw new ApiError("LAW_UPSTREAM_UNAVAILABLE", "법령 검색 서비스가 일시적으로 응답하지 않습니다.", 503);

    const body = await readLimited(response);
    const parsed = rpcResponseSchema.safeParse(parseEnvelope(body, response.headers.get("content-type") ?? ""));
    if (!parsed.success) throw new ApiError("LAW_MCP_ERROR", "법령 검색 응답 형식이 올바르지 않습니다.", 502);
    if (parsed.data.error || !parsed.data.result) throw new ApiError("LAW_MCP_ERROR", "법령 검색 서비스가 요청을 처리하지 못했습니다.", 502);
    const text = redact(parsed.data.result.content.map((part) => part.type === "text" ? part.text ?? "" : "").join("\n").trim(), key);
    if (/^\s*\[NOT_FOUND\]/u.test(text)) return { found: false, marker: "NOT_FOUND", text };
    if (parsed.data.result.isError || !text) throw new ApiError("LAW_MCP_ERROR", "법령 검색 서비스가 요청을 처리하지 못했습니다.", 502);
    return { found: true, laws: parseLawEntries(text), text };
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", onClientAbort);
    // Operational metadata only: no key, headers, query text or response body.
    console.info("[LAW][MCP]", { requestId: context.requestId, operation: "search_law", upstreamStatus, latencyMs: Date.now() - started });
  }
}

async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new ApiError("LAW_MCP_ERROR", "법령 검색 응답이 너무 큽니다.", 502);
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ApiError("LAW_MCP_ERROR", "법령 검색 응답이 너무 큽니다.", 502);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Streamable HTTP may answer with JSON or a single SSE `message` event. */
function parseEnvelope(body: string, contentType: string): unknown {
  try {
    if (contentType.includes("text/event-stream")) {
      const data = body.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
      return data.length ? JSON.parse(data[data.length - 1]) : undefined;
    }
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function redact(text: string, key: string): string {
  return key.length >= 4 ? text.split(key).join("[REDACTED]") : text;
}

/** Reads the MCP's numbered list; the original text is still returned so nothing is lost. */
export function parseLawEntries(text: string): LawSearchEntry[] {
  const entries: LawSearchEntry[] = [];
  let current: LawSearchEntry | undefined;
  for (const line of text.split(/\r?\n/u)) {
    const head = /^\s*\d+\.\s+(.+?)(?:\s+\[([^\]]+)\])?\s*$/u.exec(line);
    if (head) {
      current = { name: head[1].trim(), ...(head[2] ? { status: head[2].trim() } : {}) };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const field = /^\s*-\s*([^:]+):\s*(.+)$/u.exec(line);
    if (!field) {
      if (!line.trim()) current = undefined;
      continue;
    }
    const [label, value] = [field[1].trim(), field[2].trim()];
    if (label === "법령ID") current.lawId = value;
    else if (label === "MST") current.mst = value;
    else if (label === "구분") current.kind = value;
    else if (label.startsWith("공포일")) {
      const dates = /공포일:\s*(\S+)(?:\s*\/\s*시행일:\s*(\S+))?/u.exec(line);
      if (dates) {
        current.promulgationDate = dates[1];
        if (dates[2]) current.effectiveDate = dates[2];
      }
    } else if (label === "시행일") current.effectiveDate = value;
  }
  return entries;
}
