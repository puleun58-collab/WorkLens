import ExcelJS from "exceljs";
import type { DocumentExport } from "@/domain/operations";
import type { ValueCheckResult, ValueCheckStatus } from "@/domain/value-check";
import { EXTRACT_TYPE_LABELS } from "@/domain/extract";
import { sourceText } from "@/lib/extract/export";
import { formatWorksheet } from "@/lib/xlsx-format";

const CSV_MIME_TYPE = "text/csv; charset=utf-8";
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const statusLabel: Record<ValueCheckStatus, string> = {
  different: "값 차이",
  partial: "일부 확인",
  consistent: "일치",
};

function csvField(value: string): string {
  const safe = /^\s*[=+\-@]/u.test(value) ? `'${value}` : value;
  return /[",\r\n]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe;
}

function rows(result: ValueCheckResult): string[][] {
  return result.groups.flatMap((group) => group.occurrences.map((occurrence) => [
    group.field,
    statusLabel[group.status],
    occurrence.fileName,
    occurrence.displayValue,
    EXTRACT_TYPE_LABELS[occurrence.type],
    occurrence.sources.map(sourceText).join("; "),
  ]));
}

export function valueCheckCsv(result: ValueCheckResult): string {
  const data = [["항목", "상태", "파일", "값", "타입", "근거 위치"], ...rows(result)];
  return `${data.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}

export async function valueCheckXlsx(result: ValueCheckResult): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("값 일치 확인");
  sheet.addRow(["항목", "상태", "파일", "값", "타입", "근거 위치"]);
  for (const row of rows(result)) sheet.addRow(row);
  formatWorksheet(sheet, { freezeHeader: true, autoFilter: true });
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

export function valueCheckCsvExport(result: ValueCheckResult): DocumentExport {
  return {
    format: "csv",
    mimeType: CSV_MIME_TYPE,
    fileName: "worklens-value-check.csv",
    content: valueCheckCsv(result),
  };
}

export async function valueCheckXlsxExport(result: ValueCheckResult): Promise<DocumentExport> {
  return {
    format: "xlsx",
    mimeType: XLSX_MIME_TYPE,
    fileName: "worklens-value-check.xlsx",
    content: await valueCheckXlsx(result),
  };
}
