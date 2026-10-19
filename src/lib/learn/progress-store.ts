import type { LearnProgress } from "./types";

export const LEARN_DB_NAME = "worklens-learn";
const STORE = "progress";
const KEY = "current";
const DB_VERSION = 1;

function emptyProgress(): LearnProgress {
  return { version: 1, levels: {}, wrongAnswers: [], updatedAt: Date.now() };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(LEARN_DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(new Error("브라우저 저장소를 열지 못했습니다."));
    request.onblocked = () => { blocked = true; reject(new Error("다른 탭이 저장소 변경을 막고 있습니다.")); };
  });
}

function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let result: T;
        try {
          const tx = db.transaction(STORE, mode);
          const request = run(tx.objectStore(STORE));
          request.onsuccess = () => { result = request.result; };
          tx.oncomplete = () => { db.close(); resolve(result); };
          tx.onerror = tx.onabort = () => { db.close(); reject(new Error("브라우저 저장에 실패했습니다.")); };
        } catch {
          db.close();
          reject(new Error("브라우저 저장에 실패했습니다."));
        }
      }),
  );
}

function isValidProgress(record: unknown): record is LearnProgress {
  if (typeof record !== "object" || record === null) return false;
  const r = record as Record<string, unknown>;
  return r.version === 1 && typeof r.levels === "object" && Array.isArray(r.wrongAnswers);
}

/** 학습 진도 불러오기 — 손상 시 빈 진도로 복원 */
export async function loadLearnProgress(): Promise<LearnProgress> {
  try {
    const record = await transaction("readonly", (store) => store.get(KEY));
    if (record === undefined) return emptyProgress();
    if (isValidProgress(record)) return record;
    return emptyProgress();
  } catch {
    return emptyProgress();
  }
}

/** 학습 진도 저장 — 다른 탭과 충돌 시 에러 (AX 저장소와 동일한 보호) */
export async function saveLearnProgress(progress: LearnProgress, expected?: string): Promise<string> {
  const db = await openDb();
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let failure: Error | undefined;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const request = store.get(KEY);
    request.onsuccess = () => {
      try {
        if (expected !== undefined && JSON.stringify(request.result) !== expected) {
          throw new Error("다른 탭에서 저장된 데이터가 변경되어 자동 저장을 중단했습니다.");
        }
        const next = { ...progress, updatedAt: Date.now() };
        store.put(next, KEY);
        resolve(JSON.stringify(next));
      } catch (error) {
        failure = error instanceof Error ? error : new Error("브라우저 저장에 실패했습니다.");
        tx.abort();
      }
    };
    tx.oncomplete = () => db.close();
    tx.onerror = tx.onabort = () => { db.close(); reject(failure ?? new Error("브라우저 저장에 실패했습니다.")); };
  } catch {
    db.close();
    reject(new Error("브라우저 저장에 실패했습니다."));
  }
  return promise;
}

/**
 * 저장 정책 안내 문구 — 현재 학습 진도는 이 브라우저에만 저장되며
 * 계정 간 동기화가 아님을 명시한다.
 */
export const LEARN_STORAGE_NOTICE =
  "학습 진도는 이 브라우저에만 저장됩니다. 다른 기기나 브라우저에서는 이어서 학습할 수 없습니다.";
