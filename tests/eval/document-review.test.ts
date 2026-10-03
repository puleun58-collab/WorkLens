import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REVIEW_SELECTOR_VERSION, reviewFileFor } from "../../src/lib/law-review-source";
import { reviewContract } from "../../src/server/contract-review";
import { paragraphCase, DEVELOPMENT_CASES } from "./document-review-cases";
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
    expect(baseline.selector).toBe(REVIEW_SELECTOR_VERSION);
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
    // Candidate priority closes the adversarial gaps while fallback independently improves coverage.
    for (const id of ["dev-18-sampling-gap", "dev-19-band-middle", "dev-20-multi-issue", "dev-21-last-tail", "dev-22-repeated-boilerplate"]) {
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

describe("document-review adversarial fallback (separate from fixed gold)", () => {
  const boilerplate = "자료는 정해진 순서로 기록하고 보관한다. ".repeat(12);
  const important = "상대방의 승인 없이 업무 조건을 변경하며 이에 따른 책임은 상대방이 부담한다. 변경된 조건에 대한 이의는 서면으로 제출하여야 하며 처리 완료 전에도 이행 의무는 계속된다. 당사자는 추가 비용과 작업 범위에 대한 합의 내용을 기록하여 보관하고 상대방에게 통지하여야 한다.";
  for (const [name, position] of [["A middle", 1055], ["B tail", 1955], ["D repeated boilerplate", 855]] as const) {
    it(name, () => {
      const lines = Array.from({ length: 2000 }, () => boilerplate);
      lines[0] = "용역 계약서: 당사자는 아래 사항에 합의한다.";
      lines[position] = important;
      const test = paragraphCase(name, "docx", lines, [], undefined, { status: "partial" });
      const file = reviewFileFor(test.document, "계약서.docx");
      expect(file.scan.candidates).toBe(0);
      expect(file.document.segments.some((segment) => segment.text === important)).toBe(true);
    });
  }
  it("C oversized unit does not hide its short neighbor", () => {
    const lines = Array.from({ length: 2000 }, (_, index) => `기록 ${index}: ${boilerplate}`);
    lines[1000] = boilerplate.repeat(100);
    lines[1001] = important;
    const file = reviewFileFor(paragraphCase("C", "docx", lines, []).document, "계약서.docx");
    expect(file.document.segments.some((segment) => segment.text === important)).toBe(true);
  });
  it("E zero candidates retain original text from every document tenth", () => {
    const lines = Array.from({ length: 2000 }, (_, index) => `기록 ${index}: ${boilerplate}`);
    const file = reviewFileFor(paragraphCase("E", "docx", lines, []).document, "계약서.docx");
    expect(file.scan.candidates).toBe(0);
    const positions = new Set(file.sources.map((source) => source.locator?.kind === "docx" ? Math.floor(source.locator.block / 200) : -1));
    expect([...positions].sort()).toEqual(Array.from({ length: 10 }, (_, index) => index));
  });
  it("F similar issues in one sentence do not duplicate findings", async () => {
    const file = reviewFileFor(paragraphCase("F", "docx", ["용역 계약서", "계약 위반 시 위약금과 위약벌 100만원을 지급한다."], []).document, "계약서.docx");
    const review = await reviewContract(file.document.segments, syntheticSources);
    const issues = review.clauses.flatMap((clause) => clause.issues);
    expect(issues.length).toBeGreaterThan(0);
    expect(new Set(issues.map((issue) => `${issue.id}:${issue.fact}`)).size).toBe(issues.length);
  });
  it("G legal vocabulary alone does not produce a risk", async () => {
    const file = reviewFileFor(paragraphCase("G", "docx", ["용역 계약서", "당사자는 개인정보 보호 의무를 준수하고 변경 사항을 통지한다."], []).document, "계약서.docx");
    const review = await reviewContract(file.document.segments, syntheticSources);
    expect(review.clauses.flatMap((clause) => clause.issues)).toEqual([]);
  });
});
