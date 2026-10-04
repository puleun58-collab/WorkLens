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
export function restoreAxRecord(record: unknown): { state: AxState; notice?: string } {
  if (record === undefined) return { state: emptyAxState() };
  try { return { state: migrateAxState(record) }; }
  catch { return { state: emptyAxState(), notice: "저장된 AX 데이터가 손상되었거나 지원하지 않는 버전이어서 안전하게 초기화했습니다." }; }
}
export async function loadAxState() { return restoreAxRecord(await transaction("readonly", store => store.get(KEY))); }
export async function saveAxState(state: AxState): Promise<void> { await transaction("readwrite", store => store.put(validateAxState(state), KEY)); }
export async function clearAxState(): Promise<void> { await transaction("readwrite", store => store.delete(KEY)); }
