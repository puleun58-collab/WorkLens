import type { AiAvailableResult } from "@/domain/ai";
import type { NormalizedDocument } from "@/domain/document";
import {
  BROWSER_AI_MESSAGES,
  type BrowserAiErrorCode,
  type BrowserAiState,
  type BrowserAiTask,
  type BrowserAiWorkerEvent,
} from "./browser-ai-protocol";

export interface BrowserAiFailure {
  code: BrowserAiErrorCode;
  message: string;
}

type Pending = {
  id: string;
  resolve: (result: AiAvailableResult) => void;
  reject: (failure: BrowserAiFailure) => void;
};

let worker: Worker | undefined;
let pending: Pending | undefined;
let state: BrowserAiState = { phase: "idle" };
const listeners = new Set<(next: BrowserAiState) => void>();

/**
 * WebGPU is the hard requirement for in-browser inference. Everything
 * deterministic keeps working without it, so callers only disable AI actions.
 */
export function browserAiSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean((navigator as Navigator & { gpu?: unknown }).gpu);
}

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

function settleWithFailure(code: BrowserAiErrorCode, message?: string): void {
  const entry = pending;
  pending = undefined;
  entry?.reject({ code, message: message || BROWSER_AI_MESSAGES[code] });
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(new URL("./browser-ai-worker.ts", import.meta.url), { type: "module" });
  created.addEventListener("message", (event: MessageEvent<BrowserAiWorkerEvent>) => {
    const message = event.data;
    if (pending && message.id !== pending.id && message.kind !== "progress") return;
    switch (message.kind) {
      case "progress":
        publish({ phase: "loading", progress: message.progress, text: message.text });
        return;
      case "ready":
        publish({ phase: "ready" });
        return;
      case "result": {
        const entry = pending;
        pending = undefined;
        publish({ phase: "ready" });
        entry?.resolve(message.result);
        return;
      }
      case "error":
        // A late failure for a request the user already cancelled must not
        // resurface as a model error.
        if (!pending) {
          if (state.phase === "loading") publish({ phase: "idle" });
          return;
        }
        if (message.code === "LOAD_FAILED") publish({ phase: "failed", message: BROWSER_AI_MESSAGES.LOAD_FAILED, detail: message.message });
        else if (state.phase === "loading") publish({ phase: "ready" });
        settleWithFailure(message.code, message.message);
        return;
    }
  });
  created.addEventListener("error", () => {
    settleWithFailure("WORKER_FAILED");
    publish({ phase: "failed", message: BROWSER_AI_MESSAGES.WORKER_FAILED });
    created.terminate();
    worker = undefined;
  });
  worker = created;
  return created;
}

/**
 * Lazy by contract: the model is downloaded on the first AI request, never on
 * page load, and only one request runs at a time so the tab keeps one model in
 * memory alongside the document worker.
 */
export function runBrowserAi(task: BrowserAiTask, documents: NormalizedDocument[]): Promise<AiAvailableResult> {
  if (!browserAiSupported()) {
    publish({ phase: "unsupported" });
    return Promise.reject<AiAvailableResult>({ code: "NO_WEBGPU", message: BROWSER_AI_MESSAGES.NO_WEBGPU } satisfies BrowserAiFailure);
  }
  if (pending) {
    return Promise.reject<AiAvailableResult>({ code: "BUSY", message: BROWSER_AI_MESSAGES.BUSY } satisfies BrowserAiFailure);
  }
  const id = crypto.randomUUID();
  const target = ensureWorker();
  if (state.phase !== "ready") publish({ phase: "loading", progress: 0, text: "브라우저 AI를 준비하는 중" });
  return new Promise<AiAvailableResult>((resolve, reject) => {
    pending = { id, resolve, reject };
    target.postMessage({ id, kind: "run", task, documents });
  });
}

/** Settles the caller immediately so the UI never waits on a stopped model. */
export function cancelBrowserAi(): void {
  if (!worker || !pending) return;
  worker.postMessage({ id: pending.id, kind: "cancel" });
  settleWithFailure("CANCELLED");
  if (state.phase === "loading") publish({ phase: "idle" });
}

/** Releases the model and every in-flight request, mirroring 모두 삭제. */
export function disposeBrowserAi(): void {
  settleWithFailure("CANCELLED");
  worker?.terminate();
  worker = undefined;
  publish({ phase: "idle" });
}
