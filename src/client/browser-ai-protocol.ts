import type { AiAvailableResult } from "@/domain/ai";
import type { NormalizedDocument } from "@/domain/document";

/**
 * Contract between the main thread and the browser AI worker.
 *
 * The AI worker is separate from the document worker: parsing keeps running
 * while a model loads, and terminating one never drops the other's memory.
 */
export const BROWSER_AI_MODEL_ID = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
export const BROWSER_AI_MODEL_LABEL = "Qwen2.5 1.5B Instruct (q4f16)";
/** Weight download size, used only for the first-run notice. */
export const BROWSER_AI_MODEL_MB = 1_630;
export const BROWSER_AI_MAX_FILES = 5;

export type BrowserAiTask =
  | { kind: "analyze" }
  | { kind: "ask"; question: string }
  | { kind: "brief"; instruction?: string }
  | { kind: "semantic-check"; statement: string };

export type BrowserAiErrorCode =
  | "NO_WEBGPU"
  | "LOAD_FAILED"
  | "CANCELLED"
  | "NO_EVIDENCE"
  | "BUSY"
  | "WORKER_FAILED";

/** UI-facing model lifecycle. `idle` means nothing has been downloaded yet. */
export type BrowserAiState =
  | { phase: "idle" }
  | { phase: "unsupported" }
  | { phase: "loading"; progress: number; text: string }
  | { phase: "ready" }
  | { phase: "failed"; message: string; detail?: string };

export type BrowserAiWorkerRequest =
  | { id: string; kind: "run"; task: BrowserAiTask; documents: NormalizedDocument[] }
  | { id: string; kind: "cancel" };

export type BrowserAiWorkerEvent =
  | { id: string; kind: "progress"; progress: number; text: string }
  | { id: string; kind: "ready" }
  | { id: string; kind: "result"; result: AiAvailableResult }
  | { id: string; kind: "error"; code: BrowserAiErrorCode; message: string };

export const BROWSER_AI_MESSAGES: Record<BrowserAiErrorCode, string> = {
  NO_WEBGPU: "이 브라우저 또는 장치에서는 WebGPU를 지원하지 않습니다. 기본 분석·비교·검수·추출 기능은 계속 사용할 수 있습니다.",
  LOAD_FAILED: "브라우저 AI 모델을 준비하지 못했습니다. 기본 분석·비교·검수·추출 기능은 계속 사용할 수 있습니다.",
  CANCELLED: "브라우저 AI 작업을 취소했습니다.",
  NO_EVIDENCE: "선택한 문서에서 답을 뒷받침할 근거를 찾지 못했습니다.",
  BUSY: "브라우저 AI 작업이 이미 실행 중입니다.",
  WORKER_FAILED: "브라우저 AI 처리기를 실행하지 못했습니다. 페이지를 새로고침하세요.",
};
