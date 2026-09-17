import { describe, expect, it } from "vitest";
import { prebuiltAppConfig } from "@mlc-ai/web-llm";
import nextConfig from "../next.config";
import { securityHeaders } from "@/config/security-headers";
import { noReferrerFetch } from "@/client/no-referrer-fetch";
import {
  BROWSER_AI_BASELINE_MODEL_ID,
  BROWSER_AI_MODELS,
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
  it("ships only models the installed runtime can serve", () => {
    for (const profile of Object.values(BROWSER_AI_MODELS)) {
      const entry = modelEntry(profile.id);
      expect(entry, profile.id).toBeDefined();
      expect(entry?.model).toContain(profile.id);
    }
  });

  it("keeps the A/B baseline resolvable", () => {
    expect(modelEntry(BROWSER_AI_BASELINE_MODEL_ID)).toBeDefined();
  });

  it("states each model's working set as the runtime reports it", () => {
    // The memory figures decide which model a device may load, so a WebLLM
    // upgrade that moves them has to fail here rather than on a user's machine.
    for (const profile of Object.values(BROWSER_AI_MODELS)) {
      const vram = modelEntry(profile.id)?.vram_required_MB ?? 0;
      expect(vram, profile.id).toBeGreaterThan(0);
      expect(Math.abs(profile.vramRequiredMb - vram), profile.id).toBeLessThan(2);
      // Weights dominate the download; device memory adds runtime buffers on top.
      expect(profile.downloadMb, profile.id).toBeLessThan(vram);
      expect(profile.downloadMb, profile.id).toBeGreaterThan(vram / 2);
    }
  });

  it("keeps the light model smaller than the standard one", () => {
    // The fallback only helps if it actually asks for less memory.
    expect(BROWSER_AI_MODELS.light.vramRequiredMb).toBeLessThan(BROWSER_AI_MODELS.standard.vramRequiredMb);
    expect(BROWSER_AI_MODELS.light.downloadMb).toBeLessThan(BROWSER_AI_MODELS.standard.downloadMb);
  });

  it("loads each model with a context the runtime supports", () => {
    // WebLLM validates `context_window_size` against the model library, and
    // the prebuilt record states what that library was built for.
    for (const profile of Object.values(BROWSER_AI_MODELS)) {
      const prebuilt = modelEntry(profile.id)?.overrides?.context_window_size ?? 0;
      expect(prebuilt, profile.id).toBeGreaterThan(0);
      expect(profile.contextWindowSize, profile.id).toBeLessThanOrEqual(prebuilt);
    }
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
    for (const id of [...Object.values(BROWSER_AI_MODELS).map((profile) => profile.id), BROWSER_AI_BASELINE_MODEL_ID]) {
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

  it("applies the policy to the application page itself", async () => {
    const rules = await nextConfig.headers?.() ?? [];
    // The Cloudflare runtime does not match "/" against "/:path*", so the page
    // that loads both workers went out with no security header at all.
    const root = rules.find((rule) => rule.source === "/");
    expect(root?.headers.map((entry) => entry.key)).toContain("Content-Security-Policy");
  });

  it("sends no referrer, which the model host requires", async () => {
    // huggingface.co answers 404 to a request carrying a Referer, and a 404
    // has no Access-Control-Allow-Origin, so the browser reports a CORS
    // failure and no weight is ever downloaded. Both the page and the asset
    // responses that serve the workers must carry this.
    for (const headers of [(await nextConfig.headers?.() ?? []).flatMap((rule) => rule.headers), securityHeaders(false)]) {
      expect(headers).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
    }
  });
});

describe("browser AI model requests", () => {
  it("drops the referrer the model host rejects, whatever the caller asks for", async () => {
    const seen: RequestInit[] = [];
    const base = ((_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;

    const pinned = noReferrerFetch(base);
    await pinned("https://huggingface.co/mlc-ai/model/resolve/main/mlc-chat-config.json");
    await pinned("https://huggingface.co/mlc-ai/model/resolve/main/params_shard_0.bin", {
      headers: { Range: "bytes=0-1" },
      referrerPolicy: "strict-origin-when-cross-origin",
    });

    expect(seen.map((init) => init.referrerPolicy)).toEqual(["no-referrer", "no-referrer"]);
    // The caller's own request options survive.
    expect(seen[1]?.headers).toEqual({ Range: "bytes=0-1" });
  });
});
