import { describe, expect, it } from "vitest";
import { SUPPLEMENT_EVAL_CASES } from "./eval/supplement-cases";
import { FAILURE_SEVERITY, formatSummary, runSupplementCase, summarize, type EvalOutcome } from "./eval/supplement-harness";

/**
 * 보완 quality gate on the fixed case set, without the model: the model can
 * only cancel candidates, so this run shows the deterministic pipeline's
 * worst case. Meaning-dependent cases are checked for critical failures only.
 * `bun scripts/supplement-eval.ts` runs the same set with the live model.
 */
describe("보완 eval (deterministic)", () => {
  it("has no critical failure and holds precision on the fixed set", async () => {
    const outcomes: EvalOutcome[] = [];
    for (const entry of SUPPLEMENT_EVAL_CASES) outcomes.push(await runSupplementCase(entry));
    const summary = summarize(outcomes);
    console.info(formatSummary("보완 eval (deterministic)", summary));
    const critical = summary.failures.filter((failure) => FAILURE_SEVERITY[failure.kind] === "critical");
    expect(critical).toEqual([]);
    expect(summary.byKind["false-positive"]).toBe(0);
    expect(summary.byKind.duplicate).toBe(0);
    expect(summary.recall).toBeGreaterThanOrEqual(95);
    expect(summary.failed).toBe(0);
  }, 120_000);
});
