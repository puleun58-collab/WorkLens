import { defineConfig, devices } from "@playwright/test";

/*
 * Tier 2 full product regression (`bun run test:regression`): manual /
 * pre-release only, never part of PR CI. Every case records itself through
 * tests/regression/record.ts; scripts/regression-report.ts summarises them.
 */
const PORT = Number(process.env.REGRESSION_PORT ?? 3312);

export default defineConfig({
  testDir: "tests/regression",
  testMatch: /.*\.regression\.ts$/u,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "artifacts/regression/playwright.json" }]],
  outputDir: "artifacts/regression/output",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    acceptDownloads: true,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, hasTouch: true }, grep: /@mobile/u },
  ],
  webServer: {
    command: `bunx next start --port ${PORT} --hostname 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { NODE_ENV: "production", WORKLENS_ORIGIN: `http://127.0.0.1:${PORT}` },
  },
});
