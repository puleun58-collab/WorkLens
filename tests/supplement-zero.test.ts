import { describe, expect, it } from "vitest";
import { SUPPLEMENT_ZERO_CASES } from "./eval/supplement-zero";
import { runSupplementCase } from "./eval/supplement-harness";

describe("보완 0건 회귀", () => {
  it("정의된 Must-Find가 모두 사라지면 critical gate가 실패한다", async () => {
    const outcome = await runSupplementCase(SUPPLEMENT_ZERO_CASES[0], async (batch) => batch.checks.map((check) => ({ id: check.id, verdict: "found" as const, handles: [check.handles[0]] })));
    expect(outcome.result.findings).toEqual([]);
    expect(outcome.failures.some((failure) => failure.kind === "zero-result")).toBe(true);
  });
  for (const failure of ["timeout", "rate-limit", "network", "provider-unavailable", "malformed", "parse-failure", "retry-exhausted"]) {
    it(`${failure}: deterministic 후보 보존, 시스템 영향과 품질 분리`, async () => {
      const outcome = await runSupplementCase(SUPPLEMENT_ZERO_CASES[0], async () => { throw new Error(failure); });
      expect(outcome.systemAffected).toBe(true);
      expect(outcome.expected).toBe(0);
      expect(outcome.result.semanticReview).toBe("partial");
      expect(outcome.result.findings.map((finding) => finding.check).sort()).toEqual(["budget", "owner", "schedule", "scope"]);
      expect(outcome.result.findings.every((finding) => finding.status === "unverified")).toBe(true);
    });
  }
});
