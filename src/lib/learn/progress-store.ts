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

/**
 * 학습 진도 로드 결과 — 기록 없음/손상/접근 불가를 구분한다.
 * - "ok": 정상 기록 존재, revision은 충돌 검사용 JSON
 * - "empty": 기록 없음 (신규 사용자), revision은 null
 * - "corrupt": 기록은 있으나 형식이 손상됨 — 자동 덮어쓰기 금지
 * - "unavailable": 저장소 접근 실패
 */
export type LearnProgressLoadStatus = "ok" | "empty" | "corrupt" | "unavailable";
export interface LearnProgressLoadResult {
  status: LearnProgressLoadStatus;
  /** 표시용 진도 — empty/corrupt/unavailable인 경우 빈 진도 */
  progress: LearnProgress;
  /** 충돌 검사용 revision — 기록이 없으면 null */
  revision: string | null;
  /** corrupt/unavailable인 경우 원인 */
  message?: string;
}

/** 학습 진도 불러오기 — 기록 없음/손상/접근 불가를 구분 */
export async function loadLearnProgressEx(): Promise<LearnProgressLoadResult> {
  try {
    const record = await transaction("readonly", (store) => store.get(KEY));
    if (record === undefined) return { status: "empty", progress: emptyProgress(), revision: null };
    if (isValidProgress(record)) return { status: "ok", progress: record, revision: JSON.stringify(record) };
    return { status: "corrupt", progress: emptyProgress(), revision: JSON.stringify(record), message: "저장된 학습 기록의 형식이 손상되었습니다." };
  } catch (e) {
    return { status: "unavailable", progress: emptyProgress(), revision: null, message: e instanceof Error ? e.message : "학습 진도를 불러오지 못했습니다." };
  }
}

/** 학습 진도 불러오기 — 손상 시 빈 진도로 복원 (기존 호환용) */
export async function loadLearnProgress(): Promise<LearnProgress> {
  const result = await loadLearnProgressEx();
  return result.progress;
}

/** 저장 요청 직렬화 — 빠른 연속 저장이 서로 덮어쓰지 않도록 순서대로 처리 */
let saveQueue: Promise<unknown> = Promise.resolve();
function enqueueSave<T>(task: () => Promise<T>): Promise<T> {
  const run = saveQueue.then(task, task);
  // 큐 자체는 실패해도 다음 작업을 막지 않도록 처리 (개별 결과는 run에 전달)
  saveQueue = run.catch(() => {});
  return run;
}

/**
 * 이 탭이 마지막으로 확인한 revision — 동일 탭의 연속 저장이
 * "다른 탭의 변경"으로 오판되지 않도록 저장 큐 안에서 추적한다.
 * (모듈 상태는 탭별 JS 컨텍스트에 격리되므로 다른 탭과 공유되지 않는다)
 */
let tabRevision: string | null | undefined = undefined;

/** 로드 직후 이 탭의 기준 revision을 등록한다 */
export function noteLearnRevision(revision: string | null | undefined): void {
  tabRevision = revision;
}

/**
 * 학습 진도 저장 — 다른 탭과 충돌 시 에러 (AX 저장소와 동일한 보호)
 * @param expected 충돌 검사용 revision — 생략하면 이 탭이 마지막으로 확인한 revision을
 *                 저장 큐 실행 시점에 읽어 사용한다. null이면 "기록이 없을 것"으로 예상
 *                 (신규 사용자 첫 저장), 문자열이면 해당 revision과 일치해야 저장
 * @returns 저장된 기록의 새 revision
 *
 * 저장 성공은 IndexedDB 트랜잭션이 실제로 완료된 후에만 확정된다.
 * put 요청 접수 시점이 아니라 tx.oncomplete에서 resolve한다.
 */
export async function saveLearnProgress(progress: LearnProgress, expected?: string | null): Promise<string> {
  return enqueueSave(async () => {
    // expected는 큐 실행 시점에 확정한다 — 호출 시점에 캡처하면
    // 직렬화된 이전 저장이 "다른 탭의 변경"으로 오판된다
    const revision = await saveLearnProgressInner(progress, expected !== undefined ? expected : tabRevision);
    tabRevision = revision;
    return revision;
  });
}

async function saveLearnProgressInner(progress: LearnProgress, expected?: string | null): Promise<string> {
  const db = await openDb();
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let failure: Error | undefined;
  let savedRevision: string | undefined;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getRequest = store.get(KEY);
    getRequest.onsuccess = () => {
      try {
        const current = getRequest.result as unknown;
        if (current === undefined) {
          // DB에 기록 없음 — 신규 저장으로 처리한다.
          // expected가 문자열이면 호출자가 기존 기록이 있다고 예상한 것이므로 충돌로 처리한다.
          // (신규 사용자는 revision=null로 호출하므로 정상 저장된다)
          if (expected !== undefined && expected !== null) {
            throw new Error("다른 탭에서 저장된 데이터가 변경되어 자동 저장을 중단했습니다.");
          }
        } else {
          // 기록 있음 — expected와 비교
          if (expected === null) {
            // 호출자는 기록이 없을 것으로 예상했는데 이미 있음 (다른 탭에서 먼저 저장)
            throw new Error("다른 탭에서 저장된 데이터가 변경되어 자동 저장을 중단했습니다.");
          }
          if (expected !== undefined && JSON.stringify(current) !== expected) {
            throw new Error("다른 탭에서 저장된 데이터가 변경되어 자동 저장을 중단했습니다.");
          }
        }
        const next = { ...progress, updatedAt: Date.now() };
        const putRequest = store.put(next, KEY);
        putRequest.onsuccess = () => {
          savedRevision = JSON.stringify(next);
        };
        putRequest.onerror = () => {
          failure = new Error("브라우저 저장에 실패했습니다.");
          try { tx.abort(); } catch { /* 이미 종료된 트랜잭션 */ }
        };
      } catch (error) {
        failure = error instanceof Error ? error : new Error("브라우저 저장에 실패했습니다.");
        try { tx.abort(); } catch { /* 이미 종료된 트랜잭션 */ }
      }
    };
    getRequest.onerror = () => {
      failure = new Error("브라우저 저장에 실패했습니다.");
      try { tx.abort(); } catch { /* 이미 종료된 트랜잭션 */ }
    };
    // 트랜잭션 실제 완료 후에만 성공 확정 — put 접수 시점이 아님
    tx.oncomplete = () => {
      db.close();
      if (savedRevision !== undefined) resolve(savedRevision);
      else reject(failure ?? new Error("브라우저 저장에 실패했습니다."));
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(failure ?? new Error("브라우저 저장에 실패했습니다."));
    };
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
