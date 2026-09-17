import type { AiRequest } from "@/domain/ai";
import type { PolishMode, PolishProposal } from "@/domain/polish";
import type { ExtractProposal } from "@/lib/ai/extract-prompt";
import type { EvidenceItem, ModelClaim } from "@/lib/ai/prompt";
import {
  resolveBrowserAiModel,
  type BrowserAiModelDecision,
  type DeviceSignals,
} from "./browser-ai-capability";
import {
  BROWSER_AI_BASELINE_MODEL_ID,
  BROWSER_AI_MESSAGES,
  type BrowserAiErrorCode,
  type BrowserAiState,
  type BrowserAiTier,
  type BrowserAiWorkerEvent,
} from "./browser-ai-protocol";

/**
 * Which model this browser may load, and the operator's answer when the
 * browser cannot tell. The decision is made here, before a download or an
 * allocation, because a machine killed by the large model cannot fall back.
 *
 * `window.__worklensAiModel` stays the A/B seam for the real-WebGPU runs:
 * it names the previous default, which is loaded as-is.
 */
const TIER_STORAGE_KEY = "worklens:browser-ai-tier:v1";
let signals: DeviceSignals = {};
let decision: BrowserAiModelDecision = resolveBrowserAiModel(signals, readTierPreference());

function readTierPreference(): BrowserAiTier | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const stored = window.localStorage.getItem(TIER_STORAGE_KEY);
    return stored === "standard" || stored === "light" ? stored : undefined;
  } catch {
    return undefined;
  }
}

function baselineOverride(): string | undefined {
  const scope: object = globalThis;
  return "__worklensAiModel" in scope && scope.__worklensAiModel === BROWSER_AI_BASELINE_MODEL_ID
    ? BROWSER_AI_BASELINE_MODEL_ID
    : undefined;
}

/** The model the next load will use, and the context it will be loaded with. */
export function browserAiModel(): { id: string; label: string; downloadMb: number; contextWindowSize: number; tier: BrowserAiTier } {
  const override = baselineOverride();
  const { profile } = decision;
  return override
    ? { id: override, label: profile.label, downloadMb: profile.downloadMb, contextWindowSize: profile.contextWindowSize, tier: profile.tier }
    : { id: profile.id, label: profile.label, downloadMb: profile.downloadMb, contextWindowSize: profile.contextWindowSize, tier: profile.tier };
}

export function browserAiDecision(): BrowserAiModelDecision & { signals: DeviceSignals } {
  return { ...decision, signals };
}

/** The operator answering the question the browser cannot: remembered per browser. */
export function selectBrowserAiTier(tier: BrowserAiTier): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(TIER_STORAGE_KEY, tier);
    } catch {
      // A refused write only costs the choice being asked again.
    }
  }
  decision = resolveBrowserAiModel(signals, tier);
  console.info(`[AI][Model] ${decision.profile.id} — ${decision.reason}`);
  if (state.phase === "awaiting-confirmation" || state.phase === "idle") {
    publish(browserAiConfirmed() ? { phase: "idle" } : { phase: "awaiting-confirmation" });
  }
}

function selectedModelId(): string {
  return browserAiModel().id;
}

/**
 * Seams for the real-WebGPU runs, alongside `__worklensAiModel`: the decision
 * is made in this module before anything is allocated, so a run can read what
 * was chosen and why, and can ask for a tier without clicking through the
 * panel. Neither is used by the product.
 */
if (typeof window !== "undefined") {
  Reflect.set(window, "__worklensAiDiagnostics", () => {
    const model = browserAiModel();
    return {
      modelId: model.id,
      label: model.label,
      tier: model.tier,
      contextWindowSize: model.contextWindowSize,
      downloadMb: model.downloadMb,
      reason: decision.reason,
      source: decision.source,
      standardBlocked: decision.standardBlocked,
      signals,
    };
  });
  Reflect.set(window, "__worklensAiSelectTier", (tier: BrowserAiTier) => selectBrowserAiTier(tier));
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
 * Minimal WebGPU surface. The project does not depend on `@webgpu/types`, and
 * the probe only needs an adapter and a device.
 */
interface ProbeDevice { destroy(): void }
interface ProbeAdapterLimits { maxBufferSize?: number; maxStorageBufferBindingSize?: number }
interface ProbeAdapter { requestDevice(): Promise<ProbeDevice>; limits?: ProbeAdapterLimits }
interface ProbeGpu { requestAdapter(): Promise<ProbeAdapter | null> }

/**
 * Environment check before any download starts, one stage at a time: WebGPU
 * presence, an adapter, then a device. A machine can expose `navigator.gpu`
 * and still refuse an adapter, and it can hand out an adapter and still fail
 * to create a device, so each failure is reported as itself and logged under
 * its own tag for the console.
 */
export async function probeBrowserAi(): Promise<BrowserAiState> {
  if (state.phase === "ready" || state.phase === "loading") return state;
  const scope = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { gpu?: ProbeGpu });
  const gpu = scope?.gpu;
  if (!gpu) {
    console.info("[AI][WebGPU] navigator.gpu is unavailable in this browser");
    publish({ phase: "unsupported", code: "NO_WEBGPU" });
    return state;
  }
  publish({ phase: "checking" });
  let adapter: ProbeAdapter | null = null;
  try {
    adapter = await gpu.requestAdapter();
  } catch (error) {
    console.error("[AI][Adapter] requestAdapter threw", error);
    publish({ phase: "unsupported", code: "ADAPTER_FAILED" });
    return state;
  }
  if (!adapter) {
    console.error("[AI][Adapter] requestAdapter returned null");
    publish({ phase: "unsupported", code: "ADAPTER_FAILED" });
    return state;
  }
  try {
    // A device is what WebLLM actually needs; asking for it here means a
    // driver or policy refusal is reported before a 2 GB download starts.
    const device = await adapter.requestDevice();
    device.destroy();
  } catch (error) {
    console.error("[AI][Device] requestDevice failed", error);
    publish({ phase: "unsupported", code: "DEVICE_FAILED" });
    return state;
  }
  // Everything the browser will say about capacity, read once, while nothing
  // is allocated yet. The model is chosen from this and never revised by
  // trying the large one and watching the machine die.
  const memory: unknown = Reflect.get(navigator, "deviceMemory");
  signals = {
    ...(typeof memory === "number" ? { deviceMemoryGb: memory } : {}),
    ...(adapter.limits?.maxBufferSize === undefined ? {} : { maxBufferSize: adapter.limits.maxBufferSize }),
    ...(adapter.limits?.maxStorageBufferBindingSize === undefined
      ? {}
      : { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize }),
  };
  decision = resolveBrowserAiModel(signals, readTierPreference());
  console.info(
    `[AI][Model] ${decision.profile.id} (context ${decision.profile.contextWindowSize}) — ${decision.reason}`,
    signals,
  );
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

  created.addEventListener("error", (event) => {
    // A module worker that dies while evaluating reports only this event, so
    // the console keeps whatever the browser gave us and the UI keeps one
    // sentence.
    console.error("[AI][Worker] failed to start", event.message || event, event.filename, event.lineno);
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
    const { id: modelId, contextWindowSize } = browserAiModel();
    target.postMessage(payload
      ? { id, kind, modelId, contextWindowSize, ...payload }
      : { id, kind, modelId, contextWindowSize });
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
    const { id: modelId, contextWindowSize } = browserAiModel();
    target.postMessage({ id, kind: "polish", modelId, contextWindowSize, text, mode });
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
    const { id: modelId, contextWindowSize } = browserAiModel();
    target.postMessage({ id, kind: "extract", modelId, contextWindowSize, field, items });
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
