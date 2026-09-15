/**
 * Node stand-in for the Workers-only `cloudflare:workers` module. Turbopack
 * aliases the specifier here so `next build` and `next start` resolve; the
 * Cloudflare build uses the real module and its bindings.
 */
export const env: Record<string, unknown> = process.env as unknown as Record<string, unknown>;
