import { describe, expect, test } from "vitest";
import { ALL_LEVELS, LEVEL_METAS, levelMeta } from "@/lib/learn/curriculum";
import { levelContent } from "@/lib/learn/content";
import { questionBank } from "@/lib/learn/questions";
import {
  allocateUnitQuotas,
  applyAttempt,
  canUnlockLevel,
  gradeQuestion,
  gradeQuiz,
  isLearningComplete,
  overallProgress,
  selectQuizQuestions,
  seededShuffle,
  shuffleQuestionChoices,
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
  test("LEVEL 1: 문항당 10점, 70점은 미통과 (80점 통일 기준)", () => {
    const questions = Array.from({ length: 10 }, (_, i) => ({ ...singleQ, id: `l1-q${i}` }));
    const answers = Object.fromEntries(questions.slice(0, 7).map((q) => [q.id, { kind: "choices", selectedChoiceIds: ["b"] }]));
    const { score, passed } = gradeQuiz(1, questions, answers as never);
    expect(score).toBe(70);
    expect(passed).toBe(false);
  });
  test("LEVEL 1: 80점이면 통과, 90·100점도 통과", () => {
    const questions = Array.from({ length: 10 }, (_, i) => ({ ...singleQ, id: `l1-q${i}` }));
    for (const correctCount of [8, 9, 10]) {
      const answers = Object.fromEntries(questions.slice(0, correctCount).map((q) => [q.id, { kind: "choices", selectedChoiceIds: ["b"] }]));
      const { score, passed } = gradeQuiz(1, questions, answers as never);
      expect(score).toBe(correctCount * 10);
      expect(passed).toBe(true);
    }
  });
  test("LEVEL 10: 문항당 5점, 75점 미통과·80점 통과", () => {
    const q10 = { ...singleQ, level: 10 as const, id: "l10-q001" };
    const questions = Array.from({ length: 20 }, (_, i) => ({ ...q10, id: `l10-q${i}` }));
    const grade = (correctCount: number) => {
      const answers = Object.fromEntries(questions.slice(0, correctCount).map((q) => [q.id, { kind: "choices", selectedChoiceIds: ["b"] }]));
      return gradeQuiz(10, questions, answers as never);
    };
    expect(grade(15)).toEqual(expect.objectContaining({ score: 75, passed: false }));
    expect(grade(16)).toEqual(expect.objectContaining({ score: 80, passed: true }));
    expect(grade(17)).toEqual(expect.objectContaining({ score: 85, passed: true }));
    expect(grade(20)).toEqual(expect.objectContaining({ score: 100, passed: true }));
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

describe("통과 기준 80점 통일", () => {
  test("LEVEL 1~10 메타데이터의 통과 기준이 모두 80점", () => {
    for (const meta of LEVEL_METAS) {
      expect(meta.passScore, `LEVEL ${meta.level}`).toBe(80);
    }
  });
  test("구 기준(70점)으로 통과한 기록은 해제 상태를 유지한다", () => {
    // passScore 필드가 없는 과거 기록 — 당시 기준으로 passed=true 판정된 상태
    const legacy = emptyProgress();
    legacy.levels[1] = {
      passed: true,
      bestScore: 70,
      attempts: [{
        attemptId: "legacy-1", level: 1, questionIds: ["l1-q001"], answers: {},
        graded: [{ questionId: "l1-q001", correct: true, points: 10 }],
        score: 70, passed: true, startedAt: 0, finishedAt: 1,
      }],
    };
    expect(canUnlockLevel(2, legacy)).toBe(true);
    // 새 기준으로 미통과 응시를 추가해도 통과·해제는 유지되고 과거 기록은 원본 그대로
    const next = applyAttempt(legacy, {
      attemptId: "new-1", level: 1, questionIds: ["l1-q001"], answers: {},
      graded: [{ questionId: "l1-q001", correct: false, points: 0 }],
      score: 50, passed: false, passScore: 80, startedAt: 2, finishedAt: 3,
    });
    expect(next.levels[1]?.passed).toBe(true);
    expect(canUnlockLevel(2, next)).toBe(true);
    expect(next.levels[1]?.attempts[0].score).toBe(70);
    expect(next.levels[1]?.attempts[0].passScore).toBeUndefined();
    expect(next.levels[1]?.attempts[1].passScore).toBe(80);
  });
});

describe("allocateUnitQuotas", () => {
  test("균등 배분 + 나머지는 은행이 큰 단위부터", () => {
    const quotas = allocateUnitQuotas(
      ["u1", "u2", "u3", "u4", "u5", "u6"],
      new Map([["u1", 3], ["u2", 16], ["u3", 6], ["u4", 6], ["u5", 6], ["u6", 3]]),
      20,
    );
    expect([...quotas.values()].reduce((a, b) => a + b, 0)).toBe(20);
    expect(quotas.get("u2")).toBe(4);
    expect(quotas.get("u3")).toBe(4);
    expect(quotas.get("u1")).toBe(3);
    expect(quotas.get("u6")).toBe(3);
  });
  test("은행이 부족한 단위는 있는 만큼만, 부족분은 여유 단위로", () => {
    const quotas = allocateUnitQuotas(
      ["u1", "u2"],
      new Map([["u1", 1], ["u2", 10]]),
      6,
    );
    expect(quotas.get("u1")).toBe(1);
    expect(quotas.get("u2")).toBe(5);
  });
});

describe("단위별 균형 출제 (실제 문제은행)", () => {
  for (const level of ALL_LEVELS) {
    test(`LEVEL ${level}: 모든 단위에서 출제되고 중복이 없다`, () => {
      const meta = levelMeta(level);
      const unitIds = levelContent(level).units.map((u) => u.id);
      const bank = questionBank(level);
      const bankSizes = new Map(unitIds.map((id) => [id, bank.filter((q) => q.unitId === id && q.verified).length]));
      const expected = allocateUnitQuotas(unitIds, bankSizes, meta.questionCount);
      for (const attemptNo of [1, 2, 3]) {
        const selected = selectQuizQuestions(level, bank, `attempt-${level}-${attemptNo}`, unitIds);
        expect(selected).toHaveLength(meta.questionCount);
        expect(new Set(selected.map((q) => q.id)).size).toBe(meta.questionCount);
        const counts = new Map<string, number>();
        for (const q of selected) counts.set(q.unitId!, (counts.get(q.unitId!) ?? 0) + 1);
        for (const unitId of unitIds) {
          expect(counts.get(unitId) ?? 0, `LEVEL ${level} ${unitId}`).toBe(expected.get(unitId));
        }
      }
    });
  }
  test("재응시에서는 직전 응시와 겹치지 않는 문항을 우선 출제한다", () => {
    // 단위당 은행 4문항·출제 2문항인 LEVEL 1: 직전 문항을 모두 피할 수 있어야 한다
    const unitIds = levelContent(1).units.map((u) => u.id);
    const bank = questionBank(1);
    const first = selectQuizQuestions(1, bank, "first-attempt", unitIds);
    const second = selectQuizQuestions(1, bank, "second-attempt", unitIds, first.map((q) => q.id));
    const overlap = second.filter((q) => first.some((f) => f.id === q.id));
    // 단위별 은행이 쿼터의 2배 미만인 단위(l1-u3: 2문항)만 겹침 허용
    const overlapUnits = new Set(overlap.map((q) => q.unitId));
    expect([...overlapUnits].every((id) => (bank.filter((q) => q.unitId === id).length) < 4)).toBe(true);
  });
  test("서로 다른 응시는 문제 구성·순서가 달라진다", () => {
    const unitIds = levelContent(1).units.map((u) => u.id);
    const bank = questionBank(1);
    const a = selectQuizQuestions(1, bank, "seed-a", unitIds).map((q) => q.id);
    const b = selectQuizQuestions(1, bank, "seed-b", unitIds).map((q) => q.id);
    expect(a).not.toEqual(b);
  });
});

describe("shuffleQuestionChoices", () => {
  test("선택지 순서가 바뀌어도 채점 결과는 동일하다", () => {
    const shuffled = shuffleQuestionChoices([singleQ, multiQ], "attempt-x");
    for (const q of shuffled) {
      expect([...(q.choices ?? [])].map((c) => c.id).sort()).toEqual([...(q.id === singleQ.id ? singleQ : multiQ).choices!].map((c) => c.id).sort());
    }
    expect(gradeQuestion(shuffled[0], { kind: "choices", selectedChoiceIds: ["b"] })).toBe(true);
    expect(gradeQuestion(shuffled[0], { kind: "choices", selectedChoiceIds: ["a"] })).toBe(false);
    expect(gradeQuestion(shuffled[1], { kind: "choices", selectedChoiceIds: ["c", "a"] })).toBe(true);
  });
  test("여러 응시 중 최소 한 번은 선택지 순서가 원본과 달라진다", () => {
    const original = (singleQ.choices ?? []).map((c) => c.id).join(",");
    const orders = new Set(
      Array.from({ length: 12 }, (_, i) => shuffleQuestionChoices([singleQ], `seed-${i}`)[0].choices!.map((c) => c.id).join(",")),
    );
    expect(orders.size).toBeGreaterThan(1);
    expect([...orders].some((o) => o !== original)).toBe(true);
  });
  test("OX 문제는 그대로 둔다", () => {
    expect(shuffleQuestionChoices([oxQ], "attempt-x")[0]).toBe(oxQ);
  });
  test("같은 attemptId는 같은 선택지 순서 (응시 중 고정)", () => {
    const a = shuffleQuestionChoices([singleQ], "fixed-seed")[0].choices!.map((c) => c.id);
    const b = shuffleQuestionChoices([singleQ], "fixed-seed")[0].choices!.map((c) => c.id);
    expect(a).toEqual(b);
  });
});
