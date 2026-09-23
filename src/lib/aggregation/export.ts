import ExcelJS from "exceljs";
import type {
  AggregationDraft,
  AggregationField,
  AggregationFieldMapping,
  AggregationRecord,
  AggregationSchemaGroup,
  AggregationSelection,
  AggregationSheet,
} from "@/domain/aggregation";
import type {
  DocumentMedia,
  NormalizedDocument,
  TableCell,
  WorkbookSheet,
  XlsxStyleSnapshot,
} from "@/domain/document";
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

interface ExportedCell {
  value: ExcelJS.CellValue;
  numberFormat?: string;
}

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
function exportCell(field: AggregationField): ExportedCell {
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

type TemplateSource = {
  aggregationSheet: AggregationSheet;
  workbookSheet?: WorkbookSheet;
  document?: NormalizedDocument;
};

const styleCopy = (style: XlsxStyleSnapshot | undefined): Partial<ExcelJS.Style> | undefined =>
  style ? JSON.parse(JSON.stringify(style)) as Partial<ExcelJS.Style> : undefined;

const columnNumber = (letters: string): number =>
  letters.toUpperCase().split("").reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);

const rangeBounds = (
  range: string | undefined,
): { startRow: number; endRow: number; startColumn: number; endColumn: number } | undefined => {
  const match = range ? /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/iu.exec(range) : null;
  return match ? {
    startRow: Number(match[2]),
    endRow: Number(match[4]),
    startColumn: columnNumber(match[1]),
    endColumn: columnNumber(match[3]),
  } : undefined;
};
function templateSource(
  draft: AggregationDraft,
  group: AggregationSchemaGroup,
  selectedSheets: ReadonlySet<string>,
  documents: readonly NormalizedDocument[],
): TemplateSource | undefined {
  for (const workbook of draft.workbooks) {
    for (const sheet of workbook.sheets) {
      if (!group.sheetIds.includes(sheet.id) || !selectedSheets.has(sheet.id) || sheet.regions.length === 0) continue;
      const document = documents.find((entry) => entry.fileId === sheet.fileId);
      return {
        aggregationSheet: sheet,
        document,
        workbookSheet: document?.workbookSheets?.find((entry) => entry.index === sheet.index),
      };
    }
  }
  return undefined;
}

function templateColumn(
  mapping: AggregationFieldMapping,
  template: TemplateSource,
): number | undefined {
  const sourceLabels = new Set(mapping.sourceFields
    .filter((source) => source.sheetId === template.aggregationSheet.id)
    .map((source) => source.field));
  if (sourceLabels.size === 0) return undefined;
  for (const record of template.aggregationSheet.regions.flatMap((region) => region.records)) {
    const field = record.fields.find((entry) => sourceLabels.has(entry.label));
    const column = field?.value.sources[0]?.column;
    if (column !== undefined) return column;
  }
  return undefined;
}

function applyTemplateStyle(cell: ExcelJS.Cell, source: TableCell | undefined): void {
  const style = styleCopy(source?.style);
  if (style) cell.style = style;
}

function neutralHeader(cell: ExcelJS.Cell): void {
  cell.font = { ...cell.font, bold: true, color: { argb: "FF4B5563" } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF6F7F9" } };
  cell.border = {
    top: { style: "thin", color: { argb: "FFD7DEE7" } },
    left: { style: "thin", color: { argb: "FFD7DEE7" } },
    bottom: { style: "thin", color: { argb: "FFD7DEE7" } },
    right: { style: "thin", color: { argb: "FFD7DEE7" } },
  };
  cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
}

function neutralBody(cell: ExcelJS.Cell): void {
  cell.font = { ...cell.font, color: { argb: "FF596579" } };
  cell.border = {
    top: { style: "hair", color: { argb: "FFE5E9EF" } },
    bottom: { style: "hair", color: { argb: "FFE5E9EF" } },
  };
  cell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
}

function templateCellValue(cell: TableCell | undefined): ExcelJS.CellValue {
  if (!cell || cell.value === null) return null;
  if (cell.valueType === "date" && typeof cell.value === "string") {
    const date = new Date(cell.value);
    return Number.isNaN(date.getTime()) ? cell.display : date;
  }
  return typeof cell.value === "string" || typeof cell.value === "number" || typeof cell.value === "boolean"
    ? cell.value
    : cell.display;
}

function applyRecordStyle(
  cell: ExcelJS.Cell,
  source: TableCell | undefined,
  exported: ExportedCell,
): void {
  const style = styleCopy(source?.style);
  if (style) {
    const format = typeof style.numFmt === "string" ? style.numFmt : undefined;
    const compatible = exported.value instanceof Date
      ? Boolean(format && isDateNumberFormat(format))
      : typeof exported.value === "number"
        ? !format || !isDateNumberFormat(format)
        : !format;
    if (!compatible) delete style.numFmt;
    cell.style = style;
  }
  if (!cell.numFmt && exported.numberFormat) cell.numFmt = exported.numberFormat;
}

function addRecordSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  records: readonly AggregationRecord[],
  mappings: readonly AggregationFieldMapping[],
  mediaFor: (record: AggregationRecord) => DocumentMedia[],
  used: Set<string>,
  template: TemplateSource | undefined,
  placed: Set<string>,
): void {
  const sheet = workbook.addWorksheet(safeSheetName(name, used));
  const sourceSheet = template?.workbookSheet;
  const sourceRegion = template?.aggregationSheet.regions[0];
  const header = rangeBounds(sourceRegion?.headerRange);
  const templateEnabled = Boolean(sourceSheet?.template && header);
  const headerRow = templateEnabled ? header!.endRow : 1;
  const firstDataRow = headerRow + 1;
  const sourceColumns = new Map<string, number>();
  for (const mapping of mappings) {
    const sourceColumn = template ? templateColumn(mapping, template) : undefined;
    if (sourceColumn !== undefined) sourceColumns.set(mapping.id, sourceColumn);
  }
  const sourceToOutput = new Map<number, number>();
  mappings.forEach((mapping, index) => {
    const sourceColumn = sourceColumns.get(mapping.id);
    if (sourceColumn !== undefined) sourceToOutput.set(sourceColumn, index + 1);
  });

  if (templateEnabled) {
    for (let rowNumber = 1; rowNumber <= headerRow; rowNumber += 1) {
      const outputRow = sheet.getRow(rowNumber);
      const sourceRowMeta = sourceSheet!.template!.rows.find((row) => row.number === rowNumber);
      if (sourceRowMeta?.height !== undefined) outputRow.height = sourceRowMeta.height;
      if (sourceRowMeta?.hidden) outputRow.hidden = true;
      mappings.forEach((mapping, outputIndex) => {
        const sourceColumn = sourceColumns.get(mapping.id);
        const outputCell = outputRow.getCell(outputIndex + 1);
        if (sourceColumn === undefined) {
          if (rowNumber === headerRow) {
            outputCell.value = mapping.targetField;
            neutralHeader(outputCell);
          }
          return;
        }
        const sourceCell = sourceSheet!.table.rows[rowNumber - 1]?.[sourceColumn - 1];
        outputCell.value = templateCellValue(sourceCell);
        applyTemplateStyle(outputCell, sourceCell);
      });
    }
    for (const merge of sourceSheet!.template!.merges) {
      const bounds = rangeBounds(merge);
      if (!bounds || bounds.endRow > headerRow) continue;
      const mappedColumns = Array.from(
        { length: bounds.endColumn - bounds.startColumn + 1 },
        (_, index) => sourceToOutput.get(bounds.startColumn + index),
      );
      if (mappedColumns.some((column) => column === undefined)) continue;
      const concrete = mappedColumns as number[];
      if (!concrete.every((column, index) => index === 0 || column === concrete[index - 1] + 1)) continue;
      sheet.mergeCells(
        bounds.startRow,
        concrete[0],
        bounds.endRow,
        concrete[concrete.length - 1],
      );
    }
    mappings.forEach((mapping, outputIndex) => {
      const sourceColumn = sourceColumns.get(mapping.id);
      const sourceColumnMeta = sourceSheet!.template!.columns.find((column) => column.index === sourceColumn);
      const outputColumn = sheet.getColumn(outputIndex + 1);
      if (sourceColumnMeta?.width !== undefined) outputColumn.width = sourceColumnMeta.width;
      if (sourceColumnMeta?.hidden) outputColumn.hidden = true;
      const columnStyle = styleCopy(sourceColumnMeta?.style);
      if (columnStyle) outputColumn.style = columnStyle;
    });
    sheet.views = sourceSheet!.template!.views.length
      ? JSON.parse(JSON.stringify(sourceSheet!.template!.views)) as ExcelJS.WorksheetView[]
      : [];
  } else {
    const headerCells = sheet.addRow(mappings.map((mapping) => mapping.targetField));
    headerCells.eachCell(neutralHeader);
  }

  const recordMedia = new Map(records.map((record) => [record.id, mediaFor(record)]));
  const withImages = [...recordMedia.values()].some((media) => media.length > 0);
  const imageColumn = withImages ? mappings.length + 1 : 0;
  const provenanceStart = mappings.length + (withImages ? 2 : 1);
  if (withImages) {
    const cell = sheet.getCell(headerRow, imageColumn);
    cell.value = IMAGE_COLUMN;
    neutralHeader(cell);
  }
  PROVENANCE_COLUMNS.forEach((label, index) => {
    const cell = sheet.getCell(headerRow, provenanceStart + index);
    cell.value = label;
    neutralHeader(cell);
  });

  const representativeRow = rangeBounds(sourceRegion?.recordRange)?.startRow;
  const representativeHeight = representativeRow
    ? sourceSheet?.template?.rows.find((row) => row.number === representativeRow)?.height
    : undefined;
  let widestImageRow = 0;
  for (const [index, record] of records.entries()) {
    const rowNumber = firstDataRow + index;
    const row = sheet.getRow(rowNumber);
    if (representativeHeight !== undefined) row.height = representativeHeight;
    mappings.forEach((mapping, columnIndex) => {
      const cell = row.getCell(columnIndex + 1);
      const fields = mappedFields(record, mapping);
      const sourceColumn = sourceColumns.get(mapping.id);
      const representativeCell = representativeRow && sourceColumn
        ? sourceSheet?.table.rows[representativeRow - 1]?.[sourceColumn - 1]
        : undefined;
      if (fields.length === 0) {
        applyTemplateStyle(cell, representativeCell);
        return;
      }
      if (fields.length > 1) {
        cell.value = fields.map((field) => field.value.displayValue).join(" | ");
        applyTemplateStyle(cell, representativeCell);
        return;
      }
      const exported = exportCell(fields[0]);
      cell.value = exported.value;
      applyRecordStyle(cell, representativeCell, exported);
    });
    if (withImages) {
      const media = recordMedia.get(record.id) ?? [];
      widestImageRow = Math.max(widestImageRow, placeImages(workbook, sheet, rowNumber, imageColumn, media));
    }
    provenance(record).forEach((value, provenanceIndex) => {
      const cell = row.getCell(provenanceStart + provenanceIndex);
      cell.value = value;
      neutralBody(cell);
    });
  }

  if (templateEnabled && template?.document) {
    const decorationMedia = (template.document.media ?? []).filter((media) =>
      embeddable(media)
      && media.source.sheet === template.aggregationSheet.name
      && media.anchor.y < headerRow
      && !placed.has(media.id));
    for (const media of decorationMedia) {
      const imageId = workbook.addImage({
        buffer: media.data.slice().buffer as ArrayBuffer,
        extension: imageExtension(media.extension),
      });
      sheet.addImage(imageId, {
        tl: { col: media.anchor.x, row: media.anchor.y },
        ext: fittedSize(media),
        editAs: "oneCell",
      });
      placed.add(media.id);
    }
  }

  if (templateEnabled) {
    const templateFilter = sourceSheet!.template!.autoFilter;
    sheet.autoFilter = templateFilter
      ? {
        from: { row: templateFilter.from.row, column: sourceToOutput.get(templateFilter.from.column) ?? 1 },
        to: { row: Math.max(headerRow, firstDataRow + records.length - 1), column: sourceToOutput.get(templateFilter.to.column) ?? mappings.length },
      }
      : {
        from: { row: headerRow, column: 1 },
        to: { row: Math.max(headerRow, firstDataRow + records.length - 1), column: provenanceStart + PROVENANCE_COLUMNS.length - 1 },
      };
    if (sheet.views.length === 0) sheet.views = [{ state: "frozen", ySplit: headerRow }];
  } else {
    formatWorksheet(sheet, { freezeHeader: true, autoFilter: true });
  }

  for (let column = 1; column <= mappings.length; column += 1) {
    if (sheet.getColumn(column).width !== undefined) continue;
    const maxLength = Math.max(
      12,
      ...Array.from({ length: sheet.rowCount }, (_, rowIndex) => String(sheet.getCell(rowIndex + 1, column).text).length + 2),
    );
    sheet.getColumn(column).width = Math.min(48, maxLength);
  }
  if (withImages) {
    sheet.getColumn(imageColumn).width = Math.max(24, Math.ceil(((IMAGE_BOX_WIDTH + 8) * Math.max(1, widestImageRow)) / 7));
  }
  PROVENANCE_COLUMNS.forEach((_, index) => {
    sheet.getColumn(provenanceStart + index).width = index === 0 ? 22 : 16;
  });
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
      addRecordSheet(
        workbook,
        group.name,
        records,
        groupMappings,
        mediaFor,
        used,
        templateSource(draft, group, selectedSheets, documents),
        placed,
      );
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
