import type { SourceRef } from "@/domain/document";
import type { ExtractValueType } from "@/domain/extract";

export type AggregationValueType = ExtractValueType | "Boolean" | "List" | "Image";
export type AggregationSheetRole = "records" | "reference" | "empty" | "review";
export type AggregationMappingStatus = "confirmed" | "suggested" | "review";

export interface AggregationValue {
  displayValue: string;
  value: string | number | boolean | null;
  normalizedValue?: string;
  type: AggregationValueType;
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
  kind: "xlsx" | "csv" | "pdf" | "docx" | "pptx";
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

export interface OutputSheetMapping {
  targetSheet: string;
  sourceGroup?: string;
  sourceSelector?: Record<string, string>;
  fieldMappings: Record<string, string>;
  purpose: "records" | "summary" | "reference";
}

export interface AggregationOutputProfile {
  id: string;
  label: string;
  requiredFields: string[];
  sheetMappings: OutputSheetMapping[];
  formats: Array<"xlsx" | "pptx">;
}
