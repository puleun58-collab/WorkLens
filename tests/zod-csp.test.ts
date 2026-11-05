import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("CSP-safe AX schema initialization", () => {
  // Dynamic imports intentionally exercise fresh module-loading boundaries:
  // static imports would initialize the schemas before the CSP probe spy.
  it.each([
    "@/lib/ax/grounding-schema",
    "@/lib/ax/schema",
    "@/client/server-ai-client",
  ])("initializes %s without probing Function", async entry => {
    vi.resetModules();
    const { z } = await import("zod");
    z.config({ jitless: false });
    const dynamicFunction = vi.spyOn(globalThis, "Function").mockImplementation(() => {
      throw new EvalError("Production CSP forbids dynamic code");
    });
    await import(entry);
    expect(dynamicFunction).not.toHaveBeenCalled();
    expect(z.config().jitless).toBe(true);
  });

  it("keeps strict source-quote validation and normalization", async () => {
    const { axGroundingSchema } = await import("@/lib/ax/grounding-schema");
    const fact = { field: "inputs", source: "description", quote: "  입력 표  " };
    expect(axGroundingSchema.parse({ facts: [fact], conflicts: [] }).facts[0].quote).toBe("입력 표");
    expect(axGroundingSchema.safeParse({ facts: [{ ...fact, field: "unknown" }], conflicts: [] }).success).toBe(false);
    expect(axGroundingSchema.safeParse({ facts: [{ ...fact, quote: " " }], conflicts: [] }).success).toBe(false);
    expect(axGroundingSchema.safeParse({ facts: [fact], conflicts: [], unexpected: true }).success).toBe(false);
  });
});
