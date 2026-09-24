import { z } from "zod";
import { workerEnv } from "@/server/cf-env";
import { ApiError } from "@/server/http";

/**
 * Server-only client for the public Korean Law MCP (Streamable HTTP, stateless).
 * The fixed tools are selected by server entry points. The MCP URL and
 * 법제처 key come from server configuration; the key travels in the `apikey`
 * header, never in the URL, a log line or a response.
 */
export const LAW_QUERY_MAX_CHARS = 200;
const REQUEST_TIMEOUT_MS = 20_000;
/** `legal_analysis` fans out to many 법제처 requests (citations, citing precedents, five impact axes). */
const ANALYSIS_TIMEOUT_MS = 45_000;
/** MCP chains stop after 45s plus assembly/transfer; document_review has no chain deadline, but remains bounded. */
const RESEARCH_TIMEOUT_MS = 60_000;
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

export interface LawTextArticle {
  jo: string;
  title: string;
}

export type LawTextResult =
  | {
    found: true;
    mode: "toc" | "article" | "full";
    text: string;
    name?: string;
    promulgationDate?: string;
    effectiveDate?: string;
    articles?: LawTextArticle[];
  }
  | { found: false; marker: "NOT_FOUND"; text: string };

type LawContext = { requestId: string; signal?: AbortSignal };

const rpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  result: z.object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
    isError: z.boolean().optional(),
  }).passthrough().optional(),
  error: z.object({ code: z.number().optional(), message: z.string().optional() }).passthrough().optional(),
}).passthrough();

export async function searchLaw(query: string, context: LawContext): Promise<LawSearchResult> {
  const { text, isError } = await callLawTool("search_law", { query }, context);
  const trimmed = text.trim();
  if (/^\s*\[NOT_FOUND\]/u.test(trimmed)) return { found: false, marker: "NOT_FOUND", text: trimmed };
  if (isError || !trimmed) throw new ApiError("LAW_MCP_ERROR", "법령 검색 서비스가 요청을 처리하지 못했습니다.", 502);
  return { found: true, laws: parseLawEntries(trimmed), text: trimmed };
}

export async function getLawText(
  identifier: { mst: string } | { lawId: string },
  jo: string | undefined,
  context: LawContext,
): Promise<LawTextResult> {
  const { text, isError } = await callLawTool("get_law_text", jo === undefined ? identifier : { ...identifier, jo }, context);
  if (/^[ \t]*\[NOT_FOUND\](?=\s|$)/mu.test(text)) return { found: false, marker: "NOT_FOUND", text };
  if (isError || !text.trim()) throw new ApiError("LAW_MCP_ERROR", "법령 검색 서비스가 요청을 처리하지 못했습니다.", 502);

  const metadata: Pick<Extract<LawTextResult, { found: true }>, "name" | "promulgationDate" | "effectiveDate"> = {};
  const lines = text.split(/\r?\n/u);
  for (const line of lines) {
    if (!line.trim()) break;
    const field = /^(법령명|공포일|시행일):\s*(.+?)\s*$/u.exec(line);
    if (!field) continue;
    if (field[1] === "법령명") metadata.name = field[2];
    else if (field[1] === "공포일" && /^\d{8}$/u.test(field[2])) metadata.promulgationDate = field[2];
    else if (field[1] === "시행일" && /^\d{8}$/u.test(field[2])) metadata.effectiveDate = field[2];
  }

  if (jo !== undefined) return { found: true, mode: "article", text, ...metadata };
  const tocIndex = lines.findIndex((line) => /^\s*목차\s*\(총\s*[\d,]+\s*개\s*조문\)\s*$/u.test(line));
  if (tocIndex < 0) return { found: true, mode: "full", text, ...metadata };

  const articles: LawTextArticle[] = [];
  for (let index = tocIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    const article = /^\s*(제[1-9]\d{0,3}조(?:의[1-9]\d?)?)(?:\s+(.+?))?\s*$/u.exec(line);
    if (!article) break;
    articles.push({ jo: article[1], title: article[2] ?? "" });
  }
  return { found: true, mode: "toc", text, ...metadata, articles };
}

/** Tool names and arguments are fixed by server entry points, never supplied by the caller. */
export async function callLawTool(
  tool: "search_law" | "get_law_text" | "search_decisions" | "get_decision_text" | "legal_analysis" | "legal_research",
  args: { query: string } | { mst: string; jo?: string } | { lawId: string; jo?: string } |
    { domain: string; query: string; display: 20; page: number } | { domain: string; id: string; full?: true } |
    { mode: "verify_citations"; text: string; maxCitations: 15 } |
    { mode: "cite_check"; caseNumber: string; display: 20; deepScan: true } |
    { mode: "applicable_law"; lawName: string; date: string; jo?: string } |
    { mode: "impact_map"; lawName: string; jo: string; includeOrdinances: true; includeMermaid: false } |
    { task: "full_research" | "action_basis" | "procedure_detail"; query: string } |
    { task: "law_system"; query: string; articles?: string[] } |
    { task: "dispute_prep"; query: string; domain?: "tax" | "labor" | "privacy" | "competition" | "general" } |
    { task: "amendment_track"; query: string; scenario?: "timeline" | "time_travel"; mst?: string; lawId?: string;
      fromDate?: string; toDate?: string; includeHistory: boolean } |
    { task: "ordinance_compare"; query: string; parentLaw?: string } |
    { task: "document_review"; text: string; maxClauses: number },
  context: LawContext,
): Promise<{ text: string; isError: boolean }> {
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
  const timeoutMs = tool === "legal_analysis" ? ANALYSIS_TIMEOUT_MS : tool === "legal_research" ? RESEARCH_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), timeoutMs);
  const onClientAbort = () => controller.abort(new DOMException("client aborted", "AbortError"));
  context.signal?.addEventListener("abort", onClientAbort, { once: true });
  if (context.signal?.aborted) onClientAbort();
  let upstreamStatus: number | undefined;
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", apikey: key },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
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

    let body: string;
    try {
      body = await readLimited(response);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (controller.signal.reason instanceof DOMException && controller.signal.reason.name === "TimeoutError") {
        throw new ApiError("LAW_UPSTREAM_TIMEOUT", "법령 검색 응답 시간이 초과되었습니다. 다시 시도하세요.", 504);
      }
      if (context.signal?.aborted) throw new ApiError("LAW_REQUEST_ABORTED", "요청이 취소되었습니다.", 499);
      throw new ApiError("LAW_UPSTREAM_UNAVAILABLE", "법령 검색 서비스에 연결할 수 없습니다.", 503);
    }
    const parsed = rpcResponseSchema.safeParse(parseEnvelope(body, response.headers.get("content-type") ?? ""));
    if (!parsed.success) throw new ApiError("LAW_MCP_ERROR", "법령 검색 응답 형식이 올바르지 않습니다.", 502);
    if (parsed.data.error || !parsed.data.result) throw new ApiError("LAW_MCP_ERROR", "법령 검색 서비스가 요청을 처리하지 못했습니다.", 502);
    const text = redact(parsed.data.result.content.map((part) => part.type === "text" ? part.text ?? "" : "").join("\n"), key);
    return { text, isError: parsed.data.result.isError === true };
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", onClientAbort);
    // Operational metadata only: no key, headers, query text or response body.
    console.info("[LAW][MCP]", { requestId: context.requestId, operation: tool, ...("mode" in args ? { mode: args.mode } : {}), ...("task" in args ? { task: args.task } : {}), upstreamStatus, latencyMs: Date.now() - started });
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
  return key && text.includes(key) ? text.split(key).join("[REDACTED]") : text;
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
