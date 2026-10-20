import { levelContent } from "@/lib/learn/content";
import { ALL_LEVELS, levelMeta } from "@/lib/learn/curriculum";
import { findQuestion, linkedUnitForQuestion, orderedChoicesForAttempt, questionBank } from "@/lib/learn/questions";
import { gradeQuiz } from "@/lib/learn/scoring";
import type { GradedItem, LearnerAnswer, LearnLevelNo, LearnQuestion, LearnUnit, QuizAttempt } from "@/lib/learn/types";
import type { AssistantEvidence } from "./evidence";

/**
 * 학습센터 연동 근거·검증 모듈 (서버 전용 순수 함수).
 *
 * 원칙:
 * - 학습 콘텐츠는 src/lib/learn의 실제 데이터에서만 생성한다 (렌즈봇용 별도 하드코딩 금지).
 * - 문제은행의 정답·해설은 "제출 완료가 서버에서 검증된 응시"의 근거로만 포함한다.
 *   퀴즈 응시 중이거나 검증되지 않은 경우, 정답·해설은 근거 자체에 넣지 않는다.
 */

export type LearnScreenMode =
  | "dashboard" | "lesson" | "quiz" | "result" | "wrongnotes" | "diagnostic" | "certificate";

/** 클라이언트가 보낸 제출 완료 응시 주장 (신뢰하지 않음 — 서버에서 재채점으로 검증한다). */
export interface RawSubmittedAttempt {
  attemptId: string;
  level: number;
  questionIds: string[];
  answers: Record<string, LearnerAnswer>;
  graded: GradedItem[];
  score: number;
  passed: boolean;
  passScore?: number;
  choiceOrder?: Record<string, string[]>;
  startedAt: number;
  finishedAt: number;
}

/** 클라이언트가 보낸 학습 화면 정보 (신뢰하지 않음 — 서버에서 실제 데이터로 검증한다). */
export interface RawLearnContext {
  mode: LearnScreenMode;
  level?: number;
  unitId?: string;
  questionId?: string;
  attempt?: RawSubmittedAttempt;
}

/** 검증이 끝난 학습 화면 컨텍스트. */
export interface LearnAssistantContext {
  mode: LearnScreenMode;
  level?: LearnLevelNo;
  unit?: LearnUnit;
  /** 응시 중인 현재 문항 (정답·해설은 근거에 절대 포함하지 않는다). */
  quizQuestion?: LearnQuestion;
  /** 제출 완료가 서버 재채점으로 검증된 응시. */
  verifiedAttempt?: { attempt: QuizAttempt; questions: LearnQuestion[] };
  /** 응시가 전달됐지만 검증에 실패한 경우 true — 오답을 추측하지 않도록 프롬프트에 명시한다. */
  attemptRejected?: boolean;
  focusQuestionId?: string;
}

const LEGACY_PASS_SCORES: Record<LearnLevelNo, number> = {
  1: 70, 2: 70, 3: 70, 4: 75, 5: 75, 6: 80, 7: 80, 8: 80, 9: 80, 10: 85,
};

function isLevelNo(value: number | undefined): value is LearnLevelNo {
  return value !== undefined && Number.isInteger(value) && value >= 1 && value <= 10;
}

/**
 * 제출 완료 응시 검증: 클라이언트가 보낸 응시 기록을 문제은행 원본으로 다시 채점해
 * 문항 구성·문항별 정오·점수·통과 여부가 모두 일치할 때만 제출 완료로 인정한다.
 * 클라이언트 값만으로 정답 공개 권한을 인정하지 않기 위한 서버 측 검증이다.
 */
export function verifySubmittedAttempt(raw: RawSubmittedAttempt): { attempt: QuizAttempt; questions: LearnQuestion[] } | null {
  if (!raw || typeof raw !== "object") return null;
  if (!isLevelNo(raw.level)) return null;
  const meta = levelMeta(raw.level);
  if (typeof raw.attemptId !== "string" || !raw.attemptId) return null;
  if (!Array.isArray(raw.questionIds) || raw.questionIds.length !== meta.questionCount) return null;
  if (new Set(raw.questionIds).size !== raw.questionIds.length) return null;
  const bank = new Map(questionBank(raw.level).map((q) => [q.id, q]));
  const questions: LearnQuestion[] = [];
  for (const id of raw.questionIds) {
    const q = bank.get(id);
    if (!q) return null;
    questions.push(q);
  }
  if (!raw.answers || typeof raw.answers !== "object") return null;
  if (!Array.isArray(raw.graded) || raw.graded.length !== questions.length) return null;
  if (typeof raw.startedAt !== "number" || typeof raw.finishedAt !== "number") return null;
  if (!(raw.finishedAt >= raw.startedAt) || raw.finishedAt > Date.now() + 5 * 60_000) return null;

  const recomputed = gradeQuiz(raw.level, questions, raw.answers);
  const gradedById = new Map(raw.graded.map((g) => [g.questionId, g]));
  for (const item of recomputed.graded) {
    const claimed = gradedById.get(item.questionId);
    if (!claimed || claimed.correct !== item.correct || claimed.points !== item.points) return null;
  }
  if (raw.score !== recomputed.score) return null;
  const threshold = typeof raw.passScore === "number" ? raw.passScore : LEGACY_PASS_SCORES[raw.level];
  if (raw.passed !== (recomputed.score >= threshold)) return null;
  const attempt: QuizAttempt = {
    attemptId: raw.attemptId,
    level: raw.level,
    questionIds: raw.questionIds,
    answers: raw.answers,
    graded: raw.graded,
    score: raw.score,
    passed: raw.passed,
    ...(typeof raw.passScore === "number" ? { passScore: raw.passScore } : {}),
    ...(raw.choiceOrder ? { choiceOrder: raw.choiceOrder } : {}),
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
  };
  return { attempt, questions };
}

/** 클라이언트 학습 화면 정보를 실제 학습 데이터 기준으로 검증·정규화한다. */
export function sanitizeLearnContext(raw: RawLearnContext | undefined): LearnAssistantContext | undefined {
  if (!raw) return undefined;
  const ctx: LearnAssistantContext = { mode: raw.mode };
  const level = isLevelNo(raw.level) ? raw.level : undefined;
  if (level) ctx.level = level;

  if (raw.mode === "lesson" && level && raw.unitId) {
    const unit = levelContent(level).units.find((u) => u.id === raw.unitId);
    if (unit) ctx.unit = unit;
  }
  if (raw.mode === "quiz" && raw.questionId) {
    const q = findQuestion(raw.questionId);
    if (q) {
      ctx.quizQuestion = q;
      ctx.level = q.level;
    }
  }
  if ((raw.mode === "result" || raw.mode === "wrongnotes") && raw.attempt) {
    const verified = verifySubmittedAttempt(raw.attempt);
    if (verified) {
      ctx.verifiedAttempt = verified;
      ctx.level = verified.attempt.level;
    } else {
      ctx.attemptRejected = true;
    }
    if (raw.questionId && ctx.verifiedAttempt?.attempt.questionIds.includes(raw.questionId)) {
      ctx.focusQuestionId = raw.questionId;
    }
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// 학습 단위 검색
// ---------------------------------------------------------------------------

interface UnitIndexEntry {
  level: LearnLevelNo;
  unit: LearnUnit;
  searchable: string;
  terms: string[];
  categories: string[];
}

let unitIndexCache: UnitIndexEntry[] | null = null;

function unitIndex(): UnitIndexEntry[] {
  if (unitIndexCache) return unitIndexCache;
  const entries: UnitIndexEntry[] = [];
  for (const level of ALL_LEVELS) {
    const content = levelContent(level);
    const bank = questionBank(level);
    for (const unit of content.units) {
      const categories = bank.filter((q) => q.unitId === unit.id).map((q) => q.category);
      const terms = unit.concepts.map((c) => c.term);
      const searchable = [
        unit.title, unit.shortTitle ?? "", unit.goal,
        ...terms,
        ...unit.concepts.map((c) => c.definition),
        ...unit.summary,
        ...categories,
      ].join("\n").toLowerCase();
      entries.push({ level, unit, searchable, terms, categories });
    }
  }
  unitIndexCache = entries;
  return entries;
}

const QUERY_TOKEN = /[a-z0-9]{2,}|[가-힣]{2,}/gu;

function queryTokens(question: string): string[] {
  return question.toLowerCase().match(QUERY_TOKEN) ?? [];
}

/**
 * 용어 매칭: 괄호 표기를 제외한 핵심어로 비교한다.
 * - "exact": 질문에 용어 원형이 그대로 포함됨
 * - "partial": 한국어 조사 결합("환각이", "커밋을")처럼 토큰과 부분 일치
 */
function textHit(needle: string, lowered: string, tokens: string[]): "exact" | "partial" | null {
  const core = needle.toLowerCase().replace(/\(.*?\)/gu, "").trim();
  if (core.length < 2) return null;
  if (lowered.includes(core)) return "exact";
  return tokens.some((token) => token.length >= 2 && (core.includes(token) || token.includes(core))) ? "partial" : null;
}

/** 질문과 관련된 학습 단위를 점수 순으로 찾는다. 근거는 실제 학습 콘텐츠에서만 만든다. */
export function searchLearnUnits(question: string, limit = 2): { level: LearnLevelNo; unit: LearnUnit; score: number }[] {
  const lowered = question.toLowerCase();
  const tokens = queryTokens(question);
  const levelHint = /(?:level|레벨|단계)\s*(\d{1,2})/u.exec(lowered)?.[1];
  const scored = unitIndex().map((entry) => {
    let score = 0;
    for (const term of entry.terms) {
      const hit = textHit(term, lowered, tokens);
      if (hit === "exact") score += 20;
      else if (hit === "partial") score += 6;
    }
    for (const category of entry.categories) {
      const hit = textHit(category, lowered, tokens);
      if (hit === "exact") score += 16;
      else if (hit === "partial") score += 5;
    }
    const titleHit = textHit(entry.unit.title, lowered, tokens);
    if (titleHit === "exact") score += 22;
    else if (titleHit === "partial") score += 8;
    let tokenHits = 0;
    for (const token of tokens) {
      if (entry.searchable.includes(token)) tokenHits += 1;
    }
    score += Math.min(tokenHits * 2, 10);
    if (levelHint && Number(levelHint) === entry.level) score += 4;
    return { level: entry.level, unit: entry.unit, score };
  });
  return scored
    .filter((item) => item.score >= 12)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** 학습 관련 질문인지 판정 — 기존 범위 판정(코딩 상담 등)이 학습 질문을 잘못 차단하지 않기 위한 보조 신호. */
export function isLearnRelated(question: string, ctx?: LearnAssistantContext): boolean {
  if (ctx) return true;
  if (/학습센터|학습하기|오답\s*노트|퀴즈|커리큘럼/u.test(question)) return true;
  return searchLearnUnits(question, 1).length > 0;
}

// ---------------------------------------------------------------------------
// 근거 생성
// ---------------------------------------------------------------------------

const UNIT_TEXT_LIMIT = 1900;

export function unitEvidenceText(unit: LearnUnit): string {
  const sections: string[] = [`학습 목표: ${unit.goal}`];
  if (unit.concepts.length) {
    sections.push(`핵심 개념: ${unit.concepts.map((c) => `${c.term} — ${c.definition}`).join(" / ")}`);
  }
  sections.push(`왜 알아야 할까요: ${unit.whyNeeded}`);
  if (unit.usageSituations.length) sections.push(`실제 사용 상황: ${unit.usageSituations.join(" / ")}`);
  if (unit.comparisons?.length) {
    sections.push(`비슷한 개념과 차이: ${unit.comparisons.map((c) => `${c.a} vs ${c.b} — ${c.difference}`).join(" / ")}`);
  }
  if (unit.cases.length) {
    sections.push(`실무 사례: ${unit.cases.map((c) => `${c.title} — ${c.situation} (교훈: ${c.lesson})`).join(" / ")}`);
  }
  if (unit.practice) {
    const commands = unit.practice.commands?.length ? ` / 명령어: ${unit.practice.commands.join(" ; ")}` : "";
    sections.push(`실습: ${unit.practice.title} — ${unit.practice.steps.join(" → ")}${commands}`);
  }
  if (unit.mistakes.length) {
    sections.push(`자주 발생하는 실수: ${unit.mistakes.map((m) => `${m.mistake} — ${m.why} → ${m.fix}`).join(" / ")}`);
  }
  if (unit.summary.length) sections.push(`핵심 요약: ${unit.summary.join(" / ")}`);
  const text = sections.join("\n");
  return text.length > UNIT_TEXT_LIMIT ? `${text.slice(0, UNIT_TEXT_LIMIT)}…` : text;
}

export function unitEvidence(level: LearnLevelNo, unit: LearnUnit): AssistantEvidence {
  const meta = levelMeta(level);
  return {
    id: `learn-unit-${unit.id}`,
    screen: `학습센터 > LEVEL ${level} ${meta.title}`,
    title: unit.title,
    text: unitEvidenceText(unit),
    keywords: /$^/u,
    kind: "policy",
  };
}

export function learnOverviewEvidence(): AssistantEvidence {
  const lines = ALL_LEVELS.map((level) => {
    const meta = levelMeta(level);
    return `LEVEL ${meta.level} ${meta.title}(${meta.topic}) — ${meta.questionCount}문항, 통과 ${meta.passScore}점`;
  });
  return {
    id: "learn-overview",
    screen: "학습센터",
    title: "학습센터 구성과 통과 기준",
    text: [
      "학습센터는 왼쪽 메뉴의 AI·AX 카테고리에서 '업무 자동화 진단' 바로 위에 있는 '학습센터' 메뉴에서 이용할 수 있습니다.",
      "학습센터는 LEVEL 1~10으로 구성되며, 모든 LEVEL의 퀴즈 통과 기준은 80점입니다.",
      "LEVEL 1은 항상 열려 있고, 이전 LEVEL 퀴즈를 통과하면 다음 LEVEL이 해제됩니다.",
      "퀴즈는 응시할 때마다 학습 단위별로 균형 있게 무작위 출제되고, 틀린 문제는 오답 노트에 남아 관련 학습 단원으로 바로 이동해 복습할 수 있습니다.",
      ...lines,
    ].join("\n"),
    keywords: /$^/u,
    kind: "policy",
  };
}

function answerTextFor(question: LearnQuestion, attempt: QuizAttempt): string {
  const answer = attempt.answers[question.id];
  if (!answer) return "미응답";
  if (answer.kind === "ox") return answer.answer ? "O" : "X";
  if (answer.kind === "terminal") return answer.passed ? "실습 성공" : "실습 미완료";
  if (!question.choices) return "미응답";
  const byId = new Map(question.choices.map((c) => [c.id, c.text]));
  const picked = answer.selectedChoiceIds.map((id) => byId.get(id)).filter(Boolean);
  return picked.length ? picked.join(", ") : "미응답";
}

function correctTextFor(question: LearnQuestion): string {
  if (question.type === "ox") return question.oxAnswer ? "O" : "X";
  if (question.type === "terminal-task") return "실습 과제 성공";
  if (!question.choices) return "";
  const byId = new Map(question.choices.map((c) => [c.id, c.text]));
  return (question.correctChoiceIds ?? []).map((id) => byId.get(id)).filter(Boolean).join(", ");
}

/** 제출 완료가 검증된 응시의 문항 근거 — 이 경로로만 정답·해설이 근거에 들어간다. */
export function questionEvidence(question: LearnQuestion, attempt: QuizAttempt): AssistantEvidence {
  const ordered = orderedChoicesForAttempt(question, attempt);
  const graded = attempt.graded.find((g) => g.questionId === question.id);
  const answer = attempt.answers[question.id];
  const wrongNote = answer?.kind === "choices"
    ? answer.selectedChoiceIds.map((id) => question.wrongExplanations?.[id]).find(Boolean)
    : undefined;
  const unit = linkedUnitForQuestion(question);
  const lines = [
    `문제: ${question.prompt}`,
    ordered ? `선택지: ${ordered.map((c, i) => `${String.fromCharCode(97 + i)}. ${c.text}`).join(" / ")}` : "",
    `사용자 답변: ${answerTextFor(question, attempt)}`,
    `정답: ${correctTextFor(question)}`,
    `채점 결과: ${graded?.correct ? "정답" : "오답"} (${graded?.points ?? 0}점)`,
    `해설: ${question.explanation}`,
    wrongNote ? `선택한 오답에 대한 해설: ${wrongNote}` : "",
    unit ? `연결된 학습 단원: LEVEL ${question.level} '${unit.title}'` : "",
  ].filter(Boolean);
  return {
    id: `learn-question-${question.id}`,
    screen: `학습센터 > LEVEL ${question.level} 퀴즈 결과`,
    title: `문항 해설: ${question.category}`,
    text: lines.join("\n"),
    keywords: /$^/u,
    kind: "diagnosis",
  };
}

const OVERVIEW_TRIGGER = /학습센터|학습하기|커리큘럼|통과\s*(기준|하려면|점수)|잠금|해제|몇\s*단계|퀴즈.*(몇\s*문항|구성|방식)|오답\s*노트|레벨\s*구성|LEVEL\s*구성/iu;

/**
 * 질문과 검증된 학습 컨텍스트로 학습 근거와 프롬프트 안내 문구를 만든다.
 * 퀴즈 응시 중에는 현재 문항의 정답·해설을 근거에 절대 넣지 않고, 연결 단원의 개념 근거만 제공한다.
 */
export function buildLearnEvidence(
  question: string,
  ctx?: LearnAssistantContext,
): { evidence: AssistantEvidence[]; note?: string } {
  const evidence: AssistantEvidence[] = [];
  const push = (entry: AssistantEvidence) => {
    if (!evidence.some((e) => e.id === entry.id)) evidence.push(entry);
  };

  if (!ctx) {
    // 학습 화면 밖에서도 학습 질문에는 실제 콘텐츠 근거로 답한다.
    if (OVERVIEW_TRIGGER.test(question)) push(learnOverviewEvidence());
    for (const hit of searchLearnUnits(question)) push(unitEvidence(hit.level, hit.unit));
    return { evidence };
  }

  switch (ctx.mode) {
    case "dashboard": {
      push(learnOverviewEvidence());
      for (const hit of searchLearnUnits(question)) push(unitEvidence(hit.level, hit.unit));
      return { evidence, note: "사용자는 학습센터 메인 화면에 있습니다. 학습센터 구성·학습 순서·통과 기준·잠금 해제 방식을 안내하세요." };
    }
    case "lesson": {
      if (ctx.unit && ctx.level) push(unitEvidence(ctx.level, ctx.unit));
      for (const hit of searchLearnUnits(question)) push(unitEvidence(hit.level, hit.unit));
      const note = ctx.unit && ctx.level
        ? `사용자는 학습센터 LEVEL ${ctx.level} '${levelMeta(ctx.level).title}'의 '${ctx.unit.title}' 단원을 학습 중입니다. 제공된 이 단원의 실제 학습 내용을 근거로, 어려운 개념은 쉬운 말로 설명하세요. 사용자가 "이것"처럼 현재 단원을 가리키면 이 단원의 내용을 가리키는 것으로 이해하세요.`
        : "사용자는 학습센터 학습하기 화면에 있습니다.";
      return { evidence: evidence.slice(0, 3), note };
    }
    case "quiz": {
      const q = ctx.quizQuestion;
      const unit = q ? linkedUnitForQuestion(q) : undefined;
      if (q && unit) push(unitEvidence(q.level, unit));
      if (OVERVIEW_TRIGGER.test(question)) push(learnOverviewEvidence());
      const note = q
        ? `사용자는 학습센터 LEVEL ${q.level} 퀴즈 응시 중이며, 현재 문항은 '${q.category}' 개념을 묻는 문제입니다. 현재 문항의 정답과 해설은 근거에 의도적으로 포함되어 있지 않습니다. 정답을 직접·간접으로 알려주거나, 특정 선택지가 맞는지 판정하거나, 오답을 제거해 정답을 유도하지 마세요. 관련 개념 설명과 풀이 방향 힌트만 짧게 제공하세요.`
        : "사용자는 학습센터 퀴즈 응시 중입니다. 어떤 문항의 정답도 알려주지 말고 개념 설명만 제공하세요.";
      return { evidence: evidence.slice(0, 2), note };
    }
    case "result":
    case "wrongnotes": {
      if (ctx.verifiedAttempt) {
        const { attempt, questions } = ctx.verifiedAttempt;
        const byId = new Map(questions.map((q) => [q.id, q]));
        const gradedById = new Map(attempt.graded.map((g) => [g.questionId, g]));
        const lowered = question.toLowerCase();
        const wrong = questions.filter((q) => gradedById.get(q.id)?.correct === false);
        const scored = wrong
          .map((q) => {
            let score = 0;
            if (ctx.focusQuestionId === q.id) score += 100;
            if (lowered.includes(q.category.toLowerCase())) score += 20;
            for (const token of queryTokens(question)) {
              if (q.prompt.toLowerCase().includes(token)) score += 2;
            }
            return { q, score };
          })
          .sort((a, b) => b.score - a.score);
        const focus = scored[0]?.q ?? (ctx.focusQuestionId ? byId.get(ctx.focusQuestionId) : undefined);
        if (focus) {
          push(questionEvidence(focus, attempt));
          const unit = linkedUnitForQuestion(focus);
          if (unit) push(unitEvidence(focus.level, unit));
        }
        const note = `사용자는 제출이 완료된 LEVEL ${attempt.level} 응시(점수 ${attempt.score}점, ${attempt.passed ? "통과" : "미통과"})를 보고 있습니다. 이 응시 기록은 서버에서 문제은행 원본으로 다시 채점해 일치함을 검증했습니다. 제공된 문항 근거 범위 안에서 틀린 이유와 선택한 답변·정답의 차이를 설명하세요.`;
        return { evidence: evidence.slice(0, 3), note };
      }
      // 응시 기록을 검증할 수 없어도 화면 맥락 근거는 제공해, 추측 금지 안내가 AI에 닿게 한다.
      push(learnOverviewEvidence());
      for (const hit of searchLearnUnits(question)) push(unitEvidence(hit.level, hit.unit));
      const note = ctx.attemptRejected
        ? "사용자의 응시 기록이 서버 검증과 일치하지 않아 확인할 수 없었습니다. 어떤 문제를 어떻게 틀렸는지 추측하지 말고, 오답 노트 화면에서 직접 확인할 수 있다고 안내하세요."
        : "사용자의 응시 기록을 확인할 수 없습니다. 어떤 문제를 틀렸는지 추측하지 말고, 오답 노트 화면에서 확인할 수 있다고 안내하세요.";
      return { evidence: evidence.slice(0, 3), note };
    }
    case "diagnostic": {
      if (OVERVIEW_TRIGGER.test(question)) push(learnOverviewEvidence());
      for (const hit of searchLearnUnits(question)) push(unitEvidence(hit.level, hit.unit));
      return { evidence: evidence.slice(0, 3), note: "사용자는 학습센터 사전 진단 화면에 있습니다. 진단 문항의 정답은 알려주지 마세요." };
    }
    case "certificate": {
      push(learnOverviewEvidence());
      return { evidence, note: "사용자는 학습센터 수료 화면에 있습니다." };
    }
  }
}

// ---------------------------------------------------------------------------
// 퀴즈 정답 보호
// ---------------------------------------------------------------------------

/** 응시 중 정답을 직접 요구하는 질문 패턴 — 개념 질문은 여기에 걸리지 않는다. */
const ANSWER_SEEKING = [
  /정답(이|을|은|를|이요)?\s*(알려|뭐|뭔|무엇|말해)/u,
  /정답\s*(알려|말해)\s*(줘|주세요)/u,
  /뭐가\s*정답/u, /무엇이\s*정답/u, /어느\s*것이\s*정답/u,
  /몇\s*번(이|을)?\s*(정답|맞|골라|선택)/u,
  /(이거|이것|이\s*선택지|이\s*답|저거)\s*(가|이)?\s*맞(아|나요|습니까|죠)/u,
  /^[a-d]\s*(번)?\s*(이|가)?\s*맞(아|나요|습니까)/iu,
  /오답.*(제거|빼\s*줘|빼줘|골라|알려)/u,
  /해설.*(먼저|미리|보여|알려|공개)/u,
  /정답의?\s*첫\s*글자/u, /첫\s*글자만/u,
  /힌트\s*말고\s*정답/u,
  /정답인지\s*(확인|알려|판정)/u,
  /골라\s*줘/u, /찍어\s*줘/u,
] as const;

export function detectQuizAnswerSeeking(question: string): boolean {
  const text = question.trim();
  return ANSWER_SEEKING.some((pattern) => pattern.test(text));
}

/**
 * 응시 중 정답 요구에 대한 결정적 응답 (AI를 거치지 않는다).
 * 정답은 보호하되, 연결 단원의 핵심 개념은 힌트로 제공한다.
 */
export function quizHintResponse(ctx: LearnAssistantContext): { answer: string; sources: { screen: string; title: string }[] } {
  const q = ctx.quizQuestion;
  const unit = q ? linkedUnitForQuestion(q) : undefined;
  if (!q || !unit) {
    return { answer: "응시 중인 퀴즈의 정답은 알려드릴 수 없어요. 관련 학습 내용을 복습한 뒤 다시 풀어 보세요.", sources: [] };
  }
  const meta = levelMeta(q.level);
  const concept = unit.concepts[0];
  const hint = concept ? ` 이 문항은 '${concept.term}' 개념과 관련이 있어요. ${concept.definition}` : "";
  return {
    answer: `응시 중인 퀴즈의 정답은 알려드릴 수 없어요.${hint} 학습하기에서 '${unit.title}' 단원을 복습하면 도움이 됩니다.`,
    sources: [{ screen: `학습센터 > LEVEL ${q.level} ${meta.title}`, title: unit.title }],
  };
}

const normalizeForLeak = (text: string) => text.toLowerCase().replace(/\s+/gu, "");

/**
 * 응시 중 AI 답변이 현재 문항의 정답을 누설했는지 서버에서 검사한다.
 * 정답 선택지 원문 포함, 정답 해설 원문 포함, 정답 식별자 지목 패턴을 확인한다.
 */
export function quizAnswerLeakCheck(answer: string, question: LearnQuestion): boolean {
  const normalized = normalizeForLeak(answer);
  if (question.choices && question.correctChoiceIds?.length) {
    for (const choice of question.choices) {
      if (!question.correctChoiceIds.includes(choice.id)) continue;
      const text = normalizeForLeak(choice.text);
      if (text.length >= 4 && normalized.includes(text)) return true;
    }
    const ids = question.correctChoiceIds.join("|");
    if (new RegExp(`(${ids})\\s*(번)?\\s*(이|가)?\\s*(정답|맞)`, "iu").test(answer)) return true;
  }
  if (question.type === "ox") {
    if (/(정답|답)은?\s*(O|X|참|거짓)/u.test(answer)) return true;
    if (question.oxAnswer === true && /(O(이|가)\s*(정답|맞)|참(이|이)다|사실이다)/u.test(answer)) return true;
    if (question.oxAnswer === false && /(X(이|가)\s*(정답|맞)|거짓(이|이)다|사실이\s*아니다)/u.test(answer)) return true;
  }
  const explanation = normalizeForLeak(question.explanation);
  if (explanation.length >= 12 && normalized.includes(explanation.slice(0, 12))) return true;
  return false;
}
