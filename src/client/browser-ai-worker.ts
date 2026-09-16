import { CreateMLCEngine, type InitProgressReport, type MLCEngine } from "@mlc-ai/web-llm";
import { CLAIM_RESPONSE_SCHEMA, buildMessages, parseModelClaims } from "@/lib/ai/prompt";
import {
  BROWSER_AI_MODEL_ID,
  type BrowserAiErrorCode,
  type BrowserAiWorkerEvent,
  type BrowserAiWorkerRequest,
} from "./browser-ai-protocol";

/**
 * Browser AI worker.
 *
 * Runs WebLLM off the main thread. It never receives documents: the document
 * worker hands over a bounded evidence window of `handle` + `text`, and the
 * model's answer goes back as handle-level claims, so locators and proposition
 * tokens never enter this thread.
 */
let engine: MLCEngine | undefined;
let loading: Promise<MLCEngine> | undefined;
let generating = false;

const MAX_OUTPUT_TOKENS = 700;

function post(event: BrowserAiWorkerEvent): void {
  self.postMessage(event);
}

function fail(id: string, code: BrowserAiErrorCode, message: string): void {
  post({ id, kind: "error", code, message });
}

/** Splits a runtime failure into the codes the UI treats differently. */
function classify(error: unknown): { code: BrowserAiErrorCode; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  if (lowered.includes("out of memory") || lowered.includes("oom") || lowered.includes("allocation")) {
    return { code: "OUT_OF_MEMORY", message };
  }
  if (lowered.includes("failed to fetch") || lowered.includes("network") || lowered.includes("404")) {
    return { code: "MODEL_DOWNLOAD_FAILED", message };
  }
  if (lowered.includes("adapter") || lowered.includes("device") || lowered.includes("webgpu")) {
    return { code: "ADAPTER_FAILED", message };
  }
  return { code: "MODEL_LOAD_FAILED", message };
}

async function loadEngine(id: string): Promise<MLCEngine> {
  if (engine) return engine;
  loading ??= CreateMLCEngine(BROWSER_AI_MODEL_ID, {
    initProgressCallback: (report: InitProgressReport) => {
      post({ id, kind: "progress", progress: report.progress, text: report.text });
    },
  }).then((created) => {
    engine = created;
    return created;
  }).catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

self.addEventListener("message", (event: MessageEvent<BrowserAiWorkerRequest>) => {
  const request = event.data;
  if (request.kind === "interrupt") {
    // Only generation can be interrupted in place; a download is cancelled by
    // terminating this worker from the client.
    if (generating) engine?.interruptGenerate();
    return;
  }
  if (request.kind === "load") {
    void loadEngine(request.id).then(
      () => post({ id: request.id, kind: "ready" }),
      (error: unknown) => {
        const { code, message } = classify(error);
        fail(request.id, code, message);
      },
    );
    return;
  }

  if (generating) {
    fail(request.id, "BUSY", "브라우저 AI 작업이 이미 실행 중입니다.");
    return;
  }
  generating = true;
  void (async () => {
    const active = await loadEngine(request.id);
    const completion = await active.chat.completions.create({
      messages: buildMessages(request.request, request.items),
      temperature: 0.2,
      max_tokens: MAX_OUTPUT_TOKENS,
      response_format: { type: "json_object", schema: JSON.stringify(CLAIM_RESPONSE_SCHEMA) },
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    const claims = parseModelClaims(raw);
    if (claims.length === 0) {
      fail(request.id, "INVALID_OUTPUT", "모델이 근거를 인용한 항목을 만들지 못했습니다.");
      return;
    }
    post({ id: request.id, kind: "claims", claims });
  })().catch((error: unknown) => {
    const { code, message } = classify(error);
    fail(request.id, code === "MODEL_LOAD_FAILED" && engine ? "INFERENCE_FAILED" : code, message);
  }).finally(() => {
    generating = false;
  });
});
