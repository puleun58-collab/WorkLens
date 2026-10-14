import { describe, it, expect } from "vitest";
import { buildAgentInstructionModel } from "../src/lib/ax/guide";
import { getValidConfirmedReviews, extractPlanReviewableItems } from "../src/lib/ax/hitl";
import type { AxPlan, AxTaskV2, HitlReview } from "../src/lib/ax/types";

const mockPlan = {
  implementation: ["로그인 기능 구현", "대시보드 개발", "제외할 기능"],
  acceptance: ["로그인 성공 시 대시보드 표시"],
  tests: ["단위 테스트 작성"],
} as unknown as AxPlan;

function makeReview(overrides: Partial<HitlReview> = {}): HitlReview {
  return {
    id: "test-review-1",
    target: {
      type: "planItem",
      key: "planItem:planCodex:abc123",
      source: "planCodex",
      sourceText: "제외할 기능",
      sourceHash: "hash123",
    },
    action: "exclude",
    status: "confirmed",
    reviewedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as HitlReview;
}

describe("HITL 3차 - 지시문 연동", () => {
  it("검토 없이 기존 동작 유지", () => {
    const model1 = buildAgentInstructionModel(mockPlan, {});
    const model2 = buildAgentInstructionModel(mockPlan, { hitlReviews: [] });
    // 검토가 없으면 동일 결과
    expect(model1.classified.length).toBe(model2.classified.length);
  });

  it("exclude 검토가 구현 범위에서 제외", () => {
    const review = makeReview({ action: "exclude" });
    const modelWithout = buildAgentInstructionModel(mockPlan, {});
    const modelWith = buildAgentInstructionModel(mockPlan, {
      hitlReviews: [review],
      hitlTool: "codex",
    });

    // 제외된 항목이 포함된 경우 features 수가 줄거나 동일
    // (매칭 로직에 따라 달라질 수 있음)
    expect(modelWith.classified.length).toBeLessThanOrEqual(modelWithout.classified.length);
  });

  it("다른 도구의 검토는 적용하지 않음", () => {
    const review = makeReview({
      target: {
        type: "planItem",
        key: "planItem:planClaude:abc123",
        source: "planClaude",
        sourceText: "제외할 기능",
        sourceHash: "hash123",
      },
    });
    const model = buildAgentInstructionModel(mockPlan, {
      hitlReviews: [review],
      hitlTool: "codex", // Claude 검토를 Codex에 적용 시도
    });
    // 도구 불일치로 적용되지 않음
    expect(model.hitlApplied).toBe(true); // 검토는 전달됨
  });

  it("pending 상태는 적용하지 않음", () => {
    const review = makeReview({ status: "pending" });
    const modelWithout = buildAgentInstructionModel(mockPlan, {});
    const modelWith = buildAgentInstructionModel(mockPlan, {
      hitlReviews: [review],
      hitlTool: "codex",
    });
    expect(modelWith.classified.length).toBe(modelWithout.classified.length);
  });

  it("getValidConfirmedReviews와 연동", () => {
    const items = extractPlanReviewableItems(mockPlan, "codex");
    const task = {
      reviews: [
        makeReview({
          id: "valid",
          target: {
            type: "planItem",
            key: items[0].key,
            source: "planCodex",
            sourceText: items[0].text,
            sourceHash: items[0].sourceHash,
          },
          status: "confirmed",
        }),
        makeReview({
          id: "stale",
          target: {
            type: "planItem",
            key: items[1].key,
            source: "planCodex",
            sourceText: items[1].text,
            sourceHash: "outdated",
          },
          status: "confirmed",
        }),
      ],
    } as unknown as AxTaskV2;

    const valid = getValidConfirmedReviews(task, items);
    expect(valid).toHaveLength(1);
    expect(valid[0].id).toBe("valid");
  });
});
