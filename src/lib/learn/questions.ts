import type { LearnLevelNo, LearnQuestion } from "./types";

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
