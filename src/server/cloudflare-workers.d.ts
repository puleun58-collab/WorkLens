/**
 * Ambient declaration for the Workers-only module. Under Node, Turbopack
 * aliases the specifier to `src/server/cf-env-node.ts`.
 */
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
