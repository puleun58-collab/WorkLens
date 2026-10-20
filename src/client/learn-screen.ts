import type { LearnLevelNo } from "@/lib/learn/types";

/**
 * 학습센터 현재 화면 상태 공유 (렌즈봇 화면 인식용).
 *
 * LearnCenterView와 그 하위 화면(학습하기·퀴즈)이 현재 화면 정보를 발행하고,
 * 렌즈봇 위젯이 질문 전송 시점에 읽는다. 렌더링과 무관한 모듈 상태이며,
 * 학습 진도 데이터 자체는 포함하지 않는다 (응시 기록은 위젯이 저장소에서 직접 읽는다).
 */
export type LearnScreenMode =
  | "dashboard" | "lesson" | "quiz" | "result" | "wrongnotes" | "diagnostic" | "certificate";

export interface LearnScreenState {
  mode: LearnScreenMode;
  level?: LearnLevelNo;
  unitId?: string;
  questionId?: string;
  attemptId?: string;
}

let current: LearnScreenState | null = null;

/** 부분 갱신 발행 — patch에 포함된 키만 덮어쓴다 (undefined를 넣으면 해당 키를 지운다). */
export function publishLearnScreen(patch: Partial<LearnScreenState>): void {
  const next: LearnScreenState = current ? { ...current } : { mode: "dashboard" };
  for (const key of Object.keys(patch) as (keyof LearnScreenState)[]) {
    const value = patch[key];
    if (value === undefined) delete next[key];
    else (next as unknown as Record<string, unknown>)[key] = value;
  }
  current = next;
}

export function readLearnScreen(): LearnScreenState | null {
  return current;
}

export function clearLearnScreen(): void {
  current = null;
}
