import type {
  AggregationDraft,
  AggregationField,
  AggregationFieldMapping,
  AggregationHelperColumn,
  AggregationIssue,
  AggregationMappingStatus,
  AggregationRecord,
  AggregationRegion,
  AggregationSheet,
  AggregationTarget,
  AggregationTargetKind,
  AggregationTargetType,
  AggregationWorkbook,
} from "@/domain/aggregation";
import { AGGREGATION_UNSUPPORTED_DETAIL, AGGREGATION_UNSUPPORTED_TITLE, isAggregationFileKind } from "@/domain/aggregation";
import type { DocumentMedia, NormalizedDocument, SourceRef, TableBlock, TableCell, WorkbookSheet } from "@/domain/document";
import { classifyValue, normalizeValue } from "@/lib/extract/values";
import { DocumentError } from "@/lib/upload";
import { isDateNumberFormat } from "@/lib/xlsx-values";
import { isExternalFormula, rowTemplate } from "./formula";
import { primaryRegion } from "./values";

const MAX_HEADER_SCAN_ROWS = 24;
const MIN_RECORD_CELLS = 2;
const MAX_REGIONS_PER_SHEET = 12;
/** Values a reader must never see; they mean a cell failed to render, not a value. */
const UNREADABLE_TEXT = /^(?:\[object\s[^\]]*\]|undefined|null|NaN)$/u;
const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/u;
const LOOSE_DATE = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})\.?$/u;
const MONTH_PERIOD = /^(\d{4})\s*(?:년\s*(\d{1,2})\s*월?|[-./]\s*(\d{1,2})\.?)$/u;
const MONTH_ONLY = /^(\d{1,2})\s*월$/u;
/**
 * Established business synonyms only; the first label of a group is the
 * canonical name. Spelling similarity alone never relates two fields.
 */
const ALIAS_GROUPS: readonly (readonly string[])[] = [
  ["부서", "부서명", "담당부서"],
  ["매출", "매출액", "매출금액"],
  ["비용", "비용액", "지출액"],
  ["인원", "인원수"],
  ["문제점", "현상 파악", "문제 현상"],
  ["관리 No", "관리번호", "관리 번호"],
];


function fieldKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[\s._/\\:：()[\]{}-]+/gu, "");
}

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * One calendar day has one field name. KPI workbooks label columns with dates
 * written several ways, and unless they collapse to one canonical label the
 * same day becomes several fields the user then has to reconcile by hand.
 */
function canonicalDateLabel(value: string): string | undefined {
  const text = value.trim();
  const date = ISO_DATE.exec(text) ?? LOOSE_DATE.exec(text);
  if (date) {
    const year = Number(date[1]);
    const month = Number(date[2]);
    const day = Number(date[3]);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return undefined;
    const label = `${date[1]}.${pad(month)}.${pad(day)}`;
    return date[4] && (date[4] !== "00" || date[5] !== "00")
      ? `${label} ${date[4]}:${date[5]}`
      : label;
  }
  const period = MONTH_PERIOD.exec(text);
  if (period) {
    const month = Number(period[2] ?? period[3]);
    return month >= 1 && month <= 12 ? `${period[1]}.${pad(month)}` : undefined;
  }
  const month = MONTH_ONLY.exec(text);
  return month && Number(month[1]) >= 1 && Number(month[1]) <= 12 ? `${pad(Number(month[1]))}월` : undefined;
}

function canonicalField(value: string): string {
  return value.split(" > ").map((part) => {
    const label = canonicalDateLabel(part) ?? part.trim();
    const key = fieldKey(label);
    for (const [canonical, ...aliases] of ALIAS_GROUPS) {
      if (aliases.some((alias) => fieldKey(alias) === key)) return canonical;
    }
    return label;
  }).join(" > ");
}

function columnName(column: number): string {
  let value = column;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result || "A";
}

/** Only what the cell actually displays; an unrendered object is no text at all. */
function cellText(cell: TableCell | undefined): string {
  const display = cell?.display.trim() ?? "";
  if (display && !UNREADABLE_TEXT.test(display)) return display;
  const value = cell?.value;
  if (typeof value === "string") return UNREADABLE_TEXT.test(value.trim()) ? "" : value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function nonEmptyCount(row: readonly TableCell[]): number {
  return row.reduce((count, cell) => count + (cellText(cell) ? 1 : 0), 0);
}

function sourceRange(source: SourceRef, range: string, row?: number, column?: number): SourceRef {
  const sheet = source.sheet ?? (source.locator?.kind === "xlsx" ? source.locator.sheet : undefined);
  return {
    ...source,
    nodeId: `${source.nodeId}:${range}`,
    label: sheet ? `${sheet}!${range}` : `${source.label} · ${range}`,
    ...(sheet ? { sheet } : {}),
    cellRange: range,
    ...(row ? { row } : {}),
    ...(column ? { column } : {}),
    ...(sheet ? { locator: { kind: "xlsx" as const, sheet, range } } : {}),
  };
}

function rowBands(rows: readonly TableCell[][]): Array<{ start: number; end: number }> {
  const bands: Array<{ start: number; end: number }> = [];
  let start = -1;
  rows.forEach((row, index) => {
    if (nonEmptyCount(row) > 0) {
      if (start < 0) start = index;
    } else if (start >= 0) {
      bands.push({ start, end: index - 1 });
      start = -1;
    }
  });
  if (start >= 0) bands.push({ start, end: rows.length - 1 });
  return bands;
}

function headerScore(rows: readonly TableCell[][], rowIndex: number, end: number): number {
  const row = rows[rowIndex] ?? [];
  const labels = row.map(cellText).filter(Boolean);
  if (labels.length < 2) return -1;
  const textLabels = labels.filter((value) => /[A-Za-z가-힣]/u.test(value) || canonicalDateLabel(value) !== undefined).length;
  const nextRows = rows.slice(rowIndex + 1, Math.min(end + 1, rowIndex + 6));
  const populated = nextRows.filter((candidate) => nonEmptyCount(candidate) >= MIN_RECORD_CELLS).length;
  if (populated === 0) return -1;
  const unique = new Set(labels.map(fieldKey)).size;
  const tiered = row.some((cell, column) => (cell.colSpan ?? 1) > 1
    && Array.from({ length: cell.colSpan! }, (_, offset) => headerLabel(rows[rowIndex + 1]?.[column + offset])).filter(Boolean).length >= 2);
  return textLabels * 2 + populated + unique / Math.max(1, labels.length) + (tiered ? 8 : 0) - rowIndex * 0.01;
}

function detectHeader(rows: readonly TableCell[][], start: number, end: number): { row: number; depth: number } | undefined {
  let best: { row: number; score: number } | undefined;
  for (let row = start; row <= Math.min(end - 1, start + MAX_HEADER_SCAN_ROWS); row += 1) {
    const score = headerScore(rows, row, end);
    if (!best || score > best.score) best = { row, score };
  }
  if (!best || best.score < 4) return undefined;
  const first = rows[best.row] ?? [];
  const second = rows[best.row + 1] ?? [];
  const tiered = first.some((cell, column) => (cell.colSpan ?? 1) > 1
    && Array.from({ length: cell.colSpan! }, (_, offset) => headerLabel(second[column + offset])).filter(Boolean).length >= 2);
  return { row: best.row, depth: tiered && best.row + 2 <= end ? 2 : 1 };
}

/** A header is the text a person reads, canonicalised only for dates. */
function headerLabel(cell: TableCell | undefined): string {
  const text = cellText(cell);
  if (!text) return "";
  return canonicalDateLabel(text) ?? text.replace(/\s+/gu, " ").trim();
}

function headersFor(rows: readonly TableCell[][], headerRow: number, depth: number): Array<{ column: number; label: string }> {
  const first = rows[headerRow] ?? [];
  const second = depth === 2 ? rows[headerRow + 1] ?? [] : [];
  const headers: Array<{ column: number; label: string }> = [];
  const width = Math.max(first.length, second.length);
  for (let column = 0; column < width; column += 1) {
    // Merged children are blank in the parser. A heading belongs only to its
    // actual span, never every column until the next nonempty heading.
    let parent = headerLabel(first[column]);
    if (!parent && depth === 2) {
      for (let anchor = column - 1; anchor >= 0; anchor -= 1) {
        const span = first[anchor]?.colSpan ?? 1;
        if (anchor + span <= column) break;
        parent = headerLabel(first[anchor]);
        if (parent) break;
      }
    }
    const child = headerLabel(second[column]);
    const label = child && parent && fieldKey(child) !== fieldKey(parent)
      ? `${parent} > ${child}`
      : parent || child;
    if (label) headers.push({ column, label });
  }
  return headers;
}

function typedField(label: string, cell: TableCell): AggregationField {
  const displayValue = cellText(cell);
  const isoDate = cell.valueType === "date" && typeof cell.value === "string" ? ISO_DATE.exec(cell.value) : null;
  // Midnight is how a plain calendar day serializes; only a real time of day
  // makes the value a date-time.
  const hasTimeOfDay = Boolean(isoDate?.[4]) && !(isoDate?.[4] === "00" && isoDate?.[5] === "00");
  const inferred = cell.valueType === "date"
    ? (hasTimeOfDay ? "DateTime" : "Date")
    : classifyValue(displayValue);
  const normalized = isoDate
    ? (hasTimeOfDay ? `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}T${isoDate[4]}:${isoDate[5]}` : `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`)
    : normalizeValue(displayValue, inferred);
  return {
    key: fieldKey(label),
    label,
    value: {
      displayValue,
      value: cell.value,
      ...(normalized ? { normalizedValue: normalized } : {}),
      type: inferred,
      ...(cell.valueType ? { cellType: cell.valueType } : {}),
      ...(cell.numberFormat ? { numberFormat: cell.numberFormat } : {}),
      sources: [cell.source],
    },
  };
}

function associateRecordMedia(
  mediaItems: readonly DocumentMedia[],
  sheet: string | undefined,
  headers: readonly { column: number; label: string }[],
  records: AggregationRecord[],
  linked: Set<string>,
): void {
  for (const media of mediaItems) {
    if (media.source.sheet !== sheet || linked.has(media.id) || media.anchor.unit !== "cell") continue;
    const { x, y } = media.anchor;
    const width = Math.max(media.anchor.width, 0.01);
    const height = Math.max(media.anchor.height, 0.01);
    // A large drawing across the table is not evidence that it belongs to a
    // particular record or column (logos and other decorative art remain on
    // the sheet, not inside a record).
    if (width > 4 || height > 3) continue;
    const covered = headers.filter(({ column }) => Math.min(x + width, column + 1) > Math.max(x, column));
    if (covered.length === 0) continue;
    const centered = covered.find(({ column }) => x + width / 2 >= column && x + width / 2 < column + 1);
    const anchored = covered.find(({ column }) => column + 1 === media.source.column);
    const semantic = centered ?? anchored ?? covered.reduce((best, header) => {
      const overlap = Math.min(x + width, header.column + 1) - Math.max(x, header.column);
      const bestOverlap = Math.min(x + width, best.column + 1) - Math.max(x, best.column);
      return overlap > bestOverlap ? header : best;
    });
    const center = y + height / 2;
    let best: { record: AggregationRecord; overlap: number; distance: number } | undefined;
    let ambiguous = false;
    for (const record of records) {
      if (record.source.row === undefined) continue;
      const rowStart = record.source.row - 1;
      const overlap = Math.min(y + height, rowStart + 1) - Math.max(y, rowStart);
      if (overlap <= 0) continue;
      const distance = Math.abs(center - (rowStart + 0.5));
      if (!best || overlap > best.overlap + 1e-6 || (Math.abs(overlap - best.overlap) <= 1e-6 && distance < best.distance - 1e-6)) {
        best = { record, overlap, distance };
        ambiguous = false;
      } else if (Math.abs(overlap - best.overlap) <= 1e-6 && Math.abs(distance - best.distance) <= 1e-6) {
        ambiguous = true;
      }
    }
    if (!best || ambiguous) continue;
    best.record.media.push({ id: media.id, source: media.source, role: semantic.label });
    linked.add(media.id);
  }
}

function regionsForTable(document: NormalizedDocument, sheetId: string, table: TableBlock): AggregationRegion[] {
  const regions: AggregationRegion[] = [];
  const bands = rowBands(table.rows);
  const linkedMedia = new Set<string>();
  for (const band of bands) {
    if (regions.length >= MAX_REGIONS_PER_SHEET || band.end - band.start < 1) continue;
    const header = detectHeader(table.rows, band.start, band.end);
    if (!header) continue;
    const headers = headersFor(table.rows, header.row, header.depth);
    if (headers.length < 2) continue;
    const dataStart = header.row + header.depth;
    const records: AggregationRecord[] = [];
    for (let rowIndex = dataStart; rowIndex <= band.end; rowIndex += 1) {
      const row = table.rows[rowIndex] ?? [];
      const fields = headers.flatMap(({ column, label }) => {
        const cell = row[column];
        return cell && cellText(cell) ? [typedField(label, cell)] : [];
      });
      if (fields.length < MIN_RECORD_CELLS) continue;
      const firstColumn = Math.min(...headers.map((entry) => entry.column)) + 1;
      const lastColumn = Math.max(...headers.map((entry) => entry.column)) + 1;
      const rowNumber = rowIndex + 1;
      const range = `${columnName(firstColumn)}${rowNumber}:${columnName(lastColumn)}${rowNumber}`;
      const source = sourceRange(table.source, range, rowNumber, firstColumn);
      records.push({
        id: `${sheetId}:region:${regions.length + 1}:record:${records.length + 1}`,
        documentId: document.id,
        sheetId,
        regionId: `${sheetId}:region:${regions.length + 1}`,
        fields,
        media: [],
        source,
      });
    }
    if (records.length === 0) continue;
    const firstColumn = Math.min(...headers.map((entry) => entry.column)) + 1;
    const lastColumn = Math.max(...headers.map((entry) => entry.column)) + 1;
    const headerRange = `${columnName(firstColumn)}${header.row + 1}:${columnName(lastColumn)}${header.row + header.depth}`;
    const recordRange = `${columnName(firstColumn)}${dataStart + 1}:${columnName(lastColumn)}${band.end + 1}`;
    const id = `${sheetId}:region:${regions.length + 1}`;
    records.forEach((record) => { record.regionId = id; });
    associateRecordMedia(document.media ?? [], table.source.sheet, headers, records, linkedMedia);
    regions.push({
      id,
      headerRange,
      recordRange,
      headers: headers.map((entry) => entry.label),
      headerColumns: headers.map((entry) => entry.column + 1),
      records,
      source: sourceRange(table.source, `${headerRange},${recordRange}`),
      status: "ready",
    });
  }
  return regions;
}
/** Internal formulas among a region's filled record cells, as a share. */
function formulaShare(table: TableBlock, region: AggregationRegion): number {
  let filled = 0;
  let formulas = 0;
  for (const record of region.records) {
    const row = table.rows[(record.source.row ?? 0) - 1] ?? [];
    for (const column of region.headerColumns) {
      const cell = row[column - 1];
      if (!cell || (!cellText(cell) && !cell.formula)) continue;
      filled += 1;
      if (cell.formula && !isExternalFormula(cell.formula)) formulas += 1;
    }
  }
  return filled ? formulas / filled : 0;
}

function workbookSheet(document: NormalizedDocument, sheet: WorkbookSheet): AggregationSheet {
  const id = `${document.fileId}:sheet:${sheet.index}`;
  const regions = regionsForTable(document, id, sheet.table);
  const hasValues = sheet.table.rows.some((row) => nonEmptyCount(row) > 0);
  const role = !hasValues ? "empty" : regions.length ? (sheet.visibility === "visible" ? "records" : "review") : "reference";
  const primary = primaryRegion({ regions });
  return {
    id,
    documentId: document.id,
    fileId: document.fileId,
    fileName: document.metadata.fileName,
    name: sheet.name,
    index: sheet.index,
    visibility: sheet.visibility,
    role,
    selectedByDefault: false,
    regions,
    media: (document.media ?? []).filter((media) => media.source.sheet === sheet.name).map((media) => ({ id: media.id, source: media.source })),
    source: sheet.table.source,
    calculated: primary ? formulaShare(sheet.table, primary) >= 0.5 : false,
    plan: { kind: "ignored" },
    ...(!hasValues ? { reason: "빈 시트" } : regions.length === 0 ? { reason: "반복 레코드 구조를 확정하지 못했습니다." } : sheet.visibility !== "visible" ? { reason: "숨김 시트는 확인 후 포함할 수 있습니다." } : {}),
  };
}

function safeWorkbookSheet(document: NormalizedDocument, sheet: WorkbookSheet): AggregationSheet {
  try {
    return workbookSheet(document, sheet);
  } catch (error) {
    const id = `${document.fileId}:sheet:${sheet.index}`;
    return {
      id,
      documentId: document.id,
      fileId: document.fileId,
      fileName: document.metadata.fileName,
      name: sheet.name,
      index: sheet.index,
      visibility: sheet.visibility,
      role: "review",
      selectedByDefault: false,
      regions: [],
      media: [],
      source: sheet.table.source,
      calculated: false,
      plan: { kind: "ignored" },
      reason: error instanceof Error && error.message ? `시트 분석 실패: ${error.message}` : "시트 분석에 실패했습니다.",
    };
  }
}

/**
 * Excel's own sheet hierarchy is the aggregation unit: visibility, header
 * region, style template and media all hang off a real worksheet.
 */
function documentWorkbook(document: NormalizedDocument & { kind: "xlsx" }): AggregationWorkbook {
  const sheets = (document.workbookSheets ?? []).map((sheet) => safeWorkbookSheet(document, sheet));
  return { id: `aggregation:${document.id}`, fileId: document.fileId, fileName: document.metadata.fileName, kind: "xlsx", sheets };
}

interface FieldPair {
  target: number;
  status: AggregationMappingStatus;
}

const STATUS_RANK: Record<AggregationMappingStatus, number> = { confirmed: 0, suggested: 1, review: 2 };
const worse = (left: AggregationMappingStatus, right: AggregationMappingStatus): AggregationMappingStatus =>
  STATUS_RANK[left] >= STATUS_RANK[right] ? left : right;
const fieldIdentity = (label: string): string => fieldKey(canonicalField(label));
const leafOf = (label: string): string => fieldKey(label.split(" > ").pop() ?? label);

/**
 * Maps source headers onto target headers by meaning, never by column letter.
 * Exact and established-synonym names map first, then a unique leaf under a
 * renamed parent. With `positional`, a single unmatched source field between
 * the same matched neighbours as a single unmatched target field is paired for
 * the user to confirm.
 */
function matchFields(sourceLabels: readonly string[], targetLabels: readonly string[], positional: boolean): Map<number, FieldPair> {
  const pairs = new Map<number, FieldPair>();
  const taken = new Set<number>();
  const targetKeys = targetLabels.map(fieldIdentity);
  const ambiguous = new Set(targetKeys.filter((key, index) => targetKeys.indexOf(key) !== index));
  sourceLabels.forEach((label, index) => {
    const key = fieldIdentity(label);
    if (ambiguous.has(key)) return;
    const target = targetKeys.indexOf(key);
    if (target < 0 || taken.has(target)) return;
    taken.add(target);
    pairs.set(index, { target, status: fieldKey(label) === fieldKey(targetLabels[target]) ? "confirmed" : "suggested" });
  });

  const targetLeaves = targetLabels.map(leafOf);
  const sourceLeaves = sourceLabels.map(leafOf);
  sourceLabels.forEach((label, index) => {
    if (pairs.has(index) || !label.includes(" > ")) return;
    const leaf = sourceLeaves[index];
    if (sourceLeaves.filter((entry) => entry === leaf).length !== 1) return;
    const candidates = targetLeaves.flatMap((entry, target) => entry === leaf && targetLabels[target].includes(" > ") ? [target] : []);
    if (candidates.length !== 1 || taken.has(candidates[0])) return;
    taken.add(candidates[0]);
    pairs.set(index, { target: candidates[0], status: "suggested" });
  });
  if (!positional) return pairs;

  sourceLabels.forEach((label, index) => {
    if (pairs.has(index) || canonicalDateLabel(label)) return;
    let previous = index - 1;
    while (previous >= 0 && !pairs.has(previous)) previous -= 1;
    let next = index + 1;
    while (next < sourceLabels.length && !pairs.has(next)) next += 1;
    const low = previous >= 0 ? pairs.get(previous)!.target : -1;
    const high = next < sourceLabels.length ? pairs.get(next)!.target : targetLabels.length;
    if (next - previous - 1 !== 1 || high - low - 1 !== 1) return;
    const candidate = low + 1;
    if (taken.has(candidate) || canonicalDateLabel(targetLabels[candidate])) return;
    taken.add(candidate);
    pairs.set(index, { target: candidate, status: "review" });
  });
  return pairs;
}


/**
 * How well a source sheet fits a target sheet, or undefined when it is not
 * the same table. Stable fields decide; monthly columns come and go, and a
 * type or column-letter difference is never a reason to split a table.
 */
function sheetFit(source: AggregationSheet, target: AggregationSheet): number | undefined {
  const sourceRegion = primaryRegion(source);
  const targetRegion = primaryRegion(target);
  if (!sourceRegion || !targetRegion) return undefined;
  const sourceStable = sourceRegion.headers.filter((label) => !canonicalDateLabel(label));
  const targetStable = targetRegion.headers.filter((label) => !canonicalDateLabel(label));
  const common = matchFields(sourceStable, targetStable, false).size;
  const ratio = common / Math.max(1, sourceStable.length, targetStable.length);
  const sameName = fieldKey(source.name) === fieldKey(target.name);
  const dated = common === 1 && sourceStable.length === 1 && targetStable.length === 1
    && sourceRegion.headers.length - sourceStable.length >= 2 && targetRegion.headers.length - targetStable.length >= 2;
  const fits = sameName ? common >= 1 && (ratio >= 0.4 || dated) : common >= 2 && ratio >= 0.6;
  return fits ? ratio + (sameName ? 0.5 : 0) : undefined;
}

function isNumericCell(cell: TableCell): boolean {
  return typeof cell.value === "number" && cell.valueType !== "date";
}

/** The meaning of a column as its own sheet stores it: dates, numbers or text. */
function columnSemantics(
  table: TableBlock | undefined,
  region: AggregationRegion,
  column: number,
): { targetType: AggregationTargetType; targetFormat?: string } {
  const cells = region.records
    .map((record) => table?.rows[(record.source.row ?? 0) - 1]?.[column - 1])
    .filter((cell): cell is TableCell => Boolean(cell));
  const format = cells.find((cell) => cell.numberFormat && cell.numberFormat !== "General")?.numberFormat;
  const filled = cells.filter((cell) => cellText(cell));
  const dates = filled.filter((cell) => cell.valueType === "date");
  const timed = dates.some((cell) => typeof cell.value === "string" && /T(?!00:00)\d{2}:\d{2}/u.test(cell.value));
  const withFormat = format ? { targetFormat: format } : {};
  if (dates.length > 0) return { targetType: timed || /h/iu.test(format ?? "") ? "datetime" : "date", ...withFormat };
  if (isDateNumberFormat(format) && filled.every((cell) => isNumericCell(cell) || !cellText(cell))) {
    return { targetType: /h/iu.test(format ?? "") ? "datetime" : "date", ...withFormat };
  }
  if (filled.length > 0 && filled.every(isNumericCell)) return { targetType: "number", ...withFormat };
  return { targetType: "text", ...withFormat };
}

interface PlanContext {
  tables: ReadonlyMap<string, TableBlock>;
  targets: AggregationTarget[];
  mappings: AggregationFieldMapping[];
  /** Target mappings parallel to the template sheet's primary headers. */
  columns: Map<string, AggregationFieldMapping[]>;
  issues: AggregationIssue[];
}

function newMapping(context: PlanContext, mapping: Omit<AggregationFieldMapping, "id">): AggregationFieldMapping {
  const created = { id: `mapping:${context.mappings.length + 1}`, ...mapping };
  context.mappings.push(created);
  return created;
}

function addTemplateMappings(context: PlanContext, target: AggregationTarget, sheet: AggregationSheet): void {
  const region = primaryRegion(sheet);
  if (!region) return;
  const table = context.tables.get(sheet.id);
  const keys = region.headers.map(fieldIdentity);
  context.columns.set(target.id, region.headers.map((label, index) => newMapping(context, {
    targetId: target.id,
    targetField: label,
    targetColumn: region.headerColumns[index],
    ...columnSemantics(table, region, region.headerColumns[index]),
    sourceFields: [{ sheetId: sheet.id, field: label }],
    // Two template headers with one normalized name cannot tell a source which it meant.
    status: keys.indexOf(keys[index]) !== keys.lastIndexOf(keys[index]) ? "review" : "confirmed",
    included: true,
  })));
}

function appendSourceMappings(context: PlanContext, target: AggregationTarget, template: AggregationSheet, source: AggregationSheet): void {
  const targetRegion = primaryRegion(template);
  const sourceRegion = primaryRegion(source);
  const columns = context.columns.get(target.id);
  if (!targetRegion || !sourceRegion || !columns) return;
  const table = context.tables.get(source.id);
  const pairs = matchFields(sourceRegion.headers, targetRegion.headers, true);
  sourceRegion.headers.forEach((label, index) => {
    const pair = pairs.get(index);
    if (pair) {
      const mapping = columns[pair.target];
      mapping.sourceFields.push({ sheetId: source.id, field: label });
      mapping.status = worse(mapping.status, pair.status);
      return;
    }
    const period = canonicalDateLabel(label);
    const identity = fieldIdentity(label);
    const existing = context.mappings.find((mapping) =>
      mapping.targetId === target.id && mapping.targetColumn === undefined && fieldIdentity(mapping.targetField) === identity);
    if (existing) {
      existing.sourceFields.push({ sheetId: source.id, field: label });
      return;
    }
    // A reporting period the target does not list yet extends the target's
    // period columns; any other field waits for the user instead of growing
    // the target layout.
    newMapping(context, {
      targetId: target.id,
      targetField: period ?? label,
      ...columnSemantics(table, sourceRegion, sourceRegion.headerColumns[index]),
      sourceFields: [{ sheetId: source.id, field: label }],
      status: period ? "confirmed" : "review",
      included: Boolean(period),
    });
  });
}

/**
 * Target columns outside the header span that the target's own records fill,
 * such as a month helper a summary counts. An appended row takes the target's
 * own row formula, otherwise a row formula a source keeps at the same place
 * relative to its table (re-expressed in target columns), otherwise the
 * source's value there.
 */
function helperColumns(context: PlanContext, target: AggregationTarget, template: AggregationSheet, sources: readonly AggregationSheet[]): AggregationHelperColumn[] {
  const region = primaryRegion(template);
  const table = context.tables.get(template.id);
  if (!region || !table) return [];
  const first = Math.min(...region.headerColumns);
  const inside = new Set(region.headerColumns);
  const rows = region.records.map((record) => record.source.row ?? 0);
  const width = Math.max(0, ...rows.map((row) => table.rows[row - 1]?.length ?? 0));
  const helpers: AggregationHelperColumn[] = [];
  for (let column = 1; column <= width; column += 1) {
    if (inside.has(column)) continue;
    const cells = rows.map((row) => ({ row, cell: table.rows[row - 1]?.[column - 1] }));
    if (!cells.some(({ cell }) => cell && (cellText(cell) || cell.formula))) continue;
    const own = cells.find(({ cell }) => cell?.formula);
    let formula = own?.cell?.formula ? rowTemplate(own.cell.formula, own.row, (source) => source) : undefined;
    let hasValue = false;
    for (const source of sources) {
      if (formula) break;
      const sourceRegion = primaryRegion(source);
      const sourceTable = context.tables.get(source.id);
      if (!sourceRegion || !sourceTable) continue;
      const sourceColumn = Math.min(...sourceRegion.headerColumns) + column - first;
      if (sourceColumn < 1) continue;
      const targetOf = (sourceCol: number): number | undefined => {
        const label = sourceRegion.headers[sourceRegion.headerColumns.indexOf(sourceCol)];
        return label === undefined ? undefined : context.mappings.find((mapping) =>
          mapping.targetId === target.id && mapping.sourceFields.some((field) => field.sheetId === source.id && field.field === label))?.targetColumn;
      };
      for (const record of sourceRegion.records) {
        const cell = sourceTable.rows[(record.source.row ?? 0) - 1]?.[sourceColumn - 1];
        if (cell && cellText(cell)) hasValue = true;
        if (cell?.formula) {
          formula = rowTemplate(cell.formula, record.source.row ?? 0, targetOf);
          if (formula) break;
        }
      }
    }
    helpers.push(formula ? { column, fill: "formula", formula } : { column, fill: hasValue ? "value" : "none" });
    if (!formula && !hasValue && sources.length > 0) {
      context.issues.push({
        scope: "sheet",
        id: template.id,
        fileName: template.fileName,
        sheetName: template.name,
        message: `표 밖 ${columnName(column)}열 값은 추가된 행에서 채울 근거가 없어 비워 둡니다.`,
      });
    }
  }
  return helpers;
}

function targetKind(sheet: AggregationSheet): AggregationTargetKind {
  return sheet.calculated ? "calculated" : sheet.regions.length ? "records" : "static";
}

function newTarget(sheet: AggregationSheet, kind: AggregationTargetKind): AggregationTarget {
  return {
    id: `target:${sheet.id}`,
    name: sheet.name,
    kind,
    sheetId: sheet.id,
    sheetIds: [sheet.id],
    fields: primaryRegion(sheet)?.headers ?? [],
    recordCount: primaryRegion(sheet)?.records.length ?? 0,
    helpers: [],
  };
}

/**
 * The first workbook is the result. Every later sheet is placed into the
 * target sheet that holds the same table (its rows appended), superseded by a
 * target summary that recalculates from the final data, or left for review.
 */
function planAggregation(workbooks: readonly AggregationWorkbook[], documents: readonly NormalizedDocument[]): Pick<AggregationDraft, "targets" | "mappings" | "issues"> {
  const tables = new Map(documents.flatMap((document) => (document.workbookSheets ?? [])
    .map((sheet) => [`${document.fileId}:sheet:${sheet.index}`, sheet.table] as const)));
  const context: PlanContext = { tables, targets: [], mappings: [], columns: new Map(), issues: [] };
  const [first, ...rest] = workbooks;
  if (!first) return { targets: [], mappings: [], issues: [] };
  const templates = new Map<string, AggregationSheet>();
  const appended = new Map<string, AggregationSheet[]>();

  for (const sheet of first.sheets) {
    const target = newTarget(sheet, targetKind(sheet));
    context.targets.push(target);
    templates.set(target.id, sheet);
    sheet.plan = { kind: "target", targetId: target.id };
    sheet.selectedByDefault = sheet.visibility === "visible" && sheet.role !== "empty";
    if (target.kind === "records") addTemplateMappings(context, target, sheet);
  }
  const absorbing = context.targets.filter((target) => target.kind === "records" || target.kind === "calculated");

  for (const workbook of rest) {
    for (const sheet of workbook.sheets) {
      if (sheet.regions.length === 0) {
        // A source's own summary with nothing to read is still that file's
        // copy of a target summary, not a separate structure to review.
        const namesake = context.targets.find((target) => target.kind === "calculated" && fieldKey(target.name) === fieldKey(sheet.name));
        sheet.plan = namesake ? { kind: "summarized", targetId: namesake.id } : { kind: "ignored" };
        if (namesake) sheet.reason = "기준 파일의 요약 수식이 최종 취합 데이터로 다시 계산합니다.";
        continue;
      }
      let best: { target: AggregationTarget; fit: number } | undefined;
      for (const target of absorbing) {
        const fit = sheetFit(sheet, templates.get(target.id)!);
        if (fit !== undefined && (!best || fit > best.fit)) best = { target, fit };
      }
      if (best?.target.kind === "calculated") {
        sheet.plan = { kind: "summarized", targetId: best.target.id };
        sheet.reason = "기준 파일의 요약 수식이 최종 취합 데이터로 다시 계산합니다.";
        continue;
      }
      if (best) {
        const target = best.target;
        sheet.plan = { kind: "append", targetId: target.id };
        sheet.selectedByDefault = sheet.visibility === "visible" && sheet.role === "records";
        target.sheetIds.push(sheet.id);
        target.recordCount += primaryRegion(sheet)?.records.length ?? 0;
        appended.set(target.id, [...(appended.get(target.id) ?? []), sheet]);
        appendSourceMappings(context, target, templates.get(target.id)!, sheet);
        continue;
      }
      const own = newTarget(sheet, "source");
      context.targets.push(own);
      addTemplateMappings(context, own, sheet);
      sheet.plan = { kind: "unmatched", targetId: own.id };
      sheet.reason = "기준 파일에 대응하는 시트가 없습니다. 필요하면 직접 포함하세요.";
      context.issues.push({ scope: "sheet", id: sheet.id, fileName: workbook.fileName, sheetName: sheet.name, message: sheet.reason });
    }
  }

  for (const target of context.targets) {
    const sources = appended.get(target.id) ?? [];
    if (target.kind === "records" && sources.length > 0) target.helpers = helperColumns(context, target, templates.get(target.id)!, sources);
  }

  // A column that carries pictures is an image field, whichever file supplied them.
  const roles = new Set(workbooks.flatMap((workbook) => workbook.sheets.flatMap((sheet) => sheet.regions.flatMap((region) =>
    region.records.flatMap((record) => record.media.map((media) => `${record.sheetId}\u0000${media.role ?? ""}`))))));
  for (const mapping of context.mappings) {
    if (mapping.sourceFields.some((field) => roles.has(`${field.sheetId}\u0000${field.field}`))) mapping.targetType = "image";
  }
  return { targets: context.targets, mappings: context.mappings, issues: context.issues };
}

function markDuplicates(records: AggregationRecord[]): void {
  const seen = new Map<string, string>();
  for (const record of records) {
    const preferred = record.fields.filter((field) => /(관리.*no|관리번호|문서번호|id|제목|부서|기간|기준일)/iu.test(field.label));
    const basis = (preferred.length ? preferred : record.fields.slice(0, 4)).map((field) => `${fieldKey(field.label)}=${field.value.normalizedValue ?? fieldKey(field.value.displayValue)}`).join("|");
    if (!basis) continue;
    const existing = seen.get(basis);
    if (existing) record.duplicateOf = existing;
    else seen.set(basis, record.id);
  }
}

export function buildAggregation(documents: readonly NormalizedDocument[]): AggregationDraft {
  if (documents.some((document) => !isAggregationFileKind(document.kind))) {
    throw new DocumentError("AGGREGATE_FORMAT_UNSUPPORTED", AGGREGATION_UNSUPPORTED_TITLE, AGGREGATION_UNSUPPORTED_DETAIL);
  }
  const xlsx = documents.filter((document): document is NormalizedDocument & { kind: "xlsx" } => isAggregationFileKind(document.kind));
  const workbooks = xlsx.map(documentWorkbook);
  const plan = planAggregation(workbooks, xlsx);
  const records = workbooks.flatMap((workbook) => workbook.sheets.flatMap((sheet) => sheet.regions.flatMap((region) => region.records)));
  markDuplicates(records);
  const structureIssues = workbooks.flatMap((workbook) => workbook.sheets
    .filter((sheet) => (sheet.role === "review" || sheet.role === "reference") && sheet.plan.kind !== "unmatched" && sheet.plan.kind !== "summarized")
    .map((sheet) => ({ scope: "sheet" as const, id: sheet.id, fileName: workbook.fileName, sheetName: sheet.name, message: sheet.reason ?? "확인이 필요한 구조입니다." })));
  return {
    ...(xlsx[0] ? { targetFileId: xlsx[0].fileId } : {}),
    workbooks,
    targets: plan.targets,
    mappings: plan.mappings,
    records,
    issues: [...structureIssues, ...plan.issues],
  };
}

