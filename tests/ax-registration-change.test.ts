import { describe, expect, it } from "vitest";
import { taskDisplayStatus } from "../src/lib/ax/policy";
import { isRegistrationUnchanged, registrationSnapshot } from "../src/lib/ax/registration";
import { axTaskSchema } from "../src/lib/ax/schema";
import type { AxTask } from "../src/lib/ax/types";

const base: AxTask = {
  id: "task-1", name: "월간 정산", description: "매월 정산", cycle: "매월", minutesPerRun: 240,
  status: "registered", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
};

function parseEdit(task: AxTask): AxTask {
  return axTaskSchema.parse({ ...task, createdAt: task.createdAt });
}

describe("isRegistrationUnchanged", () => {
  it("treats a no-change edit as unchanged and preserves identity of the parsed object", () => {
    expect(isRegistrationUnchanged(base, parseEdit(base))).toBe(true);
  });
  it("treats whitespace-only differences as unchanged", () => {
    expect(isRegistrationUnchanged(base, parseEdit({ ...base, name: "  월간 정산  ", description: "매월 정산\n" }))).toBe(true);
  });
  it("treats equal numeric values as unchanged regardless of numeric type", () => {
    expect(isRegistrationUnchanged(base, parseEdit({ ...base, minutesPerRun: 240 }))).toBe(true);
  });
  it("detects real content changes", () => {
    expect(isRegistrationUnchanged(base, parseEdit({ ...base, description: "주간 정산" }))).toBe(false);
    expect(isRegistrationUnchanged(base, parseEdit({ ...base, name: "주간 정산" }))).toBe(false);
    expect(isRegistrationUnchanged(base, parseEdit({ ...base, minutesPerRun: 120 }))).toBe(false);
    expect(isRegistrationUnchanged(base, parseEdit({ ...base, cycle: "매주" }))).toBe(false);
  });
  it("detects attachment changes but ignores timestamps", () => {
    const meta = { name: "a.pdf", type: "application/pdf", size: 10, lastModified: 1, fingerprint: "a".repeat(64) };
    const withFile: AxTask = { ...base, attachmentMeta: meta };
    expect(isRegistrationUnchanged(withFile, parseEdit({ ...base, attachmentMeta: meta, updatedAt: "2026-02-02T00:00:00.000Z" }))).toBe(true);
    expect(isRegistrationUnchanged(withFile, parseEdit({ ...base, attachmentMeta: { ...meta, name: "b.pdf" } }))).toBe(false);
    expect(isRegistrationUnchanged(withFile, parseEdit({ ...base }))).toBe(false);
  });
  it("preserves legacy fields through the snapshot", () => {
    const legacy: AxTask = { ...base, people: 3, painPoints: "병목", goal: "목표" };
    expect(isRegistrationUnchanged(legacy, parseEdit(legacy))).toBe(true);
    expect(isRegistrationUnchanged(legacy, parseEdit({ ...legacy, people: 4 }))).toBe(false);
  });
  it("produces stable snapshots for semantically equal inputs", () => {
    expect(registrationSnapshot(parseEdit(base))).toBe(registrationSnapshot(parseEdit({ ...base })));
  });
});

describe("taskDisplayStatus", () => {
  const diagnosis = (sufficiency: "sufficient" | "needs-check") => ({ ...baseDiagnosis(sufficiency) });
  function baseDiagnosis(sufficiency: "sufficient" | "needs-check"): NonNullable<AxTask["diagnosis"]> {
    return {
      factors: [{ key: "repetition", aiValue: 3, rationale: "" }], informationSufficiency: sufficiency,
      sourceNote: "", followUpQuestions: [], stepAssessments: [],
      nextAction: { label: "", detail: "" }, humanInLoop: [], prerequisites: [], fallback: [],
      technicalChecks: [], operation: [], decisionGate: { verdict: "go", reasons: [] },
      asIs: "", toBe: "",
    } as unknown as NonNullable<AxTask["diagnosis"]>;
  }
  it("flags adjusted + needs-check without changing the primary status", () => {
    const r = taskDisplayStatus({ ...base, status: "adjusted", diagnosis: diagnosis("needs-check") });
    expect(r).toEqual({ status: "adjusted", needsCheck: true });
  });
  it("keeps adjusted alone without the flag", () => {
    const r = taskDisplayStatus({ ...base, status: "adjusted", diagnosis: diagnosis("sufficient") });
    expect(r).toEqual({ status: "adjusted", needsCheck: false });
  });
  it("never flags non-adjusted tasks", () => {
    expect(taskDisplayStatus({ ...base, status: "needs-info", diagnosis: diagnosis("needs-check") }).needsCheck).toBe(false);
    expect(taskDisplayStatus({ ...base, status: "registered" }).needsCheck).toBe(false);
  });
});
