import { describe, expect, it } from "vitest";
import { formatLawDate, LAW_FALLBACK_ERROR, lawOutcome, lawStatusTone } from "@/lib/law-search";

describe("law search outcome", () => {
  const law = { name: "근로기준법", lawId: "001872", mst: "283457", status: "현행" };

  it("keeps identifiers of found laws for the later text lookup", () => {
    expect(lawOutcome(true, { data: { found: true, laws: [law] } })).toEqual({ kind: "found", laws: [law] });
  });

  it("treats only an explicit found:false as no result", () => {
    expect(lawOutcome(true, { data: { found: false, marker: "NOT_FOUND" } })).toEqual({ kind: "empty" });
  });

  it("never reports an outage as no result", () => {
    expect(lawOutcome(false, { error: { code: "LAW_RATE_LIMITED", message: "요청이 많습니다." } })).toEqual({ kind: "error", message: "요청이 많습니다." });
    expect(lawOutcome(false, null)).toEqual({ kind: "error", message: LAW_FALLBACK_ERROR });
    expect(lawOutcome(false, { error: { message: 42 } })).toEqual({ kind: "error", message: LAW_FALLBACK_ERROR });
    // A success that claims results but lists none is malformed, not empty.
    expect(lawOutcome(true, { data: { found: true, laws: [] } })).toEqual({ kind: "error", message: LAW_FALLBACK_ERROR });
  });

  it("formats compact dates and leaves other shapes untouched", () => {
    expect(formatLawDate("20260820")).toBe("2026.08.20");
    expect(formatLawDate("2026-08-20")).toBe("2026-08-20");
    expect(formatLawDate(undefined)).toBeUndefined();
  });

  it("maps statuses to tones without inventing one", () => {
    expect(lawStatusTone("현행")).toBe("current");
    expect(lawStatusTone("시행예정")).toBe("upcoming");
    expect(lawStatusTone("폐지")).toBe("muted");
    expect(lawStatusTone(undefined)).toBeUndefined();
  });
});
