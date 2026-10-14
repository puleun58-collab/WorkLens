import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAxState, type AxStateV2 } from "@/lib/ax/types";
import { exportAxState } from "@/lib/ax/transfer";
import type * as AxStore from "@/client/ax-store";

const harness = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, effects: [] as Array<() => void | (() => void)>,
  load: vi.fn(), save: vi.fn(), clear: vi.fn(), channel: undefined as undefined | { onmessage: ((event: { data: unknown }) => void) | null },
}));
vi.mock("react", () => ({
  useState(initial: unknown) {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = typeof initial === "function" ? initial() : initial;
    return [harness.slots[index], (value: unknown) => { harness.slots[index] = typeof value === "function" ? value(harness.slots[index]) : value; }];
  },
  useRef(initial: unknown) {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { current: initial };
    return harness.slots[index];
  },
  useEffect(effect: () => void | (() => void)) {
    const index = harness.cursor++;
    if (!(index in harness.slots)) { harness.slots[index] = true; harness.effects.push(effect); }
  },
}));
vi.mock("@/client/ax-store", async importOriginal => {
  const actual = await importOriginal<typeof AxStore>();
  return { ...actual, loadAxState: harness.load, saveAxState: harness.save, clearAxState: harness.clear };
});
import { AxStorageConflictError, restoreAxRecord } from "@/client/ax-store";
import { useAxState } from "@/client/use-ax-state";
// This harness drives mocked React primitives outside a React component tree.
const runAxStateHarness = useAxState;

let cleanup: (() => void) | undefined;
let record: unknown;
function render() { harness.cursor = 0; return runAxStateHarness(); }
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
async function mount() {
  render();
  cleanup = harness.effects[0]() ?? undefined;
  await settle();
  return render();
}
beforeEach(() => {
  vi.useFakeTimers();
  harness.slots = []; harness.cursor = 0; harness.effects = []; harness.channel = undefined; cleanup = undefined; record = undefined;
  harness.load.mockReset().mockImplementation(async () => restoreAxRecord(record));
  harness.save.mockReset().mockImplementation(async (state: AxStateV2, expected: string | undefined, explicit: boolean) => {
    if (!explicit && JSON.stringify(record) !== expected) throw new AxStorageConflictError();
    record = structuredClone(state); return JSON.stringify(record);
  });
  harness.clear.mockReset().mockImplementation(async (expected: string | undefined, explicit: boolean) => {
    if (!explicit && JSON.stringify(record) !== expected) throw new AxStorageConflictError();
    record = undefined;
  });
  vi.stubGlobal("BroadcastChannel", class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor() { harness.channel = this; }
    postMessage = vi.fn(); close = vi.fn();
  });
});
afterEach(async () => { cleanup?.(); await settle(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("AX hook storage protection", () => {
  it.each([null, { schemaVersion: 999 }, { broken: true }])("preserves invalid original through editing and pending unmount: %j", async original => {
    record = structuredClone(original);
    let hook = await mount();
    expect(hook.storageProtection).toBe("invalid");
    hook.update({ ...hook.state, step: 2 });
    await vi.advanceTimersByTimeAsync(300);
    hook = render(); hook.update({ ...hook.state, step: 3 }); cleanup?.(); cleanup = undefined;
    await settle();
    expect(record).toEqual(original); expect(harness.save).not.toHaveBeenCalled();
    expect(JSON.parse(exportAxState(render().state)).data.step).toBe(3);
  });
  it("allows only explicit import/reset to unlock a preserved original", async () => {
    record = { schemaVersion: 999 };
    let hook = await mount();
    const imported = { ...emptyAxState(), step: 2 };
    expect(await hook.replace(imported)).toBe(true);
    hook = render(); expect(hook.storageProtection).toBe("writable"); expect(hook.loadNotice).toBe("");
    hook.update({ ...imported, step: 3 }); await vi.advanceTimersByTimeAsync(300);
    expect(record).toEqual({ ...imported, step: 3 });
    expect(await render().replace(emptyAxState(), true)).toBe(true); expect(record).toBeUndefined();
  });
  it("keeps local editing and export available after unavailable storage without automatic writes", async () => {
    record = { preserved: true }; harness.load.mockRejectedValue(new Error("unavailable"));
    let hook = await mount(); expect(hook.storageProtection).toBe("unavailable");
    hook.update({ ...emptyAxState(), step: 4 }); await vi.advanceTimersByTimeAsync(300);
    hook = render(); expect(JSON.parse(exportAxState(hook.state)).data.step).toBe(4);
    expect(harness.save).not.toHaveBeenCalled(); expect(record).toEqual({ preserved: true });
  });
  it("does not report successful reset when deletion fails and stays blocked", async () => {
    record = emptyAxState(); await mount(); harness.clear.mockRejectedValue(new Error("failed"));
    expect(await render().replace(emptyAxState(), true)).toBe(false);
    let hook = render(); expect(hook.saveStatus).toBe("저장 실패"); expect(hook.storageProtection).toBe("unavailable");
    hook.update({ ...hook.state, step: 2 }); await vi.advanceTimersByTimeAsync(300);
    hook = render(); expect(hook.saveStatus).not.toBe("이 브라우저에 저장됨"); expect(harness.save).not.toHaveBeenCalled(); expect(record).toEqual(emptyAxState());
  });
  it("blocks autosave and pending unmount on another tab notification without losing local export", async () => {
    const hook = await mount(); hook.update({ ...hook.state, step: 2 });
    record = { ...emptyAxState(), step: 4 };
    harness.channel?.onmessage?.({ data: { type: "ax-saved", tabId: "other-tab" } });
    cleanup?.(); cleanup = undefined; await settle();
    expect(render().externalChange).toBe(true); expect(render().storageProtection).toBe("conflict");
    expect(record).toEqual({ ...emptyAxState(), step: 4 }); expect(harness.save).not.toHaveBeenCalled();
    expect(JSON.parse(exportAxState(render().state)).data.step).toBe(2);
  });
  it("blocks stale writes even without BroadcastChannel notifications", async () => {
    const hook = await mount(); record = { ...emptyAxState(), step: 4 };
    hook.update({ ...hook.state, step: 2 }); await vi.advanceTimersByTimeAsync(300);
    expect(render().storageProtection).toBe("conflict"); expect(render().externalChange).toBe(true);
    expect(record).toEqual({ ...emptyAxState(), step: 4 });
    render().update({ ...emptyAxState(), step: 3 }); await vi.advanceTimersByTimeAsync(300);
    expect(harness.save).toHaveBeenCalledTimes(1);
  });
  it("uses each own committed revision for consecutive queued saves and flushes latest on unmount", async () => {
    const hook = await mount();
    const first = { ...emptyAxState(), step: 2 }, second = { ...emptyAxState(), step: 3 }, last = { ...emptyAxState(), step: 4 };
    const gate = Promise.withResolvers<string | undefined>();
    harness.save.mockImplementationOnce(async () => { await gate.promise; record = structuredClone(first); return JSON.stringify(record); });
    hook.update(first); await vi.advanceTimersByTimeAsync(300);
    render().update(second); await vi.advanceTimersByTimeAsync(300);
    render().update(last); cleanup?.(); cleanup = undefined;
    gate.resolve(undefined); await settle();
    expect(record).toEqual(last); expect(harness.save).toHaveBeenCalledTimes(3);
    expect(harness.save.mock.calls[1][1]).toBe(JSON.stringify(first));
    expect(harness.save.mock.calls[2][1]).toBe(JSON.stringify(second));
  });
});
