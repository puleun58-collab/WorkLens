import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AX_DB_NAME, deleteAxQuestionFile, deleteAxQuestionFiles, loadAxQuestionFile,
  loadAxState, saveAxQuestionFile,
} from "@/client/ax-store";
import { emptyAxState } from "@/lib/ax/types";

type Key = string | Key[];
type Request = { result: unknown; onsuccess: null | (() => void) };
let records: Map<string, unknown>;
let failure: "quota" | "abort" | undefined;
let holdCommit: boolean;
let commit: (() => void) | undefined;
let opens: Array<[string, number]>;
let requestSucceeded: (() => void) | undefined;

// IDB key order for the string/array keys used by this store, including prefix bounds.
function compareKeys(left: Key, right: Key): number {
  if (typeof left === "string" && typeof right === "string") return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === "string") return -1;
  if (typeof right === "string") return 1;
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const result = compareKeys(left[i], right[i]);
    if (result) return result;
  }
  return left.length - right.length;
}

beforeEach(() => {
  records = new Map(); failure = undefined; holdCommit = false; commit = undefined; opens = []; requestSucceeded = undefined;
  vi.stubGlobal("IDBKeyRange", {
    bound(lower: Key, upper: Key, lowerOpen: boolean, upperOpen: boolean) {
      return { includes(key: Key) {
        const low = compareKeys(key, lower), high = compareKeys(key, upper);
        return (lowerOpen ? low > 0 : low >= 0) && (upperOpen ? high < 0 : high <= 0);
      } };
    },
  });
  vi.stubGlobal("indexedDB", {
    open(name: string, version: number) {
      opens.push([name, version]);
      const opened = {
        result: {
          close: vi.fn(), onversionchange: null,
          transaction(store: string, mode: string) {
            expect(store).toBe("state");
            const staged = new Map(records);
            let pending = 0, ended = false;
            const tx = {
              oncomplete: null as null | (() => void), onerror: null as null | (() => void), onabort: null as null | (() => void),
              error: null as DOMException | null,
              abort() {
                if (ended) return;
                ended = true;
                tx.error = new DOMException("Transaction aborted", "AbortError");
                queueMicrotask(() => tx.onabort?.());
              },
              objectStore() {
                function enqueue(action: (request: Request) => void, request: Request = { result: undefined, onsuccess: null }): Request {
                  pending++;
                  queueMicrotask(() => {
                    if (ended) return;
                    action(request);
                    if (ended) return;
                    request.onsuccess?.();
                    requestSucceeded?.();
                    if (failure === "abort") { tx.abort(); return; }
                    pending--;
                    if (pending === 0) {
                      commit = () => {
                        if (ended || pending !== 0) return;
                        ended = true;
                        if (mode === "readwrite") records = staged;
                        tx.oncomplete?.();
                      };
                      if (!holdCommit) queueMicrotask(() => commit?.());
                    }
                  });
                  return request;
                }
                return {
                  get(key: Key) { return enqueue(request => { request.result = staged.get(JSON.stringify(key)); }); },
                  put(value: unknown, key: Key) {
                    if (failure === "quota") throw new DOMException("Storage full", "QuotaExceededError");
                    return enqueue(request => { staged.set(JSON.stringify(key), value); request.result = key; });
                  },
                  delete(key: Key) { return enqueue(() => { staged.delete(JSON.stringify(key)); }); },
                  openKeyCursor(range: { includes(key: Key): boolean }) {
                    const keys = [...staged.keys()].map(key => JSON.parse(key) as Key).filter(key => range.includes(key)).sort(compareKeys);
                    let index = 0;
                    const request: Request = { result: undefined, onsuccess: null };
                    function advance() {
                      enqueue(current => {
                        const key = keys[index++];
                        current.result = key === undefined ? null : { primaryKey: key, continue: advance };
                      }, request);
                    }
                    advance();
                    return request;
                  },
                };
              },
            };
            return tx;
          },
        },
        onsuccess: null as null | (() => void),
      };
      queueMicrotask(() => opened.onsuccess?.());
      return opened;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("local-only question file records", () => {
  it("restores Blob contents on a new connection without changing the DB version or current state", async () => {
    const state = emptyAxState();
    records.set(JSON.stringify("current"), state);
    await saveAxQuestionFile("task", "response", "fp", new Blob(["actual document text"], { type: "text/plain" }));
    const restored = await loadAxQuestionFile("task", "response", "fp");
    expect(await restored?.text()).toBe("actual document text");
    expect(restored?.type).toBe("text/plain");
    expect((await loadAxState()).state).toEqual(state);
    expect(opens.length).toBe(3);
    expect(opens.every(([name, version]) => name === AX_DB_NAME && version === 1)).toBe(true);
    expect(records.get(JSON.stringify("current"))).toEqual(state);
    expect(records.has(JSON.stringify(["question-file", "task", "response", "fp"]))).toBe(true);
  });

  it("isolates task, response and fingerprint and deletes only the exact file", async () => {
    const keys: Array<[string, string, string]> = [["a", "q", "f"], ["b", "q", "f"], ["a", "r", "f"], ["a", "q", "g"]];
    for (const [i, key] of keys.entries()) await saveAxQuestionFile(...key, new Blob([String(i)]));
    await deleteAxQuestionFile(...keys[0]);
    expect(await loadAxQuestionFile(...keys[0])).toBeUndefined();
    for (let i = 1; i < keys.length; i++) expect(await (await loadAxQuestionFile(...keys[i]))?.text()).toBe(String(i));
    expect(await loadAxQuestionFile("missing", "q", "f")).toBeUndefined();
  });

  it("cleans exact task prefixes or all question files but never current or unrelated keys", async () => {
    const state = emptyAxState();
    records.set(JSON.stringify("current"), state);
    records.set(JSON.stringify(["other", "a"]), "unrelated");
    for (const task of ["", "a", "ab", "b"]) await saveAxQuestionFile(task, "q", "f", new Blob([task]));
    await deleteAxQuestionFiles("a");
    expect(await loadAxQuestionFile("a", "q", "f")).toBeUndefined();
    expect(await (await loadAxQuestionFile("ab", "q", "f"))?.text()).toBe("ab");
    await deleteAxQuestionFiles("");
    expect(await loadAxQuestionFile("", "q", "f")).toBeUndefined();
    await deleteAxQuestionFiles();
    expect([...records.keys()].sort()).toEqual([JSON.stringify("current"), JSON.stringify(["other", "a"])].sort());
    expect(records.get(JSON.stringify("current"))).toEqual(state);
  });

  it("does not resolve writes on request success before transaction commit", async () => {
    holdCommit = true;
    const gate = Promise.withResolvers<void>();
    requestSucceeded = gate.resolve;
    let resolved = false;
    const saved = saveAxQuestionFile("a", "q", "f", new Blob(["text"])).then(() => { resolved = true; });
    await gate.promise;
    expect(resolved).toBe(false);
    expect(records.size).toBe(0);
    commit!();
    await saved;
    expect(resolved).toBe(true);
    expect(records.size).toBe(1);
  });

  it("rejects quota failures and keeps the prior Blob and current record", async () => {
    await saveAxQuestionFile("a", "q", "f", new Blob(["original"]));
    records.set(JSON.stringify("current"), emptyAxState());
    const before = new Map(records);
    failure = "quota";
    await expect(saveAxQuestionFile("a", "q", "f", new Blob(["replacement"]))).rejects.toThrow();
    expect(records).toEqual(before);
  });

  it("rejects transaction aborts after request success and rolls back writes and deletions", async () => {
    await saveAxQuestionFile("a", "q", "f", new Blob(["original"]));
    records.set(JSON.stringify("current"), emptyAxState());
    const before = new Map(records);
    failure = "abort";
    await expect(saveAxQuestionFile("a", "q", "f", new Blob(["replacement"]))).rejects.toThrow();
    await expect(loadAxQuestionFile("a", "q", "f")).rejects.toThrow();
    await expect(deleteAxQuestionFile("a", "q", "f")).rejects.toThrow();
    await expect(deleteAxQuestionFiles("a")).rejects.toThrow();
    expect(records).toEqual(before);
  });
});
