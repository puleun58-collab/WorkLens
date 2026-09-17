import type { EvidenceItem, ModelClaim } from "@/lib/ai/prompt";
import type { ExtractProposal } from "@/lib/ai/extract-prompt";
import type { AiRequest } from "@/domain/ai";
import type { PolishMode, PolishProposal } from "@/domain/polish";

/**
 * Contract between the main thread and the browser AI worker.
 *
 * The AI worker is separate from the document worker: parsing keeps running
 * while a model loads, terminating one never drops the other's memory, and the
 * only document data that crosses this boundary is the bounded evidence window
 * (`handle` + `text`) built by the document worker.
 */
/**
 * The two models this product ships, and the only two it will load.
 *
 * `vramRequiredMb` and `downloadMb` are the published MLC figures for these
 * exact repositories — `tests/browser-ai-model.test.ts` pins them against the
 * installed `prebuiltAppConfig`, so a WebLLM upgrade that moves them fails in
 * unit tests rather than on a user's machine.
 *
 * `contextWindowSize` is deliberately below the prebuilt 4,096: the KV cache
 * is allocated up front and scales with it, and WorkLens never feeds a whole
 * document to the model — the document worker hands over a bounded evidence
 * window (40 items, 5,000 characters), which fits well inside 2,048 tokens.
 */
export type BrowserAiTier = "standard" | "light";

export interface BrowserAiModelProfile {
  tier: BrowserAiTier;
  id: string;
  label: string;
  /** First-run download: weights and config plus the WebGPU runtime library. */
  downloadMb: number;
  /** Device memory the engine reserves once loaded. */
  vramRequiredMb: number;
  contextWindowSize: number;
}

export const BROWSER_AI_MODELS: Record<BrowserAiTier, BrowserAiModelProfile> = {
  standard: {
    tier: "standard",
    id: "Qwen3.5-4B-q4f16_1-MLC",
    label: "표준 AI 모델",
    downloadMb: 2_290,
    vramRequiredMb: 3_868,
    contextWindowSize: 2_048,
  },
  light: {
    tier: "light",
    id: "Qwen3.5-2B-q4f16_1-MLC",
    label: "경량 AI 모델",
    downloadMb: 1_320,
    vramRequiredMb: 2_245,
    contextWindowSize: 2_048,
  },
};

export const BROWSER_AI_MODEL_ID = BROWSER_AI_MODELS.standard.id;
export const BROWSER_AI_MODEL_LABEL = "Qwen3.5 4B";
export const BROWSER_AI_MODEL_MB = BROWSER_AI_MODELS.standard.downloadMb;
/**
 * Previous default, kept as the A/B baseline for the real-WebGPU runs and
 * selected only through the `window.__worklensAiModel` test seam.
 */
export const BROWSER_AI_BASELINE_MODEL_ID = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
export const BROWSER_AI_MAX_FILES = 5;

export type BrowserAiErrorCode =
  | "NO_WEBGPU"
  | "ADAPTER_FAILED"
  | "DEVICE_FAILED"
  | "MODEL_DOWNLOAD_FAILED"
  | "MODEL_LOAD_FAILED"
  | "OUT_OF_MEMORY"
  | "INFERENCE_FAILED"
  | "INVALID_OUTPUT"
  | "GROUNDING_REJECTED"
  | "NO_EVIDENCE"
  | "CANCELLED"
  | "BUSY"
  | "WORKER_FAILED";

/**
 * Model lifecycle. `checking` probes the WebGPU adapter, `awaiting-confirmation`
 * waits for the user to accept the one-time download, and `loading` is the only
 * phase that reports progress.
 */
export type BrowserAiState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "awaiting-confirmation" }
  | { phase: "unsupported"; code: "NO_WEBGPU" | "ADAPTER_FAILED" | "DEVICE_FAILED" }
  | { phase: "loading"; progress: number; text: string }
  | { phase: "ready" }
  | { phase: "failed"; code: BrowserAiErrorCode; message: string; detail?: string };

/**
 * Every request names the model and the context it must be loaded with: the
 * KV cache is allocated when the engine is created, so the context size is
 * part of choosing a model, not a later setting.
 */
export interface BrowserAiModelRequest {
  modelId: string;
  contextWindowSize: number;
}

export type BrowserAiWorkerRequest =
  | ({ id: string; kind: "load" } & BrowserAiModelRequest)
  | ({ id: string; kind: "generate"; request: AiRequest; items: EvidenceItem[] } & BrowserAiModelRequest)
  | ({ id: string; kind: "polish"; text: string; mode: PolishMode } & BrowserAiModelRequest)
  | ({ id: string; kind: "extract"; field: string; items: EvidenceItem[] } & BrowserAiModelRequest)
  | { id: string; kind: "interrupt" };

export type BrowserAiWorkerEvent =
  | { id: string; kind: "progress"; progress: number; text: string }
  | { id: string; kind: "ready" }
  | { id: string; kind: "claims"; claims: ModelClaim[] }
  | { id: string; kind: "polish"; proposal: PolishProposal }
  | { id: string; kind: "extract"; proposal: ExtractProposal }
  | { id: string; kind: "error"; code: BrowserAiErrorCode; message: string };

/**
 * User-facing copy. Error codes stay internal; only these strings are shown.
 * These are the full sentences the notice shows. The AI status box says the
 * same thing in fewer words — see `BROWSER_AI_STATUS_MESSAGES` — so one
 * failure never reads as two different problems.
 */
export const BROWSER_AI_MESSAGES: Record<BrowserAiErrorCode, string> = {
  NO_WEBGPU: "이 브라우저 또는 장치가 WebGPU를 지원하지 않아 브라우저 AI를 사용할 수 없습니다. AI 기능을 제외한 나머지 기능은 계속 사용할 수 있습니다.",
  ADAPTER_FAILED: "이 장치의 그래픽 어댑터에서 브라우저 AI를 시작할 수 없습니다. 회사 브라우저 정책에서 WebGPU가 제한되었을 수도 있습니다. AI 기능을 제외한 나머지 기능은 계속 사용할 수 있습니다.",
  DEVICE_FAILED: "그래픽 장치를 준비하지 못했습니다. 다른 프로그램이 GPU를 점유하고 있거나 드라이버 업데이트가 필요할 수 있습니다. AI 기능을 제외한 나머지 기능은 계속 사용할 수 있습니다.",
  MODEL_DOWNLOAD_FAILED: "모델 데이터를 불러오지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.",
  MODEL_LOAD_FAILED: "AI 모델을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  OUT_OF_MEMORY: "이 장치의 메모리에서 AI 모델을 실행하기 어렵습니다.",
  INFERENCE_FAILED: "AI 실행 중 문제가 발생했습니다. 다시 시도해 주세요.",
  INVALID_OUTPUT: "AI 응답을 해석하지 못했습니다. 다시 시도해 주세요.",
  GROUNDING_REJECTED: "근거로 확인되지 않은 AI 결과는 표시하지 않았습니다.",
  NO_EVIDENCE: "선택한 문서에서 질문을 뒷받침할 근거를 찾지 못했습니다.",
  CANCELLED: "브라우저 AI 작업을 취소했습니다.",
  BUSY: "브라우저 AI 작업이 이미 실행 중입니다.",
  WORKER_FAILED: "브라우저 AI를 시작하지 못했습니다. 페이지를 새로고침한 후 다시 시도해 주세요.",
};

/**
 * The AI status box reports the current state, not the whole story, so it uses
 * a shorter line where the full sentence would repeat what the notice above it
 * already said. Codes without an entry here read the same in both places.
 */
export const BROWSER_AI_STATUS_MESSAGES: Partial<Record<BrowserAiErrorCode, string>> = {
  WORKER_FAILED: "브라우저 AI를 시작하지 못했습니다. 새로고침 후 다시 시도해 주세요.",
};
