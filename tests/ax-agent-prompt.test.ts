import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt } from "../src/lib/ax/guide";
import { executionProfile } from "../src/lib/ax/policy";
import { exportAxState, importAxState } from "../src/lib/ax/transfer";
import type { AxDiagnosis, AxPlan } from "../src/lib/ax/types";
import { diagnosisFixture, planFixture, taskFixture } from "./fixtures/ax";
import { agentCases, equipmentCase, inquiryCase, permitCase, type AxAgentCase } from "./fixtures/ax-agent-cases";

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

describe("coding-agent instruction scope", () => {
  const levels = [[0, [3, 2, 2, 2, 5, 4]], [1, [4, 4, 3, 2, 4, 3]], [2, [4, 4, 4, 3, 3, 3]], [3, [5, 5, 5, 5, 1, 1]]] as const;
  it.each(levels.flatMap(([level, factors]) => (["go", "conditional", "no-go"] as const).map(verdict => [level, verdict, factors] as const)))(
    "Level %s · %s: every section uses the same Level × Gate step scope", (level, verdict, factors) => {
      const diagnosis = withFactors([...factors], { decisionGate: { verdict, reasons: verdict === "go" ? [] : ["권한 확인"] }, technicalChecks: [] });
      const before = structuredClone(diagnosis);
      const prompt = buildAllInOnePrompt(planFixture, "codex", { taskName: "월간 취합", diagnosis });
      const profile = executionProfile(diagnosis);
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
        expect(block(sectionBody(prompt, "작업 목표·실행 범위"), "향후 확장 (이번 작업에서 구현하지 않음)")).toContain("생성 계획 제안: 취합 — ");
      } else {
        expect(work).toEqual(level === 1 ? ["형식 검증"] : ["자료 수집", "형식 검증"]);
        expect(unitSteps(prompt)).toEqual(work);
        expect(completionSteps(prompt)).toEqual(work);
        if (level === 1) expect(block(sectionBody(prompt, "작업 목표·실행 범위"), "향후 확장 (이번 작업에서 구현하지 않음)")).toContain("자료 수집 — 자동화 단계지만 현재 Level 1 범위 밖");
        // The instruction and Step 4 read one rule: each implemented treatment is a PoC scope item.
        for (const step of profile.stepScope.filter(s => s.scope === "implement" || s.scope === "after-check")) expect(profile.poc.inScope).toContain(`${step.step} ${step.treatment}`);
        expect(block(sectionBody(prompt, "단계별 실제 구현"), "범위 확인이 필요한 생성 계획 제안")).toContain("- 취합");
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
    const prompt = promptFor({ ...equipmentCase, plan: { ...equipmentCase.plan, implementation: [...equipmentCase.plan.implementation, "최종 승인 대리 확정"] } });
    const scope = sectionBody(prompt, "작업 목표·실행 범위"), implementation = sectionBody(prompt, "단계별 실제 구현"), completion = sectionBody(prompt, "완료 조건");
    expect(groupSteps(prompt, "확인 후 구현")).toEqual(["AI 컬럼 매핑", "보고서 초안 작성"]);
    for (const step of ["공유 폴더 파일 수집", "데이터 표준화", "누락·중복 검증", "가동률 계산"]) {
      expect(block(scope, "향후 확장 (이번 작업에서 구현하지 않음)")).toContain(`- ${step} — 자동화 단계지만 현재 Level 1 범위 밖`);
      expect(unitSteps(prompt)).not.toContain(step);
    }
    for (const proposal of ["공유 폴더 자동 수집", "가동률 자동 계산"]) {
      expect(block(scope, "향후 확장 (이번 작업에서 구현하지 않음)")).toContain(`- 생성 계획 제안: ${proposal} — Level 1은 자동 실행 대신 후보·초안까지만 허용`);
      expect(implementation).not.toContain(proposal);
      expect(completion).not.toContain(proposal);
    }
    // A plan restating the human step is not shown as a separate exclusion; a new automation of it is excluded.
    expect(prompt).not.toContain("최종 승인 자동화");
    expect(block(scope, "제외·담당자 유지 (자동화로 대체하지 않음)")).toContain("- 생성 계획 제안: 최종 승인 대리 확정 — 담당자 수행 단계");
    expect(implementation).not.toContain("최종 승인 대리 확정");
    // Linked detail stays with its permitted step; vague targets cannot pass or fail.
    expect(implementation).toContain("- 세부 제안 (생성 계획): AI 컬럼 매핑 후보 제안");
    expect(completion).toContain("- 누락·중복 건수가 수동 검토와 동일하거나 감소 (확인 필요: 기대 결과를 정의한 뒤 판정)");
    // An open check is listed once in section 3 even when the plan restates it.
    const conditions = block(sectionBody(prompt, "선행 조건·차단 사항"), "확인할 항목");
    expect(conditions.match(/공유 폴더 접근 권한/gu)).toHaveLength(1);
    expect(conditions.match(/보고서 템플릿/gu)).toHaveLength(2);
    expect(conditions).toContain("- 공유 폴더 연동 (확인 필요)");
    expect(prompt.match(/공유 폴더 연동/gu)).toHaveLength(1);
    expect(equipmentCase).toEqual(before);
  });

  it("holds unconfirmed integrations and keeps blocked work to review", () => {
    const inquiry = promptFor({ ...inquiryCase, plan: { ...inquiryCase.plan, integrations: ["외부 AI API 연동"], implementation: [...inquiryCase.plan.implementation, "외부 AI API 호출"] } });
    expect(block(sectionBody(inquiry, "선행 조건·차단 사항"), "확인할 항목")).toContain("- 외부 AI API 연동");
    expect(block(sectionBody(inquiry, "단계별 실제 구현"), "범위 확인이 필요한 생성 계획 제안")).toContain("- 외부 AI API 호출 (확인 필요: 실제 연동 방식과 권한을 확인한 뒤 확인된 방식만 사용하세요)");
    expect(unitSteps(inquiry)).toEqual(["문의 유형 분류", "답변 초안 작성"]);

    const permit = promptFor(permitCase);
    const implementation = sectionBody(permit, "단계별 실제 구현");
    expect(unitSteps(permit)).toEqual([]);
    // The diagnosed exclusion is listed once, not repeated as a generated "future" proposal.
    expect(block(sectionBody(permit, "작업 목표·실행 범위"), "제외·담당자 유지 (자동화로 대체하지 않음)")).toContain("- 허가 자동 승인");
    expect(sectionBody(permit, "작업 목표·실행 범위")).not.toContain("생성 계획 제안: 허가 자동 승인 —");
    expect(implementation).toContain("운영 기능·자동 실행 코드·스캐폴딩을 만들지 마세요.");
    expect(sectionBody(permit, "예외·보안·승인")).not.toContain("### 반복 실행");
    for (const item of ["허가 자동 승인", "허가 처리 시간 단축", "신청서 접수"]) expect(sectionBody(permit, "완료 조건")).not.toContain(item);
    expect(implementation).not.toContain("### 실제 동작하는 기본 토대");
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
    const prompt = promptFor(c);
    expect(sectionsOf(prompt)).toEqual(AREAS);
    const scope = sectionBody(prompt, "작업 목표·실행 범위");
    expect(scope).toContain(`- 자동화 수준: ${want.level}`);
    expect(scope).toContain(`- 실행 상태: ${want.gate}`);
    expect(groupSteps(prompt, want.group)).toEqual(want.steps);
    for (const step of want.human) expect(block(scope, "제외·담당자 유지 (자동화로 대체하지 않음)")).toContain(`- ${step} (담당자 수행)`);
    // Inputs, outputs and exceptions come from this task only; no other task's steps or systems leak in.
    const flow = sectionBody(prompt, "업무 데이터 흐름");
    for (const input of c.diagnosis.asIs.inputs) expect(block(flow, "입력")).toContain(`- ${input}`);
    for (const output of c.diagnosis.asIs.outputs) expect(block(flow, "출력")).toContain(`- ${output}`);
    for (const exception of c.diagnosis.asIs.exceptions) expect(block(sectionBody(prompt, "예외·보안·승인"), "예외")).toContain(`- ${exception}`);
    for (const other of agentCases.filter(o => o !== c)) for (const step of other.diagnosis.stepAssessments) expect(prompt).not.toContain(step.step);
    expect(promptFor(c, "claude")).toBe(prompt);
  });
});

describe("coding-agent instructions with missing data", () => {
  it("names missing inputs, outputs and step diagnosis instead of inventing work", () => {
    const sparse = { ...equipmentCase, diagnosis: { ...equipmentCase.diagnosis, asIs: { ...equipmentCase.diagnosis.asIs, inputs: [], outputs: [] }, stepAssessments: [] } };
    const prompt = promptFor(sparse);
    const conditions = block(sectionBody(prompt, "선행 조건·차단 사항"), "확인할 항목");
    for (const gap of ["입력 자료와 샘플 형식 (진단에 입력 정보 없음)", "결과물 형식과 보고 양식 (진단에 출력 정보 없음)", "업무 단계별 진단 정보 없음: 구현할 단계와 담당자 단계를 먼저 확인"]) expect(conditions).toContain(`- ${gap}`);
    expect(sectionBody(prompt, "작업 목표·실행 범위")).toContain("현재 실행 범위에 구현할 업무 단계가 없습니다.");
    expect(unitSteps(prompt)).toEqual([]);
  });
  it("builds from the diagnosis alone when no tool plan exists", () => {
    const prompt = promptFor({ ...equipmentCase, plan: undefined });
    expect(sectionsOf(prompt)).toEqual(AREAS);
    expect(prompt).not.toMatch(/생성 계획 제안|\(생성 계획\)|생성 계획의 목표|범위 확인이 필요한/u);
    expect(unitSteps(prompt)).toEqual(["AI 컬럼 매핑", "보고서 초안 작성"]);
  });
  it("does not permit generated work without a diagnosis", () => {
    const prompt = buildAllInOnePrompt(planFixture, "codex", { taskName: "월간 취합" });
    expect(block(sectionBody(prompt, "선행 조건·차단 사항"), "확인할 항목")).toContain("- 진단 결과 없음: Level·실행 상태를 확인하기 전에는 생성 계획의 제안을 확정 구현하지 마세요.");
    expect(sectionBody(prompt, "작업 목표·실행 범위")).not.toMatch(/### (이번 구현|확인 후 구현)/u);
    expect(block(sectionBody(prompt, "단계별 실제 구현"), "범위 확인이 필요한 생성 계획 제안")).toContain("- 취합");
  });
  it("generates the improved instruction from an exported and re-imported stored diagnosis without changing it", () => {
    const task = { ...taskFixture("stored", { ...equipmentCase.diagnosis, planCodex: equipmentCase.plan }), name: equipmentCase.name, description: equipmentCase.description };
    const state = { schemaVersion: 1 as const, tasks: [task], selectedTaskId: task.id, step: 4 };
    const restored = importAxState(exportAxState(state)).tasks[0];
    expect(restored.diagnosis).toEqual(task.diagnosis);
    expect(restored.diagnosis?.planClaude).toBeUndefined();
    const prompt = promptFor({ name: restored.name, description: restored.description, diagnosis: restored.diagnosis!, plan: restored.diagnosis!.planCodex });
    expect(prompt).toBe(promptFor(equipmentCase));
    expect(restored.diagnosis).toEqual(task.diagnosis);
  });
});
