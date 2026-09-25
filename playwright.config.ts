import { defineConfig, devices } from "@playwright/test";

const PORT = 3311;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: ["worklens.spec.ts", "tools.spec.ts", "aggregation.spec.ts", "analysis.spec.ts", "analysis-matrix.spec.ts"],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "artifacts/e2e-report.json" }]],
  outputDir: "artifacts/e2e",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "chromium-tablet", use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: `bunx next start --port ${PORT} --hostname 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: "production",
      WORKLENS_ORIGIN: `http://127.0.0.1:${PORT}`,
    },
  },
});
