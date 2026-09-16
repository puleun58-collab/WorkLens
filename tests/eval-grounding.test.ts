import { describe, expect, it } from "vitest";
import { EVAL_CASES } from "./eval/cases";
import { percentage, runGrounding } from "./eval/harness";

/**
 * Grounding evaluation.
 *
 * Checks the contract that protects users from a wrong answer: a claim is only
 * shown when it resolves to canonical evidence in the document, and a claim
 * that invents a value is dropped rather than displayed.
 */
const answerable = EVAL_CASES.filter((entry) => !entry.refuse);
const unanswerable = EVAL_CASES.filter((entry) => entry.refuse);

describe("grounding eval", () => {
  it("resolves supported claims to canonical sources and exact values", async () => {
    const failures: string[] = [];
    let grounded = 0;
    let canonical = 0;
    let valueSupported = 0;
    for (const entry of answerable) {
      const outcome = await runGrounding(entry);
      if (outcome.grounded) grounded += 1;
      if (outcome.sourcesCanonical) canonical += 1;
      if (outcome.valueSupported) valueSupported += 1;
      if (!outcome.grounded || !outcome.valueSupported) failures.push(entry.id);
    }
    const byKind = (kinds: string[]) => {
      const subset = answerable.filter((entry) => kinds.includes(entry.kind));
      return { cases: subset.length, failed: subset.filter((entry) => failures.includes(entry.id)).length };
    };
    console.info("grounding eval", {
      cases: answerable.length,
      groundedPass: percentage(grounded, answerable.length),
      canonicalSources: percentage(canonical, answerable.length),
      valueAccuracy: percentage(valueSupported, answerable.length),
      numeric: byKind(["numeric", "cross-section"]),
      date: byKind(["date"]),
      percentage: byKind(["percentage"]),
      failures,
    });
    expect(percentage(canonical, answerable.length)).toBe(100);
    expect(percentage(grounded, answerable.length)).toBeGreaterThanOrEqual(90);
    expect(percentage(valueSupported, answerable.length)).toBeGreaterThanOrEqual(85);
  });

  it("refuses a fabricated answer when the evidence does not support it", async () => {
    const leaked: string[] = [];
    for (const entry of unanswerable) {
      const outcome = await runGrounding(entry);
      if (!outcome.refused) leaked.push(entry.id);
    }
    console.info("refusal eval", { cases: unanswerable.length, refusal: percentage(unanswerable.length - leaked.length, unanswerable.length), leaked });
    expect(leaked).toEqual([]);
  });
});
