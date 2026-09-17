/**
 * One definition of the response security headers, used by `next.config.ts`
 * for worker-rendered responses and by `scripts/write-asset-headers.ts` for
 * the Cloudflare `_headers` file that covers static assets.
 *
 * Both surfaces need them. A document's policy does not extend into a Web
 * Worker: a worker takes its Content-Security-Policy and its referrer policy
 * from the response that served the worker script. When the browser AI worker
 * was served from Cloudflare's asset binding without these headers it fell
 * back to the default referrer policy, sent `Referer` to huggingface.co, and
 * every model request answered 404 — with no `Access-Control-Allow-Origin` on
 * that error, so the browser reported it as a CORS failure and the model never
 * downloaded.
 */

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
 * `'unsafe-eval'` and the local sockets are development-only: the Next dev
 * runtime evaluates chunks with `eval`, which also kills the module workers.
 */
export function contentSecurityPolicy(development: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    // Both workers are bundled same-origin scripts; WebLLM never builds one from a blob.
    "worker-src 'self'",
    `connect-src 'self' ${MODEL_HOSTS.join(" ")}${development ? " ws: http://127.0.0.1:* http://localhost:*" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

export interface ResponseHeader { key: string; value: string }

export function securityHeaders(development: boolean): ResponseHeader[] {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    // Also the reason the AI worker can reach the model host: Hugging Face
    // answers 404 to a request that carries a Referer.
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "Content-Security-Policy", value: contentSecurityPolicy(development) },
  ];
}
