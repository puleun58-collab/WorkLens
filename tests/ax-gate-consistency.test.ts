import { describe, expect, it } from "vitest";
import { axMessages } from "@/lib/ax/prompt";
import { validateAxGateConsistency } from "@/lib/ax/semantic";
import type { AxDiagnosis } from "@/lib/ax/types";
import { diagnosisFixture, outputFixture } from "./fixtures/ax";

function base(overrides: Partial<AxDiagnosis> = {}): AxDiagnosis {
  return {
    ...structuredClone(diagnosisFixture),
    decisionGate: { verdict: "go", reasons: [] },
    informationSufficiency: "sufficient",
    technicalChecks: [{ topic: "시스템 접근", status: "확인됨", note: "API 접근 권한 확인 완료" }],
    ...overrides,
  };
}
const request = { kind: "ax-diagnosis" as const, name: "취합", description: "입력 표를 취합하여 담당자 승인을 받습니다.", details: {} };

describe("AX diagnosis prompt: required/optional classification and verdict criteria", () => {
  it("scopes technical checks to the first MVP and defines required vs optional with step grounding", () => {
    const prompt = axMessages(request)[0].content;
    for (const rule of [
      "기술 확인 항목은 첫 MVP에서 독립적으로 구현할 단계의 조건만 다루세요.",
      "향후 확장·연동 단계의 조건으로 현재 독립 단계를 막지 마세요.",
      "필수 조건은 현재 구현할 특정 단계의 정상 작동에 실제로 필요한 조건입니다",
      "필요한 입력 형식·업무 계산 규칙",
      "현재 필수 연동에 필요한 접근 권한",
      "해당 기능의 필수 보안·승인 조건",
      "선택적 조건(required를 false로 표시)은 현재 구현 범위를 직접 차단하지 않는 권장·향후 조건입니다",
      "향후 확장용 API 연동",
      "선택적 편의 기능",
      "현재 구현에 필요하지 않은 추가 환경 설정",
      "각 기술 확인 항목의 note에는 실제로 적용되는 단계명과 그 단계에서 이 조건이 필요한 이유를 적으세요.",
      "미확정이라는 이유만으로 선택적 조건을 필수로 분류하지 마세요.",
      "실제 필수 조건을 선택 사항으로 완화하거나",
      "확인되지 않은 사실을 확인됨으로 바꾸거나",
      "미확정 외부 연동을 우회하지 마세요.",
    ]) expect(prompt).toContain(rule);
  });
  it("gives explicit decisionGate verdict criteria and bans groundless conditional verdicts", () => {
    const prompt = axMessages(request)[0].content;
    for (const rule of [
      "decisionGate 판정 기준",
      "미확정 필수 조건·핵심 정보 부족이 없고 명시적 진행 불가 사유가 없으면 go",
      "미확정 필수 기술 확인사항·핵심 정보 부족·미확정 필수 조건이 있으면 conditional",
      "명시적 안전·법률·권한 제한이 있으면 no-go",
      "모든 필수 조건이 확인되고 핵심 정보가 충분하면 근거 없이 conditional로 판정하지 마세요.",
      "담당자 승인 단계는 humanInLoop로 다루고",
      "승인과 무관한 독립 단계까지 조건부로 제한하지 마세요.",
    ]) expect(prompt).toContain(rule);
  });
});

describe("AX gate consistency validation (read-only, never rewrites the verdict)", () => {
  it("finds no issues for go with confirmed checks and sufficient information", () => {
    expect(validateAxGateConsistency(outputFixture())).toEqual([]);
    expect(validateAxGateConsistency(base())).toEqual([]);
  });
  it("finds no issues for conditional with a genuinely unconfirmed required check", () => {
    const d = base({
      decisionGate: { verdict: "conditional", reasons: ["API 권한 확인 후 진행"] },
      technicalChecks: [{ topic: "API 권한", status: "확인 필요", note: "수집 단계 접근 권한 미확인" }],
    });
    expect(validateAxGateConsistency(d)).toEqual([]);
  });
  it("flags go with an unconfirmed required check", () => {
    const issues = validateAxGateConsistency(base({
      technicalChecks: [{ topic: "API 권한", status: "확인 필요", note: "권한 미확인" }],
    }));
    expect(issues.map(i => i.category)).toEqual(["go_with_unconfirmed_required"]);
    expect(issues[0].detail).toContain("API 권한");
  });
  it("flags go while information needs checking", () => {
    const issues = validateAxGateConsistency(base({ informationSufficiency: "needs-check" }));
    expect(issues.map(i => i.category)).toEqual(["go_with_insufficient_information"]);
  });
  it("flags conditional with no required cause and no reasons", () => {
    const issues = validateAxGateConsistency(base({ decisionGate: { verdict: "conditional", reasons: [] } }));
    expect(issues.map(i => i.category)).toEqual(["conditional_without_required_cause"]);
  });
  it("flags conditional restricted only by the 담당자 approval flow", () => {
    const issues = validateAxGateConsistency(base({
      decisionGate: { verdict: "conditional", reasons: ["담당자 최종 승인 절차 확인 필요"] },
    }));
    expect(issues.map(i => i.category)).toEqual(["conditional_on_approval_only"]);
  });
  it("flags a 확인됨 check whose note still reads unconfirmed", () => {
    const issues = validateAxGateConsistency(base({
      technicalChecks: [{ topic: "API 권한", status: "확인됨", note: "권한 미확인 상태" }],
    }));
    expect(issues.map(i => i.category)).toEqual(["confirmed_but_note_unconfirmed"]);
  });
  it("does not flag optional-only unconfirmed checks under go", () => {
    const d = base({
      technicalChecks: [{ topic: "향후 확장 API", status: "확인 필요", note: "2단계 연동 시 확인", required: false }],
    });
    expect(validateAxGateConsistency(d)).toEqual([]);
  });
  it("does not flag no-go with explicit safety reasons", () => {
    const d = base({ decisionGate: { verdict: "no-go", reasons: ["외부 전송 금지 정책"] } });
    expect(validateAxGateConsistency(d)).toEqual([]);
  });
});
