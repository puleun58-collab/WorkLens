import ExcelJS from "exceljs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type {
  AggregationDraft,
  AggregationFieldMapping,
  AggregationRecord,
  AggregationRegion,
  AggregationSelection,
  AggregationSheet,
  AggregationTarget,
} from "@/domain/aggregation";
import type { DocumentMedia, NativeCellAnchor, NormalizedDocument, TableCell, WorkbookSheet, XlsxStyleSnapshot } from "@/domain/document";
import { formatWorksheet } from "@/lib/xlsx-format";
import { imagePixelSize, isDateNumberFormat } from "@/lib/xlsx-values";
import { followGrowth, isExternalFormula, sheetKey, type SheetGrowth } from "./formula";
import { mappedFields, primaryRegion, targetCell, type TargetCell } from "./values";

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const IMAGE_COLUMN = "이미지";
const EMBEDDABLE: Record<string, true> = { png: true, jpeg: true, jpg: true, gif: true };
const ATTACHMENT_BOX_HEIGHT = 96;
const ATTACHMENT_BOX_WIDTH = 168;
const ATTACHMENT_PADDING = 3;
const EMU_PER_PIXEL = 9_525;
const EMU_PER_POINT = 12_700;
/** Keeps a picture off the cell border it sits inside. */
const IMAGE_INSET_PX = 2;
const TILE_GAP_PX = 2;
/** Below this a picture cannot be read; only then does a row grow. */
const MIN_IMAGE_ROW_POINTS = 36;

export interface AggregationExport {
  fileName: string;
  mimeType: string;
  content: Uint8Array;
}

type ImageExtension = "png" | "jpeg" | "gif";

/** DrawingML crop in thousandths of a percent of each edge. */
interface SourceCrop {
  l: number;
  t: number;
  r: number;
  b: number;
}

interface Template {
  sheet: AggregationSheet;
  document?: NormalizedDocument;
  workbookSheet?: WorkbookSheet;
}

interface ExportContext {
  workbook: ExcelJS.Workbook;
  draft: AggregationDraft;
  documents: readonly NormalizedDocument[];
  mappings: readonly AggregationFieldMapping[];
  mediaById: ReadonlyMap<string, DocumentMedia>;
  imageIds: Map<string, number>;
  placed: Set<string>;
  used: Set<string>;
  /** Per output sheet, one entry per picture in the order it was added. */
  crops: Map<string, Array<SourceCrop | undefined>>;
  growth: Map<string, SheetGrowth>;
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

function embeddable(media: DocumentMedia | undefined): media is DocumentMedia {
  return Boolean(media && Object.hasOwn(EMBEDDABLE, media.extension.toLowerCase()));
}

/** Canonical media IDs repeat for byte-identical uploads; file identity does not. */
function mediaKey(media: { id: string; source: { fileId: string } }): string {
  return `${media.source.fileId}\u0000${media.id}`;
}

function imageExtension(extension: string): ImageExtension {
  const kind = extension.toLowerCase();
  return kind === "jpg" || kind === "jpeg" ? "jpeg" : kind === "gif" ? "gif" : "png";
}

function imageId(context: ExportContext, media: DocumentMedia): number {
  const key = mediaKey(media);
  const existing = context.imageIds.get(key);
  if (existing !== undefined) return existing;
  const id = context.workbook.addImage({ buffer: media.data.slice().buffer as ArrayBuffer, extension: imageExtension(media.extension) });
  context.imageIds.set(key, id);
  return id;
}

function cropsOf(context: ExportContext, sheet: ExcelJS.Worksheet): Array<SourceCrop | undefined> {
  const list = context.crops.get(sheet.name) ?? [];
  context.crops.set(sheet.name, list);
  return list;
}

const columnNumber = (letters: string): number =>
  letters.toUpperCase().split("").reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);

const rangeBounds = (range: string | undefined): { startRow: number; endRow: number; startColumn: number; endColumn: number } | undefined => {
  const match = range ? /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/iu.exec(range) : null;
  return match ? { startRow: Number(match[2]), endRow: Number(match[4]), startColumn: columnNumber(match[1]), endColumn: columnNumber(match[3]) } : undefined;
};

const styleCopy = (style: XlsxStyleSnapshot | undefined): Partial<ExcelJS.Style> | undefined =>
  style ? JSON.parse(JSON.stringify(style)) as Partial<ExcelJS.Style> : undefined;

function templateOf(draft: AggregationDraft, sheetId: string, documents: readonly NormalizedDocument[]): Template | undefined {
  const sheet = draft.workbooks.flatMap((workbook) => workbook.sheets).find((entry) => entry.id === sheetId);
  if (!sheet) return undefined;
  const document = documents.find((entry) => entry.fileId === sheet.fileId);
  return { sheet, document, workbookSheet: document?.workbookSheets?.find((entry) => entry.index === sheet.index) };
}

/** A cell's stored value: dates stay dates, errors and failed renders stay empty. */
function storedValue(cell: TableCell | undefined): ExcelJS.CellValue {
  if (!cell || cell.value === null) return null;
  if (cell.valueType === "date" && typeof cell.value === "string") {
    const date = new Date(cell.value);
    return Number.isNaN(date.getTime()) ? cell.display : date;
  }
  return cell.value;
}

/**
 * A template cell as written to the result. Workbook-internal formulas stay
 * live and follow appended rows; an external reference keeps only the value
 * Excel stored, so no link to another workbook survives.
 */
function templateValue(cell: TableCell | undefined, sheetName: string, growth: ReadonlyMap<string, SheetGrowth>, keepResult: boolean): ExcelJS.CellValue {
  if (cell?.formula && !isExternalFormula(cell.formula)) {
    const formula = followGrowth(cell.formula, sheetName, growth);
    const result = storedValue(cell);
    return keepResult && formula === cell.formula && result !== null
      ? { formula, result } as ExcelJS.CellFormulaValue
      : { formula } as ExcelJS.CellFormulaValue;
  }
  return storedValue(cell);
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

/**
 * An appended cell takes the target column's data style. A number format is
 * kept only when it fits the value: a date format never turns a count into a
 * day, and a date keeps a date format.
 */
function applyTargetStyle(cell: ExcelJS.Cell, representative: TableCell | undefined, exported: TargetCell): void {
  const style = styleCopy(representative?.style);
  if (style) {
    const format = typeof style.numFmt === "string" ? style.numFmt : undefined;
    const compatible = exported.value instanceof Date
      ? Boolean(format && isDateNumberFormat(format))
      : typeof exported.value === "number"
        ? !format || !isDateNumberFormat(format)
        : !format || !isDateNumberFormat(format);
    if (!compatible) delete style.numFmt;
    cell.style = style;
  }
  if (exported.value instanceof Date ? !isDateNumberFormat(cell.numFmt) : !cell.numFmt) {
    if (exported.numberFormat) cell.numFmt = exported.numberFormat;
  }
}

interface MergeBox {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/**
 * Copies a template worksheet: every cell, style, merge, width, height, view
 * and filter. Rows after `lastRow` move down by `added` so appended records
 * sit directly after the template's own records.
 */
function copyTemplate(
  context: ExportContext,
  output: ExcelJS.Worksheet,
  template: WorkbookSheet,
  lastRow: number,
  added: number,
  keepResults: (row: number) => boolean,
): MergeBox[] {
  const shift = (row: number): number => row > lastRow ? row + added : row;
  const rowMeta = new Map((template.template?.rows ?? []).map((row) => [row.number, row]));
  template.table.rows.forEach((cells, index) => {
    const number = index + 1;
    const row = output.getRow(shift(number));
    const meta = rowMeta.get(number);
    if (meta?.height !== undefined) row.height = meta.height;
    if (meta?.hidden) row.hidden = true;
    cells.forEach((cell, columnIndex) => {
      const target = row.getCell(columnIndex + 1);
      const value = templateValue(cell, template.name, context.growth, keepResults(number));
      if (value !== null) target.value = value;
      const style = styleCopy(cell.style);
      if (style) target.style = style;
    });
  });
  const merges: MergeBox[] = [];
  for (const merge of template.template?.merges ?? []) {
    const bounds = rangeBounds(merge);
    if (!bounds) continue;
    const box = { top: shift(bounds.startRow), left: bounds.startColumn, bottom: bounds.endRow > lastRow ? bounds.endRow + added : bounds.endRow, right: bounds.endColumn };
    output.mergeCells(box.top, box.left, box.bottom, box.right);
    merges.push(box);
  }
  for (const column of template.template?.columns ?? []) {
    const target = output.getColumn(column.index);
    if (column.width !== undefined) target.width = column.width;
    if (column.hidden) target.hidden = true;
    const style = styleCopy(column.style);
    if (style) target.style = style;
  }
  if (template.template?.views.length) output.views = JSON.parse(JSON.stringify(template.template.views)) as ExcelJS.WorksheetView[];
  const filter = template.template?.autoFilter;
  if (filter) {
    output.autoFilter = {
      from: { row: shift(filter.from.row), column: filter.from.column },
      to: { row: filter.to.row >= lastRow ? filter.to.row + added : filter.to.row, column: filter.to.column },
    };
  }
  return merges;
}

/** Excel's pixel width for a column width in characters (default font). */
function columnPixels(width: number | undefined): number {
  return Math.trunc(((256 * (width ?? 8.43) + Math.trunc(128 / 7)) / 256) * 7);
}

function coverCrop(media: DocumentMedia, width: number, height: number): SourceCrop | undefined {
  const natural = imagePixelSize(media.data, media.extension);
  if (!natural || natural.width <= 0 || natural.height <= 0 || width <= 0 || height <= 0) return undefined;
  const image = natural.width / natural.height;
  const box = width / height;
  if (Math.abs(image - box) / box < 0.005) return undefined;
  if (image > box) {
    const side = Math.round(((1 - box / image) / 2) * 100_000);
    return { l: side, t: 0, r: side, b: 0 };
  }
  const side = Math.round(((1 - image / box) / 2) * 100_000);
  return { l: 0, t: side, r: 0, b: side };
}

/**
 * Fills the cell (or its merged area) with the record's pictures: one picture
 * covers the whole area, several share it as a grid. Each keeps its aspect
 * ratio and is centre-cropped to its tile, and the two-cell anchor moves and
 * sizes with the cell.
 */
function placeCover(context: ExportContext, sheet: ExcelJS.Worksheet, box: MergeBox, images: readonly DocumentMedia[]): void {
  const widths = Array.from({ length: box.right - box.left + 1 }, (_, index) => columnPixels(sheet.getColumn(box.left + index).width) * EMU_PER_PIXEL);
  const heights = Array.from({ length: box.bottom - box.top + 1 }, (_, index) => (sheet.getRow(box.top + index).height ?? 15) * EMU_PER_POINT);
  const boxWidth = widths.reduce((sum, width) => sum + width, 0);
  const boxHeight = heights.reduce((sum, height) => sum + height, 0);
  let columns = Math.ceil(Math.sqrt(images.length));
  let rows = Math.ceil(images.length / columns);
  if (boxHeight > boxWidth && columns !== rows) [columns, rows] = [rows, columns];
  const inset = IMAGE_INSET_PX * EMU_PER_PIXEL;
  const gap = TILE_GAP_PX * EMU_PER_PIXEL;
  const tileWidth = (boxWidth - inset * 2 - gap * (columns - 1)) / columns;
  const tileHeight = (boxHeight - inset * 2 - gap * (rows - 1)) / rows;
  const locate = (offset: number, sizes: readonly number[], origin: number): { index: number; offset: number } => {
    let index = 0;
    let rest = offset;
    while (index < sizes.length - 1 && rest >= sizes[index]) {
      rest -= sizes[index];
      index += 1;
    }
    return { index: origin - 1 + index, offset: Math.round(Math.min(rest, sizes[index] - 1)) };
  };
  const anchor = (x: number, y: number): NativeCellAnchor => {
    const column = locate(x, widths, box.left);
    const row = locate(y, heights, box.top);
    return { nativeCol: column.index, nativeColOff: column.offset, nativeRow: row.index, nativeRowOff: row.offset };
  };
  const crops = cropsOf(context, sheet);
  images.forEach((media, index) => {
    const x = inset + (index % columns) * (tileWidth + gap);
    const y = inset + Math.floor(index / columns) * (tileHeight + gap);
    sheet.addImage(imageId(context, media), {
      tl: anchor(x, y),
      br: anchor(x + tileWidth, y + tileHeight),
      editAs: "twoCell",
    } as unknown as ExcelJS.ImageRange);
    crops.push(coverCrop(media, tileWidth, tileHeight));
    context.placed.add(mediaKey(media));
  });
}

/** Re-places a template picture exactly where the template had it. */
function copyPicture(context: ExportContext, sheet: ExcelJS.Worksheet, media: DocumentMedia, shift: (row: number) => number): void {
  const native = media.anchor.native;
  const moved = (anchor: NativeCellAnchor): NativeCellAnchor => ({ ...anchor, nativeRow: shift(anchor.nativeRow + 1) - 1 });
  const range = native
    ? native.br
      ? { tl: moved(native.tl), br: moved(native.br), editAs: "oneCell" }
      : { tl: moved(native.tl), ext: native.ext ?? { width: 16, height: 16 }, editAs: "oneCell" }
    : { tl: { col: media.anchor.x, row: shift(Math.floor(media.anchor.y) + 1) - 1 + (media.anchor.y % 1) }, br: { col: media.anchor.x + media.anchor.width, row: shift(Math.floor(media.anchor.y) + 1) - 1 + (media.anchor.y % 1) + media.anchor.height }, editAs: "oneCell" };
  sheet.addImage(imageId(context, media), range as unknown as ExcelJS.ImageRange);
  cropsOf(context, sheet).push(undefined);
  context.placed.add(mediaKey(media));
}

function mergeBoxAt(merges: readonly MergeBox[], row: number, column: number): MergeBox {
  return merges.find((box) => row >= box.top && row <= box.bottom && column >= box.left && column <= box.right)
    ?? { top: row, left: column, bottom: row, right: column };
}

interface SourceTable {
  table: WorkbookSheet["table"];
  region: AggregationRegion;
}

function sourceTables(context: ExportContext): (sheetId: string) => SourceTable | undefined {
  const cache = new Map<string, SourceTable | undefined>();
  return (sheetId) => {
    if (!cache.has(sheetId)) {
      const template = templateOf(context.draft, sheetId, context.documents);
      const region = template ? primaryRegion(template.sheet) : undefined;
      cache.set(sheetId, template?.workbookSheet && region ? { table: template.workbookSheet.table, region } : undefined);
    }
    return cache.get(sheetId);
  };
}

/** A result sheet from a template with header and records: the target's own rows, then appended rows. */
function writeRecordSheet(context: ExportContext, target: AggregationTarget, template: Template, records: readonly AggregationRecord[]): void {
  const output = context.workbook.addWorksheet(safeSheetName(target.name, context.used));
  const region = primaryRegion(template.sheet);
  const mappings = context.mappings.filter((mapping) => mapping.targetId === target.id);
  if (!template.workbookSheet || !region) {
    writePlainSheet(output, records, mappings);
    return;
  }
  const own = records.filter((record) => record.sheetId === template.sheet.id);
  const appended = records.filter((record) => record.sheetId !== template.sheet.id);
  const lastRow = Math.max(...region.records.map((record) => record.source.row ?? 0));
  const added = appended.length;
  const merges = copyTemplate(context, output, template.workbookSheet, lastRow, added, (row) => added === 0 || (row <= lastRow && row >= (region.records[0].source.row ?? 0)));
  const rows = template.workbookSheet.table.rows;
  const width = Math.max(template.workbookSheet.template?.columns.length ?? 0, ...rows.map((row) => row.length));
  const headerRow = rangeBounds(region.headerRange)?.endRow ?? Math.max(1, (region.records[0].source.row ?? 2) - 1);

  // Fields the target does not have take new columns only when included.
  const columnOf = new Map<string, number>();
  let next = width;
  for (const mapping of mappings) {
    const column = mapping.targetColumn ?? ++next;
    columnOf.set(mapping.id, column);
    if (mapping.targetColumn === undefined) {
      const header = output.getCell(headerRow, column);
      header.value = mapping.targetField;
      neutralHeader(header);
      output.getColumn(column).width = Math.min(48, Math.max(12, mapping.targetField.length + 4));
    }
  }

  const representativeRow = region.records[0].source.row ?? lastRow;
  const representative = rows[representativeRow - 1] ?? [];
  const representativeHeight = template.workbookSheet.template?.rows.find((row) => row.number === representativeRow)?.height;
  const rowMerges = merges.filter((box) => box.top === representativeRow && box.bottom === representativeRow);
  const tableOf = sourceTables(context);
  const placements: Array<{ record: AggregationRecord; row: number }> = own.map((record) => ({ record, row: record.source.row ?? 0 }));
  appended.forEach((record, index) => {
    const rowNumber = lastRow + 1 + index;
    const row = output.getRow(rowNumber);
    if (representativeHeight !== undefined) row.height = representativeHeight;
    for (let column = 1; column <= width; column += 1) {
      const style = styleCopy(representative[column - 1]?.style);
      if (style) row.getCell(column).style = style;
    }
    for (const box of rowMerges) {
      output.mergeCells(rowNumber, box.left, rowNumber, box.right);
      merges.push({ top: rowNumber, left: box.left, bottom: rowNumber, right: box.right });
    }
    for (const mapping of mappings) {
      const column = columnOf.get(mapping.id)!;
      const exported = targetCell(mappedFields(record, mapping), mapping);
      const cell = row.getCell(column);
      cell.value = exported.value;
      applyTargetStyle(cell, column <= width ? representative[column - 1] : undefined, exported);
    }
    const source = tableOf(record.sheetId);
    for (const helper of target.helpers) {
      const cell = row.getCell(helper.column);
      if (helper.fill === "formula" && helper.formula) {
        cell.value = { formula: helper.formula.replaceAll("{ROW}", String(rowNumber)) } as ExcelJS.CellFormulaValue;
      } else if (helper.fill === "value" && source) {
        const offset = helper.column - Math.min(...region.headerColumns);
        const value = storedValue(source.table.rows[(record.source.row ?? 0) - 1]?.[Math.min(...source.region.headerColumns) + offset - 1]);
        if (value !== null) cell.value = value;
      }
    }
    placements.push({ record, row: rowNumber });
  });

  // Pictures go into the record's own target cell, in the order their rows appear.
  for (const { record, row } of placements) {
    const byColumn = new Map<number, DocumentMedia[]>();
    for (const reference of record.media) {
      const media = context.mediaById.get(mediaKey(reference));
      if (!embeddable(media) || context.placed.has(mediaKey(media))) continue;
      const mapping = mappings.find((candidate) => candidate.sourceFields.some((field) => field.sheetId === record.sheetId && field.field === reference.role));
      const column = mapping ? columnOf.get(mapping.id) : undefined;
      if (column === undefined) continue;
      byColumn.set(column, [...(byColumn.get(column) ?? []), media]);
    }
    for (const [column, images] of byColumn) {
      const box = mergeBoxAt(merges, row, column);
      for (let number = box.top; number <= box.bottom; number += 1) {
        const outputRow = output.getRow(number);
        if ((outputRow.height ?? 15) < MIN_IMAGE_ROW_POINTS / (box.bottom - box.top + 1)) outputRow.height = MIN_IMAGE_ROW_POINTS / (box.bottom - box.top + 1);
      }
      placeCover(context, output, box, images);
    }
  }

  // Everything else the template drew (logos, stamps) stays where it was.
  const shift = (row: number): number => row > lastRow ? row + added : row;
  for (const media of template.document?.media ?? []) {
    if (media.source.sheet !== template.sheet.name || !embeddable(media) || context.placed.has(mediaKey(media))) continue;
    copyPicture(context, output, media, shift);
  }
}

/** Without the parsed template (older callers) the records still export as a plain table. */
function writePlainSheet(output: ExcelJS.Worksheet, records: readonly AggregationRecord[], mappings: readonly AggregationFieldMapping[]): void {
  output.addRow(mappings.map((mapping) => mapping.targetField)).eachCell(neutralHeader);
  for (const record of records) {
    const row = output.addRow([]);
    mappings.forEach((mapping, index) => {
      const exported = targetCell(mappedFields(record, mapping), mapping);
      const cell = row.getCell(index + 1);
      cell.value = exported.value;
      if (exported.numberFormat) cell.numFmt = exported.numberFormat;
    });
  }
  formatWorksheet(output, { freezeHeader: true, autoFilter: true });
  mappings.forEach((_, index) => {
    const column = output.getColumn(index + 1);
    if (column.width !== undefined) return;
    const longest = Math.max(12, ...Array.from({ length: output.rowCount }, (__, row) => String(output.getCell(row + 1, index + 1).text).length + 2));
    column.width = Math.min(48, longest);
  });
}

/** A calculated or reference sheet of the target, copied whole; its formulas recalculate on open. */
function writeCopiedSheet(context: ExportContext, target: AggregationTarget, template: Template): void {
  const output = context.workbook.addWorksheet(safeSheetName(target.name, context.used));
  if (!template.workbookSheet) return;
  copyTemplate(context, output, template.workbookSheet, Number.POSITIVE_INFINITY, 0, () => target.kind !== "calculated");
  for (const media of template.document?.media ?? []) {
    if (media.source.sheet !== template.sheet.name || !embeddable(media) || context.placed.has(mediaKey(media))) continue;
    copyPicture(context, output, media, (row) => row);
  }
}

/** Fits a picture inside the attachment column without cropping or distortion. */
function fittedSize(media: DocumentMedia, maxWidth: number, maxHeight = ATTACHMENT_BOX_HEIGHT): { width: number; height: number } {
  const natural = imagePixelSize(media.data, media.extension);
  if (!natural || natural.width <= 0 || natural.height <= 0) {
    return { width: Math.min(maxWidth, ATTACHMENT_BOX_WIDTH), height: Math.min(maxHeight, ATTACHMENT_BOX_HEIGHT) };
  }
  const scale = Math.min(maxWidth / natural.width, maxHeight / natural.height, 1);
  return { width: Math.max(1, natural.width * scale), height: Math.max(1, natural.height * scale) };
}

/** Pictures no record owns are listed with their origin instead of being dropped. */
function addAttachmentSheet(context: ExportContext, media: readonly DocumentMedia[], fileNames: ReadonlyMap<string, string>): void {
  const sheet = context.workbook.addWorksheet(safeSheetName("첨부 이미지", context.used));
  sheet.addRow(["출처 파일", "출처 시트", "출처 범위", IMAGE_COLUMN]);
  formatWorksheet(sheet, { freezeHeader: true });
  sheet.getColumn(4).width = Math.ceil((ATTACHMENT_BOX_WIDTH + 8) / 7);
  const available = columnPixels(sheet.getColumn(4).width) - ATTACHMENT_PADDING * 2;
  const crops = cropsOf(context, sheet);
  media.forEach((item, index) => {
    const rowNumber = index + 2;
    sheet.addRow([fileNames.get(item.source.fileId) ?? item.source.fileId, item.source.sheet ?? "", item.source.cellRange ?? "", null]);
    const size = fittedSize(item, available);
    sheet.getRow(rowNumber).height = (size.height + ATTACHMENT_PADDING * 2) * 0.75;
    sheet.addImage(imageId(context, item), {
      tl: { col: 3 + ATTACHMENT_PADDING / columnPixels(sheet.getColumn(4).width), row: rowNumber - 1 + 0.02 },
      ext: size,
      editAs: "oneCell",
    });
    crops.push(undefined);
    context.placed.add(mediaKey(item));
  });
}

const xmlUnescape = (value: string): string => value.replace(/&quot;/gu, "\"").replace(/&apos;/gu, "'").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&");

function relationshipTargets(xml: string): Array<{ id: string; type: string; target: string }> {
  return [...xml.matchAll(/<Relationship\b[^>]*>/gu)].map(([tag]) => ({
    id: /\sId="([^"]*)"/u.exec(tag)?.[1] ?? "",
    type: /\sType="([^"]*)"/u.exec(tag)?.[1] ?? "",
    target: /\sTarget="([^"]*)"/u.exec(tag)?.[1] ?? "",
  }));
}

function resolvePart(from: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = from.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment && segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

/**
 * ExcelJS stretches every picture to its anchor and cannot crop. Cover
 * placement needs the DrawingML source rectangle, so it is added to each
 * cropped picture of the written package.
 */
function applyCrops(bytes: Uint8Array, crops: ReadonlyMap<string, ReadonlyArray<SourceCrop | undefined>>): Uint8Array {
  if (![...crops.values()].some((list) => list.some(Boolean))) return bytes;
  const files = unzipSync(bytes);
  const workbook = strFromU8(files["xl/workbook.xml"]);
  const workbookRels = relationshipTargets(strFromU8(files["xl/_rels/workbook.xml.rels"]));
  for (const [tag] of workbook.matchAll(/<sheet\b[^>]*>/gu)) {
    const name = xmlUnescape(/\sname="([^"]*)"/u.exec(tag)?.[1] ?? "");
    const list = crops.get(name);
    if (!list?.some(Boolean)) continue;
    const rid = /\sr:id="([^"]*)"/u.exec(tag)?.[1];
    const sheetTarget = workbookRels.find((relationship) => relationship.id === rid)?.target;
    if (!sheetTarget) continue;
    const sheetPath = resolvePart("xl/workbook.xml", sheetTarget);
    const sheetRels = files[sheetPath.replace(/([^/]+)$/u, "_rels/$1.rels")];
    const drawingTarget = sheetRels ? relationshipTargets(strFromU8(sheetRels)).find((relationship) => relationship.type.endsWith("/drawing"))?.target : undefined;
    if (!drawingTarget) continue;
    const drawingPath = resolvePart(sheetPath, drawingTarget);
    let index = 0;
    const drawing = strFromU8(files[drawingPath]).replace(/<xdr:pic\b[\s\S]*?<\/xdr:pic>/gu, (picture) => {
      const crop = list[index];
      index += 1;
      if (!crop) return picture;
      return picture.replace(/(<a:blip\b[^>]*?(?:\/>|>[\s\S]*?<\/a:blip>))/u, `$1<a:srcRect l="${crop.l}" t="${crop.t}" r="${crop.r}" b="${crop.b}"/>`);
    });
    files[drawingPath] = strToU8(drawing);
  }
  return zipSync(files);
}

/**
 * Writes the target workbook with every selected source absorbed: target
 * sheets in their own order, source records appended in selection order,
 * summaries recalculating from the final data. Pictures that belong to no
 * record are listed separately instead of being dropped.
 */
export async function aggregationXlsxExport(
  draft: AggregationDraft,
  selection: AggregationSelection,
  documents: readonly NormalizedDocument[] = [],
): Promise<AggregationExport> {
  const selected = new Set(selection.sheetIds);
  const sheets = draft.workbooks.flatMap((workbook) => workbook.sheets);
  const selectedSheetsByKey = new Map(sheets.filter((sheet) => selected.has(sheet.id)).map((sheet) => [`${sheet.fileId}\u0000${sheet.name}`, sheet] as const));
  const mediaById = new Map(documents.flatMap((document) => document.media ?? []).map((media) => [mediaKey(media), media]));
  const unsupported = [...mediaById.values()].filter((media) =>
    selectedSheetsByKey.has(`${media.source.fileId}\u0000${media.source.sheet ?? ""}`) && !embeddable(media));
  if (unsupported.length) {
    throw new Error(`포함된 이미지 ${unsupported.length}건은 Excel 결과에 넣을 수 없는 형식입니다. 이미지가 누락되지 않도록 지원 형식(PNG, JPEG, GIF)으로 바꾼 뒤 다시 시도해 주세요.`);
  }
  const workbook = new ExcelJS.Workbook();
  // Summaries keep their formulas; Excel recalculates them over the final rows.
  workbook.calcProperties.fullCalcOnLoad = true;
  const context: ExportContext = {
    workbook,
    draft,
    documents,
    mappings: selectedMappings(draft, selection),
    mediaById,
    imageIds: new Map(),
    placed: new Set(),
    used: new Set(),
    crops: new Map(),
    growth: new Map(),
  };

  const sheetById = new Map(sheets.map((sheet) => [sheet.id, sheet]));
  const recordsOf = (target: AggregationTarget): AggregationRecord[] => {
    const allowed = new Map(target.sheetIds.filter((id) => selected.has(id)).map((id) => {
      const sheet = sheetById.get(id);
      return [id, sheet ? primaryRegion(sheet)?.id : undefined] as const;
    }));
    return draft.records.filter((record) => allowed.has(record.sheetId) && (record.sheetId === target.sheetId || allowed.get(record.sheetId) === record.regionId));
  };
  const written = draft.targets.filter((target) => selected.has(target.sheetId));
  for (const target of written) {
    if (target.kind !== "records") continue;
    const template = sheetById.get(target.sheetId);
    const region = template ? primaryRegion(template) : undefined;
    if (!region) continue;
    const added = recordsOf(target).filter((record) => record.sheetId !== target.sheetId).length;
    if (added > 0) context.growth.set(sheetKey(target.name), { lastRow: Math.max(...region.records.map((record) => record.source.row ?? 0)), added });
  }

  for (const target of written) {
    const template = templateOf(draft, target.sheetId, documents);
    if (!template) continue;
    if (target.kind === "records" || target.kind === "source") writeRecordSheet(context, target, template, recordsOf(target));
    else writeCopiedSheet(context, target, template);
  }

  const linked = new Set(draft.records.filter((record) => selected.has(record.sheetId)).flatMap((record) => record.media.map(mediaKey)));
  const unplaced = [...mediaById.values()].filter((media) => {
    if (!embeddable(media) || context.placed.has(mediaKey(media))) return false;
    const sourceSheet = selectedSheetsByKey.get(`${media.source.fileId}\u0000${media.source.sheet ?? ""}`);
    if (!sourceSheet || sourceSheet.plan.kind === "summarized") return false;
    const headerRow = rangeBounds(primaryRegion(sourceSheet)?.headerRange)?.endRow;
    // A source's own title art belongs to that file, not the result.
    return linked.has(mediaKey(media)) || headerRow === undefined || media.anchor.y >= headerRow;
  });
  if (unplaced.length > 0) addAttachmentSheet(context, unplaced, new Map(documents.map((document) => [document.fileId, document.metadata.fileName])));

  if (workbook.worksheets.length === 0) {
    const sheet = workbook.addWorksheet("취합 결과");
    sheet.addRow(["안내"]);
    sheet.addRow(["선택한 시트에서 취합할 레코드를 찾지 못했습니다."]);
    formatWorksheet(sheet, { freezeHeader: true });
  }

  const content = new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer);
  return { fileName: "worklens-aggregation.xlsx", mimeType: XLSX_MIME_TYPE, content: applyCrops(content, context.crops) };
}
