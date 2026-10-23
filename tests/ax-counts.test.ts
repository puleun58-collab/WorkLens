import { describe, expect, it } from "vitest";
import { diagnosisCounts, diagnosisStatusItems } from "@/lib/ax/policy";
import type { AxDiagnosis, AxTask } from "@/lib/ax/types";
import { diagnosisFixture, taskFixture } from "./fixtures/ax";

/** 기본 픽스처는 verdict conditional + 미확인 필수 항목이라, ready 기준선(go + 전 항목 확인됨)으로 맞춘 뒤 덮어쓴다. */
function diagnosis(overrides: Partial<AxDiagnosis> = {}): AxDiagnosis {
  return {
    ...structuredClone(diagnosisFixture),
    decisionGate: { verdict: "go", reasons: [] },
    technicalChecks: [{ topic: "시스템 접근", status: "확인됨", note: "API 확인 완료" }],
    ...overrides,
  };
}
const readyTask = (id: string): AxTask => taskFixture(id, diagnosis());
const conditionalTask = (id: string): AxTask => taskFixture(id, diagnosis({ decisionGate: { verdict: "conditional", reasons: ["권한 확인 후 진행"] } }));
const blockedTask = (id: string): AxTask => taskFixture(id, diagnosis({ decisionGate: { verdict: "no-go", reasons: ["개인정보 처리 정책상 자동화 불가"] } }));
const needsCheckTask = (id: string): AxTask => taskFixture(id, diagnosis({ informationSufficiency: "needs-check", followUpQuestions: ["입력 자료 형식을 알려 주세요"] }));

describe("diagnosisCounts (공통 집계)", () => {
  it("등록 업무가 없으면 전부 0이다", () => {
    expect(diagnosisCounts([])).toEqual({ results: 0, ready: 0, conditional: 0, blocked: 0, questions: 0 });
  });

  it("등록만 되고 진단되지 않은 업무는 어떤 건수에도 포함되지 않는다", () => {
    expect(diagnosisCounts([taskFixture("a"), taskFixture("b")])).toEqual({ results: 0, ready: 0, conditional: 0, blocked: 0, questions: 0 });
  });

  it("일부만 진단 완료되면 진단 완료 건수와 해당 Gate만 집계된다", () => {
    const counts = diagnosisCounts([readyTask("a"), taskFixture("b"), taskFixture("c")]);
    expect(counts).toEqual({ results: 1, ready: 1, conditional: 0, blocked: 0, questions: 0 });
  });

  it("진행 상태가 혼합되면 상태별로 집계된다", () => {
    const counts = diagnosisCounts([readyTask("a"), readyTask("b"), conditionalTask("c"), blockedTask("d")]);
    expect(counts).toEqual({ results: 4, ready: 2, conditional: 1, blocked: 1, questions: 0 });
  });

  it("정보 확인 필요는 Gate(확인 후 진행)와 별개 축으로 동시에 집계된다 — 합산·병합하지 않는다", () => {
    const counts = diagnosisCounts([needsCheckTask("a"), readyTask("b")]);
    expect(counts).toEqual({ results: 2, ready: 1, conditional: 1, blocked: 0, questions: 1 });
  });

  it("정보 확인 필요 업무가 여러 건이면 업무 수 그대로 집계된다", () => {
    const counts = diagnosisCounts([needsCheckTask("a"), needsCheckTask("b"), needsCheckTask("c")]);
    expect(counts.questions).toBe(3);
    expect(counts.results).toBe(3);
  });
});

describe("diagnosisStatusItems (공통 표시)", () => {
  it("전부 0건이면 표시 항목이 없다", () => {
    expect(diagnosisStatusItems({ results: 0, ready: 0, conditional: 0, blocked: 0, questions: 0 })).toEqual([]);
  });

  it("순서는 진행 가능 → 확인 후 진행 → 진행 보류 → 정보 확인 필요이고 0건은 숨긴다", () => {
    const items = diagnosisStatusItems({ results: 5, ready: 2, conditional: 2, blocked: 1, questions: 0 });
    expect(items.map(item => item.key)).toEqual(["ready", "conditional", "blocked"]);
    expect(items.map(item => item.text)).toEqual(["진행 가능 2", "확인 후 진행 2", "진행 보류 1"]);
  });

  it("전부 확인 후 진행 + 정보 확인 필요 업무 1개이면 예시 문구와 동일하다", () => {
    const items = diagnosisStatusItems({ results: 5, ready: 0, conditional: 5, blocked: 0, questions: 1 });
    expect(items.map(item => item.text).join(" · ")).toBe("확인 후 진행 5 · 정보 확인 필요 업무 1개");
  });

  it("정보 확인 필요 항목만 클릭 가능(actionable)이고 건수·라벨을 구조화해 반환한다", () => {
    const items = diagnosisStatusItems({ results: 5, ready: 0, conditional: 5, blocked: 0, questions: 1 });
    expect(items.find(item => item.key === "needsCheck")).toEqual({
      key: "needsCheck", label: "정보 확인 필요", count: 1, text: "정보 확인 필요 업무 1개", actionable: true,
    });
    expect(items.filter(item => item.key !== "needsCheck").every(item => !item.actionable)).toBe(true);
  });

  it("집계 결과와 연결하면 시나리오별 문구가 두 화면 공통 규칙으로 생성된다", () => {
    const texts = (tasks: AxTask[]) => diagnosisStatusItems(diagnosisCounts(tasks)).map(item => item.text).join(" · ");
    expect(texts([conditionalTask("a"), conditionalTask("b"), needsCheckTask("c")])).toBe("확인 후 진행 3 · 정보 확인 필요 업무 1개");
    expect(texts([readyTask("a"), blockedTask("b")])).toBe("진행 가능 1 · 진행 보류 1");
    expect(texts([taskFixture("a")])).toBe("");
  });
});
