import type {
  AnalyzeResult,
  CheckFinding,
  CheckResult,
  ExplicitTotal,
  ExtractResult,
  NumericSummary,
} from "@/domain/operations";
import type { NormalizedDocument, SourceRef, TableBlock, TableCell } from "@/domain/document";
import { displayFormat, parseCanonicalNumber } from "@/domain/numeric";

const TOTAL_LABEL = /^(?:grand\s+)?total\b/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE = /(?:\+?\d{1,3}[ .-])?(?:\(?\d{2,4}\)?[ .-])\d{3,4}[ .-]\d{4}\b/;
const RESIDENT_REGISTRATION = /\b\d{6}\s*[-–]\s*[1-4]\d{6}\b/;

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
    totals.push(...totalForTable(block));
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

  const numeric: NumericSummary = numericValues.length === 0
    ? { count: 0, sum: 0, minimum: 0, maximum: 0, average: 0, sources: [] }
    : {
        count: numericValues.length,
        sum: numericValues.reduce((sum, value) => sum + value, 0),
        minimum: Math.min(...numericValues),
        maximum: Math.max(...numericValues),
        average: numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length,
        sources: numericSources,
      };

  return {
    documentId: document.id,
    structure: { paragraphCount, tableCount: tables.length, tables },
    numeric,
    text: { paragraphCount, tableCellCount, nonEmptyValueCount, characterCount },
    totals,
  };
}

function privacyFindings(text: string, source: SourceRef): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const finding = (code: CheckFinding["code"], severity: CheckFinding["severity"], message: string, recommendation: string): CheckFinding => ({
    code,
    severity,
    message,
    reason: "문서 내용이 정의된 개인정보 패턴과 일치합니다.",
    recommendation,
    sources: [source],
  });
  if (EMAIL.test(text)) findings.push(finding("privacy-email", "warning", "Email address detected.", "공유 범위를 확인하고 필요하면 이메일 주소를 마스킹하세요."));
  if (RESIDENT_REGISTRATION.test(text)) findings.push(finding("privacy-resident-registration", "critical", "Resident-registration-like number detected.", "즉시 접근을 제한하고 주민등록번호를 삭제하거나 비식별화하세요."));
  if (PHONE.test(text)) findings.push(finding("privacy-phone", "warning", "Phone number detected.", "업무상 필요 여부를 확인하고 필요하면 전화번호를 마스킹하세요."));
  return findings;
}

export function checkDocument(document: NormalizedDocument): CheckResult {
  const findings: CheckFinding[] = [];
  for (const block of document.blocks) {
    if (block.type === "paragraph") {
      findings.push(...privacyFindings(block.text, block.source));
      continue;
    }

    const duplicates = new Map<number, Map<string, SourceRef[]>>();
    const formats = new Map<number, Map<string, SourceRef[]>>();
    block.rows.forEach((row, rowIndex) => {
      if (row.length > 0 && row.every(isEmpty)) {
        findings.push({ code: "empty-row", severity: "suggestion", message: `Empty row ${rowIndex + 1}.`, reason: "행의 모든 셀이 비어 있습니다.", recommendation: "불필요한 빈 행을 삭제하세요.", sources: row.map((cell) => cell.source) });
      }
      row.forEach((cell, column) => {
        if (isEmpty(cell)) findings.push({ code: "empty-cell", severity: "suggestion", message: `Empty cell in column ${column + 1}.`, reason: "셀 값이 비어 있습니다.", recommendation: "의도된 빈 값인지 확인하세요.", sources: [cell.source] });
        const text = cellText(cell);
        if (text) {
          const byValue = duplicates.get(column) ?? new Map<string, SourceRef[]>();
          const key = text.normalize("NFKC").toLocaleLowerCase();
          byValue.set(key, [...(byValue.get(key) ?? []), cell.source]);
          duplicates.set(column, byValue);
        }
        findings.push(...privacyFindings(text, cell.source));
        const numeric = numericCell(cell);
        if (numeric) {
          const byFormat = formats.get(column) ?? new Map<string, SourceRef[]>();
          byFormat.set(numeric.format, [...(byFormat.get(numeric.format) ?? []), cell.source]);
          formats.set(column, byFormat);
        }
      });
    });

    for (const values of duplicates.values()) {
      for (const [value, sources] of values) {
        if (sources.length > 1) findings.push({ code: "duplicate-value", severity: "warning", message: `Duplicate value "${value}" in a table column.`, reason: "동일 열에 같은 값이 반복됩니다.", recommendation: "중복이 업무상 유효한지 확인하세요.", sources });
      }
    }
    for (const [column, values] of formats) {
      if (values.size > 1) findings.push({ code: "inconsistent-number-format", severity: "warning", message: `Inconsistent numeric formats in column ${column + 1}.`, reason: "동일 열에서 서로 다른 숫자 표시 형식이 사용됩니다.", recommendation: "숫자 형식을 하나로 통일하세요.", sources: [...values.values()].flat() });
    }
    for (const total of totalForTable(block)) {
      if (Math.abs(total.actual - total.expected) > 1e-9) {
        findings.push({ code: "invalid-total", severity: "critical", message: `Total "${total.label}" is ${total.actual}, but contributing values sum to ${total.expected}.`, reason: "표시된 합계와 구성 값의 계산 결과가 다릅니다.", recommendation: "합계 수식 또는 구성 값을 수정하세요.", sources: [total.source, ...total.contributingSources] });
      }
    }
  }
  return { documentId: document.id, findings };
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
