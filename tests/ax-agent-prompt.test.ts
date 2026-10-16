import { describe, expect, it } from "vitest";
import { buildAgentInstructionModel, buildAllInOnePrompt, type AgentInstructionModel } from "../src/lib/ax/guide";
import { executionProfile } from "../src/lib/ax/policy";
import { exportAxState, importAxState } from "../src/lib/ax/transfer";
import type { AxDiagnosis, AxPlan } from "../src/lib/ax/types";
import { diagnosisFixture, planFixture, taskFixture } from "./fixtures/ax";
import { agentCases, equipmentRuleCase, equipmentCase, freightCase, permitCase, type AxAgentCase } from "./fixtures/ax-agent-cases";

const withFactors = (values: readonly number[], patch: Partial<AxDiagnosis> = {}): AxDiagnosis => ({
  ...diagnosisFixture, ...patch, factors: diagnosisFixture.factors.map((factor, i) => ({ ...factor, aiValue: values[i] })),
});
const optionsFor = (c: Pick<AxAgentCase, "name" | "description" | "diagnosis">) => {
  const profile = executionProfile(c.diagnosis);
  return { taskName: c.name, prerequisites: profile.gate === "blocked" ? [] : profile.prerequisites, diagnosis: c.diagnosis, context: c.description };
};
const classified = (model: AgentInstructionModel, source: string, text: string) =>
  model.classified.find(item => item.sources.includes(source) && (item.text === text || item.original === text));
const authorized = (model: AgentInstructionModel, role: keyof AgentInstructionModel["scoped"]) => model.scoped[role].map(item => item.text);
const semantic = (m: AgentInstructionModel) => ({
  steps: m.steps, methods: m.methods, methodReasons: m.methodReasons, conditions: m.conditions,
  gate: m.gate, level: m.level, scopeLevel: m.scopeLevel, classified: m.classified, scoped: m.scoped, gaps: m.gaps,
});

describe("coding-agent instruction scope", () => {
  const levels = [[0, [3, 2, 2, 2, 5, 4]], [1, [4, 4, 3, 2, 4, 3]], [2, [4, 4, 4, 3, 3, 3]], [3, [5, 5, 5, 5, 1, 1]]] as const;
  it.each(levels.flatMap(([level, factors]) => (["go", "conditional", "no-go"] as const).map(verdict => [level, verdict, factors] as const)))(
    "Level %s · %s derives one authorized scope without changing policy", (level, verdict, factors) => {
      const diagnosis = withFactors(factors, { decisionGate: { verdict, reasons: verdict === "go" ? [] : ["권한 확인"] }, technicalChecks: [] });
      const before = structuredClone(diagnosis);
      const options = { taskName: "월간 취합", diagnosis };
      const profile = executionProfile(diagnosis);
      const model = buildAgentInstructionModel(planFixture, options);
      expect(model.steps).toEqual(profile.stepScope);
      expect(model.gate).toBe(profile.gate);
      expect(model.scopeLevel).toBe(verdict === "no-go" ? 0 : level);
      expect(model.methods).toHaveLength(model.steps.length);
      expect(model.methodReasons).toHaveLength(model.steps.length);
      const reviewOnly = verdict === "no-go" || level === 0;
      const currentSteps = model.steps.filter(step => ["implement", "after-check", "verify"].includes(step.scope));
      // PART B (기능 구현 vs 운영 자동화 분리): Level 1의 "자동화" 판정 단계도 담당자 실행 기반의
      // 사용자 실행형 기능으로 구현 범위에 포함된다. 무인 자동 실행은 여전히 "운영 자동화 적용"으로 제외.
      expect(currentSteps.map(step => step.step)).toEqual(reviewOnly ? ["자료 수집", "형식 검증"] : ["자료 수집", "형식 검증"]);
      expect(currentSteps.every(step => step.scope === (reviewOnly ? "verify" : verdict === "go" ? "implement" : "after-check"))).toBe(true);
      expect(model.scoped.features.every(item => ["implement", "after-check"].includes(item.scope))).toBe(true);
      for (const role of ["tests", "criteria", "outputs", "validationMethods"] as const) {
        expect(model.scoped[role].every(item => item.step && currentSteps.some(step => step.step === item.step))).toBe(true);
        expect(model.scoped[role].every(item => reviewOnly ? item.scope === "verify" : ["implement", "after-check"].includes(item.scope))).toBe(true);
      }
      if (reviewOnly) expect(model.scoped.features).toEqual([]);
      expect(model.steps.find(step => step.step === "담당자 승인")?.scope).toBe("human");
      expect(model.scoped.features).not.toContainEqual(expect.objectContaining({ step: "담당자 승인" }));
      expect(model.scoped.criteria).not.toContainEqual(expect.objectContaining({ step: "담당자 승인" }));
      expect(authorized(model, "features")).not.toContain("취합");
      expect(model.conditions.future.every(item => item.scope === "future")).toBe(true);
      expect(model.conditions.confirm.every(item => item.scope === "confirm")).toBe(true);
      const prompt = buildAllInOnePrompt(planFixture, "codex", options);
      expect(buildAllInOnePrompt(planFixture, "claude", options)).toBe(prompt);
      expect(buildAllInOnePrompt(planFixture, "codex", options)).toBe(prompt);
      expect(diagnosis).toEqual(before);
    });

  it.each([...agentCases, freightCase].map(c => [c.name, c] as const))("%s keeps its own diagnosed policy and evidence", (_name, c) => {
    const before = structuredClone(c);
    const options = optionsFor(c);
    const model = buildAgentInstructionModel(c.plan, options);
    expect(model.steps).toEqual(executionProfile(c.diagnosis).stepScope);
    for (const output of c.diagnosis.asIs.outputs) expect(classified(model, "diagnosis.asIs.outputs", output)).toBeDefined();
    expect(model.scoped.outputs.every(item => item.step && ["implement", "after-check", "verify"].includes(item.scope))).toBe(true);
    expect(buildAgentInstructionModel(c.plan, options)).toEqual(model);
    expect(buildAllInOnePrompt(c.plan, "claude", options)).toBe(buildAllInOnePrompt(c.plan, "codex", options));
    expect(c).toEqual(before);
  });
});

describe("classified generator boundaries", () => {
  it("does not promote unlinked future outputs, tests or acceptance claims into current requirements", () => {
    const c = equipmentRuleCase;
    const model = buildAgentInstructionModel(c.plan, optionsFor(c));
    for (const [source, text, role] of [
      ["plan.tests", "일일 보고서 자동 발행 결과 파일 재열기", "tests"],
      ["plan.acceptance", "일일 보고서 자동 발행 완료", "criteria"],
      ["diagnosis.poc.evaluation", "일일 보고서 자동 발행 결과 대조", "tests"],
      ["diagnosis.poc.success", "일일 보고서 자동 발행 성공", "criteria"],
      ["diagnosis.poc.outputs", "일일 보고서 자동 발행 결과", "outputs"],
    ] as const) {
      const item = classified(model, source, text);
      expect(item).toMatchObject({ role, scope: "confirm" });
      expect(item?.step).toBeUndefined();
      expect(authorized(model, role)).not.toContain(text);
    }
    const misplaced = classified(model, "plan.implementation", "일일 보고서 자동 발행 결과 파일 재열기");
    expect(misplaced).toMatchObject({ role: "tests", scope: "confirm" });
    expect(misplaced?.sources).toEqual(expect.arrayContaining(["plan.tests", "plan.implementation"]));
    expect(model.classified.filter(item => item.text === misplaced?.text)).toHaveLength(1);
    const scenario = "정상 케이스: 표준 형식 파일 3개 → 자동 매핑·검증·보고서 생성.";
    const scenarioModel = buildAgentInstructionModel({ ...c.plan, implementation: [...c.plan.implementation, scenario] }, optionsFor(c));
    expect(classified(scenarioModel, "plan.implementation", scenario)).toMatchObject({ role: "tests", scope: "confirm" });
    expect(authorized(scenarioModel, "features")).not.toContain(scenario);
  });

  it("holds human approval, exclusion and unconfirmed integration proposals outside implementation", () => {
    const c = equipmentCase;
    const plan: AxPlan = { ...c.plan, implementation: [...c.plan.implementation, "최종 승인 대리 확정", "외부 AI API 호출"], integrations: ["외부 AI API 연동"] };
    const model = buildAgentInstructionModel(plan, optionsFor(c));
    for (const text of ["공유 폴더 자동 수집", "가동률 자동 계산", "최종 승인 대리 확정", "외부 AI API 호출"]) expect(authorized(model, "features")).not.toContain(text);
    expect(model.conditions.confirm).toContainEqual(expect.objectContaining({ originals: expect.arrayContaining(["외부 AI API 연동"]) }));
    expect(classified(model, "plan.acceptance", "매핑 후보를 담당자가 확정한 뒤에만 결과 반영")).toMatchObject({ role: "criteria", scope: "confirm" });
    const blocked = buildAgentInstructionModel(permitCase.plan, optionsFor(permitCase));
    expect(blocked.scoped.features).toEqual([]);
    expect(blocked.scoped.criteria).toEqual([]);
    expect(classified(blocked, "plan.acceptance", "허가 처리 시간 단축")).toMatchObject({ role: "criteria", scope: "confirm" });
  });
});

describe("coding-agent instructions with missing or persisted data", () => {
  it("never invents authorized work from missing diagnosis, steps, or optional arrays", () => {
    const missing = buildAgentInstructionModel(planFixture, { taskName: "월간 취합" });
    expect(missing.profile).toBeUndefined();
    expect(missing.steps).toEqual([]);
    expect(missing.gaps.length).toBeGreaterThan(0);
    const sparse = { ...equipmentCase, diagnosis: { ...equipmentCase.diagnosis, asIs: { ...equipmentCase.diagnosis.asIs, inputs: [], outputs: [] }, stepAssessments: [] } };
    const sparseModel = buildAgentInstructionModel(sparse.plan, optionsFor(sparse));
    expect(sparseModel.steps).toEqual([]);
    expect(sparseModel.gaps.length).toBeGreaterThan(0);
    for (const model of [missing, sparseModel]) for (const role of ["features", "tests", "criteria", "outputs", "validationMethods"] as const) expect(model.scoped[role]).toEqual([]);
    const older = structuredClone(equipmentCase.diagnosis) as Partial<AxDiagnosis>;
    delete older.toBe;
    delete older.technicalChecks;
    delete older.risks;
    const before = structuredClone(older);
    const olderModel = buildAgentInstructionModel(undefined, { diagnosis: older as AxDiagnosis });
    expect(olderModel.steps.map(step => step.step)).toEqual(equipmentCase.diagnosis.stepAssessments.map(step => step.step));
    expect(olderModel.classified.some(item => item.sources.includes("diagnosis.technicalChecks"))).toBe(false);
    expect(older).toEqual(before);
  });

  it("honors needs-check information sufficiency even when the nominal verdict is go", () => {
    const diagnosis: AxDiagnosis = { ...equipmentRuleCase.diagnosis, informationSufficiency: "needs-check", followUpQuestions: ["실제 Excel 샘플과 누락 판정 기대값 확보"], decisionGate: { verdict: "go", reasons: [] }, technicalChecks: [] };
    const model = buildAgentInstructionModel(equipmentRuleCase.plan, { diagnosis });
    expect(model.gate).toBe("conditional");
    expect(model.steps.filter(step => step.scope === "after-check").map(step => step.step)).toContain("누락·중복 검증");
    expect(model.steps.some(step => step.scope === "implement")).toBe(false);
  });

  it("builds from diagnosis alone without introducing a generated plan source", () => {
    const model = buildAgentInstructionModel(undefined, optionsFor(equipmentCase));
    expect(model.steps).toEqual(executionProfile(equipmentCase.diagnosis).stepScope);
    expect(model.classified.some(item => item.sources.some(source => source.startsWith("plan.")))).toBe(false);
  });

  it("preserves stored diagnosis and derived behavior across export/import", () => {
    const task = { ...taskFixture("stored", { ...equipmentCase.diagnosis, planCodex: equipmentCase.plan }), name: equipmentCase.name, description: equipmentCase.description };
    const state = { schemaVersion: 1 as const, tasks: [task], selectedTaskId: task.id, step: 4 };
    const before = structuredClone(state);
    const restored = importAxState(exportAxState(state)).tasks[0];
    expect(restored.diagnosis).toEqual(task.diagnosis);
    expect(restored.diagnosis?.planClaude).toBeUndefined();
    const options = optionsFor({ name: restored.name, description: restored.description, diagnosis: restored.diagnosis! });
    expect(semantic(buildAgentInstructionModel(restored.diagnosis!.planCodex, options))).toEqual(semantic(buildAgentInstructionModel(equipmentCase.plan, optionsFor(equipmentCase))));
    expect(buildAllInOnePrompt(restored.diagnosis!.planCodex, "codex", options)).toBe(buildAllInOnePrompt(equipmentCase.plan, "codex", optionsFor(equipmentCase)));
    expect(state).toEqual(before);
  });
});
