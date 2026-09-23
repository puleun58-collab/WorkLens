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
const EMBEDDABLE: Record<string, true> = { png: true, jpeg: true, jpg: true, gif: true };
const IMAGE_BOX_HEIGHT = 96;
const IMAGE_BOX_WIDTH = 168;
const IMAGE_PADDING = 3;
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

  if (value.cellType === "date" || isDateNumberFormat(value.numberFormat)) {
    const date = isoDate(value.normalizedValue ?? (typeof value.value === "string" ? value.value : ""));
    if (date) {
      // The worksheet template takes precedence when present; otherwise retain
      // the source's own date display, including formats such as m/d.
      const sourceFormat = isDateNumberFormat(value.numberFormat)
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


function embeddable(media: DocumentMedia | undefined): media is DocumentMedia {
  return Boolean(media && Object.hasOwn(EMBEDDABLE, media.extension.toLowerCase()));
}

/** Canonical media IDs repeat for byte-identical uploads; file identity does not. */
function mediaKey(media: { id: string; source: { fileId: string } }): string {
  return `${media.source.fileId}\u0000${media.id}`;
}

function imageExtension(extension: string): ImageExtension {
  const kind = extension.toLowerCase();
  return kind === "jpg" ? "jpeg" : kind === "gif" ? "gif" : kind === "jpeg" ? "jpeg" : "png";
}

/** Fits a picture inside its actual column without cropping or distortion. */
function fittedSize(media: DocumentMedia, maxWidth: number, maxHeight = IMAGE_BOX_HEIGHT): { width: number; height: number } {
  const natural = imagePixelSize(media.data, media.extension);
  if (!natural || natural.width <= 0 || natural.height <= 0) {
    return { width: Math.min(maxWidth, IMAGE_BOX_WIDTH), height: Math.min(maxHeight, IMAGE_BOX_HEIGHT) };
  }
  const scale = Math.min(maxWidth / natural.width, maxHeight / natural.height, 1);
  return { width: Math.max(1, natural.width * scale), height: Math.max(1, natural.height * scale) };
}

/** Excel column widths are measured in character units; image anchors use pixels. */
function columnPixels(column: ExcelJS.Column): number {
  return Math.max(12, Math.floor((column.width ?? 8.43) * 7 + 5));
}

function placeImages(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  column: number,
  media: readonly DocumentMedia[],
): void {
  if (media.length === 0) return;
  const width = columnPixels(sheet.getColumn(column));
  const available = Math.max(8, width - IMAGE_PADDING * 2);
  const sizes = media.map((item) => fittedSize(item, available));
  const neededPixels = sizes.reduce((height, size) => height + size.height + IMAGE_PADDING, IMAGE_PADDING);
  const row = sheet.getRow(rowNumber);
  row.height = Math.max(row.height ?? 0, neededPixels * 0.75);
  let y = IMAGE_PADDING;
  for (const [index, item] of media.entries()) {
    const imageId = workbook.addImage({
      buffer: item.data.slice().buffer as ArrayBuffer,
      extension: imageExtension(item.extension),
    });
    sheet.addImage(imageId, {
      tl: { col: column - 1 + IMAGE_PADDING / width, row: rowNumber - 1 + y / (row.height! * 4 / 3) },
      ext: sizes[index],
      editAs: "oneCell",
    });
    y += sizes[index].height + IMAGE_PADDING;
  }
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
  // Empty record cells have no field source, so locate them through the
  // detected header paths and their actual physical spans. A simple array
  // offset is wrong when an intervening worksheet column has no header.
  const rows = template.workbookSheet?.table.rows;
  if (!rows) return undefined;
  for (const region of template.aggregationSheet.regions) {
    const bounds = rangeBounds(region.headerRange);
    if (!bounds) continue;
    const first = rows[bounds.startRow - 1] ?? [];
    const tiered = bounds.endRow > bounds.startRow;
    const second = tiered ? rows[bounds.startRow] ?? [] : [];
    const columns: number[] = [];
    for (let column = bounds.startColumn; column <= bounds.endColumn; column += 1) {
      let parent = first[column - 1]?.display.trim() ?? "";
      if (!parent && tiered) {
        for (let anchor = column - 1; anchor >= bounds.startColumn; anchor -= 1) {
          const cell = first[anchor - 1];
          if (anchor + (cell?.colSpan ?? 1) <= column) break;
          parent = cell?.display.trim() ?? "";
          if (parent) break;
        }
      }
      const child = tiered ? second[column - 1]?.display.trim() ?? "" : "";
      if ((parent && !UNREADABLE_TEXT.test(parent)) || (child && !UNREADABLE_TEXT.test(child))) {
        columns.push(column);
      }
    }
    if (columns.length === region.headers.length) {
      const index = region.headers.findIndex((label) => sourceLabels.has(label));
      if (index >= 0) return columns[index];
    }
    // Older parsed headers may not retain spans; only a unique exact leaf is
    // safe to use without a trustworthy canonical column-by-column path.
    let direct: number | undefined;
    let ambiguous = false;
    for (const column of columns) {
      for (let rowNumber = bounds.startRow; rowNumber <= bounds.endRow; rowNumber += 1) {
        const label = rows[rowNumber - 1]?.[column - 1]?.display.replace(/\s+/gu, " ").trim();
        if (!label || !sourceLabels.has(label)) continue;
        if (direct !== undefined && direct !== column) ambiguous = true;
        direct = column;
        break;
      }
    }
    if (!ambiguous && direct !== undefined) return direct;
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
  mediaById: ReadonlyMap<string, DocumentMedia>,
  used: Set<string>,
  template: TemplateSource | undefined,
  placed: Set<string>,
): void {
  const sheet = workbook.addWorksheet(safeSheetName(name, used));
  const sourceSheet = template?.workbookSheet;
  const sourceRegion = template?.aggregationSheet.regions[0];
  const header = rangeBounds(sourceRegion?.headerRange);
  // A parsed sheet's table is itself a usable layout, even if older parser
  // output has no separate presentation snapshot.
  const templateEnabled = Boolean(sourceSheet && header);
  const headerRow = templateEnabled ? header!.endRow : 1;
  const firstDataRow = headerRow + 1;
  const physicalColumns = templateEnabled
    ? Math.max(
      header!.endColumn,
      sourceSheet!.table.rows.slice(0, headerRow).reduce((width, row) => Math.max(width, row.length), 0),
      sourceSheet!.template?.columns.length ?? 0,
    )
    : 0;
  const sourceColumns = new Map<string, number>();
  const occupied = new Set<number>();
  let nextColumn = physicalColumns;
  for (const mapping of mappings) {
    const original = templateEnabled ? templateColumn(mapping, template!) : undefined;
    const column = original !== undefined && !occupied.has(original) ? original : ++nextColumn;
    sourceColumns.set(mapping.id, column);
    occupied.add(column);
  }

  if (templateEnabled) {
    for (let rowNumber = 1; rowNumber <= headerRow; rowNumber += 1) {
      const outputRow = sheet.getRow(rowNumber);
      const sourceRowMeta = sourceSheet!.template?.rows.find((row) => row.number === rowNumber);
      if (sourceRowMeta?.height !== undefined) outputRow.height = sourceRowMeta.height;
      if (sourceRowMeta?.hidden) outputRow.hidden = true;
      for (let column = 1; column <= physicalColumns; column += 1) {
        const sourceCell = sourceSheet!.table.rows[rowNumber - 1]?.[column - 1];
        const outputCell = outputRow.getCell(column);
        outputCell.value = templateCellValue(sourceCell);
        applyTemplateStyle(outputCell, sourceCell);
      }
    }
    for (const merge of sourceSheet!.template?.merges ?? []) {
      const bounds = rangeBounds(merge);
      if (bounds && bounds.endRow <= headerRow) {
        sheet.mergeCells(bounds.startRow, bounds.startColumn, bounds.endRow, bounds.endColumn);
      }
    }
    for (const columnMeta of sourceSheet!.template?.columns ?? []) {
      const outputColumn = sheet.getColumn(columnMeta.index);
      if (columnMeta.width !== undefined) outputColumn.width = columnMeta.width;
      if (columnMeta.hidden) outputColumn.hidden = true;
      const style = styleCopy(columnMeta.style);
      if (style) outputColumn.style = style;
    }
    sheet.views = sourceSheet!.template?.views.length
      ? JSON.parse(JSON.stringify(sourceSheet!.template.views)) as ExcelJS.WorksheetView[]
      : [{ state: "frozen", ySplit: headerRow }];
    for (const mapping of mappings) {
      const column = sourceColumns.get(mapping.id)!;
      if (column <= physicalColumns) continue;
      const cell = sheet.getCell(headerRow, column);
      cell.value = mapping.targetField;
      neutralHeader(cell);
    }
  } else {
    const headerCells = sheet.addRow(mappings.map((mapping) => mapping.targetField));
    headerCells.eachCell(neutralHeader);
  }

  const representativeRow = rangeBounds(sourceRegion?.recordRange)?.startRow;
  for (const [index, record] of records.entries()) {
    const rowNumber = firstDataRow + index;
    const row = sheet.getRow(rowNumber);
    const styleRow = record.regionId === sourceRegion?.id && record.sheetId === template?.aggregationSheet.id
      ? record.source.row ?? representativeRow
      : representativeRow;
    const sourceRowMeta = styleRow
      ? sourceSheet?.template?.rows.find((entry) => entry.number === styleRow)
      : undefined;
    if (sourceRowMeta?.height !== undefined) row.height = sourceRowMeta.height;
    if (record.sheetId === template?.aggregationSheet.id && sourceRowMeta?.hidden) row.hidden = true;
    for (const mapping of mappings) {
      const column = sourceColumns.get(mapping.id)!;
      const cell = row.getCell(column);
      const fields = mappedFields(record, mapping);
      const representativeCell = styleRow && column <= physicalColumns
        ? sourceSheet?.table.rows[styleRow - 1]?.[column - 1]
        : undefined;
      if (fields.length === 0) {
        applyTemplateStyle(cell, representativeCell);
      } else if (fields.length > 1) {
        cell.value = fields.map((field) => field.value.displayValue).join(" | ");
        applyTemplateStyle(cell, representativeCell);
      } else {
        const exported = exportCell(fields[0]);
        cell.value = exported.value;
        applyRecordStyle(cell, representativeCell, exported);
      }
    }
  }

  if (templateEnabled) {
    const filter = sourceSheet!.template?.autoFilter;
    if (filter) sheet.autoFilter = {
      from: filter.from,
      to: { row: Math.max(filter.to.row, firstDataRow + records.length - 1), column: filter.to.column },
    };
  } else {
    formatWorksheet(sheet, { freezeHeader: true, autoFilter: true });
  }
  for (const column of sourceColumns.values()) {
    if (sheet.getColumn(column).width !== undefined) continue;
    const maxLength = Math.max(
      12,
      ...Array.from({ length: sheet.rowCount }, (_, rowIndex) => String(sheet.getCell(rowIndex + 1, column).text).length + 2),
    );
    sheet.getColumn(column).width = Math.min(48, maxLength);
  }

  // Place all images after column widths are final. Group by cell and stack
  // vertically so multiple pictures in one semantic field never overlap.
  for (const [index, record] of records.entries()) {
    const imagesByColumn = new Map<number, DocumentMedia[]>();
    for (const ref of record.media) {
      const media = mediaById.get(mediaKey(ref));
      if (!embeddable(media) || placed.has(mediaKey(media))) continue;
      const mapping = ref.role && mappings.find((candidate) =>
        candidate.targetField === ref.role
        || candidate.sourceFields.some((source) => source.sheetId === record.sheetId && source.field === ref.role));
      const column = mapping ? sourceColumns.get(mapping.id) : (
        templateEnabled
        && record.sheetId === template!.aggregationSheet.id
        && ref.source.column !== undefined
        && ref.source.column >= 1
        && ref.source.column <= physicalColumns
          ? ref.source.column
          : undefined
      );
      if (column === undefined) continue;
      const group = imagesByColumn.get(column) ?? [];
      group.push(media);
      imagesByColumn.set(column, group);
      placed.add(mediaKey(media));
    }
    const targetRow = sheet.getRow(firstDataRow + index);
    for (const [column, images] of imagesByColumn) {
      const available = Math.max(8, columnPixels(sheet.getColumn(column)) - IMAGE_PADDING * 2);
      const needed = images.reduce(
        (height, image) => height + fittedSize(image, available).height + IMAGE_PADDING,
        IMAGE_PADDING,
      );
      targetRow.height = Math.max(targetRow.height ?? 0, needed * 0.75);
    }
    for (const [column, images] of imagesByColumn) {
      placeImages(workbook, sheet, firstDataRow + index, column, images);
    }
  }

  // Only the first workbook supplies sheet decoration; never copy raw package
  // content or decorations from every contributing workbook.
  if (templateEnabled && template?.document) {
    const decorationMedia = (template.document.media ?? []).filter((media) =>
      embeddable(media)
      && media.source.sheet === template.aggregationSheet.name
      && media.anchor.y < headerRow
      && !placed.has(mediaKey(media)));
    for (const media of decorationMedia) {
      const imageId = workbook.addImage({
        buffer: media.data.slice().buffer as ArrayBuffer,
        extension: imageExtension(media.extension),
      });
      sheet.addImage(imageId, {
        tl: { col: media.anchor.x, row: media.anchor.y },
        ext: fittedSize(media, IMAGE_BOX_WIDTH),
        editAs: "oneCell",
      });
      placed.add(mediaKey(media));
    }
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
  sheet.getColumn(4).width = Math.ceil((IMAGE_BOX_WIDTH + 8) / 7);
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
  const selectedSheetsByKey = new Map(draft.workbooks
    .flatMap((entry) => entry.sheets)
    .filter((sheet) => selectedSheets.has(sheet.id))
    .map((sheet) => [`${sheet.fileId}\u0000${sheet.name}`, sheet] as const));
  const mappings = selectedMappings(draft, selection);
  const workbook = new ExcelJS.Workbook();
  const used = new Set<string>();
  const mediaById = new Map((documents.flatMap((document) => document.media ?? [])).map((media) => [mediaKey(media), media]));
  const unsupported = [...mediaById.values()].filter((media) =>
    selectedSheetsByKey.has(`${media.source.fileId}\u0000${media.source.sheet ?? ""}`) && !embeddable(media));
  if (unsupported.length) {
    throw new Error(`포함된 이미지 ${unsupported.length}건은 Excel 결과에 넣을 수 없는 형식입니다. 이미지가 누락되지 않도록 지원 형식(PNG, JPEG, GIF)으로 바꾼 뒤 다시 시도해 주세요.`);
  }
  const fileNames = new Map(documents.map((document) => [document.fileId, document.metadata.fileName]));
  const placed = new Set<string>();

  for (const group of draft.groups) {
    const sheetIds = group.sheetIds.filter((id) => selectedSheets.has(id));
    if (sheetIds.length === 0) continue;
    const groupMappings = mappings.filter((mapping) => mapping.sourceFields.some((source) => sheetIds.includes(source.sheetId)));
    const records = draft.records.filter((record) => sheetIds.includes(record.sheetId));
    const template = templateSource(draft, group, selectedSheets, documents);
    if (records.length > 0 && groupMappings.length > 0) {
      addRecordSheet(
        workbook,
        template?.aggregationSheet.name || group.name,
        records,
        groupMappings,
        mediaById,
        used,
        template,
        placed,
      );
    }
  }

  const linked = new Set(draft.records
    .filter((record) => selectedSheets.has(record.sheetId))
    .flatMap((record) => record.media.map(mediaKey)));
  const unplaced = [...mediaById.values()].filter((media) => {
    if (!embeddable(media) || placed.has(mediaKey(media))) return false;
    const sourceSheet = selectedSheetsByKey.get(`${media.source.fileId}\u0000${media.source.sheet ?? ""}`);
    if (!sourceSheet) return false;
    const headerRow = rangeBounds(sourceSheet.regions[0]?.headerRange)?.endRow;
    // Logos and other unlinked header decoration belong only to the first
    // template, not a second workbook's fallback attachments.
    return linked.has(mediaKey(media)) || headerRow === undefined || media.anchor.y >= headerRow;
  });
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
