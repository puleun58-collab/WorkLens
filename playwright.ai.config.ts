import { defineConfig, devices } from "@playwright/test";

/**
 * Optional browser-AI runs. Both need a real WebGPU adapter, so neither is
 * part of the default CI matrix — the deterministic suites in
 * `playwright.config.ts` stay the blocking ones.
 *
 * The two runs are separate on purpose: one pays for the model download, the
 * other exercises the features on the model it left in the shared browser
 * profile.
 *
 *   bun run test:ai:model                       # first-run download, then cache reuse
 *   bun run test:ai:smoke                       # features on the cached model
 *   WORKLENS_AI_SMOKE_URL=https://… bun run test:ai:smoke   # against a deployment
 *   WORKLENS_AI_MODEL=Qwen2.5-1.5B-Instruct-q4f16_1-MLC bun run test:ai:smoke  # A/B baseline
 *
 * Model waits are bounded by the specs themselves (`TIMEOUTS` in
 * `tests/e2e/ai-stages.ts`), so the assertion default stays short: a run that
 * cannot prepare a model reports the stage it failed in instead of sitting on
 * a ten-minute assertion.
 */
const PORT = 3321;
const externalUrl = process.env.WORKLENS_AI_SMOKE_URL;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: ["ai-smoke.spec.ts", "ai-model-download.spec.ts"],
  // Per-test ceilings come from each spec's `test.setTimeout`.
  timeout: 30 * 60_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: externalUrl ?? `http://127.0.0.1:${PORT}`,
    // Playwright leaves actions unbounded by default, so a `click` on a
    // control that never appears waits out the whole test instead of failing
    // the stage it belongs to.
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: "off",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
    // Headless Chromium hands out no WebGPU adapter here, and both runs then
    // skip instead of exercising anything, so this config is always headed.
    headless: false,
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
