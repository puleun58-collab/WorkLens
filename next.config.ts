import path from "node:path";
import type { NextConfig } from "next";

const isCloudflareBuild = (process.env.npm_lifecycle_event ?? "").includes("vinext")
  || process.env.npm_lifecycle_event === "deploy"
  || process.env.VINEXT === "1";

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
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
