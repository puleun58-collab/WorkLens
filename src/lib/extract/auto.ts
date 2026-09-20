import type { NormalizedDocument, SourceRef, TableBlock } from "@/domain/document";
import type { ExtractedField, ExtractedRecords, FileExtraction } from "@/domain/extract";
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
const BUSINESS_LABEL = /(회사명|종목명|종목코드|기준일|목표주가|시가총액|단위|매출|비용|기간|담당자|부서|일시|인원|금액|수량|수익|손익|예산|일정)/u;

interface AutoExtractOptions {
  /** Requested-field mode may explicitly ask for an otherwise structural name. */
  includeGenericLabels?: boolean;
}

interface GenericCandidate {
  label: string;
  value: string;
  source: SourceRef;
  quote: string;
}

function labelKey(label: string): string {
  return label.normalize("NFKC").trim().toLocaleLowerCase("ko-KR").replace(/[\s._-]+/gu, "");
}

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

function push(fields: ExtractedField[], field: string, value: string, source: SourceRef, quote?: string): void {
  if (fields.length >= MAX_FIELDS) return;
  const type = classifyValue(value);
  const normalized = normalizeValue(value, type);
  // The same pair repeated across a deck is one field with several sources.
  const existing = fields.find((entry) => entry.field === field && entry.displayValue === value);
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
    ...(quote ? { quote } : {}),
  });
}

function tableRecords(block: TableBlock, index: number): ExtractedRecords | undefined {
  const [header, ...body] = block.rows;
  if (!header || body.length < RECORD_MIN_ROWS || header.length < 2) return undefined;
  const columns = header.map((cell, column) => cell.display.trim() || `열 ${column + 1}`);
  // A two-column table is a label/value list; wider ones are records.
  if (columns.length < 3) return undefined;
  return {
    id: block.id,
    title: `표 ${index + 1}`,
    columns,
    rows: body.map((row) => ({ cells: row.map((cell) => cell.display), source: row[0]?.source ?? block.source })),
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
  const generic = new Map<string, GenericCandidate[]>();
  let tableIndex = 0;

  const addCandidate = (
    label: string,
    value: string,
    source: SourceRef,
    quote: string,
    delimiter?: string,
  ) => {
    if (!isUsefulLabel(label) || !isUsefulValue(value)) return;
    // A vertical bar commonly separates layout fragments. Accept it only when
    // the left side reads as an explicit compact business label.
    if (delimiter === "|" && !isExplicitPipeLabel(label)) return;
    if (!options.includeGenericLabels && isGenericLabel(label)) {
      const key = labelKey(label);
      const candidates = generic.get(key) ?? [];
      candidates.push({ label: label.trim(), value: value.trim(), source, quote });
      generic.set(key, candidates);
      return;
    }
    push(fields, label.trim(), value.trim(), source, quote);
  };

  for (const block of document.blocks) {
    if (block.type === "paragraph") {
      const match = LABEL_VALUE.exec(block.text);
      if (!match) continue;
      const [, label, delimiter, value] = match;
      addCandidate(label, value, block.source, block.text, delimiter);
      continue;
    }

    const asRecords = tableRecords(block, tableIndex);
    tableIndex += 1;
    if (asRecords) {
      records.push(asRecords);
      continue;
    }
    // Two-column tables carry explicit key/value pairs.
    for (const row of block.rows) {
      if (row.length < 2) continue;
      const label = row[0].display.trim();
      const value = row[1].display.trim();
      addCandidate(label, value, row[1].source, `${label}: ${value}`);
    }
  }

  // Repeated structural labels describe a list, not several business fields.
  // A lone generic note is omitted; two or more become one source-backed record.
  for (const candidates of generic.values()) {
    if (candidates.length < 2) continue;
    const [first] = candidates;
    records.push({
      id: `generic:${records.length}:${labelKey(first.label)}`,
      title: first.label,
      columns: [first.label],
      rows: candidates.map((candidate) => ({ cells: [candidate.value], source: candidate.source })),
      source: first.source,
    });
  }

  return { file, fields, records, missing: [] };
}
