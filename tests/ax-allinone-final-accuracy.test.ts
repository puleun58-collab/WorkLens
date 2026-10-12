
import { describe, expect, it } from "vitest";
import {
  buildAgentInstructionModel, guardPlan, isConfirmedMetric, stepMethodLabel,
} from "../src/lib/ax/guide";
import type { AxDiagnosis } from "../src/lib/ax/types";
import { freightCase } from "./fixtures/ax-agent-cases";
import { planFixture } from "./fixtures/ax";

const EVIDENCE_CONTEXT = "계약서상 정산 오차율 0.5% 이내. 매월 100건 처리. 처리시간 30분. 운임 10% 할인 적용.";

const modelFor = (diagnosis: AxDiagnosis) =>
  buildAgentInstructionModel(undefined, { diagnosis, taskName: "테스트 업무", context: EVIDENCE_CONTEXT });

/** A diagnosis with a single step under test, cloned from the freight fixture. */
const singleStepDiagnosis = (step: string, note: string, toBeDescription?: string): AxDiagnosis => {
  const diagnosis = structuredClone(freightCase.diagnosis);
  diagnosis.stepAssessments = [{ step, verdict: "AI 보조", owner: "AI", note }];
  if (toBeDescription) diagnosis.toBe = [{ step, owner: "시스템", description: toBeDescription }];
  return diagnosis;
};

describe("AX metric evidence precision (same number is not the same meaning)", () => {
  const cases: [string, string, string, boolean][] = [
    ["정산 오차율 0.5%", "정산 오차율 0.5% 확인", EVIDENCE_CONTEXT, true],
    ["정산 오차율 0.5%", "시스템 오류율 0.5% 달성", EVIDENCE_CONTEXT, false],
    ["처리시간 30분", "처리시간 30% 단축", EVIDENCE_CONTEXT, false],
    ["운임 10% 할인", "정확도 10% 향상", EVIDENCE_CONTEXT, false],
    ["근거 없음", "정확도 99% 달성", "", false],
    ["월간 100건 처리", "100건 자동 처리 보장", EVIDENCE_CONTEXT, false],
    ["", "0.5% 이내 유지", EVIDENCE_CONTEXT, false],
  ];
  it.each(cases)("%s -> %s", (_fact, generated, context, expected) => {
    expect(isConfirmedMetric(generated, context)).toBe(expected);
  });
  it("keeps a confirmed business rule and drops an unconfirmed performance goal", () => {
    const plan = structuredClone(planFixture);
    plan.acceptance = ["계약서상 정산 오차율 0.5% 이내 확인", "정확도 99% 달성"];
    const guarded = guardPlan(plan, EVIDENCE_CONTEXT);
    expect(guarded.acceptance).toContain("계약서상 정산 오차율 0.5% 이내 확인");
    expect(guarded.acceptance).not.toContain("정확도 99% 달성");
  });
});

describe("AX guardPlan applies every safety check even for confirmed metrics", () => {
  const confirmed = (items: string[]) => guardPlan({ ...structuredClone(planFixture), acceptance: items }, EVIDENCE_CONTEXT).acceptance;
  it("case A: confirmed metric + unconfirmed API", () => {
    const [item] = confirmed(["정산 오차율 0.5% 이내를 유지하고 신규 ERP API로 자동 전송"]);
    expect(item).toContain("0.5%");
    expect(item).toContain("(확인 필요: 실제 연동 방식과 권한을 확인한 뒤 확인된 방식만 사용하세요)");
  });
  it("case B: confirmed metric + auto approval", () => {
    const [item] = confirmed(["정산 오차율 0.5% 이내면 자동 승인"]);
    expect(item).toContain("0.5%");
    expect(item).toContain("(확인 필요: 업무 규칙에서 확인된 경우에만 적용하고, 아니면 대상 건을 표시만 하세요)");
  });
  it("case C: confirmed metric + unconfirmed organization", () => {
    const [item] = confirmed(["정산 오차율 0.5%를 재무혁신본부가 최종 승인"]);
    expect(item).toContain("0.5%");
    expect(item).not.toContain("재무혁신본부");
    expect(item).toContain("담당 조직");
    expect(item).toContain("(확인 필요: 실제 담당 조직을 확인하세요)");
  });
  it("case D: unconfirmed performance goal with several risks is dropped", () => {
    expect(confirmed(["정확도 99%를 달성하고 신규 API로 자동 수정·전송"])).toEqual([]);
  });
  it("is idempotent and never mutates the raw plan", () => {
    const raw = { ...structuredClone(planFixture), acceptance: ["정산 오차율 0.5% 이내를 유지하고 신규 ERP API로 자동 전송", "정확도 99% 달성"] };
    const once = guardPlan(raw, EVIDENCE_CONTEXT);
    const twice = guardPlan(once, EVIDENCE_CONTEXT);
    expect(twice).toEqual(once);
    expect(raw.acceptance).toEqual(["정산 오차율 0.5% 이내를 유지하고 신규 ERP API로 자동 전송", "정확도 99% 달성"]);
  });
});

describe("AX composite order: sequence, parallel, enumeration, conflict", () => {
  const modelOf = (note: string, toBe?: string) => modelFor(singleStepDiagnosis("검토 단계", note, toBe));
  it("A: explicit sequential flow keeps the confirmed order", () => {
    const model = modelOf("AI가 컬럼 매핑 후보를 제안한 후, 확정된 규칙으로 검증하고 담당자가 최종 확인한다.");
    expect(model.methods[0]).toBe("composite");
    expect(model.methodChains[0]).toEqual(["assist", "rule", "manual"]);
    expect(model.methodOrders[0]).toBe("sequence");
    expect(stepMethodLabel(model, 0)).toContain("복합 처리 (확인된 순서): AI 후보·초안 생성 → 규칙 기반 처리 → 담당자 확인");
  });
  it("B: explicit parallel execution is not rewritten as a sequence", () => {
    const model = modelOf("AI 후보 검토와 규칙 기반 데이터 검증을 병행한다.");
    expect(model.methods[0]).toBe("composite");
    expect(model.methodChains[0]).toEqual(["assist", "rule"]);
    expect(model.methodOrders[0]).toBe("parallel");
    const label = stepMethodLabel(model, 0);
    expect(label).toContain("복합 처리 (병행)");
    expect(label).not.toContain("→");
    expect(label).toContain("실행 순서·의존성 확인 필요");
  });
  it("C: mere enumeration never establishes an order", () => {
    const model = modelOf("AI 처리 그리고 스크립트로 파일을 병합");
    expect(model.methods[0]).toBe("confirm");
    expect(model.methodChains[0]).toBeUndefined();
  });
  it("weak connector with an explicit actor still counts as a sequence", () => {
    const model = modelOf("로컬 스크립트로 Excel 파일을 병합하고 담당자가 결과를 확인");
    expect(model.methods[0]).toBe("composite");
    expect(model.methodChains[0]).toEqual(["script", "manual"]);
    expect(model.methodOrders[0]).toBe("sequence");
  });
  it("D: conflicting evidence across sources stays confirm", () => {
    const model = modelOf("규칙 기반으로 누락 검사", "AI 모델이 누락 여부를 최종 판단");
    expect(model.methods[0]).toBe("confirm");
    expect(model.methodReasons[0]).toContain("처리 방식 근거 충돌");
  });
  it("E: a single processing role stays a single method", () => {
    const model = modelOf("확정된 계산식에 따라 운임을 계산한다.");
    expect(model.methods[0]).toBe("rule");
  });
});
