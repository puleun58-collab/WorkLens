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
  /** 단위 선택 버튼 표시용 축약 문구 — 없으면 title 사용. 본문 제목은 title 유지 */
  shortTitle?: string;
  estimatedMinutes: number;
  goal: string;
  concepts: { term: string; definition: string }[];
  whyNeeded: string;
  usageSituations: string[];
  comparisons?: { a: string; b: string; difference: string }[];
  cases: { title: string; situation: string; lesson: string }[];
  practice?: {
    title: string;
    steps: string[];
    /** 복사 가능한 명령어 예시 (CLI·Git) */
    commands?: string[];
  };
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
  /** 연결된 학습 단위 식별자 ("l1-u1") — 단위 제목이 바뀌어도 연결이 유지되는 안정 식별자.
   *  단계별 문제은행 문항은 필수이며, 사전 진단 문항에는 없다. */
  unitId?: string;
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
  passScore: number; // 전 단계 80점으로 통일
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
  /** 응시 당시 적용된 통과 기준 — 과거 기록의 판정 기준을 구분하기 위해 응시 시점에 고정한다.
   *  이 필드가 없는 과거 기록은 당시 단계별 기준(70/75/80/85)으로 판정된 것이다. */
  passScore?: number;
  /** 문항별 선택지 표시 순서 (선택지 ID 배열) — 응시 당시 화면에 보인 순서 그대로 보존한다 */
  choiceOrder?: Record<string, string[]>;
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
  /**
   * 응시 당시 정보 스냅샷 — 응시 이력이 보관 한도(레벨별 20회)를 넘어 정리되거나
   * 문제은행에서 문항이 변경·제거되어도 오답 노트가 실제 응시 내용을 그대로
   * 참조할 수 있도록 응시 시점에 고정한다. 이 필드들이 없는 과거 기록은
   * 기존 방식(응시 기록·문제은행 조회)으로 복원을 시도하고, 복원할 수 없는
   * 정보는 임의로 만들지 않는다.
   */
  unitId?: string;
  prompt?: string;
  questionType?: QuestionType;
  /** 응시 당시 표시 순서 그대로의 선택지 스냅샷 */
  choices?: { id: string; text: string }[];
  correctChoiceIds?: string[];
  oxAnswer?: boolean;
  explanation?: string;
  /** 응시 당시 사용자의 실제 답변 스냅샷 */
  myAnswer?: LearnerAnswer;
}

/**
 * 가상 터미널 상태 스냅샷 — 실습 중간 상태를 JSON으로 저장·복구하기 위한 직렬화 형태.
 * VirtualTerminalState의 Set/Map을 배열로 풀어 저장한다 (terminal.ts의
 * serialize/deserializeTerminalState가 변환을 담당한다).
 */
export interface TerminalStateSnapshot {
  cwd: string;
  dirs: string[];
  files: [string, string][];
  git: {
    repoRoot: string | null;
    branch: string;
    branches: string[];
    staged: string[];
    modified: string[];
    untracked: string[];
    commits: { id: string; message: string }[];
    remote: { name: string; url: string } | null;
    ahead: number;
    behind: number;
    conflicted: boolean;
  };
  lines: string[];
  /** 터미널 화면 기록 (입력한 명령과 출력) */
  transcript: { cmd: string; out: string[] }[];
}

/**
 * 진행 중 퀴즈 응시 — 완료된 QuizAttempt와 구분되는 임시 저장 모델.
 * 새로고침·재접속 시 문제 세트·선택지 순서·답변·문항 위치를 그대로 복원한다.
 * 완료 기록(QuizAttempt)으로 저장되지 않으며, 제출이 확정되면 삭제된다.
 */
export interface InProgressQuiz {
  attemptId: string;
  level: LearnLevelNo;
  startedAt: number;
  /** 출제된 문제 ID와 순서 */
  questionIds: string[];
  /** 문항별 선택지 표시 순서 (선택지 ID 배열) */
  choiceOrder: Record<string, string[]>;
  answers: Record<string, LearnerAnswer>;
  currentIndex: number;
  /**
   * 문항별 가상 터미널 실습 중간 상태 — 문항 이동·새로고침·재접속 후에도
   * 실습 상태를 그대로 복원한다. 이 필드가 없는 과거 기록은 터미널 상태를
   * 복원하지 않고 기존 답변만 복원한다.
   */
  terminalStates?: Record<string, TerminalStateSnapshot>;
  /** 응시 시작 당시 통과 기준 */
  passScore: number;
  /**
   * 문항별 내용 지문 — 문제은행 문항이 응시 시작 후 변경·제거된 경우
   * 잘못된 문제·정답으로 복원하지 않기 위한 검증값 (questionFingerprint)
   */
  questionChecks: Record<string, number>;
  /** 마지막 저장 시각 — 다중 탭 충돌 감지 기준 */
  savedAt: number;
  status: "in-progress";
}

/** 단계별 진도 */
export interface LevelProgress {
  passed: boolean;
  bestScore: number;
  attempts: QuizAttempt[];
  /** 마지막으로 열람한 학습 항목 — "현재 학습 위치"이며 완료 여부와 무관하다 */
  lastStudiedUnitId?: string;
  /**
   * 과거 수동 "학습 완료" 표시로 기록된 학습 항목 ID 목록 (보존용).
   * 수동 완료 기능이 제거되어 UI에서는 더 이상 표시·변경하지 않지만,
   * 기존 기록과 백업 파일의 호환을 위해 데이터는 삭제·마이그레이션하지 않는다.
   */
  completedUnitIds?: string[];
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
  /**
   * 최초 학습 완료일 (LEVEL 1~10 전체 통과가 확정된 실제 시각).
   * 전체 통과가 저장 확정되는 시점에 한 번만 기록되고 이후 재응시에도 유지된다.
   * 과거 기록에 이 값이 없으면 응시 기록에서 신뢰성 있게 복원할 수 있을 때만
   * 채우고, 복원할 수 없으면 비워 둔다 (임의 날짜를 만들지 않는다).
   */
  completedAt?: number;
  /** 과거 수료증 발급 여부 — 호환성 유지를 위해 읽기만 하며 신규 기록에서는 사용하지 않는다 */
  certificateIssued?: boolean;
  updatedAt: number;
}
