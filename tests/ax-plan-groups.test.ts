import { describe, expect, it } from "vitest";
import { groupPlanSteps } from "@/lib/ax/plan-groups";
import { planFixture } from "./fixtures/ax";

describe("AX 구현 계획 그룹 표시 (표시 전용 분류)", () => {
  it("모든 단계가 정확히 한 그룹에 들어가고, 그룹 안은 원본 순서를 유지한다", () => {
    const steps = [
      "원본 파일 수집 및 공유 드라이브 접근 권한 확인",
      "입력 자료 유효성 검증",
      "컬럼 매핑 표준화",
      "가동률 계산 규칙 적용",
      "보고서 템플릿에 결과 반영",
      "결과 파일 저장",
      "오류 발생 시 담당자 알림",
      "담당자 최종 검토 및 승인",
    ];
    const groups = groupPlanSteps(steps);
    const indices = groups.flatMap(group => group.steps.map(step => step.index));
    expect([...indices].sort((a, b) => a - b)).toEqual(steps.map((_, index) => index));
    expect(new Set(indices).size).toBe(steps.length);
    for (const group of groups) expect(group.steps.map(step => step.index)).toEqual([...group.steps.map(step => step.index)].sort((a, b) => a - b));
    expect(groups.map(group => [group.id, group.steps.map(step => step.index)])).toEqual([
      ["collect", [0, 1]], ["process", [2, 3]], ["report", [4, 5]], ["operate", [6, 7]],
    ]);
  });

  it("규칙에 맞지 않는 단계는 앞 단계의 그룹을 따르고, 빈 그룹은 만들지 않는다", () => {
    const groups = groupPlanSteps(["보고서 초안 작성", "표 서식 정리", "가동률 계산"]);
    expect(groups.map(group => [group.id, group.steps.map(step => step.index)])).toEqual([["process", [2]], ["report", [0, 1]]]);
    expect(groupPlanSteps(["기타 작업"]).map(group => group.id)).toEqual(["process"]);
    expect(groupPlanSteps([])).toEqual([]);
  });

  it("고정 예시 계획도 누락·중복 없이 원본 항목 수와 같다", () => {
    const groups = groupPlanSteps(planFixture.implementation);
    expect(groups.reduce((sum, group) => sum + group.steps.length, 0)).toBe(planFixture.implementation.length);
  });
});
