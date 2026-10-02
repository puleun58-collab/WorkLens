import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reviewFileFor } from "../../src/lib/law-review-source";
import { reviewContract } from "../../src/server/contract-review";
import { DEVELOPMENT_CASES } from "./document-review-cases";
import { HOLDOUT_CASES } from "./document-review-holdout";
import { EVAL_SET_VERSION, evalRun, evaluateCase, scoreCase, summarize, syntheticSources, type EvalSummary } from "./document-review-harness";

const baseline = JSON.parse(readFileSync("tests/eval/document-review-baseline.json", "utf8")) as {
  version: string; set: string; evalSet: string; selector: string; caseIds: string[]; summary: EvalSummary; distributed: EvalSummary;
};
/** Run-dependent fields; everything else in a summary is deterministic. */
const stable = (summary: EvalSummary) => ({ ...summary, positions: undefined });

describe("document-review gold evaluation", () => {
  it("keeps a versioned development-only baseline and distinct gold assertions", () => {
    expect(DEVELOPMENT_CASES).toHaveLength(26);
    const ids = DEVELOPMENT_CASES.map((test) => test.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => HOLDOUT_CASES.some((test) => test.id === id))).toBe(false);
    expect(baseline.version).toBe("document-review-v2");
    expect(baseline.set).toBe("development");
    expect(baseline.evalSet).toBe(EVAL_SET_VERSION);
    expect(baseline.caseIds).toEqual(DEVELOPMENT_CASES.map((test) => test.id));
    for (const test of DEVELOPMENT_CASES) {
      expect(test.document.kind).toBe(test.kind);
      expect(new Set(test.gold.map((item) => `${item.issue}:${item.location}`)).size).toBe(test.gold.length);
    }
  });

  it("measures selector and final findings, links, traps, locations, over-suggestion and coverage against independent gold", async () => {
    const rows = await Promise.all(DEVELOPMENT_CASES.map((test) => evaluateCase(test)));
    const distributedRows = await Promise.all(DEVELOPMENT_CASES.map((test) => evaluateCase(test, syntheticSources, { selection: "distributed" })));
    const summary = summarize(rows);
    const distributed = summarize(distributedRows);
    console.log(JSON.stringify({
      run: evalRun("development", "deterministic", { development: DEVELOPMENT_CASES.length, holdout: HOLDOUT_CASES.length }, baseline.version),
      summary, distributed,
      comparison: DEVELOPMENT_CASES.map((test, index) => ({ id: test.id,
        candidate: { selectorFn: rows[index].selectorFn, fn: rows[index].fn, fp: rows[index].fp, chars: rows[index].payloadChars, segments: rows[index].segments, candidates: rows[index].candidates, ms: rows[index].latencyMs },
        distributed: { selectorFn: distributedRows[index].selectorFn, fn: distributedRows[index].fn, fp: distributedRows[index].fp, chars: distributedRows[index].payloadChars, segments: distributedRows[index].segments, ms: distributedRows[index].latencyMs } }))
        .filter((row) => row.candidate.selectorFn !== row.distributed.selectorFn || row.candidate.fn !== row.distributed.fn || row.candidate.fp !== row.distributed.fp),
      deviations: rows.filter((row) => row.fp || row.fn || row.coverageErrors || row.wrongLawLinks || row.wrongPrecedentLinks || row.unsupportedClaims || row.wrongLocations || row.duplicates || row.overSuggestions),
    }, null, 2));
    expect(stable(summary)).toEqual(stable(baseline.summary));
    expect(stable(distributed)).toEqual(stable(baseline.distributed));
    expect(summary.tp + summary.fn).toBe(DEVELOPMENT_CASES.reduce((sum, test) => sum + test.gold.length, 0));
    // The sampling gap is reproduced by the old selection and closed by the scan, within the same request bound.
    for (const id of ["dev-18-sampling-gap", "dev-19-band-middle", "dev-20-multi-issue", "dev-21-last-tail", "dev-22-repeated-boilerplate"]) {
      expect(distributedRows.find((row) => row.id === id)?.selectorFn, id).toBeGreaterThan(0);
      expect(rows.find((row) => row.id === id), id).toMatchObject({ selectorFn: 0, reviewFn: 0, fn: 0, fp: 0 });
    }
    expect(summary.selectorRecall).toBeGreaterThan(distributed.selectorRecall);
    expect(summary.fp).toBeLessThanOrEqual(distributed.fp);
    for (const row of rows) expect(row.payloadChars, row.id).toBeLessThanOrEqual(100_000);
    expect(rows.find((row) => row.id === "dev-24-candidate-zero")).toMatchObject({ candidates: 0, coverageErrors: 0, fp: 0 });
    expect(rows.find((row) => row.id === "dev-23-false-positive-trap")).toMatchObject({ fp: 0, overSuggestions: 0 });
    expect(rows.find((row) => row.id === "dev-11-no-pdf-text")?.coverageErrors).toBe(0);
    expect(rows.find((row) => row.id === "dev-10-data-negative")?.fp).toBe(0);
    expect(rows.find((row) => row.id === "dev-26-short-negative")?.coverageErrors).toBe(0);
  }, 120_000);

  it("detects a falsely linked law, invented precedent, unsupported claim, duplicate and misplaced finding", async () => {
    const test = DEVELOPMENT_CASES[0];
    const file = reviewFileFor(test.document, `${test.id}.${test.kind}`);
    const original = await reviewContract(file.document.segments.map((segment) => segment.text), syntheticSources);
    const review = structuredClone(original);
    const issue = review.clauses.flatMap((clause) => clause.issues).find((candidate) => candidate.id === "penalty");
    expect(issue).toBeDefined();
    issue!.laws.push("absent-law");
    issue!.precedents.push("absent-judgment");
    issue!.fact = "문서에 없는 단정이다.";
    issue!.segments = [0];
    review.clauses[0].issues.push(structuredClone(issue!));
    const row = scoreCase(test, file, review);
    expect(row).toMatchObject({ tp: 0, fn: 1, fp: 2, wrongLocations: 2, duplicates: 1, unsupportedClaims: 2, wrongLawLinks: 2, wrongPrecedentLinks: 2, selectorFn: 0, reviewFn: 1 });
  });
});
