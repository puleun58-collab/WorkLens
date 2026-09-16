import type { AiRequest } from "@/domain/ai";
import type { PolishMode, PolishProposal } from "@/domain/polish";
import type { ExtractProposal } from "@/lib/ai/extract-prompt";
import type { EvidenceItem, ModelClaim } from "@/lib/ai/prompt";
import {
  BROWSER_AI_BASELINE_MODEL_ID,
  BROWSER_AI_MESSAGES,
  BROWSER_AI_MODEL_ID,
  type BrowserAiErrorCode,
  type BrowserAiState,
  type BrowserAiWorkerEvent,
} from "./browser-ai-protocol";

/**
 * The product ships one model. `window.__worklensAiModel` exists only so the
 * real-WebGPU smoke run can replay the same flow on the previous default for
 * an A/B comparison; anything else falls back to the shipped model.
 */
function selectedModelId(): string {
  const scope: object = globalThis;
  const baseline = "__worklensAiModel" in scope && scope.__worklensAiModel === BROWSER_AI_BASELINE_MODEL_ID;
  return baseline ? BROWSER_AI_BASELINE_MODEL_ID : BROWSER_AI_MODEL_ID;
}

export interface BrowserAiFailure {
  code: BrowserAiErrorCode;
  message: string;
}

/**
 * One request at a time. `load` settles on ready, `generate` on claims, and
 * `polish` on a single rewrite proposal, so each kind carries its own resolve
 * type instead of a shared any-shaped payload.
 */
type Pending =
  | { id: string; kind: "load" | "generate"; resolve: (claims: ModelClaim[]) => void; reject: (failure: BrowserAiFailure) => void }
  | { id: string; kind: "polish"; resolve: (proposal: PolishProposal) => void; reject: (failure: BrowserAiFailure) => void }
  | { id: string; kind: "extract"; resolve: (proposal: ExtractProposal) => void; reject: (failure: BrowserAiFailure) => void };

let worker: Worker | undefined;
let pending: Pending | undefined;
let state: BrowserAiState = { phase: "idle" };
const listeners = new Set<(next: BrowserAiState) => void>();

export function browserAiState(): BrowserAiState {
  return state;
}

export function subscribeBrowserAi(listener: (next: BrowserAiState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

function publish(next: BrowserAiState): void {
  state = next;
  for (const listener of listeners) listener(next);
}

function settle(code: BrowserAiErrorCode, message?: string): void {
  const entry = pending;
  pending = undefined;
  entry?.reject({ code, message: message || BROWSER_AI_MESSAGES[code] });
}

/**
 * WebGPU presence is not enough: a device can expose `navigator.gpu` and still
 * fail to hand out an adapter, which is the difference between "unsupported"
 * and "model failed" in the UI.
 */
export async function probeBrowserAi(): Promise<BrowserAiState> {
  if (state.phase === "ready" || state.phase === "loading") return state;
  const gpu = typeof navigator === "undefined"
    ? undefined
    : (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) {
    publish({ phase: "unsupported", code: "NO_WEBGPU" });
    return state;
  }
  publish({ phase: "checking" });
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      publish({ phase: "unsupported", code: "ADAPTER_FAILED" });
      return state;
    }
  } catch {
    publish({ phase: "unsupported", code: "ADAPTER_FAILED" });
    return state;
  }
  publish(browserAiConfirmed() ? { phase: "idle" } : { phase: "awaiting-confirmation" });
  return state;
}

/**
 * Consent is per model and survives a reload, because the weights survive one
 * too: WebLLM keeps them in the browser cache. Only the fact that this user
 * allowed the download is stored — never a document, question, answer or
 * source — and consent is not a claim that the cache is populated. The load
 * still runs; WebLLM serves it from cache on a hit and downloads on a miss.
 */
const CONSENT_SCHEMA_VERSION = 1;
const CONSENT_KEY_PREFIX = `worklens:browser-ai-consent:v${CONSENT_SCHEMA_VERSION}:`;

interface ConsentRecord {
  version: number;
  model: string;
  consented: boolean;
}

export function browserAiConfirmed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(`${CONSENT_KEY_PREFIX}${selectedModelId()}`);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Partial<ConsentRecord>;
    return parsed.version === CONSENT_SCHEMA_VERSION && parsed.model === selectedModelId() && parsed.consented === true;
  } catch {
    return false;
  }
}

/** The user accepted the one-time model download for the selected model. */
export function confirmBrowserAi(): void {
  const model = selectedModelId();
  const record: ConsentRecord = { version: CONSENT_SCHEMA_VERSION, model, consented: true };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(`${CONSENT_KEY_PREFIX}${model}`, JSON.stringify(record));
    } catch {
      // Private mode or a full quota only costs a repeated confirmation.
    }
  }
  if (state.phase === "awaiting-confirmation") publish({ phase: "idle" });
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(new URL("./browser-ai-worker.ts", import.meta.url), { type: "module" });
  created.addEventListener("message", (event: MessageEvent<BrowserAiWorkerEvent>) => {
    const message = event.data;
    if (message.kind === "progress") {
      if (pending) publish({ phase: "loading", progress: message.progress, text: message.text });
      return;
    }
    if (!pending || pending.id !== message.id) return;
    switch (message.kind) {
      case "ready": {
        const entry = pending;
        publish({ phase: "ready" });
        if (entry.kind === "load") {
          pending = undefined;
          entry.resolve([]);
        }
        return;
      }
      case "claims": {
        const entry = pending;
        pending = undefined;
        publish({ phase: "ready" });
        if (entry.kind === "load" || entry.kind === "generate") entry.resolve(message.claims);
        return;
      }
      case "polish": {
        const entry = pending;
        pending = undefined;
        publish({ phase: "ready" });
        if (entry.kind === "polish") entry.resolve(message.proposal);
        return;
      }
      case "extract": {
        const entry = pending;
        pending = undefined;
        publish({ phase: "ready" });
        if (entry.kind === "extract") entry.resolve(message.proposal);
        return;
      }
      case "error": {
        if (message.code === "MODEL_DOWNLOAD_FAILED" || message.code === "MODEL_LOAD_FAILED"
          || message.code === "ADAPTER_FAILED" || message.code === "OUT_OF_MEMORY") {
          publish({ phase: "failed", code: message.code, message: BROWSER_AI_MESSAGES[message.code], detail: message.message });
        } else if (state.phase === "loading") {
          publish({ phase: "ready" });
        }
        settle(message.code, BROWSER_AI_MESSAGES[message.code]);
        return;
      }
    }
  });
  created.addEventListener("error", () => {
    settle("WORKER_FAILED");
    publish({ phase: "failed", code: "WORKER_FAILED", message: BROWSER_AI_MESSAGES.WORKER_FAILED });
    created.terminate();
    worker = undefined;
  });
  worker = created;
  return created;
}

/** Busy check plus the loading phase every request shares. */
function begin(): { id: string; target: Worker } {
  const id = crypto.randomUUID();
  const target = ensureWorker();
  if (state.phase !== "ready") publish({ phase: "loading", progress: 0, text: "브라우저 AI를 준비하는 중" });
  return { id, target };
}

function send(kind: "load" | "generate", payload?: { request: AiRequest; items: EvidenceItem[] }): Promise<ModelClaim[]> {
  if (pending) {
    return Promise.reject<ModelClaim[]>({ code: "BUSY", message: BROWSER_AI_MESSAGES.BUSY } satisfies BrowserAiFailure);
  }
  const { id, target } = begin();
  return new Promise<ModelClaim[]>((resolve, reject) => {
    pending = { id, kind, resolve, reject };
    const modelId = selectedModelId();
    target.postMessage(payload ? { id, kind, modelId, ...payload } : { id, kind, modelId });
  });
}

/**
 * Rewrites one prose segment. Polish runs segment by segment through the same
 * single-request lifecycle as every other AI task: no parallel generations,
 * and the caller's cancel applies to the segment in flight.
 */
export function polishBrowserAi(text: string, mode: PolishMode): Promise<PolishProposal> {
  if (pending) {
    return Promise.reject<PolishProposal>({ code: "BUSY", message: BROWSER_AI_MESSAGES.BUSY } satisfies BrowserAiFailure);
  }
  const { id, target } = begin();
  return new Promise<PolishProposal>((resolve, reject) => {
    pending = { id, kind: "polish", resolve, reject };
    target.postMessage({ id, kind: "polish", modelId: selectedModelId(), text, mode });
  });
}

/** Downloads and initializes the model without running a task. */
export async function loadBrowserAi(): Promise<void> {
  await send("load");
}

/**
 * Runs one task. Lazy by contract: the model is only fetched on the first AI
 * request, never on page load, and one request runs at a time.
 */
export function generateBrowserAi(request: AiRequest, items: EvidenceItem[]): Promise<ModelClaim[]> {
  return send("generate", { request, items });
}

/**
 * Resolves one requested field against one bounded evidence window. The window
 * is built by the document worker, so this call carries handles and text only.
 */
export function extractBrowserAi(field: string, items: EvidenceItem[]): Promise<ExtractProposal> {
  if (pending) {
    return Promise.reject<ExtractProposal>({ code: "BUSY", message: BROWSER_AI_MESSAGES.BUSY } satisfies BrowserAiFailure);
  }
  const { id, target } = begin();
  return new Promise<ExtractProposal>((resolve, reject) => {
    pending = { id, kind: "extract", resolve, reject };
    target.postMessage({ id, kind: "extract", modelId: selectedModelId(), field, items });
  });
}

/** Stops generation in place; the loaded model stays in memory. */
export function interruptBrowserAi(): void {
  if (!worker || !pending || pending.kind !== "generate") return;
  worker.postMessage({ id: pending.id, kind: "interrupt" });
  settle("CANCELLED");
}

/**
 * Cancels a download. WebLLM has no abort for an in-flight load, so the worker
 * is terminated and recreated on the next request.
 */
export function cancelBrowserAiLoad(): void {
  settle("CANCELLED");
  worker?.terminate();
  worker = undefined;
  publish({ phase: "idle" });
}

/**
 * Releases the model and every in-flight request, mirroring 모두 삭제. Runtime
 * state only: the stored consent is a user decision, not workspace data, so
 * clearing the workspace does not revoke it.
 */
export function disposeBrowserAi(): void {
  settle("CANCELLED");
  worker?.terminate();
  worker = undefined;
  publish({ phase: "idle" });
}
