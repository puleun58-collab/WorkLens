import { afterEach, describe, expect, test, vi } from "vitest";
import { levelContent } from "@/lib/learn/content";
import { questionBank, restoreQuizQuestions } from "@/lib/learn/questions";
import {
  applyAttempt,
  questionFingerprint,
  selectQuizQuestions,
  shuffleQuestionChoices,
} from "@/lib/learn/scoring";
import type {
  InProgressQuiz,
  LearnProgress,
  LearnQuestion,
  QuizAttempt,
} from "@/lib/learn/types";

/**
 * 학습센터 저장 안정성 — 응시 멱등성·오답 스냅샷·진행 중 응시 복원·스토어 충돌.
 * 브라우저 IndexedDB 자체의 트랜잭션 직렬화는 E2E(learn-center.spec.ts)가 검증한다.
 */

const emptyProgress = (): LearnProgress => ({ version: 1, levels: {}, wrongAnswers: [], updatedAt: 0 });

const singleQ: LearnQuestion = {
  id: "l1-q001", level: 1, unitId: "l1-u1", category: "개념", type: "single", difficulty: "concept",
  prompt: "질문 본문", choices: [{ id: "a", text: "선택지 A" }, { id: "b", text: "선택지 B" }],
  correctChoiceIds: ["a"], explanation: "해설 본문", verified: true,
};

function wrongAttempt(attemptId: string, choiceOrder?: Record<string, string[]>): QuizAttempt {
  return {
    attemptId,
    level: 1,
    questionIds: ["l1-q001"],
    answers: { "l1-q001": { kind: "choices", selectedChoiceIds: ["b"] } },
    graded: [{ questionId: "l1-q001", correct: false, points: 0 }],
    score: 0,
    passed: false,
    passScore: 80,
    choiceOrder,
    startedAt: 10,
    finishedAt: 20,
  };
}

describe("applyAttempt 멱등성 (중복 제출 방지)", () => {
  test("같은 attemptId를 두 번 적용해도 기록이 중복되지 않는다", () => {
    const attempt = wrongAttempt("dup-1");
    let p = applyAttempt(emptyProgress(), attempt, [singleQ]);
    expect(p.levels[1]?.attempts).toHaveLength(1);
    expect(p.wrongAnswers).toHaveLength(1);
    p = applyAttempt(p, attempt, [singleQ]);
    expect(p.levels[1]?.attempts).toHaveLength(1);
    expect(p.wrongAnswers).toHaveLength(1);
    expect(p.levels[1]?.bestScore).toBe(0);
  });

  test("서로 다른 응시는 각각 기록된다", () => {
    let p = applyAttempt(emptyProgress(), wrongAttempt("a-1"), [singleQ]);
    p = applyAttempt(p, wrongAttempt("a-2"), [singleQ]);
    expect(p.levels[1]?.attempts).toHaveLength(2);
    expect(p.wrongAnswers).toHaveLength(2);
  });
});

describe("오답 스냅샷 (응시 이력 정리 후에도 참조 유지)", () => {
  test("오답 항목에 응시 당시 정보가 스냅샷으로 고정된다", () => {
    const attempt = wrongAttempt("snap-1", { "l1-q001": ["b", "a"] });
    const p = applyAttempt(emptyProgress(), attempt, [singleQ]);
    const entry = p.wrongAnswers[0];
    expect(entry.prompt).toBe("질문 본문");
    expect(entry.unitId).toBe("l1-u1");
    expect(entry.explanation).toBe("해설 본문");
    expect(entry.correctChoiceIds).toEqual(["a"]);
    expect(entry.myAnswer).toEqual({ kind: "choices", selectedChoiceIds: ["b"] });
    // 선택지 스냅샷은 응시 당시 표시 순서(choiceOrder) 그대로
    expect(entry.choices?.map((c) => c.id)).toEqual(["b", "a"]);
  });

  test("응시 이력이 20회 한도를 넘어 정리되어도 오답 스냅샷은 남는다", () => {
    let p = applyAttempt(emptyProgress(), wrongAttempt("old-1"), [singleQ]);
    // 이후 20회 응시(전부 정답) → 첫 응시는 이력에서 밀려난다
    for (let i = 2; i <= 21; i++) {
      p = applyAttempt(p, {
        attemptId: `later-${i}`,
        level: 1,
        questionIds: ["l1-q001"],
        answers: { "l1-q001": { kind: "choices", selectedChoiceIds: ["a"] } },
        graded: [{ questionId: "l1-q001", correct: true, points: 10 }],
        score: 100,
        passed: true,
        passScore: 80,
        startedAt: i,
        finishedAt: i,
      }, [singleQ]);
    }
    expect(p.levels[1]?.attempts).toHaveLength(20);
    expect(p.levels[1]?.attempts.some((a) => a.attemptId === "old-1")).toBe(false);
    const entry = p.wrongAnswers.find((w) => w.attemptId === "old-1");
    expect(entry).toBeDefined();
    expect(entry?.prompt).toBe("질문 본문");
    expect(entry?.myAnswer).toEqual({ kind: "choices", selectedChoiceIds: ["b"] });
  });

  test("문항 정보 없이 적용하면 스냅샷을 만들지 않는다 (조회 기반 복원에 맡김)", () => {
    const p = applyAttempt(emptyProgress(), wrongAttempt("noq-1"));
    expect(p.wrongAnswers[0].prompt).toBeUndefined();
    expect(p.wrongAnswers[0].myAnswer).toBeUndefined();
  });
});

describe("questionFingerprint", () => {
  test("선택지 표시 순서가 달라도 지문은 같다", () => {
    const shuffled: LearnQuestion = { ...singleQ, choices: [...(singleQ.choices ?? [])].reverse() };
    expect(questionFingerprint(shuffled)).toBe(questionFingerprint(singleQ));
  });
  test("질문·선택지·정답이 바뀌면 지문이 달라진다", () => {
    const base = questionFingerprint(singleQ);
    expect(questionFingerprint({ ...singleQ, prompt: "다른 질문" })).not.toBe(base);
    expect(
      questionFingerprint({ ...singleQ, choices: [{ id: "a", text: "바뀐 선택지" }, { id: "b", text: "선택지 B" }] }),
    ).not.toBe(base);
    expect(questionFingerprint({ ...singleQ, correctChoiceIds: ["b"] })).not.toBe(base);
  });
});

describe("restoreQuizQuestions (진행 중 응시 복원)", () => {
  function buildInProgress(): { ip: InProgressQuiz; questions: LearnQuestion[] } {
    const attemptId = "restore-test-1";
    const unitIds = levelContent(1).units.map((u) => u.id);
    const selected = selectQuizQuestions(1, questionBank(1), attemptId, unitIds, []);
    const questions = shuffleQuestionChoices(selected, attemptId);
    const choiceOrder: Record<string, string[]> = {};
    const questionChecks: Record<string, number> = {};
    for (const q of questions) {
      if (q.choices) choiceOrder[q.id] = q.choices.map((c) => c.id);
      questionChecks[q.id] = questionFingerprint(q);
    }
    return {
      questions,
      ip: {
        attemptId,
        level: 1,
        startedAt: 100,
        questionIds: questions.map((q) => q.id),
        choiceOrder,
        answers: {},
        currentIndex: 3,
        passScore: 80,
        questionChecks,
        savedAt: 200,
        status: "in-progress",
      },
    };
  }

  test("저장된 문제 순서·선택지 순서 그대로 복원된다", () => {
    const { ip, questions } = buildInProgress();
    const restored = restoreQuizQuestions(ip);
    expect(restored).not.toBeNull();
    expect(restored?.map((q) => q.id)).toEqual(ip.questionIds);
    for (let i = 0; i < questions.length; i++) {
      expect(restored?.[i].choices?.map((c) => c.id)).toEqual(questions[i].choices?.map((c) => c.id));
    }
  });

  test("문항 지문이 다르면 복원하지 않는다 (문제은행 변경)", () => {
    const { ip } = buildInProgress();
    const tampered: InProgressQuiz = {
      ...ip,
      questionChecks: { ...ip.questionChecks, [ip.questionIds[0]]: (ip.questionChecks[ip.questionIds[0]] ?? 0) + 1 },
    };
    expect(restoreQuizQuestions(tampered)).toBeNull();
  });

  test("문제은행에 없는 문항이 포함되면 복원하지 않는다", () => {
    const { ip } = buildInProgress();
    const missing: InProgressQuiz = {
      ...ip,
      questionIds: [...ip.questionIds.slice(0, 9), "l1-q999"],
      questionChecks: { ...ip.questionChecks, "l1-q999": 123 },
    };
    expect(restoreQuizQuestions(missing)).toBeNull();
  });
});

/* ---------------- progress-store: 진행 중 응시 저장 ---------------- */

/** 키 기반 인메모리 IndexedDB 스텁 — 스토어의 get/put/delete·트랜잭션 완료 경로를 재현 */
function installFakeIndexedDb() {
  const data = new Map<string, unknown>();
  let failPut = false;
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({}),
    close: () => {},
    onversionchange: null as null | (() => void),
    transaction: () => {
      let pending = 0;
      let aborted = false;
      const tx: Record<string, unknown> = {
        oncomplete: null as null | (() => void),
        onabort: null as null | (() => void),
        onerror: null as null | (() => void),
        abort() {
          aborted = true;
          queueMicrotask(() => (tx.onabort as (() => void) | null)?.());
        },
        objectStore: () => store,
      };
      const settle = () => {
        pending -= 1;
        if (pending === 0 && !aborted) queueMicrotask(() => (tx.oncomplete as (() => void) | null)?.());
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
        get: (key: string) => makeRequest((req) => {
          req.result = data.has(key) ? structuredClone(data.get(key)) : undefined;
        }),
        put: (value: unknown, key: string) => {
          if (failPut) {
            pending += 1;
            const req = { result: undefined, onsuccess: null as null | (() => void), onerror: null as null | (() => void) };
            queueMicrotask(() => {
              req.onerror?.();
            });
            return req;
          }
          return makeRequest((req) => {
            data.set(key, structuredClone(value));
            req.result = key;
          });
        },
        delete: (key: string) => makeRequest((req) => {
          data.delete(key);
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
  return {
    data,
    setFailPut: (v: boolean) => {
      failPut = v;
    },
  };
}

/** 새 탭에 해당 — 모듈 상태를 초기화해 progress-store를 다시 불러온다 */
async function freshStore() {
  vi.resetModules();
  return import("@/lib/learn/progress-store");
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
    passScore: 80,
    questionChecks: { "l1-q001": 42 },
    savedAt: 0,
    status: "in-progress",
  };
}

describe("progress-store 진행 중 응시", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("저장 후 불러오면 같은 응시가 복원되고 savedAt이 단조 증가한다", async () => {
    installFakeIndexedDb();
    const store = await freshStore();
    expect(await store.loadInProgressQuiz()).toBeNull();
    const first = await store.saveInProgressQuiz(sampleInProgress("ip-1"));
    expect(first.savedAt).toBeGreaterThan(0);
    const second = await store.saveInProgressQuiz({ ...first, currentIndex: 1 });
    expect(second.savedAt).toBeGreaterThan(first.savedAt);
    const loaded = await store.loadInProgressQuiz();
    expect(loaded?.attemptId).toBe("ip-1");
    expect(loaded?.currentIndex).toBe(1);
    expect(loaded?.answers).toEqual({ "l1-q001": { kind: "choices", selectedChoiceIds: ["b"] } });
  });

  test("진행 중 응시와 완료 진도 기록은 서로 영향을 주지 않는다", async () => {
    installFakeIndexedDb();
    const store = await freshStore();
    const progress: LearnProgress = { version: 1, levels: {}, wrongAnswers: [], updatedAt: 5 };
    await store.saveLearnProgress(progress);
    await store.saveInProgressQuiz(sampleInProgress("ip-2"));
    const loadedProgress = await store.loadLearnProgressEx();
    expect(loadedProgress.status).toBe("ok");
    expect(loadedProgress.progress.updatedAt).toBeGreaterThanOrEqual(5);
    await store.clearInProgressQuiz("ip-2");
    expect(await store.loadInProgressQuiz()).toBeNull();
    expect((await store.loadLearnProgressEx()).status).toBe("ok");
  });

  test("attemptId가 다른 기록은 정리하지 않는다", async () => {
    installFakeIndexedDb();
    const store = await freshStore();
    await store.saveInProgressQuiz(sampleInProgress("mine"));
    await store.clearInProgressQuiz("someone-else");
    expect((await store.loadInProgressQuiz())?.attemptId).toBe("mine");
    await store.clearInProgressQuiz("mine");
    expect(await store.loadInProgressQuiz()).toBeNull();
  });

  test("다른 탭이 같은 응시를 먼저 저장하면 충돌로 중단하고 기존 기록을 보호한다", async () => {
    installFakeIndexedDb();
    const tabA = await freshStore();
    await tabA.loadInProgressQuiz();
    const savedByA = await tabA.saveInProgressQuiz(sampleInProgress("shared"));

    // 다른 탭: 같은 기록을 불러와 이어서 저장
    const tabB = await freshStore();
    const loadedByB = await tabB.loadInProgressQuiz();
    expect(loadedByB?.attemptId).toBe("shared");
    const bAnswers = { "l1-q001": { kind: "choices", selectedChoiceIds: ["a"] } } as InProgressQuiz["answers"];
    const savedByB = await tabB.saveInProgressQuiz({ ...loadedByB!, answers: bAnswers });
    expect(savedByB.savedAt).toBeGreaterThan(savedByA.savedAt);

    // 원래 탭이 오래된 기준(savedAt)으로 저장 시도 → 충돌, B의 기록 유지
    await expect(
      tabA.saveInProgressQuiz({ ...savedByA, answers: { "l1-q001": { kind: "ox", answer: true } } }),
    ).rejects.toThrow("다른 탭");
    const after = await tabB.loadInProgressQuiz();
    expect(after?.answers).toEqual(bAnswers);
  });

  test("손상된 진행 중 기록은 null로 처리한다 (완료 기록과 무관)", async () => {
    const fake = installFakeIndexedDb();
    fake.data.set("in-progress", { broken: true });
    const store = await freshStore();
    expect(await store.loadInProgressQuiz()).toBeNull();
  });

  test("저장 실패 시 거부되고 기록이 남지 않는다", async () => {
    const fake = installFakeIndexedDb();
    const store = await freshStore();
    fake.setFailPut(true);
    await expect(store.saveInProgressQuiz(sampleInProgress("ip-fail"))).rejects.toThrow();
    fake.setFailPut(false);
    expect(await store.loadInProgressQuiz()).toBeNull();
  });
});
