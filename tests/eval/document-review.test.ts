import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reviewFileFor } from "../../src/lib/law-review-source";
import { reviewContract } from "../../src/server/contract-review";
import { DEVELOPMENT_CASES } from "./document-review-cases";
import { evaluateCase, scoreCase, summarize, syntheticSources, type EvalSummary } from "./document-review-harness";

const baseline = JSON.parse(readFileSync("tests/eval/document-review-baseline.json", "utf8")) as {
  version: string; set: string; caseIds: string[]; summary: EvalSummary;
};

describe("document-review gold evaluation", () => {
  it("keeps a versioned development-only baseline and distinct gold assertions", () => {
    expect(DEVELOPMENT_CASES).toHaveLength(17);
    const ids = DEVELOPMENT_CASES.map((test) => test.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(baseline.version).toBe("document-review-v1");
    expect(baseline.set).toBe("development");
    expect(baseline.caseIds).toEqual(DEVELOPMENT_CASES.map((test) => test.id));
    for (const test of DEVELOPMENT_CASES) {
      expect(test.document.kind).toBe(test.kind);
      expect(new Set(test.gold.map((item) => `${item.issue}:${item.location}`)).size).toBe(test.gold.length);
    }
  });

  it("measures development findings, links, citation traps, wrong locations, over-suggestion and coverage against independent gold", async () => {
    const rows = await Promise.all(DEVELOPMENT_CASES.map((test) => evaluateCase(test)));
    const summary = summarize(rows);
    console.log(JSON.stringify({ baseline: baseline.version, set: "development", summary, deviations: rows.filter((row) => row.fp || row.fn || row.coverageErrors || row.wrongLawLinks || row.wrongPrecedentLinks || row.unsupportedClaims || row.wrongLocations || row.duplicates || row.overSuggestions) }, null, 2));
    expect(summary).toMatchObject(baseline.summary);
    expect(summary.tp + summary.fn).toBe(DEVELOPMENT_CASES.reduce((sum, test) => sum + test.gold.length, 0));
    expect(rows.find((row) => row.id === "dev-17-long-end")?.fn).toBe(0);
    expect(rows.find((row) => row.id === "dev-11-no-pdf-text")?.coverageErrors).toBe(0);
    expect(rows.find((row) => row.id === "dev-10-data-negative")?.fp).toBe(0);
  }, 60_000);

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
    expect(row).toMatchObject({ tp: 0, fn: 1, fp: 2, wrongLocations: 2, duplicates: 1, unsupportedClaims: 2, wrongLawLinks: 2, wrongPrecedentLinks: 2 });
  });

});
