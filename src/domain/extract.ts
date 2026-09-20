import type { SourceRef } from "@/domain/document";

/**
 * Structured extraction.
 *
 * Extract answers "give me the data", not "show me the text": a document
 * becomes fields, values and repeating records that can be pasted into a
 * spreadsheet, with the original wording and its source kept intact. The old
 * paragraph/table dump still exists as the 전체 텍스트 내보내기 mode.
 */
export type ExtractMode = "auto" | "fields" | "text";

export type ExtractValueType =
  | "Text"
  | "Number"
  | "Date"
  | "DateTime"
  | "Period"
  | "Money"
  | "Percent"
  | "Email"
  | "Phone"
  | "Url"
  | "Code";

export type ExtractConfidence = "high" | "medium" | "low";

export interface ExtractedField {
  field: string;
  /** The document's own wording. Never replaced by a normalised form. */
  displayValue: string;
  /** Added only when the reading is unambiguous; absent otherwise. */
  normalizedValue?: string;
  type: ExtractValueType;
  /** Every place the pair was found, in document order. */
  sources: SourceRef[];
  /** Set only for model-derived values; deterministic hits carry none. */
  confidence?: ExtractConfidence;
  quote?: string;
}

/** A repeating structure stays a table: one row per record, not N fields. */
export interface ExtractedRecords {
  id: string;
  title: string;
  /** User-facing name when a structural parser label is too implementation-like. */
  displayTitle?: string;
  columns: string[];
  rows: { cells: string[]; source: SourceRef }[];
  source: SourceRef;
}

export interface FileExtraction {
  file: { id: string; name: string };
  fields: ExtractedField[];
  records: ExtractedRecords[];
  /** Requested fields the document does not answer. Never guessed. */
  missing: string[];
}

export interface StructuredExtract {
  mode: "auto" | "fields";
  /** Field names the user asked for; empty in auto mode. */
  requestedFields: string[];
  files: FileExtraction[];
  summary: { fields: number; missing: number; records: number; lowConfidence: number };
}

export const EXTRACT_MODE_LABELS: Record<ExtractMode, string> = {
  auto: "자동 추출",
  fields: "항목 지정",
  text: "전체 텍스트 내보내기",
};

export const EXTRACT_TYPE_LABELS: Record<ExtractValueType, string> = {
  Text: "텍스트",
  Number: "숫자",
  Date: "날짜",
  DateTime: "일시",
  Period: "기간",
  Money: "금액",
  Percent: "비율",
  Email: "이메일",
  Phone: "연락처",
  Url: "링크",
  Code: "코드",
};
