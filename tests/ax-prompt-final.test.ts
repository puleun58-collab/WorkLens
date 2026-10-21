import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt, buildAgentInstructionModel, stepIoSpec } from "../src/lib/ax/guide";
import { dieselCase } from "./fixtures/diesel-case";
import { pdfCase, reportCase } from "./fixtures/quality-cases";
import { contractCase, permitCase } from "./fixtures/ax-agent-cases";
import type { AxDiagnosis, AxPlan } from "../src/lib/ax/types";
import { FACTOR_KEYS, REPOSITORY_FIRST } from "../src/lib/ax/schema";

/**
 * 올인원 지시문 최종 실행형 고도화 회귀:
 * - 처리 근거가 있는 단계가 '처리 방식 미확정'으로 일괄 표시되지 않는다
 * - 근거 없는 단계는 여전히 미확정으로 남는다 (임의 확정 금지)
 * - '입력 후보'는 데이터 입력 행위가 아니라 후보 제안(AI 보조)으로 판정한다
 * - 종단 단계의 입력은 선행 단계 산출물과 연결된다
 * - 검증 문구가 기능별 요구사항과 단계별 완료 기준에 전문 중복되지 않는다
 */
const promptFor = (c: { plan: AxPlan; name: string; diagnosis: AxDiagnosis }) =>
  buildAllInOnePrompt(c.plan, "codex", { taskName: c.name, diagnosis: c.diagnosis, context: "" });
const modelFor = (c: { plan: AxPlan; name: string; diagnosis: AxDiagnosis }) =>
  buildAgentInstructionModel(c.plan, { taskName: c.name, diagnosis: c.diagnosis, context: "" });

describe("처리 방식 판정 정확성", () => {
  it("diesel: 근거 있는 단계는 근거 기반 방식으로, 담당자 단계는 담당자로 판정", () => {
    const model = modelFor(dieselCase);
    expect(model.methods).toEqual(["manual", "script", "rule", "rule", "assist", "manual"]);
    const prompt = promptFor(dieselCase);
    expect(prompt).not.toContain("처리 방식 미확정");
    expect(prompt).not.toContain("처리 방식 근거 충돌");
  });

  it("report: 템플릿 입력은 스크립트 처리, 확정 계산식은 규칙 기반 처리로 판정", () => {
    const model = modelFor(reportCase);
    expect(model.methods).toEqual(["script", "rule", "script", "manual"]);
  });

  it("contract: 정해진 기간 조건의 추출은 규칙 기반으로 판정", () => {
    const model = modelFor(contractCase);
    expect(model.methods[0]).toBe("rule");
  });

  it("permit: 처리 근거가 없는 접수 단계는 미확정으로 남는다 (임의 확정 금지)", () => {
    const model = modelFor(permitCase);
    expect(model.methods[0]).toBe("confirm");
    const prompt = promptFor(permitCase);
    expect(prompt).toContain("처리 방식 미확정");
  });

  it("pdf: 검토 항목 목록 생성은 근거가 없어 미확정으로 남는다", () => {
    const model = modelFor(pdfCase);
    expect(model.methods).toEqual(["script", "assist", "confirm", "manual"]);
  });
});

describe("생성 전 정합성 — 단계 상태와 기능 요구사항 일치", () => {
  it("diesel: 모든 기능의 검증이 해당 단계의 처리 방식과 모순되지 않는다", () => {
    const prompt = promptFor(dieselCase);
    // 확정된 방식의 단계가 있는 지시문에 미확정 전용 문구가 섞이지 않는다
    expect(prompt).not.toContain("방식이 확정되기 전에는 구현을 시작하지 마세요");
    expect(prompt).not.toContain("처리 방식이 확정되지 않았습니다");
  });

  it("diesel: 방식별 검증 기준은 공통 블록에 한 번만 정의되고 기능·완료 기준은 이를 참조한다", () => {
    const prompt = promptFor(dieselCase);
    const ruleVerify = "확인된 형식·키·업무 규칙으로 실제 입력이 처리되고";
    // 12점 고도화: 동일한 방식별 검증 문구를 기능마다 반복하지 않고 '방식별 검증 기준'
    // 블록에 한 번만 정의한다. 기능별 검증 줄과 단계별 완료 기준은 이 블록을 참조한다.
    expect(prompt.split(ruleVerify).length - 1).toBe(1);
    const verifyBlock = prompt.match(/### 방식별 검증 기준[\s\S]*?(?=### 기능|\n### |$)/)?.[0] ?? "";
    expect(verifyBlock).toContain(ruleVerify);
    expect(verifyBlock).toContain("가격 입력");
    const func2 = prompt.match(/### 기능 2\. 전주 대비 증감률 계산[\s\S]*?(?=### 기능 3)/)?.[0] ?? "";
    expect(func2).toContain("검증 기준 적용");
    const doneSection = prompt.match(/### 단계별 완료 기준[\s\S]*?(?=### |$)/)?.[0] ?? "";
    expect(doneSection).toContain("가격 입력");
    expect(doneSection).not.toContain(ruleVerify);
  });

  it("diesel: 단계명 머리말 재진술만으로는 단계를 연결하지 않는다 (유사성 연결 금지)", () => {
    const prompt = promptFor(dieselCase);
    // "보고서 업데이트 후보 제안"은 명시적 연결 근거가 없어 확인 항목으로 남는다 —
    // 단계명 접두 일치만으로 승격하면 미연결 미래 산출물까지 현재 요구사항이 되는 회귀가 생긴다
    expect(prompt).toContain("적용 단계 확인 필요 제안");
    expect(prompt).toContain("보고서 업데이트 후보 제안");
  });

  it("diesel: 예외 목록이 구현 순서에 다시 나열되지 않는다", () => {
    const prompt = promptFor(dieselCase);
    const orderSection = prompt.match(/## 5\. 구현 순서 및 검증[\s\S]*?(?=### 정상 케이스)/)?.[0] ?? "";
    expect(orderSection).toContain("예외 및 유지 조건");
    expect(orderSection).not.toContain("가격 미공시일 분리; 누락 데이터 구분");
  });
});

describe("기능별 입력·출력 연결", () => {
  it("diesel: 마지막 구현 단계(보고서 업데이트)의 입력은 선행 단계 산출물과 연결된다", () => {
    const model = modelFor(dieselCase);
    const idx = model.steps.findIndex(s => s.step === "보고서 업데이트");
    const spec = stepIoSpec(model, idx);
    expect(spec.inputs.some(t => t.includes("전주 대비 증감률") && t.includes("선행 단계 산출물"))).toBe(true);
    expect(spec.inputs.some(t => t.includes("월평균 가격") && t.includes("선행 단계 산출물"))).toBe(true);
    // 최종 산출물은 이 단계의 직접 산출물, PoC 결과는 전체 산출물 참조로 남는다
    expect(spec.outputs.some(o => o.includes("주간 경유 가격 보고서"))).toBe(true);
    expect(spec.overallOutputs.some(o => o.includes("주간 경유 가격 결과"))).toBe(true);
  });

  it("diesel: 중간 단계의 입력은 공통 입력을 유지하고 선행 산출물을 임의로 붙이지 않는다", () => {
    const model = modelFor(dieselCase);
    const idx = model.steps.findIndex(s => s.step === "월평균 계산");
    const spec = stepIoSpec(model, idx);
    expect(spec.inputs.every(t => !t.includes("선행 단계 산출물"))).toBe(true);
  });

  it("diesel: 프롬프트 기능 4의 입력 줄에 선행 단계 산출물이 표시된다", () => {
    const prompt = promptFor(dieselCase);
    const func4 = prompt.match(/### 기능 4\. 보고서 업데이트[\s\S]*?(?=### 기능 5|## 4\.)/)?.[0] ?? "";
    expect(func4).toContain("전주 대비 증감률 (선행 단계 산출물)");
    expect(func4).not.toContain("공통 입력 사용");
  });
});

describe("TO-BE 근거 연결 — 포함 관계가 유일할 때만", () => {
  const baseDiagnosis = (patch: Partial<AxDiagnosis>): AxDiagnosis => ({
    informationSufficiency: "sufficient", followUpQuestions: [],
    asIs: { purpose: "테스트", trigger: "요청 시", inputs: ["입력"], steps: [], outputs: ["결과"], exceptions: [], humanDecisions: [], systems: [] },
    factors: FACTOR_KEYS.map(key => ({ key, aiValue: 3, rationale: "근거" })),
    stepAssessments: [], toBe: [], humanInLoop: [], technicalChecks: [], risks: [],
    poc: { hypothesis: "", inScope: [], outOfScope: [], inputs: [], outputs: [], evaluation: [], success: [], failure: [] },
    decisionGate: { verdict: "conditional", reasons: ["확인 후 진행"] },
    roadmap: [],
    operation: { owner: "", failureOwner: "", maintenanceBurden: "low", fallback: "", notes: [] },
    nextAction: { label: "", detail: "" }, sourceNote: "test",
    ...patch,
  } as AxDiagnosis);
  const emptyPlan = (): AxPlan => ({
    repositoryFirst: REPOSITORY_FIRST, goal: [], asIs: [], toBe: [], inScope: [], outOfScope: [], prerequisites: [],
    humanInLoop: [], poc: [], implementation: [], dataFlow: [], integrations: [], exceptions: [], fallback: [],
    security: [], operation: [], tests: [], acceptance: [],
  });

  it("단계명이 TO-BE 단계명을 포함하고 관계가 유일하면 TO-BE 근거가 연결된다", () => {
    const diagnosis = baseDiagnosis({
      stepAssessments: [
        { step: "전주 대비 증감률 계산", verdict: "자동화", owner: "시스템", note: "" },
        { step: "보고서 작성", verdict: "자동화", owner: "시스템", note: "" },
      ],
      toBe: [{ step: "증감률 계산", owner: "시스템", description: "전주 가격과 현재 가격으로 증감률 계산" }],
    });
    const model = buildAgentInstructionModel(emptyPlan(), { taskName: "테스트", diagnosis, context: "" });
    expect(model.methods[0]).toBe("rule");
  });

  it("파일 쓰기·로드 같은 구체적 파일 입출력 근거는 스크립트 처리로 판정한다", () => {
    const diagnosis = baseDiagnosis({
      stepAssessments: [
        { step: "자료 등록", verdict: "자동화", owner: "시스템", note: "입력 검증 후 파일 쓰기로 저장" },
        { step: "자료 조회", verdict: "자동화", owner: "시스템", note: "파일 로드 후 화면 표시" },
      ],
    });
    const model = buildAgentInstructionModel(emptyPlan(), { taskName: "테스트", diagnosis, context: "" });
    expect(model.methods).toEqual(["script", "script"]);
  });

  it("포함 관계가 여러 단계에 걸치면 연결하지 않는다 (유사성만으로 동일 취급 금지)", () => {
    const diagnosis = baseDiagnosis({
      stepAssessments: [
        { step: "전주 대비 증감률 계산", verdict: "자동화", owner: "시스템", note: "" },
        { step: "전월 대비 증감률 계산", verdict: "자동화", owner: "시스템", note: "" },
      ],
      toBe: [{ step: "증감률 계산", owner: "시스템", description: "전주 가격과 현재 가격으로 증감률 계산" }],
    });
    const model = buildAgentInstructionModel(emptyPlan(), { taskName: "테스트", diagnosis, context: "" });
    expect(model.methods[0]).toBe("confirm");
    expect(model.methods[1]).toBe("confirm");
  });
});
