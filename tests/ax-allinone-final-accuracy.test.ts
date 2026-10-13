
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
    expect(item).toContain("(확인 필요: ERP API의 전송 기능과 실제 권한을 확인한 뒤 확인된 범위에서만 사용하세요)");
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

describe("AX boundary: every metric in one sentence is verified independently", () => {
  const ctx = (s: string) => s;
  it.each([
    ["오차율 0.5%", "오차율 0.5% 유지", true],
    ["오차율 0.5%", "오차율 0.5% 유지·정확도 99% 달성", false],
    ["오차율 0.5% 이내, 불량률 2% 이내", "오차율 0.5%와 불량률 2%를 대조", true],
    ["응답률 95% 유지", "응답률 95%·정확도 95% 달성", false],
    ["기존 처리량 100건", "100건 자동 처리 보장", false],
    ["", "정확도 99%·시간 80% 단축", false],
  ])("isConfirmedMetric(%s, %s)", (context, generated, expected) => {
    expect(isConfirmedMetric(generated, ctx(context))).toBe(expected);
  });
  it("keeps a partially confirmed sentence but names the unconfirmed metrics", () => {
    const plan = structuredClone(planFixture);
    plan.acceptance = ["정산 오차율 0.5% 유지 및 정확도 99% 달성"];
    const guarded = guardPlan(plan, "정산 오차율 0.5% 이내");
    expect(guarded.acceptance).toHaveLength(1);
    expect(guarded.acceptance[0]).toContain("정산 오차율 0.5% 유지 및 정확도 99% 달성");
    expect(guarded.acceptance[0]).toContain("(확인 필요: 다음 수치의 근거를 먼저 확인하세요: 정확도 99%)");
  });
  it("drops a sentence whose metrics are all unconfirmed", () => {
    const plan = structuredClone(planFixture);
    plan.acceptance = ["정확도 99%·시간 80% 단축 달성"];
    expect(guardPlan(plan, "").acceptance).toEqual([]);
  });
  it("is idempotent for partially confirmed sentences", () => {
    const plan = structuredClone(planFixture);
    plan.acceptance = ["정산 오차율 0.5% 유지 및 정확도 99% 달성"];
    const once = guardPlan(plan, "정산 오차율 0.5% 이내");
    expect(guardPlan(once, "정산 오차율 0.5% 이내")).toEqual(once);
  });
  it("verifies metrics at the start, middle and end of a sentence", () => {
    const context = "오차율 0.5% 이내, 불량률 2% 이내";
    expect(isConfirmedMetric("오차율 0.5% 유지 후 불량률 2% 대조", context)).toBe(true);
    expect(isConfirmedMetric("불량률 2% 대조 후 오차율 0.5% 유지", context)).toBe(true);
    expect(isConfirmedMetric("정확도 99% 달성 후 오차율 0.5% 유지", context)).toBe(false);
  });
});

describe("AX boundary: per-API existence, function and permission", () => {
  const guarded = (items: string[], context: string) =>
    guardPlan({ ...structuredClone(planFixture), implementation: items }, context).implementation;
  it("does not block a confirmed read API", () => {
    expect(guarded(["ERP API로 데이터 조회"], "ERP 읽기 API 연동 가능")).toEqual(["ERP API로 데이터 조회"]);
  });
  it("flags a write through a read-only API", () => {
    const [item] = guarded(["ERP API를 통해 정산 결과 등록"], "ERP 읽기 API 연동 가능");
    expect(item).toContain("(확인 필요: ERP API의 등록 기능과 실제 권한을 확인한 뒤 확인된 범위에서만 사용하세요)");
  });
  it("distinguishes a different integration on the same system", () => {
    const [item] = guarded(["ERP 외부 전송 API 연동"], "ERP 조회 API 사용 가능");
    expect(item).toContain("(확인 필요: ERP API의 전송 기능과 실제 권한을 확인한 뒤 확인된 범위에서만 사용하세요)");
  });
  it("distinguishes the same API name on another system", () => {
    const [item] = guarded(["시스템 B API 호출"], "시스템 A API 연동 가능");
    expect(item).toContain("(확인 필요:");
    expect(item).not.toContain("확인된 범위에서만 사용하세요");
  });
  it("keeps the auto-action check independent from the API check", () => {
    const [item] = guarded(["ERP API를 통해 정산 결과 자동 등록·전송"], "ERP 읽기 API 연동 가능");
    expect(item).toContain("(확인 필요: 업무 규칙에서 확인된 경우에만 적용하고, 아니면 대상 건을 표시만 하세요)");
    expect(item).toContain("ERP API의");
  });
  it("does not expand a confirmed write into an unrelated approval", () => {
    const [item] = guarded(["ERP API를 통해 정산 결과 등록"], "ERP 등록 API 사용 가능. 등록 권한 확인됨.");
    expect(item).toBe("ERP API를 통해 정산 결과 등록");
  });
});

describe("AX boundary: same measurement target with different wording", () => {
  it.each([
    ["정산 오차율 0.5% 이내", "기존 정산 오차율 0.5% 확인", true],
    ["정산 오차율 0.5% 이내", "현재 정산 오차율 0.5% 유지", true],
    ["정산 오차율 0.5% 이내", "정산 오차율 0.5% 확인", true],
    ["정산 오차율 0.5% 이내", "목표 정산 오차율 0.5% 달성", false],
    ["최대 처리율 95% 유지", "평균 처리율 95% 달성", false],
    ["할인율 10% 적용", "할인율 10퍼센트 적용", true],
    ["정산 오차율 0.5% 이내", "시스템 오류율 0.5% 달성", false],
  ])("isConfirmedMetric(context=%s, item=%s)", (context, item, expected) => {
    expect(isConfirmedMetric(item, context)).toBe(expected);
  });
  it("keeps the original wording when a neutral modifier is present", () => {
    const plan = structuredClone(planFixture);
    plan.acceptance = ["기존 정산 오차율 0.5% 이내 확인"];
    const guarded = guardPlan(plan, "정산 오차율 0.5% 이내");
    expect(guarded.acceptance).toEqual(["기존 정산 오차율 0.5% 이내 확인"]);
  });
});
