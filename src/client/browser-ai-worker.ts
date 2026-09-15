import { CreateMLCEngine, type InitProgressReport, type MLCEngine } from "@mlc-ai/web-llm";
import type { AiRequest } from "@/domain/ai";
import type { NormalizedDocument } from "@/domain/document";
import { buildEvidenceNodes, groundAiResult } from "@/lib/ai/grounding";
import { CLAIM_RESPONSE_SCHEMA, buildMessages, evidenceWindow, parseModelCompletion } from "@/lib/ai/prompt";
import {
  BROWSER_AI_MODEL_ID,
  type BrowserAiErrorCode,
  type BrowserAiTask,
  type BrowserAiWorkerEvent,
  type BrowserAiWorkerRequest,
} from "./browser-ai-protocol";

/**
 * Browser AI worker.
 *
 * Runs the WebLLM engine off the main thread so a model download or a long
 * generation never blocks the UI, and keeps document text inside this worker
 * for the duration of one request only: nothing is cached at module scope.
 */
let engine: MLCEngine | undefined;
let loading: Promise<MLCEngine> | undefined;
let activeRequestId: string | undefined;

const MAX_OUTPUT_TOKENS = 700;

function post(event: BrowserAiWorkerEvent): void {
  self.postMessage(event);
}

function fail(id: string, code: BrowserAiErrorCode, message: string): void {
  post({ id, kind: "error", code, message });
}

async function loadEngine(id: string): Promise<MLCEngine> {
  if (engine) return engine;
  loading ??= CreateMLCEngine(BROWSER_AI_MODEL_ID, {
    initProgressCallback: (report: InitProgressReport) => {
      if (!activeRequestId) return;
      post({ id: activeRequestId, kind: "progress", progress: report.progress, text: report.text });
    },
  }).then((created) => {
    engine = created;
    return created;
  }).catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  const ready = await loading;
  post({ id, kind: "ready" });
  return ready;
}

function toAiRequest(task: BrowserAiTask): AiRequest {
  switch (task.kind) {
    case "ask":
      return { operation: "ask", question: task.question };
    case "brief":
      return { operation: "brief", ...(task.instruction ? { instruction: task.instruction } : {}) };
    case "semantic-check":
      return { operation: "semantic-check", statement: task.statement };
    case "analyze":
      return { operation: "analyze" };
  }
}

async function run(id: string, task: BrowserAiTask, documents: NormalizedDocument[]): Promise<void> {
  const window = evidenceWindow(buildEvidenceNodes(documents));
  if (window.items.length === 0) {
    fail(id, "NO_EVIDENCE", "선택한 문서에서 사용할 수 있는 근거를 찾지 못했습니다.");
    return;
  }
  let active: MLCEngine;
  try {
    active = await loadEngine(id);
  } catch (error) {
    fail(id, "LOAD_FAILED", error instanceof Error ? error.message : "모델을 불러오지 못했습니다.");
    return;
  }
  if (activeRequestId !== id) {
    fail(id, "CANCELLED", "브라우저 AI 작업을 취소했습니다.");
    return;
  }

  const request = toAiRequest(task);
  let raw: string;
  try {
    const completion = await active.chat.completions.create({
      messages: buildMessages(request, window),
      temperature: 0.2,
      max_tokens: MAX_OUTPUT_TOKENS,
      response_format: { type: "json_object", schema: JSON.stringify(CLAIM_RESPONSE_SCHEMA) },
    });
    raw = completion.choices[0]?.message?.content ?? "";
  } catch (error) {
    if (activeRequestId !== id) {
      fail(id, "CANCELLED", "브라우저 AI 작업을 취소했습니다.");
      return;
    }
    fail(id, "LOAD_FAILED", error instanceof Error ? error.message : "모델 실행에 실패했습니다.");
    return;
  }
  if (activeRequestId !== id) {
    fail(id, "CANCELLED", "브라우저 AI 작업을 취소했습니다.");
    return;
  }

  const result = groundAiResult(request, documents, parseModelCompletion(raw, window));
  // A rejected claim means the model drifted off the evidence index: refuse the
  // whole completion instead of showing a partially grounded answer.
  if (result.rejectedClaimCount > 0 || result.claims.length === 0) {
    fail(id, "NO_EVIDENCE", "근거로 확인되지 않은 AI 결과를 사용하지 않았습니다.");
    return;
  }
  post({ id, kind: "result", result });
}

self.addEventListener("message", (event: MessageEvent<BrowserAiWorkerRequest>) => {
  const request = event.data;
  if (request.kind === "cancel") {
    if (!activeRequestId) return;
    activeRequestId = undefined;
    engine?.interruptGenerate();
    return;
  }
  if (activeRequestId) {
    fail(request.id, "BUSY", "브라우저 AI 작업이 이미 실행 중입니다.");
    return;
  }
  activeRequestId = request.id;
  void run(request.id, request.task, request.documents).finally(() => {
    if (activeRequestId === request.id) activeRequestId = undefined;
  });
});
