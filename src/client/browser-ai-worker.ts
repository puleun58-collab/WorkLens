// Must evaluate before WebLLM: its browser bundle reads `window` at module
// scope, and a worker only has `self`. Without this the worker dies with
// "window is not defined" before it can report anything, which the client can
// only see as a bare `error` event.
import "./worker-globals";
import { CreateMLCEngine, type InitProgressReport, type MLCEngine } from "@mlc-ai/web-llm";
import { CLAIM_RESPONSE_SCHEMA, buildMessages, parseModelResponse } from "@/lib/ai/prompt";
import { POLISH_RESPONSE_SCHEMA, buildPolishMessages, parsePolishResponse } from "@/lib/ai/polish-prompt";
import { EXTRACT_RESPONSE_SCHEMA, buildExtractMessages, parseExtractResponse } from "@/lib/ai/extract-prompt";
import type {
  BrowserAiErrorCode,
  BrowserAiWorkerEvent,
  BrowserAiWorkerRequest,
} from "./browser-ai-protocol";
import { noReferrerFetch } from "./no-referrer-fetch";

// Every model request leaves this worker without a Referer: the model host
// answers 404 to a request that carries one, which the browser can only report
// as a CORS failure. `Object.assign` keeps whatever statics the platform's
// `fetch` carries (Bun exposes `preconnect`); only the call is wrapped.
self.fetch = Object.assign(noReferrerFetch(self.fetch.bind(self)), self.fetch);

/**
 * Browser AI worker.
 *
 * Runs WebLLM off the main thread. It never receives documents: the document
 * worker hands over a bounded evidence window of `handle` + `text`, and the
 * model's answer goes back as handle-level claims, so locators and proposition
 * tokens never enter this thread.
 */
let engine: MLCEngine | undefined;
let loadedModel: string | undefined;
let loading: Promise<MLCEngine> | undefined;
let generating = false;

const MAX_OUTPUT_TOKENS = 700;
/**
 * Review work needs reproducible, literal answers rather than variety, so the
 * sampler stays near-greedy and the seed is fixed. `enable_thinking: false` is
 * WebLLM's supported switch for Qwen3: it seeds an empty `<think></think>`
 * block so no reasoning text can ever reach the response.
 */
const SAMPLING = { temperature: 0.2, top_p: 0.8, seed: 1 } as const;

function post(event: BrowserAiWorkerEvent): void {
  self.postMessage(event);
}

function fail(id: string, code: BrowserAiErrorCode, message: string): void {
  post({ id, kind: "error", code, message });
}

/**
 * Splits a runtime failure into the codes the UI treats differently, and keeps
 * the original error in the worker console under a stage tag so a failure can
 * be located without decoding the user-facing sentence.
 */
function classify(error: unknown, stage: string): { code: BrowserAiErrorCode; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AI][${stage}]`, error);
  const lowered = message.toLowerCase();
  if (lowered.includes("out of memory") || lowered.includes("oom") || lowered.includes("allocation")) {
    return { code: "OUT_OF_MEMORY", message };
  }
  if (lowered.includes("failed to fetch") || lowered.includes("network") || lowered.includes("404")) {
    return { code: "MODEL_DOWNLOAD_FAILED", message };
  }
  if (lowered.includes("webassembly") || lowered.includes("wasm") || lowered.includes("compile")) {
    return { code: "MODEL_LOAD_FAILED", message };
  }
  if (lowered.includes("adapter") || lowered.includes("device") || lowered.includes("webgpu")) {
    return { code: "ADAPTER_FAILED", message };
  }
  return { code: "MODEL_LOAD_FAILED", message };
}

async function loadEngine(id: string, modelId: string): Promise<MLCEngine> {
  if (engine && loadedModel === modelId) return engine;
  if (engine && loadedModel !== modelId) {
    const previous = engine;
    engine = undefined;
    loading = undefined;
    await previous.unload();
  }
  loadedModel = modelId;
  loading ??= CreateMLCEngine(modelId, {
    initProgressCallback: (report: InitProgressReport) => {
      post({ id, kind: "progress", progress: report.progress, text: report.text });
    },
  }).then((created) => {
    engine = created;
    return created;
  }).catch((error: unknown) => {
    loading = undefined;
    loadedModel = undefined;
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
    void loadEngine(request.id, request.modelId).then(
      () => post({ id: request.id, kind: "ready" }),
      (error: unknown) => {
        const { code, message } = classify(error, "Model Load");
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
  if (request.kind === "polish") {
    // Polish sends one prose segment at a time: no evidence window, no
    // locators, and the answer is a single rewrite proposal.
    void (async () => {
      const active = await loadEngine(request.id, request.modelId);
      const completion = await active.chat.completions.create({
        messages: buildPolishMessages(request.text, request.mode),
        ...SAMPLING,
        max_tokens: MAX_OUTPUT_TOKENS,
        response_format: { type: "json_object", schema: JSON.stringify(POLISH_RESPONSE_SCHEMA) },
        extra_body: { enable_thinking: false },
      });
      const raw = completion.choices[0]?.message?.content ?? "";
      post({ id: request.id, kind: "polish", proposal: parsePolishResponse(raw, request.text) });
    })().catch((error: unknown) => {
      const { code, message } = classify(error, "Polish");
      fail(request.id, code === "MODEL_LOAD_FAILED" && engine ? "INFERENCE_FAILED" : code, message);
    }).finally(() => {
      generating = false;
    });
    return;
  }
  if (request.kind === "extract") {
    // One field against one bounded evidence window; the answer is a value
    // copied from that window or nothing at all.
    void (async () => {
      const active = await loadEngine(request.id, request.modelId);
      const completion = await active.chat.completions.create({
        messages: buildExtractMessages(request.field, request.items),
        ...SAMPLING,
        max_tokens: MAX_OUTPUT_TOKENS,
        response_format: { type: "json_object", schema: JSON.stringify(EXTRACT_RESPONSE_SCHEMA) },
        extra_body: { enable_thinking: false },
      });
      const raw = completion.choices[0]?.message?.content ?? "";
      post({ id: request.id, kind: "extract", proposal: parseExtractResponse(raw, request.field, request.items) });
    })().catch((error: unknown) => {
      const { code, message } = classify(error, "Extract");
      fail(request.id, code === "MODEL_LOAD_FAILED" && engine ? "INFERENCE_FAILED" : code, message);
    }).finally(() => {
      generating = false;
    });
    return;
  }
  void (async () => {
    const active = await loadEngine(request.id, request.modelId);
    const completion = await active.chat.completions.create({
      messages: buildMessages(request.request, request.items),
      ...SAMPLING,
      max_tokens: MAX_OUTPUT_TOKENS,
      response_format: { type: "json_object", schema: JSON.stringify(CLAIM_RESPONSE_SCHEMA) },
      extra_body: { enable_thinking: false },
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    const { envelope, claims } = parseModelResponse(raw);
    if (claims.length === 0) {
      // A well-formed but empty answer is abstention, not a broken contract.
      if (envelope) fail(request.id, "NO_EVIDENCE", "모델이 근거로 뒷받침할 수 있는 항목을 찾지 못했습니다.");
      else fail(request.id, "INVALID_OUTPUT", "모델이 근거를 인용한 항목을 만들지 못했습니다.");
      return;
    }
    post({ id: request.id, kind: "claims", claims });
  })().catch((error: unknown) => {
    const { code, message } = classify(error, "Inference");
    fail(request.id, code === "MODEL_LOAD_FAILED" && engine ? "INFERENCE_FAILED" : code, message);
  }).finally(() => {
    generating = false;
  });
});
