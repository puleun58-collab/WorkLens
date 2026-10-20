import type { LearnLevelNo, LearnQuestion, QuizAttempt } from "./types";
import { levelContent } from "./content";

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
