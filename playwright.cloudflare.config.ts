import { defineConfig, devices } from "@playwright/test";

const PORT = 8788;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: ["cloudflare.spec.ts"],
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: "artifacts/e2e-cloudflare",
  reporter: [["list"], ["json", { outputFile: "artifacts/e2e-cloudflare-report.json" }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: "chromium-cloudflare", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: `bunx wrangler dev --config dist/server/wrangler.json --port ${PORT} --ip 127.0.0.1 --local`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
