import { describe, it, expect } from "vitest";
import { buildAgentInstructionModel, buildAllInOnePrompt } from "../src/lib/ax/guide";
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
    expect(model2.hitlApplied).toBe(false);
  });

  it("exclude 검토가 정확한 대상을 제거", () => {
    // 실제 검토 대상 추출 결과 사용
    const items = extractPlanReviewableItems(mockPlan, "codex");
    const targetItem = items.find(item => item.text === "제외할 기능");
    expect(targetItem).toBeDefined();

    const review = makeReview({
      action: "exclude",
      target: {
        type: "planItem",
        key: targetItem!.key,
        source: "planCodex",
        sourceText: targetItem!.text,
        sourceHash: targetItem!.sourceHash,
      },
    });

    const modelWithout = buildAgentInstructionModel(mockPlan, {});
    const modelWith = buildAgentInstructionModel(mockPlan, {
      hitlReviews: [review],
      hitlTool: "codex",
    });

    // 정확한 대상이 제거되었는지 확인
    const withoutTexts = modelWithout.classified.map(c => c.text);
    const withTexts = modelWith.classified.map(c => c.text);

    // "제외할 기능" 관련 항목이 제거됨
    const excludedGone = withoutTexts.some(t => t.includes("제외할 기능")) &&
                        !withTexts.some(t => t.includes("제외할 기능"));
    expect(excludedGone).toBe(true);

    // 무관한 항목은 유지됨
    expect(withTexts.some(t => t.includes("로그인 기능"))).toBe(true);
    expect(withTexts.some(t => t.includes("대시보드"))).toBe(true);

    // hitlApplied가 실제 적용을 반영
    expect(modelWith.hitlApplied).toBe(true);
  });

  it("다른 도구의 검토는 적용하지 않음", () => {
    const items = extractPlanReviewableItems(mockPlan, "claude");
    const review = makeReview({
      target: {
        type: "planItem",
        key: "planItem:planClaude:xyz789",
        source: "planClaude",
        sourceText: "제외할 기능",
        sourceHash: "hash456",
      },
    });
    const modelWithout = buildAgentInstructionModel(mockPlan, {});
    const modelWith = buildAgentInstructionModel(mockPlan, {
      hitlReviews: [review],
      hitlTool: "codex", // Claude 검토를 Codex에 적용 시도
    });
    // 도구 불일치로 적용되지 않음 - 항목 수 동일
    expect(modelWith.classified.length).toBe(modelWithout.classified.length);
    expect(modelWith.hitlApplied).toBe(false);
  });

  it("pending 상태는 적용하지 않음", () => {
    const review = makeReview({ status: "pending" });
    const modelWithout = buildAgentInstructionModel(mockPlan, {});
    const modelWith = buildAgentInstructionModel(mockPlan, {
      hitlReviews: [review],
      hitlTool: "codex",
    });
    expect(modelWith.classified.length).toBe(modelWithout.classified.length);
    expect(modelWith.hitlApplied).toBe(false);
  });

  it("부분 문자열 매칭으로 오적용 방지", () => {
    // 비슷한 문구의 다른 항목이 있으면 정확한 것만 제외
    const planWithSimilar = {
      implementation: ["로그인 기능 구현", "로그인 기능 테스트", "제외할 기능"],
      acceptance: [],
      tests: [],
    } as unknown as AxPlan;

    const items = extractPlanReviewableItems(planWithSimilar, "codex");
    const targetItem = items.find(item => item.text === "제외할 기능");

    const review = makeReview({
      action: "exclude",
      target: {
        type: "planItem",
        key: targetItem!.key,
        source: "planCodex",
        sourceText: targetItem!.text,
        sourceHash: targetItem!.sourceHash,
      },
    });

    const model = buildAgentInstructionModel(planWithSimilar, {
      hitlReviews: [review],
      hitlTool: "codex",
    });

    const texts = model.classified.map(c => c.text);
    // "제외할 기능"만 제거되고 "로그인 기능 구현/테스트"는 유지
    expect(texts.some(t => t.includes("제외할 기능"))).toBe(false);
    expect(texts.some(t => t.includes("로그인 기능 구현"))).toBe(true);
  });

  it("지시문에서 제외된 항목이 재등장하지 않음", () => {
    const items = extractPlanReviewableItems(mockPlan, "codex");
    const targetItem = items.find(item => item.text === "제외할 기능");

    const review = makeReview({
      action: "exclude",
      target: {
        type: "planItem",
        key: targetItem!.key,
        source: "planCodex",
        sourceText: targetItem!.text,
        sourceHash: targetItem!.sourceHash,
      },
    });

    const prompt = buildAllInOnePrompt(mockPlan, "codex", {
      hitlReviews: [review],
      hitlTool: "codex",
    });

    // 지시문에 제외된 항목이 구현 대상으로 나타나지 않음
    // (단순 문자열 검사가 아닌, 구현 섹션에서의 등장 여부)
    // 계획 항목 제외는 사람 검토 구간에 명시적으로 나열되므로(§8 결함 수정),
    // 사람 검토 반영 블록은 구현 섹션이 아니어서 계수에서 제외한다.
    const withoutReviewBlock = (prompt: string): string => {
      const start = prompt.indexOf("### 사람 검토 반영");
      if (start < 0) return prompt;
      const rest = prompt.slice(start);
      const next = rest.search(/\n## \d+\. /u);
      return next < 0 ? prompt.slice(0, start) : prompt.slice(0, start) + rest.slice(next);
    };
    const lines = withoutReviewBlock(prompt).split("\n");
    const implSection = lines.filter(line =>
      line.includes("구현") || line.includes("작업")
    ).join(" ");
    // 제외된 기능이 구현 지시로 나타나지 않아야 함
    expect(implSection.includes("제외할 기능")).toBe(false);
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
