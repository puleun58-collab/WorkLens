import { describe, expect, it } from "vitest";
import { applyCheckConfirmations, checkConfirmationState, upsertCheckConfirmation } from "@/lib/ax/check-confirmations";
import { executionGate } from "@/lib/ax/policy";
import { precheckListItems } from "@/components/ax/AxReport";
import { planSummary } from "@/lib/ax/guide";
import { diagnosisFixture } from "./fixtures/ax";

const NOW = "2026-11-01T00:00:00.000Z";
const base = { ...diagnosisFixture, decisionGate: { verdict: "go" as const, reasons: [] }, informationSufficiency: "sufficient" as const,
  technicalChecks: [{ topic: "파일 저장소 접근 권한", status: "확인 필요" as const, note: "공유 드라이브 접근 권한 확인 필요", required: true }] };
const check = base.technicalChecks[0];

describe("AX 기술 확인 항목 확인 기록", () => {
  it("근거가 있는 확인 완료만 확인됨으로 반영하고, 미확인·근거 없음·사용 불가는 확인됨이 아니다", () => {
    const done = upsertCheckConfirmation(undefined, check, { result: "확인 완료", note: "IT팀이 읽기·쓰기 권한 부여 확인" }, NOW);
    expect(checkConfirmationState(check, done)).toMatchObject({ kind: "applied", status: "확인됨" });
    expect(applyCheckConfirmations(base, done).technicalChecks[0]).toMatchObject({ status: "확인됨" });
    expect(applyCheckConfirmations(base, done).technicalChecks[0].note).toContain("담당자 확인: IT팀이 읽기·쓰기 권한 부여 확인");

    const pending = upsertCheckConfirmation(undefined, check, { result: "미확인", note: "IT팀에 문의 중" }, NOW);
    expect(checkConfirmationState(check, pending).kind).toBe("recorded");
    expect(applyCheckConfirmations(base, pending)).toBe(base);

    const noNote = upsertCheckConfirmation(undefined, check, { result: "확인 완료", note: "  " }, NOW);
    expect(checkConfirmationState(check, noNote).kind).toBe("recorded");

    const unavailable = upsertCheckConfirmation(undefined, check, { result: "사용 불가", note: "외부 계정 접근 금지 정책" }, NOW);
    expect(applyCheckConfirmations(base, unavailable).technicalChecks[0].status).toBe("불가");
  });

  it("확인 완료가 반영되면 Gate·구현 전 확인 건수가 함께 갱신되고, 원본 진단은 바뀌지 않는다", () => {
    expect(executionGate(base)).toBe("conditional");
    const before = precheckListItems(planSummary(base, undefined, "")).length;
    const done = upsertCheckConfirmation(undefined, check, { result: "확인 완료", note: "권한 확인" }, NOW);
    const effective = applyCheckConfirmations(base, done);
    expect(executionGate(effective)).toBe("ready");
    expect(precheckListItems(planSummary(effective, undefined, "")).length).toBe(before - 1);
    expect(base.technicalChecks[0].status).toBe("확인 필요");
  });

  it("재진단으로 원본 확인 내용이 바뀌면 기존 기록은 적용되지 않고 재확인 필요가 된다", () => {
    const done = upsertCheckConfirmation(undefined, check, { result: "확인 완료", note: "권한 확인" }, NOW);
    const changed = { ...check, note: "공유 드라이브와 SharePoint 모두 확인 필요" };
    expect(checkConfirmationState(changed, done).kind).toBe("stale");
    const rediagnosed = { ...base, technicalChecks: [changed] };
    expect(applyCheckConfirmations(rediagnosed, done)).toBe(rediagnosed);
  });

  it("같은 항목 기록은 교체되고, 다른 항목 기록은 유지된다", () => {
    const other = { topic: "보고서 템플릿 자동화", note: "템플릿 형식 확인 필요" };
    let list = upsertCheckConfirmation(undefined, other, { result: "미확인", note: "확인 예정" }, NOW);
    list = upsertCheckConfirmation(list, check, { result: "미확인", note: "1차" }, NOW);
    list = upsertCheckConfirmation(list, check, { result: "확인 완료", note: "2차 확인" }, NOW);
    expect(list).toHaveLength(2);
    expect(list.find(entry => entry.topic === check.topic)).toMatchObject({ result: "확인 완료", note: "2차 확인" });
  });
});
