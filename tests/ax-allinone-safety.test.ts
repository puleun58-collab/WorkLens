/** AX all-in-one prompt safety verification.
 * PART A: output-scope safety — PoC linking, HITL exclude/defer, Level×Gate bypass,
 * and PoC success/failure criteria must not leak excluded or unscoped items
 * into the implementable instruction.
 */
import { describe, expect, it } from "vitest";
import {
  buildAllInOnePrompt,
  buildAgentInstructionModel,
  stepIoSpec,
} from "../src/lib/ax/guide";
import { extractPlanReviewableItems, extractReviewableItems } from "../src/lib/ax/hitl";
import { dieselCase } from "./fixtures/diesel-case";
import type { AxDiagnosis, AxPlan, HitlReview } from "../src/lib/ax/types";
import { FACTOR_KEYS, REPOSITORY_FIRST } from "../src/lib/ax/schema";

const promptFor = (plan: AxPlan, diagnosis: AxDiagnosis, options: Record<string, unknown> = {}) =>
  buildAllInOnePrompt(plan, "codex", {
    taskName: dieselCase.name, diagnosis, context: "", ...options,
  });

/** Build a step-type review for excluding/deferring a diagnosis step. */
const makeStepReview = (stepName: string, overrides: Partial<HitlReview> = {}): HitlReview => {
  const items = extractReviewableItems(dieselCase.diagnosis);
  const item = items.find(i => i.type === "step" && i.text.startsWith(stepName));
  if (!item) throw new Error(`reviewable step not found: ${stepName}`);
  return {
    id: "safety-review",
    target: {
      type: "step",
      key: item.key,
      source: item.source,
      sourceText: item.text,
      sourceHash: item.sourceHash,
    },
    action: "exclude",
    status: "confirmed",
    reason: "사용자 제외 결정",
    reviewedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as HitlReview;
};

/** Build a planItem-type review for excluding a plan implementation item. */
const makePlanItemReview = (sourceText: string, overrides: Partial<HitlReview> = {}): HitlReview => {
  const items = extractPlanReviewableItems(dieselCase.plan, "codex");
  const item = items.find(i => i.text === sourceText);
  if (!item) throw new Error(`reviewable item not found: ${sourceText}`);
  return {
    id: "safety-review",
    target: {
      type: "planItem",
      key: item.key,
      source: item.source,
      sourceText: item.text,
      sourceHash: item.sourceHash,
    },
    action: "exclude",
    status: "confirmed",
    reason: "사용자 제외 결정",
    reviewedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as HitlReview;
};

describe("A-1: PoC output wrong-step linking prevention", () => {
  it("does not link a PoC output to multiple steps by keyword alone", () => {
    const model = buildAgentInstructionModel(dieselCase.plan, {
      taskName: dieselCase.name, diagnosis: dieselCase.diagnosis, context: "",
    });
    // "전주 대비 증감률" PoC output should link to the matching step only
    const linked: string[] = [];
    model.steps.forEach((s, i) => {
      const spec = stepIoSpec(model, i);
      if (spec.outputs.some(o => o.includes("전주 대비 증감률"))) linked.push(s.step);
    });
    expect(linked.length).toBeLessThanOrEqual(1);
  });

  it("does not promote an unrelated PoC output to a step's direct output", () => {
    // "보고서 업데이트" step shares no meaningful keyword with "주간 경유 가격 결과"
    // beyond generic words; it must stay as overall deliverable, not step output.
    const model = buildAgentInstructionModel(dieselCase.plan, {
      taskName: dieselCase.name, diagnosis: dieselCase.diagnosis, context: "",
    });
    const idx = model.steps.findIndex(s => s.step === "보고서 업데이트");
    expect(idx).toBeGreaterThanOrEqual(0);
    const spec = stepIoSpec(model, idx);
    // Step's own outputs must not claim the overall deliverable as directly produced
    expect(spec.outputs.some(o => o.includes("주간 경유 가격 결과"))).toBe(false);
    expect(spec.overallOutputs.some(o => o.includes("주간 경유 가격 결과"))).toBe(true);
  });
});

describe("A-2: step output vs overall deliverable separation", () => {
  it("labels overall deliverables distinctly from step-direct outputs", () => {
    const model = buildAgentInstructionModel(dieselCase.plan, {
      taskName: dieselCase.name, diagnosis: dieselCase.diagnosis, context: "",
    });
    const inputIdx = model.steps.findIndex(s => s.step === "가격 입력");
    const spec = stepIoSpec(model, inputIdx);
    // Input step produces nothing directly; overall deliverables are separate
    expect(spec.outputs).toEqual([]);
    expect(spec.overallOutputs.length).toBeGreaterThan(0);
  });

  it("does not present overall deliverable as step-direct output in prompt", () => {
    const prompt = promptFor(dieselCase.plan, dieselCase.diagnosis);
    // "### 기능 1. 가격 입력" block must not claim PoC outputs as its direct output
    const func1 = prompt.match(/### 기능 1\. 가격 입력[\s\S]*?(?=### 기능 2\.)/)?.[0] ?? "";
    expect(func1).not.toMatch(/- 출력: [^\n]*전주 대비 증감률/);
    // Overall deliverables are shown with a distinct label
    expect(prompt).toContain("업무 전체 산출물");
  });
});

describe("A-3: HITL exclude/defer bypass prevention", () => {
  it("excluded step does not reappear in implementation requirements", () => {
    const prompt = promptFor(dieselCase.plan, dieselCase.diagnosis, {
      hitlReviews: [makeStepReview("보고서 업데이트")], hitlTool: "codex",
    });
    // Excluded step → must not appear as an implementation requirement
    expect(prompt).not.toMatch(/### 요구사항 \d+\. 보고서 업데이트/);
    // Nor in the INPUT·PROCESS·OUTPUT function blocks
    expect(prompt).not.toMatch(/### 기능 \d+\. 보고서 업데이트/);
  });

  it("excluded step output is not rerouted as another step's output", () => {
    const model = buildAgentInstructionModel(dieselCase.plan, {
      taskName: dieselCase.name, diagnosis: dieselCase.diagnosis, context: "",
      hitlReviews: [makeStepReview("보고서 업데이트")], hitlTool: "codex",
    });
    // "보고서 업데이트" step excluded → its outputs must not be rerouted
    const idx = model.steps.findIndex(s => s.step === "보고서 업데이트");
    expect(idx).toBe(-1); // step itself removed
    // No remaining step should claim the excluded step's outputs
    model.steps.forEach((s, i) => {
      const spec = stepIoSpec(model, i);
      expect(spec.outputs.every(o => !o.includes("보고서"))).toBe(true);
    });
  });

  it("defer is not auto-resumed without resume conditions", () => {
    const deferReview = makeStepReview("보고서 업데이트", {
      action: "defer", reason: "보고서 양식 확인 필요", resumeCondition: "양식 확인 완료",
    });
    const prompt = promptFor(dieselCase.plan, dieselCase.diagnosis, {
      hitlReviews: [deferReview], hitlTool: "codex",
    });
    // Deferred step → not in implementation requirements
    expect(prompt).not.toMatch(/### 요구사항 \d+\. 보고서 업데이트/);
    expect(prompt).not.toMatch(/### 기능 \d+\. 보고서 업데이트/);
  });

  it("stale reviews are not applied like confirmed", () => {
    for (const status of ["stale", "pending", "editing"] as const) {
      const review = makeStepReview("보고서 업데이트", { status });
      const prompt = promptFor(dieselCase.plan, dieselCase.diagnosis, {
        hitlReviews: [review], hitlTool: "codex",
      });
      // Non-confirmed must not remove the step from implementation
      expect(prompt).toMatch(/### 기능 \d+\. 보고서 업데이트/);
    }
  });
});

describe("A-4: Level × Gate bypass prevention", () => {
  it("blocked gate does not leak implementation through completion criteria", () => {
    const blockedDiagnosis = {
      ...dieselCase.diagnosis,
      decisionGate: { verdict: "no-go", reasons: ["운영 정책 위반"] },
    } as unknown as AxDiagnosis;
    const prompt = promptFor(dieselCase.plan, blockedDiagnosis);
    // No implementation requirements in blocked state
    expect(prompt).not.toMatch(/### 요구사항 \d+\. 가격 입력/);
    // Completion criteria must not instruct implementation
    const criteria = prompt.match(/### 단계별 완료 기준[\s\S]*?(?=### |$)/)?.[0] ?? "";
    expect(criteria).not.toMatch(/구현·검증 완료/);
  });

  it("level 0 keeps review-only scope, no implementation steps", () => {
    // Level 0 case: all factors low → automationLevel 0
    const l0Diagnosis = {
      ...dieselCase.diagnosis,
      factors: FACTOR_KEYS.map(key => ({ key, aiValue: 1, rationale: "낮음" })),
    } as unknown as AxDiagnosis;
    const model = buildAgentInstructionModel(dieselCase.plan, {
      taskName: dieselCase.name, diagnosis: l0Diagnosis, context: "",
    });
    expect(model.scopeLevel).toBe(0);
    const work = model.steps.filter(s => s.scope === "implement" || s.scope === "after-check");
    expect(work.length).toBe(0);
  });

  it("level 1 allows user-initiated features but forbids unattended automation", () => {
    const prompt = promptFor(dieselCase.plan, dieselCase.diagnosis);
    expect(prompt).toMatch(/담당자가 실행을 요청하면|담당자 요청 기반/);
    expect(prompt).toMatch(/무인|스케줄러/); // prohibition present
    // No instruction to implement unattended execution
    expect(prompt).not.toMatch(/정기 무인 실행을 구현하세요/);
  });
});

describe("A-5: PoC success/failure criteria safety", () => {
  it("success criteria for excluded steps are not promoted to required", () => {
    // Exclude the calculation step via HITL, then check criteria
    const calcExclude = makeStepReview("전주 대비 증감률 계산");
    const prompt = promptFor(dieselCase.plan, dieselCase.diagnosis, {
      hitlReviews: [calcExclude], hitlTool: "codex",
    });
    // Excluded step's criteria must not appear as required completion criteria
    const overall = prompt.match(/### 업무 전체 완료 기준[\s\S]*?(?=### |$)/)?.[0] ?? "";
    expect(overall).not.toContain("증감률 계산이 담당자 수동 계산과 일치");
  });

  it("blocked-state PoC criteria are not presented as implementable", () => {
    const blockedDiagnosis = {
      ...dieselCase.diagnosis,
      decisionGate: { verdict: "no-go", reasons: ["운영 정책 위반"] },
    } as unknown as AxDiagnosis;
    const prompt = promptFor(dieselCase.plan, blockedDiagnosis);
    const overall = prompt.match(/### 업무 전체 완료 기준[\s\S]*?(?=### |$)/)?.[0] ?? "";
    // In blocked state, no implementable completion criteria for PoC deliverables
    expect(overall).not.toContain("증감률 계산이 담당자 수동 계산과 일치");
  });
});
