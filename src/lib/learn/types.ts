/**
 * AI·AX 학습센터 데이터 모델
 *
 * - 학습 콘텐츠·문제은행·평가 로직·학습 진도·UI를 분리한다.
 * - 채점은 결정적 규칙으로만 동작한다 (외부 AI API 의존 금지).
 */

/** 학습 단계 번호 (1~10) */
export type LearnLevelNo = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** 문제 유형 */
export type QuestionType =
  | "single"        // 단일 선택 객관식
  | "multiple"      // 복수 선택 객관식
  | "ox"            // OX
  | "command-result"// 명령어 실행 결과 예측
  | "error-cause"   // 오류 원인 및 해결 방법 선택
  | "case-judgment" // 실무 사례 기반 자동화 판단
  | "terminal-task"; // 가상 터미널 실습 과제

/** 문제 난이도 (출제 비중 기준: 개념 이해 / 응용 / 상황 판단) */
export type QuestionDifficulty = "concept" | "application" | "judgment";

/** 학습 단위 */
export interface LearnUnit {
  id: string; // "l1-u1"
  title: string;
  estimatedMinutes: number;
  goal: string;
  concepts: { term: string; definition: string }[];
  whyNeeded: string;
  usageSituations: string[];
  comparisons?: { a: string; b: string; difference: string }[];
  cases: { title: string; situation: string; lesson: string }[];
  practice?: { title: string; steps: string[] };
  mistakes: { mistake: string; why: string; fix: string }[];
  summary: string[];
}

/** 단계별 학습 콘텐츠 */
export interface LearnContent {
  level: LearnLevelNo;
  intro: string;
  units: LearnUnit[];
}

/** 가상 터미널 과제 성공 조건 */
export type TerminalSuccessCheck =
  | { kind: "cwd-is"; path: string }
  | { kind: "dir-exists"; path: string }
  | { kind: "file-exists"; path: string }
  | { kind: "file-contains"; path: string; text: string }
  | { kind: "staged-includes"; path: string }
  | { kind: "commit-exists"; messageContains: string }
  | { kind: "branch-is"; name: string }
  | { kind: "remote-in-sync" };

/** 가상 터미널 과제 */
export interface TerminalTaskSpec {
  scenario: "folder-nav" | "git-basic" | "git-remote" | "failure";
  instructions: string[];
  successChecks: TerminalSuccessCheck[];
  hint: string;
}

/** 학습 문제 */
export interface LearnQuestion {
  id: string; // "l1-q001"
  level: LearnLevelNo;
  category: string; // 학습 목표·개념 분류
  type: QuestionType;
  difficulty: QuestionDifficulty;
  prompt: string;
  /** single/multiple/command-result/error-cause/case-judgment 용 선택지 */
  choices?: { id: string; text: string }[];
  /** single: 1개, multiple: 2개 이상 */
  correctChoiceIds?: string[];
  /** ox 용 */
  oxAnswer?: boolean;
  /** terminal-task 용 */
  terminalTask?: TerminalTaskSpec;
  explanation: string;
  wrongExplanations?: Record<string, string>;
  verified: boolean;
}

/** 단계 메타데이터 */
export interface LevelMeta {
  level: LearnLevelNo;
  title: string;
  topic: string;
  passScore: number; // 70 / 75 / 80 / 85
  questionCount: number; // 10 (L1~9), 20 (L10)
  pointsPerQuestion: number; // 10 (L1~9), 5 (L10)
}

/** 학습자 답변 */
export type LearnerAnswer =
  | { kind: "choices"; selectedChoiceIds: string[] }
  | { kind: "ox"; answer: boolean }
  | { kind: "terminal"; passed: boolean };

/** 채점된 문항 결과 */
export interface GradedItem {
  questionId: string;
  correct: boolean;
  points: number;
}

/** 응시 기록 */
export interface QuizAttempt {
  attemptId: string;
  level: LearnLevelNo;
  questionIds: string[];
  answers: Record<string, LearnerAnswer>;
  graded: GradedItem[];
  score: number;
  passed: boolean;
  startedAt: number;
  finishedAt: number;
}

/** 오답 노트 항목 */
export interface WrongAnswerEntry {
  questionId: string;
  level: LearnLevelNo;
  category: string;
  attemptId: string;
  answeredAt: number;
  reviewCount: number;
}

/** 단계별 진도 */
export interface LevelProgress {
  passed: boolean;
  bestScore: number;
  attempts: QuizAttempt[];
  lastStudiedUnitId?: string;
}

/** 학습 진도 전체 */
export interface LearnProgress {
  version: 1;
  diagnostic?: {
    answers: Record<string, string>;
    completedAt: number;
    weakAreas: string[];
  };
  levels: Partial<Record<LearnLevelNo, LevelProgress>>;
  wrongAnswers: WrongAnswerEntry[];
  completedAt?: number;
  certificateIssued?: boolean;
  updatedAt: number;
}
