import { describe, expect, it } from "vitest";
import { precheckListItems, scopeSummaryRows } from "../src/components/ax/AxReport";
import type { AxPlanSummary } from "@/lib/ax/guide";

const summary = (overrides: Partial<AxPlanSummary>): AxPlanSummary => ({
  include: [],
  humanKept: [],
  excluded: [],
  prerequisites: [],
  checks: [],
  blockReasons: [],
  additionalChecks: [],
  prerequisiteSources: [],
  conditions: { current: [], future: [] },
  constraints: [],
  approvals: [],
  data: [],
  tests: [],
  success: [],
  failure: [],
  exceptions: [],
  demotedCriteria: [],
  demotedExceptions: [],
  conflictingCriteria: [],
  numericConflictCriteria: [],
  ...overrides,
} as AxPlanSummary);

describe("구현 전 확인 펼침 목록", () => {
  it("배지 건수와 펼친 항목 수가 같은 집계 기준을 쓴다", () => {
    const s = summary({
      blockReasons: ["필수 시스템 접근 불가"],
      checks: [
        { topic: "시스템 접근", status: "확인 필요", note: "API 권한 확인", tone: "required" },
        { topic: "출력 형식", status: "확인됨", note: "", tone: "done" },
      ],
      additionalChecks: [
        { item: "권한 확인", content: "관리자 승인 필요", stage: null, status: "확인 필요", tone: "required", future: false, relation: "공통 조건" },
        { item: "향후 검토", content: "나중에 확인", stage: null, status: "향후 검토", tone: "future", future: true, relation: "향후 조건" },
      ],
      conflictingCriteria: ["기준 A·B 충돌"],
      numericConflictCriteria: ["허용 오차 상충"],
    });
    const items = precheckListItems(s);
    // 차단 1 + 미완료 기술 확인 1 + 미완료 추가 확인 1 + 기준 충돌 2 = 5건.
    // 확인됨(done)·향후 검토(future)는 미해결 건수에 포함되지 않는다.
    expect(items).toHaveLength(5);
    expect(items.map(item => item.title)).toEqual([
      "필수 시스템 접근 불가",
      "시스템 접근",
      "권한 확인",
      "기준 A·B 충돌",
      "허용 오차 상충",
    ]);
  });

  it("미해결 항목이 없어도 빈 목록을 반환한다", () => {
    expect(precheckListItems(summary({}))).toEqual([]);
  });

  it("확인 위치가 없는 항목(출력 컬럼)은 위치 안내를 생략한다", () => {
    const items = precheckListItems(summary({
      checks: [{ topic: "출력 컬럼 미확정", status: "확인 필요", note: "컬럼 확정 필요", tone: "required" }],
    }));
    expect(items).toHaveLength(1);
    expect(items[0].target.kind).toBe("none");
  });

  it("D번호가 하나만 언급된 항목은 해당 결정 지점을 확인 위치로 쓴다", () => {
    const items = precheckListItems(summary({
      checks: [{ topic: "D3 예외값 처리", status: "확인 필요", note: "", tone: "required" }],
    }));
    expect(items[0].target).toEqual({ kind: "decision", id: "D3" });
  });
});

describe("구현 범위·완료 기준 한 줄 요약", () => {
  it("범위 건수는 실제 판정 결과에서 계산한다", () => {
    const rows = scopeSummaryRows(summary({
      include: ["A 단계 처리", "B 단계 처리"],
      humanKept: ["C 단계 (담당자 수행)"],
      excluded: ["D 단계"],
    }));
    expect(rows.implementCount).toBe(2);
    expect(rows.humanCount).toBe(1);
    expect(rows.excludedCount).toBe(1);
  });

  it("핵심 기준은 성공→실패→테스트→승인 순으로 최대 3개까지만 표시하고 나머지는 건수로 요약한다", () => {
    const rows = scopeSummaryRows(summary({
      success: ["성공 기준 1", "성공 기준 2"],
      failure: ["실패 기준 1"],
      tests: ["테스트 기준 1"],
      approvals: ["승인 기준 1"],
    }));
    expect(rows.coreCriteria).toEqual(["성공 기준 1", "성공 기준 2", "실패 기준 1"]);
    expect(rows.additionalCriteriaCount).toBe(2);
  });

  it("기준이 3개 이하면 추가 기준 건수는 0이다", () => {
    const rows = scopeSummaryRows(summary({ success: ["성공 기준 1"], failure: ["실패 기준 1"] }));
    expect(rows.coreCriteria).toHaveLength(2);
    expect(rows.additionalCriteriaCount).toBe(0);
  });
});
