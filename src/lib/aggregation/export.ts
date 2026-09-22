import ExcelJS from "exceljs";
import type {
  AggregationDraft,
  AggregationField,
  AggregationFieldMapping,
  AggregationRecord,
  AggregationSelection,
} from "@/domain/aggregation";
import type { DocumentMedia, NormalizedDocument } from "@/domain/document";
import { formatWorksheet } from "@/lib/xlsx-format";
import {
  DATETIME_NUMBER_FORMAT,
  DATE_NUMBER_FORMAT,
  imagePixelSize,
  isDateNumberFormat,
} from "@/lib/xlsx-values";

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const IMAGE_COLUMN = "이미지";
const PROVENANCE_COLUMNS = ["출처 파일", "출처 시트", "출처 범위"] as const;
const EMBEDDABLE = new Set(["png", "jpeg", "jpg", "gif"]);
const MAX_IMAGES_PER_RECORD = 3;
const IMAGE_BOX_HEIGHT = 96;
const IMAGE_BOX_WIDTH = 168;
const UNREADABLE_TEXT = /^(?:\[object\s[^\]]*\]|undefined|null|NaN)$/u;

export interface AggregationExport {
  fileName: string;
  mimeType: string;
  content: Uint8Array;
}

type ImageExtension = "png" | "jpeg" | "gif";

function safeSheetName(preferred: string, used: Set<string>): string {
  const base = preferred.replace(/[\\/?*[\]:]/gu, " ").replace(/\s+/gu, " ").trim() || "취합 결과";
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

function mappedFields(record: AggregationRecord, mapping: AggregationFieldMapping): AggregationField[] {
  const allowed = new Set(mapping.sourceFields
    .filter((source) => source.sheetId === record.sheetId)
    .map((source) => source.field));
  return record.fields.filter((field) => allowed.has(field.label) && field.value.displayValue !== "");
}

function isoDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/u.exec(value);
  if (!match) return undefined;
  return new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
  ));
}

/**
 * The exported cell keeps the source value's meaning: a date stays a date cell,
 * a measured number stays numeric with its own format, and anything else keeps
 * the text the document shows. Values that failed to render become empty cells
 * rather than a rendered placeholder.
 */
function exportCell(field: AggregationField): { value: ExcelJS.CellValue; numberFormat?: string } {
  const { value } = field;
  const display = value.displayValue.trim();
  if (!display || UNREADABLE_TEXT.test(display)) return { value: null };

  if (value.type === "Date" || value.type === "DateTime" || value.cellType === "date") {
    const date = isoDate(value.normalizedValue ?? (typeof value.value === "string" ? value.value : ""));
    if (date) {
      // A source format is reused only when it states a four-digit year; the
      // writer's implicit `mm-dd-yy` would otherwise reformat every date.
      const sourceFormat = isDateNumberFormat(value.numberFormat) && /yyyy/iu.test(value.numberFormat ?? "")
        ? value.numberFormat
        : undefined;
      const fallback = value.type === "DateTime" ? DATETIME_NUMBER_FORMAT : DATE_NUMBER_FORMAT;
      return { value: date, numberFormat: sourceFormat ?? fallback };
    }
  }
  if (typeof value.value === "number" && Number.isFinite(value.value)) {
    return {
      value: value.value,
      ...(value.numberFormat && !isDateNumberFormat(value.numberFormat) ? { numberFormat: value.numberFormat } : {}),
    };
  }
  if (typeof value.value === "boolean") return { value: value.value };
  return { value: display };
}

function provenance(record: AggregationRecord): string[] {
  return [
    record.source.label.split(" · ")[0]?.split("!")[0] ?? record.source.fileId,
    record.source.sheet ?? "",
    record.source.cellRange ?? "",
  ];
}

function embeddable(media: DocumentMedia | undefined): media is DocumentMedia {
  return Boolean(media && EMBEDDABLE.has(media.extension.toLowerCase()));
}

function imageExtension(extension: string): ImageExtension {
  const kind = extension.toLowerCase();
  return kind === "jpg" ? "jpeg" : kind === "gif" ? "gif" : kind === "jpeg" ? "jpeg" : "png";
}

/** Fits the picture inside one cell-sized box without cropping or distorting it. */
function fittedSize(media: DocumentMedia): { width: number; height: number } {
  const natural = imagePixelSize(media.data, media.extension);
  if (!natural || natural.width <= 0 || natural.height <= 0) {
    return { width: IMAGE_BOX_WIDTH, height: IMAGE_BOX_HEIGHT };
  }
  const scale = Math.min(IMAGE_BOX_WIDTH / natural.width, IMAGE_BOX_HEIGHT / natural.height, 1);
  return { width: Math.max(16, Math.round(natural.width * scale)), height: Math.max(16, Math.round(natural.height * scale)) };
}

function placeImages(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  column: number,
  media: readonly DocumentMedia[],
): number {
  let offset = 0;
  let tallest = 0;
  for (const item of media.slice(0, MAX_IMAGES_PER_RECORD)) {
    const size = fittedSize(item);
    const imageId = workbook.addImage({
      buffer: item.data.slice().buffer as ArrayBuffer,
      extension: imageExtension(item.extension),
    });
    sheet.addImage(imageId, {
      tl: { col: column - 1 + offset, row: rowNumber - 1 },
      ext: size,
      editAs: "oneCell",
    });
    offset += size.width / (IMAGE_BOX_WIDTH + 8);
    tallest = Math.max(tallest, size.height);
  }
  if (tallest > 0) {
    const row = sheet.getRow(rowNumber);
    row.height = Math.max(row.height ?? 0, tallest * 0.78);
  }
  return offset;
}

function addRecordSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  records: readonly AggregationRecord[],
  mappings: readonly AggregationFieldMapping[],
  mediaFor: (record: AggregationRecord) => DocumentMedia[],
  used: Set<string>,
): void {
  const sheet = workbook.addWorksheet(safeSheetName(name, used));
  const recordMedia = new Map(records.map((record) => [record.id, mediaFor(record)]));
  const withImages = [...recordMedia.values()].some((media) => media.length > 0);
  const imageColumn = withImages ? mappings.length + 1 : 0;

  sheet.addRow([
    ...mappings.map((mapping) => mapping.targetField),
    ...(withImages ? [IMAGE_COLUMN] : []),
    ...PROVENANCE_COLUMNS,
  ]);

  let widestImageRow = 0;
  for (const [index, record] of records.entries()) {
    const rowNumber = index + 2;
    const row = sheet.addRow([
      ...mappings.map(() => null),
      ...(withImages ? [null] : []),
      ...provenance(record),
    ]);
    mappings.forEach((mapping, columnIndex) => {
      const fields = mappedFields(record, mapping);
      if (fields.length === 0) return;
      const cell = row.getCell(columnIndex + 1);
      if (fields.length > 1) {
        cell.value = fields.map((field) => field.value.displayValue).join(" | ");
        return;
      }
      const exported = exportCell(fields[0]);
      cell.value = exported.value;
      if (exported.numberFormat) cell.numFmt = exported.numberFormat;
    });
    if (withImages) {
      const media = recordMedia.get(record.id) ?? [];
      widestImageRow = Math.max(widestImageRow, placeImages(workbook, sheet, rowNumber, imageColumn, media));
    }
  }

  formatWorksheet(sheet, { freezeHeader: true, autoFilter: true });
  if (withImages) {
    sheet.getColumn(imageColumn).width = Math.max(24, Math.ceil(((IMAGE_BOX_WIDTH + 8) * Math.max(1, widestImageRow)) / 7));
  }
}

function addAttachmentSheet(
  workbook: ExcelJS.Workbook,
  media: readonly DocumentMedia[],
  fileNames: ReadonlyMap<string, string>,
  used: Set<string>,
): void {
  const sheet = workbook.addWorksheet(safeSheetName("첨부 이미지", used));
  sheet.addRow(["출처 파일", "출처 시트", "출처 범위", IMAGE_COLUMN]);
  for (const [index, item] of media.entries()) {
    const rowNumber = index + 2;
    sheet.addRow([
      fileNames.get(item.source.fileId) ?? item.source.fileId,
      item.source.sheet ?? "",
      item.source.cellRange ?? "",
      null,
    ]);
    placeImages(workbook, sheet, rowNumber, 4, [item]);
  }
  formatWorksheet(sheet, { freezeHeader: true });
  sheet.getColumn(4).width = Math.ceil((IMAGE_BOX_WIDTH + 8) / 7);
}

/**
 * Exports every selected schema group to its own worksheet; incompatible
 * schemas are never forced together. Record images travel with their row, and
 * images that no record owns are listed separately instead of being dropped.
 */
export async function aggregationXlsxExport(
  draft: AggregationDraft,
  selection: AggregationSelection,
  documents: readonly NormalizedDocument[] = [],
): Promise<AggregationExport> {
  const selectedSheets = new Set(selection.sheetIds);
  const mappings = selectedMappings(draft, selection);
  const workbook = new ExcelJS.Workbook();
  const used = new Set<string>();
  const mediaById = new Map((documents.flatMap((document) => document.media ?? [])).map((media) => [media.id, media]));
  const fileNames = new Map(documents.map((document) => [document.fileId, document.metadata.fileName]));
  const placed = new Set<string>();
  const mediaFor = (record: AggregationRecord): DocumentMedia[] => {
    const media = record.media.map((ref) => mediaById.get(ref.id)).filter(embeddable);
    for (const item of media.slice(0, MAX_IMAGES_PER_RECORD)) placed.add(item.id);
    return media;
  };

  for (const group of draft.groups) {
    const sheetIds = group.sheetIds.filter((id) => selectedSheets.has(id));
    if (sheetIds.length === 0) continue;
    const groupMappings = mappings.filter((mapping) => mapping.sourceFields.some((source) => sheetIds.includes(source.sheetId)));
    const records = draft.records.filter((record) => sheetIds.includes(record.sheetId));
    if (records.length > 0 && groupMappings.length > 0) {
      addRecordSheet(workbook, group.name, records, groupMappings, mediaFor, used);
    }
  }

  const selectedSheetKeys = new Set(draft.workbooks
    .flatMap((entry) => entry.sheets)
    .filter((sheet) => selectedSheets.has(sheet.id))
    .map((sheet) => `${sheet.fileId}\u0000${sheet.name}`));
  const unplaced = [...mediaById.values()].filter((media) =>
    embeddable(media)
    && !placed.has(media.id)
    && selectedSheetKeys.has(`${media.source.fileId}\u0000${media.source.sheet ?? ""}`));
  if (unplaced.length > 0) addAttachmentSheet(workbook, unplaced, fileNames, used);

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
