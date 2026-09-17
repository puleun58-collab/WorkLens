import { readdirSync } from "node:fs";
import { chromium } from "@playwright/test";

/**
 * Real-WebGPU engine check, run by hand on a machine with an adapter.
 *
 *   bun scripts/ai-engine-check.ts            # small model, then the shipped one
 *   MODELS=Qwen2.5-0.5B-Instruct-q4f16_1-MLC bun scripts/ai-engine-check.ts
 *
 * It drives the application's own AI worker, so what is exercised is the
 * shipped runtime path: worker evaluation, WebGPU device, WASM library, model
 * download and cache, engine creation and one inference.
 */
const port = process.env.PORT ?? "3013";
const workerFile = readdirSync("dist/client/_next/static/workers").find((name) => name.startsWith("browser-ai-worker"));
if (!workerFile) throw new Error("worker bundle not found; run `bun run build:vinext` first");
const workerUrl = `/_next/static/workers/${workerFile}`;
const models = (process.env.MODELS ?? "Qwen2.5-0.5B-Instruct-q4f16_1-MLC,Qwen3.5-4B-q4f16_1-MLC").split(",");

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
page.on("console", (message) => {
  const text = message.text();
  if (text.startsWith("[AI]")) console.info("  ", text.slice(0, 200));
});
await page.goto(`http://127.0.0.1:${port}/`);

for (const modelId of models) {
  for (const attempt of ["first", "cached"] as const) {
    const started = Date.now();
    const result = await page.evaluate(async ({ url, model }) => {
      const worker = new Worker(url, { type: "module" });
      const outcome = await new Promise<Record<string, unknown>>((resolve) => {
        const failure = (reason: string) => resolve({ ok: false, reason });
        worker.addEventListener("error", (event) => failure(`worker error: ${event.message}`));
        let lastProgress = "";
        worker.addEventListener("message", (event) => {
          const message = event.data as { kind: string; text?: string; code?: string; message?: string; proposal?: unknown };
          if (message.kind === "progress") {
            lastProgress = message.text ?? "";
            return;
          }
          if (message.kind === "error") {
            failure(`${message.code}: ${message.message}`);
            return;
          }
          if (message.kind === "ready") {
            worker.postMessage({ id: "infer", kind: "polish", modelId: model, text: "이번 보고는 관련 부서와의 협의를 통해 진행하고자 합니다.", mode: "default" });
            return;
          }
          if (message.kind === "polish") {
            resolve({ ok: true, lastProgress, proposal: message.proposal });
          }
        });
        worker.postMessage({ id: "load", kind: "load", modelId: model });
        setTimeout(() => failure("timeout"), 25 * 60_000);
      });
      worker.terminate();
      return outcome;
    }, { url: workerUrl, model: modelId });
    console.info(modelId, attempt, `${Math.round((Date.now() - started) / 1000)}s`, JSON.stringify(result).slice(0, 320));
    if (!result.ok) break;
    if (attempt === "first") await page.reload();
  }
}

await browser.close();
