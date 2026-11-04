import { describe, expect, it } from "vitest";
import { applyCurrentFacts, currentFactAssessment, resolveCurrentFacts } from "@/lib/ax/current-facts";
import { executionGate, taskStatus } from "@/lib/ax/policy";
import type { AxDiagnosisRequest } from "@/lib/ax/types";
import { diagnosisFixture } from "./fixtures/ax";

const request: AxDiagnosisRequest = { kind: "ax-diagnosis", name: "정산", description: "매월 운송 실적을 취합하고 정산표를 작성한 뒤 담당자가 최종 승인한다. 누락 건은 담당자가 원본을 확인한다. Excel로 처리한다.", details: {} };
const extracted = { facts: [
  { field: "cycle", source: "description", quote: "매월" },
  { field: "inputs", source: "description", quote: "운송 실적" },
  { field: "outputs", source: "description", quote: "정산표를 작성" },
  { field: "humanDecisions", source: "description", quote: "담당자가 최종 승인한다" },
  { field: "steps", source: "description", quote: "운송 실적을 취합하고 정산표를 작성한 뒤 담당자가 최종 승인한다" },
  { field: "exceptions", source: "description", quote: "누락 건은 담당자가 원본을 확인한다" },
  { field: "systems", source: "description", quote: "Excel" },
], conflicts: [] };
const grounding = () => resolveCurrentFacts(request, structuredClone(extracted));

describe("source-grounded information sufficiency", () => {
  it.each([0, 1, 2, 3, 4])("uses %i verified core facts, not the AI's status", count => {
    const keys = ["cycle", "inputs", "outputs", "humanSteps"] as const;
    const values = ["매월", "실적표", "정산표", "최종 승인"];
    const details = Object.fromEntries(keys.slice(0, count).map((key, i) => [key, values[i]]));
    const g = resolveCurrentFacts({ ...request, details }, { facts: [], conflicts: [] });
    for (const old of ["needs-check", "partial", "sufficient"] as const) {
      const result = applyCurrentFacts({ ...diagnosisFixture, informationSufficiency: old }, g);
      expect(result.informationSufficiency).toBe(count < 2 ? "needs-check" : "partial");
      expect(taskStatus(result)).toBe(count < 2 ? "needs-info" : "diagnosed");
    }
  });
  it("accepts description-only facts while keeping technical unknowns separate", () => {
    const result = applyCurrentFacts({ ...diagnosisFixture, decisionGate: { verdict: "go" as const, reasons: [] } }, grounding());
    expect(result.informationSufficiency).toBe("sufficient");
    expect(result.asIs.systems).toEqual(["Excel"]);
    expect(result.asIs.trigger).toBe("매월");
    expect(result.technicalChecks).toEqual(diagnosisFixture.technicalChecks);
    expect(executionGate(result)).toBe("conditional");
  });
  it("does not confuse four core facts with a complete current procedure, nor flip on unstated systems/exceptions", () => {
    const withoutSteps = grounding();
    withoutSteps.facts = withoutSteps.facts.filter(fact => fact.field !== "steps");
    expect(currentFactAssessment(withoutSteps).informationSufficiency).toBe("partial");
    const unstated = grounding();
    unstated.facts = unstated.facts.filter(fact => fact.field !== "systems" && fact.field !== "exceptions");
    expect(currentFactAssessment(unstated)).toMatchObject({ informationSufficiency: "sufficient", asIs: { systems: [], exceptions: [] } });
  });
  it("keeps conflicting explicit facts as evidence without choosing one, and blocks implementation", () => {
    const revised = { ...request, details: { cycle: "매주" } };
    const g = resolveCurrentFacts(revised, { ...extracted, conflicts: [{ field: "cycle", left: { source: "details.cycle", quote: "매주" }, right: { source: "description", quote: "매월" } }] });
    const result = applyCurrentFacts({ ...diagnosisFixture, decisionGate: { verdict: "go" as const, reasons: [] }, technicalChecks: [] }, g);
    expect(result.asIs.trigger).toBe("확인 필요");
    expect(result.informationSufficiency).toBe("partial");
    expect(result.grounding.conflicts).toHaveLength(1);
    expect(result.technicalChecks[0]).toMatchObject({ required: true, status: "확인 필요" });
    expect(executionGate(result)).toBe("conditional");
  });
  it("keeps an automation step over an unstated current system behind a required check", () => {
    const g = grounding();
    g.facts = g.facts.filter(fact => fact.field !== "systems");
    const automated = { ...diagnosisFixture, decisionGate: { verdict: "go" as const, reasons: [] }, technicalChecks: [],
      stepAssessments: [{ step: "정산 금액 계산", verdict: "자동화" as const, owner: "시스템" as const, note: "계산 자동화" }] };
    const result = applyCurrentFacts(automated, g);
    expect(result.technicalChecks).toEqual([expect.objectContaining({ topic: "현재 사용 시스템·자료 접근 방식", status: "확인 필요", required: true })]);
    expect(executionGate(result)).toBe("conditional");
    // A stated system, a human-only plan, or an already open required check adds nothing.
    expect(applyCurrentFacts(automated, grounding()).technicalChecks).toEqual([]);
    expect(applyCurrentFacts({ ...automated, stepAssessments: [{ ...automated.stepAssessments[0], verdict: "사람 유지" as const }] }, g).technicalChecks).toEqual([]);
    const open = [{ topic: "자료 접근 권한", status: "확인 필요" as const, note: "확인", required: true }];
    expect(applyCurrentFacts({ ...automated, technicalChecks: open }, g).technicalChecks).toEqual(open);
  });
  it("ignores blank/unknown entries and counts duplicates once", () => {
    const plain = { ...request, description: "운송 실적을 취합한다." };
    const g = resolveCurrentFacts({ ...plain, details: { cycle: "  ", outputs: "미정", humanSteps: "확인 필요" } }, { facts: [extracted.facts[1], extracted.facts[1]], conflicts: [] });
    expect(currentFactAssessment(g).informationSufficiency).toBe("needs-check");
    expect(currentFactAssessment(g).asIs.inputs).toEqual(["운송 실적"]);
    expect(currentFactAssessment(g).asIs.outputs).toEqual([]);
  });
  it("keeps a calendar cycle stated only in the description even when extraction skips it", () => {
    const g = resolveCurrentFacts({ ...request, description: "매주 금요일 가격을 확인해 Excel에 입력한다." }, { facts: [], conflicts: [] });
    expect(currentFactAssessment(g).asIs.trigger).toBe("매주 금요일");
    expect(resolveCurrentFacts({ ...request, description: "가격을 확인해 Excel에 입력한다." }, { facts: [], conflicts: [] }).facts.some(fact => fact.field === "cycle")).toBe(false);
  });
  it("retains explicit structured facts even when extraction omits them, including output order", () => {
    const outputs = "정산.csv (컬럼: 차량번호, 운송일자, 금액; 타입: 금액 숫자)";
    const g = resolveCurrentFacts({ ...request, details: { cycle: "매월 말일", outputs, humanSteps: "최종 정산 승인", systems: "Excel, 사내 시스템" } }, { facts: [], conflicts: [] });
    const result = currentFactAssessment(g);
    expect(result.asIs.purpose).toBe(request.name);
    expect(result.asIs.trigger).toBe("매월 말일");
    expect(result.asIs.outputs).toEqual([outputs]);
    expect(result.asIs.humanDecisions).toEqual(["최종 정산 승인"]);
  });
  it.each([
    ["수동 조회 후 Excel에 입력하고 담당자가 확인한다", "수동 조회"],
    ["가격은 API로 자동 수집하고 담당자가 확인한다", "API로 자동 수집"],
    ["현재 자동 작업이 매일 실행하며 실패 시 담당자가 확인한다", "자동 작업이 매일 실행"],
  ])("preserves actual manual/partial/automated operations: %s", (description, quote) => {
    const g = resolveCurrentFacts({ ...request, description }, { facts: [{ field: "steps", source: "description", quote }], conflicts: [] });
    expect(currentFactAssessment(g).asIs.steps).toEqual([quote]);
  });
  it("drops a title, missing attachment or renamed evidence instead of turning it into a current system", () => {
    for (const fact of [
      { field: "systems", source: "description", quote: "SharePoint" },
      { field: "systems", source: "attachmentSummary", quote: "Excel" },
      { field: "systems", source: "name", quote: "정산" },
      { field: "systems", source: "details.inputs", quote: "Excel" },
    ]) {
      const g = resolveCurrentFacts({ ...request, details: { inputs: "Excel" } }, { facts: [fact, extracted.facts[1]], conflicts: [] });
      expect(currentFactAssessment(g).asIs).toMatchObject({ systems: [], inputs: ["운송 실적", "Excel"] });
    }
    const conflict = { field: "cycle", left: { source: "description", quote: "매주" }, right: { source: "description", quote: "매월" } } as const;
    expect(resolveCurrentFacts(request, { facts: [], conflicts: [conflict] }).conflicts).toEqual([]);
  });
});
