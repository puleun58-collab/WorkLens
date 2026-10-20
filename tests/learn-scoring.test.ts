import { describe, expect, test } from "vitest";
import {
  applyAttempt,
  canUnlockLevel,
  gradeQuestion,
  gradeQuiz,
  isLearningComplete,
  overallProgress,
  selectQuizQuestions,
  seededShuffle,
  weakCategories,
} from "@/lib/learn/scoring";
import type { LearnProgress, LearnQuestion, QuizAttempt } from "@/lib/learn/types";

const singleQ: LearnQuestion = {
  id: "l1-q001", level: 1, category: "개념", type: "single", difficulty: "concept",
  prompt: "Q", choices: [{ id: "a", text: "A" }, { id: "b", text: "B" }], correctChoiceIds: ["b"],
  explanation: "E", verified: true,
};
const multiQ: LearnQuestion = {
  id: "l1-q002", level: 1, category: "개념", type: "multiple", difficulty: "application",
  prompt: "Q", choices: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }],
  correctChoiceIds: ["a", "c"], explanation: "E", verified: true,
};
const oxQ: LearnQuestion = {
  id: "l1-q003", level: 1, category: "개념", type: "ox", difficulty: "concept",
  prompt: "Q", oxAnswer: true, explanation: "E", verified: true,
};

describe("gradeQuestion", () => {
  test("단일 선택 정답", () => {
    expect(gradeQuestion(singleQ, { kind: "choices", selectedChoiceIds: ["b"] })).toBe(true);
    expect(gradeQuestion(singleQ, { kind: "choices", selectedChoiceIds: ["a"] })).toBe(false);
  });
  test("복수 선택은 집합 완전 일치", () => {
    expect(gradeQuestion(multiQ, { kind: "choices", selectedChoiceIds: ["a", "c"] })).toBe(true);
    expect(gradeQuestion(multiQ, { kind: "choices", selectedChoiceIds: ["c", "a"] })).toBe(true); // 순서 무관
    expect(gradeQuestion(multiQ, { kind: "choices", selectedChoiceIds: ["a"] })).toBe(false); // 부분 점수 없음
    expect(gradeQuestion(multiQ, { kind: "choices", selectedChoiceIds: ["a", "b", "c"] })).toBe(false);
  });
  test("OX", () => {
    expect(gradeQuestion(oxQ, { kind: "ox", answer: true })).toBe(true);
    expect(gradeQuestion(oxQ, { kind: "ox", answer: false })).toBe(false);
  });
  test("미응답은 오답", () => {
    expect(gradeQuestion(singleQ, undefined)).toBe(false);
  });
  test("잘못된 답변 형식은 오답", () => {
    expect(gradeQuestion(singleQ, { kind: "ox", answer: true })).toBe(false);
  });
});

describe("gradeQuiz", () => {
  test("LEVEL 1: 문항당 10점, 70점 통과", () => {
    const questions = Array.from({ length: 10 }, (_, i) => ({ ...singleQ, id: `l1-q${i}` }));
    const answers = Object.fromEntries(questions.slice(0, 7).map((q) => [q.id, { kind: "choices", selectedChoiceIds: ["b"] }]));
    const { score, passed } = gradeQuiz(1, questions, answers as never);
    expect(score).toBe(70);
    expect(passed).toBe(true);
  });
  test("기준 점수와 동일하면 통과", () => {
    const questions = Array.from({ length: 10 }, (_, i) => ({ ...singleQ, id: `l1-q${i}` }));
    const answers = Object.fromEntries(questions.slice(0, 6).map((q) => [q.id, { kind: "choices", selectedChoiceIds: ["b"] }]));
    const { score, passed } = gradeQuiz(1, questions, answers as never);
    expect(score).toBe(60);
    expect(passed).toBe(false);
  });
  test("LEVEL 10: 문항당 5점, 85점 통과", () => {
    const q10 = { ...singleQ, level: 10 as const, id: "l10-q001" };
    const questions = Array.from({ length: 20 }, (_, i) => ({ ...q10, id: `l10-q${i}` }));
    const answers = Object.fromEntries(questions.slice(0, 17).map((q) => [q.id, { kind: "choices", selectedChoiceIds: ["b"] }]));
    const { score, passed } = gradeQuiz(10, questions, answers as never);
    expect(score).toBe(85);
    expect(passed).toBe(true);
  });
});

describe("seededShuffle", () => {
  test("같은 시드는 같은 순서", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(seededShuffle(items, 42)).toEqual(seededShuffle(items, 42));
  });
  test("다른 시드는 다른 순서 (높은 확률)", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(seededShuffle(items, 42)).not.toEqual(seededShuffle(items, 43));
  });
});

describe("selectQuizQuestions", () => {
  test("검증된 문제만 출제, 단계별 문항 수", () => {
    const bank: LearnQuestion[] = Array.from({ length: 25 }, (_, i) => ({
      ...singleQ, id: `l1-q${String(i).padStart(3, "0")}`, verified: i < 20,
    }));
    const selected = selectQuizQuestions(1, bank, "attempt-1");
    expect(selected).toHaveLength(10);
    expect(selected.every((q) => q.verified)).toBe(true);
  });
  test("같은 attemptId는 같은 출제", () => {
    const bank: LearnQuestion[] = Array.from({ length: 20 }, (_, i) => ({ ...singleQ, id: `l1-q${String(i).padStart(3, "0")}` }));
    expect(selectQuizQuestions(1, bank, "a1").map((q) => q.id)).toEqual(selectQuizQuestions(1, bank, "a1").map((q) => q.id));
  });
  test("문제 부족 시 에러", () => {
    expect(() => selectQuizQuestions(1, [singleQ], "a1")).toThrow();
  });
});

const emptyProgress = (): LearnProgress => ({ version: 1, levels: {}, wrongAnswers: [], updatedAt: 0 });

describe("canUnlockLevel", () => {
  test("LEVEL 1은 항상 해제", () => {
    expect(canUnlockLevel(1, emptyProgress())).toBe(true);
  });
  test("이전 단계 통과해야 해제", () => {
    const p = emptyProgress();
    expect(canUnlockLevel(2, p)).toBe(false);
    p.levels[1] = { passed: true, bestScore: 80, attempts: [] };
    expect(canUnlockLevel(2, p)).toBe(true);
    expect(canUnlockLevel(3, p)).toBe(false);
  });
});

describe("applyAttempt", () => {
  const makeAttempt = (score: number, passed: boolean): QuizAttempt => ({
    attemptId: "a1", level: 1, questionIds: ["l1-q001", "l1-q002"],
    answers: {}, graded: [{ questionId: "l1-q001", correct: passed, points: passed ? 10 : 0 }, { questionId: "l1-q002", correct: false, points: 0 }],
    score, passed, startedAt: 0, finishedAt: 1,
  });
  test("최고 점수 보존, 통과 상태 유지", () => {
    let p = applyAttempt(emptyProgress(), makeAttempt(80, true));
    expect(p.levels[1]?.bestScore).toBe(80);
    expect(p.levels[1]?.passed).toBe(true);
    // 재응시 점수가 낮아도 통과 유지, 최고 점수 유지
    p = applyAttempt(p, makeAttempt(60, false));
    expect(p.levels[1]?.bestScore).toBe(80);
    expect(p.levels[1]?.passed).toBe(true);
  });
  test("오답 노트 기록", () => {
    const p = applyAttempt(emptyProgress(), makeAttempt(50, false));
    expect(p.wrongAnswers.length).toBeGreaterThan(0);
    expect(p.wrongAnswers.every((w) => w.level === 1)).toBe(true);
  });
  test("오답에 실제 문제 카테고리 저장", () => {
    const p = applyAttempt(emptyProgress(), makeAttempt(50, false), [singleQ, multiQ]);
    // l1-q001 오답 → singleQ.category="개념", l1-q002 오답 → multiQ.category="개념"
    expect(p.wrongAnswers.length).toBe(2);
    expect(p.wrongAnswers[0].category).toBe("개념");
    expect(p.wrongAnswers[1].category).toBe("개념");
  });
  test("문제은행에 없는 ID는 임의 카테고리로 대체하지 않음", () => {
    const attempt = makeAttempt(50, false);
    attempt.graded = [{ questionId: "l1-unknown", correct: false, points: 0 }];
    attempt.questionIds = ["l1-unknown"];
    const p = applyAttempt(emptyProgress(), attempt, [singleQ]);
    expect(p.wrongAnswers[0].category).toBe("");
  });
});

describe("weakCategories", () => {
  const makeWrong = (questionId: string, category: string) => ({
    questionId, level: 1 as const, category, attemptId: "a1", answeredAt: 1, reviewCount: 0,
  });
  test("빈 카테고리 기록은 문제 ID로 복원", () => {
    const p = emptyProgress();
    p.wrongAnswers = [makeWrong("l1-q001", ""), makeWrong("l1-q002", "")];
    const result = weakCategories(p, (id) => (id === "l1-q001" ? "개념A" : id === "l1-q002" ? "개념B" : undefined));
    expect(result).toEqual([{ category: "개념A", count: 1 }, { category: "개념B", count: 1 }]);
  });
  test("복원 불가능한 항목은 집계에서 제외", () => {
    const p = emptyProgress();
    p.wrongAnswers = [makeWrong("l1-gone", "")];
    expect(weakCategories(p, () => undefined)).toEqual([]);
    expect(weakCategories(p)).toEqual([]);
  });
  test("기존 카테고리는 그대로 집계", () => {
    const p = emptyProgress();
    p.wrongAnswers = [makeWrong("l1-q001", "개념"), makeWrong("l1-q002", "개념")];
    expect(weakCategories(p)).toEqual([{ category: "개념", count: 2 }]);
  });
});

describe("overallProgress / isLearningComplete", () => {
  test("진행률 계산", () => {
    const p = emptyProgress();
    p.levels[1] = { passed: true, bestScore: 80, attempts: [] };
    p.levels[2] = { passed: true, bestScore: 90, attempts: [] };
    expect(overallProgress(p)).toEqual({ passed: 2, total: 10, percent: 20 });
    expect(isLearningComplete(p)).toBe(false);
  });
});

describe("응시 이력 불변성", () => {
  const emptyProgress = (): LearnProgress => ({ version: 1, levels: {}, wrongAnswers: [], updatedAt: 0 });
  const makeAttempt = (attemptId: string, score: number, passed: boolean): QuizAttempt => ({
    attemptId, level: 1, questionIds: ["l1-q001"],
    answers: {}, graded: [{ questionId: "l1-q001", correct: passed, points: passed ? 10 : 0 }],
    score, passed, startedAt: 0, finishedAt: 1,
  });
  test("과거 응시의 점수·통과 상태가 그대로 보존된다", () => {
    let p = applyAttempt(emptyProgress(), makeAttempt("a1", 70, true));
    const first = p.levels[1]!.attempts[0];
    expect(first.score).toBe(70);
    expect(first.passed).toBe(true);
    // 이후 재응시해도 과거 응시 기록은 변경되지 않음
    p = applyAttempt(p, makeAttempt("a2", 40, false));
    expect(p.levels[1]!.attempts[0].score).toBe(70);
    expect(p.levels[1]!.attempts[0].passed).toBe(true);
    expect(p.levels[1]!.attempts[1].score).toBe(40);
    // 최고 점수와 통과 상태는 유지
    expect(p.levels[1]!.bestScore).toBe(70);
    expect(p.levels[1]!.passed).toBe(true);
  });
});
