import type { EvidenceItem, ModelClaim } from "@/lib/ai/prompt";
import type { AiRequest } from "@/domain/ai";

/**
 * Contract between the main thread and the browser AI worker.
 *
 * The AI worker is separate from the document worker: parsing keeps running
 * while a model loads, terminating one never drops the other's memory, and the
 * only document data that crosses this boundary is the bounded evidence window
 * (`handle` + `text`) built by the document worker.
 */
export const BROWSER_AI_MODEL_ID = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
export const BROWSER_AI_MODEL_LABEL = "Qwen2.5 1.5B Instruct (q4f16)";
/** Weight download size, used only for the first-run confirmation. */
export const BROWSER_AI_MODEL_MB = 1_630;
export const BROWSER_AI_MAX_FILES = 5;

export type BrowserAiErrorCode =
  | "NO_WEBGPU"
  | "ADAPTER_FAILED"
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
  | { phase: "unsupported"; code: "NO_WEBGPU" | "ADAPTER_FAILED" }
  | { phase: "loading"; progress: number; text: string }
  | { phase: "ready" }
  | { phase: "failed"; code: BrowserAiErrorCode; message: string; detail?: string };

export type BrowserAiWorkerRequest =
  | { id: string; kind: "load" }
  | { id: string; kind: "generate"; request: AiRequest; items: EvidenceItem[] }
  | { id: string; kind: "interrupt" };

export type BrowserAiWorkerEvent =
  | { id: string; kind: "progress"; progress: number; text: string }
  | { id: string; kind: "ready" }
  | { id: string; kind: "claims"; claims: ModelClaim[] }
  | { id: string; kind: "error"; code: BrowserAiErrorCode; message: string };

/** User-facing copy. Error codes stay internal; only these strings are shown. */
export const BROWSER_AI_MESSAGES: Record<BrowserAiErrorCode, string> = {
  NO_WEBGPU: "이 브라우저 또는 장치가 WebGPU를 지원하지 않아 브라우저 AI를 사용할 수 없습니다. Analyze · Compare · Check · Extract는 계속 사용할 수 있습니다.",
  ADAPTER_FAILED: "이 장치의 그래픽 어댑터에서 브라우저 AI를 초기화할 수 없습니다. Analyze · Compare · Check · Extract는 계속 사용할 수 있습니다.",
  MODEL_DOWNLOAD_FAILED: "AI 모델을 내려받지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.",
  MODEL_LOAD_FAILED: "AI 모델을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  OUT_OF_MEMORY: "이 장치의 메모리에서 AI 모델을 실행하기 어렵습니다.",
  INFERENCE_FAILED: "AI 실행 중 문제가 발생했습니다. 다시 시도해 주세요.",
  INVALID_OUTPUT: "AI 응답을 해석하지 못했습니다. 다시 시도해 주세요.",
  GROUNDING_REJECTED: "근거로 확인되지 않은 AI 결과는 표시하지 않았습니다.",
  NO_EVIDENCE: "선택한 문서에서 질문을 뒷받침할 근거를 찾지 못했습니다.",
  CANCELLED: "브라우저 AI 작업을 취소했습니다.",
  BUSY: "브라우저 AI 작업이 이미 실행 중입니다.",
  WORKER_FAILED: "브라우저 AI 처리기를 실행하지 못했습니다. 페이지를 새로고침하세요.",
};
