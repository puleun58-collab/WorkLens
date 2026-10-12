import { migrateAxState, validateAxState } from "@/lib/ax/transfer";
import { emptyAxState, type AxState } from "@/lib/ax/types";
export const AX_DB_NAME = "worklens-ax";
const STORE = "state", KEY = "current";
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(AX_DB_NAME, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
    request.onsuccess = () => { if (blocked) { request.result.close(); return; } request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(new Error("브라우저 저장소를 열지 못했습니다."));
    request.onblocked = () => { blocked = true; reject(new Error("다른 탭이 저장소 변경을 막고 있습니다.")); };
  });
}
async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let result: T;
    try {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(new Error("브라우저 저장에 실패했습니다.")); };
    } catch { db.close(); reject(new Error("브라우저 저장에 실패했습니다.")); }
  });
}
export type AxStorageProtection = "loading" | "writable" | "invalid" | "unavailable" | "conflict";
export class AxStorageConflictError extends Error {
  constructor() { super("다른 탭에서 저장된 데이터가 변경되어 자동 저장을 중단했습니다."); }
}
export function restoreAxRecord(record: unknown): { state: AxState; protection: "writable" | "invalid"; revision?: string; notice?: string } {
  if (record === undefined) return { state: emptyAxState(), protection: "writable" };
  try { return { state: migrateAxState(record), protection: "writable", revision: JSON.stringify(record) }; }
  catch { return { state: emptyAxState(), protection: "invalid", notice: "저장된 AI•AX 데이터가 손상되었거나 지원하지 않는 버전입니다. 원본을 보존하고 자동 저장을 중단했습니다. 화면 작업은 내보내기로 보관하고, 초기화 또는 가져오기를 확인하면 저장을 다시 시작할 수 있습니다." }; }
}
export async function loadAxState() { return restoreAxRecord(await transaction("readonly", store => store.get(KEY))); }
async function writeAxRecord(record: AxState | undefined, expected: string | undefined, explicit: boolean): Promise<string | undefined> {
  const db = await openDb();
  const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
  let failure: Error | undefined;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const request = store.get(KEY);
    request.onsuccess = () => {
      try {
        // Compare and write in the same transaction: another tab cannot slip a write between them.
        if (!explicit && JSON.stringify(request.result) !== expected) throw new AxStorageConflictError();
        if (record === undefined) store.delete(KEY); else store.put(record, KEY);
      } catch (error) {
        failure = error instanceof Error ? error : new Error("브라우저 저장에 실패했습니다.");
        tx.abort();
      }
    };
    tx.oncomplete = () => { db.close(); resolve(JSON.stringify(record)); };
    tx.onerror = tx.onabort = () => { db.close(); reject(failure ?? new Error("브라우저 저장에 실패했습니다.")); };
  } catch { db.close(); reject(new Error("브라우저 저장에 실패했습니다.")); }
  return promise;
}
export async function saveAxState(state: AxState, expected: string | undefined, explicit = false): Promise<string | undefined> {
  return writeAxRecord(validateAxState(state), expected, explicit);
}
export async function clearAxState(expected: string | undefined, explicit = false): Promise<undefined> {
  await writeAxRecord(undefined, expected, explicit);
}
