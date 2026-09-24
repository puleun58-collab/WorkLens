import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // Workers-only module: tests resolve the process-env stub.
      "cloudflare:workers": path.resolve(import.meta.dirname, "src/server/cf-env-node.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    coverage: {
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts"],
      // json-summary for the gate, json for per-line branch diagnosis in the CI artifact.
      reporter: ["text-summary", "json-summary", "json"],
      thresholds: { branches: 58 },
    },
    hookTimeout: 30_000,
  },
});
