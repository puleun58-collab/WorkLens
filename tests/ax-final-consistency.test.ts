import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt, buildAgentInstructionModel, stepIoSpec } from "../src/lib/ax/guide";
import type { AxDiagnosis, AxPlan } from "../src/lib/ax/types";
import { FACTOR_KEYS, REPOSITORY_FIRST } from "../src/lib/ax/schema";

/**
 * 올인원 지시문 최종 정합성 보완 회귀:
 * 1) 예외 조건 포함관계 중복 제거는 의미 보존이 우선한다 — 부정·금지·허용·필수 등
 *    의미를 바꾸는 말이 덧붙은 포함 관계에서는 짧은 항목을 삭제하지 않는다.
 *    (사실 + 처리·상태 부연인 포함 관계와 정규화 후 완전 동일 항목만 중복 제거)
 * 2) 최종 산출물은 현재 구현 범위의 확정 산출물(허용 단계 연결 출력)이 우선하고,
 *    AS-IS 산출물은 확정 산출물이 없을 때만 전체 산출물이 되며 그 외에는 참고로 남는다.
 * 3) 단계에 연결된 기능별 고유 검증 기준은 공통 방식 기준과 구분되어 단계 표기와
 *    함께 보존되고, 실패 기준은 성공 기준과 섞이지 않는다.
 */
type Step = AxDiagnosis["stepAssessments"][number];
const step = (name: string, verdict: Step["verdict"], owner: Step["owner"], note: string): Step => ({ step: name, verdict, owner, note });
const factors = (values: [number, number, number, number, number, number]) => FACTOR_KEYS.map((key, index) => ({ key, aiValue: values[index], rationale: "등록된 업무 설명 근거" }));
const newPlan = (patch: Partial<AxPlan>): AxPlan => ({
  repositoryFirst: REPOSITORY_FIRST, goal: [], asIs: [], toBe: [], inScope: [], outOfScope: [], prerequisites: [], humanInLoop: [], poc: [],
  implementation: [], dataFlow: [], integrations: [], exceptions: [], fallback: [], security: [], operation: [], tests: [], acceptance: [], ...patch,
});
const baseDiagnosis = (patch: Partial<AxDiagnosis>): AxDiagnosis => ({
  informationSufficiency: "partial", followUpQuestions: [],
  asIs: { purpose: "업무 목적", trigger: "담당자 요청 시", inputs: ["입력 자료"], steps: [], outputs: [], exceptions: [], humanDecisions: [], systems: [] },
  factors: factors([4, 4, 3, 2, 4, 3]),
  stepAssessments: [], toBe: [], humanInLoop: [], technicalChecks: [], risks: [],
  poc: { hypothesis: "", inScope: [], outOfScope: [], inputs: [], outputs: [], evaluation: [], success: [], failure: [] },
  decisionGate: { verdict: "conditional", reasons: ["확인 후 진행"] },
  roadmap: [],
  operation: { owner: "업무 담당", failureOwner: "운영 담당", maintenanceBurden: "medium", fallback: "", notes: [] },
  nextAction: { label: "확인", detail: "" }, sourceNote: "회귀 픽스처",
  ...patch,
} as AxDiagnosis);
const exceptionsSection = (prompt: string) => prompt.match(/### 예외\n\n([\s\S]*?)(?=\n\n실패·미매칭)/)?.[1] ?? "";

describe("1순위 — 예외 조건 중복 제거의 의미 보존", () => {
  const diagnosis = baseDiagnosis({
    asIs: {
      purpose: "자료 취합", trigger: "요청 시", inputs: ["원본 자료"], steps: ["자료 취합", "결과 정리"],
      outputs: ["결과표"], exceptions: ["데이터 누락", "데이터 누락 없음", "담당자 승인 필요", "담당자 승인 필요 없음", "가격 미공시일"],
      humanDecisions: [], systems: [],
    },
    stepAssessments: [step("자료 취합", "자동화", "시스템", "자료를 시스템에 입력"), step("결과 정리", "자동화", "시스템", "결과표 작성")],
  });
  const plan = newPlan({
    inScope: ["자료 취합", "결과 정리"], implementation: ["자료 취합", "결과 정리"],
    exceptions: ["가격 미공시일 분리", "저장 실패", "저장 실패 시 재시도", "자동 삭제 금지", "중복 등록 불허", "중복 등록"],
  });
  const section = exceptionsSection(buildAllInOnePrompt(plan, "codex", { taskName: "예외 정합성", diagnosis, context: "" }));

  it("부정형이 덧붙은 포함 관계에서는 긍정 조건이 삭제되지 않는다", () => {
    expect(section).toContain("- 데이터 누락\n");
    expect(section).toContain("- 데이터 누락 없음");
    expect(section).toContain("- 담당자 승인 필요\n");
    expect(section).toContain("- 담당자 승인 필요 없음");
  });

  it("금지·불허가 덧붙은 포함 관계에서는 짧은 항목이 삭제되지 않는다", () => {
    // '중복 등록' ⊂ '중복 등록 불허' — 불허가 의미를 바꾸므로 양쪽 유지
    expect(section).toContain("- 중복 등록\n");
    expect(section).toContain("- 중복 등록 불허");
    expect(section).toContain("- 자동 삭제 금지");
  });

  it("사실 + 처리 부연인 포함 관계는 긴 항목 한 번만 남는다", () => {
    expect(section).toContain("가격 미공시일 분리");
    expect(section).not.toMatch(/^- 가격 미공시일$/mu);
    // '저장 실패' 사실은 긴 항목 안에 그대로 남아 있다 (사실 소실 아님)
    expect(section).toContain("저장 실패 시 재시도");
    expect(section).not.toMatch(/^- 저장 실패$/mu);
  });

  it("정규화 후 완전히 같은 항목은 한 번만 남는다", () => {
    const dupDiagnosis = baseDiagnosis({
      asIs: {
        purpose: "자료 취합", trigger: "요청 시", inputs: ["원본 자료"], steps: ["자료 취합"],
        outputs: ["결과표"], exceptions: ["외부 파일 수신 지연"], humanDecisions: [], systems: [],
      },
      stepAssessments: [step("자료 취합", "자동화", "시스템", "자료를 시스템에 입력")],
      risks: ["외부 파일 수신 지연."],
    });
    const dupPlan = newPlan({ inScope: ["자료 취합"], implementation: ["자료 취합"] });
    const dupSection = exceptionsSection(buildAllInOnePrompt(dupPlan, "codex", { taskName: "중복", diagnosis: dupDiagnosis, context: "" }));
    expect(dupSection.split("외부 파일 수신 지연").length - 1).toBe(1);
  });
});

describe("2순위 — AS-IS·TO-BE·확정 산출물 구분", () => {
  const makeCase = (pocOutputs: string[], asIsOutputs: string[]) => {
    const diagnosis = baseDiagnosis({
      asIs: {
        purpose: "월간 실적 보고", trigger: "매월 말", inputs: ["실적 원본 데이터"], steps: ["자료 취합", "보고서 생성"],
        outputs: asIsOutputs, exceptions: [], humanDecisions: [], systems: ["Excel"],
      },
      stepAssessments: [step("자료 취합", "자동화", "시스템", "실적 데이터를 시스템에 입력"), step("보고서 생성", "자동화", "시스템", "집계 결과를 보고서로 작성")],
      poc: { hypothesis: "자동 집계", inScope: [], outOfScope: [], inputs: [], outputs: pocOutputs, evaluation: [], success: [], failure: [] },
    });
    const plan = newPlan({ inScope: ["자료 취합", "보고서 생성"], implementation: ["자료 취합", "보고서 생성"] });
    return { diagnosis, plan };
  };

  it("확정 산출물이 있으면 최종 산출물은 확정 산출물이고 AS-IS는 참고로 남는다", () => {
    const { diagnosis, plan } = makeCase(["보고서 생성: 자동 집계 결과 보고서"], ["담당자가 수기로 작성한 Excel 보고서"]);
    const prompt = buildAllInOnePrompt(plan, "codex", { taskName: "산출물", diagnosis, context: "" });
    const goal = prompt.match(/## 1\. 구현 목표[\s\S]*?(?=## 2\.)/)?.[0] ?? "";
    expect(goal).toContain("최종 산출물: 보고서 생성: 자동 집계 결과 보고서");
    expect(goal).not.toContain("최종 산출물: 담당자가 수기로 작성한 Excel 보고서");
    expect(prompt).toContain("기존 업무 산출물 (참고 — 최종 구현 목표 아님): 담당자가 수기로 작성한 Excel 보고서");
    // 마지막 단계의 직접 산출물도 AS-IS 결과물로 귀속되지 않는다
    const model = buildAgentInstructionModel(plan, { taskName: "산출물", diagnosis, context: "" });
    const spec = stepIoSpec(model, model.steps.findIndex(s => s.step === "보고서 생성"));
    expect(spec.outputs.join(" ")).not.toContain("수기로 작성한");
    expect(spec.outputs.join(" ")).toContain("자동 집계 결과 보고서");
  });

  it("확정 산출물이 없으면 AS-IS 산출물이 전체 산출물로 유지된다 (기존 동작)", () => {
    const { diagnosis, plan } = makeCase([], ["월간 실적 보고서"]);
    const prompt = buildAllInOnePrompt(plan, "codex", { taskName: "산출물2", diagnosis, context: "" });
    expect(prompt).toContain("최종 산출물: 월간 실적 보고서");
    expect(prompt).not.toContain("기존 업무 산출물 (참고");
  });

  it("AS-IS 산출물이 단계에 연결돼 확정 산출물과 같으면 참고 줄이 중복되지 않는다", () => {
    const { diagnosis, plan } = makeCase([], ["보고서 생성: 월간 실적 보고서"]);
    const prompt = buildAllInOnePrompt(plan, "codex", { taskName: "산출물3", diagnosis, context: "" });
    expect(prompt).toContain("최종 산출물: 보고서 생성: 월간 실적 보고서");
    expect(prompt).not.toContain("기존 업무 산출물 (참고");
  });
});

describe("3순위 — 기능별 고유 검증 기준 보존", () => {
  const diagnosis = baseDiagnosis({
    asIs: {
      purpose: "월간 실적 보고", trigger: "매월 말", inputs: ["실적 원본 데이터"], steps: ["자료 취합", "보고서 생성"],
      outputs: ["월간 실적 보고서"], exceptions: [], humanDecisions: [], systems: [],
    },
    stepAssessments: [step("자료 취합", "자동화", "시스템", "실적 데이터를 시스템에 입력"), step("보고서 생성", "자동화", "시스템", "집계 결과를 보고서로 작성")],
    poc: { hypothesis: "", inScope: [], outOfScope: [], inputs: [], outputs: [], evaluation: [], success: [], failure: ["보고서 생성 — 합계가 원본과 다르면 실패"] },
  });
  const plan = newPlan({
    inScope: ["자료 취합", "보고서 생성"], implementation: ["자료 취합", "보고서 생성"],
    acceptance: ["보고서 생성 — 합계 오차 0원 일치", "자료 취합 — 누락 행 0건"],
  });
  const prompt = buildAllInOnePrompt(plan, "codex", { taskName: "검증기준", diagnosis, context: "" });

  it("단계 연결 고유 성공 기준은 단계 표기와 함께 판정 기준에 보존된다", () => {
    const criteria = prompt.match(/### 판정 기준[\s\S]*?(?=### |$)/)?.[0] ?? "";
    expect(criteria).toContain("합계 오차 0원 일치");
    expect(criteria).toContain("관련 단계: 보고서 생성");
    expect(criteria).toContain("누락 행 0건");
  });

  it("단계 연결 실패 기준은 성공 기준과 섞이지 않는다", () => {
    const fail = prompt.match(/### 단계별 실패 판정 기준[\s\S]*?(?=### |$)/)?.[0] ?? "";
    expect(fail).toContain("합계가 원본과 다르면 실패");
    const criteria = prompt.match(/### 판정 기준[\s\S]*?(?=### |$)/)?.[0] ?? "";
    expect(criteria).not.toContain("합계가 원본과 다르면 실패");
  });

  it("기능별 검증 줄은 방식별 공통 기준을 참조하는 구조를 유지한다", () => {
    const func = prompt.match(/### 기능 2\. 보고서 생성[\s\S]*?(?=### 기능|## 4\.)/)?.[0] ?? "";
    expect(func).toContain("검증 기준 적용 (위 '방식별 검증 기준' 참조)");
  });
});
