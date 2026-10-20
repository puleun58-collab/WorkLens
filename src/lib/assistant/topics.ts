/** Server-side question classification for the WorkLens assistant. Pure functions: no I/O, unit-testable. */

export type AssistantTopic = "in-scope" | "out-of-scope" | "injection" | "execution-request" | "clarify";

/** A pending clarification: the server asked which intent the user meant. */
export interface ClarifyState {
  /** The original ambiguous question. */
  originalQuestion: string;
  /** Short labels for each offered option, in order. */
  options: string[];
  /** Opaque id tying the follow-up answer to this clarification. */
  clarifyId: string;
}

/** Follow-up answers that select one of the offered clarification options. */
const CLARIFY_SELECT_PATTERNS: { index: number; pattern: RegExp }[] = [
  { index: 0, pattern: /^(첫\s*번째|1\s*번|첫째|1)(요|예요|입니다)?$/u },
  { index: 1, pattern: /^(두\s*번째|2\s*번|둘째|2)(요|예요|입니다)?$/u },
  { index: 2, pattern: /^(세\s*번째|3\s*번|셋째|3)(요|예요|입니다)?$/u },
];

/** Affirmative follow-ups confirming the offered interpretation. */
const CLARIFY_AFFIRM = /^(네|예|응|어|맞아요|맞습니다|그래요|그렇습니다|좋아요)(,?\s*(요|맞아요|맞습니다))?$/u;
/** Negative follow-ups rejecting the offered interpretation. */
const CLARIFY_DENY = /^(아니요|아니오|아니야|틀렸어요|다른\s*뜻)/u;

/** Attempts to override assistant behavior, extract hidden data, or bypass policy. */
const INJECTION = [
  /이전\s*지침\s*무시/u, /지침을\s*무시/u, /ignore\s*(previous|all)?\s*instructions?/iu,
  /시스템\s*프롬프트/u, /system\s*prompt/iu, /프롬프트\s*공개/u, /프롬프트를\s*보여/u,
  /jailbreak/iu, /DAN\s*모드/iu,
  /level.*gate.*무시/iu, /gate를?\s*무시/u, /승인\s*(절차를?\s*)?(생략|무시|없이)/u,
  /자동\s*삭제\s*(허용|해줘|해\s*줘)/u, /권한\s*없이/u,
  /다른\s*업무.*(조회|보여|알려)/u, /전체\s*업무\s*(목록|데이터)/u, /남의\s*업무/u,
  /첨부\s*파일\s*(원문|전체|내용).*(보여|전송|알려)/u,
] as const;

/** Read-only assistant must not perform these; it only explains how to do them in WorkLens. */
const EXECUTION = [
  /(수정|삭제|변경|보정|실행|구현)\s*해\s*(줘|주세요|주실래)/u,
  /업무를?\s*(수정|삭제|변경)\s*해/u, /factor.*(보정|변경|수정)\s*해/iu, /팩터를?\s*(바꿔|수정|변경)\s*해/u,
  /gate를?\s*(변경|바꿔)\s*해/u, /level을?\s*(올려|변경|바꿔)\s*해/u,
  /파일을?\s*(업로드|다운로드|처리|분석)\s*해/u, /문서를?\s*(처리|분석)\s*해/u,
  /배포\s*해\s*(줘|주세요|주실래)/u, /git\s*(push|commit|푸시|커밋)\s*해\s*(줘|주세요|주실래)/iu,
  /승인(을|를)?\s*해(줘|주세요)/u, /결재\s*해(줘|주세요)/u,
] as const;

/** Topics outside WorkLens. The assistant answers only WorkLens features, usage, and policy. */
const OUT_OF_SCOPE = [
  /뉴스/u, /주식/u, /코인/u, /부동산/u, /날씨/u, /운세/u, /로또/u,
  /영화/u, /드라마/u, /음악\s*추천/u, /맛집/u, /여행\s*(추천|계획)/u,
  /파이썬|자바스크립트|코딩\s*(알려|가르쳐|질문)/u, /코드\s*(짜|작성|리뷰)/u,
  /숙제/u, /논문/u, /자기소개서/u,
  /외부\s*웹\s*검색/u, /인터넷\s*검색/u,
  /법률\s*(해석|자문|상담)/u, /판례\s*검색/u, /소송/u,
  /잡담/u, /심심/u, /농담/u,
] as const;

/**
 * Ambiguous questions: WorkLens-related but the intent is unclear.
 * These should trigger a clarification question, not an out-of-scope rejection.
 *
 * IMPORTANT: Only genuinely ambiguous fragments trigger clarification. A clear
 * question that happens to contain an ambiguous keyword (e.g. "문서 취합 시
 * 중복 데이터는 어떻게 처리하나요?") must NOT be treated as ambiguous.
 */
const AMBIGUOUS_FRAGMENT = [
  // "자동으로" without clear target
  /^자동으로\s*(되나요|되는거야|돼)\??$/u,
  // "검토" without clear target
  /^검토\s*(자동으로\s*)?(되나요|되는거야)\??$/u,
  // Very short fragments mentioning WorkLens concepts without a clear question
  /^(리서치|검색|레벨|게이트|승인)\s*(어디|뭐|뭔데)\??$/u,
] as const;

/**
 * "중복" is ambiguous only in short fragments where two intents are plausible
 * (natural-language questions vs duplicate handling). A question with a clear
 * verb structure ("어떻게 처리하나요", "어떻게 되나요") is NOT ambiguous.
 */
const DUPLICATE_AMBIGUOUS = /중복/u;
const CLEAR_QUESTION_VERB = /(어떻게|어떤|무엇|뭐).*(처리|동작|되나|인가|인가요|하나요|해요|합니까)|처리.*(방법|방식)/u;

/** WorkLens topics the assistant may answer. Used as a positive signal, not a gate. */
const IN_SCOPE = [
  /worklens|워크렌즈/iu, /사용(법|방법|가이드)/u, /기능/u, /화면/u, /메뉴/u,
  /업무\s*(등록|진단|자동화)/u, /factor|팩터/u, /level|레벨/u, /gate|게이트/u,
  /매트릭스/u, /로드맵/u, /우선순위/u, /올인원\s*(지시문|프롬프트)|코딩\s*에이전트\s*지시문/u, /codex|claude/iu,
  /완료\s*기준/u, /검증\s*방법/u, /통과\s*조건/u, /실패\s*기준/u, /승인/u,
  /진행\s*(가능|보류)/u, /확인\s*후\s*진행/u, /담당자/u,
  /법령|리서치/u, /문서\s*(검토|처리|분석)/u, /파일\s*업로드/u,
  /진단\s*(결과|정책)/u, /구현\s*(범위|계획)/u, /mvp|엠브이피/iu, /깃허브|github|git|배포|production/iu,
  /도우미/u, /오류/u, /에러/u,
  // 학습센터 (학습 콘텐츠 질문은 일반 코딩 상담과 구분한다)
  /학습센터|학습하기|퀴즈|오답|통과\s*기준|단원|커리큘럼/u, /터미널|명령어|커밋|브랜치/u,
  // Colloquial/short forms
  /자연어/u, /말로/u, /문장으로/u,
  /어디\s*(있|계시)/u, /어떻게\s*(써|해|해요)/u,
] as const;

const matches = (patterns: readonly RegExp[], text: string) => patterns.some((pattern) => pattern.test(text));

/**
 * Normalize question for better matching: remove extra spaces, handle common variations.
 * This helps with short questions, colloquial speech, and spacing differences.
 * Normalization must NOT change the question's meaning: it only trims whitespace
 * and normalizes spacing. The original text is always preserved for the model.
 */
export function normalizeQuestion(question: string): string {
  return question
    .trim()
    .replace(/\s+/gu, " ");
}

/**
 * Classify a question. Injection is checked first: a policy-bypass attempt is never
 * treated as a normal question even when it mentions WorkLens features.
 *
 * Distinguishes:
 * - out-of-scope: genuinely not about WorkLens
 * - clarify: WorkLens-related but intent unclear (ask for clarification, don't reject)
 * - in-scope: clear WorkLens question
 *
 * Ambiguity is judged separately from relevance: a question containing an
 * ambiguous keyword is only "clarify" when its structure is genuinely unclear.
 */
export function classifyQuestion(question: string): AssistantTopic {
  const text = question.trim();
  const normalized = normalizeQuestion(text);
  if (matches(INJECTION, text)) return "injection";
  if (matches(EXECUTION, text)) return "execution-request";
  // Check ambiguous before out-of-scope: WorkLens-related but unclear intent
  // should trigger clarification, not rejection.
  if (isAmbiguous(normalized)) return "clarify";
  if (matches(OUT_OF_SCOPE, text) && !matches(IN_SCOPE, text)) return "out-of-scope";
  return "in-scope";
}

/**
 * True when the question is WorkLens-related but its intent is genuinely unclear.
 * Clear questions with a concrete verb structure are never ambiguous, even when
 * they contain keywords like "중복".
 */
function isAmbiguous(normalized: string): boolean {
  const inScope = matches(IN_SCOPE, normalized);
  if (!inScope) return false;
  // Clear verb structure → not ambiguous, even with "중복"
  if (CLEAR_QUESTION_VERB.test(normalized)) return false;
  if (matches(AMBIGUOUS_FRAGMENT, normalized)) return true;
  // "중복" without a clear question structure: short fragment with two plausible intents
  if (DUPLICATE_AMBIGUOUS.test(normalized) && normalized.length <= 30) return true;
  return false;
}

/** 상세 설명 요청 — 기본 간결 답변 대신 요청한 깊이만큼 설명해야 하는 질문. */
const DETAIL_REQUEST = /자세히|자세한|예시\s*(들어|로|를)|단계별|왜\s*그런지|구체적으로|비교해서|비교해\s*(줘|주세요)|상세히|예를\s*들/u;

export function isDetailRequest(question: string): boolean {
  return DETAIL_REQUEST.test(question);
}

export const OUT_OF_SCOPE_RESPONSE = "이 도우미는 WorkLens에 구현된 기능과 사용 방법만 안내할 수 있습니다.";

export const INJECTION_RESPONSE =
  "요청하신 방식으로는 안내할 수 없습니다. WorkLens 기능과 사용 방법에 대해 질문해 주세요.";

export const NO_EVIDENCE_RESPONSE =
  "현재 WorkLens에서 확인할 수 있는 근거가 없어 정확하게 안내하기 어렵습니다.";

export const CLARIFY_RESPONSE =
  "어떤 기능을 말씀하시는지 조금 더 알려주세요.";

export function clarifyResponse(question: string): string {
  // Provide specific clarification based on ambiguous terms
  if (/중복/u.test(question)) {
    return "종합 리서치에서 자연어로 질문할 수 있는지 궁금하신가요, 아니면 중복 질문 처리 기능을 말씀하시는 건가요?";
  }
  if (/자동으로/u.test(question)) {
    return "어떤 작업을 자동으로 하고 싶으신가요? (예: 문서 분석, 업무 진단, 리서치 검색)";
  }
  return CLARIFY_RESPONSE;
}

/**
 * Structured clarification options matching clarifyResponse(). The client shows
 * these so the user can pick; the server resolves "첫 번째요" style answers.
 */
export function clarifyOptions(question: string): string[] {
  if (/중복/u.test(question)) {
    return ["자연어 질문 기능", "중복 질문 처리 기능"];
  }
  if (/자동으로/u.test(question)) {
    return ["문서 분석", "업무 진단", "리서치 검색"];
  }
  return [];
}

/** Result of attempting to resolve a follow-up answer against a pending clarification. */
export type ClarifyResolution =
  | { kind: "select"; optionIndex: number; option: string }
  | { kind: "affirm" }
  | { kind: "deny" }
  | { kind: "none" };

/**
 * Match a short follow-up answer ("첫 번째요", "네", "아니요"...) against the
 * pending clarification. Returns "none" when the answer is a new question or
 * does not address the clarification.
 */
export function resolveClarifyFollowUp(answer: string, clarify: ClarifyState): ClarifyResolution {
  const text = answer.trim();
  // A longer message that is itself a question is a topic change, not a selection.
  if (text.length > 24 && /[?？]/.test(text)) return { kind: "none" };
  for (const { index, pattern } of CLARIFY_SELECT_PATTERNS) {
    if (pattern.test(text) && index < clarify.options.length) {
      return { kind: "select", optionIndex: index, option: clarify.options[index] };
    }
  }
  if (CLARIFY_AFFIRM.test(text)) return { kind: "affirm" };
  if (CLARIFY_DENY.test(text)) return { kind: "deny" };
  return { kind: "none" };
}

/** Questions about the currently selected task's own diagnosis (not general policy). */
const TASK_SPECIFIC = [
  /이\s*업무/u, /지금\s*(선택|열).{0,8}업무/u, /현재\s*업무/u,
  /왜\s*(level|레벨)/iu, /왜\s*(진행\s*보류|보류)/u, /왜\s*(gate|게이트)/iu,
  /우리\s*업무/u, /이\s*건/u,
] as const;

/**
 * True when the question asks about the selected task's own diagnosis rather
 * than general WorkLens policy. Such questions need the task's actual diagnosis
 * data (with user consent); a general policy answer would be misleading.
 */
export function isTaskSpecificQuestion(question: string): boolean {
  const text = question.trim();
  // Injection/execution checks run first in classifyQuestion; here we only
  // distinguish task-specific from general within in-scope questions.
  return matches(TASK_SPECIFIC, text);
}

export function executionRequestResponse(question: string): string {
  if (/배포/u.test(question)) {
    return "배포는 도우미가 직접 수행하지 않습니다. 결과·로드맵의 03 완료 기준을 확인하고, 설치·시작 가이드의 GitHub·배포 안내에 따라 저장소의 기존 방식을 확인하세요. Production 배포는 사용자 요청과 권한이 확인된 경우에만 수행합니다.";
  }
  if (/삭제/u.test(question)) {
    return "삭제는 도우미가 수행하지 않습니다. 업무 목록에서 해당 항목의 삭제 기능을 직접 사용하세요.";
  }
  return "해당 작업은 도우미가 직접 수행하지 않습니다. WorkLens 화면에서 직접 진행해 주세요. 구체적인 위치가 궁금하면 어떤 화면인지 질문해 주세요.";
}
