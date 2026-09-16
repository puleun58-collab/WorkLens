import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-AI quality evaluation. Separate from the smoke run on purpose: the
 * smoke run answers "does the AI path work end to end", this one answers "how
 * good are the answers", scores a fixed case set deterministically and writes
 * `artifacts/ai-eval-<model>.json`.
 *
 * It needs the same real WebGPU adapter and model download, so it is never in
 * the blocking CI matrix.
 *
 *   bun run test:eval:ai                        # shipped model (Qwen3 1.7B)
 *   WORKLENS_AI_MODEL=Qwen2.5-1.5B-Instruct-q4f16_1-MLC bun run test:eval:ai
 *   WORKLENS_AI_EVAL_URL=https://… bun run test:eval:ai      # against a deployment
 */
const PORT = 3322;
const externalUrl = process.env.WORKLENS_AI_EVAL_URL;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: ["ai-eval.spec.ts"],
  // One cold download plus one generation per case on an integrated GPU.
  timeout: 60 * 60_000,
  expect: { timeout: 10 * 60_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: externalUrl ?? `http://127.0.0.1:${PORT}`,
    trace: "off",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
    },
  },
  ...(externalUrl ? {} : {
    webServer: {
      command: `bunx next start --port ${PORT} --hostname 127.0.0.1`,
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { NODE_ENV: "production", WORKLENS_ORIGIN: `http://127.0.0.1:${PORT}` },
    },
  }),
});
