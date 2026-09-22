import ExcelJS from "exceljs";
import type { DocumentExport } from "@/domain/operations";
import type { ValueCheckResult, ValueCheckStatus } from "@/domain/value-check";
import { sourceText } from "@/lib/extract/export";
import { csvField } from "@/lib/csv";
import { formatWorksheet } from "@/lib/xlsx-format";

const CSV_MIME_TYPE = "text/csv; charset=utf-8";
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const EMPTY = "—";
/** Beyond two files the per-file evidence columns stop fitting on one screen. */
const EVIDENCE_SHEET_THRESHOLD = 2;

const statusLabel: Record<ValueCheckStatus, string> = {
  different: "값 차이",
  partial: "일부 파일만 확인",
  consistent: "일치",
};

const STATUS_TINT: Partial<Record<ValueCheckStatus, string>> = {
  different: "FFFDF4E3",
  partial: "FFF1F4F9",
};

/**
 * One row per item, matching the on-screen matrix.
 *
 * The screen compares an item's values side by side; a workbook that repeats
 * the same item once per file cannot be read the same way.
 */
export interface ValueCheckExportRow {
  field: string;
  values: string[];
  status: string;
  sources: string[];
  tint?: string;
}

export interface ValueCheckEvidenceRow {
  field: string;
  fileName: string;
  value: string;
  location: string;
}


function fileNames(result: ValueCheckResult): string[] {
  const names = new Map(result.groups
    .flatMap((group) => group.occurrences)
    .map((occurrence) => [occurrence.fileId, occurrence.fileName]));
  return result.fileIds.map((fileId) => names.get(fileId) ?? fileId);
}

export function valueCheckExportRows(result: ValueCheckResult): ValueCheckExportRow[] {
  return result.groups.map((group) => ({
    field: group.field,
    values: result.fileIds.map((fileId) => {
      const values = group.occurrences.filter((occurrence) => occurrence.fileId === fileId).map((occurrence) => occurrence.displayValue);
      return values.length ? values.join(" | ") : EMPTY;
    }),
    status: statusLabel[group.status],
    sources: result.fileIds.map((fileId) => {
      const sources = group.occurrences
        .filter((occurrence) => occurrence.fileId === fileId)
        .flatMap((occurrence) => occurrence.sources.map(sourceText));
      return sources.length ? sources.join("; ") : EMPTY;
    }),
    ...(STATUS_TINT[group.status] ? { tint: STATUS_TINT[group.status] } : {}),
  }));
}

export function valueCheckEvidenceRows(result: ValueCheckResult): ValueCheckEvidenceRow[] {
  return result.groups.flatMap((group) => group.occurrences.map((occurrence) => ({
    field: group.field,
    fileName: occurrence.fileName,
    value: occurrence.displayValue,
    location: occurrence.sources.map(sourceText).join("; "),
  })));
}

function headersOf(result: ValueCheckResult): string[] {
  const names = fileNames(result);
  if (result.fileIds.length === EVIDENCE_SHEET_THRESHOLD) {
    return ["항목", "기준 파일 값", "대상 파일 값", "판정", "기준 근거", "대상 근거"];
  }
  return ["항목", ...names, "판정"];
}

function cellsOf(result: ValueCheckResult, row: ValueCheckExportRow): string[] {
  if (result.fileIds.length === EVIDENCE_SHEET_THRESHOLD) {
    return [row.field, row.values[0], row.values[1], row.status, row.sources[0], row.sources[1]];
  }
  return [row.field, ...row.values, row.status];
}

export function valueCheckCsv(result: ValueCheckResult): string {
  const rows = valueCheckExportRows(result);
  const data = [headersOf(result), ...rows.map((row) => cellsOf(result, row))];
  return `${data.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}

export async function valueCheckXlsx(result: ValueCheckResult): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("비교 결과");
  const rows = valueCheckExportRows(result);
  sheet.addRow(headersOf(result));
  for (const row of rows) {
    const added = sheet.addRow(cellsOf(result, row));
    if (!row.tint) continue;
    added.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: row.tint } };
  }
  formatWorksheet(sheet, { freezeHeader: true, autoFilter: true });

  // Two files fit their evidence beside the values; more files would push the
  // table past readable width, so evidence moves to its own sheet.
  if (result.fileIds.length > EVIDENCE_SHEET_THRESHOLD) {
    const evidence = workbook.addWorksheet("근거 상세");
    evidence.addRow(["항목", "파일", "값", "위치"]);
    for (const row of valueCheckEvidenceRows(result)) {
      evidence.addRow([row.field, row.fileName, row.value, row.location]);
    }
    formatWorksheet(evidence, { freezeHeader: true, autoFilter: true });
  }

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
