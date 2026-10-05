import { describe, expect, it } from "vitest";
import { validateAxSemantics, type AxSemanticViolationCategory } from "@/lib/ax/semantic";
import type { AxDiagnosisRequest } from "@/lib/ax/types";
import { outputFixture } from "./fixtures/ax";

const request: AxDiagnosisRequest = { kind: "ax-diagnosis", name: "취합", description: "입력 표를 취합하고 담당자가 승인합니다.", details: {} };

describe("AX semantic guard", () => {
  it.each<[string, Partial<AxDiagnosisRequest>]>([
    ["입력 표를 대조해 검증합니다", {}],
    ["월 20회 수행", { details: { runsPerMonth: 20 } }],
    ["1회 30분 소요", { details: { minutesPerRun: 30 } }],
    ["담당자 2명", { details: { people: 2 } }],
    ["2단계 승인", {}],
    ["Phase 1", {}],
    ["Level 3", {}],
    ["Factor 4점", {}],
    ["현재 처리시간은 약 60분입니다", { description: "현재 60분 걸립니다" }],
    ["사용자가 설정한 목표는 처리시간 30% 단축입니다", { details: { goal: "처리 시간을 30% 줄이는 것이 목표입니다" } }],
    ["현재 처리시간은 30분이다", { description: "현재 30분 걸린다" }],
  ])("allows facts, goals and structural numbers: %s", (text, input) => {
    const diagnosis = outputFixture();
    diagnosis.poc.hypothesis = text;
    expect(validateAxSemantics(diagnosis, { ...request, ...input })).toEqual([]);
  });

  it.each<[string, AxSemanticViolationCategory, Partial<AxDiagnosisRequest>]>([
    ["작업 시간 50% 절감", "invented_time_saving", {}],
    ["오류 80% 감소", "invented_accuracy_claim", {}],
    ["정확도 95%", "invented_accuracy_claim", {}],
    ["자동화율 70%", "invented_automation_rate", {}],
    ["ROI 150%", "invented_roi", {}],
    ["효율 2배", "unsupported_performance_metric", {}],
    ["처리시간 40% 단축", "invented_time_saving", {}],
    ["생산성 30% 향상", "unsupported_performance_metric", {}],
    ["자동화하면 30% 단축된다", "unsupported_performance_metric", { description: "현재 30분 걸린다" }],
    ["자동화하면 오류율이 20% 감소한다", "invented_accuracy_claim", { details: { goal: "오류율을 20% 줄이는 것이 목표" } }],
    ["자동화 후 30분 이하로 단축됩니다", "invented_time_saving", { description: "현재 60분이며 목표는 30분 이하" }],
    ["정확도 95", "invented_accuracy_claim", {}],
    ["roi 150", "invented_roi", {}],
    ["효율 2.5배 개선", "unsupported_performance_metric", {}],
    ["작업 시간 12.5퍼센트 절감", "invented_time_saving", {}],
  ])("blocks unsupported claims: %s", (text, category, input) => {
    const diagnosis = outputFixture();
    diagnosis.poc.hypothesis = text;
    expect(validateAxSemantics(diagnosis, { ...request, ...input })).toEqual([{ category, field: "poc.hypothesis" }]);
  });

  it("accepts the baseline diagnosis without changing it", () => {
    const diagnosis = outputFixture();
    const before = structuredClone(diagnosis);
    expect(validateAxSemantics(diagnosis, request)).toEqual([]);
    expect(diagnosis).toEqual(before);
  });

  it("checks every specified narrative path and returns its exact location", () => {
    const fields = [
      "followUpQuestions[0]", "asIs.purpose", "asIs.trigger", "asIs.inputs[0]", "asIs.steps[0]", "asIs.outputs[0]",
      "asIs.exceptions[0]", "asIs.humanDecisions[0]", "asIs.systems[0]", "factors[0].rationale",
      "stepAssessments[0].step", "stepAssessments[0].note", "toBe[0].step", "toBe[0].description", "humanInLoop[0]",
      "technicalChecks[0].topic", "technicalChecks[0].note", "risks[0]", "poc.hypothesis", "poc.inScope[0]",
      "poc.outOfScope[0]", "poc.inputs[0]", "poc.outputs[0]", "poc.evaluation[0]", "poc.success[0]", "poc.failure[0]",
      "decisionGate.reasons[0]", "roadmap[0].phase", "roadmap[0].title", "roadmap[0].items[0]", "operation.owner",
      "operation.failureOwner", "operation.fallback", "operation.notes[0]", "nextAction.label", "nextAction.detail",
    ];
    for (const field of fields) {
      const diagnosis = outputFixture();
      const keys = field.replace(/\[(\d+)\]/g, ".$1").split(".");
      let parent = diagnosis as unknown as Record<string, unknown>;
      for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
      parent[keys.at(-1)!] = "ROI 150%";
      const before = structuredClone(diagnosis);
      expect(validateAxSemantics(diagnosis, request)).toEqual([{ category: "invented_roi", field }]);
      expect(diagnosis).toEqual(before);
    }
  });

  it("deduplicates overlapping rules and repeated claims within a field, retaining other fields", () => {
    const diagnosis = outputFixture();
    diagnosis.risks = ["ROI 150% 또는 ROI 200%", "ROI 150%"];
    expect(validateAxSemantics(diagnosis, request)).toEqual([
      { category: "invented_roi", field: "risks[0]" }, { category: "invented_roi", field: "risks[1]" },
    ]);
  });

  it("requires the goal marker in both input and output and matches each claim's unit", () => {
    const diagnosis = outputFixture();
    diagnosis.poc.hypothesis = "목표는 처리시간 30퍼센트 단축";
    expect(validateAxSemantics(diagnosis, { ...request, details: { goal: "목표는 처리시간 30% 단축" } })).toHaveLength(1);
    diagnosis.poc.hypothesis = "목표는 처리시간 30% 단축";
    expect(validateAxSemantics(diagnosis, { ...request, description: "현재 수치 30%" })).toHaveLength(1);
    diagnosis.poc.hypothesis = "목표는 처리시간 30% 단축, 효율 2배 개선";
    expect(validateAxSemantics(diagnosis, { ...request, details: { goal: "목표는 처리시간 30% 단축" } })).toHaveLength(1);
  });

  it("collects facts from every input text field and rendered numeric details", () => {
    const diagnosis = outputFixture();
    diagnosis.poc.hypothesis = "현재 정확도 80%";
    for (const key of ["name", "description"] as const) expect(validateAxSemantics(diagnosis, { ...request, [key]: "현재 정확도 80%" })).toEqual([]);
    for (const key of ["cycle", "systems", "inputs", "outputs", "humanSteps", "painPoints", "goal"] as const) {
      expect(validateAxSemantics(diagnosis, { ...request, details: { [key]: "현재 정확도 80%" } })).toEqual([]);
    }
    for (const [text, details] of [
      ["현재 효율 측정은 30분 소요", { minutesPerRun: 30 }],
      ["현재 효율 측정은 월 20회", { runsPerMonth: 20 }],
      ["현재 효율 측정 담당자 2명", { people: 2 }],
    ] as const) {
      diagnosis.poc.hypothesis = text;
      expect(validateAxSemantics(diagnosis, { ...request, details })).toEqual([]);
    }
  });

  it("does not treat attachment summaries as factual metric evidence", () => {
    const diagnosis = outputFixture();
    diagnosis.poc.hypothesis = "정확도 95%";
    expect(validateAxSemantics(diagnosis, { ...request, attachmentSummary: "정확도 95%" })).toHaveLength(1);
  });

  it("allows multipliers without a performance context", () => {
    const diagnosis = outputFixture();
    diagnosis.asIs.inputs = ["파일을 2배 크기로 표시"];
    expect(validateAxSemantics(diagnosis, request)).toEqual([]);
  });
});
