import type { InProgressQuiz, LearnLevelNo, LearnQuestion, QuizAttempt } from "./types";
import { levelContent } from "./content";
import { questionFingerprint } from "./scoring";

// 단계별 문제은행은 questions-l01.ts ~ questions-l10.ts 에서 정의한다.
import { QUESTIONS_L01 } from "./questions-l01";
import { QUESTIONS_L02 } from "./questions-l02";
import { QUESTIONS_L03 } from "./questions-l03";
import { QUESTIONS_L04 } from "./questions-l04";
import { QUESTIONS_L05 } from "./questions-l05";
import { QUESTIONS_L06 } from "./questions-l06";
import { QUESTIONS_L07 } from "./questions-l07";
import { QUESTIONS_L08 } from "./questions-l08";
import { QUESTIONS_L09 } from "./questions-l09";
import { QUESTIONS_L10 } from "./questions-l10";
import { DIAGNOSTIC_QUESTIONS } from "./questions-diagnostic";

const BANKS: Record<LearnLevelNo, LearnQuestion[]> = {
  1: QUESTIONS_L01,
  2: QUESTIONS_L02,
  3: QUESTIONS_L03,
  4: QUESTIONS_L04,
  5: QUESTIONS_L05,
  6: QUESTIONS_L06,
  7: QUESTIONS_L07,
  8: QUESTIONS_L08,
  9: QUESTIONS_L09,
  10: QUESTIONS_L10,
};

export function questionBank(level: LearnLevelNo): LearnQuestion[] {
  return BANKS[level] ?? [];
}

export function allQuestions(): LearnQuestion[] {
  return ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as LearnLevelNo[]).flatMap((l) => BANKS[l] ?? []);
}

export function findQuestion(id: string): LearnQuestion | undefined {
  return allQuestions().find((q) => q.id === id);
}

/** 사전 진단 문제 */
export function diagnosticQuestions(): LearnQuestion[] {
  return DIAGNOSTIC_QUESTIONS;
}

/** 문제에 연결된 학습 단위 — 단위가 변경·제거됐거나 연결이 없으면 undefined */
export function linkedUnitForQuestion(q: LearnQuestion) {
  if (!q.unitId) return undefined;
  return levelContent(q.level).units.find((u) => u.id === q.unitId);
}

/** 응시 당시 표시 순서대로 선택지를 정렬한다 (기록이 없으면 문제은행 순서) */
export function orderedChoicesForAttempt(q: LearnQuestion, attempt?: QuizAttempt) {
  if (!q.choices) return undefined;
  const order = attempt?.choiceOrder?.[q.id];
  if (!order) return q.choices;
  const byId = new Map(q.choices.map((c) => [c.id, c]));
  const ordered = order.map((id) => byId.get(id)).filter((c) => c !== undefined);
  return ordered.length === q.choices.length ? ordered : q.choices;
}

/**
 * 진행 중 응시의 문제 세트를 복원한다.
 *
 * - 문제 순서와 선택지 표시 순서는 저장된 기록 그대로 재현한다 (다시 섞지 않는다).
 * - 문항이 문제은행에서 사라졌거나 응시 시작 후 내용이 바뀐(지문 불일치) 경우
 *   잘못된 문제·정답으로 임의 대체하지 않고 null을 반환한다 — 호출자는
 *   복원 불가 안내와 새로 시작 동선을 제공해야 한다.
 */
export function restoreQuizQuestions(inProgress: InProgressQuiz): LearnQuestion[] | null {
  const restored: LearnQuestion[] = [];
  for (const questionId of inProgress.questionIds) {
    const question = findQuestion(questionId);
    if (!question) return null;
    if (inProgress.questionChecks[questionId] !== questionFingerprint(question)) return null;
    const order = inProgress.choiceOrder[questionId];
    if (question.choices && order) {
      const byId = new Map(question.choices.map((c) => [c.id, c]));
      const ordered = order.map((id) => byId.get(id)).filter((c) => c !== undefined);
      if (ordered.length !== question.choices.length) return null;
      restored.push({ ...question, choices: ordered });
    } else {
      restored.push(question);
    }
  }
  return restored;
}
