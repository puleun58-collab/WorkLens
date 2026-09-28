import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testMatch: ["polish-benchmark.spec.ts"],
  timeout: 180_000,
  projects: [{ name: "chromium-desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  reporter: "list",
});
