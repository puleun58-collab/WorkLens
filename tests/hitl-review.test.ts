import { describe, it, expect } from "vitest";
import {
  hashSource,
  makeTargetKey,
  extractReviewableItems,
  extractPlanReviewableItems,
  canTransition,
  shouldMarkStale,
  findReview,
  getConfirmedReviews,
  reconcileReviews,
} from "../src/lib/ax/hitl";
import type { AxDiagnosis, AxPlan, AxTaskV2, HitlReview } from "../src/lib/ax/types";

const mockDiagnosis = {
  stepAssessments: [
    { step: "데이터 입력", verdict: "자동화", owner: "시스템", note: "정형 데이터" },
    { step: "검토 승인", verdict: "사람 유지", owner: "사용자", note: "판단 필요" },
  ],
  risks: ["데이터 유출 위험"],
  technicalChecks: [
    { topic: "API 연동", status: "확인 필요", note: "엔드포인트 확인" },
    { topic: "DB 접근", status: "확인됨", note: "정상" },
  ],
} as unknown as AxDiagnosis;

const mockPlan = {
  implementation: ["로그인 기능 구현", "대시보드 개발"],
  acceptance: ["로그인 성공 시 대시보드 표시"],
  tests: ["단위 테스트 작성"],
} as unknown as AxPlan;

describe("HITL review logic", () => {
  it("hashSource produces consistent hashes", () => {
    expect(hashSource("test")).toBe(hashSource("test"));
    expect(hashSource("test")).not.toBe(hashSource("test2"));
    // whitespace normalization
    expect(hashSource("  test  ")).toBe(hashSource("test"));
  });

  it("makeTargetKey is stable", () => {
    const k1 = makeTargetKey("step", "diagnosis", "데이터 입력");
    const k2 = makeTargetKey("step", "diagnosis", "데이터 입력");
    expect(k1).toBe(k2);
    expect(makeTargetKey("step", "diagnosis", "A")).not.toBe(makeTargetKey("step", "diagnosis", "B"));
    // tool distinction
    expect(makeTargetKey("planItem", "planCodex", "X")).not.toBe(makeTargetKey("planItem", "planClaude", "X"));
  });

  it("extractReviewableItems from diagnosis", () => {
    const items = extractReviewableItems(mockDiagnosis);
    // 2 steps + 1 risk + 1 technical check (확인 필요만)
    expect(items).toHaveLength(4);
    expect(items.filter(i => i.type === "step")).toHaveLength(2);
    expect(items.filter(i => i.type === "risk")).toHaveLength(2);
  });

  it("extractPlanReviewableItems distinguishes tools", () => {
    const codexItems = extractPlanReviewableItems(mockPlan, "codex");
    const claudeItems = extractPlanReviewableItems(mockPlan, "claude");
    expect(codexItems).toHaveLength(4); // 2 planItem + 2 criterion
    expect(claudeItems).toHaveLength(4);
    // keys differ by source
    expect(codexItems[0].key).not.toBe(claudeItems[0].key);
    expect(codexItems[0].source).toBe("planCodex");
    expect(claudeItems[0].source).toBe("planClaude");
  });

  it("canTransition validates status changes", () => {
    expect(canTransition("pending", "editing")).toBe(true);
    expect(canTransition("editing", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "stale")).toBe(true);
    expect(canTransition("stale", "confirmed")).toBe(true);
    expect(canTransition("pending", "confirmed")).toBe(false);
    expect(canTransition("confirmed", "pending")).toBe(false);
  });

  it("shouldMarkStale only for confirmed with changed hash", () => {
    const review = {
      status: "confirmed",
      target: { sourceHash: "abc123" },
    } as unknown as HitlReview;
    expect(shouldMarkStale(review, "abc123")).toBe(false);
    expect(shouldMarkStale(review, "different")).toBe(true);

    const pending = { ...review, status: "pending" } as unknown as HitlReview;
    expect(shouldMarkStale(pending, "different")).toBe(false);
  });

  it("findReview and getConfirmedReviews", () => {
    const task = {
      reviews: [
        { target: { key: "k1" }, status: "confirmed" },
        { target: { key: "k2" }, status: "pending" },
      ],
    } as unknown as AxTaskV2;
    expect(findReview(task, "k1")?.status).toBe("confirmed");
    expect(findReview(task, "k3")).toBeUndefined();
    expect(getConfirmedReviews(task)).toHaveLength(1);
  });

  it("duplicate text gets distinct keys", () => {
    const dupDiagnosis = {
      stepAssessments: [
        { step: "데이터 입력", verdict: "자동화", owner: "시스템", note: "" },
        { step: "데이터 입력", verdict: "자동화", owner: "시스템", note: "" },
      ],
      risks: [],
      technicalChecks: [],
    } as unknown as AxDiagnosis;
    const items = extractReviewableItems(dupDiagnosis);
    expect(items).toHaveLength(2);
    expect(items[0].key).not.toBe(items[1].key);
  });

  it("reconcileReviews distinguishes matched/changed/gone", () => {
    const items = extractReviewableItems(mockDiagnosis);
    const reviews = items.map((item, i) => ({
      id: `r${i}`,
      target: { key: item.key, sourceHash: item.sourceHash, type: item.type, source: item.source, sourceText: item.text },
      status: "confirmed",
      action: "keep",
      reviewedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })) as unknown as HitlReview[];

    // 동일한 원본 → matched
    const result1 = reconcileReviews(reviews, items);
    for (const [, v] of result1) {
      expect(v.status).toBe("matched");
    }

    // 원본 변경 → changed
    const changedItems = items.map(it => ({ ...it, sourceHash: "different-hash" }));
    const result2 = reconcileReviews(reviews, changedItems);
    for (const [, v] of result2) {
      expect(v.status).toBe("changed");
    }

    // 대상 소멸 → gone
    const result3 = reconcileReviews(reviews, []);
    for (const [, v] of result3) {
      expect(v.status).toBe("gone");
    }
  });

  it("canTransition allows confirmed->editing and stale->confirmed", () => {
    expect(canTransition("confirmed", "editing")).toBe(true);
    expect(canTransition("stale", "editing")).toBe(true);
    expect(canTransition("stale", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "pending")).toBe(false);
  });
});
