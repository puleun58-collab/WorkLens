import type { FileKind, SourceRef } from "@/domain/document";

/**
 * 보완 (supplement) finds business information a report needs but does not
 * state. It never judges whether a stated value is right — that belongs to
 * 검수 and 비교 — only whether something required is absent.
 */

/** The only formats this feature analyses in its first release. */
export const SUPPLEMENT_FILE_KINDS: readonly FileKind[] = ["pptx", "pdf"];
export const isSupplementFileKind = (kind: FileKind): boolean => SUPPLEMENT_FILE_KINDS.includes(kind);
export const SUPPLEMENT_UNSUPPORTED_TITLE = "보완은 PPTX, PDF 파일만 지원합니다.";
export const SUPPLEMENT_UNSUPPORTED_DETAIL = "XLSX, CSV, DOCX 파일은 선택을 해제한 뒤 실행하세요.";

export type SupplementDocType =
  | "performance"
  | "cost"
  | "project"
  | "operation"
  | "issue"
  | "improvement"
  | "plan"
  | "management"
  | "general";

export const SUPPLEMENT_DOC_TYPE_LABELS: Record<SupplementDocType, string> = {
  performance: "실적 보고",
  cost: "비용 보고",
  project: "프로젝트 보고",
  operation: "운영 보고",
  issue: "이슈 보고",
  improvement: "개선안",
  plan: "계획서",
  management: "경영 보고",
  general: "일반 업무자료",
};

/** The seven gap kinds this release detects; nothing else is reported. */
export type SupplementCheck = "baseline" | "cause" | "impact" | "response" | "owner" | "schedule" | "conclusion";

/**
 * How much a document of a given type needs a check.
 * - required: a triggered item is reported at its base severity.
 * - conditional: reported only when the trigger itself is strong in context.
 * - recommended: reported at most as 참고.
 * - none: never reported for this type.
 */
export type SupplementNecessity = "required" | "recommended" | "conditional" | "none";

/**
 * Internal verdict for a candidate. Only `missing` and `unverified` reach the
 * user; the rest are kept so "the document lacks it" and "the system could
 * not confirm it" never collapse into one state.
 */
export type SupplementStatus =
  /** Needed in context and not found anywhere the system could read. */
  | "missing"
  /** Not found, but part of the file could not be read, so absence is unproven. */
  | "unverified"
  /** Another page/slide already supplies the information. */
  | "found-elsewhere"
  /** The check does not apply to this document. */
  | "not-applicable"
  /** Whether it is needed or supplied could not be decided; never shown as a gap. */
  | "undetermined";

/** 중요 · 확인 필요 · 참고, reusing the existing severity scale. */
export type SupplementSeverity = "critical" | "warning" | "suggestion";

export const SUPPLEMENT_SEVERITY_LABELS: Record<SupplementSeverity, string> = {
  critical: "중요",
  warning: "확인 필요",
  suggestion: "참고",
};

export interface SupplementFinding {
  id: string;
  fileId: string;
  check: SupplementCheck;
  severity: SupplementSeverity;
  status: "missing" | "unverified";
  /** e.g. "원인 설명 확인 필요". */
  title: string;
  /** What was found and what could not be confirmed, in hedged wording. */
  message: string;
  /** Why a reader would need it. */
  reason: string;
  /** The document's own sentence the gap is about. */
  current: string;
  /** Every place the same gap occurs, in document order. */
  sources: SourceRef[];
  /** Page/slide labels matching `sources`, e.g. "3P", "12페이지". */
  locations: string[];
  /** Kinds of information to add; never a value the document does not state. */
  additions: string[];
  /** A natural question from the report's reader, when one follows. */
  question?: string;
  /** Present when `status` is `unverified`. */
  limitation?: string;
}

/** A finding before the semantic re-check decided it. */
export interface SupplementCandidate extends SupplementFinding {
  /** Short statement of the information that would cancel this candidate. */
  requirement: string;
}

export interface SupplementCoverage {
  fileId: string;
  fileName: string;
  kind: FileKind;
  /** "슬라이드" or "페이지". */
  unit: string;
  total: number;
  analyzed: number;
  complete: boolean;
  /** Unread areas, in the reader's words. */
  notes: string[];
}

export interface SupplementFileSummary {
  fileId: string;
  fileName: string;
  docType: SupplementDocType;
}

/** One bounded semantic re-check request: up to six candidates and their related evidence. */
export interface SupplementReviewBatch {
  checks: Array<{ id: string; candidateId: string; statement: string; requirement: string; handles: string[] }>;
  items: Array<{ handle: string; text: string }>;
  sources: Record<string, SourceRef>;
}

export interface SupplementDraft {
  files: SupplementFileSummary[];
  coverage: SupplementCoverage[];
  candidates: SupplementCandidate[];
  reviews: SupplementReviewBatch[];
  /** Candidates cancelled by the deterministic document-wide search. */
  resolvedCount: number;
}

export type SupplementVerdict = "found" | "not_found" | "unclear";

export interface SupplementReviewVerdict {
  id: string;
  verdict: SupplementVerdict;
  handles: string[];
}

export interface SupplementResult {
  files: SupplementFileSummary[];
  coverage: SupplementCoverage[];
  findings: SupplementFinding[];
  questions: string[];
  /** Candidates cancelled because another location already covers them. */
  resolvedCount: number;
  /** Candidates withheld because their need or absence stayed unclear. */
  withheldCount: number;
  /** Whether the meaning-level re-check ran for every candidate that needed it. */
  semanticReview: "complete" | "partial" | "not-needed";
}
