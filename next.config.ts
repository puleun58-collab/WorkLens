import path from "node:path";
import type { NextConfig } from "next";

const isCloudflareBuild = (process.env.npm_lifecycle_event ?? "").includes("vinext")
  || process.env.npm_lifecycle_event === "deploy"
  || process.env.VINEXT === "1";

const isDevelopment = process.env.NODE_ENV !== "production";

/**
 * Hosts WebLLM downloads from: `mlc-chat-config.json`, tokenizer and weight
 * shards live on Hugging Face (`resolve` redirects to the LFS/Xet CDNs, and a
 * redirect target is matched against this policy too), the compiled WebGPU
 * runtime library (`model_lib`) on raw.githubusercontent.com.
 */
const MODEL_HOSTS = [
  "https://huggingface.co",
  "https://*.huggingface.co",
  "https://*.hf.co",
  "https://raw.githubusercontent.com",
];

/**
 * `'wasm-unsafe-eval'` is required: the browser AI worker compiles the MLC
 * WebGPU runtime with `WebAssembly.instantiate`, which a policy without it
 * rejects — every model load then failed before it started. It permits
 * WebAssembly only, not JavaScript `eval`.
 *
 * `'unsafe-eval'` and the HMR socket are development-only: the Next dev
 * runtime evaluates chunks with `eval`, which also kills the module workers.
 */
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  // Both workers are bundled same-origin scripts; WebLLM never builds one from a blob.
  "worker-src 'self'",
  `connect-src 'self' ${MODEL_HOSTS.join(" ")}${isDevelopment ? " ws: http://127.0.0.1:* http://localhost:*" : ""}`,
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  // The Cloudflare build resolves "cloudflare:workers" natively; plain Node
  // builds (next dev/build/start) get a process-env stub instead.
  turbopack: {
    root: path.resolve("."),
    ...(isCloudflareBuild ? {} : { resolveAlias: { "cloudflare:workers": "./src/server/cf-env-node.ts" } }),
  },
  // Parsing and export now run in the browser worker; no server bundling opt-out needed.
  poweredByHeader: false,
  async headers() {
    const security = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Content-Security-Policy", value: CSP },
    ];
    // `/:path*` alone leaves the root uncovered on the Cloudflare runtime, which
    // served the application page itself without a single security header.
    return [{ source: "/", headers: security }, { source: "/:path*", headers: security }];
  },
};

export default nextConfig;
