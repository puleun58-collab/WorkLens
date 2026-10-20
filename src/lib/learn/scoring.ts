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
 * - 통과 기준: 전 단계 80점 이상
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

/** 문자열 시드 해시 (attemptId 등 → 32bit 정수) */
export function seedFromString(text: string): number {
  let seed = 0;
  for (const ch of text) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  return seed;
}

/**
 * 문항 내용 지문 — 채점에 영향을 주는 내용(유형·질문·선택지·정답·실습 과제)이
 * 바뀌었는지를 판정한다. 진행 중 응시를 복원할 때 응시 시작 당시 문항과
 * 현재 문제은행 문항이 같은지 검증하는 용도로만 사용한다.
 */
export function questionFingerprint(question: LearnQuestion): number {
  // 선택지·정답 집합은 표시 순서와 무관하게 같은 지문이 되도록 ID 순으로 정렬한다
  const choices = question.choices
    ? [...question.choices].sort((a, b) => (a.id < b.id ? -1 : 1)).map((c) => [c.id, c.text])
    : null;
  const correct = question.correctChoiceIds ? [...question.correctChoiceIds].sort() : null;
  return seedFromString(
    JSON.stringify([question.type, question.prompt, choices, correct, question.oxAnswer ?? null, question.terminalTask ?? null]),
  );
}

/**
 * 단위별 출제 쿼터 배분 — 출제 문항 수를 학습 단위 수로 나눈 몫을 기본으로 하고,
 * 나머지는 문제은행이 큰 단위부터 +1 한다. 은행이 쿼터보다 작은 단위는 있는 만큼만
 * 배정하고 부족분은 여유가 있는 단위에 재배분한다.
 * @returns 단위 ID → 출제 문항 수
 */
export function allocateUnitQuotas(
  unitIds: string[],
  bankSizeByUnit: Map<string, number>,
  totalCount: number,
): Map<string, number> {
  const quotas = new Map<string, number>(unitIds.map((id) => [id, 0]));
  if (unitIds.length === 0 || totalCount <= 0) return quotas;
  const base = Math.floor(totalCount / unitIds.length);
  const remainder = totalCount % unitIds.length;
  // 나머지를 줄 단위 순서: 은행 크기 내림차순, 동률은 커리큘럼 순서
  const byBankSize = [...unitIds].sort(
    (a, b) => (bankSizeByUnit.get(b) ?? 0) - (bankSizeByUnit.get(a) ?? 0) || unitIds.indexOf(a) - unitIds.indexOf(b),
  );
  for (const id of unitIds) quotas.set(id, base);
  for (let i = 0; i < remainder; i++) {
    const id = byBankSize[i];
    quotas.set(id, (quotas.get(id) ?? 0) + 1);
  }
  // 은행 크기를 넘는 쿼터는 회수해 여유 있는 단위에 재배분
  let deficit = 0;
  for (const id of unitIds) {
    const cap = bankSizeByUnit.get(id) ?? 0;
    if ((quotas.get(id) ?? 0) > cap) {
      deficit += (quotas.get(id) ?? 0) - cap;
      quotas.set(id, cap);
    }
  }
  while (deficit > 0) {
    const spare = byBankSize.filter((id) => (quotas.get(id) ?? 0) < (bankSizeByUnit.get(id) ?? 0));
    if (spare.length === 0) break;
    for (const id of spare) {
      if (deficit <= 0) break;
      quotas.set(id, (quotas.get(id) ?? 0) + 1);
      deficit--;
    }
  }
  return quotas;
}

/**
 * 출제 문항 선정 — 검증된(verified) 문제만 사용한다.
 *
 * 1. 학습 단위별로 균형 있게 배분한다 (모든 단위가 출제에 포함된다).
 * 2. 직전 응시 문항을 후순위로 밀어 재응시 시 동일 세트 반복을 최소화한다.
 * 3. 최종 순서는 attemptId 시드로 섞는다 — 응시 시작 시 1회만 구성하고
 *    응시가 끝날 때까지 고정한다 (렌더링마다 다시 섞지 않는다).
 */
export function selectQuizQuestions(
  level: LearnLevelNo,
  bank: LearnQuestion[],
  attemptId: string,
  unitIds: string[] = [],
  previousQuestionIds: string[] = [],
): LearnQuestion[] {
  const meta = levelMeta(level);
  const verified = bank.filter((q) => q.level === level && q.verified);
  if (verified.length < meta.questionCount) {
    throw new Error(`LEVEL ${level} 검증된 문제가 부족합니다 (${verified.length}/${meta.questionCount})`);
  }
  const seed = seedFromString(attemptId);
  const units = unitIds.length > 0 ? unitIds : [...new Set(verified.map((q) => q.unitId ?? ""))].filter(Boolean);
  // 단위 연결이 없는 문항은 균형 출제 대상에서 제외한다 (연결 검증은 테스트가 강제)
  const linked = verified.filter((q) => q.unitId && units.includes(q.unitId));
  if (linked.length < meta.questionCount || units.length === 0) {
    // 단위 정보를 사용할 수 없는 경우의 폴백: 전체에서 시드 셔플 선택
    return seededShuffle(verified, seed).slice(0, meta.questionCount);
  }
  const byUnit = new Map<string, LearnQuestion[]>(units.map((id) => [id, []]));
  for (const q of linked) byUnit.get(q.unitId!)!.push(q);
  const quotas = allocateUnitQuotas(units, new Map(units.map((id) => [id, byUnit.get(id)!.length])), meta.questionCount);
  const prev = new Set(previousQuestionIds);
  const selected: LearnQuestion[] = [];
  units.forEach((unitId, unitIndex) => {
    const pool = byUnit.get(unitId)!;
    const quota = quotas.get(unitId) ?? 0;
    if (quota <= 0) return;
    // 직전 응시에 없던 문제를 먼저 뽑아 세트 반복을 줄인다
    const fresh = pool.filter((q) => !prev.has(q.id));
    const stale = pool.filter((q) => prev.has(q.id));
    const ordered = [
      ...seededShuffle(fresh, seed + unitIndex * 101),
      ...seededShuffle(stale, seed + unitIndex * 101 + 7),
    ];
    selected.push(...ordered.slice(0, quota));
  });
  return seededShuffle(selected, seed + 9999);
}

/**
 * 선택지 표시 순서 무작위화 — 응시 시작 시 1회만 적용한다.
 * 채점은 선택지 ID 기준이므로 표시 순서가 바뀌어도 정답 판정은 달라지지 않는다.
 * OX는 선택지가 없고, terminal-task는 선택지가 없어 그대로 둔다.
 */
export function shuffleQuestionChoices(questions: LearnQuestion[], attemptId: string): LearnQuestion[] {
  return questions.map((q) => {
    if (!q.choices || q.choices.length < 2 || q.type === "ox") return q;
    const shuffled = seededShuffle(q.choices, seedFromString(`${attemptId}:${q.id}`));
    return { ...q, choices: shuffled };
  });
}

/** 단계 해제 가능 여부 — LEVEL 1은 항상, 이후는 이전 단계 통과 필요 */
export function canUnlockLevel(level: LearnLevelNo, progress: LearnProgress): boolean {
  if (level === 1) return true;
  return progress.levels[(level - 1) as LearnLevelNo]?.passed === true;
}

/**
 * 응시 기록을 진도에 반영 — 최고 점수 보존, 통과 상태 유지
 *
 * 멱등성: 같은 attemptId의 응시가 이미 반영되어 있으면 다시 적용하지 않는다.
 * (제출 버튼 연속 클릭, 저장 실패 후 재시도, 다른 탭에서 같은 응시 제출 시에도
 * 완료 기록과 오답 데이터가 중복 생성되지 않는다)
 *
 * 오답 항목에는 응시 당시 정보(문제·선택지·정답·내 답변)를 스냅샷으로 함께
 * 저장한다. 응시 이력이 보관 한도를 넘어 정리되어도 오답 노트가 실제 응시를
 * 참조할 수 있게 하기 위함이며, 스냅샷은 응시 시점 값 그대로 고정된다.
 *
 * @param questions 출제된 문제 목록 (오답 카테고리·스냅샷 연결용, 생략 시 카테고리는 빈 문자열)
 */
export function applyAttempt(progress: LearnProgress, attempt: QuizAttempt, questions?: LearnQuestion[]): LearnProgress {
  const prev = progress.levels[attempt.level];
  // 동일 응시의 중복 반영 방지 — 이미 기록된 응시면 진도를 그대로 반환한다
  if (prev?.attempts.some((a) => a.attemptId === attempt.attemptId)) return progress;
  const bestScore = Math.max(prev?.bestScore ?? 0, attempt.score);
  const passed = (prev?.passed ?? false) || attempt.passed;
  const attempts = [...(prev?.attempts ?? []), attempt].slice(-20); // 최근 20회만 보관
  const questionById = new Map((questions ?? []).map((q) => [q.id, q]));
  const knownWrongKeys = new Set(progress.wrongAnswers.map((w) => `${w.attemptId}:${w.questionId}`));
  const wrongAnswers = [...progress.wrongAnswers];
  for (const g of attempt.graded) {
    if (!g.correct) {
      if (!attempt.questionIds.includes(g.questionId)) continue;
      // 같은 응시·같은 문항의 오답은 중복 생성하지 않는다
      const key = `${attempt.attemptId}:${g.questionId}`;
      if (knownWrongKeys.has(key)) continue;
      knownWrongKeys.add(key);
      const question = questionById.get(g.questionId);
      // 문제은행에 존재하지 않는 ID는 임의 카테고리로 대체하지 않는다
      const category = question?.category ?? "";
      wrongAnswers.push({
        questionId: g.questionId,
        level: attempt.level,
        category,
        attemptId: attempt.attemptId,
        answeredAt: attempt.finishedAt,
        reviewCount: 0,
        // 응시 당시 스냅샷 — 문항 정보가 있을 때만 기록하고, 없으면 조회 기반 복원에 맡긴다
        ...(question
          ? {
              unitId: question.unitId,
              prompt: question.prompt,
              questionType: question.type,
              choices: orderedChoicesSnapshot(question, attempt),
              correctChoiceIds: question.correctChoiceIds,
              oxAnswer: question.oxAnswer,
              explanation: question.explanation,
              myAnswer: attempt.answers[g.questionId],
            }
          : {}),
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

/** 오답 스냅샷용 선택지 — 응시 당시 표시 순서(choiceOrder)대로 고정한다 */
function orderedChoicesSnapshot(
  question: LearnQuestion,
  attempt: QuizAttempt,
): { id: string; text: string }[] | undefined {
  if (!question.choices) return undefined;
  const snapshot = question.choices.map((c) => ({ id: c.id, text: c.text }));
  const order = attempt.choiceOrder?.[question.id];
  if (!order) return snapshot;
  const byId = new Map(snapshot.map((c) => [c.id, c]));
  const ordered = order.map((id) => byId.get(id)).filter((c) => c !== undefined);
  return ordered.length === snapshot.length ? ordered : snapshot;
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

/**
 * 취약 개념 집계 — 오답 노트에서 카테고리별 오답 횟수
 * @param resolveCategory 기존 빈 카테고리 기록의 복원용 조회 함수 (읽기 시 보완, 원본 불변).
 *                        복원 불가능한 항목은 집계에서 제외한다.
 */
export function weakCategories(
  progress: LearnProgress,
  resolveCategory?: (questionId: string) => string | undefined,
): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const w of progress.wrongAnswers) {
    // 기존 category:"" 기록은 문제 ID로 실제 카테고리 복원 시도
    const category = w.category || resolveCategory?.(w.questionId) || "";
    if (!category) continue;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
}

/** 응시 ID 생성 */
export function newAttemptId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
