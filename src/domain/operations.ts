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
  | "privacy-email"
  | "privacy-phone"
  | "privacy-resident-registration";

export type CheckSeverity = "critical" | "warning" | "suggestion";

export interface CheckFinding {
  code: CheckCode;
  severity: CheckSeverity;
  message: string;
  reason: string;
  recommendation: string;
  sources: SourceRef[];
}

export interface CheckResult {
  documentId: string;
  findings: CheckFinding[];
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
  content: string | Buffer;
}

export type OperationDocument = NormalizedDocument;
