import type {
  AggregationDraft,
  AggregationField,
  AggregationFieldMapping,
  AggregationRecord,
  AggregationRegion,
  AggregationSchemaGroup,
  AggregationSheet,
  AggregationWorkbook,
} from "@/domain/aggregation";
import { AGGREGATION_UNSUPPORTED_DETAIL, AGGREGATION_UNSUPPORTED_TITLE, isAggregationFileKind } from "@/domain/aggregation";
import type { DocumentMedia, NormalizedDocument, SourceRef, TableBlock, TableCell, WorkbookSheet } from "@/domain/document";
import { classifyValue, normalizeValue } from "@/lib/extract/values";
import { DocumentError } from "@/lib/upload";

const MAX_HEADER_SCAN_ROWS = 24;
const MIN_RECORD_CELLS = 2;
const MAX_REGIONS_PER_SHEET = 12;
/** Values a reader must never see; they mean a cell failed to render, not a value. */
const UNREADABLE_TEXT = /^(?:\[object\s[^\]]*\]|undefined|null|NaN)$/u;
const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/u;
const LOOSE_DATE = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})\.?$/u;
const MONTH_PERIOD = /^(\d{4})\s*(?:년\s*(\d{1,2})\s*월?|[-./]\s*(\d{1,2})\.?)$/u;
const MONTH_ONLY = /^(\d{1,2})\s*월$/u;
/** Only established business synonyms; never infer a relationship from spelling similarity. */
const SAFE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  부서: ["부서명", "담당부서"],
  매출: ["매출액", "매출금액"],
  비용: ["비용액", "지출액"],
  인원: ["인원수"],
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
    for (const [canonical, aliases] of Object.entries(SAFE_ALIASES)) {
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

/**
 * Excel's own sheet hierarchy is the aggregation unit: visibility, header
 * region, style template and media all hang off a real worksheet.
 */
function documentWorkbook(document: NormalizedDocument & { kind: "xlsx" }): AggregationWorkbook {
  const sheets = (document.workbookSheets ?? []).map((sheet) => safeWorkbookSheet(document, sheet));
  return { id: `aggregation:${document.id}`, fileId: document.fileId, fileName: document.metadata.fileName, kind: "xlsx", sheets };
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

function sheetFields(sheet: AggregationSheet): string[] {
  const fields: string[] = [];
  for (const label of sheet.regions.flatMap((region) => region.headers)) {
    const canonical = canonicalField(label);
    if (!fields.some((field) => fieldKey(field) === fieldKey(canonical))) fields.push(canonical);
  }
  return fields;
}

function valueShape(sheet: AggregationSheet, key: string): string | undefined {
  const shapes = new Set(sheet.regions.flatMap((region) => region.records)
    .flatMap((record) => record.fields)
    .filter((field) => fieldKey(canonicalField(field.label)) === key)
    .map((field) => {
      switch (field.value.type) {
        case "Date":
        case "DateTime":
        case "Period": return "time";
        case "Number":
        case "Money":
        case "Percent": return "number";
        case "Boolean": return "boolean";
        case "Image": return "image";
        default: return "text";
      }
    }));
  return shapes.size === 1 ? [...shapes][0] : undefined;
}

function compatibleSheets(left: AggregationSheet, right: AggregationSheet): boolean {
  const leftFields = sheetFields(left);
  const rightFields = sheetFields(right);
  const a = new Set(leftFields.filter((field) => !canonicalDateLabel(field)).map(fieldKey));
  const b = new Set(rightFields.filter((field) => !canonicalDateLabel(field)).map(fieldKey));
  const common = [...a].filter((key) => b.has(key));
  const aDynamic = leftFields.length - a.size;
  const bDynamic = rightFields.length - b.size;
  if (common.length === 0) return false;
  // Calendar headings come and go. Stable identity and measurements, not
  // the number of monthly columns, define a report's schema.
  const strong = common.length >= 2 && common.length / Math.max(a.size, b.size) >= 0.8;
  const datedIdentity = common.length === 1 && a.size === 1 && b.size === 1
    && aDynamic >= 2 && bDynamic >= 2
    && fieldKey(left.name) === fieldKey(right.name);
  if (!strong && !datedIdentity) return false;
  if ((aDynamic > 0) !== (bDynamic > 0) && (aDynamic >= 2 || bDynamic >= 2)) return false;
  return common.every((key) => {
    const leftShape = valueShape(left, key);
    const rightShape = valueShape(right, key);
    return !leftShape || !rightShape || leftShape === rightShape;
  });
}

function schemaGroups(workbooks: readonly AggregationWorkbook[]): AggregationSchemaGroup[] {
  const groups: Array<AggregationSchemaGroup & { sheets: AggregationSheet[] }> = [];
  for (const sheet of workbooks.flatMap((workbook) => workbook.sheets).filter((entry) => entry.regions.length > 0)) {
    const fields = sheetFields(sheet);
    let group = groups.find((candidate) => candidate.sheets.every((entry) => compatibleSheets(entry, sheet)));
    if (!group) {
      group = { id: `group:${groups.length + 1}`, name: "", sheetIds: [], fields: [], recordCount: 0, sheets: [] };
      groups.push(group);
    }
    group.sheetIds.push(sheet.id);
    group.sheets.push(sheet);
    group.recordCount += sheet.regions.reduce((sum, region) => sum + region.records.length, 0);
    for (const field of fields) if (!group.fields.some((entry) => fieldKey(entry) === fieldKey(field))) group.fields.push(field);
  }
  return groups.map(({ sheets, ...group }, index) => ({ ...group, name: groupName(sheets, index + 1) }));
}

/** Only identical normalized paths and calendar spellings map automatically. */
function fieldMappings(workbooks: readonly AggregationWorkbook[]): AggregationFieldMapping[] {
  const mappings: AggregationFieldMapping[] = [];
  for (const sheet of workbooks.flatMap((workbook) => workbook.sheets)) {
    for (const label of new Set(sheet.regions.flatMap((region) => region.headers))) {
      const target = canonicalField(label);
      const key = fieldKey(target);
      const collisions = mappings.filter((entry) => fieldKey(entry.targetField) === key);
      // Once a key is ambiguous, a later sheet cannot tell us which of the
      // competing source columns it meant.
      let mapping = collisions.length <= 1
        ? collisions.find((entry) => !entry.sourceFields.some((source) => source.sheetId === sheet.id && source.field !== label))
        : undefined;
      if (!mapping) {
        for (const collision of collisions) collision.status = "review";
        mapping = { id: `mapping:${mappings.length + 1}`, targetField: target, sourceFields: [], status: collisions.length ? "review" : "confirmed", included: true };
        mappings.push(mapping);
      }
      if (!mapping.sourceFields.some((entry) => entry.sheetId === sheet.id && entry.field === label)) {
        mapping.sourceFields.push({ sheetId: sheet.id, field: label });
      }
      if (fieldKey(label) !== fieldKey(target) && mapping.status === "confirmed") mapping.status = "suggested";
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


export function buildAggregation(documents: readonly NormalizedDocument[]): AggregationDraft {
  if (documents.some((document) => !isAggregationFileKind(document.kind))) {
    throw new DocumentError("AGGREGATE_FORMAT_UNSUPPORTED", AGGREGATION_UNSUPPORTED_TITLE, AGGREGATION_UNSUPPORTED_DETAIL);
  }
  const workbooks = documents
    .filter((document): document is NormalizedDocument & { kind: "xlsx" } => isAggregationFileKind(document.kind))
    .map(documentWorkbook);
  const records = workbooks.flatMap((workbook) => workbook.sheets.flatMap((sheet) => sheet.regions.flatMap((region) => region.records)));
  markDuplicates(records);
  const issues = workbooks.flatMap((workbook) => workbook.sheets.filter((sheet) => sheet.role === "review" || sheet.role === "reference").map((sheet) => ({ scope: "sheet" as const, id: sheet.id, fileName: workbook.fileName, sheetName: sheet.name, message: sheet.reason ?? "확인이 필요한 구조입니다." })));
  return {
    workbooks,
    groups: schemaGroups(workbooks),
    mappings: fieldMappings(workbooks),
    records,
    issues,
  };
}
