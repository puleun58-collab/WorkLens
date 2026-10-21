import { afterEach, describe, expect, test, vi } from "vitest";
import { buildLearnBackup, parseLearnBackup, serializeLearnBackup } from "@/lib/learn/backup";
import { questionBank } from "@/lib/learn/questions";
import { questionFingerprint } from "@/lib/learn/scoring";
import type { PracticeTerminalStates } from "@/lib/learn/progress-store";
import type {
  InProgressQuiz,
  LearnProgress,
  TerminalStateSnapshot,
} from "@/lib/learn/types";

/**
 * 학습 기록 백업 가져오기(복원) 원자성 — replaceAllLearnData가 진도·진행 중
 * 퀴즈·연습 상태를 단일 트랜잭션으로 교체하는지 검증한다.
 * 실패·충돌 시 3개 키 모두 기존 값을 유지해야 한다.
 */

/** 트랜잭션 원자성을 재현하는 IndexedDB 스텁 — 쓰기는 완료 시에만 반영되고 중단 시 버려진다 */
function installFakeIndexedDb() {
  const data = new Map<string, unknown>();
  const failPutKeys = new Set<string>();
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({}),
    close: () => {},
    onversionchange: null as null | (() => void),
    transaction: () => {
      let pending = 0;
      let aborted = false;
      let finished = false;
      const staged = new Map<string, unknown>();
      const stagedDeletes = new Set<string>();
      const tx: Record<string, unknown> = {
        oncomplete: null as null | (() => void),
        onabort: null as null | (() => void),
        onerror: null as null | (() => void),
        abort() {
          if (aborted || finished) return;
          aborted = true;
          queueMicrotask(() => (tx.onabort as (() => void) | null)?.());
        },
        objectStore: () => store,
      };
      const settle = () => {
        pending -= 1;
        if (pending === 0 && !aborted && !finished) {
          finished = true;
          for (const key of stagedDeletes) data.delete(key);
          for (const [key, value] of staged) data.set(key, value);
          queueMicrotask(() => (tx.oncomplete as (() => void) | null)?.());
        }
      };
      const makeRequest = (run: (req: { result: unknown }) => void) => {
        pending += 1;
        const req: { result: unknown; onsuccess: null | (() => void); onerror: null | (() => void) } = {
          result: undefined,
          onsuccess: null,
          onerror: null,
        };
        queueMicrotask(() => {
          if (aborted) return;
          run(req);
          req.onsuccess?.();
          settle();
        });
        return req;
      };
      const store = {
        get: (key: string) =>
          makeRequest((req) => {
            req.result = stagedDeletes.has(key)
              ? undefined
              : staged.has(key)
                ? structuredClone(staged.get(key))
                : data.has(key)
                  ? structuredClone(data.get(key))
                  : undefined;
          }),
        put: (value: unknown, key: string) => {
          if (failPutKeys.has(key)) {
            pending += 1;
            const req = { result: undefined, onsuccess: null as null | (() => void), onerror: null as null | (() => void) };
            queueMicrotask(() => {
              req.onerror?.();
            });
            return req;
          }
          return makeRequest((req) => {
            staged.set(key, structuredClone(value));
            stagedDeletes.delete(key);
            req.result = key;
          });
        },
        delete: (key: string) =>
          makeRequest((req) => {
            staged.delete(key);
            stagedDeletes.add(key);
            req.result = undefined;
          }),
      };
      return tx;
    },
  };
  vi.stubGlobal("indexedDB", {
    open: () => {
      const req: {
        result: unknown;
        onsuccess: null | (() => void);
        onerror: null | (() => void);
        onblocked: null | (() => void);
        onupgradeneeded: null | (() => void);
      } = { result: db, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      queueMicrotask(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  });
  return { data, failPutKeys };
}

/** 새 탭에 해당 — 모듈 상태를 초기화해 progress-store를 다시 불러온다 */
async function freshStore() {
  vi.resetModules();
  return import("@/lib/learn/progress-store");
}

function sampleProgress(bestScore: number): LearnProgress {
  return {
    version: 1,
    levels: {
      1: { passed: true, bestScore, attempts: [], completedUnitIds: ["l1-u1"], lastStudiedUnitId: "l1-u1" },
    },
    wrongAnswers: [],
    updatedAt: bestScore,
  };
}

function sampleInProgress(attemptId: string): InProgressQuiz {
  return {
    attemptId,
    level: 1,
    startedAt: 1000,
    questionIds: ["l1-q001"],
    choiceOrder: { "l1-q001": ["b", "a"] },
    answers: { "l1-q001": { kind: "choices", selectedChoiceIds: ["b"] } },
    currentIndex: 0,
    terminalStates: {},
    passScore: 80,
    questionChecks: { "l1-q001": 42 },
    savedAt: 0,
    status: "in-progress",
  };
}

function sampleSnapshot(cwd: string): TerminalStateSnapshot {
  return {
    cwd,
    dirs: ["/"],
    files: [],
    git: {
      repoRoot: null,
      branch: "main",
      branches: [],
      staged: [],
      modified: [],
      untracked: [],
      commits: [],
      remote: null,
      ahead: 0,
      behind: 0,
      conflicted: false,
    },
    lines: [],
    transcript: [],
  };
}

function samplePractice(cwd: string): PracticeTerminalStates {
  return { "1:l1-u1": sampleSnapshot(cwd) };
}

/** 기준 데이터(기존 기록)를 저장해 탭 기준값(revision·savedAt)까지 확정한다 */
async function seedBase(
  store: Awaited<ReturnType<typeof freshStore>>,
  bestScore = 11,
  attemptId = "base-ip",
  cwd = "/base",
) {
  await store.saveLearnProgress(sampleProgress(bestScore));
  await store.saveInProgressQuiz(sampleInProgress(attemptId));
  await store.savePracticeTerminalStates(samplePractice(cwd));
}

describe("replaceAllLearnData 원자적 교체", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("정상 교체 시 3개 키가 모두 새 값으로 반영된다", async () => {
    installFakeIndexedDb();
    const store = await freshStore();
    await seedBase(store);

    const result = await store.replaceAllLearnData(
      sampleProgress(99),
      sampleInProgress("imported-ip"),
      samplePractice("/imported"),
    );

    expect(result.progress.levels[1]?.bestScore).toBe(99);
    expect(result.inProgress?.attemptId).toBe("imported-ip");
    const loadedProgress = await store.loadLearnProgressEx();
    expect(loadedProgress.status).toBe("ok");
    expect(loadedProgress.progress.levels[1]?.bestScore).toBe(99);
    expect(loadedProgress.progress.levels[1]?.completedUnitIds).toEqual(["l1-u1"]);
    const loadedIp = await store.loadInProgressQuiz();
    expect(loadedIp?.attemptId).toBe("imported-ip");
    expect(loadedIp?.answers).toEqual({ "l1-q001": { kind: "choices", selectedChoiceIds: ["b"] } });
    expect(await store.loadPracticeTerminalStates()).toEqual(samplePractice("/imported"));
  });

  test("백업에 진행 중 퀴즈가 없으면 기존 진행 중 키가 삭제되고 나머지가 교체된다", async () => {
    installFakeIndexedDb();
    const store = await freshStore();
    await seedBase(store);

    const result = await store.replaceAllLearnData(sampleProgress(77), null, {});

    expect(result.inProgress).toBeNull();
    expect(await store.loadInProgressQuiz()).toBeNull();
    expect((await store.loadLearnProgressEx()).progress.levels[1]?.bestScore).toBe(77);
    expect(await store.loadPracticeTerminalStates()).toEqual({});
  });

  test("트랜잭션 도중 put이 실패하면 3개 키 모두 기존 값을 유지한다", async () => {
    const fake = installFakeIndexedDb();
    const store = await freshStore();
    await seedBase(store);

    // 마지막에 쓰는 연습 상태 키의 put을 실패시켜 앞선 put들의 롤백까지 확인한다
    fake.failPutKeys.add("practice-terminal");
    await expect(
      store.replaceAllLearnData(sampleProgress(55), sampleInProgress("should-not-land"), samplePractice("/nope")),
    ).rejects.toThrow();

    expect((await store.loadLearnProgressEx()).progress.levels[1]?.bestScore).toBe(11);
    expect((await store.loadInProgressQuiz())?.attemptId).toBe("base-ip");
    expect(await store.loadPracticeTerminalStates()).toEqual(samplePractice("/base"));
  });

  test("다른 탭이 진도를 변경했으면 충돌로 중단하고 기존 데이터를 전부 유지한다", async () => {
    installFakeIndexedDb();
    const tabA = await freshStore();
    await seedBase(tabA);

    // 다른 탭이 진도를 먼저 변경
    const tabB = await freshStore();
    const loadedByB = await tabB.loadLearnProgressEx();
    tabB.noteLearnRevision(loadedByB.revision);
    await tabB.saveLearnProgress(sampleProgress(33));

    await expect(
      tabA.replaceAllLearnData(sampleProgress(99), sampleInProgress("a-import"), samplePractice("/a")),
    ).rejects.toThrow("다른 탭");

    // 진도는 다른 탭 값, 진행 중 퀴즈·연습 상태는 기존 값 그대로
    expect((await tabB.loadLearnProgressEx()).progress.levels[1]?.bestScore).toBe(33);
    expect((await tabB.loadInProgressQuiz())?.attemptId).toBe("base-ip");
    expect(await tabB.loadPracticeTerminalStates()).toEqual(samplePractice("/base"));
  });

  test("다른 탭이 진행 중 퀴즈를 변경했으면 충돌로 중단하고 진도도 교체되지 않는다", async () => {
    installFakeIndexedDb();
    const tabA = await freshStore();
    await seedBase(tabA);

    // 다른 탭이 진행 중 퀴즈만 먼저 변경
    const tabB = await freshStore();
    const loadedByB = await tabB.loadInProgressQuiz();
    expect(loadedByB?.attemptId).toBe("base-ip");
    await tabB.saveInProgressQuiz({ ...loadedByB!, currentIndex: 7 });

    await expect(
      tabA.replaceAllLearnData(sampleProgress(99), sampleInProgress("a-import"), samplePractice("/a")),
    ).rejects.toThrow("다른 탭");

    expect((await tabB.loadLearnProgressEx()).progress.levels[1]?.bestScore).toBe(11);
    expect((await tabB.loadInProgressQuiz())?.currentIndex).toBe(7);
    expect(await tabB.loadPracticeTerminalStates()).toEqual(samplePractice("/base"));
  });

  test("교체 후 재로드하면 동일 상태이며, 같은 탭의 후속 저장이 충돌로 오판되지 않는다", async () => {
    installFakeIndexedDb();
    const tabA = await freshStore();
    await seedBase(tabA);
    const replaced = await tabA.replaceAllLearnData(
      sampleProgress(66),
      sampleInProgress("reloaded-ip"),
      samplePractice("/reloaded"),
    );

    // 교체 직후 같은 탭이 가져온 응시를 이어서 저장 — 기준값이 갱신되어 충돌이 아니어야 한다
    const continued = await tabA.saveInProgressQuiz({ ...replaced.inProgress!, currentIndex: 3 });
    expect(continued.currentIndex).toBe(3);

    // 새 탭(재로드)에서 불러온 상태가 교체 결과와 같다
    const tabB = await freshStore();
    expect((await tabB.loadLearnProgressEx()).progress.levels[1]?.bestScore).toBe(66);
    const ip = await tabB.loadInProgressQuiz();
    expect(ip?.attemptId).toBe("reloaded-ip");
    expect(ip?.currentIndex).toBe(3);
    expect(await tabB.loadPracticeTerminalStates()).toEqual(samplePractice("/reloaded"));
  });

  test("기존 백업 파일(현행 형식)을 파싱해 복원하면 파싱 결과와 같은 상태가 된다", async () => {
    installFakeIndexedDb();
    const store = await freshStore();
    await seedBase(store, 5, "old-ip", "/old");

    // 문제은행과 지문이 일치하는 진행 중 퀴즈를 포함한 백업 파일 생성 → 파싱
    const bank = questionBank(1).slice(0, 3);
    const questionChecks: Record<string, number> = {};
    const choiceOrder: Record<string, string[]> = {};
    for (const q of bank) {
      questionChecks[q.id] = questionFingerprint(q);
      if (q.choices) choiceOrder[q.id] = q.choices.map((c) => c.id);
    }
    const backupIp: InProgressQuiz = {
      attemptId: "backup-ip",
      level: 1,
      startedAt: 2000,
      questionIds: bank.map((q) => q.id),
      choiceOrder,
      answers: {},
      currentIndex: 1,
      terminalStates: {},
      passScore: 80,
      questionChecks,
      savedAt: 3000,
      status: "in-progress",
    };
    const parsed = parseLearnBackup(
      serializeLearnBackup(buildLearnBackup(sampleProgress(88), backupIp, samplePractice("/from-backup"))),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // completedUnitIds 같은 기존 필드가 파싱에서 유지되는지 확인
    expect(parsed.progress.levels[1]?.completedUnitIds).toEqual(["l1-u1"]);
    expect(parsed.inProgress?.attemptId).toBe("backup-ip");

    await store.replaceAllLearnData(parsed.progress, parsed.inProgress, parsed.practiceStates);

    expect((await store.loadLearnProgressEx()).progress.levels[1]?.bestScore).toBe(88);
    expect((await store.loadInProgressQuiz())?.attemptId).toBe("backup-ip");
    expect(await store.loadPracticeTerminalStates()).toEqual(samplePractice("/from-backup"));
  });
});
