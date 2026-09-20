import ExcelJS from "exceljs";
import type { ComparisonCategory, ComparisonItem, ComparisonResult } from "@/domain/compare";
import type { SourceRef } from "@/domain/document";
import type { DocumentExport } from "@/domain/operations";
import { sourceText } from "@/lib/extract/export";

const CSV_MIME_TYPE = "text/csv; charset=utf-8";
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const HEADERS = ["변경 유형", "항목", "기준 파일 값", "대상 파일 값", "차이", "변화율", "기준 근거", "대상 근거"];

const CATEGORY_LABELS: Record<ComparisonCategory, string> = {
  Added: "추가",
  Removed: "삭제",
  Changed: "변경",
  "Structural Change": "구조 변경",
  "Important Change": "중요 변경",
};

function csvField(value: string): string {
  const safe = /^\s*[=+\-@]/u.test(value) ? `'${value}` : value;
  return /[",\r\n]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe;
}

function sourcePair(item: ComparisonItem): { base?: SourceRef; current?: SourceRef } {
  if (item.previous === null) return { current: item.sources[0] };
  if (item.current === null) return { base: item.sources[0] };
  return { base: item.sources[0], current: item.sources[1] };
}

function numberText(value: number | null): string {
  return value === null ? "" : String(value);
}

function rows(result: ComparisonResult): string[][] {
  return result.items.map((item) => {
    const sources = sourcePair(item);
    return [
      CATEGORY_LABELS[item.category],
      item.label,
      item.previous ?? "",
      item.current ?? "",
      numberText(item.difference),
      item.changePercent === null ? "" : `${item.changePercent.toFixed(2)}%`,
      sources.base ? sourceText(sources.base) : "",
      sources.current ? sourceText(sources.current) : "",
    ];
  });
}

export function comparisonCsv(result: ComparisonResult): string {
  return `${[HEADERS, ...rows(result)].map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}

export async function comparisonXlsx(result: ComparisonResult): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("버전 비교");
  sheet.addRow(HEADERS);
  for (const row of rows(result)) sheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

export function comparisonCsvExport(result: ComparisonResult): DocumentExport {
  return {
    format: "csv",
    mimeType: CSV_MIME_TYPE,
    fileName: "worklens-version-compare.csv",
    content: comparisonCsv(result),
  };
}

export async function comparisonXlsxExport(result: ComparisonResult): Promise<DocumentExport> {
  return {
    format: "xlsx",
    mimeType: XLSX_MIME_TYPE,
    fileName: "worklens-version-compare.xlsx",
    content: await comparisonXlsx(result),
  };
}
