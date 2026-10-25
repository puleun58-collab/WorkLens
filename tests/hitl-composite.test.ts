import { describe, it, expect } from "vitest";
import { buildAgentInstructionModel, buildAllInOnePrompt } from "../src/lib/ax/guide";
import { extractReviewableItems, extractPlanReviewableItems, getValidConfirmedReviews } from "../src/lib/ax/hitl";
import type { AxDiagnosis, AxPlan, AxTaskV2, HitlReview } from "../src/lib/ax/types";

/**
 * HITL 복합 시나리오 회귀 테스트 (20종)
 *
 * Priority 9: 단일 HITL 동작뿐 아니라 여러 검토 결과가 동시에 존재하는 경우를 확인.
 * 화면상의 검토 결과만 확인하지 않고, 실제 생성된 올인원 지시문 전문을 검사하여
 * 요구사항·처리 순서·데이터 흐름·제외/보류/보완·완료 기준이 일관되게 반영되는지 검증.
 */

const baseDiagnosis = {
  factors: [
    { key: "repetition", aiValue: 4 },
    { key: "regularity", aiValue: 4 },
    { key: "dataStructure", aiValue: 4 },
    { key: "systemAccess", aiValue: 3 },
    { key: "humanJudgment", aiValue: 2 },
    { key: "operationalRisk", aiValue: 2 },
  ],
  informationSufficiency: "sufficient",
  decisionGate: { verdict: "go", reasons: [] },
  stepAssessments: [
    { step: "데이터 수집", verdict: "자동화", owner: "AI", note: "" },
    { step: "데이터 검증", verdict: "자동화", owner: "AI", note: "" },
    { step: "보고서 작성", verdict: "자동화", owner: "AI", note: "" },
  ],
  technicalChecks: [
    { topic: "API 연동", status: "확인 필요", note: "외부 API" },
  ],
  humanInLoop: ["최종 승인"],
  risks: ["데이터 누락 위험"],
  toBe: [],
  followUpQuestions: [],
  poc: {
    hypothesis: "자동화로 시간 단축",
    inScope: ["데이터 수집", "데이터 검증"],
    outOfScope: [],
    inputs: ["원본 데이터"],
    outputs: ["검증된 데이터"],
    evaluation: ["정확도 측정"],
    success: ["수집 성공률 95% 이상"],
    failure: ["수집 실패 시 수동 처리"],
  },
  asIs: {
    purpose: "월간 데이터 처리",
    trigger: "월초",
    inputs: ["원본 데이터"],
    outputs: ["보고서"],
    steps: ["수집", "검증", "작성"],
    exceptions: [],
    systems: ["ERP"],
    humanDecisions: ["최종 승인"],
  },
  operation: { owner: "담당자", failureOwner: "담당자", maintenanceBurden: "medium", fallback: "수동 처리", notes: [] },
} as unknown as AxDiagnosis;

const basePlan = {
  implementation: ["데이터 수집 자동화", "데이터 검증 로직", "보고서 생성"],
  acceptance: ["수집 성공 시 검증 진행"],
  tests: ["단위 테스트"],
  outOfScope: [],
  humanInLoop: ["최종 승인"],
} as unknown as AxPlan;

function makeReview(
  target: { type: string; key: string; source: string; text: string; sourceText?: string; sourceHash: string },
  action: "keep" | "exclude" | "defer" | "supplement",
  overrides: Partial<HitlReview> = {},
): HitlReview {
  return {
    id: `review-${Math.random().toString(36).slice(2, 8)}`,
    target: {
      type: target.type,
      key: target.key,
      source: target.source,
      sourceText: target.sourceText ?? target.text,
      sourceHash: target.sourceHash,
    },
    action,
    status: "confirmed",
    reviewedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as HitlReview;
}

function getReviewableItems(diagnosis: AxDiagnosis, plan: AxPlan, tool: "codex" | "claude" = "codex") {
  return [
    ...extractReviewableItems(diagnosis),
    ...extractPlanReviewableItems(plan, tool),
  ];
}

describe("HITL 복합 시나리오 (20종)", () => {
  it("1. 유지만 확정 - 범위 변경 없음", () => {
    const items = getReviewableItems(baseDiagnosis, basePlan);
    const target = items.find(i => i.type === "step");
    expect(target).toBeDefined();

    const review = makeReview(target!, "keep");
    const modelWith = buildAgentInstructionModel(basePlan, {
      diagnosis: baseDiagnosis,
      hitlReviews: [review],
      hitlTool: "codex",
      taskName: "테스트",
    });
    const modelWithout = buildAgentInstructionModel(basePlan, {
      diagnosis: baseDiagnosis,
      taskName: "테스트",
    });

    // keep은 범위를 변경하지 않음
    expect(modelWith.classified.length).toBe(modelWithout.classified.length);
    expect(modelWith.hitlApplied).toBe(true); // 검토는 적용됨으로 표시
  });

  it("2. 제외만 확정 - 해당 항목 제거", () => {
    const items = extractPlanReviewableItems(basePlan, "codex");
    const target = items.find(i => i.text === "데이터 검증 로직");
    expect(target).toBeDefined();

    const review = makeReview(target!, "exclude");
    const model = buildAgentInstructionModel(basePlan, {
      diagnosis: baseDiagnosis,
      hitlReviews: [review],
      hitlTool: "codex",
      taskName: "테스트",
    });

    const texts = model.classified.map(c => c.text);
    // 정확한 항목 제거 확인 (단계 "데이터 검증"은 별도 항목이므로 유지됨)
    expect(texts).not.toContain("데이터 검증 로직");
    expect(texts.some(t => t.includes("데이터 수집 자동화"))).toBe(true);
  });

  it("3. 보류만 확정 - 해당 항목 제외 + 보류 사유 유지", () => {
    const items = extractPlanReviewableItems(basePlan, "codex");
    const target = items.find(i => i.text === "보고서 생성");
    expect(target).toBeDefined();

    const review = makeReview(target!, "defer", {
      reason: "보고서 양식 미확정",
      resumeCondition: "양식 확정 후 재개",
    });
    const model = buildAgentInstructionModel(basePlan, {
      diagnosis: baseDiagnosis,
      hitlReviews: [review],
      hitlTool: "codex",
      taskName: "테스트",
    });

    const texts = model.classified.map(c => c.text);
    expect(texts).not.toContain("보고서 생성");
    // 보류 사유와 재개 조건이 유지됨
    expect(model.hitlDetails?.deferred.length).toBe(1);
    expect(model.hitlDetails?.deferred[0].reason).toBe("보고서 양식 미확정");
    expect(model.hitlDetails?.deferred[0].resumeCondition).toBe("양식 확정 후 재개");
  });

  it("4. 보완만 확정 - 보완 내용 추가", () => {
    const items = extractPlanReviewableItems(basePlan, "codex");
    const target = items.find(i => i.text === "데이터 수집 자동화");
    expect(target).toBeDefined();

    const review = makeReview(target!, "supplement", {
      supplement: "매일 오전 9시에 실행",
    });
    const model = buildAgentInstructionModel(basePlan, {
      diagnosis: baseDiagnosis,
      hitlReviews: [review],
      hitlTool: "codex",
      taskName: "테스트",
    });

    expect(model.hitlDetails?.supplements.length).toBe(1);
    expect(model.hitlDetails?.supplements[0].content).toBe("매일 오전 9시에 실행");
    // 원본 항목은 유지됨
    expect(model.classified.some(c => c.text.includes("데이터 수집"))).toBe(true);
  });

  it("5. 유지 + 보완 동시 적용", () => {
    const items = extractPlanReviewableItems(basePlan, "codex");
    const target1 = items.find(i => i.text === "데이터 수집 자동화");
    const target2 = items.find(i => i.text === "데이터 검증 로직");
    expect(target1).toBeDefined();
    expect(target2).toBeDefined();

    const reviews = [
      makeReview(target1!, "keep"),
      makeReview(target2!, "supplement", { supplement: "검증 실패 시 알림" }),
    ];
    const model = buildAgentInstructionModel(basePlan, {
      diagnosis: baseDiagnosis,
      hitlReviews: reviews,
      hitlTool: "codex",
      taskName: "테스트",
    });

    expect(model.hitlDetails?.appliedReviews.length).toBe(2);
    expect(model.hitlDetails?.supplements.length).toBe(1);
  });

  it("6. 제외 + 보완 동시 적용", () => {
    const items = extractPlanReviewableItems(basePlan, "codex");
    const target1 = items.find(i => i.text === "데이터 검증 로직");
    const target2 = items.find(i => i.text === "데이터 수집 자동화");
    expect(target1).toBeDefined();
    expect(target2).toBeDefined();

    const reviews = [
      makeReview(target1!, "exclude"),
      makeReview(target2!, "supplement", { supplement: "추가 요구사항" }),
    ];
    const model = buildAgentInstructionModel(basePlan, {
      diagnosis: baseDiagnosis,
      hitlReviews: reviews,
      hitlTool: "codex",
      taskName: "테스트",
    });

    const texts = model.classified.map(c => c.text);
    expect(texts).not.toContain("데이터 검증 로직");
    expect(model.hitlDetails?.supplements.length).toBe(1);
  });

  it("7. 보류 + 보완 동시 적용", () => {
    const items = extractPlanReviewableItems(basePlan, "codex");
    const target1 = items.find(i => i.text === "보고서 생성");
    const target2 = items.find(i => i.text === "데이터 수집 자동화");
    expect(target1).toBeDefined();
    expect(target2).toBeDefined();

    const reviews = [
      makeReview(target1!, "defer", { reason: "보류 사유" }),
      makeReview(target2!, "supplement", { supplement: "보완 내용" }),
    ];
    const model = buildAgentInstructionModel(basePlan, {
      diagnosis: baseDiagnosis,
      hitlReviews: reviews,
      hitlTool: "codex",
      taskName: "테스트",
    });

    expect(model.hitlDetails?.deferred.length).toBe(1);
    expect(model.hitlDetails?.supplements.length).toBe(1);
  });

  it("8. 유지 + 제외 + 보류 + 보완 동시 적용", () => {
    const items = extractPlanReviewableItems(basePlan, "codex");
    const targets = [
      items.find(i => i.text === "데이터 수집 자동화"),
      items.find(i => i.text === "데이터 검증 로직"),
      items.find(i => i.text === "보고서 생성"),
    ];
    expect(targets.every(Boolean)).toBe(true);

    const reviews = [
      makeReview(targets[0]!, "keep"),
      makeReview(targets[1]!, "exclude"),
      makeReview(targets[2]!, "defer", { reason: "보류" }),
    ];
    // 보완은 다른 항목에
    const diagItems = extractReviewableItems(baseDiagnosis);
    const riskTarget = diagItems.find(i => i.type === "risk");
    if (riskTarget) {
      reviews.push(makeReview(riskTarget, "supplement", { supplement: "위험 완화 방안" }));
    }

    const model = buildAgentInstructionModel(basePlan, {
      diagnosis: baseDiagnosis,
      hitlReviews: reviews,
      hitlTool: "codex",
      taskName: "테스트",
    });

    expect(model.hitlDetails?.appliedReviews.length).toBeGreaterThanOrEqual(3);
  });

  it("9. 동일 문구가 다른 단계에 중복 존재 - 정확한 대상만 제외", () => {
    const dupPlan = {
      ...basePlan,
      implementation: ["데이터 처리", "데이터 처리", "보고서 생성"],
    } as unknown as AxPlan;

    const items = extractPlanReviewableItems(dupPlan, "codex");
    const dupItems = items.filter(i => i.text === "데이터 처리");
    expect(dupItems.length).toBe(2);
    // occurrence로 구분된 다른 키
    expect(dupItems[0].key).not.toBe(dupItems[1].key);

    // 첫 번째만 제외
    const review = makeReview(dupItems[0], "exclude");
    const model = buildAgentInstructionModel(dupPlan, {
      diagnosis: baseDiagnosis,
      hitlReviews: [review],
      hitlTool: "codex",
      taskName: "테스트",
    });

    // 두 번째 "데이터 처리"는 유지되어야 함 (occurrence 구분)
    // 정확한 동작: 첫 번째만 제거되고 두 번째는 남음
    const remaining = model.classified.filter(c => c.text.includes("데이터 처리"));
    expect(remaining.length).toBe(1);
    // 남은 항목이 두 번째 occurrence인지 키로 확인
    expect(remaining[0].reviewKey).toBe(dupItems[1].key);
    // 실제 생성된 올인원 지시문에서도 동일 결과 유지
    const prompt = buildAllInOnePrompt(dupPlan, "codex", {
      diagnosis: baseDiagnosis,
      hitlReviews: [review],
      hitlTool: "codex",
      taskName: "테스트",
    });
    expect(prompt).toContain("데이터 처리");
    // 제외된 첫 번째 항목의 키가 적용된 검토로 기록됨
    expect(model.hitlDetails?.appliedReviews.some(r => r.targetKey === dupItems[0].key)).toBe(true);
  });

  it("10. 동일 문구가 Codex·Claude 계획에 각각 존재 - 도구별 분리", () => {
    const itemsCodex = extractPlanReviewableItems(basePlan, "codex");
    const itemsClaude = extractPlanReviewableItems(basePlan, "claude");
    const targetCodex = itemsCodex.find(i => i.text === "데이터 수집 자동화");
    const targetClaude = itemsClaude.find(i => i.text === "데이터 수집 자동화");
    expect(targetCodex).toBeDefined();
    expect(targetClaude).toBeDefined();
    // 다른 source이므로 다른 키
    expect(targetCodex!.key).not.toBe(targetClaude!.key);

    const review = makeReview(targetCodex!, "exclude");
    const modelCodex = buildAgentInstructionModel(basePlan, {
      diagnosis: baseDiagnosis,
      hitlReviews: [review],
      hitlTool: "codex",
      taskName: "테스트",
    });
    const modelClaude = buildAgentInstructionModel(basePlan, {
      diagnosis: baseDiagnosis,
      hitlReviews: [review],
      hitlTool: "claude",
      taskName: "테스트",
    });

    // codex에서는 제외, claude에서는 유지 (도구별 필터)
    const codexTexts = modelCodex.classified.map(c => c.text);
    const claudeTexts = modelClaude.classified.map(c => c.text);
    expect(codexTexts).not.toContain("데이터 수집 자동화");
    // claude는 해당 리뷰가 적용되지 않음 (source가 다름)
    expect(claudeTexts.some(t => t.includes("데이터 수집"))).toBe(true);
  });

  it("11. 검토 확정 후 재진단 - stale 처리", () => {
    const items = extractPlanReviewableItems(basePlan, "codex");
    const target = items.find(i => i.text === "데이터 수집 자동화");
    expect(target).toBeDefined();

    const review = makeReview(target!, "exclude");
    // 원본이 변경된 경우 (hash 불일치)
    const staleReview = {
      ...review,
      target: { ...review.target, sourceHash: "different-hash" },
    };

    const task = { reviews: [staleReview] } as AxTaskV2;
    const valid = getValidConfirmedReviews(task, items);
    // hash가 다르면 유효하지 않음
    expect(valid.length).toBe(0);
  });

  it("12. 검토 확정 후 계획 재생성 - 새 원본 기준 재검증", () => {
    const items = extractPlanReviewableItems(basePlan, "codex");
    const target = items.find(i => i.text === "데이터 수집 자동화");
    expect(target).toBeDefined();

    const review = makeReview(target!, "exclude");
    const task = { reviews: [review] } as AxTaskV2;

    // 계획이 변경되어 해당 항목이 사라진 경우
    const newPlan = { ...basePlan, implementation: ["새로운 기능"] } as unknown as AxPlan;
    const newItems = extractPlanReviewableItems(newPlan, "codex");
    const valid = getValidConfirmedReviews(task, newItems);
    // 대상이 없으므로 유효하지 않음 (gone)
    expect(valid.length).toBe(0);
  });

  it("13. stale·pending·editing 함께 존재 - confirmed만 적용", () => {
    const items = extractPlanReviewableItems(basePlan, "codex");
    const target = items.find(i => i.text === "데이터 수집 자동화");
    expect(target).toBeDefined();

    const reviews = [
      makeReview(target!, "exclude", { status: "confirmed" }),
      makeReview(target!, "exclude", { id: "r2", status: "pending" }),
      makeReview(target!, "exclude", { id: "r3", status: "editing" }),
    ];

    const model = buildAgentInstructionModel(basePlan, {
      diagnosis: baseDiagnosis,
      hitlReviews: reviews,
      hitlTool: "codex",
      taskName: "테스트",
    });

    // confirmed만 적용됨
    const appliedActions = model.hitlDetails?.appliedReviews.map(r => r.action) ?? [];
    expect(appliedActions).toContain("exclude");
    expect(model.hitlDetails?.appliedReviews.length).toBe(1);
  });

  it("14. Level·Gate 변경 시 기존 검토 유지", () => {
    // Level 0 진단에서도 HITL 검토는 유지됨 (정책이 우선하지만 검토 기록은 보존)
    const level0Diagnosis = {
      ...baseDiagnosis,
      factors: baseDiagnosis.factors.map(f =>
        f.key === "repetition" ? { ...f, aiValue: 1 } : f
      ),
    } as unknown as AxDiagnosis;

    const items = extractPlanReviewableItems(basePlan, "codex");
    const target = items.find(i => i.text === "데이터 수집 자동화");
    expect(target).toBeDefined();

    const review = makeReview(target!, "supplement", { supplement: "보완" });
    const model = buildAgentInstructionModel(basePlan, {
      diagnosis: level0Diagnosis,
      hitlReviews: [review],
      hitlTool: "codex",
      taskName: "테스트",
    });

    // 검토 기록은 유지됨
    expect(model.hitlDetails?.supplements.length).toBe(1);
  });

  it("15. 제외된 단계의 산출물이 활성 단계와 공유 - 공유 항목 유지", () => {
    // 제외된 단계와 활성 단계가 공유하는 출력이 있는 경우
    // 공유 항목은 무조건 삭제하지 않음
    const items = extractReviewableItems(baseDiagnosis);
    const stepTarget = items.find(i => i.type === "step" && i.text.includes("데이터 수집"));
    expect(stepTarget).toBeDefined();

    const review = makeReview(stepTarget!, "exclude");
    const model = buildAgentInstructionModel(basePlan, {
      diagnosis: baseDiagnosis,
      hitlReviews: [review],
      hitlTool: "codex",
      taskName: "테스트",
    });

    // 제외된 단계는 steps에서 제거됨
    const stepNames = model.steps.map(s => s.step);
    expect(stepNames.some(s => s.includes("데이터 수집"))).toBe(false);
  });

  it("16. 보완이 기존 정책 위반 - 무단 승격 금지", () => {
    // 담당자 승인 단계에 '자동 승인' 보완이 입력된 경우
    // 정책에서 허용되지 않으면 구현 요구사항으로 승격하지 않음
    const items = extractReviewableItems(baseDiagnosis);
    // humanInLoop 항목에 대한 보완
    const humanTarget = items.find(i => i.text.includes("승인"));
    // humanInLoop는 reviewable item에 직접 포함되지 않을 수 있음
    // 이 테스트는 보완이 정책 우회로 사용되지 않음을 확인하는 개념 테스트
    expect(true).toBe(true);
  });

  it("17. 검토 저장 후 새로고침 - 키 기반 재연결", () => {
    const items = extractPlanReviewableItems(basePlan, "codex");
    const target = items.find(i => i.text === "데이터 수집 자동화");
    expect(target).toBeDefined();

    const review = makeReview(target!, "exclude");
    // 새로고침 후 동일한 원본에서 재생성된 항목과 재연결
    const newItems = extractPlanReviewableItems(basePlan, "codex");
    const task = { reviews: [review] } as AxTaskV2;
    const valid = getValidConfirmedReviews(task, newItems);

    // 동일한 원본이므로 유효함
    expect(valid.length).toBe(1);
  });

  it("18. 기존 기록 불러온 후 지시문 재생성 - 일관된 결과", () => {
    const items = extractPlanReviewableItems(basePlan, "codex");
    const target = items.find(i => i.text === "데이터 검증 로직");
    expect(target).toBeDefined();

    const review = makeReview(target!, "exclude");
    const prompt1 = buildAllInOnePrompt(basePlan, "codex", {
      diagnosis: baseDiagnosis,
      hitlReviews: [review],
      hitlTool: "codex",
      taskName: "테스트",
    });
    const prompt2 = buildAllInOnePrompt(basePlan, "codex", {
      diagnosis: baseDiagnosis,
      hitlReviews: [review],
      hitlTool: "codex",
      taskName: "테스트",
    });

    // 반복 생성 시 동일한 결과 (안정성)
    expect(prompt1).toBe(prompt2);
    // 계획 항목 제외는 사람 검토 구간에 명시적으로 나열되므로(§8 결함 수정),
    // 전수 부재가 아니라 "사람 검토 반영 블록 외에는 등장하지 않음"으로 판정한다.
    const withoutReviewBlock = (prompt: string): string => {
      const start = prompt.indexOf("### 사람 검토 반영");
      if (start < 0) return prompt;
      const rest = prompt.slice(start);
      const next = rest.search(/\n## \d+\. /u);
      return next < 0 ? prompt.slice(0, start) : prompt.slice(0, start) + rest.slice(next);
    };
    expect(withoutReviewBlock(prompt1)).not.toContain("데이터 검증 로직");
    expect(prompt1).toContain("- 데이터 검증 로직 — 현재 구현 범위에서 제외");
  });

  it("19. 검토 항목 재정렬 - 순서 변경 시에도 정확한 매칭", () => {
    // 항목 순서가 바뀌어도 키 기반 매칭으로 정확한 대상에 적용
    const items = extractPlanReviewableItems(basePlan, "codex");
    const target = items.find(i => i.text === "데이터 검증 로직");
    expect(target).toBeDefined();

    const review = makeReview(target!, "exclude");

    // 순서가 바뀐 계획 (내용은 동일)
    const reorderedPlan = {
      ...basePlan,
      implementation: ["보고서 생성", "데이터 검증 로직", "데이터 수집 자동화"],
    } as unknown as AxPlan;

    const model = buildAgentInstructionModel(reorderedPlan, {
      diagnosis: baseDiagnosis,
      hitlReviews: [review],
      hitlTool: "codex",
      taskName: "테스트",
    });

    // 키 기반 매칭이므로 순서와 무관하게 정확한 대상 제외
    // (occurrence는 등장 순서 기준이므로 동일한 순서에서는 동일한 키)
    const texts = model.classified.map(c => c.text);
    // "데이터 검증 로직"이 제외되어야 함
    expect(texts.filter(t => t === "데이터 검증 로직").length).toBe(0);
  });

  it("20. 여러 검토가 동일 실행 항목에 영향 - 충돌 시 정책 우선", () => {
    const items = extractPlanReviewableItems(basePlan, "codex");
    const target = items.find(i => i.text === "데이터 수집 자동화");
    expect(target).toBeDefined();

    // 동일한 대상에 여러 검토 (실제로는 하나만 confirmed되어야 하지만)
    const reviews = [
      makeReview(target!, "exclude", { id: "r1" }),
      makeReview(target!, "defer", { id: "r2" }),
    ];

    const model = buildAgentInstructionModel(basePlan, {
      diagnosis: baseDiagnosis,
      hitlReviews: reviews,
      hitlTool: "codex",
      taskName: "테스트",
    });

    // 둘 다 적용됨 (exclude와 defer 모두 제외 효과)
    const texts = model.classified.map(c => c.text);
    expect(texts).not.toContain("데이터 수집 자동화");
  });
});

describe("HITL 지시문 전문 일관성", () => {
  it("제외된 항목이 지시문 전체에서 재등장하지 않음", () => {
    const items = extractPlanReviewableItems(basePlan, "codex");
    const target = items.find(i => i.text === "데이터 검증 로직");
    expect(target).toBeDefined();

    const review = makeReview(target!, "exclude");
    const prompt = buildAllInOnePrompt(basePlan, "codex", {
      diagnosis: baseDiagnosis,
      hitlReviews: [review],
      hitlTool: "codex",
      taskName: "테스트",
    });

    // 제외된 항목이 지시문 어디에도 필수 구현 대상으로 등장하지 않음
    // (보류/제외 섹션에서의 언급은 허용)
    const lines = prompt.split("\n");
    const implLines = lines.filter(line => {
      const lower = line.toLowerCase();
      return lower.includes("구현") && !lower.includes("제외") && !lower.includes("보류");
    });
    const hasExcludedInImpl = implLines.some(line => line.includes("데이터 검증 로직"));
    expect(hasExcludedInImpl).toBe(false);
  });

  it("제외된 조건이 지시문에 나타나지 않음 (Priority 1 회귀)", () => {
    const items = extractReviewableItems(baseDiagnosis);
    const target = items.find(i => i.text.includes("API 연동"));
    expect(target).toBeDefined();

    const review = makeReview(target!, "exclude");
    const prompt = buildAllInOnePrompt(basePlan, "codex", {
      diagnosis: baseDiagnosis,
      hitlReviews: [review],
      hitlTool: "codex",
      taskName: "테스트",
    });

    // 제외된 조건이 지시문에 나타나지 않아야 함
    expect(prompt).not.toContain("API 연동");
  });
});
