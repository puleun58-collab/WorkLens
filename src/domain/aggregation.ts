import type { FileKind, SourceRef, TableCell } from "@/domain/document";
import type { ExtractValueType } from "@/domain/extract";

export type AggregationValueType = ExtractValueType | "Boolean" | "List" | "Image";
export type AggregationSheetRole = "records" | "reference" | "empty" | "review";
export type AggregationMappingStatus = "confirmed" | "suggested" | "review";
/**
 * Aggregation keeps the first selected workbook's layout, so only a real Excel
 * workbook can take part. XLSM is parsed as `xlsx` (its macro is never read).
 */
export function isAggregationFileKind(kind: FileKind): kind is "xlsx" {
  return kind === "xlsx";
}

export const AGGREGATION_UNSUPPORTED_TITLE = "취합할 수 없는 파일이 포함되어 있습니다.";
export const AGGREGATION_UNSUPPORTED_DETAIL = "취합은 Excel 파일만 지원합니다. 지원하지 않는 파일을 선택 해제한 뒤 다시 실행해 주세요.";

export interface AggregationValue {
  displayValue: string;
  value: string | number | boolean | null;
  normalizedValue?: string;
  type: AggregationValueType;
  /** Semantic cell type from the source parser, kept apart from display text. */
  cellType?: TableCell["valueType"];
  /** Original number format, reused so exported values keep their meaning. */
  numberFormat?: string;
  sources: SourceRef[];
}

export interface AggregationField {
  key: string;
  label: string;
  value: AggregationValue;
}

export interface AggregationMediaRef {
  id: string;
  role?: string;
  source: SourceRef;
}

export interface AggregationRecord {
  id: string;
  documentId: string;
  sheetId: string;
  regionId: string;
  fields: AggregationField[];
  media: AggregationMediaRef[];
  source: SourceRef;
  duplicateOf?: string;
}

export interface AggregationRegion {
  id: string;
  headerRange?: string;
  recordRange?: string;
  headers: string[];
  /** Physical 1-based worksheet column of each header, parallel to `headers`. */
  headerColumns: number[];
  records: AggregationRecord[];
  source: SourceRef;
  status: "ready" | "review";
  reason?: string;
}

/**
 * What a sheet contributes to the result. The first selected workbook is the
 * target: its sheets are the result sheets, and every other workbook's sheets
 * either feed one of them or wait for review.
 */
export type AggregationSheetPlan =
  | { kind: "target"; targetId: string }
  | { kind: "append"; targetId: string }
  | { kind: "summarized"; targetId: string }
  | { kind: "unmatched"; targetId?: string }
  | { kind: "ignored" };

export interface AggregationSheet {
  id: string;
  documentId: string;
  fileId: string;
  fileName: string;
  name: string;
  index: number;
  visibility: "visible" | "hidden" | "veryHidden";
  role: AggregationSheetRole;
  selectedByDefault: boolean;
  regions: AggregationRegion[];
  media: AggregationMediaRef[];
  source: SourceRef;
  /** Its records are mostly workbook formulas: a calculated view, not data to append. */
  calculated: boolean;
  plan: AggregationSheetPlan;
  reason?: string;
}

export interface AggregationWorkbook {
  id: string;
  fileId: string;
  fileName: string;
  kind: "xlsx";
  sheets: AggregationSheet[];
}

export type AggregationTargetType = "date" | "datetime" | "number" | "text" | "image";

export interface AggregationFieldMapping {
  id: string;
  /** Result sheet this field belongs to. */
  targetId: string;
  /** The target workbook's own header, which the result keeps. */
  targetField: string;
  /** Target template column; absent when the field is not part of the target layout. */
  targetColumn?: number;
  /** Semantics of the target column: a serial number becomes a date only in a date column. */
  targetType: AggregationTargetType;
  targetFormat?: string;
  sourceFields: Array<{ sheetId: string; field: string }>;
  status: AggregationMappingStatus;
  included: boolean;
}

/**
 * A target column outside the header span (for example a month helper a
 * summary counts). `formula` holds `{ROW}` where the appended row belongs; with
 * `fill: "value"` it is the fallback for rows whose source value is blank.
 */
export interface AggregationHelperColumn {
  column: number;
  fill: "formula" | "value" | "none";
  formula?: string;
}

export type AggregationTargetKind = "records" | "calculated" | "static" | "source";

export interface AggregationTarget {
  id: string;
  name: string;
  kind: AggregationTargetKind;
  /** Template sheet: a target workbook sheet, or an unmatched source sheet kept on its own. */
  sheetId: string;
  /** Template first, then appended source sheets in selection order. */
  sheetIds: string[];
  fields: string[];
  recordCount: number;
  helpers: AggregationHelperColumn[];
}

export interface AggregationIssue {
  scope: "document" | "sheet" | "region" | "record";
  id: string;
  fileName: string;
  sheetName?: string;
  message: string;
}


export interface AggregationDraft {
  /** First selected workbook: the result's structure, fields, formats and style. */
  targetFileId?: string;
  workbooks: AggregationWorkbook[];
  targets: AggregationTarget[];
  mappings: AggregationFieldMapping[];
  records: AggregationRecord[];
  issues: AggregationIssue[];
}

export interface AggregationSelection {
  sheetIds: string[];
  mappings: Array<Pick<AggregationFieldMapping, "id" | "targetField" | "sourceFields" | "included">>;
}
