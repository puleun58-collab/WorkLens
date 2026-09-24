/**
 * One definition of the response security headers, used by `next.config.ts`
 * for worker-rendered responses and by `scripts/write-asset-headers.ts` for
 * the Cloudflare `_headers` file that covers static assets.
 */
export function contentSecurityPolicy(development: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "worker-src 'self'",
    `connect-src 'self'${development ? " ws: http://127.0.0.1:* http://localhost:*" : ""}`,
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
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "Content-Security-Policy", value: contentSecurityPolicy(development) },
  ];
}
