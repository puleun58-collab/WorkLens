import { describe, expect, it } from "vitest";
import { prebuiltAppConfig } from "@mlc-ai/web-llm";
import nextConfig from "../next.config";
import {
  BROWSER_AI_BASELINE_MODEL_ID,
  BROWSER_AI_MODEL_ID,
  BROWSER_AI_MODEL_LABEL,
  BROWSER_AI_MODEL_MB,
} from "@/client/browser-ai-protocol";

/**
 * A wrong model id only fails inside a real browser, after a download attempt.
 * This pins the shipped id and its A/B baseline to the ids the installed
 * WebLLM build can actually serve, and keeps the advertised download size in
 * the same order of magnitude as the model the runtime reports.
 */
function modelEntry(id: string) {
  return prebuiltAppConfig.model_list.find((entry) => entry.model_id === id);
}

describe("browser AI model selection", () => {
  it("ships a model the installed runtime can serve", () => {
    const entry = modelEntry(BROWSER_AI_MODEL_ID);
    expect(entry, BROWSER_AI_MODEL_ID).toBeDefined();
    expect(entry?.model).toContain(BROWSER_AI_MODEL_ID);
  });

  it("keeps the A/B baseline resolvable", () => {
    expect(modelEntry(BROWSER_AI_BASELINE_MODEL_ID)).toBeDefined();
  });

  it("advertises a download size that matches the model's footprint", () => {
    const vram = modelEntry(BROWSER_AI_MODEL_ID)?.vram_required_MB ?? 0;
    expect(vram).toBeGreaterThan(0);
    // Weights dominate the download; device memory adds runtime buffers on top.
    expect(BROWSER_AI_MODEL_MB).toBeLessThan(vram);
    expect(BROWSER_AI_MODEL_MB).toBeGreaterThan(vram / 2);
  });

  it("names the model the way the runtime id reads", () => {
    expect(BROWSER_AI_MODEL_ID.startsWith(BROWSER_AI_MODEL_LABEL.replace(" ", "-"))).toBe(true);
  });
});

/**
 * The response policy is what the browser enforces on the AI worker, and a
 * policy that forbids WebAssembly compilation or the model hosts made every
 * model load fail before it started — on every machine, from the first run,
 * with WebGPU fully working. These assertions read the shipped headers.
 */
async function contentSecurityPolicy(): Promise<Record<string, string[]>> {
  const rules = await nextConfig.headers?.() ?? [];
  const header = rules
    .flatMap((rule) => rule.headers)
    .find((entry) => entry.key === "Content-Security-Policy");
  expect(header, "Content-Security-Policy header").toBeDefined();
  const directives: Record<string, string[]> = {};
  for (const directive of (header?.value ?? "").split(";")) {
    const [name, ...values] = directive.trim().split(/\s+/);
    if (name) directives[name] = values;
  }
  return directives;
}

/** CSP source matching for the host forms this policy uses. */
function allows(sources: string[], url: string): boolean {
  const { origin, host, protocol } = new URL(url);
  return sources.some((source) => {
    if (source === origin) return true;
    const [sourceProtocol, sourceHost] = source.split("://");
    if (!sourceHost || `${sourceProtocol}:` !== protocol) return false;
    return sourceHost.startsWith("*.")
      ? host === sourceHost.slice(2) || host.endsWith(sourceHost.slice(1))
      : host === sourceHost;
  });
}

describe("browser AI content security policy", () => {
  it("permits the WebAssembly compilation the MLC runtime needs", async () => {
    const directives = await contentSecurityPolicy();
    expect(directives["script-src"]).toContain("'wasm-unsafe-eval'");
  });

  it("permits the hosts the shipped model is downloaded from", async () => {
    const connect = (await contentSecurityPolicy())["connect-src"] ?? [];
    for (const id of [BROWSER_AI_MODEL_ID, BROWSER_AI_BASELINE_MODEL_ID]) {
      const entry = modelEntry(id);
      expect(entry, id).toBeDefined();
      // Weights and the compiled WebGPU library live on different hosts.
      expect(allows(connect, entry?.model ?? ""), `${id} weights`).toBe(true);
      expect(allows(connect, entry?.model_lib ?? ""), `${id} model_lib`).toBe(true);
    }
  });

  it("keeps both browser workers same-origin", async () => {
    expect((await contentSecurityPolicy())["worker-src"]).toEqual(["'self'"]);
  });
});
