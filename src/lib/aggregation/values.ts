import type { AggregationField, AggregationFieldMapping, AggregationRecord, AggregationRegion, AggregationSheet } from "@/domain/aggregation";
import { DATETIME_NUMBER_FORMAT, DATE_NUMBER_FORMAT, isDateNumberFormat, serialToDate } from "@/lib/xlsx-values";

/**
 * One interpretation of a mapped value, shared by the preview and the XLSX.
 *
 * The target column decides the type: a serial number mapped into a date
 * column is that day, while the same number in a count column stays a count.
 * Nothing is converted on magnitude alone.
 */
export interface TargetCell {
  value: string | number | boolean | Date | null;
  numberFormat?: string;
  display: string;
}

const UNREADABLE_TEXT = /^(?:\[object\s[^\]]*\]|undefined|null|NaN)$/u;
/** Cell error values: a failed calculation or an unreadable picture, never data. */
export const CELL_ERROR = /^#(?:VALUE!|REF!|N\/A|NAME\?|DIV\/0!|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)$/u;
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/u;
const LOOSE = /^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\.?(?:\s+(\d{1,2}):(\d{2}))?$/u;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function calendar(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date | undefined {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : undefined;
}

/** The calendar value a field holds, whatever form the source stored it in. */
export function fieldDate(field: AggregationField): Date | undefined {
  const { value } = field;
  const iso = ISO.exec(value.normalizedValue ?? (typeof value.value === "string" ? value.value : ""));
  if (iso && (value.cellType === "date" || value.type === "Date" || value.type === "DateTime")) {
    return calendar(Number(iso[1]), Number(iso[2]), Number(iso[3]), Number(iso[4] ?? 0), Number(iso[5] ?? 0), Number(iso[6] ?? 0));
  }
  if (typeof value.value === "number") return serialToDate(value.value);
  const loose = LOOSE.exec(value.displayValue.trim());
  return loose ? calendar(Number(loose[1]), Number(loose[2]), Number(loose[3]), Number(loose[4] ?? 0), Number(loose[5] ?? 0)) : undefined;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/**
 * Renders a date the way Excel's number format would, for the preview. Only
 * the calendar tokens matter here; literal text and escapes are kept.
 */
export function formatExcelDate(date: Date, format: string | undefined): string {
  const section = (format && isDateNumberFormat(format) ? format : "").split(";")[0].replace(/\[[^\]]*\]/gu, "");
  if (!section) {
    const hasTime = date.getUTCHours() !== 0 || date.getUTCMinutes() !== 0;
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}${hasTime ? ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}` : ""}`;
  }
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|\\(.)|(yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|am\/pm|.)/giu;
  for (const match of section.matchAll(pattern)) tokens.push(match[1] !== undefined ? `"${match[1]}` : match[2] !== undefined ? `"${match[2]}` : match[3]);
  const twelveHour = tokens.some((token) => /^am\/pm$/iu.test(token));
  let lastWasHour = false;
  return tokens.map((token, index) => {
    if (token.startsWith("\"")) return token.slice(1);
    const lower = token.toLowerCase();
    const next = tokens.slice(index + 1).find((entry) => /^[ymdhs]/iu.test(entry))?.toLowerCase();
    let output: string;
    if (lower === "yyyy") output = String(date.getUTCFullYear());
    else if (lower === "yy") output = pad(date.getUTCFullYear() % 100);
    else if (/^m{1,2}$/u.test(lower) && (lastWasHour || next?.startsWith("s"))) output = lower === "mm" ? pad(date.getUTCMinutes()) : String(date.getUTCMinutes());
    else if (lower === "mmmmm") output = MONTHS[date.getUTCMonth()][0];
    else if (lower === "mmmm") output = MONTH_NAMES[date.getUTCMonth()];
    else if (lower === "mmm") output = MONTHS[date.getUTCMonth()];
    else if (lower === "mm") output = pad(date.getUTCMonth() + 1);
    else if (lower === "m") output = String(date.getUTCMonth() + 1);
    else if (lower === "dddd") output = DAY_NAMES[date.getUTCDay()];
    else if (lower === "ddd") output = DAYS[date.getUTCDay()];
    else if (lower === "dd") output = pad(date.getUTCDate());
    else if (lower === "d") output = String(date.getUTCDate());
    else if (lower === "hh" || lower === "h") {
      const hours = twelveHour ? (date.getUTCHours() % 12 || 12) : date.getUTCHours();
      output = lower === "hh" ? pad(hours) : String(hours);
    } else if (lower === "ss") output = pad(date.getUTCSeconds());
    else if (lower === "s") output = String(date.getUTCSeconds());
    else if (lower === "am/pm") output = date.getUTCHours() < 12 ? "AM" : "PM";
    else if (token === "@") output = "";
    else output = token;
    if (/^[ymd]/iu.test(lower)) lastWasHour = false;
    if (/^h/iu.test(lower)) lastWasHour = true;
    return output;
  }).join("").trim();
}

function readable(field: AggregationField): string {
  const display = field.value.displayValue.trim();
  return display && !UNREADABLE_TEXT.test(display) && !CELL_ERROR.test(display) ? display : "";
}

type TargetSemantics = Pick<AggregationFieldMapping, "targetType" | "targetFormat">;

/** The value a mapped field takes in its target column. */
export function targetCell(fields: readonly AggregationField[], mapping: TargetSemantics): TargetCell {
  const present = fields.filter((field) => readable(field) !== "");
  if (present.length === 0) return { value: null, display: "" };
  if (present.length > 1) {
    const text = present.map((field) => targetCell([field], mapping).display).join(" | ");
    return { value: text, display: text };
  }
  const [field] = present;
  const { value } = field;
  const display = readable(field);
  const date = mapping.targetType === "date" || mapping.targetType === "datetime" || value.cellType === "date"
    ? fieldDate(field)
    : undefined;
  if (date && (mapping.targetType === "date" || mapping.targetType === "datetime" || value.cellType === "date")) {
    const targetFormat = isDateNumberFormat(mapping.targetFormat) ? mapping.targetFormat : undefined;
    const sourceFormat = isDateNumberFormat(value.numberFormat) ? value.numberFormat : undefined;
    const hasTime = date.getUTCHours() !== 0 || date.getUTCMinutes() !== 0;
    const numberFormat = targetFormat ?? sourceFormat ?? (hasTime ? DATETIME_NUMBER_FORMAT : DATE_NUMBER_FORMAT);
    return { value: date, numberFormat, display: formatExcelDate(date, numberFormat) };
  }
  if (typeof value.value === "number" && Number.isFinite(value.value)) {
    const format = value.numberFormat && !isDateNumberFormat(value.numberFormat) ? value.numberFormat : undefined;
    return { value: value.value, ...(format ? { numberFormat: format } : {}), display };
  }
  if (typeof value.value === "boolean") return { value: value.value, display };
  return { value: display, display };
}

/** The record fields a mapping draws from for this record's own sheet. */
export function mappedFields(record: AggregationRecord, mapping: Pick<AggregationFieldMapping, "sourceFields">): AggregationField[] {
  const allowed = new Set(mapping.sourceFields.filter((source) => source.sheetId === record.sheetId).map((source) => source.field));
  return record.fields.filter((field) => allowed.has(field.label));
}
export interface SequenceCells {
  mappingId: string;
  cells: ReadonlyMap<string, TargetCell>;
}

/** Numbering is a property of the combined rows, not a source file's stored IDs. */
export function sequenceCells(records: readonly AggregationRecord[], mappings: readonly AggregationFieldMapping[], templateSheetId: string): SequenceCells | undefined {
  if (!records.some((record) => record.sheetId !== templateSheetId)) return undefined;
  const own = records.filter((record) => record.sheetId === templateSheetId);
  const strongHeader = /^(?:순번|연번|일련번호|번호|관리\s*(?:no\.?|번호)|no\.?)$/iu;
  const nonSequenceHeader = /(?:날짜|일자|연도|년도|금액|비율|수량|단가|합계|건수|인원|식별|고유|date|amount|qty|rate|percent|^id$)/iu;
  const parse = (field: AggregationField | undefined, named: boolean) => {
    if (!field || field.value.cellType === "date" || field.value.cellType === "formula"
      || field.value.type === "Date" || field.value.type === "DateTime"
      || isDateNumberFormat(field.value.numberFormat)) return undefined;
    const value = field.value.value;
    const format = field.value.numberFormat ?? "";
    if (/[%₩$€¥]|원|개|건|명|kg|g\b|톤/u.test(format) || !named && /#,##/u.test(format)) return undefined;
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0 || value >= 1900 && value <= 2100) return undefined;
      return { prefix: "", digits: 0, number: value, numeric: true };
    }
    if (typeof value !== "string") return undefined;
    const text = value.trim();
    if (/^\d+$/u.test(text)) {
      const number = Number(text);
      if (!Number.isSafeInteger(number) || number >= 1900 && number <= 2100) return undefined;
      return { prefix: "", digits: text.length, number, numeric: false };
    }
    const match = /^(.+[-_/])(\d{2,})$/u.exec(text);
    if (!match || !/[A-Za-z가-힣]/u.test(match[1])) return undefined;
    const number = Number(match[2]);
    return Number.isSafeInteger(number) ? { prefix: match[1], digits: match[2].length, number, numeric: false } : undefined;
  };
  for (const mapping of mappings) {
    if (!mapping.included || mapping.targetColumn === undefined || mapping.targetType === "date" || mapping.targetType === "datetime"
      || isDateNumberFormat(mapping.targetFormat) || nonSequenceHeader.test(mapping.targetField)) continue;
    const named = strongHeader.test(mapping.targetField);
    const parsed = own.map((record) => parse(mappedFields(record, mapping)[0], named));
    const firstIndex = parsed.findIndex(Boolean);
    const first = parsed[firstIndex];
    if (!first || parsed.some((entry) => entry && (entry.prefix !== first.prefix || entry.numeric !== first.numeric || entry.digits !== first.digits))) continue;
    const numbered = parsed.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    if (numbered.length < 2 || numbered.some((entry, index) => entry.number !== first.number + index)) continue;
    const start = first.number - firstIndex;
    if (start < 0) continue;
    const sourceRestarts = records.some((record) => {
      if (record.sheetId === templateSheetId) return false;
      const source = parse(mappedFields(record, mapping)[0], named);
      return source?.number === first.number && source.prefix === first.prefix && source.numeric === first.numeric;
    });
    if (!named && (!sourceRestarts || numbered.length < 3)) continue;
    const cells = new Map(records.map((record, index) => {
      const number = start + index;
      const value = first.numeric ? number : `${first.prefix}${String(number).padStart(first.digits, "0")}`;
      const display = first.numeric && /^0+$/u.test(mapping.targetFormat ?? "")
        ? String(number).padStart(mapping.targetFormat!.length, "0") : String(value);
      return [record.id, { value, display }] as const;
    }));
    return { mappingId: mapping.id, cells };
  }
}

/** Images a record holds in the given target field. */
export function mappedImageCount(record: AggregationRecord, mapping: Pick<AggregationFieldMapping, "sourceFields" | "targetField">): number {
  const allowed = new Set(mapping.sourceFields.filter((source) => source.sheetId === record.sheetId).map((source) => source.field));
  return record.media.filter((media) => media.role && allowed.has(media.role)).length;
}

/** Region holding the sheet's records; other tables on the sheet stay template content. */
export function primaryRegion(sheet: Pick<AggregationSheet, "regions">): AggregationRegion | undefined {
  return sheet.regions.reduce<AggregationRegion | undefined>((best, region) =>
    !best || region.records.length > best.records.length ? region : best, undefined);
}
