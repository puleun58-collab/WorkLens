import { describe, expect, it } from "vitest";
import { DEVELOPMENT_CASES } from "./document-review-cases";
import { HOLDOUT_CASES } from "./document-review-holdout";
import { evalRun, evaluateCase, summarize } from "./document-review-harness";

describe("document-review protected holdout", () => {
  it("measures eleven unseen gold cases, selector included, without importing or comparing the development baseline", async () => {
    expect(HOLDOUT_CASES).toHaveLength(11);
    expect(new Set(HOLDOUT_CASES.map((test) => test.id)).size).toBe(HOLDOUT_CASES.length);
    const rows = await Promise.all(HOLDOUT_CASES.map((test) => evaluateCase(test)));
    const summary = summarize(rows);
    console.log(JSON.stringify({ run: evalRun("holdout", "deterministic", { development: DEVELOPMENT_CASES.length, holdout: HOLDOUT_CASES.length }, "none (holdout is never baselined)"),
      summary, deviations: rows.filter((row) => row.fp || row.fn || row.selectorFn || row.coverageErrors || row.wrongLawLinks || row.wrongPrecedentLinks || row.unsupportedClaims || row.wrongLocations || row.duplicates || row.overSuggestions) }, null, 2));
    expect(summary.tp + summary.fn).toBe(HOLDOUT_CASES.reduce((sum, test) => sum + test.gold.length, 0));
    expect(summary.selectorFn).toBe(0);
    expect(summary.fp).toBe(0);
    expect(summary.fn).toBe(0);
    expect(summary.wrongLocations).toBe(0);
    expect(summary.duplicates).toBe(0);
    expect(summary.coverageErrors).toBe(0);
    expect(summary.unsupportedClaims).toBe(0);
    expect(summary.wrongLawLinks).toBe(0);
    expect(summary.wrongPrecedentLinks).toBe(0);
    expect(summary.overSuggestions).toBe(0);
    for (const row of rows) expect(row.payloadChars, row.id).toBeLessThanOrEqual(100_000);
  }, 120_000);
});
