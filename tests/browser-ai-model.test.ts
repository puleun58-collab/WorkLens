import { describe, expect, it } from "vitest";
import { prebuiltAppConfig } from "@mlc-ai/web-llm";
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
