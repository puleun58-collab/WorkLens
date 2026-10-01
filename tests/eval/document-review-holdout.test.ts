import { describe, expect, it } from "vitest";
import { HOLDOUT_CASES } from "./document-review-holdout";
import { evaluateCase, summarize } from "./document-review-harness";

describe("document-review protected holdout", () => {
  it("measures seven unseen gold cases without importing or comparing development baseline", async () => {
    expect(HOLDOUT_CASES).toHaveLength(7);
    expect(new Set(HOLDOUT_CASES.map((test) => test.id)).size).toBe(HOLDOUT_CASES.length);
    const rows = await Promise.all(HOLDOUT_CASES.map((test) => evaluateCase(test)));
    const summary = summarize(rows);
    console.log(JSON.stringify({ set: "holdout", summary, deviations: rows.filter((row) => row.fp || row.fn || row.coverageErrors || row.wrongLawLinks || row.wrongPrecedentLinks || row.unsupportedClaims || row.wrongLocations || row.duplicates || row.overSuggestions) }, null, 2));
    expect(summary.tp + summary.fn).toBe(HOLDOUT_CASES.reduce((sum, test) => sum + test.gold.length, 0));
    expect(summary.fp).toBe(0);
    expect(summary.fn).toBe(0);
    expect(summary.wrongLocations).toBe(0);
    expect(summary.duplicates).toBe(0);
    expect(summary.coverageErrors).toBe(0);
    expect(summary.unsupportedClaims).toBe(0);
    expect(summary.wrongLawLinks).toBe(0);
    expect(summary.wrongPrecedentLinks).toBe(0);
    expect(summary.overSuggestions).toBe(0);
  });
});
