import { describe, expect, it } from "vitest";
import { taskDisplayStatus } from "../src/lib/ax/policy";
import { isRegistrationUnchanged, registrationSnapshot, preserveRegistrationHistory, taskDetails, registrationContext } from "../src/lib/ax/registration";
import { axTaskSchema } from "../src/lib/ax/schema";
import type { AxTask } from "../src/lib/ax/types";
import { applyRediagnosis } from "../src/lib/ax/diagnosis-preservation";
import { buildAllInOnePrompt, detectUndeterminedOutputs, parseOutputColumns } from "../src/lib/ax/guide";
import { axTaskV2Schema } from "../src/lib/ax/schema";
import type { AxTaskV2 } from "../src/lib/ax/types";
import { diagnosisFixture, planFixture, taskFixture } from "./fixtures/ax";
import { exportAxState, importAxState, validateAxStateV2 } from "../src/lib/ax/transfer";

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

describe("출력 편집 → 저장 → 재진단", () => {
  it("입력 저장만으로 기존 진단·지시문과 사용자 기록을 변경하거나 확인 완료하지 않는다", () => {
    const previous: AxTaskV2 = {
      ...taskFixture("output-edit", structuredClone(diagnosisFixture)),
      outputs: "정산.csv",
      systems: "Excel",
      diagnosis: { ...structuredClone(diagnosisFixture), decisionPoints: [{ id: "D1", status: "확정", detail: "관리번호 기준 비교" }] },
      genericRules: [{ id: "R1", name: "담당자 확인", category: "권한·검토 기준", applicability: "적용", status: "확정", detail: "담당자가 직접 확인" }],
      reviews: [], exampleResults: [], verificationResults: [], checkConfirmations: [],
    };
    const snapshot = structuredClone(previous);
    const registration = axTaskV2Schema.parse({
      ...base, id: previous.id, outputs: "정산.csv\n컬럼: 거래일, 금액\n타입·형식: 거래일=날짜, 금액=숫자",
    });
    const edited = axTaskV2Schema.parse(preserveRegistrationHistory(previous, registration));
    expect(taskDetails(edited).outputs).toBe(registration.outputs);
    expect(edited.systems).toBeUndefined();
    expect(edited.diagnosis).toEqual(previous.diagnosis);
    expect(edited.status).toBe(previous.status);
    for (const key of ["reviews", "exampleResults", "genericRules", "verificationResults", "checkConfirmations"] as const) {
      expect(edited[key]).toEqual(previous[key]);
    }
    expect(edited.diagnosisRegistration).toEqual({ name: previous.name, description: previous.description, details: taskDetails(previous), context: registrationContext(previous) });
    expect(buildAllInOnePrompt(planFixture, "codex", { diagnosis: edited.diagnosis, genericRules: edited.genericRules, taskName: edited.diagnosisRegistration?.name, context: edited.diagnosisRegistration?.context }))
      .toBe(buildAllInOnePrompt(planFixture, "codex", { diagnosis: previous.diagnosis, genericRules: previous.genericRules, taskName: previous.name, context: registrationContext(previous) }));
    const editedAgain = preserveRegistrationHistory(edited, { ...registration, name: "다시 수정", outputs: "다른.csv" });
    expect(editedAgain.diagnosisRegistration).toEqual(edited.diagnosisRegistration);
    const savedState = { schemaVersion: 2 as const, tasks: [editedAgain], selectedTaskId: editedAgain.id, step: 1 };
    expect(validateAxStateV2(savedState).tasks[0].diagnosisRegistration).toEqual(edited.diagnosisRegistration);
    expect(importAxState(exportAxState(savedState)).tasks[0].diagnosisRegistration).toEqual(edited.diagnosisRegistration);
    expect(previous).toEqual(snapshot);
  });

  it.each<[string, string[]]>([
    ["정산.csv (컬럼: 미확정)", ["정산.csv"]],
    ["정산.csv (컬럼: 거래일, TBD)", ["정산.csv"]],
    ["정산.csv", ["정산.csv"]],
    ["정산.csv (컬럼: 거래일, 금액; 타입·형식: 거래일=날짜, 금액=숫자)", []],
  ])("재진단은 실제 출력 정보만 반영하며 미확정 컬럼을 생성하지 않는다: %s", (output, unresolved) => {
    const previous = taskFixture("output-rediagnosis", structuredClone(diagnosisFixture));
    const registration = axTaskV2Schema.parse({ ...base, id: previous.id, outputs: output });
    const edited = preserveRegistrationHistory(previous, registration);
    const incoming = structuredClone(diagnosisFixture);
    incoming.asIs.outputs = [taskDetails(edited).outputs!];
    incoming.poc.outputs = [taskDetails(edited).outputs!];
    const diagnosed = applyRediagnosis(edited, incoming, "2026-11-02T00:00:00.000Z");
    expect(diagnosed.diagnosis?.asIs.outputs).toEqual([output]);
    expect(diagnosed.diagnosis?.poc.outputs).toEqual([output]);
    expect(detectUndeterminedOutputs(diagnosed.diagnosis!.poc.outputs)).toEqual(unresolved);
    expect(edited.diagnosis).toEqual(previous.diagnosis);
    expect(edited.diagnosisRegistration).toBeDefined();
    expect(diagnosed.diagnosisRegistration).toBeUndefined();
  });

  it("확정된 컬럼 순서를 보존하고 미정 항목이 섞이면 부분 목록을 확정하지 않는다", () => {
    expect(parseOutputColumns("정산.csv (컬럼: 금액, 거래일; 형식: 확정 양식)")).toEqual(["금액", "거래일"]);
    expect(parseOutputColumns("정산.csv (컬럼: 거래일, 미확정)")).toBeNull();
    expect(parseOutputColumns("result.csv (컬럼:미확정,금액)")).toBeNull();
    expect(parseOutputColumns("result.csv （컬럼:미확정,금액）")).toBeNull();
    expect(parseOutputColumns("result.csv （컬럼:거래일,TBD）")).toBeNull();
    expect(parseOutputColumns("result.csv （컬럼:거래일,금액）")).toEqual(["거래일", "금액"]);
    expect(detectUndeterminedOutputs(["result.csv (컬럼:미확정,금액)", "result.csv （컬럼:미확정,금액）"])).toEqual(["result.csv"]);
  });
});
