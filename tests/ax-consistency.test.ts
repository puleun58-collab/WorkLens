import { describe, expect, it } from "vitest";
import { buildAgentInstructionModel, buildAllInOnePrompt, planSummary, stepMethodLabel, type AgentInstructionModel } from "../src/lib/ax/guide";
import { executionProfile } from "../src/lib/ax/policy";
import { exportAxState, importAxState } from "../src/lib/ax/transfer";
import type { AxDiagnosis, AxPlan } from "../src/lib/ax/types";
import { taskFixture } from "./fixtures/ax";
import { agentCases, contractCase, equipmentCase, equipmentRuleCase, facilityCase, freightCase, inquiryCase, permitCase } from "./fixtures/ax-agent-cases";

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
    const algorithm: AxDiagnosis = { ...unknown, stepAssessments: unknown.stepAssessments.map(step => step.step === "누락·중복 검증"
      ? { ...step, note: "필수 항목 누락과 운송장 번호 중복 여부를 검사하는 알고리즘" } : step) };
    const algorithmModel = modelFor(algorithm, c.plan);
    expect(algorithmModel.methods[ruleIndex]).toBe("rule");
    expect(algorithmModel.methodReasons[ruleIndex]).toContain("알고리즘");
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
    const duplicateIndices = model.steps.flatMap((step, index) => step.step === "누락·중복 검증" ? [index] : []);
    for (const index of duplicateIndices) {
      expect(model.methods[index]).toBe("confirm");
      expect(model.methodReasons[index]).toBeTruthy();
    }
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
    expect(summary.humanKept).not.toContain("보고서 자동 승인");
    expect(summary.excluded).not.toContain("담당자 최종 검토·승인");
    expect(model.classified).toContainEqual(expect.objectContaining({ role: "human", text: "담당자 최종 검토·승인", sources: expect.arrayContaining(["diagnosis.humanInLoop"]) }));
    expect(model.classified).toContainEqual(expect.objectContaining({ role: "excluded", text: "보고서 자동 승인", sources: expect.arrayContaining(["diagnosis.poc.outOfScope"]) }));
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


  it("derives freight processing from evidence without expanding the Level 1 conditional policy", () => {
    const c = freightCase;
    const before = structuredClone(c);
    const model = modelFor(c.diagnosis, c.plan);
    expect(model.steps).toEqual(executionProfile(c.diagnosis).stepScope);
    expect(model.gate).toBe("conditional");
    expect(model.scopeLevel).toBe(1);
    expect(model.methods).toEqual(["script", "rule", "confirm", "manual"]);
    expect(model.steps.map(step => step.scope)).toEqual(["after-check", "after-check", "future", "human"]);
    expect(model.scoped.outputs).toContainEqual(expect.objectContaining({ text: "실적 파일 병합 — 병합 검토 파일", step: "실적 파일 병합", scope: "after-check" }));
    const test = from(model, "plan.tests", "누락·중복 검증 — 샘플 누락·중복 검사");
    expect(test).toMatchObject({ role: "tests", step: "누락·중복 검증", scope: "after-check" });
    expect(test?.sources).toEqual(expect.arrayContaining(["plan.tests", "diagnosis.poc.evaluation"]));
    expect(model.scoped.tests).toContainEqual(test);
    for (const [source, text, role] of [
      ["diagnosis.poc.outputs", "정산표 생성 결과", "outputs"],
      ["diagnosis.poc.evaluation", "정산표 생성 결과 대조", "tests"],
      ["plan.tests", "정산표 생성 결과 대조", "tests"],
      ["diagnosis.poc.success", "정산표 생성 완료", "criteria"],
    ] as const) {
      const item = from(model, source, text);
      expect(item).toMatchObject({ role, scope: "confirm" });
      expect(item?.step).toBeUndefined();
      expect(model.scoped[role]).not.toContainEqual(item);
    }
    const explicit = "정산표 생성 — 정산 결과 재열기";
    expect(from(modelFor(c.diagnosis, { ...c.plan, tests: [explicit] }), "plan.tests", explicit))
      .toMatchObject({ step: "정산표 생성", scope: "future" });
    expect(c).toEqual(before);
  });

  it("retains conflicting method evidence while requiring confirmation", () => {
    const c = freightCase;
    const conflicting: AxDiagnosis = { ...c.diagnosis, toBe: c.diagnosis.toBe.map(step => step.step === "실적 파일 병합"
      ? { ...step, owner: "AI", description: "AI 모델을 호출하여 파일 병합 후보를 제안" } : step) };
    const model = modelFor(conflicting, c.plan);
    const index = model.steps.findIndex(step => step.step === "실적 파일 병합");
    expect(model.methods[index]).toBe("confirm");
    expect(model.methodReasons[index]).toContain("로컬 스크립트");
    expect(model.methodReasons[index]).toContain("AI 모델");
    expect(model.steps).toEqual(executionProfile(conflicting).stepScope);
    const noteConflict: AxDiagnosis = { ...c.diagnosis, stepAssessments: c.diagnosis.stepAssessments.map(step => step.step === "누락·중복 검증"
      ? { ...step, note: "규칙 기반 알고리즘과 AI 모델 호출로 누락·중복 후보 제안" } : step) };
    const noteModel = modelFor(noteConflict, c.plan);
    const ruleIndex = noteModel.steps.findIndex(step => step.step === "누락·중복 검증");
    expect(noteModel.methods[ruleIndex]).toBe("confirm");
    expect(noteModel.methodReasons[ruleIndex]).toContain("규칙 기반 알고리즘");
    expect(noteModel.methodReasons[ruleIndex]).toContain("AI 모델");
  });

  it("keeps diagnosis metrics and comparison-recording methods out of pass conditions", () => {
    const c = freightCase;
    const model = modelFor(c.diagnosis, c.plan);
    const metric = from(model, "diagnosis.poc.success", "누락·중복 검증 — 정확도 95% 이상");
    expect(metric).toMatchObject({ scope: "confirm" });
    expect(model.scoped.criteria).not.toContainEqual(metric);
    const method = from(model, "diagnosis.poc.success", "누락·중복 검증 — 수동 결과와 대조하고 차이 기록");
    expect(model.scoped.validationMethods).toContainEqual(method);
    expect(model.scoped.criteria).not.toContainEqual(method);
    const criterion = from(model, "diagnosis.poc.success", "누락·중복 검증 — 누락 건이 모두 검토 대상으로 표시");
    expect(model.scoped.criteria).toContainEqual(criterion);
    const passing = "누락·중복 검증 — 수동 결과와 대조하여 모두 일치";
    const passingModel = modelFor({ ...c.diagnosis, poc: { ...c.diagnosis.poc, success: [passing] } }, c.plan);
    expect(passingModel.scoped.criteria).toContainEqual(expect.objectContaining({ text: passing }));
    expect(passingModel.scoped.validationMethods).not.toContainEqual(expect.objectContaining({ text: passing }));
    const recording = "누락·중복 검증 — 수동 결과와 전수 대조해 불일치 항목과 사유를 기록한다.";
    const recordingModel = modelFor({ ...c.diagnosis, poc: { ...c.diagnosis.poc, success: [recording] } }, c.plan);
    expect(recordingModel.scoped.validationMethods).toContainEqual(expect.objectContaining({ text: recording }));
    expect(recordingModel.scoped.criteria).not.toContainEqual(expect.objectContaining({ text: recording }));
  });

  it("groups exact conditions without losing sources, step links, or distinct systems", () => {
    const c = freightCase;
    const current = "실적 파일 병합 — Excel 샘플 확보";
    const required = "누락·중복 검증 — 필수 항목 정의 사용";
    const future = "정산표 생성 — 운임표 확정";
    const unknown = "적용 업무 확인";
    const global = "외부 전송 전 개인정보 제거";
    const diagnosis: AxDiagnosis = { ...c.diagnosis,
      technicalChecks: [...c.diagnosis.technicalChecks, { topic: "WMS", status: "확인 필요", note: "읽기 권한 확인" }],
    };
    const plan: AxPlan = { ...c.plan, prerequisites: [current, ` 1) ${current}.`, required, future, "ERP — 읽기 권한 확인", "WMS — 읽기 권한 확인", unknown],
      security: [global, `1) ${global}.`] };
    const model = buildAgentInstructionModel(plan, { diagnosis, prerequisites: [current] });
    const conditions = Object.values(model.conditions).flat();
    const linked = conditions.filter(item => item.text === current);
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ step: "실적 파일 병합" });
    expect(linked[0].sources).toEqual(expect.arrayContaining(["plan.prerequisites", "diagnosis.technicalChecks", "options.prerequisites"]));
    expect(model.conditions.current).toContainEqual(expect.objectContaining({ text: required, step: "누락·중복 검증", scope: "after-check" }));
    expect(model.conditions.future).toContainEqual(expect.objectContaining({ text: future, step: "정산표 생성" }));
    expect(model.conditions.confirm).toContainEqual(expect.objectContaining({ text: unknown }));
    expect(model.conditions.global).toContainEqual(expect.objectContaining({ text: global, sources: ["plan.security"] }));
    for (const system of ["ERP", "WMS"]) {
      expect(conditions).toContainEqual(expect.objectContaining({ text: `${system} — 읽기 권한 확인` }));
    }
    expect(conditions.some(item => item.sources.includes("policy.prerequisites"))).toBe(true);
    expect(conditions).not.toContainEqual(expect.objectContaining({ text: "Excel — 로컬 파일 사용 가능" }));
    expect(from(model, "diagnosis.technicalChecks", "Excel — 로컬 파일 사용 가능")).toMatchObject({ role: "reference" });
  });

  it("preserves freight behavioral groups through the unchanged storage schema", () => {
    const c = freightCase;
    const task = taskFixture("freight", { ...c.diagnosis, planCodex: c.plan });
    const state = { schemaVersion: 1 as const, tasks: [task], selectedTaskId: task.id, step: 4 };
    const before = structuredClone(state);
    const restored = importAxState(exportAxState(state));
    expect(restored).toEqual(state);
    const diagnosis = restored.tasks[0].diagnosis!;
    const semantic = (model: AgentInstructionModel) => ({
      steps: model.steps, methods: model.methods, methodReasons: model.methodReasons, gate: model.gate,
      scoped: model.scoped, classified: model.classified, conditions: model.conditions,
    });
    expect(semantic(modelFor(diagnosis, diagnosis.planCodex))).toEqual(semantic(modelFor(c.diagnosis, c.plan)));
    expect(state).toEqual(before);
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
