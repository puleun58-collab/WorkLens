import ExcelJS from "exceljs";
import type {
  AggregationDraft,
  AggregationFieldMapping,
  AggregationRecord,
  AggregationSelection,
} from "@/domain/aggregation";
import { formatWorksheet } from "@/lib/xlsx-format";

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface AggregationExport {
  fileName: string;
  mimeType: string;
  content: Uint8Array;
}

function safeSheetName(preferred: string, used: Set<string>): string {
  const base = preferred.replace(/[\\/?*\[\]:]/g, " ").trim() || "취합 결과";
  let name = base.slice(0, 31);
  let suffix = 2;
  while (used.has(name.toLocaleLowerCase())) {
    const marker = ` (${suffix})`;
    name = `${base.slice(0, 31 - marker.length)}${marker}`;
    suffix += 1;
  }
  used.add(name.toLocaleLowerCase());
  return name;
}

function selectedMappings(draft: AggregationDraft, selection: AggregationSelection): AggregationFieldMapping[] {
  const overrides = new Map(selection.mappings.map((mapping) => [mapping.id, mapping]));
  return draft.mappings.flatMap((mapping) => {
    const override = overrides.get(mapping.id);
    const resolved = override ? { ...mapping, ...override } : mapping;
    return resolved.included ? [resolved] : [];
  });
}

function mappedValue(record: AggregationRecord, mapping: AggregationFieldMapping): string | number | boolean | null {
  const allowed = new Set(mapping.sourceFields
    .filter((source) => source.sheetId === record.sheetId)
    .map((source) => source.field));
  const values = record.fields
    .filter((field) => allowed.has(field.label))
    .map((field) => field.value.value)
    .filter((value) => value !== null && value !== "");
  if (values.length === 0) return null;
  return values.length === 1 ? values[0] : values.map(String).join(" | ");
}

function addRecordSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  records: AggregationRecord[],
  mappings: AggregationFieldMapping[],
  used: Set<string>,
): void {
  const sheet = workbook.addWorksheet(safeSheetName(name, used));
  sheet.addRow([...mappings.map((mapping) => mapping.targetField), "_출처 파일", "_출처 시트", "_출처 범위"]);
  for (const record of records) {
    sheet.addRow([
      ...mappings.map((mapping) => mappedValue(record, mapping)),
      record.source.label.split(" · ")[0] ?? record.source.fileId,
      record.source.sheet ?? "",
      record.source.cellRange ?? "",
    ]);
  }
  formatWorksheet(sheet, { freezeHeader: true, autoFilter: true });
}

/** Exports every selected schema group to its own worksheet; incompatible schemas are never forced together. */
export async function aggregationXlsxExport(
  draft: AggregationDraft,
  selection: AggregationSelection,
): Promise<AggregationExport> {
  const selectedSheets = new Set(selection.sheetIds);
  const mappings = selectedMappings(draft, selection);
  const workbook = new ExcelJS.Workbook();
  const used = new Set<string>();

  for (const group of draft.groups) {
    const sheetIds = group.sheetIds.filter((id) => selectedSheets.has(id));
    if (sheetIds.length === 0) continue;
    const groupMappings = mappings.filter((mapping) => mapping.sourceFields.some((source) => sheetIds.includes(source.sheetId)));
    const records = draft.records.filter((record) => sheetIds.includes(record.sheetId));
    if (records.length > 0 && groupMappings.length > 0) addRecordSheet(workbook, group.name, records, groupMappings, used);
  }

  if (workbook.worksheets.length === 0) {
    const sheet = workbook.addWorksheet("취합 결과");
    sheet.addRow(["안내"]);
    sheet.addRow(["선택한 시트에서 취합할 레코드를 찾지 못했습니다."]);
    formatWorksheet(sheet, { freezeHeader: true });
  }

  return {
    fileName: "worklens-aggregation.xlsx",
    mimeType: XLSX_MIME_TYPE,
    content: new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer),
  };
}
