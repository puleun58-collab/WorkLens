import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { securityHeaders } from "../src/config/security-headers";

/**
 * Cloudflare serves `dist/client` through the asset binding, which never runs
 * `next.config.ts` headers. `_headers` keeps static assets on the same policy
 * as worker-rendered responses.
 */
const generatedDevSecrets = path.join(process.cwd(), "dist", "server", ".dev.vars");
await rm(generatedDevSecrets, { force: true });

const target = path.join(process.cwd(), "dist", "client", "_headers");
const rules = securityHeaders(false)
  .map((header) => `  ${header.key}: ${header.value}`)
  .join("\n");

await writeFile(target, `/*\n${rules}\n`, "utf8");
console.info(`[worklens] wrote ${path.relative(process.cwd(), target)}`);
