import { describe, expect, it } from "vitest";
import { alignInformationSufficiency, executionGate, taskStatus } from "@/lib/ax/policy";
import { diagnosisFixture } from "./fixtures/ax";

const needsCheck = { ...diagnosisFixture, informationSufficiency: "needs-check" as const };

describe("information sufficiency follows the published core-fact rule", () => {
  it("lifts needs-check to partial when at most two of the four core facts are missing", () => {
    for (const details of [
      { cycle: "매주 월요일", inputs: "가격 자료", outputs: "주간 보고서", humanSteps: "누락 확인" },
      { cycle: "매주 월요일", inputs: "가격 자료" },
      { outputs: "주간 보고서", humanSteps: "누락 확인" },
    ]) {
      const aligned = alignInformationSufficiency(needsCheck, details);
      expect(aligned.informationSufficiency).toBe("partial");
      expect(taskStatus(aligned)).toBe("diagnosed");
    }
  });

  it("keeps needs-check when three or four core facts are missing or blank", () => {
    for (const details of [{}, { cycle: "매주" }, { cycle: "매주", inputs: "  ", outputs: "", systems: "Excel" }]) {
      expect(alignInformationSufficiency(needsCheck, details).informationSufficiency).toBe("needs-check");
    }
  });

  it("never promotes to sufficient or changes a model judgement that is not needs-check", () => {
    const details = { cycle: "매주", inputs: "자료", outputs: "보고서", humanSteps: "검토" };
    for (const level of ["partial", "sufficient"] as const) {
      const diagnosis = { ...diagnosisFixture, informationSufficiency: level };
      expect(alignInformationSufficiency(diagnosis, details)).toBe(diagnosis);
    }
    // Unconfirmed technical checks still keep the gate conditional after alignment.
    const aligned = alignInformationSufficiency({ ...needsCheck, decisionGate: { verdict: "go" as const, reasons: [] } }, details);
    expect(executionGate(aligned)).toBe(diagnosisFixture.technicalChecks.some(check => check.status !== "확인됨") ? "conditional" : "ready");
  });
});
