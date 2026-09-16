import type { AiRequest } from "@/domain/ai";
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

type Pending = {
  id: string;
  /** `load` settles on ready; `generate` settles on claims. */
  kind: "load" | "generate";
  resolve: (claims: ModelClaim[]) => void;
  reject: (failure: BrowserAiFailure) => void;
};

let worker: Worker | undefined;
let pending: Pending | undefined;
let confirmed = false;
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
  publish(confirmed ? { phase: "idle" } : { phase: "awaiting-confirmation" });
  return state;
}

/** The user accepted the one-time model download. */
export function confirmBrowserAi(): void {
  confirmed = true;
  if (state.phase === "awaiting-confirmation") publish({ phase: "idle" });
}

export function browserAiConfirmed(): boolean {
  return confirmed;
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
        entry.resolve(message.claims);
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

function send(kind: "load" | "generate", payload?: { request: AiRequest; items: EvidenceItem[] }): Promise<ModelClaim[]> {
  if (pending) {
    return Promise.reject<ModelClaim[]>({ code: "BUSY", message: BROWSER_AI_MESSAGES.BUSY } satisfies BrowserAiFailure);
  }
  const id = crypto.randomUUID();
  const target = ensureWorker();
  if (state.phase !== "ready") publish({ phase: "loading", progress: 0, text: "브라우저 AI를 준비하는 중" });
  return new Promise<ModelClaim[]>((resolve, reject) => {
    pending = { id, kind, resolve, reject };
    const modelId = selectedModelId();
    target.postMessage(payload ? { id, kind, modelId, ...payload } : { id, kind, modelId });
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

/** Releases the model and every in-flight request, mirroring 모두 삭제. */
export function disposeBrowserAi(): void {
  settle("CANCELLED");
  worker?.terminate();
  worker = undefined;
  confirmed = false;
  publish({ phase: "idle" });
}
