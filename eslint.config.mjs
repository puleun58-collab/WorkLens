import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    ".worklens/**",
    "next-env.d.ts",
    // Vendored pdfjs worker copied into public/ by `bun run assets:pdf`.
    "public/pdf.worker.mjs",
  ]),
  {
    // Playwright fixtures hand control to the test through a `use` callback.
    // It has nothing to do with React, and the hook rules only see the name.
    files: ["tests/e2e/**/*.ts"],
    rules: { "react-hooks/rules-of-hooks": "off" },
  },
]);

export default eslintConfig;
