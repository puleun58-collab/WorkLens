import { describe, expect, it } from "vitest";
import { concreteNextAction } from "../src/components/ax/AxReport";
import type { AxDiagnosis } from "@/lib/ax/types";
import { diagnosisFixture } from "./fixtures/ax";

/** 표시층 구체화만 검증한다: 정책 판정·저장·지시문은 이 함수가 바꾸지 않는다. */
describe("concreteNextAction", () => {
  const base: AxDiagnosis = structuredClone(diagnosisFixture);
  it("조건부에서는 필수 선행 조건 첫 항목과 나머지 건수를 표시한다", () => {
    expect(concreteNextAction(base)).toEqual({
      label: "먼저 확인",
      detail: "시스템 접근 — API와 권한 실제 확인 외 1건",
    });
  });
  it("정보 확인 필요에서는 추가 질문을 우선 표시한다", () => {
    const d: AxDiagnosis = { ...structuredClone(base), informationSufficiency: "needs-check", followUpQuestions: ["원본 사이트 접근 권한이 있나요?"] };
    expect(concreteNextAction(d)).toEqual({ label: "추가 질문 답변", detail: "원본 사이트 접근 권한이 있나요?" });
  });
  it("질문이 없는 정보 확인 필요에서는 필수 확인 항목을 표시한다", () => {
    const d: AxDiagnosis = { ...structuredClone(base), informationSufficiency: "needs-check", decisionGate: { verdict: "go", reasons: [] } };
    expect(concreteNextAction(d)).toEqual({ label: "확인할 사항 검토", detail: "시스템 접근 — API와 권한 실제 확인" });
  });
  it("선택 항목만 남은 정보 확인 필요에서는 정책 라벨로 돌아간다", () => {
    const d: AxDiagnosis = {
      ...structuredClone(base),
      informationSufficiency: "needs-check",
      decisionGate: { verdict: "go", reasons: [] },
      technicalChecks: [{ topic: "참고 자료", status: "확인 필요", note: "", required: false }],
    };
    expect(concreteNextAction(d)).toEqual({ label: "핵심 확인사항 확인 필요" });
  });
  it("진행 보류에서는 차단 사유를 표시한다", () => {
    const d: AxDiagnosis = { ...structuredClone(base), decisionGate: { verdict: "no-go", reasons: ["접근 권한 없음"] } };
    expect(concreteNextAction(d)).toEqual({ label: "차단 사유 해결", detail: "접근 권한 없음" });
  });
  it("진행 가능에서는 기존 nextAction 라벨을 유지한다", () => {
    const d: AxDiagnosis = {
      ...structuredClone(base),
      decisionGate: { verdict: "go", reasons: [] },
      technicalChecks: [{ topic: "시스템 접근", status: "확인됨", note: "API와 권한 실제 확인" }],
    };
    expect(concreteNextAction(d)).toEqual({ label: "샘플 확인" });
  });
  it("원본 근거가 없는 조건부에서는 정책 라벨로 돌아간다", () => {
    const d: AxDiagnosis = {
      ...structuredClone(base),
      decisionGate: { verdict: "conditional", reasons: [] },
      technicalChecks: [],
    };
    expect(concreteNextAction(d)).toEqual({ label: "선행 확인사항 확인" });
  });
});
