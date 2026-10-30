import { describe, expect, it } from "vitest";
import { resolveActiveTool } from "@/components/ax/AxReport";
import { extractPlanReviewableItems, findReview } from "@/lib/ax/hitl";
import type { AxPlan, AxTaskV2, HitlReview } from "@/lib/ax/types";
import { planFixture } from "./fixtures/ax";

const codexPlan: AxPlan = { ...planFixture, implementation: ["Codex 계획 항목"] };
const claudePlan: AxPlan = { ...planFixture, implementation: ["Claude 계획 항목"] };

describe("AX coding tool selection (구현 계획 검토 ↔ 올인원 지시문 공통 상태)", () => {
  it("명시적 선택이 없으면 계획이 존재하는 도구를 선택 (둘 다 있으면 Codex 우선)", () => {
    expect(resolveActiveTool(null, { codex: codexPlan, claude: claudePlan })).toBe("codex");
    expect(resolveActiveTool(null, { codex: codexPlan, claude: undefined })).toBe("codex");
    expect(resolveActiveTool(null, { codex: undefined, claude: claudePlan })).toBe("claude");
  });

  it("두 도구 모두 계획이 없으면 기본값을 유지", () => {
    expect(resolveActiveTool(null, {})).toBe("claude");
  });

  it("명시적 도구 선택은 계획 존재 여부와 무관하게 유지 (전환 후 다른 계획 생성 가능)", () => {
    // Codex 계획만 있는 상태에서 Claude 탭으로 전환 → Claude 계획 생성 유도
    expect(resolveActiveTool("claude", { codex: codexPlan, claude: undefined })).toBe("claude");
    expect(resolveActiveTool("codex", { codex: undefined, claude: claudePlan })).toBe("codex");
    // 양쪽 계획이 있어도 명시적 선택이 우선
    expect(resolveActiveTool("claude", { codex: codexPlan, claude: claudePlan })).toBe("claude");
  });

  it("도구별 구현 계획 내용이 구분됨", () => {
    const codexItems = extractPlanReviewableItems(codexPlan, "codex");
    const claudeItems = extractPlanReviewableItems(claudePlan, "claude");
    expect(codexItems.map(i => i.text)).toContain("Codex 계획 항목");
    expect(claudeItems.map(i => i.text)).toContain("Claude 계획 항목");
    expect(codexItems.map(i => i.text)).not.toContain("Claude 계획 항목");
    expect(claudeItems.map(i => i.text)).not.toContain("Codex 계획 항목");
  });

  it("도구별 검토 키가 분리되어 확정 상태가 도구 전환 후에도 유지됨 (복사·합치기 금지)", () => {
    const codexItems = extractPlanReviewableItems(codexPlan, "codex");
    const claudeItems = extractPlanReviewableItems(claudePlan, "claude");
    // 동일 문구라도 도구별 키는 다름
    expect(codexItems.every(i => i.source === "planCodex")).toBe(true);
    expect(claudeItems.every(i => i.source === "planClaude")).toBe(true);
    const codexKeys = new Set(codexItems.map(i => i.key));
    expect(claudeItems.every(i => !codexKeys.has(i.key))).toBe(true);

    // Codex 검토 확정 → Claude 키로는 조회되지 않음
    const confirmed: HitlReview = {
      id: "review-1",
      target: { key: codexItems[0].key, type: codexItems[0].type, source: "planCodex", sourceText: codexItems[0].text, sourceHash: codexItems[0].sourceHash },
      action: "keep",
      status: "confirmed",
      reviewedAt: "2026-10-19T00:00:00.000Z",
      updatedAt: "2026-10-19T00:00:00.000Z",
    };
    const task = { reviews: [confirmed] } as AxTaskV2;
    expect(findReview(task, codexItems[0].key)?.status).toBe("confirmed");
    // Claude 도구의 동일 항목 키로는 Codex 확정 결과가 조회되지 않음
    expect(findReview(task, claudeItems[0].key)).toBeUndefined();
  });
});
