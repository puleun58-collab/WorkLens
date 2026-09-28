import type { SourceRef } from "@/domain/document";

/**
 * Polish is a separate operation from Check: Check finds problems, Polish
 * rewrites prose. It never touches values — see `src/lib/polish/protect.ts`,
 * which re-checks every model answer against the original before it is shown.
 */
export type PolishMode = "default" | "concise" | "business";

export const POLISH_MODES: readonly PolishMode[] = ["default", "concise", "business"];

/** One unit of prose. Sentences and paragraphs only; never a value or a table. */
export interface PolishCandidate {
  id: string;
  text: string;
  /**
   * Absent for pasted text: that entry point has no document, and a
   * fabricated locator would be worse than none.
   */
  source?: SourceRef;
  /** Where the prose came from, used for the accessible action label. */
  origin: "paragraph" | "cell" | "claim" | "recommendation" | "pasted";
}

/** What the model answered, before any of it is trusted. */
export interface PolishProposal {
  changed: boolean;
  revisedText: string;
  reasons: string[];
}

export type PolishRejection =
  | "protected-token"
  | "quote"
  | "modality"
  | "over-edit"
  | "empty";

export type PolishStatus = "changed" | "unchanged" | "rejected" | "failed";

export interface PolishOutcome {
  id: string;
  status: PolishStatus;
  originalText: string;
  /** For `rejected` and `unchanged` this is the original text, unmodified. */
  revisedText: string;
  reasons: string[];
  rejection?: PolishRejection;
  source?: SourceRef;
  /** Provider/request failure. The original text remains authoritative. */
  failure?: { code?: string; message: string };
  origin?: PolishCandidate["origin"];
}

export interface PolishSummary {
  candidates: number;
  changed: number;
  unchanged: number;
  rejected: number;
  failed: number;
}

export interface PolishResult {
  mode: PolishMode;
  outcomes: PolishOutcome[];
  summary: PolishSummary;
  /** User interrupted the run; unattempted sentences are not failures. */
  stopped?: boolean;
}

/**
 * A pasted-text run. Same outcomes as a file run; the assembled text exists
 * because the user pastes one block and expects one block back.
 */
export interface PolishTextResult {
  mode: PolishMode;
  originalText: string;
  revisedText: string;
  outcomes: PolishOutcome[];
  summary: PolishSummary;
  /** User interrupted the run; unattempted sentences retain their source text. */
  stopped?: boolean;
}

export const POLISH_MODE_LABELS: Record<PolishMode, string> = {
  default: "기본",
  concise: "간결하게",
  business: "업무 문체",
};

export const POLISH_REJECTION_LABELS: Record<PolishRejection, string> = {
  "protected-token": "숫자·날짜·고유명사 등 보호 항목이 달라져 수정안을 적용하지 않았습니다.",
  quote: "직접 인용이 달라져 수정안을 적용하지 않았습니다.",
  modality: "의미나 표현 강도가 달라져 수정안을 적용하지 않았습니다.",
  "over-edit": "원문과 지나치게 달라져 수정안을 적용하지 않았습니다.",
  empty: "수정안이 비어 있어 적용하지 않았습니다.",
};
