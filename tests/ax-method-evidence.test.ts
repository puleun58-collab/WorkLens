import { describe, expect, test } from "vitest";
import {
  buildAllInOnePrompt,
  isConfirmedMethodEvidence,
  isConflictingMethodEvidence,
  stepMethodLabel,
} from "../src/lib/ax/guide";
import type { AgentInstructionModel } from "../src/lib/ax/guide";
import { dieselCase } from "./fixtures/diesel-case";

/** 최소 모델 픽스처 — methods/methodReasons/methodUserReasons만 설정 */
function makeModel(overrides: {
  methods: ("confirm" | "rule")[];
  methodReasons: string[];
  methodUserReasons: string[];
}): AgentInstructionModel {
  const n = overrides.methods.length;
  return {
    steps: Array.from({ length: n }, (_, i) => ({ step: `단계${i + 1}`, scope: "implement" as const })),
    methods: overrides.methods,
    methodReasons: overrides.methodReasons,
    methodUserReasons: overrides.methodUserReasons,
    methodChains: Array(n).fill(undefined),
    methodOrders: Array(n).fill(undefined),
  } as unknown as AgentInstructionModel;
}

describe("isConflictingMethodEvidence", () => {
  test("근거 충돌 reason이면 true", () => {
    const m = makeModel({
      methods: ["confirm"],
      methodReasons: ["처리 방식 근거 충돌; diagnosis.stepAssessments.note: 규칙 처리"],
      methodUserReasons: ["처리 방식 근거 충돌; 규칙 처리"],
    });
    expect(isConflictingMethodEvidence(m, 0)).toBe(true);
  });
  test("일반 confirm이면 false", () => {
    const m = makeModel({
      methods: ["confirm"],
      methodReasons: ["명시적 처리 방식 확인 필요"],
      methodUserReasons: ["진단에 처리 방식의 구체적 근거가 없음: 실제 처리 규칙·입력 형식을 확인하세요"],
    });
    expect(isConflictingMethodEvidence(m, 0)).toBe(false);
  });
  test("confirm이 아니면 false", () => {
    const m = makeModel({
      methods: ["rule"],
      methodReasons: [""],
      methodUserReasons: [""],
    });
    expect(isConflictingMethodEvidence(m, 0)).toBe(false);
  });
});

describe("isConfirmedMethodEvidence", () => {
  test("실제 근거가 있으면 true", () => {
    const m = makeModel({
      methods: ["confirm"],
      methodReasons: ["diagnosis.stepAssessments.note: 엑셀 합산 규칙"],
      methodUserReasons: ["엑셀 합산 규칙"],
    });
    expect(isConfirmedMethodEvidence(m, 0)).toBe(true);
  });
  test("근거 충돌이면 false (확정으로 승격 금지)", () => {
    const m = makeModel({
      methods: ["confirm"],
      methodReasons: ["처리 방식 근거 충돌; diagnosis.stepAssessments.note: 규칙 처리"],
      methodUserReasons: ["처리 방식 근거 충돌; 규칙 처리"],
    });
    expect(isConfirmedMethodEvidence(m, 0)).toBe(false);
  });
  test("근거 없음이면 false", () => {
    const m = makeModel({
      methods: ["confirm"],
      methodReasons: ["명시적 처리 방식 확인 필요"],
      methodUserReasons: ["진단에 처리 방식의 구체적 근거가 없음: 실제 처리 규칙·입력 형식을 확인하세요"],
    });
    expect(isConfirmedMethodEvidence(m, 0)).toBe(false);
  });
  test("빈 userReason이면 false", () => {
    const m = makeModel({
      methods: ["confirm"],
      methodReasons: [""],
      methodUserReasons: [""],
    });
    expect(isConfirmedMethodEvidence(m, 0)).toBe(false);
  });
});

describe("stepMethodLabel confirm 분기", () => {
  test("충돌 시 '확인된 처리 기준' 표현을 사용하지 않음", () => {
    const m = makeModel({
      methods: ["confirm"],
      methodReasons: ["처리 방식 근거 충돌; diagnosis.stepAssessments.note: 규칙 처리"],
      methodUserReasons: ["처리 방식 근거 충돌; 규칙 처리"],
    });
    const label = stepMethodLabel(m, 0);
    expect(label).toContain("처리 방식 근거 충돌");
    expect(label).not.toContain("확인된 처리 기준에 따라 구현");
    expect(label).toContain("임의로 선택·구현하지 마세요");
  });
  test("근거 없을 때 '확인된 처리 기준'으로 오판하지 않음", () => {
    const m = makeModel({
      methods: ["confirm"],
      methodReasons: ["명시적 처리 방식 확인 필요"],
      methodUserReasons: ["진단에 처리 방식의 구체적 근거가 없음: 실제 처리 규칙·입력 형식을 확인하세요"],
    });
    const label = stepMethodLabel(m, 0);
    expect(label).toContain("처리 방식 미확정");
    expect(label).not.toContain("확인된 처리 기준에 따라 구현");
  });
  test("실제 근거가 있으면 확인된 기준으로 표시", () => {
    const m = makeModel({
      methods: ["confirm"],
      methodReasons: ["diagnosis.stepAssessments.note: 엑셀 합산 규칙"],
      methodUserReasons: ["엑셀 합산 규칙"],
    });
    const label = stepMethodLabel(m, 0);
    expect(label).toContain("확인된 처리 기준에 따라 구현");
    expect(label).toContain("엑셀 합산 규칙");
  });
});

describe("4순위: 전체 프롬프트 통합 — 근거 없는 confirm 단계 오판 방지", () => {
  test("근거 없는 confirm 단계에 '확인된 처리 기준' 표시 없음", () => {
    const prompt = buildAllInOnePrompt(dieselCase.plan, "codex", {
      taskName: dieselCase.name, diagnosis: dieselCase.diagnosis, context: "",
    });
    // dieselCase의 confirm 단계들은 처리 근거가 없으므로 "확인된 처리 기준"이 나오면 안 됨
    expect(prompt).not.toContain("확인된 처리 기준에 따라 구현");
    // 대신 미확정으로 표시되어야 함
    expect(prompt).toContain("처리 방식 미확정");
  });
  test("담당자 확인 bullet에서도 오판 없음", () => {
    const prompt = buildAllInOnePrompt(dieselCase.plan, "codex", {
      taskName: dieselCase.name, diagnosis: dieselCase.diagnosis, context: "",
    });
    expect(prompt).not.toContain("위 '확인된 기준'에 명시된 처리 방식을 그대로 구현하세요");
  });
});

describe("doneWhen·stepMethodLabel 일관성 (지시문 내부 모순 회귀 방지)", () => {
  // 5순위 실전 평가 crud 사례 재현: 근거 텍스트는 있으나 처리 방식 키워드가 없어
  // method=confirm이 되는 단계. 구 로직에서는 표기가 "확인된 처리 기준에 따라 구현"이면서
  // 완료 기준이 "구현을 시작하지 마세요"인 모순이 발생했음.
  const crudLikeDiagnosis = {
    informationSufficiency: "sufficient",
    followUpQuestions: [],
    asIs: {
      purpose: "CRUD", trigger: "사용자 요청", inputs: ["사용자 입력"],
      steps: ["등록", "계산"], outputs: ["결과"], exceptions: [],
      humanDecisions: [], systems: [],
    },
    factors: ["repetition", "regularity", "dataStructure", "systemAccess", "humanJudgment", "operationalRisk"]
      .map(key => ({ key, aiValue: 3, rationale: "등록된 업무 설명 근거" })),
    stepAssessments: [
      { step: "등록", verdict: "자동화", owner: "시스템", note: "사용자 입력 → 서버가 ID 중복 검사 후 JSON에 추가" },
      { step: "계산", verdict: "자동화", owner: "시스템", note: "규칙 기반으로 합산 계산식을 적용" },
    ],
    toBe: [],
    humanInLoop: [],
    technicalChecks: [],
    risks: [],
    poc: { hypothesis: "", inScope: [], outOfScope: [], inputs: [], outputs: [], evaluation: [], success: [], failure: [] },
    decisionGate: { verdict: "conditional", reasons: ["확인 후 진행"] },
    roadmap: [],
    operation: { owner: "", failureOwner: "", maintenanceBurden: "low", fallback: "", notes: [] },
    nextAction: { label: "", detail: "" },
    sourceNote: "test",
  };
  const crudLikePlan = {
    repositoryFirst: "Repository-first: 테스트",
    goal: ["crud"], asIs: [], toBe: [], inScope: ["등록", "계산"], outOfScope: [],
    prerequisites: [], humanInLoop: [], poc: [], implementation: ["등록", "계산"],
    dataFlow: [], integrations: [], exceptions: [], fallback: [], security: [],
    operation: [], tests: [], acceptance: [],
  };
  const buildCrudPrompt = () => buildAllInOnePrompt(
    crudLikePlan as never, "codex", { taskName: "CRUD 테스트", diagnosis: crudLikeDiagnosis as never, context: "" },
  );

  test("미확정 confirm 단계: 표기와 완료 기준이 모두 '확인 후 진행'으로 일치", () => {
    const prompt = buildCrudPrompt();
    // 근거 없는 confirm 단계는 미확정으로 표시 (과거 "확인된 처리 기준" 오판 방지)
    expect(prompt).toContain("처리 방식 미확정");
    expect(prompt).not.toContain("확인된 처리 기준에 따라 구현");
    // 미확정 단계의 완료 기준은 '확인 후 진행'과 일치해야 함 (표기와 모순 금지)
    expect(prompt).toContain("방식이 확정되기 전에는 구현을 시작하지 마세요");
  });

  test("'구현하세요'와 '구현하지 마세요'가 같은 지시문에 공존하지 않음", () => {
    const prompt = buildCrudPrompt();
    // "확인된 처리 기준에 따라 구현"(구현 허용)과 "처리 방식이 확정되지 않았습니다"(구현 금지)는
    // 같은 확정 판정에서 나올 수 없으므로 상호 배타적이어야 한다
    const hasConfirmed = prompt.includes("확인된 처리 기준에 따라 구현");
    const hasUnconfirmedDone = prompt.includes("처리 방식이 확정되지 않았습니다");
    expect(hasConfirmed && hasUnconfirmedDone).toBe(false);
  });

  test("명시적 처리 방식(rule) 단계의 완료 기준은 구현 금지를 말하지 않음", () => {
    const prompt = buildCrudPrompt();
    // "계산" 단계는 rule이므로, 해당 요구사항 섹션(다음 ### 제목 전까지)의 완료 기준에
    // "구현을 시작하지 마세요"가 없어야 함
    const start = prompt.indexOf("### 기능 2. 계산");
    expect(start).toBeGreaterThanOrEqual(0);
    const nextHeading = prompt.indexOf("\n### ", start + 1);
    const calcSection = nextHeading > 0 ? prompt.slice(start, nextHeading) : prompt.slice(start);
    expect(calcSection).toContain("규칙 기반 처리");
    expect(calcSection).not.toContain("구현을 시작하지 마세요");
    expect(calcSection).toContain("확인된 형식·키·업무 규칙으로 실제 입력이 처리되고");
  });
});
