import type {
  AnalyzeResult,
  ExplicitTotal,
  ExtractResult,
  NumericSummary,
} from "@/domain/operations";
import type { NormalizedDocument, SourceRef, TableBlock, TableCell } from "@/domain/document";
import { displayFormat, parseCanonicalNumber } from "@/domain/numeric";

export { checkDocument } from "./check";

const TOTAL_LABEL = /^(?:grand\s+)?total\b/i;

interface NumericValue {
  value: number;
  format: string;
}

function cellText(cell: TableCell): string {
  return cell.display.trim() || (cell.value === null ? "" : String(cell.value).trim());
}

function isEmpty(cell: TableCell): boolean {
  return cell.display.trim() === "" && (cell.value === null || (typeof cell.value === "string" && cell.value.trim() === ""));
}

function numericCell(cell: TableCell): NumericValue | undefined {
  if (typeof cell.value === "number" && Number.isFinite(cell.value)) {
    return { value: cell.value, format: displayFormat(cell.display) };
  }
  return parseCanonicalNumber(cellText(cell));
}

function totalForTable(table: TableBlock): ExplicitTotal[] {
  const totals: ExplicitTotal[] = [];
  for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
    const row = table.rows[rowIndex];
    const labelCell = row.find((cell) => !isEmpty(cell));
    if (!labelCell || !TOTAL_LABEL.test(cellText(labelCell))) continue;

    for (let column = 0; column < row.length; column += 1) {
      const actual = numericCell(row[column]);
      if (!actual) continue;
      const contributors: TableCell[] = [];
      for (let previous = rowIndex - 1; previous >= 0; previous -= 1) {
        const candidate = table.rows[previous][column];
        const numeric = candidate && numericCell(candidate);
        if (!numeric) break;
        contributors.unshift(candidate);
      }
      if (contributors.length < 2) continue;
      const expected = contributors.reduce((sum, cell) => sum + (numericCell(cell)?.value ?? 0), 0);
      totals.push({
        label: cellText(labelCell),
        expected,
        actual: actual.value,
        source: row[column].source,
        contributingSources: contributors.map((cell) => cell.source),
      });
    }
  }
  return totals;
}

export function analyzeDocument(document: NormalizedDocument): AnalyzeResult {
  const numericSources: SourceRef[] = [];
  const numericValues: number[] = [];
  let paragraphCount = 0;
  let tableCellCount = 0;
  let nonEmptyValueCount = 0;
  let characterCount = 0;
  const tables: AnalyzeResult["structure"]["tables"] = [];
  const totals: ExplicitTotal[] = [];

  for (const block of document.blocks) {
    if (block.type === "paragraph") {
      paragraphCount += 1;
      characterCount += block.text.length;
      if (block.text.trim()) nonEmptyValueCount += 1;
      continue;
    }
    const columnCount = block.rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
    tables.push({ blockId: block.id, source: block.source, rowCount: block.rows.length, columnCount });
    for (const total of totalForTable(block)) totals.push(total);
    for (const row of block.rows) {
      for (const cell of row) {
        tableCellCount += 1;
        const text = cellText(cell);
        characterCount += text.length;
        if (text) nonEmptyValueCount += 1;
        const numeric = numericCell(cell);
        if (numeric) {
          numericValues.push(numeric.value);
          numericSources.push(cell.source);
        }
      }
    }
  }

  // Large workbooks hold hundreds of thousands of numbers; spreading them into
  // Math.min/max overflows the call stack, so extremes are folded in one pass.
  let sum = 0;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of numericValues) {
    sum += value;
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  const numeric: NumericSummary = numericValues.length === 0
    ? { count: 0, sum: 0, minimum: 0, maximum: 0, average: 0, sources: [] }
    : { count: numericValues.length, sum, minimum, maximum, average: sum / numericValues.length, sources: numericSources };

  return {
    documentId: document.id,
    structure: { paragraphCount, tableCount: tables.length, tables },
    numeric,
    text: { paragraphCount, tableCellCount, nonEmptyValueCount, characterCount },
    totals,
  };
}


export function extractDocument(document: NormalizedDocument): ExtractResult {
  const tables: ExtractResult["tables"] = [];
  const paragraphs: ExtractResult["paragraphs"] = [];
  for (const block of document.blocks) {
    if (block.type === "paragraph") {
      paragraphs.push({ blockId: block.id, text: block.text, source: block.source });
    } else {
      tables.push({
        blockId: block.id,
        source: block.source,
        rows: block.rows.map((row) => row.map((cell) => ({ value: cell.value, display: cell.display, source: cell.source }))),
      });
    }
  }
  return { documentId: document.id, tables, paragraphs };
}
