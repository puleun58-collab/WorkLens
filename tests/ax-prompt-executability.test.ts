import { describe, expect, it } from "vitest";
import { buildAgentInstructionModel, buildAllInOnePrompt, planSummary } from "../src/lib/ax/guide";
import { automationLevel, executionGate, matrixPosition } from "../src/lib/ax/policy";
import type { AxDiagnosis, AxPlan } from "../src/lib/ax/types";
import { agentCases, freightCase } from "./fixtures/ax-agent-cases";
import { dieselCase } from "./fixtures/diesel-case";
import { diagnosisFixture, planFixture } from "./fixtures/ax";

const promptFor = (plan: AxPlan, diagnosis: AxDiagnosis, extra: Record<string, unknown> = {}) =>
  buildAllInOnePrompt(plan, "codex", { taskName: "테스트 업무", diagnosis, context: "", ...extra });
const section = (prompt: string, title: string) => {
  const parts = prompt.split(/\n## \d+\. /u);
  return parts.find(p => p.startsWith(title)) ?? "";
};
const funcBlock = (prompt: string, step: string) => {
  const m = prompt.match(new RegExp(`### 기능 \\d+\\. ${step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?(?=### 기능 \\d+\\.|## 4\\.)`));
  return m?.[0] ?? "";
};
const ALL_CASES = [...agentCases, freightCase, dieselCase];

/** 작업 18 기준값 (시작 main 5456ef1b에서 기록): 정책·판정은 변경 전과 완전 일치해야 한다. */
const BASELINE: Record<string, { level: number; gate: string; region: string; steps: string }> = {
  "일일 장비 가동 실적 집계": { level: 1, gate: "conditional", region: "strategic", steps: "공유 폴더 파일 수집:after-check|AI 컬럼 매핑:after-check|데이터 표준화:after-check|누락·중복 검증:after-check|가동률 계산:after-check|보고서 초안 작성:after-check|최종 승인:human" },
  "계약 갱신 일정 관리": { level: 2, gate: "ready", region: "quick", steps: "만료 예정 계약 추출:implement|갱신 안내 초안 작성:implement|갱신 여부 판단:human" },
  "고객 문의 분류 및 답변 초안": { level: 1, gate: "conditional", region: "strategic", steps: "문의 유형 분류:after-check|답변 초안 작성:after-check|답변 발송:human" },
  "시설 보수 요청 접수·우선순위 검토": { level: 3, gate: "ready", region: "quick", steps: "요청 접수:implement|필수 정보 확인:implement|우선순위 후보 산정:implement|업체 선정:human" },
  "작업 허가 및 안전조치 승인": { level: 0, gate: "blocked", region: "hold", steps: "허가 신청 접수:verify|안전조치 확인:human|허가 승인:human" },
  "월간 운임 정산": { level: 1, gate: "conditional", region: "strategic", steps: "실적 파일 병합:after-check|누락·중복 검증:after-check|정산표 생성:after-check|정산 승인:human" },
  "주간 경유 가격 취합 및 보고": { level: 1, gate: "conditional", region: "strategic", steps: "경유 가격 확인:human|가격 입력:after-check|전주 대비 증감률 계산:after-check|월평균 계산:after-check|보고서 업데이트:after-check|담당자 최종 검토:human" },
};

describe("작업 18 불변성: Factor·Level·Gate·매트릭스·단계 범위·원본 무변경", () => {
  it.each(ALL_CASES.map(c => [c.name, c]))("%s", (_name, c) => {
    const base = BASELINE[c.name];
    expect(automationLevel(c.diagnosis).level).toBe(base.level);
    expect(executionGate(c.diagnosis)).toBe(base.gate);
    expect(matrixPosition(c.diagnosis).region).toBe(base.region);
    const model = buildAgentInstructionModel(c.plan, { taskName: c.name, diagnosis: c.diagnosis, context: c.description });
    expect(model.steps.map(s => `${s.step}:${s.scope}`).join("|")).toBe(base.steps);
  });
  it("원본 진단·계획 객체를 변경하지 않는다", () => {
    const before = structuredClone(freightCase);
    buildAllInOnePrompt(freightCase.plan, "codex", { taskName: freightCase.name, diagnosis: freightCase.diagnosis, context: freightCase.description });
    planSummary(freightCase.diagnosis, freightCase.plan, freightCase.description);
    expect(freightCase).toEqual(before);
  });
});

describe("작업 18 범위 1: 확인 작업까지 금지하는 전면 문구 제거", () => {
  it("전면 금지 문구가 어떤 지시문에도 남지 않고, 범위 문구로 대체된다", () => {
    for (const c of ALL_CASES) {
      const prompt = buildAllInOnePrompt(c.plan, "codex", { taskName: c.name, diagnosis: c.diagnosis, context: c.description });
      expect(prompt).not.toContain("방식이 확정되기 전에는 구현을 시작하지 마세요");
    }
    // confirm 방식 단계가 있는 사례(일일 장비)에서는 보류 규칙 자체는 유지된다.
    const daily = agentCases.find(c => c.name === "일일 장비 가동 실적 집계")!;
    const prompt = buildAllInOnePrompt(daily.plan, "codex", { taskName: daily.name, diagnosis: daily.diagnosis, context: daily.description });
    expect(prompt).toContain("해당 기능의 실제 구현은 처리 방식과 선행조건이 확인될 때까지 보류합니다");
    expect(prompt).toContain("저장소 조사·실제 자료 확인·조건 검증은 수행하세요");
    expect(prompt).toContain("독립성과 필수 조건이 확인된 작업은 허용 범위에서 구현하고 실제 데이터로 검증하세요");
  });
  it("§5에 A/B/C 구분이 명시되고 10단계 순서·개수는 유지된다", () => {
    const prompt = promptFor(freightCase.plan, freightCase.diagnosis);
    const s5 = section(prompt, "구현 순서 및 검증");
    expect(s5).toContain("A. 구현 전 확인 작업");
    expect(s5).toContain("B. 조건 충족 후 구현 작업");
    expect(s5).toContain("C. 구현 보류 작업");
    expect(s5).toContain("확인 작업 허용은 구현 권한 부여가 아닙니다");
    expect(s5).toContain("임의 값을 만들어 구현 완료로 처리하지 말고 부족 사항을 구체적으로 보고하세요");
    expect(s5).toContain("정책상 구현이 금지된 작업은 자료가 충분해도 그대로 보류합니다");
    expect(s5.split("\n").filter(l => /^\d+\. /.test(l))).toHaveLength(10);
  });
});

describe("작업 18 범위 2: 단계별 착수 증거 전달", () => {
  it("모든 확인 후 구현 단계의 기능 블록에 착수 조건 줄이 있다", () => {
    for (const c of ALL_CASES) {
      const prompt = buildAllInOnePrompt(c.plan, "codex", { taskName: c.name, diagnosis: c.diagnosis, context: c.description });
      const model = buildAgentInstructionModel(c.plan, { taskName: c.name, diagnosis: c.diagnosis, context: c.description });
      for (const s of model.steps.filter(s => s.scope === "after-check")) {
        expect(funcBlock(prompt, s.step)).toContain("착수 조건:");
      }
    }
  });
  it("연결된 조건이 없는 단계는 그 사실을 명시하고, 연결된 조건은 미충족 시 처리와 함께 표시된다", () => {
    const daily = agentCases.find(c => c.name === "일일 장비 가동 실적 집계")!;
    const dailyPrompt = buildAllInOnePrompt(daily.plan, "codex", { taskName: daily.name, diagnosis: daily.diagnosis, context: daily.description });
    // 일일 장비 사례의 미확인 조건은 어떤 단계에도 명시적으로 연결되지 않는다 (재현된 결함).
    expect(funcBlock(dailyPrompt, "공유 폴더 파일 수집")).toContain("이 단계에 직접 연결된 필수 조건 없음");
    // 명시적 단계 연결("단계명 — 조건")이 있는 합성 사례: 착수 조건 + 미충족 시 처리.
    const linked: AxPlan = { ...freightCase.plan, prerequisites: ["실적 파일 병합 — Excel 샘플 확보"] };
    const linkedPrompt = buildAllInOnePrompt(linked, "codex", { taskName: freightCase.name, diagnosis: freightCase.diagnosis, context: freightCase.description });
    const block = funcBlock(linkedPrompt, "실적 파일 병합");
    expect(block).toContain("착수 조건:");
    expect(block).toContain("Excel 샘플 확보");
    expect(block).toContain("미충족 시:");
    expect(block).toContain("해당 부분만 보류하고 보류 사유·확인 대상·재개 조건을 보고하세요");
  });
  it("관련 후보는 단계 블록에서 필수 조건이 아님을 명시한다", () => {
    // 단계명을 언급하지만 명시적 연결 구분자(" — "/" : ")가 없는 조건은 관련 후보로 남는다.
    const plan: AxPlan = { ...freightCase.plan, prerequisites: ["실적 파일 병합 파일 형식 확인"] };
    const prompt = buildAllInOnePrompt(plan, "codex", { taskName: freightCase.name, diagnosis: freightCase.diagnosis, context: freightCase.description });
    const block = funcBlock(prompt, "실적 파일 병합");
    expect(block).toContain("관련 후보 (필수 조건 아님)");
    expect(block).toContain("실적 파일 병합 파일 형식 확인");
  });
  it("입력 자료가 전혀 없으면 공통 입력을 사용하는 것처럼 쓰지 않고 미확정으로 표시한다", () => {
    const diagnosis: AxDiagnosis = {
      ...diagnosisFixture,
      asIs: { ...diagnosisFixture.asIs, inputs: [] },
      poc: { ...diagnosisFixture.poc, inputs: [] },
    };
    const prompt = promptFor(planFixture, diagnosis);
    expect(funcBlock(prompt, "자료 수집")).toContain("입력 자료 미확정");
  });
});

describe("작업 18 범위 5·공통 회귀: 8개 유형 + 경계 사례", () => {
  const synthetic = (name: string, steps: AxDiagnosis["stepAssessments"]): { name: string; diagnosis: AxDiagnosis; plan: AxPlan } => ({
    name,
    diagnosis: { ...freightCase.diagnosis, stepAssessments: steps },
    plan: { ...freightCase.plan, implementation: steps.filter(s => s.verdict !== "사람 유지").map(s => s.step) },
  });
  const cases = [
    ...ALL_CASES.map(c => ({ name: c.name, diagnosis: c.diagnosis, plan: c.plan })),
    // 외부 API 연동 (합성): 연동 조건이 필수 의존으로 자동 승격되지 않는다.
    synthetic("외부 API 연동(합성)", [
      { step: "외부 가격 조회", verdict: "AI 보조", owner: "AI", note: "외부 가격 API 제공 여부를 확인해야 함" },
      { step: "결과 정리", verdict: "AI 보조", owner: "AI", note: "조회 결과를 정리" },
    ]),
    // 이메일·알림 (합성): 발송은 담당자 유지로 남는다.
    synthetic("이메일·알림(합성)", [
      { step: "알림 대상 추출", verdict: "자동화", owner: "시스템", note: "대상 목록 추출" },
      { step: "이메일 초안 작성", verdict: "AI 보조", owner: "AI", note: "초안만 작성" },
      { step: "발송", verdict: "사람 유지", owner: "사용자", note: "담당자 발송" },
    ]),
    // 다단계·분기 (합성): 분기 단계와 예외 담당자 확인이 분리된다.
    synthetic("다단계·분기(합성)", [
      { step: "조건 분기 판단", verdict: "자동화", owner: "시스템", note: "분기 조건 확인" },
      { step: "분기별 처리", verdict: "자동화", owner: "시스템", note: "분기별 처리" },
      { step: "예외 건 담당자 확인", verdict: "사람 유지", owner: "사용자", note: "예외 확인" },
    ]),
  ];
  it.each(cases.map(c => [c.name, c]))("%s: §1~§6 존재, 담당자 단계는 기능 블록에 없음", (_name, c) => {
    const prompt = buildAllInOnePrompt(c.plan, "codex", { taskName: c.name, diagnosis: c.diagnosis, context: "" });
    for (const title of ["구현 목표", "구현 범위", "기능별 요구사항", "예외 및 유지 조건", "구현 순서 및 검증", "결과 보고"]) {
      expect(section(prompt, title).length).toBeGreaterThan(0);
    }
    const model = buildAgentInstructionModel(c.plan, { taskName: c.name, diagnosis: c.diagnosis, context: "" });
    for (const s of model.steps.filter(s => s.scope === "human")) {
      expect(funcBlock(prompt, s.step)).toBe("");
    }
  });
  it("Level 0·Gate blocked·HITL 혼합 등 기존 경계는 지시문 범위를 넓히지 않는다", () => {
    const permit = agentCases.find(c => c.name === "작업 허가 및 안전조치 승인")!;
    const prompt = buildAllInOnePrompt(permit.plan, "codex", { taskName: permit.name, diagnosis: permit.diagnosis, context: permit.description });
    expect(section(prompt, "기능별 요구사항")).not.toMatch(/### 기능 \d+\. /);
    expect(prompt).toContain("진행 보류");
    expect(prompt).not.toContain("방식이 확정되기 전에는 구현을 시작하지 마세요");
  });
});
