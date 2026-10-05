import { describe, expect, it } from "vitest";
import { axes, automationLevel, matrixPosition, priority, monthlyMinutes, bubbleArea, nextAction } from "@/lib/ax/policy";
import { exportAxState, importAxState, validateAxState } from "@/lib/ax/transfer";
import { restoreAxRecord } from "@/client/ax-store";
import { emptyAxState, type AxDiagnosis } from "@/lib/ax/types";
import { diagnosisFixture, planFixture, taskFixture } from "./fixtures/ax";
function rated(values: number[], info: AxDiagnosis["informationSufficiency"] = "sufficient"): AxDiagnosis {
  return { ...structuredClone(diagnosisFixture), informationSufficiency: info, factors: diagnosisFixture.factors.map((f, i) => ({ ...f, aiValue: values[i] })) };
}
describe("AX transparent policy", () => {
  it("rounds equal means and prefers explicit final values", () => {
    const d = rated([2, 4, 5, 1, 5, 3]);
    expect(axes(d)).toEqual({ value: 4, feasibility: 3, judgment: 5, risk: 3 });
    d.factors[0].finalValue = 5;
    expect(axes(d).value).toBe(5);
    const a = taskFixture("a", d), b = { ...a, minutesPerRun: 60, runsPerMonth: 20 };
    expect(axes(a.diagnosis!)).toEqual(axes(b.diagnosis!));
  });
  it.each([
    [[2, 2, 2, 5, 1, 1], 0], [[5, 5, 5, 5, 4, 4], 0], [[4, 4, 4, 4, 2, 2], 3],
    [[3, 3, 3, 3, 3, 5], 2], [[4, 4, 4, 4, 4, 2], 1], [[3, 3, 3, 1, 2, 2], 1],
  ])("assigns Level for %j", (values, level) => expect(automationLevel(rated(values as number[])).level).toBe(level));
  it("marks needs-check provisional and overrides only its next action", () => {
    const d = rated([4, 4, 4, 4, 2, 2], "needs-check");
    expect(automationLevel(d)).toMatchObject({ level: 3, provisional: true });
    expect(nextAction(d).label).toBe("핵심 확인사항 먼저 확인");
    expect(nextAction(rated([4, 4, 4, 4, 2, 2], "partial"))).toEqual(diagnosisFixture.nextAction);
  });
  it.each([
    [[4, 4, 4, 4, 2, 2], "quick"], [[5, 5, 1, 1, 2, 2], "strategic"],
    [[1, 4, 4, 5, 2, 2], "maybe"], [[1, 1, 1, 1, 1, 1], "hold"],
    [[5, 5, 5, 5, 2, 4], "hold"], [[5, 5, 5, 5, 5, 1], "hold"],
  ])("places region for %j", (values, region) => expect(matrixPosition(rated(values as number[])).region).toBe(region));
  it("maps axis endpoints to percentages", () => {
    expect(matrixPosition(rated([1, 1, 1, 1, 1, 1]))).toMatchObject({ x: 0, y: 0 });
    expect(matrixPosition(rated([5, 5, 5, 5, 1, 1]))).toMatchObject({ x: 100, y: 100 });
  });
  it("uses the published priority coefficients, sufficiency penalties and monthly tie break", () => {
    const a = { ...taskFixture("a", diagnosisFixture), minutesPerRun: 10, runsPerMonth: 10 };
    const b = { ...taskFixture("b", diagnosisFixture), minutesPerRun: 30, runsPerMonth: 10 };
    const c = taskFixture("c", { ...diagnosisFixture, informationSufficiency: "partial" });
    const d = taskFixture("d", { ...diagnosisFixture, informationSufficiency: "needs-check" });
    const results = priority([a, c, taskFixture("pending"), b, d]);
    expect(results.map(r => r.task.id)).toEqual(["b", "a", "c", "d"]);
    expect(results.map(r => r.score)).toEqual([9, 9, 8.5, 8]);
    expect(results[0].reason).toContain("자동화 가치 4");
  });
  it("keeps unknown effort distinct from zero and scales known bubble area proportionally", () => {
    const task = taskFixture();
    expect(monthlyMinutes(task)).toBeNull(); expect(bubbleArea(task, 100)).toBe(400);
    const known = { ...task, minutesPerRun: 5, runsPerMonth: 10 };
    expect(monthlyMinutes(known)).toBe(50); expect(bubbleArea(known, 100)).toBe(800);
    expect(bubbleArea({ ...known, minutesPerRun: 0 }, 100)).toBe(0);
  });
});
describe("AX local persistence and transfer validation", () => {
  const state = { ...emptyAxState(), tasks: [{ ...taskFixture("task-1", { ...diagnosisFixture, planCodex: planFixture }), attachmentMeta: { name: "reference.csv", type: "text/csv", size: 42, lastModified: 123, fingerprint: "a".repeat(64) } }], selectedTaskId: "task-1", step: 4 };
  it("round trips all state, attachment metadata and plans without bytes or summary", () => {
    const json = exportAxState(state);
    expect(importAxState(json)).toEqual(state); expect(restoreAxRecord(state).state).toEqual(state);
    for (const prohibited of ["bytes", "attachmentSummary", "provider", "secret"]) expect(json).not.toContain(prohibited);
    expect(() => exportAxState({ ...state, bytes: [1, 2] } as typeof state)).toThrow();
  });
  it("canonicalizes optional undefined fields for storage/export/import equality", () => {
    const canonical = validateAxState({ ...state, tasks: [{ ...state.tasks[0], diagnosis: { ...state.tasks[0].diagnosis, planClaude: undefined } }] });
    expect(canonical.tasks[0].diagnosis).not.toHaveProperty("planClaude");
    expect(importAxState(exportAxState(canonical))).toEqual(canonical);
  });
  it("handles absent, corrupt and unsupported records without crashing", () => {
    expect(restoreAxRecord(undefined)).toEqual({ state: emptyAxState() });
    for (const record of [null, {}, { schemaVersion: 2 }, { ...state, tasks: [{ id: "bad" }] }, { ...state, selectedTaskId: "missing" }]) {
      expect(restoreAxRecord(record)).toMatchObject({ state: emptyAxState(), notice: expect.stringContaining("초기화") });
    }
  });
  it("rejects JSON, format, version, required fields, unexpected payloads and inconsistent task states", () => {
    const base = JSON.parse(exportAxState(state));
    const invalid = ["{bad", JSON.stringify({ ...base, format: "other" }), JSON.stringify({ ...base, schemaVersion: 2 }), JSON.stringify({ ...base, data: {} }), JSON.stringify({ ...base, data: { ...state, tasks: [{ ...state.tasks[0], attachmentSummary: "raw" }] } }), JSON.stringify({ ...base, data: { ...state, tasks: [{ ...state.tasks[0], status: "registered" }] } })];
    for (const json of invalid) expect(() => importAxState(json)).toThrow();
    expect(() => validateAxState({ ...state, tasks: [state.tasks[0], state.tasks[0]] })).toThrow();
    expect(() => validateAxState({ ...state, step: 5 })).toThrow();
    expect(() => validateAxState({ ...state, tasks: [{ ...state.tasks[0], diagnosis: { ...diagnosisFixture, factors: Array(6).fill(diagnosisFixture.factors[0]) } }] })).toThrow();
  });
});
