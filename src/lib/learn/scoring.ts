import { levelMeta } from "./curriculum";
import type {
  GradedItem,
  LearnLevelNo,
  LearnProgress,
  LearnQuestion,
  LearnerAnswer,
  QuizAttempt,
} from "./types";

/** 정답 집합 비교 (순서 무관, 완전 일치) */
function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** 단일 문항 채점 — 결정적 규칙, 부분 점수 없음 */
export function gradeQuestion(question: LearnQuestion, answer: LearnerAnswer | undefined): boolean {
  if (!answer) return false; // 미응답은 오답
  switch (question.type) {
    case "single":
    case "command-result":
    case "error-cause":
    case "case-judgment":
      if (answer.kind !== "choices") return false;
      return sameIdSet(answer.selectedChoiceIds, question.correctChoiceIds ?? []);
    case "multiple":
      if (answer.kind !== "choices") return false;
      return sameIdSet(answer.selectedChoiceIds, question.correctChoiceIds ?? []);
    case "ox":
      if (answer.kind !== "ox") return false;
      return answer.answer === question.oxAnswer;
    case "terminal-task":
      if (answer.kind !== "terminal") return false;
      return answer.passed;
  }
}

/**
 * 퀴즈 채점 — 출제 문항 수 × 문항당 배점으로 100점 만점 환산.
 * - LEVEL 1~9: 문항당 10점, LEVEL 10: 문항당 5점
 * - 통과 기준: 단계별 passScore 이상
 */
export function gradeQuiz(level: LearnLevelNo, questions: LearnQuestion[], answers: Record<string, LearnerAnswer>): { graded: GradedItem[]; score: number; passed: boolean } {
  const meta = levelMeta(level);
  const graded: GradedItem[] = questions.map((q) => {
    const correct = gradeQuestion(q, answers[q.id]);
    return { questionId: q.id, correct, points: correct ? meta.pointsPerQuestion : 0 };
  });
  const score = graded.reduce((sum, g) => sum + g.points, 0);
  return { graded, score, passed: score >= meta.passScore };
}

/** 시드 기반 결정적 셔플 (Fisher-Yates + mulberry32) */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  const result = [...items];
  let s = seed >>> 0;
  const rand = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * 출제 문항 선정 — 검증된(verified) 문제만 사용하고,
 * attemptId 기반 시드로 결정적으로 섞은 뒤 단계별 문항 수만큼 선택한다.
 */
export function selectQuizQuestions(level: LearnLevelNo, bank: LearnQuestion[], attemptId: string): LearnQuestion[] {
  const meta = levelMeta(level);
  const verified = bank.filter((q) => q.level === level && q.verified);
  if (verified.length < meta.questionCount) {
    throw new Error(`LEVEL ${level} 검증된 문제가 부족합니다 (${verified.length}/${meta.questionCount})`);
  }
  let seed = 0;
  for (const ch of attemptId) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  return seededShuffle(verified, seed).slice(0, meta.questionCount);
}

/** 단계 해제 가능 여부 — LEVEL 1은 항상, 이후는 이전 단계 통과 필요 */
export function canUnlockLevel(level: LearnLevelNo, progress: LearnProgress): boolean {
  if (level === 1) return true;
  return progress.levels[(level - 1) as LearnLevelNo]?.passed === true;
}

/** 응시 기록을 진도에 반영 — 최고 점수 보존, 통과 상태 유지 */
export function applyAttempt(progress: LearnProgress, attempt: QuizAttempt): LearnProgress {
  const prev = progress.levels[attempt.level];
  const bestScore = Math.max(prev?.bestScore ?? 0, attempt.score);
  const passed = (prev?.passed ?? false) || attempt.passed;
  const attempts = [...(prev?.attempts ?? []), attempt].slice(-20); // 최근 20회만 보관
  const wrongAnswers = [...progress.wrongAnswers];
  for (const g of attempt.graded) {
    if (!g.correct) {
      const q = attempt.questionIds.includes(g.questionId) ? g.questionId : null;
      if (!q) continue;
      wrongAnswers.push({
        questionId: g.questionId,
        level: attempt.level,
        category: "",
        attemptId: attempt.attemptId,
        answeredAt: attempt.finishedAt,
        reviewCount: 0,
      });
    }
  }
  return {
    ...progress,
    levels: { ...progress.levels, [attempt.level]: { passed, bestScore, attempts, lastStudiedUnitId: prev?.lastStudiedUnitId } },
    wrongAnswers: wrongAnswers.slice(-200), // 최근 200개만 보관
    updatedAt: Date.now(),
  };
}

/** 전체 진행률 (통과한 단계 수 / 10) */
export function overallProgress(progress: LearnProgress): { passed: number; total: number; percent: number } {
  const passed = ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as LearnLevelNo[]).filter((l) => progress.levels[l]?.passed).length;
  return { passed, total: 10, percent: Math.round((passed / 10) * 100) };
}

/** 학습 완료 여부 — 10단계 모두 통과 */
export function isLearningComplete(progress: LearnProgress): boolean {
  return ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as LearnLevelNo[]).every((l) => progress.levels[l]?.passed === true);
}

/** 취약 개념 집계 — 오답 노트에서 카테고리별 오답 횟수 */
export function weakCategories(progress: LearnProgress): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const w of progress.wrongAnswers) {
    if (!w.category) continue;
    counts.set(w.category, (counts.get(w.category) ?? 0) + 1);
  }
  return [...counts.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
}

/** 응시 ID 생성 */
export function newAttemptId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
