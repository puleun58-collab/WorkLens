import { describe, expect, it } from "vitest";
import { resolveBrowserAiModel } from "@/client/browser-ai-capability";
import { BROWSER_AI_MODELS } from "@/client/browser-ai-protocol";

/**
 * The decision this covers is the one that cannot be retried: on an 8 GB
 * machine loading the standard model freezes the desktop, so the tier has to
 * be settled from up-front signals, never after an allocation failure.
 */
describe("browser AI model resolution", () => {
  it("refuses the standard model on a device that reports too little memory", () => {
    const decision = resolveBrowserAiModel({ deviceMemoryGb: 4 });
    expect(decision.profile).toBe(BROWSER_AI_MODELS.light);
    expect(decision.standardBlocked).toBe(true);
  });

  it("keeps refusing it even when the operator asks for it", () => {
    // A preference is an answer about headroom, not permission to freeze a
    // machine whose own report rules the model out.
    const decision = resolveBrowserAiModel({ deviceMemoryGb: 2 }, "standard");
    expect(decision.profile).toBe(BROWSER_AI_MODELS.light);
    expect(decision.source).toBe("signals");
  });

  it("does not even offer the standard model on an 8 GiB device", () => {
    // 8 GiB is the case that froze a desktop: the standard model reserves
    // ~3.9 GB of shared memory, so it is refused and not offered as a choice.
    const decision = resolveBrowserAiModel({ deviceMemoryGb: 8 });
    expect(decision.profile).toBe(BROWSER_AI_MODELS.light);
    expect(decision.standardBlocked).toBe(true);
  });

  it("keeps the standard model on a device that reports headroom above the clamp", () => {
    const decision = resolveBrowserAiModel({ deviceMemoryGb: 16, maxBufferSize: 2 ** 31 });
    expect(decision.profile).toBe(BROWSER_AI_MODELS.standard);
    expect(decision.source).toBe("signals");
  });

  it("chooses the smaller model when the browser reports nothing", () => {
    expect(resolveBrowserAiModel({}).profile).toBe(BROWSER_AI_MODELS.light);
  });

  it("refuses the standard model when the adapter cannot bind its weights", () => {
    const decision = resolveBrowserAiModel({ deviceMemoryGb: 8, maxStorageBufferBindingSize: 64 * 1024 * 1024 }, "standard");
    expect(decision.profile).toBe(BROWSER_AI_MODELS.light);
    expect(decision.standardBlocked).toBe(true);
  });

  it("keeps the context window small enough that the KV cache is not the problem", () => {
    // The evidence window the document worker builds is 40 items / 5,000
    // characters, so a 2,048-token context is the working size, not a guess.
    for (const profile of Object.values(BROWSER_AI_MODELS)) {
      expect(profile.contextWindowSize).toBeLessThanOrEqual(2_048);
    }
  });
});
