import path from "node:path";
import type { NextConfig } from "next";
import { securityHeaders } from "./src/config/security-headers";

const isCloudflareBuild = (process.env.npm_lifecycle_event ?? "").includes("vinext")
  || process.env.npm_lifecycle_event === "deploy"
  || process.env.VINEXT === "1";

const isDevelopment = process.env.NODE_ENV !== "production";

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
    const security = securityHeaders(isDevelopment);
    // `/:path*` alone leaves the root uncovered on the Cloudflare runtime, which
    // served the application page itself without a single security header.
    return [{ source: "/", headers: security }, { source: "/:path*", headers: security }];
  },
};

export default nextConfig;
