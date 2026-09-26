import type { NormalizedDocument, SourceRef, TableBlock } from "@/domain/document";
import type { ExtractedField, ExtractedRecords, ExtractOrigin, ExtractValueType, FileExtraction } from "@/domain/extract";
import { classifyValue, normalizeValue } from "./values";

/**
 * Deterministic automatic extraction.
 *
 * Structure the parser already knows is used before any model is consulted:
 * labelled pairs in prose, two-column tables, and repeating tables. Anything
 * that is not reusable business data — running prose, headings, single words —
 * is left out rather than turned into a field, because a dump is not an
 * extraction.
 */
const LABEL_VALUE = /^\s*([^\s:：|][^:：|]{0,30}?)\s*([:：|])\s*(.+?)\s*$/u;
const MAX_LABEL_LENGTH = 24;
const MAX_VALUE_LENGTH = 120;
const MAX_FIELDS = 300;
/** A table this wide with this many rows is a record set, not a pair list. */
const RECORD_MIN_ROWS = 2;
const GENERIC_LABELS = new Set([
  "source", "sources", "출처", "참고", "참고자료", "비고",
  "note", "notes", "reference", "references",
]);
const DELIMITERLESS_LABELS = [
  "영업이익", "목표주가", "현재주가", "시가총액", "상승여력", "종목코드", "매출액",
  "담당부서", "작성부서", "검토부서", "주관부서", "회사명", "법인명", "종목명",
  "문서번호", "프로젝트명", "계약명", "회의명", "회의일시", "작성자", "검토자", "승인자",
  "기준일", "작성일", "시행일", "만료일", "조치기한", "완료기한", "납기일",
  "순이익", "담당자", "매출", "비용", "금액", "예산", "인원", "수량", "기간",
  "일정", "일시", "부서", "단위",
].sort((left, right) => right.length - left.length);
const BUSINESS_LABEL = new RegExp(`(${DELIMITERLESS_LABELS.join("|")})`, "u");
const DELIMITERLESS_TYPES = new Set<ExtractValueType>([
  "Money", "Percent", "Date", "DateTime", "Period", "Number", "Email", "Phone", "Url", "Code",
]);

interface AutoExtractOptions {
  /** Requested-field mode may explicitly ask for an otherwise structural name. */
  includeGenericLabels?: boolean;
}


function labelKey(label: string): string {
  return label.normalize("NFKC").trim().toLocaleLowerCase("ko-KR").replace(/[\s._-]+/gu, "");
}

function valueKey(value: string): string {
  const type = classifyValue(value);
  return normalizeValue(value, type)?.normalize("NFKC").trim().toLocaleLowerCase("ko-KR")
    ?? value.normalize("NFKC").trim().toLocaleLowerCase("ko-KR").replace(/\s+/gu, " ");
}

const BUSINESS_LABELS = new Set(DELIMITERLESS_LABELS.map(labelKey));

function isGenericLabel(label: string): boolean {
  return GENERIC_LABELS.has(labelKey(label));
}

function isExplicitPipeLabel(label: string): boolean {
  const text = label.trim();
  return BUSINESS_LABEL.test(text) || (!/\s/u.test(text) && !/\d/u.test(text));
}
function isUsefulLabel(label: string): boolean {
  const text = label.trim();
  if (text.length === 0 || text.length > MAX_LABEL_LENGTH) return false;
  // A sentence is not a label: labels do not end in a verb ending or a period.
  if (/[.?!]$/u.test(text)) return false;
  return /[가-힣A-Za-z]/u.test(text);
}

function isUsefulValue(value: string): boolean {
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_VALUE_LENGTH) return false;
  // A long sentence with several clauses is prose, not a value.
  return text.split(/\s+/u).length <= 12;
}

function isSafeUnitValue(label: string, value: string): boolean {
  return label === "단위"
    && /^(?:천|만|백만|천만|억|조)?\s*(?:원|달러|유로|엔|USD|KRW|명|개|건)$/iu.test(value.trim());
}

/**
 * A delimiterless pair is accepted only at the start of one compact text
 * block, after the longest known business label, and only when the remainder
 * has a deterministic non-Text type. This never joins separate slide boxes.
 */
function delimiterlessPair(text: string): { label: string; value: string } | undefined {
  const candidate = text.trim();
  for (const label of DELIMITERLESS_LABELS) {
    if (!candidate.startsWith(label)) continue;
    const boundary = /^\s+(?:[-–—]\s*)?(.+?)\s*$/u.exec(candidate.slice(label.length));
    if (!boundary) continue;
    const value = boundary[1];
    const type = classifyValue(value);
    if (DELIMITERLESS_TYPES.has(type) || isSafeUnitValue(label, value)) return { label, value };
  }
  return undefined;
}

function push(fields: ExtractedField[], field: string, value: string, source: SourceRef, origin: ExtractOrigin, quote?: string): void {
  if (fields.length >= MAX_FIELDS) return;
  const type = classifyValue(value);
  const normalized = normalizeValue(value, type);
  // The same pair repeated across a deck is one field with several sources.
  const existing = fields.find((entry) => labelKey(entry.field) === labelKey(field) && valueKey(entry.displayValue) === valueKey(value));
  if (existing) {
    if (!existing.sources.some((entry) => entry.nodeId === source.nodeId)) existing.sources.push(source);
    return;
  }
  fields.push({
    field,
    displayValue: value,
    ...(normalized ? { normalizedValue: normalized } : {}),
    type,
    sources: [source],
    origin,
    ...(quote ? { quote } : {}),
  });
}

function looksLikeHeaderRow(label: string, value: string): boolean {
  const left = labelKey(label);
  const right = labelKey(value);
  return /^(항목|구분|필드|label|key)$/u.test(left)
    && /^(값|내용|설명|value|description)$/u.test(right);
}

function tableRecords(block: TableBlock, index: number, displayTitle?: string): ExtractedRecords | undefined {
  const [header, ...body] = block.rows;
  if (!header || body.length < RECORD_MIN_ROWS || header.length < 3) return undefined;
  // Duplicate headings (e.g. two 금액 columns) are numbered, never a reason to drop the table:
  // falling back to label/value pairs would silently lose every column after the second.
  const seen = new Map<string, number>();
  const columns = header.map((cell, column) => {
    const name = cell.display.trim() || `열 ${column + 1}`;
    const count = (seen.get(labelKey(name)) ?? 0) + 1;
    seen.set(labelKey(name), count);
    return count > 1 ? `${name} (${count})` : name;
  });
  const validRows = body.filter((row) => row.filter((cell) => cell.display.trim() !== "").length >= 2);
  if (validRows.length < RECORD_MIN_ROWS) return undefined;
  return {
    id: block.id,
    title: `표 ${index + 1}`,
    ...(displayTitle ? { displayTitle } : {}),
    columns,
    rows: validRows.map((row) => ({ cells: columns.map((_, column) => row[column]?.display ?? ""), source: row[0]?.source ?? block.source })),
    source: block.source,
  };
}

export function autoExtract(
  document: NormalizedDocument,
  file: { id: string; name: string },
  options: AutoExtractOptions = {},
): FileExtraction {
  const fields: ExtractedField[] = [];
  const records: ExtractedRecords[] = [];
  let tableIndex = 0;
  let currentHeading: string | undefined;

  const addCandidate = (
    label: string,
    value: string,
    source: SourceRef,
    quote: string,
    origin: ExtractOrigin,
    delimiter?: string,
  ) => {
    if (!isUsefulLabel(label) || !isUsefulValue(value)) return;
    // A vertical bar commonly separates layout fragments. Accept it only when
    // the left side reads as an explicit compact business label.
    if (delimiter === "|" && !isExplicitPipeLabel(label)) return;
    if (!options.includeGenericLabels && isGenericLabel(label)) return;
    push(fields, label.trim(), value.trim(), source, origin, quote);
  };

  if (document.kind === "pptx") {
    const shapeParagraphs = new Map<string, Array<{ text: string; source: SourceRef; role?: string }>>();
    for (const block of document.blocks) {
      if (block.type !== "paragraph" || block.source.locator?.kind !== "pptx") continue;
      const key = `${block.source.locator.slide}:${block.source.locator.shape}`;
      const entries = shapeParagraphs.get(key) ?? [];
      entries.push({ text: block.text.trim(), source: block.source, role: block.role });
      shapeParagraphs.set(key, entries);
    }
    for (const entries of shapeParagraphs.values()) {
      if (entries.length !== 2 || entries[0].role === "heading") continue;
      const [label, value] = entries;
      if (!BUSINESS_LABELS.has(labelKey(label.text))) continue;
      addCandidate(label.text, value.text, value.source, `${label.text}: ${value.text}`, "business-label");
    }
  }

  for (const block of document.blocks) {
    if (block.type === "paragraph") {
      if (block.role === "heading") {
        currentHeading = block.text.trim() || currentHeading;
        continue;
      }
      const explicit = LABEL_VALUE.exec(block.text);
      if (explicit) {
        const [, label, delimiter, value] = explicit;
        addCandidate(label, value, block.source, block.text, "explicit-delimiter", delimiter);
        continue;
      }
      const implicit = delimiterlessPair(block.text);
      if (implicit) addCandidate(implicit.label, implicit.value, block.source, block.text, "business-label");
      continue;
    }

    const asRecords = tableRecords(block, tableIndex, currentHeading);
    tableIndex += 1;
    if (asRecords) {
      records.push(asRecords);
      continue;
    }
    // Key/value tables: the first two cells form a pair, and further pairs placed side by
    // side after an empty separator cell (label | value | · | label | value) are read too.
    for (const row of block.rows) {
      if (row.length < 2) continue;
      const label = row[0].display.trim();
      const value = row[1].display.trim();
      if (looksLikeHeaderRow(label, value)) continue;
      addCandidate(label, value, row[1].source, `${label}: ${value}`, "key-value-table");
      for (let index = 2; index + 2 < row.length; index += 1) {
        if (row[index].display.trim() !== "") continue;
        const nextLabel = row[index + 1].display.trim();
        const nextValue = row[index + 2].display.trim();
        if (!nextLabel || !nextValue) continue;
        addCandidate(nextLabel, nextValue, row[index + 2].source, `${nextLabel}: ${nextValue}`, "key-value-table");
        index += 2;
      }
    }
  }


  return { file, fields, records, missing: [] };
}
