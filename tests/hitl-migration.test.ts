import { describe, expect, it } from "vitest";
import { migrateV1ToV2 } from "@/lib/ax/schema";
import { exportAxState, importAxState, migrateAxState, toAxStateV2, validateAxState, validateAxStateV2 } from "@/lib/ax/transfer";
import { restoreAxRecord } from "@/client/ax-store";
import { emptyAxState, type AxStateV2, type HitlReview } from "@/lib/ax/types";
import { diagnosisFixture, planFixture, taskFixture } from "./fixtures/ax";

const v1State = (tasks: ReturnType<typeof taskFixture>[] = []) => validateAxState({ schemaVersion: 1, tasks, selectedTaskId: tasks[0]?.id ?? null, step: 1 });
const reviewFixture = (overrides: Partial<HitlReview> = {}): HitlReview => ({
  id: "review-1",
  target: { type: "step", key: "k".repeat(16), source: "diagnosis", sourceText: "원본 단계 내용", sourceHash: "a".repeat(64) },
  action: "keep",
  status: "confirmed",
  comment: "AI 판단 유지",
  reviewedAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
  ...overrides,
});

describe("HITL v1 → v2 migration", () => {
  it("migrates empty v1 data without fabricating reviews", () => {
    const v1 = v1State();
    const before = structuredClone(v1);
    const v2 = migrateV1ToV2(v1);
    expect(v2.schemaVersion).toBe(2);
    expect(v2.tasks).toEqual([]);
    expect(v2.selectedTaskId).toBeNull();
    expect(v2.step).toBe(1);
    expect(v1).toEqual(before);
  });
  it("migrates tasks with empty reviews and preserves all v1 fields", () => {
    const v1 = v1State([taskFixture("a"), taskFixture("b", { ...diagnosisFixture, planCodex: planFixture, planClaude: planFixture })]);
    const v2 = migrateV1ToV2(v1);
    expect(v2.tasks).toHaveLength(2);
    for (const task of v2.tasks) expect(task.reviews).toEqual([]);
    expect(v2.tasks[0]).toMatchObject({ id: "a", name: "업무 a", status: "registered" });
    expect(v2.tasks[1].diagnosis?.planCodex).toBeDefined();
    expect(v2.tasks[1].diagnosis?.planClaude).toBeDefined();
    expect(v2.selectedTaskId).toBe("a");
  });
  it("does not mutate the v1 input", () => {
    const v1 = v1State([taskFixture("a", diagnosisFixture)]);
    const before = structuredClone(v1);
    migrateV1ToV2(v1);
    expect(v1).toEqual(before);
    expect(v1.tasks[0]).not.toHaveProperty("reviews");
  });
});

describe("HITL transfer compatibility", () => {
  it("imports a legacy v1 envelope by migrating to v2", () => {
    const v1 = v1State([taskFixture("a", diagnosisFixture)]);
    const json = JSON.stringify({ format: "worklens-ax", schemaVersion: 1, exportedAt: "2026-10-04T00:00:00.000Z", data: v1 });
    const imported = importAxState(json);
    expect(imported.schemaVersion).toBe(2);
    expect(imported.tasks[0].reviews).toEqual([]);
    expect(imported.tasks[0].diagnosis).toEqual(v1.tasks[0].diagnosis);
  });
  it("exports v2 envelopes for both v1 and v2 input", () => {
    const fromV1 = JSON.parse(exportAxState(v1State([taskFixture("a")])));
    expect(fromV1.schemaVersion).toBe(2);
    expect(fromV1.data.schemaVersion).toBe(2);
    const v2: AxStateV2 = { ...emptyAxState(), tasks: [{ ...taskFixture("a"), reviews: [reviewFixture()] }], selectedTaskId: "a" };
    const fromV2 = JSON.parse(exportAxState(v2));
    expect(fromV2.schemaVersion).toBe(2);
    expect(fromV2.data.tasks[0].reviews).toHaveLength(1);
  });
  it("round trips v2 data including reviews", () => {
    const v2: AxStateV2 = { ...emptyAxState(), tasks: [{ ...taskFixture("a", diagnosisFixture), reviews: [reviewFixture()] }], selectedTaskId: "a", step: 2 };
    const restored = importAxState(exportAxState(v2));
    expect(restored).toEqual(v2);
    expect(restored.tasks[0].reviews?.[0]).toMatchObject({ action: "keep", status: "confirmed" });
  });
  it("rejects malformed JSON, wrong format and unsupported versions", () => {
    expect(() => importAxState("{bad")).toThrow("올바른 JSON 파일이 아닙니다.");
    expect(() => importAxState(JSON.stringify({ format: "other" }))).toThrow("WorkLens AI•AX 내보내기 파일이 아닙니다.");
    for (const schemaVersion of [3, 99]) {
      expect(() => importAxState(JSON.stringify({ format: "worklens-ax", schemaVersion, exportedAt: "2026-10-04T00:00:00.000Z", data: {} }))).toThrow("지원하지 않는 AI•AX 데이터 버전입니다.");
    }
    expect(() => importAxState(JSON.stringify({ format: "worklens-ax", exportedAt: "2026-10-04T00:00:00.000Z", data: {} }))).toThrow("지원하지 않는 AI•AX 데이터 버전입니다.");
    const broken = JSON.parse(exportAxState(emptyAxState()));
    broken.data.tasks = [{ id: "bad" }];
    expect(() => importAxState(JSON.stringify(broken))).toThrow();
  });
  it("migrateAxState validates v2 directly and rejects unknown versions", () => {
    const v2 = validateAxStateV2({ ...emptyAxState(), tasks: [{ ...taskFixture("a"), reviews: [] }] });
    expect(migrateAxState(v2)).toEqual(v2);
    expect(() => migrateAxState({ schemaVersion: 3 })).toThrow("지원하지 않는 AI•AX 데이터 버전입니다.");
    expect(() => migrateAxState(null)).toThrow("지원하지 않는 AI•AX 데이터 버전입니다.");
    expect(() => migrateAxState({ schemaVersion: 2, tasks: [{ id: "bad" }], selectedTaskId: null, step: 1 })).toThrow();
  });
  it("toAxStateV2 normalizes v1 input and passes v2 through", () => {
    const v1 = v1State([taskFixture("a")]);
    const converted = toAxStateV2(v1);
    expect(converted.schemaVersion).toBe(2);
    expect(converted.tasks[0].reviews).toEqual([]);
    const v2 = validateAxStateV2({ ...emptyAxState(), tasks: [{ ...taskFixture("a"), reviews: [reviewFixture()] }] });
    expect(toAxStateV2(v2)).toEqual(v2);
  });
});

describe("HITL IndexedDB restore boundary", () => {
  it("returns empty v2 state for absent records", () => {
    expect(restoreAxRecord(undefined)).toEqual({ state: emptyAxState(), protection: "writable" });
    expect(emptyAxState().schemaVersion).toBe(2);
  });
  it("migrates stored v1 records in memory without overwriting the original", () => {
    const v1record = v1State([taskFixture("a", diagnosisFixture)]);
    const raw = JSON.parse(JSON.stringify(v1record));
    const result = restoreAxRecord(raw);
    expect(result.protection).toBe("writable");
    expect(result.state.schemaVersion).toBe(2);
    expect(result.state.tasks[0].reviews).toEqual([]);
    // revision은 원본 기록 기준이므로 다음 저장 시 충돌 보호가 그대로 동작한다.
    expect(result.revision).toBe(JSON.stringify(raw));
    expect(raw.tasks[0]).not.toHaveProperty("reviews");
  });
  it("restores stored v2 records including reviews", () => {
    const record = { ...emptyAxState(), tasks: [{ ...taskFixture("a"), reviews: [reviewFixture()] }], selectedTaskId: "a" };
    const result = restoreAxRecord(record);
    expect(result.protection).toBe("writable");
    expect(result.state.tasks[0].reviews).toHaveLength(1);
  });
  it("preserves corrupt originals without crashing", () => {
    for (const record of [null, {}, { schemaVersion: 2 }, { schemaVersion: 1, tasks: [{ id: "bad" }], selectedTaskId: null, step: 1 }, { schemaVersion: 99 }]) {
      const restored = restoreAxRecord(record);
      expect(restored.state).toEqual(emptyAxState());
      expect(restored.protection).toBe("invalid");
      expect(restored.notice).toBeTruthy();
      expect(restored.revision).toBeUndefined();
    }
  });
});
