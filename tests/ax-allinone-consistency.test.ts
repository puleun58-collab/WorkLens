import { describe, expect, it } from "vitest";
import {
  buildAgentInstructionModel, buildAllInOnePrompt, guardPlan, isConfirmedMetric, planSummary, stepMethodLabel,
} from "../src/lib/ax/guide";
import type { AxDiagnosis, AxPlan } from "../src/lib/ax/types";
import { contractCase, freightCase, permitCase } from "./fixtures/ax-agent-cases";

const modelFor = (diagnosis: AxDiagnosis, plan?: AxPlan, context = "") =>
  buildAgentInstructionModel(plan, { diagnosis, taskName: diagnosis.asIs?.purpose || "업무", context });

describe("AX step linking in the shared model", () => {
  it("links exact, whitespace-normalized and name-prefixed plan items to one step", () => {
    const c = freightCase;
    const plan: AxPlan = { ...c.plan, implementation: ["누락·중복 검증 — 운송장 번호 중복 검사", "  누락·중복 검증: 샘플 누락·중복 검사  "] };
    const model = modelFor(c.diagnosis, plan);
    const items = model.classified.filter(item => item.source === "plan.implementation");
    expect(items).toHaveLength(2);
    for (const item of items) expect(item).toMatchObject({ step: "누락·중복 검증", scope: "after-check" });
  });
  it("does not link similar-but-different names, partial matches or duplicates to a single step", () => {
    const c = freightCase;
    const plan: AxPlan = { ...c.plan, implementation: ["누락·중복 확인 — 담당자 메모", "중복 검사", "정산표 생성 — 운임 계산", "정산표 생성 — 결과 대조"] };
    const model = modelFor(c.diagnosis, plan);
    const byText = (text: string) => model.classified.find(item => item.source === "plan.implementation" && item.text === text)!;
    // "누락·중복 확인" is a different step from "누락·중복 검증"; "중복 검사" is a partial match.
    expect(byText("누락·중복 확인 — 담당자 메모").scope).toBe("confirm");
    expect(byText("누락·중복 확인 — 담당자 메모").step).toBeUndefined();
    expect(byText("중복 검사").scope).toBe("confirm");
    expect(byText("중복 검사").step).toBeUndefined();
    // PART B (기능 구현 vs 운영 자동화 분리): Level 1의 "자동화" 판정 단계도 담당자 실행 기반의
    // 사용자 실행형으로 구현 범위에 포함되므로, 연결된 제안은 단계의 정책 범위(after-check)를 상속한다.
    // 두 제안이 하나의 단계에 연결되어도 단계 범위를 넘어 승격되지는 않는다.
    const both = model.classified.filter(item => item.source === "plan.implementation" && item.text.startsWith("정산표 생성 — "));
    expect(both).toHaveLength(2);
    for (const item of both) expect(item).toMatchObject({ step: "정산표 생성", scope: "after-check" });
    expect(model.scoped.features.filter(item => item.text.startsWith("정산표 생성 — ")).every(item => item.scope === "after-check")).toBe(true);
  });
  it("keeps human and future linked proposals out of current implementation", () => {
    const c = freightCase;
    const plan: AxPlan = { ...c.plan, implementation: ["정산 승인 — 자동 승인 로직", "정산표 생성 — ERP 자동 전송"] };
    const model = modelFor(c.diagnosis, plan);
    const approval = model.classified.find(item => item.source === "plan.implementation" && item.text.startsWith("정산 승인"));
    const erp = model.classified.find(item => item.source === "plan.implementation" && item.text.startsWith("정산표 생성"));
    expect(approval?.scope).toBe("human");
    // PART B: 단계 자체는 사용자 실행형으로 범위에 포함되지만, "ERP 자동 전송" 같은 무인 실행 제안은
    // Level 1 정책에 따라 확인 대상으로 보류된다 (담당자 요청 없는 무인 실행·자동 확정 금지 유지).
    expect(erp?.scope).toBe("confirm");
    const prompt = buildAllInOnePrompt(plan, "codex", { diagnosis: c.diagnosis, taskName: c.name });
    // The human-linked proposal is shown as an exclusion, never as an implementation step.
    expect(model.scoped.features.some(item => item.text.startsWith("정산 승인"))).toBe(false);
    expect(prompt).toContain("현재 자동화 제외");
  });
});

describe("AX composite processing methods", () => {
  it("preserves an explicitly ordered composite flow (spec example B)", () => {
    const model = modelFor(freightCase.diagnosis, freightCase.plan);
    const index = model.steps.findIndex(step => step.step === "실적 파일 병합");
    expect(model.methods[index]).toBe("composite");
    expect(model.methodChains[index]).toEqual(["script", "manual"]);
    expect(stepMethodLabel(model, index)).toBe("복합 처리 (확인된 순서): 일반 시스템·스크립트 처리 → 담당자 확인");
  });
  it("preserves a three-role composite (spec example A)", () => {
    const diagnosis: AxDiagnosis = {
      ...freightCase.diagnosis,
      stepAssessments: freightCase.diagnosis.stepAssessments.map(step => step.step === "누락·중복 검증"
        ? { ...step, note: "AI로 컬럼 매핑 후보를 제안하고, 확정된 규칙으로 누락·중복을 검사한 뒤 담당자가 확인한다" } : step),
    };
    const model = modelFor(diagnosis, freightCase.plan);
    const index = model.steps.findIndex(step => step.step === "누락·중복 검증");
    expect(model.methods[index]).toBe("composite");
    expect(model.methodChains[index]).toEqual(["assist", "rule", "manual"]);
    expect(stepMethodLabel(model, index)).toContain("AI 후보·초안 생성 → 규칙 기반 처리 → 담당자 확인");
  });
  it("stays confirm when evidence is missing or merely conflicts", () => {
    const empty: AxDiagnosis = {
      ...freightCase.diagnosis,
      stepAssessments: freightCase.diagnosis.stepAssessments.map(step => step.step === "정산표 생성" ? { ...step, note: "데이터를 자동으로 처리한다" } : step),
    };
    const emptyModel = modelFor(empty, freightCase.plan);
    const index = emptyModel.steps.findIndex(step => step.step === "정산표 생성");
    expect(emptyModel.methods[index]).toBe("confirm");
  });
  it("keeps single-method steps with human review at their own method", () => {
    const model = modelFor(contractCase.diagnosis, contractCase.plan);
    const draftIndex = model.steps.findIndex(step => step.step === "갱신 안내 초안 작성");
    // Evidence explicitly says the human finalizes the wording; that is manual evidence, not assist.
    expect(model.methods[draftIndex]).toBe("manual");
    expect(model.methods[draftIndex]).not.toBe("composite");
  });
});

describe("AX condition step linking", () => {
  it("links whole-topic technical checks to their step and keeps unlinked ones as confirm", () => {
    const model = modelFor(freightCase.diagnosis, freightCase.plan);
    const check = model.conditions.current.find(item => item.sources.includes("diagnosis.technicalChecks") && item.text.startsWith("실적 파일 병합"));
    expect(check?.step).toBe("실적 파일 병합");
    // PART B: "정산표 생성" 단계가 사용자 실행형으로 범위에 포함되므로, 연결된 선행 조건도 현재 조건으로 분류된다.
    const linked = model.conditions.current.find(item => item.text.startsWith("정산표 생성"));
    expect(linked?.step).toBe("정산표 생성");
    const erp = model.conditions.confirm.find(item => item.text.startsWith("ERP"));
    expect(erp).toBeDefined();
    expect(erp?.step).toBeUndefined();
  });
  it("does not promote future-only conditions to current requirements", () => {
    const model = modelFor(freightCase.diagnosis, freightCase.plan);
    const currentTexts = model.conditions.current.map(item => item.text);
    expect(currentTexts.some(text => text.includes("ERP"))).toBe(false);
    expect(model.scoped.conditions.map(item => item.text).some(text => text.includes("ERP"))).toBe(false);
  });
});

describe("AX evidence preservation in guardPlan", () => {
  const context = "월간 운임 정산\n운송 실적 Excel\n계약서상 정산 오차율 0.5% 이내\n정산 대상 월 100건";
  it("keeps user-confirmed metrics and drops hallucinated performance targets", () => {
    expect(isConfirmedMetric("정산 오차율 0.5% 이내 확인", context)).toBe(true);
    expect(isConfirmedMetric("업무시간 80% 단축", context)).toBe(false);
    const plan: AxPlan = { ...freightCase.plan, acceptance: ["계약서상 정산 오차율 0.5% 이내 확인", "업무시간 80% 단축 달성"] };
    const guarded = guardPlan(plan, context);
    expect(guarded.acceptance).toContain("계약서상 정산 오차율 0.5% 이내 확인");
    expect(guarded.acceptance).not.toContain("업무시간 80% 단축 달성");
  });
  it("keeps confirmed organizations and qualifies AI-invented ones", () => {
    const plan: AxPlan = { ...freightCase.plan, goal: ["운송팀 정산 현황 공유", "재무본부 월간 보고"] };
    const guarded = guardPlan(plan, "운송 실적 Excel\n운송팀 담당자 확인");
    expect(guarded.goal).toContain("운송팀 정산 현황 공유");
    expect(guarded.goal.find(item => item.includes("담당 조직"))).toBeDefined();
  });
  it("keeps confirmed APIs and qualifies unconfirmed endpoints", () => {
    const plan: AxPlan = { ...freightCase.plan, integrations: ["ERP 읽기 API 연동", "신규 청구 endpoint 연동"] };
    const guarded = guardPlan(plan, "ERP 읽기 API 연동\n운송 실적 Excel");
    expect(guarded.integrations).toContain("ERP 읽기 API 연동");
    const unguarded = guardPlan(plan, "운송 실적 Excel");
    expect(unguarded.integrations.find(item => item.includes("신규 청구 endpoint 연동") && item.includes("(확인 필요:"))).toBeDefined();
  });
  it("marks confirmed metrics as confirmed in the shared model, not as unsupported", () => {
    const plan: AxPlan = { ...freightCase.plan, acceptance: ["계약서상 정산 오차율 0.5% 이내 확인", "업무시간 80% 단축 달성"] };
    const model = modelFor(freightCase.diagnosis, plan, context);
    const confirmed = model.classified.find(item => item.text.includes("0.5%"));
    // Unlinked to any step, so it stays a confirm item — but never as an unsupported metric.
    expect(confirmed?.reason).not.toContain("근거 없는 성능 수치");
    const hallucinated = model.classified.find(item => item.text.includes("80%"));
    expect(hallucinated?.scope).toBe("confirm");
    expect(hallucinated?.reason).toContain("확인 필요");
  });
});

describe("AX cross-tool policy consistency", () => {
  const policyFingerprint = (model: ReturnType<typeof modelFor>) => JSON.stringify({
    level: model.level?.level, gate: model.gate, scopeLevel: model.scopeLevel,
    steps: model.steps.map(step => ({ step: step.step, scope: step.scope })),
    future: model.conditions.future.map(item => item.text),
    global: model.conditions.global.map(item => item.text),
    // Tool proposals differ in wording; policy scope is the (step, scope) pairs they resolve to.
    scopedFeatures: model.scoped.features.map(item => ({ step: item.step, scope: item.scope })).sort((a, b) => `${a.step}${a.scope}`.localeCompare(`${b.step}${b.scope}`)),
    scopedTests: model.scoped.tests.map(item => ({ step: item.step, scope: item.scope })).sort((a, b) => `${a.step}${a.scope}`.localeCompare(`${b.step}${b.scope}`)),
    excluded: model.classified.filter(item => item.role === "excluded").map(item => item.text),
    human: model.classified.filter(item => item.role === "human").map(item => item.text),
  });
  it("keeps the same policy scope for different Codex and Claude Code plans on one diagnosis", () => {
    const codexPlan: AxPlan = { ...freightCase.plan, implementation: ["실적 파일 병합 — pandas read_excel로 병합", "누락·중복 검증 — 운송장 번호 중복 검사"] };
    const claudePlan: AxPlan = { ...freightCase.plan, implementation: ["실적 파일 병합 — xlsx 병합 스크립트 실행", "누락·중복 검증 — 필수값 누락 표시", "정산표 생성 — ERP 자동 전송"] };
    const codex = modelFor(freightCase.diagnosis, codexPlan, freightCase.description);
    const claude = modelFor(freightCase.diagnosis, claudePlan, freightCase.description);
    expect(policyFingerprint(codex)).toBe(policyFingerprint(claude));
    // The aggressive plan must not promote future work into current scope.
    expect(claude.scoped.features.map(item => item.text).some(text => text.includes("ERP 자동 전송"))).toBe(false);
    expect(claude.scoped.features.map(item => item.text).some(text => text.includes("실적 파일 병합"))).toBe(true);
  });
});

describe("AX blocked review-only behavior", () => {
  it("never generates implementation guidance for a blocked gate", () => {
    const model = modelFor(permitCase.diagnosis, permitCase.plan);
    expect(model.gate).toBe("blocked");
    expect(model.scopeLevel).toBe(0);
    expect(model.scoped.features).toEqual([]);
    const prompt = buildAllInOnePrompt(permitCase.plan, "codex", { diagnosis: permitCase.diagnosis, taskName: permitCase.name });
    expect(prompt).toContain("진행 보류 상태");
    expect(prompt).not.toContain("### 이번 구현");
    expect(prompt).not.toContain("### 확인 후 구현");
    // Blocked permits review-only checks; the summary lists those, never implementation features.
    const include = planSummary(permitCase.diagnosis, permitCase.plan).include;
    expect(include.length).toBeGreaterThan(0);
    expect(include.join("\n")).toMatch(/검토|확인/u);
    expect(model.scoped.features).toEqual([]);
  });
});
