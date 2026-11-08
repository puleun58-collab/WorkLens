import { describe, expect, it } from "vitest";
import { orphanedCheckConfirmations, upsertCheckConfirmation } from "@/lib/ax/check-confirmations";

describe("이전 확인 기록 판정", () => {
  const NOW = "2026-11-08T12:00:00.000Z";

  it("현재 진단에 주제가 남은 기록은 고아가 아니고 사라진 주제의 기록만 고아로 분류한다", () => {
    let list = upsertCheckConfirmation(undefined, { topic: "가격 데이터 금요일 확정", note: "금요일 오후 3시" }, { result: "확인 완료", note: "담당자 확인" }, NOW);
    list = upsertCheckConfirmation(list, { topic: "승인 권한 확인", note: "팀장 승인" }, { result: "확인 완료", note: "" }, NOW);
    const orphaned = orphanedCheckConfirmations([{ topic: "가격 데이터 금요일 확정" }], list);
    expect(orphaned.map(entry => entry.topic)).toEqual(["승인 권한 확인"]);
    // 고아 기록 자체는 삭제되지 않고 결과·내용이 그대로 남는다.
    expect(orphaned[0].result).toBe("확인 완료");
    expect(orphaned[0].note).toBe("");
  });

  it("현재 확인 항목이 없으면 모든 기록이 고아이다", () => {
    const list = upsertCheckConfirmation(undefined, { topic: "가격 데이터 금요일 확정", note: "" }, { result: "확인 완료", note: "" }, NOW);
    expect(orphanedCheckConfirmations([], list)).toHaveLength(1);
    expect(orphanedCheckConfirmations(undefined, list)).toHaveLength(1);
  });

  it("기록이 없으면 빈 목록이다", () => {
    expect(orphanedCheckConfirmations([{ topic: "가격 데이터 금요일 확정" }], undefined)).toEqual([]);
    expect(orphanedCheckConfirmations(undefined, undefined)).toEqual([]);
  });
});
