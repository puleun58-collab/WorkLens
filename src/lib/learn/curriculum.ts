import type { LearnLevelNo, LevelMeta } from "./types";

/** 10단계 커리큘럼 메타데이터 */
export const LEVEL_METAS: LevelMeta[] = [
  { level: 1, title: "AI·AX 기초", topic: "AI, 생성형 AI, AX, 자동화 개념", passScore: 80, questionCount: 10, pointsPerQuestion: 10 },
  { level: 2, title: "업무 자동화 이해", topic: "반복업무, 규칙, 예외, 사람의 검토", passScore: 80, questionCount: 10, pointsPerQuestion: 10 },
  { level: 3, title: "AI 도구 활용", topic: "ChatGPT, Claude, Gemini, 프롬프트", passScore: 80, questionCount: 10, pointsPerQuestion: 10 },
  { level: 4, title: "터미널·CLI 입문", topic: "mkdir, cd, dir, ls, pwd, 경로", passScore: 80, questionCount: 10, pointsPerQuestion: 10 },
  { level: 5, title: "Git·GitHub 기초", topic: "clone, status, add, commit, push, pull", passScore: 80, questionCount: 10, pointsPerQuestion: 10 },
  { level: 6, title: "AI 코딩 에이전트", topic: "Codex CLI, Claude Code, 작업 지시", passScore: 80, questionCount: 10, pointsPerQuestion: 10 },
  { level: 7, title: "개발 환경 이해", topic: "프로젝트 구조, 패키지, 환경변수", passScore: 80, questionCount: 10, pointsPerQuestion: 10 },
  { level: 8, title: "업무 자동화 설계", topic: "API, RPA, 워크플로, HITL", passScore: 80, questionCount: 10, pointsPerQuestion: 10 },
  { level: 9, title: "GitHub·배포 실무", topic: "브랜치, PR, CI, Merge, Deploy", passScore: 80, questionCount: 10, pointsPerQuestion: 10 },
  { level: 10, title: "AI·AX 종합 실무", topic: "복합 업무 자동화 판단 및 검증", passScore: 80, questionCount: 20, pointsPerQuestion: 5 },
];

export function levelMeta(level: LearnLevelNo): LevelMeta {
  const meta = LEVEL_METAS.find((m) => m.level === level);
  if (!meta) throw new Error(`알 수 없는 학습 단계: ${level}`);
  return meta;
}

export const ALL_LEVELS: LearnLevelNo[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** 사전 진단 영역 */
export const DIAGNOSTIC_AREAS = [
  { id: "concept", label: "AI·AX 개념 이해" },
  { id: "automation", label: "업무 자동화 판단" },
  { id: "cli-git", label: "CLI·Git 기본 지식" },
  { id: "dev-deploy", label: "개발·배포 개념" },
] as const;

export type DiagnosticAreaId = (typeof DIAGNOSTIC_AREAS)[number]["id"];

/**
 * 사전 진단 영역 → 실제 학습 항목 연결.
 * 진단 결과에서 보완이 필요한 영역의 '학습하기'로 이동할 때 사용한다.
 * 대상 단위가 커리큘럼에서 사라지면 연결이 끊긴 것으로 취급해 이동을 막는다
 * (테스트가 단위 존재를 강제한다).
 */
export const DIAGNOSTIC_AREA_TARGETS: Record<DiagnosticAreaId, { level: LearnLevelNo; unitId: string }> = {
  // diag-q1(생성형 AI)·q2(AX) — 생성형 AI 단위를 대표 연결로 사용
  concept: { level: 1, unitId: "l1-u2" },
  // diag-q3·q4(자동화 적합성 판단) — 종합 판단 단위
  automation: { level: 2, unitId: "l2-u5" },
  // diag-q5(CLI)·q6(Git 커밋) — CLI 입문 단위부터 시작 (Git은 LEVEL 5)
  "cli-git": { level: 4, unitId: "l4-u1" },
  // diag-q7(배포)·q8(CI) — 배포 단위
  "dev-deploy": { level: 9, unitId: "l9-u4" },
};
