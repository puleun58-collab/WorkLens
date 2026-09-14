import type { NormalizedDocument, SourceRef, TableCell } from "./document";

export interface NumericSummary {
  count: number;
  sum: number;
  minimum: number;
  maximum: number;
  average: number;
  sources: SourceRef[];
}

export interface TextSummary {
  paragraphCount: number;
  tableCellCount: number;
  nonEmptyValueCount: number;
  characterCount: number;
}

export interface TableStructure {
  blockId: string;
  source: SourceRef;
  rowCount: number;
  columnCount: number;
}

export interface ExplicitTotal {
  label: string;
  expected: number;
  actual: number;
  source: SourceRef;
  contributingSources: SourceRef[];
}

export interface AnalyzeResult {
  documentId: string;
  structure: {
    paragraphCount: number;
    tableCount: number;
    tables: TableStructure[];
  };
  numeric: NumericSummary;
  text: TextSummary;
  totals: ExplicitTotal[];
}

export type CheckCode =
  | "empty-cell"
  | "empty-row"
  | "duplicate-value"
  | "inconsistent-number-format"
  | "invalid-total"
  | "repeated-word"
  | "repeated-character"
  | "abnormal-spacing"
  | "repeated-punctuation"
  | "english-spelling"
  | "suspected-typo"
  | "long-sentence"
  | "sentence-ending-inconsistency"
  | "duplicate-sentence"
  | "terminology-inconsistency"
  | "title-format-inconsistency"
  | "title-body-imbalance"
  | "heading-hierarchy"
  | "heading-numbering-inconsistency"
  | "missing-slide-title"
  | "excessive-slide-text"
  | "placeholder-text"
  | "inconsistent-date-format"
  | "date-conflict"
  | "impossible-date"
  | "inconsistent-currency-format"
  | "inconsistent-unit-format"
  | "malformed-percentage"
  | "suspicious-number-change"
  | "repeated-number-conflict"
  | "cross-section-value-conflict"
  | "missing-value-in-series"
  | "privacy-email"
  | "privacy-phone"
  | "privacy-resident-registration"
  | "privacy-account-number"
  | "privacy-employee-id"
  | "privacy-internal-url"
  | "privacy-ip-address"
  | "privacy-secret"
  | "privacy-sensitive-id"
  | "ocr-text-unavailable"
  | "semantic-writing-suggestion";

export type CheckSeverity = "critical" | "warning" | "suggestion";
export type CheckCategory =
  | "spelling"
  | "grammar"
  | "wording"
  | "terminology"
  | "duplication"
  | "formatting"
  | "numeric"
  | "date"
  | "unit"
  | "total"
  | "privacy"
  | "structure"
  | "placeholder";
export type CheckCategoryGroup = "writing" | "consistency" | "data" | "privacy";

export interface CheckFinding {
  id: string;
  code: CheckCode;
  issue: string;
  severity: CheckSeverity;
  category: CheckCategory;
  message: string;
  reason: string;
  recommendation: string;
  source: SourceRef;
  sources: SourceRef[];
  originalText?: string;
  suggestedText?: string;
  relatedFindingIds?: string[];
}

export interface CheckResult {
  documentId: string;
  findings: CheckFinding[];
}

export function checkCategoryGroup(category: CheckCategory): CheckCategoryGroup {
  if (category === "privacy") return "privacy";
  if (category === "numeric" || category === "date" || category === "unit" || category === "total") return "data";
  if (category === "terminology" || category === "formatting" || category === "structure") return "consistency";
  return "writing";
}

export interface ExtractedCell {
  value: TableCell["value"];
  display: string;
  source: SourceRef;
}

export interface ExtractedTable {
  blockId: string;
  source: SourceRef;
  rows: ExtractedCell[][];
}

export interface ExtractedParagraph {
  blockId: string;
  text: string;
  source: SourceRef;
}

export interface ExtractResult {
  documentId: string;
  tables: ExtractedTable[];
  paragraphs: ExtractedParagraph[];
}

export type ExportFormat = "csv" | "xlsx";

export interface DocumentExport {
  format: ExportFormat;
  mimeType: string;
  fileName: string;
  content: string | Uint8Array;
}

export type OperationDocument = NormalizedDocument;
