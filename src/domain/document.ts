export type FileKind = "xlsx" | "csv" | "pdf" | "docx" | "pptx";

export interface SpanBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type SourceLocator =
  | { kind: "csv"; record: number; column: number }
  | { kind: "xlsx"; sheet: string; range: string }
  | { kind: "pdf"; page: number; spans: SpanBox[] }
  | {
    kind: "docx";
    part: "body" | "header" | "footer";
    block: number;
    tableCell?: { row: number; column: number; anchorCellId?: string };
  }
  | {
    kind: "pptx";
    slide: number;
    shape: number;
    tableCell?: { row: number; column: number; anchorCellId?: string };
  };

export interface SourceRef {
  fileId: string;
  /**
   * Canonical sources emitted by parseDocument always carry these fields.
   * They remain optional here while parsers construct their pre-canonical form.
   */
  documentId?: string;
  documentVersion?: string;
  nodeId: string;
  locator?: SourceLocator;
  label: string;
  page?: number;
  sheet?: string;
  cellRange?: string;
  row?: number;
  column?: number;
  quote?: string;
  quoteHash?: string;
}

export interface SheetMetadata {
  name: string;
  visibility: "visible" | "hidden" | "veryHidden";
  rowCount: number;
  columnCount: number;
}

export interface DocumentMetadata {
  fileName: string;
  pageCount?: number;
  sheets?: SheetMetadata[];
}

export interface ParagraphBlock {
  type: "paragraph";
  id: string;
  text: string;
  source: SourceRef;
  role?: "paragraph" | "heading";
  headingLevel?: number;
}

export interface TableCell {
  value: string | number | boolean | null;
  display: string;
  source: SourceRef;
  rowSpan?: number;
  colSpan?: number;
}

export interface TableBlock {
  type: "table";
  id: string;
  source: SourceRef;
  rows: TableCell[][];
}

export type DocumentBlock = ParagraphBlock | TableBlock;

export interface NormalizedDocument {
  id: string;
  version?: string;
  parserRevision?: string;
  fileId: string;
  kind: FileKind;
  metadata: DocumentMetadata;
  blocks: DocumentBlock[];
  warnings: string[];
}
