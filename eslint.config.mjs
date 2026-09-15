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
]);

export default eslintConfig;
