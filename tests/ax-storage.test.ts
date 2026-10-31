import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxStorageConflictError, clearAxState, loadAxState, saveAxState } from "@/client/ax-store";
import { emptyAxState } from "@/lib/ax/types";
import { diagnosisFixture, taskFixture } from "./fixtures/ax";
import { deriveUnifiedRules, unifiedSavePayloads } from "@/lib/ax/rule-questions";

let record: unknown;
let failWrite: boolean;
let writes: number;
let modes: string[];
// Event-driven IDB seam: exercise the real storage API's get/compare/write and abort paths.
// Browser transaction serialization is covered by the integration owner’s multi-tab suite.
beforeEach(() => {
  record = undefined; failWrite = false; writes = 0; modes = [];
  vi.stubGlobal("indexedDB", {
    open() {
      const request = { result: {
        close: vi.fn(), onversionchange: null,
        transaction(_store: string, mode: string) {
          modes.push(mode);
          let aborted = false;
          const tx = {
            oncomplete: null as null | (() => void), onabort: null as null | (() => void), onerror: null as null | (() => void),
            abort() { aborted = true; queueMicrotask(() => tx.onabort?.()); },
            objectStore() {
              return {
                get() {
                  const read = { result: undefined as unknown, onsuccess: null as null | (() => void) };
                  queueMicrotask(() => {
                    read.result = structuredClone(record); read.onsuccess?.();
                    if (!aborted) queueMicrotask(() => tx.oncomplete?.());
                  });
                  return read;
                },
                put(value: unknown) { if (failWrite) { tx.abort(); return; } writes++; record = structuredClone(value); },
                delete() { if (failWrite) { tx.abort(); return; } writes++; record = undefined; },
              };
            },
          };
          return tx;
        },
      }, onsuccess: null as null | (() => void) };
      queueMicrotask(() => request.onsuccess?.()); return request;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("AX original-record compare and write", () => {
  it("round-trips unified pending D3 and confirmed D6 through storage validation and draft restoration", async () => {
    const points = [
      { id: "D3" as const, status: "미확정" as const, detail: "작성 중 메모" },
      { id: "D6" as const, status: "확정" as const, detail: "빈 파일은 보류" },
    ];
    const diagnosis = { ...structuredClone(diagnosisFixture), decisionPoints: points };
    const payload = unifiedSavePayloads(deriveUnifiedRules(diagnosis), []);
    const task = taskFixture("draft", { ...diagnosis, decisionPoints: payload.points });
    await saveAxState({ ...emptyAxState(), tasks: [task], selectedTaskId: task.id }, undefined);
    const restored = (await loadAxState()).state.tasks[0].diagnosis!;
    expect(restored.decisionPoints).toEqual(points);
    expect(deriveUnifiedRules(restored).filter(item => item.kind === "decision" && item.origin === "stored"))
      .toEqual(points.map(point => ({ kind: "decision", ...point, origin: "stored" })));
  });
  it("loads an absent record as writable without creating a record", async () => {
    expect(await loadAxState()).toEqual({ state: emptyAxState(), protection: "writable" });
    expect(record).toBeUndefined(); expect(writes).toBe(0);
  });
  it.each([null, { schemaVersion: 999 }, { broken: true }])("loads invalid original without mutating it: %j", async original => {
    record = original;
    expect(await loadAxState()).toMatchObject({ state: emptyAxState(), protection: "invalid" });
    expect(record).toEqual(original); expect(writes).toBe(0);
  });
  it("keeps the exact legacy record revision while restoring compatible state in memory", async () => {
    const diagnosis = structuredClone(diagnosisFixture);
    diagnosis.factors[0].finalValue = diagnosis.factors[0].aiValue;
    record = { ...emptyAxState(), tasks: [taskFixture("legacy", diagnosis)], selectedTaskId: "legacy" };
    const original = structuredClone(record);
    const loaded = await loadAxState();
    expect(loaded.protection).toBe("writable"); expect(loaded.state.tasks[0].id).toBe("legacy");
    expect(loaded.revision).toBe(JSON.stringify(original)); expect(record).toEqual(original);
    await saveAxState(loaded.state, loaded.revision);
    expect(writes).toBe(1);
  });
  it("rejects stale save and delete before touching another tab's latest record", async () => {
    const loaded = await loadAxState();
    record = { ...emptyAxState(), step: 4 };
    await expect(saveAxState({ ...emptyAxState(), step: 2 }, loaded.revision)).rejects.toBeInstanceOf(AxStorageConflictError);
    await expect(clearAxState(loaded.revision)).rejects.toBeInstanceOf(AxStorageConflictError);
    expect(record).toEqual({ ...emptyAxState(), step: 4 }); expect(writes).toBe(0);
    expect(modes).toEqual(["readonly", "readwrite", "readwrite"]);
  });
  it("accepts consecutive own save revisions and returns the new baseline", async () => {
    const first = { ...emptyAxState(), step: 2 }, last = { ...emptyAxState(), step: 4 };
    const revision = await saveAxState(first, undefined);
    expect(revision).toBe(JSON.stringify(first));
    expect(await saveAxState(last, revision)).toBe(JSON.stringify(last));
    expect(record).toEqual(last);
  });
  it("permits explicit replacement or reset of an invalid original", async () => {
    record = { schemaVersion: 999 };
    await saveAxState(emptyAxState(), undefined, true); expect(record).toEqual(emptyAxState());
    record = { broken: true };
    expect(await clearAxState(undefined, true)).toBeUndefined(); expect(record).toBeUndefined();
  });
  it("rejects failed replacement and deletion without reporting success or changing original", async () => {
    record = { schemaVersion: 999 }; failWrite = true;
    await expect(saveAxState(emptyAxState(), undefined, true)).rejects.toThrow();
    await expect(clearAxState(undefined, true)).rejects.toThrow();
    expect(record).toEqual({ schemaVersion: 999 }); expect(writes).toBe(0);
  });
});
