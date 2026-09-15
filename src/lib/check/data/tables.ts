import type { SourceRef, TableBlock, TableCell } from "@/domain/document";
import type { CheckFinding, ExplicitTotal } from "@/domain/operations";
import { parseCanonicalNumber } from "@/domain/numeric";
import { cellText, isEmptyCell } from "../text-units";
import { makeFinding } from "../types";

const TOTAL_LABEL = /^(?:(?:grand\s+)?total\b|합계|총계)/iu;

function numericValue(cell: TableCell): number | undefined {
  if (typeof cell.value === "number" && Number.isFinite(cell.value)) return cell.value;
  return parseCanonicalNumber(cellText(cell))?.value;
}

function totalsForTable(table: TableBlock): ExplicitTotal[] {
  const totals: ExplicitTotal[] = [];
  for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
    const row = table.rows[rowIndex];
    const labelCell = row.find((cell) => !isEmptyCell(cell));
    if (!labelCell || !TOTAL_LABEL.test(cellText(labelCell))) continue;
    for (let column = 0; column < row.length; column += 1) {
      const actual = numericValue(row[column]);
      if (actual === undefined) continue;
      const contributors: TableCell[] = [];
      for (let previous = rowIndex - 1; previous >= 0; previous -= 1) {
        const candidate = table.rows[previous][column];
        if (!candidate || numericValue(candidate) === undefined) break;
        contributors.unshift(candidate);
      }
      if (contributors.length < 2) continue;
      totals.push({
        label: cellText(labelCell),
        expected: contributors.reduce((sum, cell) => sum + (numericValue(cell) ?? 0), 0),
        actual,
        source: row[column].source,
        contributingSources: contributors.map((cell) => cell.source),
      });
    }
  }
  return totals;
}

export function tableFindings(table: TableBlock): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const duplicates = new Map<number, Map<string, SourceRef[]>>();
  const formats = new Map<number, Map<string, SourceRef[]>>();

  table.rows.forEach((row, rowIndex) => {
    if (row.length > 0 && row.every(isEmptyCell)) findings.push(makeFinding({
      code: "empty-row",
      ruleId: "data/table/empty-row",
      category: "structure",
      severity: "suggestion",
      confidence: "medium",
      issue: "빈 행",
      message: `${rowIndex + 1}행의 모든 셀이 비어 있습니다.`,
      reason: "내용 없는 행은 데이터 범위와 정렬을 모호하게 만듭니다.",
      recommendation: "의도된 여백이 아니라면 빈 행을 삭제하세요.",
      sources: row.map((cell) => cell.source),
    }));

    row.forEach((cell, column) => {
      if (isEmptyCell(cell)) {
        findings.push(makeFinding({
          code: "empty-cell",
          ruleId: "data/table/empty-cell",
          category: "structure",
          severity: "suggestion",
          confidence: "low",
          issue: "빈 셀",
          message: `${column + 1}열의 셀 값이 비어 있습니다.`,
          reason: "필수 값이 누락되었거나 의도적으로 비운 셀일 수 있습니다.",
          recommendation: "의도된 빈 값인지 확인하세요.",
          sources: [cell.source],
        }));
        const above = rowIndex > 0 ? table.rows[rowIndex - 1]?.[column] : undefined;
        const below = table.rows[rowIndex + 1]?.[column];
        if (above && below && numericValue(above) !== undefined && numericValue(below) !== undefined) findings.push(makeFinding({
          code: "missing-value-in-series",
          ruleId: "data/table/missing-series-value",
          category: "numeric",
          severity: "warning",
          confidence: "medium",
          issue: "연속 데이터 값 누락",
          message: "연속된 수치 사이의 값이 비어 있습니다.",
          reason: "같은 열의 앞뒤 값이 숫자여서 시계열 또는 연속 데이터 누락 가능성이 높습니다.",
          recommendation: "원본 자료에서 누락된 값을 확인하고 입력하세요.",
          sources: [cell.source, above.source, below.source],
        }));
      }
      const text = cellText(cell);
      if (text) {
        const byValue = duplicates.get(column) ?? new Map<string, SourceRef[]>();
        const key = text.normalize("NFKC").toLocaleLowerCase();
        byValue.set(key, [...(byValue.get(key) ?? []), cell.source]);
        duplicates.set(column, byValue);
      }
      const numeric = parseCanonicalNumber(text);
      if (numeric) {
        const byFormat = formats.get(column) ?? new Map<string, SourceRef[]>();
        byFormat.set(numeric.format, [...(byFormat.get(numeric.format) ?? []), cell.source]);
        formats.set(column, byFormat);
      }
    });
  });

  for (const values of duplicates.values()) {
    for (const [value, sources] of values) {
      if (sources.length < 2) continue;
      findings.push(makeFinding({
        code: "duplicate-value",
        ruleId: "data/table/duplicate-value",
        category: "duplication",
        severity: "warning",
        confidence: "medium",
        issue: "중복 값",
        message: `동일 열에 "${value}" 값이 반복됩니다.`,
        reason: "동일 열에 같은 값이 반복되어 중복 레코드일 가능성이 있습니다.",
        recommendation: "중복이 업무상 유효한지 확인하세요.",
        sources,
        originalText: value,
      }));
    }
  }

  for (const [column, values] of formats) {
    if (values.size < 2) continue;
    findings.push(makeFinding({
      code: "inconsistent-number-format",
      ruleId: "data/table/number-format",
      category: "formatting",
      severity: "warning",
      confidence: "medium",
      issue: "숫자 형식 불일치",
      message: `${column + 1}열에서 서로 다른 숫자 표시 형식이 사용됩니다.`,
      reason: "동일 열의 천 단위, 소수점 또는 통화 표시 방식이 다릅니다.",
      recommendation: "숫자 형식을 하나로 통일하세요.",
      sources: [...values.values()].flat(),
    }));
  }

  for (const total of totalsForTable(table)) {
    if (Math.abs(total.actual - total.expected) <= 1e-9) continue;
    findings.push(makeFinding({
      code: "invalid-total",
      ruleId: "data/table/invalid-total",
      category: "total",
      severity: "critical",
      confidence: "high",
      issue: "합계 불일치",
      message: `합계 "${total.label}"의 표시값 ${total.actual}과 계산값 ${total.expected}이 다릅니다.`,
      reason: "표시된 합계와 구성 값의 계산 결과가 다릅니다.",
      recommendation: "합계 수식 또는 구성 값을 수정하세요.",
      sources: [total.source, ...total.contributingSources],
      originalText: String(total.actual),
      suggestedText: String(total.expected),
    }));
  }
  return findings;
}
