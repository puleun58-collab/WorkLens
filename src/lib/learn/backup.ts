/**
 * 학습 기록 JSON 백업·복원
 *
 * - 내보내기: 현재 저장 모델(진도·진행 중 퀴즈·연습 터미널 상태)을 메타데이터와
 *   함께 하나의 JSON 파일로 만든다.
 * - 가져오기: 자동 병합이 아니라 명시적 덮어쓰기 전용이다. 파일 검증이 끝나기
 *   전에는 어떤 데이터도 건드리지 않으며, 검증에 실패하면 기존 기록을 그대로
 *   유지한다 (호출자는 검증 성공 후에만 저장을 실행한다).
 */

import { levelContent } from "./content";
import { isValidInProgress, isValidProgress } from "./progress-store";
import { restoreQuizQuestions } from "./questions";
import { isValidTerminalSnapshot } from "./terminal";
import type {
  InProgressQuiz,
  LearnLevelNo,
  LearnProgress,
  TerminalStateSnapshot,
} from "./types";

export const LEARN_BACKUP_FORMAT = "worklens-learn-backup";
export const LEARN_BACKUP_FORMAT_VERSION = 1;
/** 가져오기 허용 최대 파일 크기 (10MB) */
export const LEARN_BACKUP_MAX_BYTES = 10 * 1024 * 1024;

export interface LearnBackupFile {
  format: typeof LEARN_BACKUP_FORMAT;
  formatVersion: number;
  /** LearnProgress 구조 버전 (progress.version과 동일 체계) */
  dataVersion: number;
  exportedAt: number;
  data: {
    progress: LearnProgress;
    inProgress: InProgressQuiz | null;
    practiceStates: Record<string, TerminalStateSnapshot>;
  };
}

export type LearnBackupParseResult =
  | {
      ok: true;
      progress: LearnProgress;
      inProgress: InProgressQuiz | null;
      practiceStates: Record<string, TerminalStateSnapshot>;
      /** 참조 정리 등 가져오기 과정에서 조정된 내용 안내 */
      warnings: string[];
    }
  | { ok: false; error: string };

/** 백업 파일 객체 생성 */
export function buildLearnBackup(
  progress: LearnProgress,
  inProgress: InProgressQuiz | null,
  practiceStates: Record<string, TerminalStateSnapshot>,
): LearnBackupFile {
  return {
    format: LEARN_BACKUP_FORMAT,
    formatVersion: LEARN_BACKUP_FORMAT_VERSION,
    dataVersion: progress.version,
    exportedAt: Date.now(),
    data: { progress, inProgress, practiceStates },
  };
}

export function serializeLearnBackup(backup: LearnBackupFile): string {
  return JSON.stringify(backup, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLevelNo(value: unknown): value is LearnLevelNo {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10;
}

/** 현재 커리큘럼에 실제로 존재하는 단위 ID 집합 */
function existingUnitIds(): Set<string> {
  const ids = new Set<string>();
  for (const level of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as LearnLevelNo[]) {
    for (const unit of levelContent(level).units) ids.add(unit.id);
  }
  return ids;
}

/**
 * 진도 구조 심층 검증 — 저장소의 기본 검증(isValidProgress)보다 엄격하게
 * 응시 기록·참조 무결성까지 확인한다. 문제가 있으면 오류 메시지를 반환한다.
 */
function validateProgressDeep(progress: LearnProgress): string | null {
  const attemptIds = new Set<string>();
  for (const [key, lp] of Object.entries(progress.levels)) {
    const level = Number(key);
    if (!isLevelNo(level)) return `지원하지 않는 LEVEL 데이터가 있습니다 (${key}).`;
    if (!isRecord(lp)) return "단계별 진도 형식이 올바르지 않습니다.";
    if (typeof lp.passed !== "boolean" || typeof lp.bestScore !== "number" || !Array.isArray(lp.attempts)) {
      return "단계별 진도 형식이 올바르지 않습니다.";
    }
    for (const attempt of lp.attempts) {
      if (!isRecord(attempt) || typeof attempt.attemptId !== "string" || attempt.attemptId.length === 0) {
        return "응시 기록 형식이 올바르지 않습니다.";
      }
      if (attemptIds.has(attempt.attemptId)) return "중복된 응시 ID가 있어 가져올 수 없습니다.";
      attemptIds.add(attempt.attemptId);
      if (attempt.level !== level) return "응시 기록의 LEVEL이 단계 정보와 일치하지 않습니다.";
      if (!Array.isArray(attempt.questionIds) || typeof attempt.score !== "number" || typeof attempt.passed !== "boolean") {
        return "응시 기록 형식이 올바르지 않습니다.";
      }
      if (typeof attempt.startedAt !== "number" || typeof attempt.finishedAt !== "number") {
        return "응시 기록 형식이 올바르지 않습니다.";
      }
    }
  }
  for (const w of progress.wrongAnswers) {
    if (!isRecord(w) || typeof w.questionId !== "string" || typeof w.attemptId !== "string" || !isLevelNo(w.level)) {
      return "오답 기록 형식이 올바르지 않습니다.";
    }
  }
  if (progress.diagnostic !== undefined) {
    const d = progress.diagnostic;
    if (!isRecord(d) || typeof d.completedAt !== "number" || !Array.isArray(d.weakAreas)) {
      return "사전 진단 기록 형식이 올바르지 않습니다.";
    }
  }
  if (progress.completedAt !== undefined && (typeof progress.completedAt !== "number" || progress.completedAt <= 0)) {
    return "학습 완료일 형식이 올바르지 않습니다.";
  }
  return null;
}

/** 존재하지 않는 학습 항목 참조를 제거하고 경고로 알린다 (데이터를 임의로 만들지 않는다) */
function sanitizeUnitReferences(progress: LearnProgress, warnings: string[]): LearnProgress {
  const units = existingUnitIds();
  const levels = { ...progress.levels };
  let dropped = 0;
  for (const [key, lp] of Object.entries(levels)) {
    if (!lp) continue;
    const next = { ...lp };
    if (next.lastStudiedUnitId !== undefined && !units.has(next.lastStudiedUnitId)) {
      delete next.lastStudiedUnitId;
      dropped++;
    }
    if (next.completedUnitIds !== undefined) {
      const kept = next.completedUnitIds.filter((id) => units.has(id));
      if (kept.length !== next.completedUnitIds.length) dropped += next.completedUnitIds.length - kept.length;
      next.completedUnitIds = kept;
    }
    levels[Number(key) as LearnLevelNo] = next;
  }
  if (dropped > 0) {
    warnings.push(`현재 학습 항목에 없는 참조 ${dropped}건을 제외했습니다.`);
  }
  return { ...progress, levels };
}

/**
 * 백업 파일 텍스트를 검증하고 복원 가능한 데이터로 변환한다.
 * 이 함수는 읽기 전용이며, 반환값이 ok일 때만 호출자가 저장을 실행한다.
 */
export function parseLearnBackup(text: string): LearnBackupParseResult {
  if (text.length > LEARN_BACKUP_MAX_BYTES) {
    return { ok: false, error: "파일이 너무 큽니다. 학습 기록 백업 파일인지 확인해 주세요." };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "JSON 파일이 아니거나 내용이 손상되었습니다." };
  }
  if (!isRecord(raw) || raw.format !== LEARN_BACKUP_FORMAT) {
    return { ok: false, error: "WorkLens 학습 기록 백업 파일이 아닙니다." };
  }
  if (raw.formatVersion !== LEARN_BACKUP_FORMAT_VERSION) {
    return { ok: false, error: `지원하지 않는 백업 버전입니다 (버전 ${String(raw.formatVersion)}).` };
  }
  if (!isRecord(raw.data) || !isValidProgress(raw.data.progress)) {
    return { ok: false, error: "백업 파일에 필수 학습 기록이 없거나 형식이 올바르지 않습니다." };
  }
  const progressRaw = raw.data.progress;
  if (raw.dataVersion !== undefined && raw.dataVersion !== progressRaw.version) {
    return { ok: false, error: "백업 파일의 데이터 버전이 일치하지 않습니다." };
  }
  const deepError = validateProgressDeep(progressRaw);
  if (deepError) return { ok: false, error: deepError };

  const warnings: string[] = [];
  const progress = sanitizeUnitReferences(progressRaw, warnings);

  // 진행 중 퀴즈 — 구조가 올바르고 문제은행 지문이 현재와 일치할 때만 복원한다
  let inProgress: InProgressQuiz | null = null;
  const rawInProgress = raw.data.inProgress;
  if (rawInProgress !== undefined && rawInProgress !== null) {
    if (!isValidInProgress(rawInProgress)) {
      warnings.push("진행 중 퀴즈 기록의 형식이 올바르지 않아 제외했습니다.");
    } else if (restoreQuizQuestions(rawInProgress) === null) {
      warnings.push("진행 중 퀴즈는 문제은행이 변경되어 복원할 수 없어 제외했습니다.");
    } else {
      const terminalStates: Record<string, TerminalStateSnapshot> = {};
      if (isRecord(rawInProgress.terminalStates)) {
        for (const [qid, snapshot] of Object.entries(rawInProgress.terminalStates)) {
          if (isValidTerminalSnapshot(snapshot)) terminalStates[qid] = snapshot;
        }
      }
      inProgress = { ...rawInProgress, terminalStates };
    }
  }

  // 연습 터미널 상태 — 유효한 항목만 복원한다
  const practiceStates: Record<string, TerminalStateSnapshot> = {};
  if (isRecord(raw.data.practiceStates)) {
    for (const [key, value] of Object.entries(raw.data.practiceStates)) {
      if (/^\d+:.+/.test(key) && isValidTerminalSnapshot(value)) practiceStates[key] = value;
    }
  }

  return { ok: true, progress, inProgress, practiceStates, warnings };
}
