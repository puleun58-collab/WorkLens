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

export interface NativeCellAnchor {
  nativeCol: number;
  nativeColOff: number;
  nativeRow: number;
  nativeRowOff: number;
}

export interface MediaAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
  unit: "cell" | "emu";
  /** XLSX drawing anchor exactly as stored, so a template picture can be re-placed unchanged. */
  native?: { tl: NativeCellAnchor; br?: NativeCellAnchor; ext?: { width: number; height: number } };
  /** The picture is the cell's value ("Place in Cell"), not a floating drawing. */
  inCell?: boolean;
}

export interface DocumentMedia {
  id: string;
  kind: "image";
  mimeType: string;
  extension: string;
  data: Uint8Array;
  source: SourceRef;
  anchor: MediaAnchor;
}

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

/** Serializable subset of an XLSX cell/row/column style retained for safe reconstruction. */
export type XlsxStyleSnapshot = Record<string, unknown>;

export interface XlsxWorksheetTemplate {
  columns: Array<{ index: number; width?: number; hidden?: boolean; style?: XlsxStyleSnapshot }>;
  rows: Array<{ number: number; height?: number; hidden?: boolean }>;
  merges: string[];
  views: Array<Record<string, unknown>>;
  conditionalFormats?: Array<{ ref: string; rules: Array<Record<string, unknown>> }>;
  autoFilter?: {
    from: { row: number; column: number };
    to: { row: number; column: number };
  };
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
  /** Exact XLSX semantic type retained separately from display text. */
  valueType?: "text" | "number" | "date" | "boolean" | "formula" | "blank";
  /** Original formula without the leading equals sign. Cached value remains in `value`. */
  formula?: string;
  numberFormat?: string;
  /** XLSX-only static presentation metadata; no formulas, links, or package parts. */
  style?: XlsxStyleSnapshot;
}

export interface TableBlock {
  type: "table";
  id: string;
  source: SourceRef;
  rows: TableCell[][];
}

export interface WorkbookSheet {
  index: number;
  name: string;
  visibility: SheetMetadata["visibility"];
  table: TableBlock;
  /** Safe worksheet presentation only; macros, external links and named ranges are excluded. */
  template?: XlsxWorksheetTemplate;
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
  media?: DocumentMedia[];
  /** XLSX-only workbook hierarchy, including hidden and empty worksheets. */
  workbookSheets?: WorkbookSheet[];
  warnings: string[];
}
