import { describe, expect, it } from "vitest";
import { liveGate } from "../scripts/document-review-live";
import { reviewFileFor } from "../src/lib/law-review-source";
import { DEVELOPMENT_CASES } from "./eval/document-review-cases";
import { EMPTY_REVIEW, hasQualityFailure, qualityFailures, scoreCase, summarize, type QualityFailureCounts } from "./eval/document-review-harness";

describe("document review live gate", () => {
  it("passes only a complete run without quality or infrastructure failures", () => {
    const summary = summarize([]);
    summary.cases = 2;
    summary.tp = 3;
    summary.gold = 3;
    expect(liveGate(summary, 2, 2)).toBe(0);
    expect(hasQualityFailure(summary)).toBe(false);
  });

  it.each<keyof QualityFailureCounts>([
    "fp", "fn", "wrongLawLinks", "wrongPrecedentLinks", "unsupportedClaims", "coverageErrors",
    "duplicates", "overSuggestions", "wrongLocations", "evidenceFailures",
  ])("fails quality for an isolated %s without depending on FP/FN", (counter) => {
    const summary = summarize([]);
    summary[counter] = 1;
    expect(liveGate(summary, 1, 1)).toBe(1);
    expect(hasQualityFailure(summary)).toBe(true);
    expect(qualityFailures(summary)[counter]).toBe(1);
  });

  it("treats source failure as unscorable, not quality", () => {
    const summary = summarize([]);
    summary.sourceFailures = 1;
    expect(hasQualityFailure(summary)).toBe(false);
    expect(liveGate(summary, 1, 1)).toBe(2);
  });

  it("does not pass an incomplete run even when completed cases are clean", () => {
    expect(liveGate(summarize([]), 2, 1)).toBe(2);
    expect(liveGate(summarize([]), 2, 0)).toBe(2);
  });

  it("keeps infrastructure failures unscorable even when quality also fails", () => {
    const summary = summarize([]);
    summary.evidenceFailures = 1;
    expect(liveGate(summary, 1, 1, 1)).toBe(2);
    expect(liveGate(summary, 2, 1)).toBe(2);
    summary.sourceFailures = 1;
    expect(liveGate(summary, 1, 1)).toBe(2);
  });

  it("counts FN once rather than counting its selector/review causes again", () => {
    const summary = summarize([]);
    summary.fn = 3;
    summary.selectorFn = 1;
    summary.reviewFn = 2;
    const failures = qualityFailures(summary);
    expect(Object.values(failures).reduce((sum, count) => sum + count, 0)).toBe(3);
    expect(failures).not.toHaveProperty("selectorFn");
    expect(failures).not.toHaveProperty("reviewFn");
    expect(failures).not.toHaveProperty("sourceFailures");
  });

  it("decomposes missed findings into selector and review FN", () => {
    const test = DEVELOPMENT_CASES[0];
    const file = reviewFileFor(test.document, `${test.id}.${test.kind}`);
    const reviewed = scoreCase(test, file, EMPTY_REVIEW);
    expect(reviewed).toMatchObject({ fn: 1, selectorFn: 0, reviewFn: 1 });
    const unsent = scoreCase(test, { ...file, document: { ...file.document, segments: [] } }, EMPTY_REVIEW);
    expect(unsent).toMatchObject({ fn: 1, selectorFn: 1, reviewFn: 0 });
    for (const row of [reviewed, unsent]) expect(row.fn).toBe(row.selectorFn + row.reviewFn);
  });
});
