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
  records: AggregationRecord[];
  source: SourceRef;
  status: "ready" | "review";
  reason?: string;
}

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
  reason?: string;
}

export interface AggregationWorkbook {
  id: string;
  fileId: string;
  fileName: string;
  kind: "xlsx";
  sheets: AggregationSheet[];
}

export interface AggregationFieldMapping {
  id: string;
  targetField: string;
  sourceFields: Array<{ sheetId: string; field: string }>;
  status: AggregationMappingStatus;
  included: boolean;
}

export interface AggregationSchemaGroup {
  id: string;
  name: string;
  sheetIds: string[];
  fields: string[];
  recordCount: number;
}

export interface AggregationIssue {
  scope: "document" | "sheet" | "region" | "record";
  id: string;
  fileName: string;
  sheetName?: string;
  message: string;
}


export interface AggregationDraft {
  workbooks: AggregationWorkbook[];
  groups: AggregationSchemaGroup[];
  mappings: AggregationFieldMapping[];
  records: AggregationRecord[];
  issues: AggregationIssue[];
}

export interface AggregationSelection {
  sheetIds: string[];
  mappings: Array<Pick<AggregationFieldMapping, "id" | "targetField" | "sourceFields" | "included">>;
}
