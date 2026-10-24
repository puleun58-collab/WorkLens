import { describe, expect, it } from "vitest";
import { buildAgentInstructionModel, buildAllInOnePrompt } from "../src/lib/ax/guide";
import { extractPlanReviewableItems, extractReviewableItems, type ReviewableItem } from "../src/lib/ax/hitl";
import { diagnosisFixture, planFixture } from "./fixtures/ax";
import { gatePrerequisites } from "../src/lib/ax/policy";
import type { AxDiagnosis, AxPlan, HitlReview } from "../src/lib/ax/types";

/**
 * HITL 보류·제외 결함 수정 정합성 (T1~T15).
 * 원본 HITL 결정은 바꾸지 않고, 실제 생성 함수가 만드는 지시문 전문에서
 * §1~§5가 하나의 확정 구현 범위를 일관되게 사용하는지 확인한다.
 */

const STEP_NAMES = ["원본 파일 읽기", "금액 계산", "납품표 대조", "Excel 보고서 생성"] as const;

const diagnosis: AxDiagnosis = {
  ...diagnosisFixture,
  decisionGate: { verdict: "go", reasons: [] },
  stepAssessments: STEP_NAMES.map(step => ({ step, verdict: "자동화", owner: "시스템", note: "확정된 규칙으로 처리" })),
  asIs: {
    ...diagnosisFixture.asIs,
    purpose: "거래 금액을 계산하고 결과를 보고",
    inputs: ["거래내역.xlsx"],
    steps: [...STEP_NAMES],
    outputs: ["Excel 보고서"],
    exceptions: ["납품표 번호 불일치", "금액 형식 오류", "Excel 파일 손상"],
    systems: ["Excel"],
  },
  poc: {
    ...diagnosisFixture.poc,
    inScope: [...STEP_NAMES],
    inputs: ["거래내역.xlsx"],
    outputs: ["Excel 보고서"],
    success: ["계산 결과가 기대값과 일치"],
    failure: ["금액 불일치가 일치로 표시"],
  },
  risks: ["금액 형식 오류"],
};

const plan: AxPlan = {
  ...planFixture,
  goal: ["금액 계산 결과를 Excel 보고서로 생성"],
  inScope: [...STEP_NAMES],
  implementation: [...STEP_NAMES],
  dataFlow: ["원본 파일 읽기 → 금액 계산 → 납품표 대조 → Excel 보고서 생성"],
  exceptions: ["납품표 번호 불일치 건은 별도 판정", "금액 형식 오류는 오류로 분리", "Excel 파일 손상 시 생성 중단"],
  tests: ["금액 계산 결과가 기대값과 일치하는지 확인", "형식 오류가 구분되는지 확인"],
  acceptance: ["계산 결과가 기대값과 일치", "Excel 보고서가 생성됨"],
};

let reviewSeq = 0;
function makeReview(item: ReviewableItem, action: HitlReview["action"], overrides: Partial<HitlReview> = {}): HitlReview {
  return {
    id: `consistency-review-${++reviewSeq}`,
    target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash },
    action,
    status: "confirmed",
    reviewedAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    ...overrides,
  } as HitlReview;
}

function items(tool: "codex" | "claude" = "codex", diag: AxDiagnosis = diagnosis, targetPlan: AxPlan = plan): ReviewableItem[] {
  return [...extractReviewableItems(diag), ...extractPlanReviewableItems(targetPlan, tool)];
}

/** 지정 문구를 포함하는 단계·계획 항목에 같은 결정을 적용하고, 나머지는 유지한다. */
function reviewsByMatch(match: string, action: HitlReview["action"], overrides: Partial<HitlReview> = {}, tool: "codex" | "claude" = "codex"): HitlReview[] {
  return items(tool).map(item => item.text.includes(match) && (item.type === "step" || item.type === "planItem") ? makeReview(item, action, overrides) : makeReview(item, "keep"));
}

/** 계획 항목만의 검토 (도구별 분리 확인용). */
function reviewsPlanOnly(match: string, action: HitlReview["action"], tool: "codex" | "claude"): HitlReview[] {
  return extractPlanReviewableItems(plan, tool).map(item => item.text.includes(match) ? makeReview(item, action) : makeReview(item, "keep"));
}

function compositeReviews(tool: "codex" | "claude" = "codex"): HitlReview[] {
  return items(tool).map(item => {
    if (item.type !== "step" && item.type !== "planItem") return makeReview(item, "keep");
    if (item.text.includes("Excel 보고서")) return makeReview(item, "defer", { reason: "보고서 양식 미확정", resumeCondition: "양식 확정 후 재개" });
    if (item.text.includes("납품표")) return makeReview(item, "exclude");
    if (item.text.includes("금액 계산")) return makeReview(item, "supplement", { supplement: "불일치 건은 차이값과 양쪽 원본값을 함께 표시한다" });
    return makeReview(item, "keep");
  });
}

function promptWith(reviews: HitlReview[], tool: "codex" | "claude" = "codex", diag: AxDiagnosis = diagnosis, targetPlan: AxPlan = plan): string {
  return buildAllInOnePrompt(targetPlan, tool, { taskName: "거래 검증", diagnosis: diag, hitlReviews: reviews, hitlTool: tool });
}

function section(prompt: string, title: string): string {
  const start = prompt.indexOf(`. ${title}`);
  if (start < 0) return "";
  const rest = prompt.slice(start);
  const next = rest.slice(3).search(/\n## \d+\. /u);
  return next < 0 ? rest : rest.slice(0, next + 3);
}

describe("HITL 지시문 정합성 T1~T15", () => {
  it("T1 HITL 결정 없는 일반 업무는 기존 산출물·예외를 유지한다", () => {
    const model = buildAgentInstructionModel(plan, { taskName: "거래 검증", diagnosis });
    const prompt = promptWith([]);
    expect(model.hitlDetails).toBeUndefined();
    expect(section(prompt, "구현 목표")).toContain("최종 산출물: Excel 보고서");
    expect(section(prompt, "예외 및 유지 조건")).toContain("납품표 번호 불일치");
    expect(section(prompt, "구현 범위")).not.toContain("사람 검토 반영");
  });

  it("T2 전체 유지는 범위를 바꾸지 않는다", () => {
    const reviews = items().map(item => makeReview(item, "keep"));
    const prompt = promptWith(reviews);
    expect(section(prompt, "구현 목표")).toContain("최종 산출물: Excel 보고서");
    for (const step of STEP_NAMES) expect(section(prompt, "구현 범위")).toContain(`| ${step} |`);
    expect(section(prompt, "구현 범위")).not.toContain("보류된 작업");
    expect(section(prompt, "구현 범위")).not.toContain("제외된 작업");
  });

  it("T3 일부 보류는 실제 단계명·사유·재개 조건으로 표시하고 필수 산출물에서 제외한다", () => {
    const reviews = reviewsByMatch("Excel 보고서", "defer", { reason: "보고서 양식 미확정", resumeCondition: "양식 확정 후 재개" });
    const prompt = promptWith(reviews);
    const scope = section(prompt, "구현 범위");
    expect(scope).toContain("- Excel 보고서 생성 — 보류: 보고서 양식 미확정");
    expect(scope).toContain("재개 조건: 양식 확정 후 재개");
    expect(scope).not.toContain("step:diagnosis:");
    expect(scope).not.toContain(`| Excel 보고서 생성 |`);
    expect(section(prompt, "기능별 요구사항")).not.toContain("### 기능 4. Excel 보고서 생성");
  });

  it("T4 일부 제외는 실제 단계명으로 명시하고 전용 예외를 제거한다", () => {
    const prompt = promptWith(reviewsByMatch("납품표", "exclude"));
    const scope = section(prompt, "구현 범위");
    expect(scope).toContain("- 납품표 대조 — 현재 구현 범위에서 제외. 관련 기능을 구현하지 않습니다.");
    expect(scope).not.toContain("| 납품표 대조 |");
    const exceptions = section(prompt, "예외 및 유지 조건");
    expect(exceptions).not.toContain("납품표 번호 불일치");
    expect(exceptions).toContain("금액 형식 오류");
  });

  it("T5 일부 보완은 실제 단계명과 함께 유지 기능에 반영된다", () => {
    const reviews = reviewsByMatch("금액 계산", "supplement", { supplement: "불일치 건은 차이값과 양쪽 원본값을 함께 표시한다" });
    const model = buildAgentInstructionModel(plan, { taskName: "거래 검증", diagnosis, hitlReviews: reviews, hitlTool: "codex" });
    const prompt = promptWith(reviews);
    expect(model.hitlDetails?.supplements.some(entry => entry.name === "금액 계산")).toBe(true);
    expect(section(prompt, "구현 범위")).toContain("불일치 건은 차이값과 양쪽 원본값을 함께 표시한다");
    expect(section(prompt, "기능별 요구사항")).toContain("금액 계산");
  });

  it("T6 유지·보류·제외·보완 복합 결정이 §1~§5에서 일관된다", () => {
    const prompt = promptWith(compositeReviews());
    const scope = section(prompt, "구현 범위");
    expect(scope).toContain("- Excel 보고서 생성 — 보류: 보고서 양식 미확정");
    expect(scope).toContain("- 납품표 대조 — 현재 구현 범위에서 제외");
    expect(scope).toContain("불일치 건은 차이값과 양쪽 원본값을 함께 표시한다");
    expect(scope).toContain("| 원본 파일 읽기 |");
    expect(scope).toContain("| 금액 계산 |");
    expect(section(prompt, "구현 목표")).not.toContain("최종 산출물: Excel 보고서");
    expect(section(prompt, "기능별 요구사항")).not.toContain("업무 전체 산출물 (공통 출력): Excel 보고서");
    expect(section(prompt, "예외 및 유지 조건")).not.toContain("납품표 번호 불일치");
    expect(section(prompt, "예외 및 유지 조건")).toContain("금액 형식 오류");
  });

  it("T7 보류 기능이 AS-IS 필수 산출물로 남아 있던 경우에도 현재 산출물에서 제외한다", () => {
    const prompt = promptWith(reviewsByMatch("Excel 보고서", "defer", { reason: "보고서 양식 미확정" }));
    expect(diagnosis.asIs.outputs).toContain("Excel 보고서");
    expect(section(prompt, "구현 목표")).not.toContain("최종 산출물: Excel 보고서");
    expect(section(prompt, "기능별 요구사항")).not.toContain("공통 출력): Excel 보고서");
    expect(section(prompt, "구현 순서 및 검증")).not.toContain("처리 결과를 Excel 보고서");
    expect(section(prompt, "구현 순서 및 검증")).toContain("처리 결과를 확인된 출력 형식으로 연결");
  });

  it("T7b 산출물이 활성 단계와 도메인 공통어를 공유해도 보류 단계 산출물이면 제외한다", () => {
    const sharedDiagnosis: AxDiagnosis = {
      ...diagnosis,
      stepAssessments: ["경유 가격 데이터 읽기", "월평균 계산", "Excel 보고서 반영"].map(step => ({ step, verdict: "자동화", owner: "시스템", note: "" })),
      asIs: { ...diagnosis.asIs, steps: ["경유 가격 데이터 읽기", "월평균 계산", "Excel 보고서 반영"], outputs: ["주간 경유 가격 보고서(Excel)"] },
      poc: { ...diagnosis.poc, inScope: ["경유 가격 데이터 읽기", "월평균 계산", "Excel 보고서 반영"], outputs: ["주간 경유 가격 보고서(Excel)"] },
    };
    const sharedPlan: AxPlan = { ...plan, inScope: ["경유 가격 데이터 읽기", "월평균 계산", "Excel 보고서 반영"], implementation: ["경유 가격 데이터 읽기", "월평균 계산", "Excel 보고서 반영"] };
    const reviews = items("codex", sharedDiagnosis, sharedPlan).map(item => item.text.includes("Excel 보고서 반영") ? makeReview(item, "defer", { reason: "양식 미확정" }) : makeReview(item, "keep"));
    const prompt = promptWith(reviews, "codex", sharedDiagnosis, sharedPlan);
    expect(section(prompt, "구현 목표")).not.toContain("최종 산출물: 주간 경유 가격 보고서(Excel)");
    expect(section(prompt, "기능별 요구사항")).not.toContain("공통 출력): 주간 경유 가격 보고서(Excel)");
    expect(section(prompt, "구현 범위")).toContain("| 월평균 계산 |");
  });

  it("T8 제외 기능 전용 예외는 제거하고 공통 예외는 보존한다", () => {
    const prompt = promptWith(reviewsByMatch("납품표", "exclude"));
    const exceptions = section(prompt, "예외 및 유지 조건");
    expect(exceptions).not.toContain("납품표 번호 불일치");
    expect(exceptions).not.toContain("납품표 번호 불일치 건은 별도 판정");
    expect(exceptions).toContain("금액 형식 오류");
    expect(exceptions).toContain("Excel 파일 손상");
  });

  it("T9 보류 기능과 독립 기능이 공존하면 독립 기능은 구현 대상으로 유지한다", () => {
    const prompt = promptWith(reviewsByMatch("Excel 보고서", "defer", { reason: "보고서 양식 미확정" }));
    expect(section(prompt, "기능별 요구사항")).toContain("금액 계산");
    expect(section(prompt, "구현 순서 및 검증")).toContain("금액 계산");
    expect(section(prompt, "구현 범위")).toContain("| 금액 계산 | 확인 후 구현 |");
  });

  it("T10 미확정·편집 중·stale HITL은 확정 결정으로 적용하지 않는다", () => {
    const target = items().find(item => item.type === "step" && item.text.startsWith("납품표 대조:"));
    expect(target).toBeDefined();
    const reviews = [
      makeReview(target!, "exclude", { status: "pending" }),
      makeReview(target!, "exclude", { status: "editing" }),
      makeReview(target!, "exclude", { target: { type: target!.type, key: target!.key, source: target!.source, sourceText: target!.text, sourceHash: "stale-hash" } }),
    ];
    const prompt = promptWith(reviews);
    expect(section(prompt, "구현 범위")).toContain("| 납품표 대조 |");
    expect(section(prompt, "구현 범위")).not.toContain("제외된 작업");
  });

  it("T11 Codex·Claude Code 계획 검토는 도구별로 분리되고 같은 정책을 적용한다", () => {
    const codexReviews = reviewsPlanOnly("납품표", "exclude", "codex");
    const claudePromptWithoutOwnReviews = promptWith(codexReviews, "claude");
    expect(section(claudePromptWithoutOwnReviews, "구현 범위")).toContain("| 납품표 대조 |");
    const claudeReviews = reviewsPlanOnly("납품표", "exclude", "claude");
    const claudePrompt = promptWith(claudeReviews, "claude");
    expect(section(claudePrompt, "구현 범위")).toContain("- 납품표 대조 — 현재 구현 범위에서 제외");
    const codexPrompt = promptWith(codexReviews, "codex");
    expect(section(codexPrompt, "구현 범위")).toContain("- 납품표 대조 — 현재 구현 범위에서 제외");
  });

  it("T12 유사한 단계명은 합치지 않고 정확한 대상만 제외한다", () => {
    const similarDiagnosis: AxDiagnosis = {
      ...diagnosis,
      stepAssessments: ["데이터 검증", "데이터 검증 후처리", "금액 계산"].map(step => ({ step, verdict: "자동화", owner: "시스템", note: "" })),
      asIs: { ...diagnosis.asIs, steps: ["데이터 검증", "데이터 검증 후처리", "금액 계산"] },
      poc: { ...diagnosis.poc, inScope: ["데이터 검증", "데이터 검증 후처리", "금액 계산"] },
    };
    const similarPlan: AxPlan = { ...plan, inScope: ["데이터 검증", "데이터 검증 후처리", "금액 계산"], implementation: ["데이터 검증", "데이터 검증 후처리", "금액 계산"] };
    const reviews = items("codex", similarDiagnosis, similarPlan).map(item => item.text === "데이터 검증" || item.text.startsWith("데이터 검증:") ? makeReview(item, "exclude") : makeReview(item, "keep"));
    const prompt = promptWith(reviews, "codex", similarDiagnosis, similarPlan);
    expect(section(prompt, "구현 범위")).toContain("- 데이터 검증 — 현재 구현 범위에서 제외");
    expect(section(prompt, "구현 범위")).toContain("| 데이터 검증 후처리 |");
    expect(section(prompt, "기능별 요구사항")).toContain("데이터 검증 후처리");
  });

  it("T13 모든 단계가 보류·제외되면 구현 단계와 최종 산출물을 만들지 않는다", () => {
    const reviews = items().map(item => {
      if (item.text.includes("Excel 보고서") || item.text.includes("원본 파일 읽기")) return makeReview(item, "defer", { reason: "선행 조건 미확정" });
      if (item.text.includes("납품표") || item.text.includes("금액 계산")) return makeReview(item, "exclude");
      return makeReview(item, "keep");
    });
    const prompt = promptWith(reviews);
    expect(section(prompt, "구현 목표")).toContain("현재 실행 범위에 구현할 업무 단계가 없습니다");
    expect(section(prompt, "구현 목표")).not.toContain("최종 산출물:");
    expect(section(prompt, "기능별 요구사항")).not.toContain("### 기능 1.");
  });

  it("T14 동일 입력 재생성은 바이트 단위로 일관된다", () => {
    const reviews = compositeReviews();
    const first = promptWith(reviews);
    const second = promptWith(reviews);
    expect(second).toBe(first);
    const model = buildAgentInstructionModel(plan, { taskName: "거래 검증", diagnosis, hitlReviews: reviews, hitlTool: "codex" });
    expect(model.hitlDetails?.deferred.map(entry => entry.name)).toContain("Excel 보고서 생성");
    expect(model.hitlDetails?.excluded.map(entry => entry.name)).toContain("납품표 대조");
  });

  it("T15 선택 기술 확인 항목을 제외하면 (선택) 표지 조건 사본까지 지시문에서 사라진다", () => {
    const diagWithChecks: AxDiagnosis = {
      ...diagnosis,
      decisionGate: { verdict: "conditional", reasons: ["기술 확인 후 진행"] },
      technicalChecks: [
        { topic: "파일 파싱 가능 여부", status: "확인 필요", note: "엑셀 구조 파악 필요", required: true },
        { topic: "이상값 알림 메커니즘", status: "확인 필요", note: "결측 표시와 알림은 선택 기능", required: false },
      ],
    };
    const riskItems = extractReviewableItems(diagWithChecks).filter(item => item.type === "risk");
    const optionalItem = riskItems.find(item => item.text.startsWith("이상값 알림 메커니즘:"));
    expect(optionalItem).toBeDefined();
    // 실제 UI 경로: AxPlanSection이 executionProfile의 선행조건(gatePrerequisites)을 함께 전달한다.
    const promptUi = (revs: HitlReview[]) => buildAllInOnePrompt(plan, "codex", {
      taskName: "거래 검증", diagnosis: diagWithChecks, hitlReviews: revs, hitlTool: "codex",
      prerequisites: gatePrerequisites(diagWithChecks),
    });
    // 대조군: 제외하지 않으면 선택 항목이 조건으로 남는다(선행조건 (선택) 표지 사본과 병합된 단일 항목).
    const keptPrompt = promptUi(riskItems.map(item => makeReview(item, "keep")));
    expect(keptPrompt).toContain("이상값 알림 메커니즘 — 결측 표시와 알림은 선택 기능");
    // 제외 확정 시 지시문 어디에도 해당 확인 항목이 남지 않고, 필수 확인 항목은 유지된다.
    const reviews = riskItems.map(item => item === optionalItem
      ? makeReview(item, "exclude", { reason: "알림 연동은 이번 범위에서 제외" })
      : makeReview(item, "keep"));
    const prompt = promptUi(reviews);
    expect(prompt).not.toContain("이상값 알림 메커니즘");
    expect(prompt).toContain("파일 파싱 가능 여부");
  });
});
