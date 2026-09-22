import type {
  AggregationDeck,
  AggregationDraft,
  AggregationField,
  AggregationFieldMapping,
  AggregationOutputFormat,
  AggregationRecord,
  AggregationRegion,
  AggregationSchemaGroup,
  AggregationSheet,
  AggregationWorkbook,
} from "@/domain/aggregation";
import type { NormalizedDocument, SourceRef, TableBlock, TableCell, WorkbookSheet } from "@/domain/document";
import { classifyValue, normalizeValue } from "@/lib/extract/values";

const MAX_HEADER_SCAN_ROWS = 24;
const MIN_RECORD_CELLS = 2;
const MAX_REGIONS_PER_SHEET = 12;
/** Values a reader must never see; they mean a cell failed to render, not a value. */
const UNREADABLE_TEXT = /^(?:\[object\s[^\]]*\]|undefined|null|NaN)$/u;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/u;
const LOOSE_DATE = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})\.?$/u;

const FIELD_ALIASES: Record<string, readonly string[]> = {
  "부서": ["부서", "부서명", "담당부서", "소속", "조직"],
  "매출": ["매출", "매출액", "매출금액"],
  "비용": ["비용", "비용액", "지출", "지출액"],
  "인원": ["인원", "인원수", "참석인원", "대상인원"],
  "기준일": ["기준일", "작성일", "등록일"],
  "제목": ["제목", "건명", "주제"],
};

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
  const iso = ISO_DATE.exec(text);
  if (iso) {
    const day = `${iso[1]}.${iso[2]}.${iso[3]}`;
    return iso[4] ? `${day} ${iso[4]}:${iso[5]}` : day;
  }
  const loose = LOOSE_DATE.exec(text);
  return loose ? `${loose[1]}.${pad(Number(loose[2]))}.${pad(Number(loose[3]))}` : undefined;
}

function canonicalField(value: string): string {
  const date = canonicalDateLabel(value);
  if (date) return date;
  const key = fieldKey(value);
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.some((alias) => fieldKey(alias) === key)) return canonical;
  }
  return value.trim();
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
  return textLabels * 2 + populated + unique / Math.max(1, labels.length) - rowIndex * 0.01;
}

function detectHeader(rows: readonly TableCell[][], start: number, end: number): { row: number; depth: number } | undefined {
  let best: { row: number; score: number } | undefined;
  for (let row = start; row <= Math.min(end - 1, start + MAX_HEADER_SCAN_ROWS); row += 1) {
    const score = headerScore(rows, row, end);
    if (!best || score > best.score) best = { row, score };
  }
  if (!best || best.score < 4) return undefined;
  const firstCount = nonEmptyCount(rows[best.row] ?? []);
  const secondCount = nonEmptyCount(rows[best.row + 1] ?? []);
  const thirdCount = nonEmptyCount(rows[best.row + 2] ?? []);
  const depth = secondCount > 0 && secondCount < firstCount && thirdCount >= MIN_RECORD_CELLS ? 2 : 1;
  return { row: best.row, depth };
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
  let carried = "";
  const headers: Array<{ column: number; label: string }> = [];
  const width = Math.max(first.length, second.length);
  for (let column = 0; column < width; column += 1) {
    const parent = headerLabel(first[column]);
    if (parent) carried = parent;
    const child = headerLabel(second[column]);
    const label = child && carried && fieldKey(child) !== fieldKey(carried) ? `${carried} ${child}` : parent || child;
    if (label) headers.push({ column, label: label.trim() });
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

function recordMedia(document: NormalizedDocument, source: SourceRef): AggregationRecord["media"] {
  return (document.media ?? []).filter((media) => {
    if (source.sheet && media.source.sheet === source.sheet && source.row && media.source.row) {
      return Math.floor(media.anchor.y) + 1 === source.row;
    }
    return source.page !== undefined && media.source.page === source.page;
  }).map((media) => ({ id: media.id, source: media.source }));
}

function regionsForTable(document: NormalizedDocument, sheetId: string, table: TableBlock): AggregationRegion[] {
  const regions: AggregationRegion[] = [];
  const bands = rowBands(table.rows);
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
        media: recordMedia(document, source),
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
    regions.push({ id, headerRange, recordRange, headers: headers.map((entry) => entry.label), records, source: sourceRange(table.source, `${headerRange},${recordRange}`), status: "ready" });
  }
  return regions;
}

function workbookSheet(document: NormalizedDocument, sheet: WorkbookSheet): AggregationSheet {
  const id = `${document.fileId}:sheet:${sheet.index}`;
  const regions = regionsForTable(document, id, sheet.table);
  const hasValues = sheet.table.rows.some((row) => nonEmptyCount(row) > 0);
  const role = !hasValues ? "empty" : regions.length ? (sheet.visibility === "visible" ? "records" : "review") : "reference";
  return {
    id,
    documentId: document.id,
    fileId: document.fileId,
    fileName: document.metadata.fileName,
    name: sheet.name,
    index: sheet.index,
    visibility: sheet.visibility,
    role,
    selectedByDefault: role === "records" && sheet.visibility === "visible",
    regions,
    media: (document.media ?? []).filter((media) => media.source.sheet === sheet.name).map((media) => ({ id: media.id, source: media.source })),
    source: sheet.table.source,
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
      reason: error instanceof Error && error.message ? `시트 분석 실패: ${error.message}` : "시트 분석에 실패했습니다.",
    };
  }
}

function documentWorkbook(document: NormalizedDocument): AggregationWorkbook {
  const sheets = document.kind === "xlsx" && document.workbookSheets
    ? document.workbookSheets.map((sheet) => safeWorkbookSheet(document, sheet))
    : document.blocks.filter((block): block is TableBlock => block.type === "table").map((table, index) =>
      safeWorkbookSheet(document, { index: index + 1, name: table.source.sheet ?? `Table ${index + 1}`, visibility: "visible", table }));
  return { id: `aggregation:${document.id}`, fileId: document.fileId, fileName: document.metadata.fileName, kind: document.kind, sheets };
}

function deckOf(document: NormalizedDocument): AggregationDeck {
  const slides = new Set(document.blocks.flatMap((block) =>
    block.source.locator?.kind === "pptx" ? [block.source.locator.slide] : []));
  return {
    fileId: document.fileId,
    fileName: document.metadata.fileName,
    slideCount: document.metadata.pageCount ?? slides.size,
  };
}

/**
 * A result sheet is named after the data it holds. The shared source sheet name
 * is the only name the reader already recognises, so it wins over any label the
 * aggregation could invent.
 */
function groupName(sheets: readonly AggregationSheet[], ordinal: number): string {
  const counts = new Map<string, number>();
  for (const sheet of sheets) {
    const name = sheet.name.trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best: { name: string; count: number } | undefined;
  for (const [name, count] of counts) if (!best || count > best.count) best = { name, count };
  return best?.name ?? `취합 결과 ${ordinal}`;
}

function schemaGroups(workbooks: readonly AggregationWorkbook[]): AggregationSchemaGroup[] {
  const groups: Array<AggregationSchemaGroup & { sheets: AggregationSheet[] }> = [];
  for (const sheet of workbooks.flatMap((workbook) => workbook.sheets).filter((entry) => entry.regions.length > 0)) {
    const fields = [...new Set(sheet.regions.flatMap((region) => region.headers.map(canonicalField)))];
    const keySet = new Set(fields.map(fieldKey));
    let group = groups.find((candidate) => {
      const candidateSet = new Set(candidate.fields.map(fieldKey));
      const shared = [...keySet].filter((key) => candidateSet.has(key)).length;
      return shared / Math.max(keySet.size, candidateSet.size) >= 0.7;
    });
    if (!group) {
      group = { id: `group:${groups.length + 1}`, name: "", sheetIds: [], fields, recordCount: 0, sheets: [] };
      groups.push(group);
    }
    group.sheetIds.push(sheet.id);
    group.sheets.push(sheet);
    group.recordCount += sheet.regions.reduce((sum, region) => sum + region.records.length, 0);
    for (const field of fields) if (!group.fields.some((entry) => fieldKey(entry) === fieldKey(field))) group.fields.push(field);
  }
  return groups.map(({ sheets, ...group }, index) => ({ ...group, name: groupName(sheets, index + 1) }));
}

/**
 * Identical headers — including the same calendar day written differently —
 * are settled automatically. Only a mapping that merges genuinely different
 * wording is left for the user to confirm.
 */
function fieldMappings(workbooks: readonly AggregationWorkbook[]): AggregationFieldMapping[] {
  const mappings: AggregationFieldMapping[] = [];
  for (const sheet of workbooks.flatMap((workbook) => workbook.sheets)) {
    for (const label of new Set(sheet.regions.flatMap((region) => region.headers))) {
      const target = canonicalField(label);
      let mapping = mappings.find((entry) => fieldKey(entry.targetField) === fieldKey(target));
      if (!mapping) {
        mapping = { id: `mapping:${mappings.length + 1}`, targetField: target, sourceFields: [], status: "confirmed", included: true };
        mappings.push(mapping);
      }
      if (!mapping.sourceFields.some((entry) => entry.sheetId === sheet.id && fieldKey(entry.field) === fieldKey(label))) mapping.sourceFields.push({ sheetId: sheet.id, field: label });
      if (fieldKey(target) !== fieldKey(label)) mapping.status = "suggested";
    }
  }
  return mappings;
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

function outputFormat(workbooks: readonly AggregationWorkbook[], decks: readonly AggregationDeck[]): AggregationOutputFormat {
  if (workbooks.length > 0 && decks.length > 0) return "mixed";
  if (decks.length > 0) return "pptx";
  return workbooks.length > 0 ? "xlsx" : "none";
}

export function buildAggregation(documents: readonly NormalizedDocument[]): AggregationDraft {
  const decks = documents.filter((document) => document.kind === "pptx").map(deckOf);
  const workbooks = documents.filter((document) => document.kind !== "pptx").map(documentWorkbook);
  const records = workbooks.flatMap((workbook) => workbook.sheets.flatMap((sheet) => sheet.regions.flatMap((region) => region.records)));
  markDuplicates(records);
  const issues = workbooks.flatMap((workbook) => workbook.sheets.filter((sheet) => sheet.role === "review" || sheet.role === "reference").map((sheet) => ({ scope: "sheet" as const, id: sheet.id, fileName: workbook.fileName, sheetName: sheet.name, message: sheet.reason ?? "확인이 필요한 구조입니다." })));
  return {
    output: outputFormat(workbooks, decks),
    workbooks,
    decks,
    groups: schemaGroups(workbooks),
    mappings: fieldMappings(workbooks),
    records,
    issues,
  };
}
