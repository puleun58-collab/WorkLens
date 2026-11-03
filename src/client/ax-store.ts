import { migrateAxState, validateAxStateV2 } from "@/lib/ax/transfer";
import { emptyAxState, type AxStateV2 } from "@/lib/ax/types";
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
export function restoreAxRecord(record: unknown): { state: AxStateV2; protection: "writable" | "invalid"; revision?: string; notice?: string } {
  if (record === undefined) return { state: emptyAxState(), protection: "writable" };
  // v1 기록은 메모리에서만 v2로 변환한다. 저장 원본은 덮어쓰지 않으며,
  // revision은 원본 기록 기준으로 유지해 저장 충돌 보호가 그대로 동작한다.
  try { return { state: migrateAxState(record), protection: "writable", revision: JSON.stringify(record) }; }
  catch { return { state: emptyAxState(), protection: "invalid", notice: "저장된 AI•AX 데이터가 손상되었거나 지원하지 않는 버전입니다. 원본을 보존하고 자동 저장을 중단했습니다. 화면 작업은 내보내기로 보관하고, 초기화 또는 가져오기를 확인하면 저장을 다시 시작할 수 있습니다." }; }
}
export async function loadAxState() { return restoreAxRecord(await transaction("readonly", store => store.get(KEY))); }

// Question originals are local-only Blob records, never part of the JSON state/export.
function questionFileKey(taskId: string, responseId: string, fingerprint: string): IDBValidKey {
  return ["question-file", taskId, responseId, fingerprint];
}
export async function saveAxQuestionFile(taskId: string, responseId: string, fingerprint: string, file: Blob): Promise<void> {
  await transaction("readwrite", store => store.put(file, questionFileKey(taskId, responseId, fingerprint)));
}
export async function loadAxQuestionFile(taskId: string, responseId: string, fingerprint: string): Promise<Blob | undefined> {
  return transaction("readonly", store => store.get(questionFileKey(taskId, responseId, fingerprint)));
}
export async function deleteAxQuestionFile(taskId: string, responseId: string, fingerprint: string): Promise<void> {
  await transaction("readwrite", store => store.delete(questionFileKey(taskId, responseId, fingerprint)));
}
export async function deleteAxQuestionFiles(taskId?: string): Promise<void> {
  const prefix = taskId === undefined ? ["question-file"] : ["question-file", taskId];
  // Array keys sort after string keys: this range covers only this exact prefix.
  const range = IDBKeyRange.bound(prefix, [...prefix, []], false, true);
  const db = await openDb();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let tx: IDBTransaction | undefined;
  let failure: unknown;
  try {
    const active = db.transaction(STORE, "readwrite");
    tx = active;
    active.oncomplete = () => { db.close(); resolve(); };
    active.onerror = active.onabort = () => { db.close(); reject(failure ?? active.error ?? new Error("브라우저 저장에 실패했습니다.")); };
    const store = active.objectStore(STORE);
    const request = store.openKeyCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      try {
        store.delete(cursor.primaryKey);
        cursor.continue();
      } catch (error) {
        failure = error;
        active.abort();
      }
    };
  } catch (error) {
    if (tx) { failure = error; tx.abort(); }
    else { db.close(); reject(error); }
  }
  return promise;
}
async function writeAxRecord(record: AxStateV2 | undefined, expected: string | undefined, explicit: boolean): Promise<string | undefined> {
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
export async function saveAxState(state: AxStateV2, expected: string | undefined, explicit = false): Promise<string | undefined> {
  // IndexedDB에는 v2 스키마로 검증된 데이터만 저장한다.
  return writeAxRecord(validateAxStateV2(state), expected, explicit);
}
export async function clearAxState(expected: string | undefined, explicit = false): Promise<undefined> {
  await writeAxRecord(undefined, expected, explicit);
}
