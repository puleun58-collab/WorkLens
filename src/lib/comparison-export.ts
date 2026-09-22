import ExcelJS from "exceljs";
import type { ComparisonCategory, ComparisonItem, ComparisonResult } from "@/domain/compare";
import type { SourceRef } from "@/domain/document";
import type { DocumentExport } from "@/domain/operations";
import { sourceText } from "@/lib/extract/export";
import { csvField } from "@/lib/csv";
import { formatWorksheet } from "@/lib/xlsx-format";

const CSV_MIME_TYPE = "text/csv; charset=utf-8";
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const EMPTY = "—";

const CATEGORY_LABELS: Record<ComparisonCategory, string> = {
  Added: "추가",
  Removed: "삭제",
  Changed: "변경",
  "Structural Change": "구조 변경",
  "Important Change": "중요 변경",
};

const CATEGORY_TINT: Partial<Record<ComparisonCategory, string>> = {
  Removed: "FFFDECEC",
  "Important Change": "FFFDF4E3",
  "Structural Change": "FFF1F4F9",
};

/**
 * One canonical row per change, shared by CSV and XLSX.
 *
 * Both formats must say the same thing; deriving them from one row model is
 * what makes that true, instead of two places computing a difference.
 */
export interface ComparisonExportRow {
  category: string;
  label: string;
  previous: string;
  current: string;
  difference: string;
  changeRate: string;
  baseSource: string;
  targetSource: string;
  tint?: string;
}


function sourcePair(item: ComparisonItem): { base?: SourceRef; current?: SourceRef } {
  if (item.previous === null) return { current: item.sources[0] };
  if (item.current === null) return { base: item.sources[0] };
  return { base: item.sources[0], current: item.sources[1] };
}

function changeRateText(item: ComparisonItem): string {
  // A rate without a difference would describe a change nobody computed.
  if (item.deltaText === null || item.changePercent === null || !Number.isFinite(item.changePercent)) return EMPTY;
  return `${item.changePercent > 0 ? "+" : ""}${item.changePercent.toFixed(2)}%`;
}

export function comparisonExportRows(result: ComparisonResult): ComparisonExportRow[] {
  return result.items.map((item) => {
    const sources = sourcePair(item);
    return {
      category: CATEGORY_LABELS[item.category],
      label: item.label,
      previous: item.previous ?? EMPTY,
      current: item.current ?? EMPTY,
      difference: item.deltaText ?? EMPTY,
      changeRate: changeRateText(item),
      baseSource: sources.base ? sourceText(sources.base) : EMPTY,
      targetSource: sources.current ? sourceText(sources.current) : EMPTY,
      ...(CATEGORY_TINT[item.category] ? { tint: CATEGORY_TINT[item.category] } : {}),
    };
  });
}

/** The item column exists only when the documents actually name their items. */
function columnsOf(rows: readonly ComparisonExportRow[]): { headers: string[]; cells: (row: ComparisonExportRow) => string[] } {
  const labelled = rows.some((row) => row.label.trim() !== "");
  return {
    headers: labelled
      ? ["변경 유형", "항목", "기준 파일 값", "대상 파일 값", "차이", "변화율", "기준 근거", "대상 근거"]
      : ["변경 유형", "기준 파일 값", "대상 파일 값", "차이", "변화율", "기준 근거", "대상 근거"],
    cells: (row) => labelled
      ? [row.category, row.label, row.previous, row.current, row.difference, row.changeRate, row.baseSource, row.targetSource]
      : [row.category, row.previous, row.current, row.difference, row.changeRate, row.baseSource, row.targetSource],
  };
}

export function comparisonCsv(result: ComparisonResult): string {
  const rows = comparisonExportRows(result);
  const { headers, cells } = columnsOf(rows);
  return `${[headers, ...rows.map(cells)].map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}

export async function comparisonXlsx(result: ComparisonResult): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("버전 비교");
  const rows = comparisonExportRows(result);
  const { headers, cells } = columnsOf(rows);
  sheet.addRow(headers);
  for (const row of rows) {
    const added = sheet.addRow(cells(row));
    if (!row.tint) continue;
    added.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: row.tint } };
  }
  formatWorksheet(sheet, { freezeHeader: true, autoFilter: true });
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
