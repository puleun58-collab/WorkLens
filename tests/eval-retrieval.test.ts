import { describe, expect, it } from "vitest";
import { EVAL_CASES } from "./eval/cases";
import { percentage, runRetrieval } from "./eval/harness";

/**
 * Retrieval evaluation.
 *
 * Measures whether the evidence that actually answers each question reaches
 * the prompt window, independent of any model. When Ask quality regresses this
 * is the first place to look: a Recall drop is a retrieval problem, a stable
 * Recall with bad answers is a generation problem.
 */
const answerable = EVAL_CASES.filter((entry) => !entry.refuse);
const unanswerable = EVAL_CASES.filter((entry) => entry.refuse);

describe("retrieval eval", () => {
  it("keeps every answerable case reachable in the evidence index", async () => {
    const missing: string[] = [];
    for (const entry of answerable) {
      const outcome = await runRetrieval(entry);
      if (!outcome.present) missing.push(entry.id);
    }
    // A missing case means the fixture or the expectation is wrong, not the ranker.
    expect(missing).toEqual([]);
  });

  it("reports Recall@5, Recall@10 and Recall@20 over the fixed case set", async () => {
    const hits: Record<number, number> = { 5: 0, 10: 0, 20: 0 };
    const missed: string[] = [];
    for (const entry of answerable) {
      for (const limit of [5, 10, 20]) {
        const outcome = await runRetrieval(entry, limit);
        if (outcome.hit) hits[limit] += 1;
        else if (limit === 20) missed.push(entry.id);
      }
    }
    const summary = {
      cases: answerable.length,
      "recall@5": percentage(hits[5], answerable.length),
      "recall@10": percentage(hits[10], answerable.length),
      "recall@20": percentage(hits[20], answerable.length),
      missed,
    };
    console.info("retrieval eval", summary);
    expect(summary["recall@20"]).toBeGreaterThanOrEqual(95);
    expect(summary["recall@10"]).toBeGreaterThanOrEqual(90);
    expect(summary["recall@5"]).toBeGreaterThanOrEqual(80);
  });

  it("does not surface evidence for questions the documents cannot answer", async () => {
    const leaked: string[] = [];
    for (const entry of unanswerable) {
      const outcome = await runRetrieval(entry);
      if (outcome.present) leaked.push(entry.id);
    }
    console.info("unanswerable eval", { cases: unanswerable.length, leaked });
    expect(leaked).toEqual([]);
  });
});
