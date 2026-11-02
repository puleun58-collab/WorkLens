import { describe, expect, it } from "vitest";
import { precheckListItems } from "../src/components/ax/AxReport";
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


  it("D번호가 하나만 언급된 항목은 해당 결정 지점을 확인 위치로 쓴다", () => {
    const items = precheckListItems(summary({
      checks: [{ topic: "D3 예외값 처리", status: "확인 필요", note: "", tone: "required" }],
    }));
    expect(items[0].target).toEqual({ kind: "decision", id: "D3" });
  });
});
