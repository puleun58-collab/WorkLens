import { describe, expect, it } from "vitest";
import {
  GATE_LABELS, executionGate, gatePrerequisites, gateBlockReasons,
  matrixPosition, planAllowed, priorityDisplayLabel,
} from "@/lib/ax/policy";
import type { AxDiagnosis } from "@/lib/ax/types";
import { diagnosisFixture } from "./fixtures/ax";

function diagnosis(overrides: Partial<AxDiagnosis> = {}): AxDiagnosis {
  return {
    ...structuredClone(diagnosisFixture),
    decisionGate: { verdict: "go", reasons: [] },
    technicalChecks: [{ topic: "시스템 접근", status: "확인됨", note: "API 확인 완료" }],
    ...overrides,
  };
}

describe("AX execution gate", () => {
  it("exposes the three execution labels", () => {
    expect(GATE_LABELS).toEqual({ ready: "실행 가능", conditional: "조건부 진행", blocked: "실행 보류" });
  });

  it("blocks no-go while preserving the original quick region and showing 실행 보류", () => {
    const d = diagnosis({ decisionGate: { verdict: "no-go", reasons: ["실행 승인 불가"] } });
    d.factors.forEach(f => { f.aiValue = f.key === "humanJudgment" || f.key === "operationalRisk" ? 1 : 5; });
    const before = structuredClone(d);
    expect(matrixPosition(d).region).toBe("quick");
    expect(executionGate(d)).toBe("blocked");
    expect(priorityDisplayLabel(d)).toBe("실행 보류");
    expect(planAllowed(d)).toBe(false);
    expect(matrixPosition(d).region).toBe("quick");
    expect(d).toEqual(before);
  });

  it("blocks no-go when all six factor values are high and preserves the raw region", () => {
    const d = diagnosis({ decisionGate: { verdict: "no-go", reasons: [] } });
    d.factors.forEach(f => { f.aiValue = 5; });
    expect(executionGate(d)).toBe("blocked");
    expect(matrixPosition(d).region).toBe("hold");
  });

  it("treats an individual 불가 check under go as conditional to avoid excessive blocking", () => {
    const d = diagnosis({ technicalChecks: [{ topic: "시스템 접근", status: "불가", note: "접근 권한 없음" }] });
    expect(executionGate(d)).toBe("conditional");
    expect(gatePrerequisites(d)).toEqual(["시스템 접근 — 접근 권한 없음"]);
    expect(planAllowed(d)).toBe(true);
  });

  it("requires prerequisites for a conditional verdict even without listed reasons", () => {
    const d = diagnosis({ decisionGate: { verdict: "conditional", reasons: [] } });
    expect(executionGate(d)).toBe("conditional");
    expect(gatePrerequisites(d)).toEqual(["진단에서 제시된 조건부 진행 사유를 확인하세요."]);
    expect(planAllowed(d)).toBe(true);
  });

  it("includes follow-up questions when information needs checking", () => {
    const d = diagnosis({ informationSufficiency: "needs-check", followUpQuestions: ["입력 형식은?", "승인자는?"] });
    expect(executionGate(d)).toBe("conditional");
    expect(gatePrerequisites(d)).toEqual(d.followUpQuestions);
  });

  it("provides a prerequisite fallback when needs-check has no questions", () => {
    expect(gatePrerequisites(diagnosis({ informationSufficiency: "needs-check" }))).toEqual([
      "진단에서 제시된 조건부 진행 사유를 확인하세요.",
    ]);
  });

  it("is ready for go with sufficient information and only confirmed checks", () => {
    const d = diagnosis({ followUpQuestions: ["이전 확인 질문"], decisionGate: { verdict: "go", reasons: ["이전 사유"] } });
    expect(executionGate(d)).toBe("ready");
    expect(gatePrerequisites(d)).toEqual([]);
    expect(planAllowed(d)).toBe(true);
  });

  it("is ready for go without technical checks and does not treat partial as needs-check", () => {
    expect(executionGate(diagnosis({ technicalChecks: [] }))).toBe("ready");
    expect(executionGate(diagnosis({ informationSufficiency: "partial" }))).toBe("ready");
  });

  it("is conditional for go with one 확인 필요 check", () => {
    const d = diagnosis({ technicalChecks: [{ topic: "API", status: "확인 필요", note: "" }] });
    expect(executionGate(d)).toBe("conditional");
    expect(gatePrerequisites(d)).toEqual(["API"]);
  });

  it("gives no-go precedence over missing information and unconfirmed checks", () => {
    const d = diagnosis({
      decisionGate: { verdict: "no-go", reasons: ["진행 불가"] },
      informationSufficiency: "needs-check", followUpQuestions: ["권한은?"],
      technicalChecks: [{ topic: "API", status: "확인 필요", note: "" }],
    });
    expect(executionGate(d)).toBe("blocked");
    expect(gatePrerequisites(d)).toEqual(["API", "권한은?", "진행 불가"]);
  });

  it("collects prerequisites in technical/question/reason order and deduplicates without mutation", () => {
    const d = diagnosis({
      informationSufficiency: "needs-check", followUpQuestions: ["API — 권한 확인", "담당자는?", "담당자는?"],
      technicalChecks: [
        { topic: "API", status: "확인 필요", note: "권한 확인" },
        { topic: "입력", status: "불가", note: "" },
        { topic: "완료", status: "확인됨", note: "이미 확인" },
        { topic: "API", status: "확인 필요", note: "권한 확인" },
      ],
      decisionGate: { verdict: "conditional", reasons: ["담당자는?", "샘플 필요"] },
    });
    const before = structuredClone(d);
    expect(gatePrerequisites(d)).toEqual(["API — 권한 확인", "입력", "담당자는?", "샘플 필요"]);
    expect(gatePrerequisites(d)).toEqual(gatePrerequisites(d));
    expect(d).toEqual(before);
  });

  it("caps prerequisites at ten unique items after preserving first appearance", () => {
    const topics = Array.from({ length: 9 }, (_, i) => `확인 ${i + 1}`);
    const d = diagnosis({
      technicalChecks: [...topics, topics[0]].map(topic => ({ topic, status: "확인 필요", note: "" })),
      informationSufficiency: "needs-check", followUpQuestions: [topics[0], "추가 질문", "뒤 질문"],
      decisionGate: { verdict: "conditional", reasons: ["뒤 사유"] },
    });
    expect(gatePrerequisites(d)).toEqual([...topics, "추가 질문"]);
  });

  it("provides block-reason and prerequisite fallbacks when no-go has no reasons or impossible checks", () => {
    const d = diagnosis({ decisionGate: { verdict: "no-go", reasons: [] } });
    expect(executionGate(d)).toBe("blocked");
    expect(gateBlockReasons(d)).toEqual(["Decision Gate에서 진행 불가(no-go)로 판정되었습니다."]);
    expect(gatePrerequisites(d).length).toBeGreaterThan(0);
  });

  it("lists decision reasons followed by impossible checks with and without notes", () => {
    const d = diagnosis({
      decisionGate: { verdict: "no-go", reasons: ["승인 불가"] },
      technicalChecks: [
        { topic: "API", status: "불가", note: "권한 없음" },
        { topic: "MFA", status: "불가", note: "" },
        { topic: "입력", status: "확인 필요", note: "샘플 필요" },
        { topic: "형식", status: "확인됨", note: "CSV" },
      ],
    });
    const before = structuredClone(d);
    expect(gateBlockReasons(d)).toEqual(["승인 불가", "API 불가 — 권한 없음", "MFA 불가"]);
    expect(d).toEqual(before);
  });

  it.each(["go", "conditional"] as const)("keeps the original region label for %s", verdict => {
    const d = diagnosis({ decisionGate: { verdict, reasons: [] } });
    for (const values of [[5, 5, 5, 5, 1, 1], [5, 5, 1, 1, 2, 2], [1, 4, 4, 5, 2, 2], [1, 1, 1, 1, 1, 1]]) {
      d.factors.forEach((f, i) => { f.aiValue = values[i]; });
      expect(priorityDisplayLabel(d)).toBe(matrixPosition(d).label);
    }
  });
});
