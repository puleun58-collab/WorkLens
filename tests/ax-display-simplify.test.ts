import { describe, expect, it } from "vitest";
import { dedupeHumanItems, foldMethodLabel, foldScopeItems, reviewDisplayState, validConfirmedKeySet } from "../src/components/ax/AxReport";
import { planSummary } from "../src/lib/ax/guide";
import { extractPlanReviewableItems, extractReviewableItems, type ReviewableItem } from "../src/lib/ax/hitl";
import { executionGate } from "../src/lib/ax/policy";
import { diagnosisFixture, planFixture } from "./fixtures/ax";
import { dieselCase } from "./fixtures/diesel-case";
import type { AxDiagnosis, HitlReview } from "../src/lib/ax/types";

const UNCONFIRMED = "처리 방식 미확정 · 확인 후 진행\n처리 방식의 구체적 근거가 확인되지 않았습니다. 실제 처리 규칙·입력 형식을 먼저 확인하고, 확인 전에는 해당 처리만 보류하세요. 확인과 무관한 독립 단계는 계속 진행할 수 있습니다.";

describe("⑥⑨ 처리 방식 장문 설명 접기 (표시 전용)", () => {
  it("미확정 라벨은 첫 줄만 남기고 unconfirmed로 표시한다", () => {
    const result = foldMethodLabel(`가격 입력 ${UNCONFIRMED}`);
    expect(result.text).toBe("가격 입력 처리 방식 미확정 · 확인 후 진행");
    expect(result.unconfirmed).toBe(true);
  });

  it("근거 충돌 라벨은 제목·근거(고유 정보)를 유지하고 공통 지시만 접는다", () => {
    const label = "자료 수집 처리 방식 근거 충돌 · 확인 후 진행\n충돌된 근거: API 처리와 수동 입력이 함께 제시됨\n충돌을 해결하기 전에는 처리 방식을 임의로 선택·구현하지 마세요. 확인과 무관한 독립 단계는 계속 진행할 수 있습니다.";
    const result = foldMethodLabel(label);
    expect(result.text).toBe("자료 수집 처리 방식 근거 충돌 · 확인 후 진행 충돌된 근거: API 처리와 수동 입력이 함께 제시됨");
    expect(result.unconfirmed).toBe(false);
  });

  it("한 줄 라벨은 그대로 둔다", () => {
    expect(foldMethodLabel("가격 입력 일반 시스템·스크립트 처리")).toEqual({ text: "가격 입력 일반 시스템·스크립트 처리", unconfirmed: false });
  });

  it("여러 항목에 동일하게 반복되는 괄호 조건은 공통 안내로 한 번만 표시한다", () => {
    const result = foldScopeItems([
      "전주 대비 증감률 계산 규칙 기반 처리 (규칙 확인 후 담당자 요청 시 실행·결과는 담당자 확인 후 확정)",
      "월평균 계산 규칙 기반 처리 (규칙 확인 후 담당자 요청 시 실행·결과는 담당자 확인 후 확정)",
      "가격 입력 일반 시스템·스크립트 처리 (담당자 요청 시 실행·형식·병합 키·예외 기준 확인 후 구현)",
    ]);
    expect(result.items).toEqual([
      "전주 대비 증감률 계산 규칙 기반 처리",
      "월평균 계산 규칙 기반 처리",
      "가격 입력 일반 시스템·스크립트 처리 (담당자 요청 시 실행·형식·병합 키·예외 기준 확인 후 구현)",
    ]);
    expect(result.notes).toEqual(["규칙 확인 후 담당자 요청 시 실행·결과는 담당자 확인 후 확정"]);
    expect(result.unconfirmed).toBe(false);
  });

  it("미확정 항목이 있으면 unconfirmed를 알리고 단계명은 유지한다", () => {
    const result = foldScopeItems([`공유 폴더 파일 수집 ${UNCONFIRMED}`, "담당자 검토 흐름 확인"]);
    expect(result.items[0]).toBe("공유 폴더 파일 수집 처리 방식 미확정 · 확인 후 진행");
    expect(result.items[1]).toBe("담당자 검토 흐름 확인");
    expect(result.unconfirmed).toBe(true);
  });
});

describe("⑪ 담당자 수행 중복 정리 (표시 전용)", () => {
  it("같은 행위를 다르게 쓴 항목은 하나로 표시한다", () => {
    expect(dedupeHumanItems(["담당자가 최종 수치를 검토한다", "최종 수치 검토"])).toEqual(["담당자가 최종 수치를 검토한다"]);
    expect(dedupeHumanItems(["가격 수집 오류 시 수동 보완", "가격 데이터 수집 오류 시 수동 보완"])).toEqual(["가격 수집 오류 시 수동 보완"]);
    expect(dedupeHumanItems(["최종 승인 (담당자 수행)", "담당자 최종 승인"])).toEqual(["최종 승인 (담당자 수행)"]);
  });

  it("최종 검토와 최종 승인처럼 다른 요건은 합치지 않는다", () => {
    expect(dedupeHumanItems(["최종 검토", "최종 승인"])).toEqual(["최종 검토", "최종 승인"]);
    expect(dedupeHumanItems(["담당자 최종 검토·승인", "최종 승인 (담당자 수행)"])).toEqual(["담당자 최종 검토·승인", "최종 승인 (담당자 수행)"]);
  });

  it("일반 수동 처리와 오류 시 수동 보완은 다른 절차로 유지한다", () => {
    expect(dedupeHumanItems(["가격 입력 수동 보완", "가격 수집 오류 시 수동 보완"])).toEqual(["가격 입력 수동 보완", "가격 수집 오류 시 수동 보완"]);
    expect(dedupeHumanItems(["답변 발송 (담당자 수행)", "답변 발송 전 담당자 확인"])).toEqual(["답변 발송 (담당자 수행)", "답변 발송 전 담당자 확인"]);
  });

  it("부정 표현이 다르면 합치지 않는다", () => {
    expect(dedupeHumanItems(["데이터 누락", "데이터 누락 없음"])).toEqual(["데이터 누락", "데이터 누락 없음"]);
  });
});

describe("① 02 진행 보류 배지의 데이터 조건", () => {
  const withGate = (verdict: "go" | "conditional" | "no-go", checks: AxDiagnosis["technicalChecks"] = []): AxDiagnosis => ({
    ...diagnosisFixture,
    decisionGate: { verdict, reasons: verdict === "no-go" ? ["승인권자 미지정"] : [] },
    technicalChecks: checks,
  });

  it("Gate blocked일 때만 blockReasons가 채워진다", () => {
    expect(executionGate(withGate("no-go"))).toBe("blocked");
    expect(planSummary(withGate("no-go")).blockReasons).toContain("승인권자 미지정");
  });

  it("Gate conditional·ready에서는 blockReasons가 비어 전체 보류 배지가 표시되지 않는다", () => {
    const conditional = withGate("conditional", [{ topic: "데이터 형식", status: "확인 필요", note: "" }]);
    expect(executionGate(conditional)).toBe("conditional");
    expect(planSummary(conditional).blockReasons).toEqual([]);
    const ready = withGate("go", [{ topic: "데이터 형식", status: "확인됨", note: "" }]);
    expect(executionGate(ready)).toBe("ready");
    expect(planSummary(ready).blockReasons).toEqual([]);
  });

  it("개별 조건이 불가여도 전체 Gate와 분리된다 (조건 자체의 상태는 유지)", () => {
    const diagnosis = withGate("conditional", [{ topic: "외부 연동", status: "불가", note: "정책상 불가", required: false }]);
    expect(executionGate(diagnosis)).toBe("conditional");
    const summary = planSummary(diagnosis);
    expect(summary.blockReasons).toEqual([]);
    expect(summary.checks.find(check => check.topic === "외부 연동")?.tone).toBe("blocked");
  });
});

describe("② 03 담당자 승인 필요 배지의 데이터 조건", () => {
  it("담당자 수행 항목만 있고 명시적 승인 근거가 없으면 approvals는 비어 있다 (경유 사례)", () => {
    const summary = planSummary(dieselCase.diagnosis, dieselCase.diagnosis.planCodex, dieselCase.name);
    expect(summary.humanKept.length).toBeGreaterThan(0);
    expect(summary.approvals).toEqual([]);
  });
});

describe("⑤ 구현 계획 검토 유효 완료 집계", () => {
  const items: ReviewableItem[] = extractPlanReviewableItems(planFixture, "codex");
  const reviewFor = (item: ReviewableItem, patch: Partial<HitlReview> = {}): HitlReview => ({
    id: `r-${item.key}`,
    target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash },
    action: "keep",
    status: "confirmed",
    reviewedAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    ...patch,
  });

  it("검토 기록이 없으면 전부 검토 전이다", () => {
    const valid = validConfirmedKeySet(items, []);
    expect(valid.size).toBe(0);
    for (const item of items) {
      expect(reviewDisplayState(item, undefined, valid)).toEqual({ status: "pending", label: "검토 전" });
    }
  });

  it("현재 원본과 해시가 일치하는 confirmed만 검토 완료로 집계한다", () => {
    const reviews = [reviewFor(items[0]), reviewFor(items[1])];
    const valid = validConfirmedKeySet(items, reviews);
    expect(valid.size).toBe(2);
    expect(reviewDisplayState(items[0], reviews[0], valid)).toEqual({ status: "confirmed", label: "검토 완료" });
    expect(reviewDisplayState(items[2], undefined, valid).status).toBe("pending");
  });

  it("해시가 불일치하는 confirmed는 검토 완료가 아니라 재확인 필요다", () => {
    const stale = reviewFor(items[0], { target: { type: items[0].type, key: items[0].key, source: items[0].source, sourceText: items[0].text, sourceHash: "0".repeat(64) } });
    const valid = validConfirmedKeySet(items, [stale]);
    expect(valid.size).toBe(0);
    expect(reviewDisplayState(items[0], stale, valid)).toEqual({ status: "stale", label: "재확인 필요" });
  });

  it("stale·editing 기록은 완료로 세지 않고 상태 문구를 구분한다", () => {
    const stale = reviewFor(items[0], { status: "stale" });
    const editing = reviewFor(items[1], { status: "editing" });
    const valid = validConfirmedKeySet(items, [stale, editing]);
    expect(valid.size).toBe(0);
    expect(reviewDisplayState(items[0], stale, valid)).toEqual({ status: "stale", label: "재확인 필요" });
    expect(reviewDisplayState(items[1], editing, valid)).toEqual({ status: "editing", label: "보완 중" });
  });

  it("다른 도구(Claude)의 확정 기록은 Codex 항목 집계에 섞이지 않는다", () => {
    const claudeItems = extractPlanReviewableItems(planFixture, "claude");
    const claudeReviews = claudeItems.map(item => reviewFor(item));
    const valid = validConfirmedKeySet(items, claudeReviews);
    expect(valid.size).toBe(0);
  });
});

describe("⑤-2 단계별 판단·위험 검토도 같은 유효성 집계를 쓴다", () => {
  const allItems = extractReviewableItems(diagnosisFixture);
  const stepItems = allItems.filter(item => item.type === "step");
  const riskItems = allItems.filter(item => item.type === "risk");
  const reviewFor = (item: ReviewableItem, patch: Partial<HitlReview> = {}): HitlReview => ({
    id: `r-${item.key}`,
    target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash },
    action: "keep",
    status: "confirmed",
    reviewedAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    ...patch,
  });

  it("단계 항목: 유효 confirmed만 완료, editing·stale·해시 불일치는 재확인/보완으로 구분된다", () => {
    const reviews = [
      reviewFor(stepItems[0]),
      reviewFor(stepItems[1], { status: "editing" }),
      reviewFor(stepItems[2], { target: { type: stepItems[2].type, key: stepItems[2].key, source: stepItems[2].source, sourceText: stepItems[2].text, sourceHash: "0".repeat(64) } }),
    ];
    const valid = validConfirmedKeySet(stepItems, reviews);
    expect(valid.size).toBe(1);
    expect(stepItems.filter(item => valid.has(item.key)).length).toBe(1);
    expect(reviewDisplayState(stepItems[0], reviews[0], valid)).toEqual({ status: "confirmed", label: "검토 완료" });
    expect(reviewDisplayState(stepItems[1], reviews[1], valid)).toEqual({ status: "editing", label: "보완 중" });
    expect(reviewDisplayState(stepItems[2], reviews[2], valid)).toEqual({ status: "stale", label: "재확인 필요" });
  });

  it("위험 항목: 기록 없음은 검토 전, stale은 재확인 필요이며 완료로 세지 않는다", () => {
    expect(riskItems.length).toBeGreaterThan(0);
    const stale = reviewFor(riskItems[0], { status: "stale" });
    const valid = validConfirmedKeySet(riskItems, [stale]);
    expect(valid.size).toBe(0);
    expect(reviewDisplayState(riskItems[0], stale, valid)).toEqual({ status: "stale", label: "재확인 필요" });
    expect(reviewDisplayState(riskItems[0], undefined, valid)).toEqual({ status: "pending", label: "검토 전" });
    const pending = reviewFor(riskItems[0], { status: "pending" });
    expect(reviewDisplayState(riskItems[0], pending, validConfirmedKeySet(riskItems, [pending]))).toEqual({ status: "pending", label: "검토 전" });
  });

  it("단계 검토 기록이 위험 항목 집계에 섞이지 않는다", () => {
    const stepReviews = stepItems.map(item => reviewFor(item));
    expect(validConfirmedKeySet(riskItems, stepReviews).size).toBe(0);
  });
});
