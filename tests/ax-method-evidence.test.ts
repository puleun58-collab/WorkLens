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
