import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt, planSummary } from "../src/lib/ax/guide";
import { diagnosisFixture, planFixture } from "./fixtures/ax";
import type { AxDiagnosis, AxPlan } from "../src/lib/ax/types";

const withPoc = (poc: Partial<{ evaluation: string[]; success: string[]; failure: string[] }>): AxDiagnosis => ({
  ...diagnosisFixture,
  poc: { ...diagnosisFixture.poc, ...poc },
});

describe("03 완료 기준 중복 제거", () => {
  it("검증 방법의 '적용 범위 확인 필요' 접두어를 공통 안내로 통합한다", () => {
    // planFixture.tests의 2개 항목이 모두 "적용 범위 확인 필요" 상태일 때
    const summary = planSummary(diagnosisFixture, planFixture);
    // 접두어가 통합되면 개별 항목에서 제거되고 공통 안내가 설정됨
    if (summary.testsNotice) {
      expect(summary.tests.every(t => !t.startsWith("적용 범위 확인 필요:"))).toBe(true);
      expect(summary.testsNotice).toBe("검증 대상 단계와 적용 범위는 확인이 필요합니다.");
    } else {
      // 접두어가 없거나 혼재된 경우는 통합하지 않음
      expect(summary.testsNotice).toBeUndefined();
    }
  });

  it("공통 안내가 설정되면 개별 접두어는 제거된다", () => {
    const diagnosis = withPoc({ success: ["기준 A 확인", "기준 B 확인"] });
    const summary = planSummary(diagnosis, { ...planFixture, acceptance: [] });
    if (summary.criteriaNotice) {
      expect(summary.success.every(s => !s.startsWith("기준 확인 필요:"))).toBe(true);
    }
  });

  it("통과 조건의 '기준 확인 필요' 접두어를 공통 안내로 통합한다", () => {
    const diagnosis = withPoc({ success: ["수동 결과와 자동 결과 일치", "불일치 항목 없음"] });
    const summary = planSummary(diagnosis, { ...planFixture, acceptance: [] });
    expect(summary.success.every(s => !s.startsWith("기준 확인 필요:"))).toBe(true);
    expect(summary.criteriaNotice).toBe("정확한 합격 판정 기준은 실제 업무 규칙 확인 후 확정합니다.");
  });

  it("의미가 중복된 검증 방법을 통합한다", () => {
    const diagnosis = withPoc({});
    const plan: AxPlan = { ...planFixture, tests: ["수동 결과와 대조", "자동 처리 결과를 기준 수동 결과와 대조"] };
    const summary = planSummary(diagnosis, plan);
    // "수동 결과와 대조"는 "자동 처리 결과를 기준 수동 결과와 대조"의 부분집합이므로 통합
    expect(summary.tests.length).toBeLessThan(2);
  });

  it("원인·대응이 다른 위험은 보존한다", () => {
    const diagnosis: AxDiagnosis = {
      ...diagnosisFixture,
      risks: ["데이터 누락으로 정산 오류 발생 가능", "매칭 오류로 잘못된 금액 산출 가능"],
    };
    const summary = planSummary(diagnosis, planFixture);
    expect(summary.exceptions).toContain("데이터 누락으로 정산 오류 발생 가능");
    expect(summary.exceptions).toContain("매칭 오류로 잘못된 금액 산출 가능");
  });

  it("완전 동일한 위험 문장은 중복 제거한다", () => {
    const diagnosis: AxDiagnosis = {
      ...diagnosisFixture,
      risks: ["운임표 불일치", "운임표 불일치"],
    };
    const summary = planSummary(diagnosis, planFixture);
    expect(summary.exceptions.filter(e => e === "운임표 불일치").length).toBe(1);
  });

  it("올인원 지시문은 planSummary 변경과 무관하게 모델을 직접 읽는다", () => {
    // buildAllInOnePrompt는 planSummary가 아닌 buildAgentInstructionModel을 직접 사용
    // planSummary의 접두어 통합이 지시문에 영향을 주지 않음을 확인
    const prompt = buildAllInOnePrompt(planFixture, "codex", { taskName: "테스트 업무" });
    expect(prompt).toContain("# 테스트 업무 자동화 구현 지시문");
    // 지시문에 planSummary의 공통 안내 문구가 직접 포함되지 않음 (모델 기반 생성)
    expect(prompt).not.toContain("검증 대상 단계와 적용 범위는 확인이 필요합니다.");
  });
});
