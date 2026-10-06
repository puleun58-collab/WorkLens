import { describe, expect, it } from "vitest";
import { axes, diagnosisHasAdjustment, factorEffectiveValue, factorHasAdjustment, taskStatus } from "@/lib/ax/policy";
import { axTaskSchema } from "@/lib/ax/schema";
import { exportAxState, importAxState, validateAxState } from "@/lib/ax/transfer";
import type { AxState, AxTask } from "@/lib/ax/types";
import { diagnosisFixture, planFixture, taskFixture } from "./fixtures/ax";

describe("AX factor adjustment normalization", () => {
  it("only treats a value different from AI as an adjustment and resets back to diagnosed", () => {
    const d = structuredClone(diagnosisFixture), factor = d.factors[0];
    expect(factor.aiValue).toBe(4);
    factor.finalValue = 4;
    expect(factorEffectiveValue(factor)).toBe(4);
    expect(factorHasAdjustment(factor)).toBe(false);
    expect(diagnosisHasAdjustment(d)).toBe(false);
    expect(taskStatus(d)).toBe("diagnosed");
    factor.finalValue = 2;
    expect(factorEffectiveValue(factor)).toBe(2);
    expect(factorHasAdjustment(factor)).toBe(true);
    expect(diagnosisHasAdjustment(d)).toBe(true);
    expect(taskStatus(d)).toBe("adjusted");
    factor.finalValue = undefined;
    expect(factorEffectiveValue(factor)).toBe(4);
    expect(factorHasAdjustment(factor)).toBe(false);
    expect(diagnosisHasAdjustment(d)).toBe(false);
    expect(taskStatus(d)).toBe("diagnosed");
  });

  it("keeps axes unchanged for equal values and applies different effective values", () => {
    const d = structuredClone(diagnosisFixture), before = axes(d);
    d.factors[0].finalValue = d.factors[0].aiValue;
    expect(axes(d)).toEqual(before);
    d.factors[0].finalValue = 2;
    expect(axes(d)).toEqual({ ...before, value: 3 });
    expect(axes(d)).not.toEqual(before);
  });

  it.each(["sufficient", "needs-check"] as const)("loads and transfers legacy equal-value adjusted tasks with %s information", informationSufficiency => {
    const d = structuredClone(diagnosisFixture);
    d.informationSufficiency = informationSufficiency;
    d.factors[0].finalValue = d.factors[0].aiValue;
    d.planCodex = structuredClone(planFixture);
    d.planClaude = structuredClone(planFixture);
    const task = { ...taskFixture("legacy", d), status: "adjusted" } as AxTask;
    const state: AxState = { schemaVersion: 1, tasks: [task], selectedTaskId: task.id, step: 1 };
    const before = structuredClone(state);
    const expected = informationSufficiency === "needs-check" ? "needs-info" : "diagnosed";
    const normalized = validateAxState(state);
    expect(normalized).toEqual({ ...before, tasks: [{ ...before.tasks[0], status: expected }] });
    expect(state).toEqual(before);
    expect(importAxState(exportAxState(state))).toEqual(normalized);
    // Import an unnormalized legacy envelope as well as the normalized export.
    expect(importAxState(JSON.stringify({ format: "worklens-ax", schemaVersion: 1, exportedAt: "2026-10-04T00:00:00.000Z", data: state }))).toEqual(normalized);
  });

  it("accepts diagnosed equal-value tasks and requires adjusted status for real adjustments", () => {
    const d = structuredClone(diagnosisFixture);
    d.factors[0].finalValue = d.factors[0].aiValue;
    const task = taskFixture("schema", d);
    expect(axTaskSchema.parse(task)).toEqual(task);
    expect(() => axTaskSchema.parse({ ...task, status: "registered" })).toThrow();
    d.factors[1].finalValue = 2;
    expect(() => axTaskSchema.parse(task)).toThrow();
    const adjusted = { ...task, status: "adjusted" } as AxTask;
    expect(axTaskSchema.parse(adjusted)).toEqual(adjusted);
    expect(validateAxState({ schemaVersion: 1, tasks: [adjusted], selectedTaskId: task.id, step: 1 }).tasks[0]).toEqual(adjusted);
    expect(() => axTaskSchema.parse({ ...taskFixture(), status: "adjusted" })).toThrow();
    expect(() => axTaskSchema.parse({ ...taskFixture("no-correction", structuredClone(diagnosisFixture)), status: "adjusted" })).toThrow();
    expect(taskStatus()).toBe("registered");
  });
});
