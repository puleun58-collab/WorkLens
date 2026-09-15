import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: ["smoke.production.spec.ts"],
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: "artifacts/e2e-smoke",
  reporter: [["list"], ["json", { outputFile: "artifacts/e2e-smoke-report.json" }]],
  use: {
    baseURL: process.env.WORKLENS_SMOKE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: "chromium-production", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
});
