import { describe, expect, it } from "vitest";
import {
  GATE_LABELS, executionGate, gatePrerequisites, gateBlockReasons, gateRecommendedChecks, splitGatePrerequisites,
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
    expect(GATE_LABELS).toEqual({ ready: "진행 가능", conditional: "확인 후 진행", blocked: "진행 보류" });
  });

  it("blocks no-go while preserving the original quick region and showing 진행 보류", () => {
    const d = diagnosis({ decisionGate: { verdict: "no-go", reasons: ["실행 승인 불가"] } });
    d.factors.forEach(f => { f.aiValue = f.key === "humanJudgment" || f.key === "operationalRisk" ? 1 : 5; });
    const before = structuredClone(d);
    expect(matrixPosition(d).region).toBe("quick");
    expect(executionGate(d)).toBe("blocked");
    expect(priorityDisplayLabel(d)).toBe("진행 보류");
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

  it("treats optional unconfirmed checks as non-blocking for the gate", () => {
    const d = diagnosis({
      decisionGate: { verdict: "go", reasons: [] },
      technicalChecks: [
        { topic: "필수 접근", status: "확인됨", note: "확인 완료" },
        { topic: "선택 권장", status: "확인 필요", note: "권장 사항", required: false },
      ],
    });
    expect(executionGate(d)).toBe("ready");
    expect(gatePrerequisites(d)).toEqual([]);
  });

  it("keeps required unconfirmed checks as conditional and marks optional ones", () => {
    const d = diagnosis({
      decisionGate: { verdict: "go", reasons: [] },
      technicalChecks: [
        { topic: "필수 접근", status: "확인 필요", note: "권한 확인 필요" },
        { topic: "선택 권장", status: "확인 필요", note: "권장 사항", required: false },
      ],
    });
    expect(executionGate(d)).toBe("conditional");
    expect(gatePrerequisites(d)).toEqual([
      "필수 접근 — 권한 확인 필요",
      "선택 권장 (선택) — 권장 사항",
    ]);
  });
});

describe("AX gate recommended checks display (표시 전용 — Gate 판정 불변)", () => {
  it("필수·선택 조건이 모두 없으면 prerequisites 빈 목록, 권장 확인사항 표시 없음", () => {
    const d = diagnosis({ technicalChecks: [] });
    expect(executionGate(d)).toBe("ready");
    expect(gatePrerequisites(d)).toEqual([]);
    expect(gateRecommendedChecks(d)).toEqual([]);
    expect(splitGatePrerequisites(d)).toEqual({ required: [], recommended: [] });
  });

  it("선택적 확인사항만 존재하면 Gate=ready 유지, 권장 확인사항으로 표시", () => {
    const d = diagnosis({
      technicalChecks: [{ topic: "선택 권장", status: "확인 필요", note: "권장 사항", required: false }],
    });
    expect(executionGate(d)).toBe("ready");
    expect(gatePrerequisites(d)).toEqual([]);
    expect(gateRecommendedChecks(d)).toEqual(["선택 권장 — 권장 사항"]);
    expect(splitGatePrerequisites(d)).toEqual({ required: [], recommended: ["선택 권장 — 권장 사항"] });
  });

  it("필수 조건 미확정이면 Gate=conditional, 필수 조건 표시", () => {
    const d = diagnosis({
      technicalChecks: [{ topic: "필수 접근", status: "확인 필요", note: "권한 확인", required: true }],
    });
    expect(executionGate(d)).toBe("conditional");
    const groups = splitGatePrerequisites(d);
    expect(groups.required).toEqual(["필수 접근 — 권한 확인"]);
    expect(groups.recommended).toEqual([]);
  });

  it("필수·선택 조건이 함께 있으면 둘을 구분 표시 (Gate 계산 불변)", () => {
    const d = diagnosis({
      technicalChecks: [
        { topic: "필수 접근", status: "확인 필요", note: "권한 확인", required: true },
        { topic: "선택 권장", status: "확인 필요", note: "권장 사항", required: false },
      ],
    });
    expect(executionGate(d)).toBe("conditional");
    expect(splitGatePrerequisites(d)).toEqual({
      required: ["필수 접근 — 권한 확인"],
      recommended: ["선택 권장 — 권장 사항"],
    });
    // gatePrerequisites 자체의 출력 형태는 기존과 동일하게 유지
    expect(gatePrerequisites(d)).toEqual(["필수 접근 — 권한 확인", "선택 권장 (선택) — 권장 사항"]);
  });

  it("명시적 no-go는 blocked, 차단 사유가 권장 확인사항보다 우선 표시", () => {
    const d = diagnosis({
      decisionGate: { verdict: "no-go", reasons: ["실행 승인 불가"] },
      technicalChecks: [
        { topic: "필수 접근", status: "확인 필요", note: "", required: true },
        { topic: "선택 권장", status: "확인 필요", note: "", required: false },
      ],
    });
    expect(executionGate(d)).toBe("blocked");
    const groups = splitGatePrerequisites(d);
    expect(groups.required).toEqual(["필수 접근", "실행 승인 불가"]);
    expect(groups.recommended).toEqual(["선택 권장"]);
  });

  it("required 필드가 없는 기존 데이터는 필수로 간주 (PR #217 규칙 유지)", () => {
    const d = diagnosis({
      technicalChecks: [{ topic: "구 데이터", status: "확인 필요", note: "" }],
    });
    expect(executionGate(d)).toBe("conditional");
    expect(gateRecommendedChecks(d)).toEqual([]);
    expect(splitGatePrerequisites(d)).toEqual({ required: ["구 데이터"], recommended: [] });
  });

  it("재진단으로 확인 상태가 변경되면 권장 확인사항 표시가 갱신", () => {
    const before = diagnosis({
      technicalChecks: [{ topic: "선택 권장", status: "확인 필요", note: "", required: false }],
    });
    expect(executionGate(before)).toBe("ready");
    expect(splitGatePrerequisites(before).recommended).toEqual(["선택 권장"]);
    const after = diagnosis({
      technicalChecks: [{ topic: "선택 권장", status: "확인됨", note: "", required: false }],
    });
    expect(executionGate(after)).toBe("ready");
    expect(splitGatePrerequisites(after)).toEqual({ required: [], recommended: [] });
  });

  it("선택적 확인사항이 있다는 이유만으로 진행 가능 업무가 확인 후 진행으로 변경되지 않음", () => {
    const d = diagnosis({
      technicalChecks: [
        { topic: "선택 1", status: "확인 필요", note: "", required: false },
        { topic: "선택 2", status: "확인 필요", note: "", required: false },
      ],
    });
    expect(executionGate(d)).toBe("ready");
    expect(gateRecommendedChecks(d)).toEqual(["선택 1", "선택 2"]);
    expect(planAllowed(d)).toBe(true);
  });

  it("표시 전용 중복 정리: 같은 주제의 확인 조건은 한 번만, 다른 주제는 각각 유지", () => {
    const d = diagnosis({
      decisionGate: { verdict: "conditional", reasons: [] },
      technicalChecks: [
        { topic: "API 제공 여부", status: "확인 필요", note: "제공 여부 미확인", required: true },
        { topic: "API 제공 여부", status: "확인 필요", note: "담당 부서 확인 중", required: true },
        { topic: "API 접근 권한", status: "확인 필요", note: "권한 신청 필요", required: true },
      ],
    });
    expect(executionGate(d)).toBe("conditional");
    // gatePrerequisites(계산·타 화면 공용) 자체는 변경하지 않는다.
    expect(gatePrerequisites(d)).toEqual([
      "API 제공 여부 — 제공 여부 미확인",
      "API 제공 여부 — 담당 부서 확인 중",
      "API 접근 권한 — 권한 신청 필요",
    ]);
    expect(splitGatePrerequisites(d)).toEqual({
      required: ["API 제공 여부 — 제공 여부 미확인", "API 접근 권한 — 권한 신청 필요"],
      recommended: [],
    });
  });

  it("표시 전용 중복 정리: 기술 확인과 같은 주제를 묻는 추가 질문은 한 번만 표시", () => {
    const d = diagnosis({
      informationSufficiency: "needs-check",
      followUpQuestions: ["API 제공 여부를 알려주세요.", "예외 건 발생 빈도는 어느 정도인가요?"],
      technicalChecks: [
        { topic: "API 제공 여부", status: "확인 필요", note: "", required: true },
        { topic: "API 접근 권한", status: "확인 필요", note: "", required: true },
      ],
    });
    expect(splitGatePrerequisites(d).required).toEqual([
      "API 제공 여부",
      "API 접근 권한",
      "예외 건 발생 빈도는 어느 정도인가요?",
    ]);
  });
});
