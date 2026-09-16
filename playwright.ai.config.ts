import { defineConfig, devices } from "@playwright/test";

/**
 * Optional browser-AI smoke run. It downloads a ~990 MB model and needs a real
 * WebGPU adapter, so it is never part of the default CI matrix — the
 * deterministic suites in `playwright.config.ts` stay the blocking ones.
 *
 *   bun run test:ai:smoke                       # local Chrome/Edge with WebGPU
 *   WORKLENS_AI_SMOKE_URL=https://… bun run test:ai:smoke   # against a deployment
 *   WORKLENS_AI_MODEL=Qwen2.5-1.5B-Instruct-q4f16_1-MLC bun run test:ai:smoke  # A/B baseline
 */
const PORT = 3321;
const externalUrl = process.env.WORKLENS_AI_SMOKE_URL;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: ["ai-smoke.spec.ts"],
  // A cold model download plus two generations on an integrated GPU is slow.
  timeout: 15 * 60_000,
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
