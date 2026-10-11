import { describe, expect, it } from "vitest";
import { buildAgentInstructionModel, buildAllInOnePrompt, stepMethodLabel, type AgentInstructionModel } from "../src/lib/ax/guide";
import { executionProfile } from "../src/lib/ax/policy";
import { exportAxState, importAxState } from "../src/lib/ax/transfer";
import type { AxDiagnosis, AxPlan } from "../src/lib/ax/types";
import { diagnosisFixture, planFixture, taskFixture } from "./fixtures/ax";
import { agentCases, equipmentRuleCase, equipmentCase, inquiryCase, permitCase, type AxAgentCase } from "./fixtures/ax-agent-cases";

const AREAS = ["작업 목표·실행 범위", "프로젝트 사전 확인", "선행 조건·차단 사항", "업무 데이터 흐름", "단계별 실제 구현", "예외·보안·승인", "테스트·회귀 검증", "Git·배포·운영", "완료 조건", "인수인계·완료 보고"];
const sectionsOf = (prompt: string) => prompt.match(/^## \d+\. .+$/gm)?.map(line => line.replace(/^## \d+\. /u, "")) ?? [];
const sectionBody = (prompt: string, title: string) => prompt.split(new RegExp(`^## \\d+\\. ${title}$`, "m"))[1]?.split(/\n## \d+\. /)[0] ?? "";
const block = (text: string, heading: string) => text.split(`### ${heading}`)[1]?.split(/\n### /)[0] ?? "";
/** Step names listed in a scope group of section 1 ("1. step — treatment"). */
const groupSteps = (prompt: string, heading: string) => [...block(sectionBody(prompt, "작업 목표·실행 범위"), heading).matchAll(/^\d+\. (.+?) — /gm)].map(match => match[1]);
const unitSteps = (prompt: string) => [...sectionBody(prompt, "단계별 실제 구현").matchAll(/^### 단계 \d+\. (.+?) — /gm)].map(match => match[1]);
const completionSteps = (prompt: string) => [...block(sectionBody(prompt, "완료 조건"), "단계별").matchAll(/^- (.+?): /gm)].map(match => match[1]);
const withFactors = (values: number[], patch: Partial<AxDiagnosis> = {}): AxDiagnosis => ({
  ...diagnosisFixture, ...patch, factors: diagnosisFixture.factors.map((factor, i) => ({ ...factor, aiValue: values[i] })),
});
/** Mirrors AxExecutionPackage: diagnosed prerequisites are passed only when the gate is not blocked. */
function promptFor(c: Pick<AxAgentCase, "name" | "description" | "diagnosis"> & { plan?: AxPlan }, tool: "codex" | "claude" = "codex") {
  const profile = executionProfile(c.diagnosis);
  return buildAllInOnePrompt(c.plan, tool, { taskName: c.name, prerequisites: profile.gate === "blocked" ? [] : profile.prerequisites, diagnosis: c.diagnosis, context: c.description });
}
const optionsFor = (c: Pick<AxAgentCase, "name" | "description" | "diagnosis">) => {
  const profile = executionProfile(c.diagnosis);
  return { taskName: c.name, prerequisites: profile.gate === "blocked" ? [] : profile.prerequisites, diagnosis: c.diagnosis, context: c.description };
};
const classified = (model: AgentInstructionModel, source: string, text: string) =>
  model.classified.find(item => item.sources.includes(source) && item.text === text);
const authorized = (model: AgentInstructionModel, role: keyof AgentInstructionModel["scoped"]) =>
  model.scoped[role].map(item => item.text);

describe("coding-agent instruction scope", () => {
  const levels = [[0, [3, 2, 2, 2, 5, 4]], [1, [4, 4, 3, 2, 4, 3]], [2, [4, 4, 4, 3, 3, 3]], [3, [5, 5, 5, 5, 1, 1]]] as const;
  it.each(levels.flatMap(([level, factors]) => (["go", "conditional", "no-go"] as const).map(verdict => [level, verdict, factors] as const)))(
    "Level %s · %s: every section uses the same Level × Gate step scope", (level, verdict, factors) => {
      const diagnosis = withFactors([...factors], { decisionGate: { verdict, reasons: verdict === "go" ? [] : ["권한 확인"] }, technicalChecks: [] });
      const before = structuredClone(diagnosis);
      const prompt = buildAllInOnePrompt(planFixture, "codex", { taskName: "월간 취합", diagnosis });
      const profile = executionProfile(diagnosis);
      const model = buildAgentInstructionModel(planFixture, { taskName: "월간 취합", diagnosis });
      expect(model.steps).toEqual(profile.stepScope);
      expect(model.gate).toBe(profile.gate);
      expect(model.scopeLevel).toBe(verdict === "no-go" ? 0 : level);
      expect(model.scoped.features.every(item => item.scope === "implement" || item.scope === "after-check")).toBe(true);
      const reviewOnly = verdict === "no-go" || level === 0;
      // Review-only scope keeps its checks as review checks; it never authorizes features or implementation work.
      for (const role of ["tests", "criteria", "outputs", "conditions"] as const) {
        expect(model.scoped[role].every(item => reviewOnly ? item.scope === "verify" : item.scope === "implement" || item.scope === "after-check")).toBe(true);
      }
      if (reviewOnly) expect(model.scoped.features).toEqual([]);
      const scopeLevel = verdict === "no-go" ? 0 : level;
      expect(sectionsOf(prompt)).toEqual(AREAS);
      // Areas are omitted when empty, so cross-references use section names, never numbers.
      expect(prompt).not.toMatch(/\d+번/u);
      expect(sectionBody(prompt, "작업 목표·실행 범위")).toContain(`- 실행 상태: ${{ go: "진행 가능", conditional: "확인 후 진행", "no-go": "진행 보류" }[verdict]}`);

      const work = groupSteps(prompt, verdict === "go" ? "이번 구현" : "확인 후 구현");
      if (scopeLevel === 0) {
        expect(groupSteps(prompt, "검토·검증만")).toEqual(["자료 수집", "형식 검증"]);
        expect(groupSteps(prompt, "이번 구현")).toEqual([]);
        expect(groupSteps(prompt, "확인 후 구현")).toEqual([]);
        expect(unitSteps(prompt)).toEqual([]);
        expect(sectionBody(prompt, "단계별 실제 구현")).not.toContain("### 실제 동작하는 기본 토대");
        // A generated inclusion never becomes work in a review-only scope.
        expect(model.scoped.features).toEqual([]);
        expect(prompt).toContain("취합");
      } else {
        expect(work).toEqual(level === 1 ? ["형식 검증"] : ["자료 수집", "형식 검증"]);
        expect(unitSteps(prompt)).toEqual(work);
        expect(completionSteps(prompt)).toEqual(work);
        if (level === 1) expect(block(sectionBody(prompt, "작업 목표·실행 범위"), "향후 확장 (이번 작업에서 구현하지 않음)")).toContain("자료 수집 — 자동화 단계지만 현재 Level 1 범위 밖");
        // Policy PoC remains authoritative; the guide presents confirmed processing evidence separately.
        for (const step of profile.stepScope.filter(s => s.scope === "implement" || s.scope === "after-check")) expect(profile.poc.inScope).toContain(`${step.step} ${step.treatment}`);
        expect(model.ambiguous.some(item => item.text === "취합")).toBe(true);
        expect(prompt).toContain("취합");
      }
      if (verdict === "no-go") {
        expect(sectionBody(prompt, "선행 조건·차단 사항")).toContain("기능 구현·코드 생성·스캐폴딩·운영 연결을 하지 마세요.");
        expect(block(sectionBody(prompt, "선행 조건·차단 사항"), "차단 사유")).toContain("- 권한 확인");
      }
      // The human step is listed once as kept work and is never implemented or required for completion.
      expect(block(sectionBody(prompt, "작업 목표·실행 범위"), "제외·담당자 유지 (자동화로 대체하지 않음)")).toContain("- 담당자 승인 (담당자 수행)");
      expect([...unitSteps(prompt), ...completionSteps(prompt), ...groupSteps(prompt, "검토·검증만")]).not.toContain("담당자 승인");
      expect(buildAllInOnePrompt(planFixture, "claude", { taskName: "월간 취합", diagnosis })).toBe(prompt);
      expect(diagnosis).toEqual(before);
    });

  it("keeps Level 1 equipment proposals that run unattended, excluded or human out of implementation", () => {
    const before = structuredClone(equipmentCase);
    const plan = { ...equipmentCase.plan, implementation: [...equipmentCase.plan.implementation, "최종 승인 대리 확정"] };
    const model = buildAgentInstructionModel(plan, optionsFor(equipmentCase));
    const prompt = buildAllInOnePrompt(plan, "codex", optionsFor(equipmentCase));
    const scope = sectionBody(prompt, "작업 목표·실행 범위"), implementation = sectionBody(prompt, "단계별 실제 구현"), completion = sectionBody(prompt, "완료 조건");
    expect(groupSteps(prompt, "확인 후 구현")).toEqual(["AI 컬럼 매핑", "보고서 초안 작성"]);
    for (const step of ["공유 폴더 파일 수집", "데이터 표준화", "누락·중복 검증", "가동률 계산"]) {
      expect(block(scope, "향후 확장 (이번 작업에서 구현하지 않음)")).toContain(`- ${step} — 자동화 단계지만 현재 Level 1 범위 밖`);
      expect(unitSteps(prompt)).not.toContain(step);
    }
    for (const proposal of ["공유 폴더 자동 수집", "가동률 자동 계산"]) {
      expect(authorized(model, "features")).not.toContain(proposal);
      expect(model.classified.some(item => item.text === proposal && item.scope !== "implement" && item.scope !== "after-check")).toBe(true);
      expect(implementation).not.toContain(`세부 제안 (생성 계획): ${proposal}`);
      expect(completion).not.toContain(proposal);
    }
    expect(classified(model, "plan.implementation", "AI 컬럼 매핑 후보 제안")).toMatchObject({ role: "features", scope: "confirm" });
    expect(model.steps.find(s => s.step === "최종 승인")?.scope).toBe("human");
    expect(authorized(model, "features")).not.toContain("최종 승인 대리 확정");
    expect(implementation).not.toContain("세부 제안 (생성 계획): 최종 승인 대리 확정");
    expect(implementation).not.toContain("세부 제안 (생성 계획): AI 컬럼 매핑 후보 제안");
    expect(authorized(model, "criteria")).not.toContain("누락·중복 건수가 수동 검토와 동일하거나 감소");
    expect(block(completion, "판정 기준")).not.toContain("누락·중복 건수가 수동 검토와 동일하거나 감소");
    expect(prompt).toContain("누락·중복 건수가 수동 검토와 동일하거나 감소");
    // An unlinked free-form acceptance sentence cannot authorize an approval workflow.
    expect(classified(model, "plan.acceptance", "매핑 후보를 담당자가 확정한 뒤에만 결과 반영")).toMatchObject({ role: "criteria", scope: "confirm" });
    expect(authorized(model, "criteria")).not.toContain("매핑 후보를 담당자가 확정한 뒤에만 결과 반영");
    expect(block(completion, "판정 기준")).not.toContain("매핑 후보를 담당자가 확정한 뒤에만 결과 반영");
    expect(block(completion, "향후·기준 확인이 필요한 판정 (이번 구현의 필수 완료 조건 아님)")).toContain("누락·중복 건수가 수동 검토와 동일하거나 감소 — 기대 결과·측정 기준 확인 필요");
    // A human step's "자동화" restatement is not listed again next to the kept human step.
    expect(block(scope, "제외·담당자 유지 (자동화로 대체하지 않음)")).not.toContain("최종 승인 자동화");
    expect(prompt).toContain("공유 폴더 접근 권한");
    expect(prompt).toContain("보고서 템플릿");
    expect(equipmentCase).toEqual(before);
  });

  it("holds unconfirmed integrations and keeps blocked work to review", () => {
    const inquiry = promptFor({ ...inquiryCase, plan: { ...inquiryCase.plan, integrations: ["외부 AI API 연동"], implementation: [...inquiryCase.plan.implementation, "외부 AI API 호출"] } });
    expect(block(sectionBody(inquiry, "선행 조건·차단 사항"), "확인할 항목")).toContain("- 외부 AI API 연동");
    expect(block(sectionBody(inquiry, "단계별 실제 구현"), "범위 확인이 필요한 생성 계획 제안")).toContain("- 외부 AI API 호출 (확인 필요: 실제 연동 방식과 권한을 확인한 뒤 확인된 방식만 사용하세요)");
    expect(unitSteps(inquiry)).toEqual(["문의 유형 분류", "답변 초안 작성"]);

    const permitModel = buildAgentInstructionModel(permitCase.plan, optionsFor(permitCase));
    const permit = promptFor(permitCase);
    const implementation = sectionBody(permit, "단계별 실제 구현");
    expect(unitSteps(permit)).toEqual([]);
    // The diagnosed exclusion is listed once, not repeated as a generated "future" proposal.
    expect(block(sectionBody(permit, "작업 목표·실행 범위"), "제외·담당자 유지 (자동화로 대체하지 않음)")).toContain("- 허가 자동 승인");
    expect(sectionBody(permit, "작업 목표·실행 범위")).not.toContain("생성 계획 제안: 허가 자동 승인 —");
    expect(implementation).toContain("운영 기능·자동 실행 코드·스캐폴딩을 만들지 마세요.");
    expect(sectionBody(permit, "예외·보안·승인")).not.toContain("### 반복 실행");
    expect(permitModel.scoped.criteria).toEqual([]);
    expect(permitModel.scoped.features).toEqual([]);
    expect(classified(permitModel, "plan.acceptance", "허가 처리 시간 단축")).toMatchObject({ role: "criteria", scope: "confirm" });
    expect(permit).toContain("허가 처리 시간 단축");
    expect(block(sectionBody(permit, "완료 조건"), "판정 기준")).not.toContain("허가 처리 시간 단축");
    expect(implementation).not.toContain("### 실제 동작하는 기본 토대");
  });
});
describe("classified generator boundaries", () => {

  it("keeps old unlinked future-publication language visible without treating it as current work", () => {
    const c = equipmentRuleCase;
    const model = buildAgentInstructionModel(c.plan, optionsFor(c));
    const prompt = promptFor(c);
    const before = structuredClone(c);
    expect(buildAgentInstructionModel(c.plan, optionsFor(c))).toEqual(model);
    expect(promptFor(c, "claude")).toBe(prompt);
    expect(promptFor(c)).toBe(prompt);
    expect(c).toEqual(before);
    expect(model.steps.find(s => s.step === "누락·중복 검증")).toMatchObject({ verdict: "AI 보조", scope: "after-check" });
    expect(model.steps.find(s => s.step === "컬럼 매핑 및 표준화")).toMatchObject({ verdict: "AI 보조", scope: "after-check" });
    expect(model.steps.find(s => s.step === "보고서 초안 작성")).toMatchObject({ verdict: "AI 보조", scope: "after-check" });
    expect(model.steps.find(s => s.step === "일일 보고서 자동 발행")).toMatchObject({ verdict: "자동화", scope: "future" });
    expect(unitSteps(prompt)).toContain("보고서 초안 작성");
    expect(unitSteps(prompt)).toContain("누락·중복 검증");
    expect(unitSteps(prompt)).not.toContain("일일 보고서 자동 발행");
    // An AI policy verdict does not turn an explicitly rule-based processing step into an AI call.
    const validationIndex = model.steps.findIndex(s => s.step === "누락·중복 검증");
    const mappingIndex = model.steps.findIndex(s => s.step === "컬럼 매핑 및 표준화");
    expect(model.methods[validationIndex]).toBe("rule");
    expect(model.methods[mappingIndex]).toBe("assist");
    const implementation = sectionBody(prompt, "단계별 실제 구현");
    const validation = block(implementation, `단계 2. 누락·중복 검증 — ${stepMethodLabel(model, validationIndex)}`);
    const mapping = block(implementation, `단계 1. 컬럼 매핑 및 표준화 — ${stepMethodLabel(model, mappingIndex)}`);
    expect(validation).toContain("확정된 규칙");
    expect(validation).not.toContain("AI 결과는 제안값");
    expect(mapping).toContain("AI 결과는 제안값");
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
    // A "테스트:" item in a feature field is the same test as plan.tests: one test item, raw wording kept.
    const misplaced = classified(model, "plan.implementation", "일일 보고서 자동 발행 결과 파일 재열기");
    expect(misplaced).toMatchObject({ role: "tests", scope: "confirm" });
    expect(misplaced?.sources).toEqual(expect.arrayContaining(["plan.tests", "plan.implementation"]));
    expect(model.classified.filter(item => item.text === "일일 보고서 자동 발행 결과 파일 재열기")).toHaveLength(1);
    expect(model.scoped.features).not.toContainEqual(expect.objectContaining({ text: misplaced?.text }));
    expect(prompt).toContain("일일 보고서 자동 발행 결과 파일 재열기");
    // The reported scenario sentence is a test case, never a feature or a future feature.
    const scenario = "정상 케이스: 표준 형식 파일 3개 → 자동 매핑·검증·보고서 생성.";
    const withScenario = { ...c.plan, implementation: [...c.plan.implementation, scenario] };
    const scenarioModel = buildAgentInstructionModel(withScenario, optionsFor(c));
    expect(classified(scenarioModel, "plan.implementation", scenario)).toMatchObject({ role: "tests" });
    const scenarioPrompt = buildAllInOnePrompt(withScenario, "codex", optionsFor(c));
    expect(block(sectionBody(scenarioPrompt, "작업 목표·실행 범위"), "향후 확장 (이번 작업에서 구현하지 않음)")).not.toContain("정상 케이스");
    expect(sectionBody(scenarioPrompt, "단계별 실제 구현")).not.toContain("정상 케이스");
    expect(block(sectionBody(prompt, "테스트·회귀 검증"), "정상 케이스")).not.toContain("일일 보고서 자동 발행 결과 파일 재열기");
    expect(block(sectionBody(prompt, "완료 조건"), "판정 기준")).not.toContain("일일 보고서 자동 발행 완료");
  });

  it("does not promote unidentified site-file work by matching a fragment of a longer step name", () => {
    const c = equipmentRuleCase;
    const item = "현장 파일 처리 개선";
    const plan = { ...c.plan, implementation: [...c.plan.implementation, item] };
    const model = buildAgentInstructionModel(plan, optionsFor(c));
    const found = classified(model, "plan.implementation", item);
    expect(found).toMatchObject({ text: item, role: "features", scope: "confirm" });
    expect(found?.reason).toBeTruthy();
    expect(model.ambiguous).toContainEqual(found);
    expect(authorized(model, "features")).not.toContain(item);
    const prompt = buildAllInOnePrompt(plan, "codex", optionsFor(c));
    expect(prompt).toContain(item);
    expect(sectionBody(prompt, "단계별 실제 구현")).not.toContain(`세부 제안 (생성 계획): ${item}`);
  });

  it("requires confirmation when one statement explicitly names two differently scoped steps", () => {
    const c = equipmentRuleCase;
    const item = "보고서 초안 작성 후 일일 보고서 자동 발행";
    const plan = { ...c.plan, implementation: [...c.plan.implementation, item] };
    const model = buildAgentInstructionModel(plan, optionsFor(c));
    const found = classified(model, "plan.implementation", item);
    expect(found?.scope).toBe("confirm");
    expect(found?.reason).toBeTruthy();
    expect(model.ambiguous).toContainEqual(found);
    expect(authorized(model, "features")).not.toContain(item);
    expect(buildAllInOnePrompt(plan, "codex", optionsFor(c))).toContain(item);
  });

  it("preserves unique approval and security instructions while deduplicating punctuation variants", () => {
    const c = equipmentCase;
    const plan = { ...c.plan,
      security: [" 1) 실적 파일 외부 전송 전 보안 조건 확인.", "실적 파일 외부 전송 전 보안 조건 확인", "외부 저장 시 파일 암호화"],
      humanInLoop: ["담당자 최종 승인.", "담당자 최종 승인", "승인 이력 별도 보관"],
      prerequisites: ["보고서 템플릿 확인.", "보고서 템플릿 확인", "보고서 템플릿 승인자 확인"],
    };
    const model = buildAgentInstructionModel(plan, optionsFor(c));
    const prompt = buildAllInOnePrompt(plan, "codex", optionsFor(c));
    for (const item of ["외부 저장 시 파일 암호화", "승인 이력 별도 보관", "보고서 템플릿 승인자 확인"]) expect(prompt).toContain(item);
    expect(model.classified.some(item => item.text.includes("외부 저장 시 파일 암호화"))).toBe(true);
  });
});

describe("representative coding-agent instructions", () => {
  const expected = [
    { level: "AI 보조 · Level 1", gate: "확인 후 진행", group: "확인 후 구현", steps: ["AI 컬럼 매핑", "보고서 초안 작성"], human: ["최종 승인"] },
    { level: "부분 자동화 · Level 2", gate: "진행 가능", group: "이번 구현", steps: ["만료 예정 계약 추출", "갱신 안내 초안 작성"], human: ["갱신 여부 판단"] },
    { level: "AI 보조 · Level 1", gate: "확인 후 진행", group: "확인 후 구현", steps: ["문의 유형 분류", "답변 초안 작성"], human: ["답변 발송"] },
    { level: "고도 자동화 · Level 3", gate: "진행 가능", group: "이번 구현", steps: ["요청 접수", "필수 정보 확인", "우선순위 후보 산정"], human: ["업체 선정"] },
    { level: "수동 유지 · Level 0", gate: "진행 보류", group: "검토·검증만", steps: ["허가 신청 접수"], human: ["안전조치 확인", "허가 승인"] },
  ];
  it.each(agentCases.map((c, index) => [c.name, c, expected[index]] as const))("%s follows its own diagnosis", (_name, c, want) => {
    const before = structuredClone(c);
    const options = optionsFor(c);
    const model = buildAgentInstructionModel(c.plan, options);
    const prompt = promptFor(c);
    expect(model.steps).toEqual(executionProfile(c.diagnosis).stepScope);
    expect(model.steps.filter(s => s.scope === "implement" || s.scope === "after-check" || s.scope === "verify").map(s => s.step)).toEqual(want.steps);
    expect(buildAgentInstructionModel(c.plan, options)).toEqual(model);
    expect(buildAllInOnePrompt(c.plan, "codex", options)).toBe(prompt);
    expect(c).toEqual(before);
    expect(sectionsOf(prompt)).toEqual(AREAS);
    const scope = sectionBody(prompt, "작업 목표·실행 범위");
    expect(scope).toContain(`- 자동화 수준: ${want.level}`);
    expect(scope).toContain(`- 실행 상태: ${want.gate}`);
    expect(groupSteps(prompt, want.group)).toEqual(want.steps);
    for (const step of want.human) expect(block(scope, "제외·담당자 유지 (자동화로 대체하지 않음)")).toContain(`- ${step} (담당자 수행)`);
    // Reference output must remain visible, but only a linked authorized output can become deliverable work.
    const flow = sectionBody(prompt, "업무 데이터 흐름");
    for (const input of c.diagnosis.asIs.inputs) expect(block(flow, "입력")).toContain(input);
    for (const output of c.diagnosis.asIs.outputs) {
      expect(classified(model, "diagnosis.asIs.outputs", output)).toBeDefined();
      expect(block(flow, "출력")).toContain(output);
    }
    for (const item of model.scoped.outputs) expect(["implement", "after-check"]).toContain(item.scope);
    for (const exception of c.diagnosis.asIs.exceptions) expect(block(sectionBody(prompt, "예외·보안·승인"), "예외")).toContain(exception);
    for (const other of agentCases.filter(o => o !== c)) for (const step of other.diagnosis.stepAssessments) expect(prompt).not.toContain(step.step);
    expect(promptFor(c, "claude")).toBe(prompt);
  });
});

describe("coding-agent instructions with missing data", () => {
  it("names missing inputs, outputs and step diagnosis instead of inventing work", () => {
    const sparse = { ...equipmentCase, diagnosis: { ...equipmentCase.diagnosis, asIs: { ...equipmentCase.diagnosis.asIs, inputs: [], outputs: [] }, stepAssessments: [] } };
    const model = buildAgentInstructionModel(sparse.plan, optionsFor(sparse));
    expect(model.steps).toEqual([]);
    for (const role of ["features", "tests", "criteria", "outputs", "conditions"] as const) expect(model.scoped[role]).toEqual([]);
    const prompt = promptFor(sparse);
    const conditions = block(sectionBody(prompt, "선행 조건·차단 사항"), "확인할 항목");
    for (const gap of ["입력 자료와 샘플 형식 (진단에 입력 정보 없음)", "결과물 형식과 보고 양식 (진단에 출력 정보 없음)", "업무 단계별 진단 정보 없음: 구현할 단계와 담당자 단계를 먼저 확인"]) expect(conditions).toContain(`- ${gap}`);
    expect(sectionBody(prompt, "작업 목표·실행 범위")).toContain("현재 실행 범위에 구현할 업무 단계가 없습니다.");
    expect(unitSteps(prompt)).toEqual([]);
  });
  it("keeps insufficient information as a conditional prerequisite even with a go verdict", () => {
    const diagnosis: AxDiagnosis = {
      ...equipmentRuleCase.diagnosis,
      informationSufficiency: "needs-check",
      followUpQuestions: ["실제 Excel 샘플과 누락 판정 기대값 확보"],
      decisionGate: { verdict: "go", reasons: [] },
      technicalChecks: [],
    };
    const model = buildAgentInstructionModel(equipmentRuleCase.plan, { diagnosis });
    expect(model.gate).toBe("conditional");
    expect(model.steps.filter(s => s.scope === "after-check").map(s => s.step)).toContain("누락·중복 검증");
    expect(model.steps.some(s => s.scope === "implement")).toBe(false);
    const prompt = buildAllInOnePrompt(equipmentRuleCase.plan, "codex", { diagnosis });
    expect(prompt).toContain("실제 Excel 샘플과 누락 판정 기대값 확보");
    expect(block(sectionBody(prompt, "완료 조건"), "판정 기준")).not.toContain("누락·중복 건수가 수동 검토와 동일하거나 감소");
  });
  it("builds from the diagnosis alone when no tool plan exists", () => {
    const model = buildAgentInstructionModel(undefined, optionsFor(equipmentCase));
    expect(model.steps).toEqual(executionProfile(equipmentCase.diagnosis).stepScope);
    expect(model.classified.some(item => item.source.startsWith("plan."))).toBe(false);
    const prompt = promptFor({ ...equipmentCase, plan: undefined });
    expect(sectionsOf(prompt)).toEqual(AREAS);
    expect(prompt).not.toMatch(/생성 계획 제안|\(생성 계획\)|생성 계획의 목표|범위 확인이 필요한/u);
    expect(unitSteps(prompt)).toEqual(["AI 컬럼 매핑", "보고서 초안 작성"]);
  });
  it("does not permit generated work without a diagnosis", () => {
    const model = buildAgentInstructionModel(planFixture, { taskName: "월간 취합" });
    expect(model.profile).toBeUndefined();
    expect(model.steps).toEqual([]);
    for (const role of ["features", "tests", "criteria", "outputs", "conditions"] as const) expect(model.scoped[role]).toEqual([]);
    const prompt = buildAllInOnePrompt(planFixture, "codex", { taskName: "월간 취합" });
    expect(block(sectionBody(prompt, "선행 조건·차단 사항"), "확인할 항목")).toContain("- 진단 결과 없음: Level·실행 상태를 확인하기 전에는 생성 계획의 제안을 확정 구현하지 마세요.");
    expect(sectionBody(prompt, "작업 목표·실행 범위")).not.toMatch(/### (이번 구현|확인 후 구현)/u);
    expect(block(sectionBody(prompt, "단계별 실제 구현"), "범위 확인이 필요한 생성 계획 제안")).toContain("- 취합");
  });
  it("treats missing optional arrays in older stored records as absent, not invented work", () => {
    const older = structuredClone(equipmentCase.diagnosis) as unknown as Record<string, unknown>;
    delete older.toBe;
    delete older.technicalChecks;
    delete older.risks;
    const diagnosis = older as unknown as AxDiagnosis;
    const model = buildAgentInstructionModel(undefined, { diagnosis });
    expect(model.steps.map(s => s.step)).toEqual(equipmentCase.diagnosis.stepAssessments.map(s => s.step));
    expect(model.classified.some(item => item.source === "diagnosis.technicalChecks")).toBe(false);
    expect(buildAllInOnePrompt(undefined, "codex", { diagnosis })).toContain("보고서 초안 작성");
  });
  it("generates the improved instruction from an exported and re-imported stored diagnosis without changing it", () => {
    const task = { ...taskFixture("stored", { ...equipmentCase.diagnosis, planCodex: equipmentCase.plan }), name: equipmentCase.name, description: equipmentCase.description };
    const state = { schemaVersion: 1 as const, tasks: [task], selectedTaskId: task.id, step: 4 };
    const restored = importAxState(exportAxState(state)).tasks[0];
    expect(restored.diagnosis).toEqual(task.diagnosis);
    expect(restored.diagnosis?.planClaude).toBeUndefined();
    const prompt = promptFor({ name: restored.name, description: restored.description, diagnosis: restored.diagnosis!, plan: restored.diagnosis!.planCodex });
    // Same stored diagnosis → same derived scope; the raw diagnosis echo (which carries planCodex) is not compared.
    const semantic = (m: AgentInstructionModel) => ({ steps: m.steps, methods: m.methods, gate: m.gate, level: m.level, scopeLevel: m.scopeLevel, classified: m.classified, scoped: m.scoped, gaps: m.gaps });
    expect(semantic(buildAgentInstructionModel(restored.diagnosis!.planCodex, {
      taskName: restored.name, context: restored.description, diagnosis: restored.diagnosis!,
      prerequisites: executionProfile(restored.diagnosis!).prerequisites,
    }))).toEqual(semantic(buildAgentInstructionModel(equipmentCase.plan, optionsFor(equipmentCase))));
    expect(prompt).toBe(promptFor(equipmentCase));
    expect(restored.diagnosis).toEqual(task.diagnosis);
  });
});
