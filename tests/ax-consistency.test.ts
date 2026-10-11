import { describe, expect, it } from "vitest";
import { buildAgentInstructionModel, buildAllInOnePrompt, planSummary, stepMethodLabel, type AgentInstructionModel } from "../src/lib/ax/guide";
import { executionProfile } from "../src/lib/ax/policy";
import { exportAxState, importAxState } from "../src/lib/ax/transfer";
import type { AxDiagnosis, AxPlan } from "../src/lib/ax/types";
import { taskFixture } from "./fixtures/ax";
import { agentCases, contractCase, equipmentCase, equipmentRuleCase, facilityCase, inquiryCase, permitCase } from "./fixtures/ax-agent-cases";

const modelFor = (diagnosis: AxDiagnosis, plan?: AxPlan) => buildAgentInstructionModel(plan, { diagnosis });
const from = (model: AgentInstructionModel, source: string, text: string) =>
  model.classified.find(item => item.sources.includes(source) && (item.text === text || item.original === text));

// Linking is deliberately tested with only the fields supported by the persisted strict schema.
describe("AX shared processing and relational scope", () => {
  it("keeps five representative fixtures aligned with policy and with their rendered per-step processing method", () => {
    for (const c of agentCases) {
      const before = structuredClone(c);
      const profile = executionProfile(c.diagnosis);
      const model = modelFor(c.diagnosis, c.plan);
      const summary = planSummary(c.diagnosis, c.plan, c.description);
      const prompt = buildAllInOnePrompt(c.plan, "codex", { diagnosis: c.diagnosis, context: c.description });
      expect(model.steps).toEqual(profile.stepScope);
      expect(model.methods).toHaveLength(model.steps.length);
      expect(model.gate).toBe(profile.gate);
      for (const [index, step] of model.steps.entries()) {
        if (!["implement", "after-check", "verify"].includes(step.scope)) continue;
        const label = stepMethodLabel(model, index);
        expect(prompt).toContain(`${step.step} — ${label}`);
        expect(summary.include).toContain(`${step.step} ${label}`);
        if (model.methods[index] === "rule") expect(label).not.toMatch(/AI 보조 결과|후보·초안/u);
        if (model.methods[index] === "confirm") expect(label).toMatch(/확인/u);
      }
      expect(c).toEqual(before);
    }
  });

  it("does not turn an AI-verdict rule into AI processing, and does not guess a method from an empty note", () => {
    const c = equipmentRuleCase;
    const model = modelFor(c.diagnosis, c.plan);
    const ruleIndex = model.steps.findIndex(step => step.step === "누락·중복 검증");
    const candidateIndex = model.steps.findIndex(step => step.step === "컬럼 매핑 및 표준화");
    expect(model.steps[ruleIndex].verdict).toBe("AI 보조");
    expect(model.methods[ruleIndex]).toBe("rule");
    expect(model.methods[candidateIndex]).toBe("assist");
    expect(planSummary(c.diagnosis).include).toContain(`누락·중복 검증 ${stepMethodLabel(model, ruleIndex)}`);
    const unknown: AxDiagnosis = { ...c.diagnosis, stepAssessments: c.diagnosis.stepAssessments.map(step => step.step === "누락·중복 검증" ? { ...step, note: "" } : step) };
    const unknownModel = modelFor(unknown, c.plan);
    expect(unknownModel.methods[ruleIndex]).toBe("confirm");
    expect(planSummary(unknown).include).toContain(`누락·중복 검증 ${stepMethodLabel(unknownModel, ruleIndex)}`);
    expect(planSummary(unknown).include.join("\n")).not.toContain("누락·중복 검증 AI 보조 결과(후보·초안) 생성");
    expect(unknownModel.steps[ruleIndex].scope).toBe(model.steps[ruleIndex].scope);
    const blocked = modelFor({ ...c.diagnosis, decisionGate: { verdict: "no-go", reasons: ["권한 미확인"] } }, c.plan);
    expect(blocked.methods).toEqual(model.methods);
    expect(blocked.steps[ruleIndex].scope).toBe("verify");
    expect(blocked.scoped.features).toEqual([]);
  });

  it("links unique exact normalized names and explicit step prefixes, not substring, alias or order", () => {
    const c = equipmentRuleCase;
    const exact = "컬럼   매핑 및 표준화. — 후보 결과 확인";
    const future = "일일 보고서 자동 발행 — 파일 재열기";
    const fragment = "표준화 후보 확인";
    const longer = "일일 보고서 자동 발행물 확인";
    const alias = "공유 폴더 자동 수집";
    const plan = { ...c.plan, tests: [exact, future, fragment, longer, alias] };
    const model = modelFor(c.diagnosis, plan);
    expect(from(model, "plan.tests", exact)).toMatchObject({ step: "컬럼 매핑 및 표준화", scope: "after-check" });
    expect(from(model, "plan.tests", future)).toMatchObject({ step: "일일 보고서 자동 발행", scope: "future" });
    for (const text of [fragment, longer, alias]) {
      const item = from(model, "plan.tests", text);
      expect(item?.step).toBeUndefined();
      expect(item?.scope).toBe("confirm");
      expect(model.scoped.tests).not.toContainEqual(item);
    }
    const reversed = { ...c.diagnosis, stepAssessments: [...c.diagnosis.stepAssessments].reverse() };
    expect(from(modelFor(reversed, plan), "plan.tests", exact)?.step).toBe("컬럼 매핑 및 표준화");
    expect(from(modelFor(reversed, plan), "plan.tests", longer)?.step).toBeUndefined();
  });

  it("distinguishes original unlinked PoC claims from an explicitly related future-step variant", () => {
    const c = equipmentRuleCase;
    const raw = modelFor(c.diagnosis, c.plan);
    const text = c.diagnosis.poc.success.at(-1)!;
    expect(from(raw, "diagnosis.poc.success", text)).toMatchObject({ role: "criteria", scope: "confirm" });
    expect(raw.scoped.criteria.map(item => item.text)).not.toContain(text);
    const explicit = "일일 보고서 자동 발행 — 성공";
    const diagnosis = { ...c.diagnosis, poc: { ...c.diagnosis.poc, success: [...c.diagnosis.poc.success.slice(0, -1), explicit] } };
    const model = modelFor(diagnosis, c.plan);
    expect(from(model, "diagnosis.poc.success", explicit)).toMatchObject({ step: "일일 보고서 자동 발행", scope: "future" });
    expect(model.scoped.criteria.map(item => item.text)).not.toContain(explicit);
    expect(c.diagnosis.poc.success.at(-1)).toBe(text);
  });

  it("resolves the full name when one diagnosed step begins with another diagnosed step name", () => {
    const diagnosis: AxDiagnosis = { ...contractCase.diagnosis, stepAssessments: [
      ...contractCase.diagnosis.stepAssessments,
      { step: "만료 예정 계약 추출 연장", verdict: "사람 유지", owner: "사용자", note: "담당자 결정" },
    ] };
    const exact = "만료 예정 계약 추출 연장 — 계약 비교";
    const plan = { ...contractCase.plan, tests: [exact] };
    expect(from(modelFor(diagnosis, plan), "plan.tests", exact)).toMatchObject({ step: "만료 예정 계약 추출 연장", scope: "human" });
  });

  it("does not coalesce duplicate step names or use substring technical-check topics as links", () => {
    const c = equipmentRuleCase;
    const repeated: AxDiagnosis = { ...c.diagnosis,
      stepAssessments: [...c.diagnosis.stepAssessments, { step: "누락·중복 검증", verdict: "자동화", owner: "시스템", note: "독립된 검증 조건" }],
      technicalChecks: [{ topic: "검증", status: "확인 필요", note: "미확정" }],
    };
    const text = "누락·중복 검증 — 샘플 비교";
    const model = modelFor(repeated, { ...c.plan, tests: [text] });
    expect(model.steps.filter(step => step.step === "누락·중복 검증")).toHaveLength(2);
    expect(from(model, "plan.tests", text)).toMatchObject({ scope: "confirm" });
    expect(from(model, "plan.tests", text)?.step).toBeUndefined();
    expect(from(model, "diagnosis.technicalChecks", "검증 — 미확정")?.step).toBeUndefined();
    expect(model.gate).toBe("conditional");
  });

  it("keeps manual and exclusion fields restrictive without promoting an unlinked approval sentence", () => {
    const c = equipmentCase;
    const risky = "최종 승인 자동화";
    const acceptance = "승인자 확인 뒤에만 시스템에 자동 등록";
    const plan: AxPlan = { ...c.plan, inScope: [...c.plan.inScope, risky], implementation: [...c.plan.implementation, risky], acceptance: [...c.plan.acceptance, acceptance] };
    const model = modelFor(c.diagnosis, plan);
    const summary = planSummary(c.diagnosis, plan);
    expect(model.steps.find(step => step.step === "최종 승인")?.scope).toBe("human");
    expect(["implement", "after-check"]).not.toContain(from(model, "plan.implementation", risky)?.scope);
    expect(model.scoped.features.map(item => item.text)).not.toContain(risky);
    expect(summary.humanKept.join("\n")).toContain("담당자");
    expect(summary.excluded.join("\n")).toContain("자동 승인");
    expect(summary.constraints.join("\n")).toContain("담당자 최종 검토·승인");
    expect(summary.constraints.join("\n")).toContain("최종 승인 자동화");
    expect(from(model, "plan.acceptance", acceptance)).toMatchObject({ scope: "confirm" });
    expect(model.scoped.criteria.map(item => item.text)).not.toContain(acceptance);
    expect(buildAllInOnePrompt(plan, "codex", { diagnosis: c.diagnosis })).toContain(acceptance);
  });

  it.each([
    [inquiryCase, "답변 자동 발송", "수신자 확인 뒤에만 고객에게 자동 발송"],
    [facilityCase, "업체 자동 발주", "승인 후에만 외부 계약 시스템을 갱신"],
    [permitCase, "허가 자동 승인", "담당자 확인 후에만 허가 결과 확정"],
  ] as const)("keeps %s human decisions and risky sends or mutations outside required work", (c, excluded, approval) => {
    const plan: AxPlan = { ...c.plan, acceptance: [...c.plan.acceptance, approval], implementation: [...c.plan.implementation, excluded] };
    const model = modelFor(c.diagnosis, plan);
    const summary = planSummary(c.diagnosis, plan);
    expect(model.scoped.features.map(item => item.text)).not.toContain(excluded);
    expect(model.scoped.criteria.map(item => item.text)).not.toContain(approval);
    expect(from(model, "plan.acceptance", approval)?.scope).toBe("confirm");
    expect(summary.constraints.join("\n")).toContain(excluded);
    expect(summary.constraints.some(text => text.includes("diagnosis.humanInLoop"))).toBe(true);
    expect(summary.constraints.some(text => text.includes("diagnosis.poc.outOfScope"))).toBe(true);
  });

  it("does not make future-step conditions required for independent current steps or bypass Gate and Level 1", () => {
    const c = equipmentRuleCase;
    const future = "일일 보고서 자동 발행 — 배포 권한 확인";
    const plan = { ...c.plan, prerequisites: [future] };
    const model = modelFor(c.diagnosis, plan);
    expect(from(model, "plan.prerequisites", future)).toMatchObject({ step: "일일 보고서 자동 발행", scope: "future" });
    expect(model.scoped.conditions.map(item => item.text)).not.toContain(future);
    expect(model.steps.find(step => step.step === "보고서 초안 작성")?.scope).toBe("after-check");
    expect(model.gate).toBe("conditional");
    expect(model.scoped.features.map(item => item.text)).not.toContain("일일 보고서 자동 발행");
    expect(modelFor(permitCase.diagnosis, { ...permitCase.plan, acceptance: ["허가 승인 — 담당자 확인 후 자동 발송"] }).scoped.criteria).toEqual([]);
  });


  it("repeats deterministically across export/import and sparse older in-memory data without mutating input", () => {
    const c = equipmentRuleCase;
    const task = { ...taskFixture("consistency", { ...c.diagnosis, planCodex: c.plan }), name: c.name, description: c.description };
    const state = { schemaVersion: 1 as const, tasks: [task], selectedTaskId: task.id, step: 4 };
    const before = structuredClone(state);
    const restored = importAxState(exportAxState(state)).tasks[0].diagnosis!;
    const original = modelFor(c.diagnosis, c.plan), roundTrip = modelFor(restored, restored.planCodex);
    expect(roundTrip.methods).toEqual(original.methods);
    expect(roundTrip.classified).toEqual(original.classified);
    expect(planSummary(restored, restored.planCodex)).toEqual(planSummary(c.diagnosis, c.plan));
    expect(modelFor(restored, restored.planCodex)).toEqual(roundTrip);
    const sparse = structuredClone(restored) as AxDiagnosis;
    delete (sparse as Partial<AxDiagnosis>).technicalChecks;
    delete (sparse as Partial<AxDiagnosis>).toBe;
    const sparseBefore = structuredClone(sparse);
    const sparseModel = modelFor(sparse, undefined);
    expect(sparseModel.steps).toHaveLength(restored.stepAssessments.length);
    expect(sparseModel.methods).toHaveLength(sparseModel.steps.length);
    expect(sparse).toEqual(sparseBefore);
    expect(state).toEqual(before);
  });
});
