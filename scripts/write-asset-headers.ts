import { writeFile } from "node:fs/promises";
import path from "node:path";
import { securityHeaders } from "../src/config/security-headers";

/**
 * Cloudflare serves `dist/client` through the asset binding, which never runs
 * `next.config.ts` headers. Without this file the browser AI worker script
 * arrived with no `Referrer-Policy`, so the worker used the default policy,
 * sent `Referer` to huggingface.co and got a 404 on every model request.
 *
 * `_headers` is read by Workers Assets from the root of the asset directory.
 */
const target = path.join(process.cwd(), "dist", "client", "_headers");
const rules = securityHeaders(false)
  .map((header) => `  ${header.key}: ${header.value}`)
  .join("\n");

await writeFile(target, `/*\n${rules}\n`, "utf8");
console.info(`[worklens] wrote ${path.relative(process.cwd(), target)}`);
