import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";
import type { AiUnavailableReason } from "@/domain/ai";
import { AI_SCHEMA_ID, type AiProviderClaim, type AiProviderCompletion, type AiProviderDirectClaim, type AiProviderHealth, type AiProviderRequest, type AiProviderResponse, type LocalAiProvider } from "@/server/ai/provider";

const CONNECT_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 8_000;
const CONTEXT_WINDOW_TOKENS = 32_768;
const sessionGates = new Map<string, SessionGate>();

export interface LocalAiProviderOptions { url?: string; fetch?: typeof globalThis.fetch; }

export function createLocalAiProvider(options: LocalAiProviderOptions = {}): LocalAiProvider {
  // `options.url` is test-only dependency injection; production calls this with deployment config only.
  const baseUrl = parseInternalUrl(options.url ?? process.env.WORKLENS_AI_URL);
  const fetcher = options.fetch ?? globalThis.fetch;
  const dispatcher = privateNetworkDispatcher();

  const health = async (signal?: AbortSignal): Promise<AiProviderHealth> => {
    if (signal?.aborted) return { available: false, reason: "cancelled" };
    if (!baseUrl || !hasServiceIdentity()) return { available: false, reason: "not-configured" };
    if (!await resolvesOnlyPrivateAddresses(baseUrl.hostname)) return { available: false, reason: "unhealthy" };
    return { available: true, capabilities: { available: true, operations: ["analyze", "ask", "brief", "semantic-check"], contextWindowTokens: CONTEXT_WINDOW_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS } };
  };

  const complete = async (request: AiProviderRequest, signal?: AbortSignal): Promise<AiProviderResponse> => {
    if (!baseUrl || !hasServiceIdentity()) return { status: "unavailable", reason: "not-configured" };
    if (!isValidRequest(request)) return { status: "unavailable", reason: "unhealthy" };
    try {
      const release = await acquireSessionSlot(request.sessionKey, signal);
      try {
        if (!await resolvesOnlyPrivateAddresses(baseUrl.hostname)) return { status: "unavailable", reason: "unhealthy" };
        const body = JSON.stringify(toWireRequest(request));
        if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) return { status: "unavailable", reason: "unhealthy" };
        const response = await postWithPermittedRetry(fetcher, baseUrl, body, request.requestId, dispatcher, signal);
        if (!response.ok) return { status: "unavailable", reason: "unhealthy" };
        return { status: "ok", completion: parseCompletion(await readJsonLimited(response)) };
      } finally { release(); }
    } catch (error) {
      return { status: "unavailable", reason: unavailableReason(error) };
    }
  };
  return { health, complete };
}

function toWireRequest(request: AiProviderRequest): object {
  return {
    requestId: request.requestId,
    task: request.task,
    schemaId: AI_SCHEMA_ID,
    locale: "ko-KR",
    sourceTokens: request.sourceTokens,
    context: request.context,
    maxOutputTokens: request.maxOutputTokens,
  };
}

async function postWithPermittedRetry(fetcher: typeof globalThis.fetch, url: URL, body: string, requestId: string, dispatcher: Agent, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchWithDeadline(fetcher, url, signal, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": requestId,
        "X-WorkLens-Service-Identity": process.env.WORKLENS_AI_SERVICE_IDENTITY!,
      },
      body,
      dispatcher,
    });
    // No body has been read at this point. Only these pre-body status responses retry once.
    if (attempt === 0 && (response.status === 429 || response.status === 502 || response.status === 503)) {
      await response.body?.cancel();
      await sleep(750 + Math.floor(Math.random() * 501), signal);
      continue;
    }
    return response;
  }
}

function parseCompletion(payload: unknown): AiProviderCompletion {
  if (!isRecord(payload) || payload.schemaId !== AI_SCHEMA_ID || Object.keys(payload).some((key) => !["schemaId", "claims", "data", "usage", "finishReason"].includes(key))) throw new Error("AI_RESPONSE_INVALID");
  const rawClaims = Array.isArray(payload.claims)
    ? payload.claims
    : isRecord(payload.data) && Array.isArray(payload.data.claims) && Object.keys(payload.data).length === 1
      ? payload.data.claims
      : undefined;
  if (!rawClaims || (payload.claims !== undefined && payload.data !== undefined)) throw new Error("AI_RESPONSE_INVALID");
  const claims = rawClaims.map(parseClaim);
  if (claims.some((claim) => !claim)) throw new Error("AI_RESPONSE_INVALID");
  return { schemaId: AI_SCHEMA_ID, claims: claims as AiProviderClaim[] };
}

function parseClaim(value: unknown): AiProviderClaim | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "direct") {
    const allowed = new Set(["type", "propositionToken", "subject", "predicate", "object", "polarity", "qualifiers"]);
    if (Object.keys(value).some((key) => !allowed.has(key)) || typeof value.propositionToken !== "string" || typeof value.subject !== "string" || !isPredicate(value.predicate) || !isDirectObject(value.object) || (value.polarity !== "affirmed" && value.polarity !== "negated") || !isQualifiers(value.qualifiers)) return undefined;
    return { type: "direct", propositionToken: value.propositionToken, subject: value.subject, predicate: value.predicate, object: value.object, polarity: value.polarity, ...(value.qualifiers === undefined ? {} : { qualifiers: value.qualifiers }) };
  }
  if (value.type === "inference" && Object.keys(value).length === 3 && typeof value.text === "string" && Array.isArray(value.sourceTokens) && value.sourceTokens.every((token) => typeof token === "string")) return { type: "inference", text: value.text, sourceTokens: value.sourceTokens };
  return undefined;
}

function isValidRequest(value: AiProviderRequest): boolean {
  return value.schemaId === AI_SCHEMA_ID && typeof value.requestId === "string" && value.requestId.length > 0 && typeof value.sessionKey === "string" && value.sessionKey.length > 0 && ["analyze", "ask", "brief", "semantic-check"].includes(value.task) && value.locale === "ko-KR" && Array.isArray(value.sourceTokens) && value.sourceTokens.every((token) => typeof token === "string") && Array.isArray(value.context) && value.maxOutputTokens > 0 && value.maxOutputTokens <= MAX_OUTPUT_TOKENS;
}

function parseInternalUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return undefined;
    return isApprovedInternalHost(url.hostname) ? url : undefined;
  } catch { return undefined; }
}
function endpoint(base: URL): URL { return new URL("/worklens/v1/generate", base); }
function hasServiceIdentity(): boolean {
  return Boolean(process.env.WORKLENS_AI_SERVICE_IDENTITY?.trim() && process.env.WORKLENS_AI_MTLS_CERT_PEM?.trim() && process.env.WORKLENS_AI_MTLS_KEY_PEM?.trim());
}
function isApprovedInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const allowlist = (process.env.WORKLENS_AI_HOSTS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return allowlist.includes(host) || host.endsWith(".internal") || host.endsWith(".corp") || host.endsWith(".local") || isPrivateAddress(host);
}
async function resolvesOnlyPrivateAddresses(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPrivateAddress(host);
  try { const addresses = await lookup(host, { all: true, verbatim: true }); return addresses.length > 0 && addresses.every(({ address }) => isPrivateAddress(address)); } catch { return false; }
}

const dispatcherState = globalThis as typeof globalThis & { __worklensAiDispatcher?: Agent };
function privateNetworkDispatcher(): Agent {
  dispatcherState.__worklensAiDispatcher ??= new Agent({ connections: 4, pipelining: 1, connectTimeout: CONNECT_TIMEOUT_MS, connect: {
    cert: process.env.WORKLENS_AI_MTLS_CERT_PEM,
    key: process.env.WORKLENS_AI_MTLS_KEY_PEM,
    ...(process.env.WORKLENS_AI_CA_PEM ? { ca: process.env.WORKLENS_AI_CA_PEM } : {}),
    async lookup(hostname, options, callback) {
      try {
        const addresses = await lookup(hostname, { all: true, verbatim: true });
        if (addresses.length === 0 || !addresses.every(({ address }) => isPrivateAddress(address))) return callback(new Error("AI_HOST_NOT_PRIVATE"), "", 0);
        if (options.all) callback(null, addresses); else callback(null, addresses[0].address, addresses[0].family);
      } catch (error) { callback(error instanceof Error ? error : new Error("AI_DNS_FAILED"), "", 0); }
    },
  } });
  return dispatcherState.__worklensAiDispatcher;
}
function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return octets.every((part) => part <= 255) && (octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
}

function fetchWithDeadline(fetcher: typeof globalThis.fetch, base: URL, callerSignal: AbortSignal | undefined, init: RequestInit & { dispatcher: Agent }): Promise<Response> {
  const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(callerSignal ? [callerSignal] : [])]);
  return fetcher(endpoint(base), { ...init, signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" } as RequestInit);
}
async function readJsonLimited(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("AI_RESPONSE_TOO_LARGE");
  if (!response.body) throw new Error("AI_RESPONSE_INVALID");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; if (!value) continue; total += value.byteLength; if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("AI_RESPONSE_TOO_LARGE"); } chunks.push(value); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function isPredicate(value: unknown): value is AiProviderDirectClaim["predicate"] { return typeof value === "string" && ["has_value", "equals", "contains", "increased_from_to", "decreased_from_to", "unchanged", "added", "removed", "structural_change", "exposes", "omits", "conflicts_with", "repeats"].includes(value); }
function isScalar(value: unknown): boolean { return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"; }
function isDirectObject(value: unknown): value is AiProviderDirectClaim["object"] { if (isScalar(value)) return true; return isRecord(value) && Object.keys(value).length > 0 && Object.keys(value).every((key) => key === "before" || key === "after") && Object.values(value).every(isScalar); }
function isQualifiers(value: unknown): value is Record<string, string | number | boolean | null> | undefined { return value === undefined || (isRecord(value) && Object.entries(value).every(([key, scalar]) => key.trim().length > 0 && isScalar(scalar))); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function unavailableReason(error: unknown): AiUnavailableReason { if (error instanceof DOMException && error.name === "TimeoutError") return "timed-out"; if (error instanceof DOMException && error.name === "AbortError") return "cancelled"; return "unhealthy"; }
function sleep(ms: number, signal?: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); }); }

interface SessionGate { active: number; waiters: Array<() => void>; }
async function acquireSessionSlot(sessionKey: string, signal?: AbortSignal): Promise<() => void> {
  const gate = sessionGates.get(sessionKey) ?? { active: 0, waiters: [] }; sessionGates.set(sessionKey, gate);
  if (gate.active >= 2) await new Promise<void>((resolve, reject) => { const wake = () => { signal?.removeEventListener("abort", abort); resolve(); }; const abort = () => { gate.waiters = gate.waiters.filter((waiter) => waiter !== wake); reject(signal?.reason); }; gate.waiters.push(wake); signal?.addEventListener("abort", abort, { once: true }); });
  if (signal?.aborted) throw signal.reason;
  gate.active += 1;
  return () => { gate.active -= 1; const next = gate.waiters.shift(); if (next) next(); else if (gate.active === 0) sessionGates.delete(sessionKey); };
}
