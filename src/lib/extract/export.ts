import ExcelJS from "exceljs";
import type { SourceRef } from "@/domain/document";
import type { DocumentExport } from "@/domain/operations";
import type { ExtractedField, StructuredExtract } from "@/domain/extract";

/**
 * Export of structured extraction.
 *
 * The workbook is the deliverable: one row per file when the user named the
 * fields, one row per extracted item in automatic mode, and a second sheet
 * carrying the source and quote behind every value. CSV holds the same table
 * with the source as a column, because a spreadsheet is where this data is
 * actually used.
 */
const CSV_MIME_TYPE = "text/csv; charset=utf-8";
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function csvField(value: string | number | null): string {
  let text = value === null ? "" : String(value);
  // Spreadsheets evaluate a leading =, +, - or @ as a formula.
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Human-readable locator, the same wording the result rows show. */
export function sourceText(source: SourceRef): string {
  const locator = source.locator;
  if (!locator) return source.label;
  switch (locator.kind) {
    case "pptx": return `Slide ${locator.slide} · ${locator.tableCell ? "표" : "본문"}`;
    case "pdf": return `Page ${locator.page}`;
    case "xlsx": return `${locator.sheet} · ${locator.range}`;
    case "docx": return locator.tableCell ? `표 · Row ${locator.tableCell.row + 1}` : `Paragraph ${locator.block + 1}`;
    case "csv": return `Row ${locator.record}`;
  }
}

const sourcesText = (field: ExtractedField): string => field.sources.map(sourceText).join("; ");

/** Values are left empty when a field is not stated: no "없음" placeholders. */
function fieldValue(fields: readonly ExtractedField[], name: string): string {
  return fields.find((entry) => entry.field === name)?.displayValue ?? "";
}

export function structuredCsv(extract: StructuredExtract): string {
  const rows: Array<Array<string | number | null>> = [];
  if (extract.mode === "fields") {
    rows.push(["FILE", ...extract.requestedFields, "SOURCE"]);
    for (const file of extract.files) {
      rows.push([
        file.file.name,
        ...extract.requestedFields.map((name) => fieldValue(file.fields, name)),
        file.fields.map((entry) => `${entry.field}=${sourcesText(entry)}`).join("; "),
      ]);
    }
  } else {
    rows.push(["FILE", "FIELD", "VALUE", "TYPE", "SOURCE"]);
    for (const file of extract.files) {
      for (const field of file.fields) {
        rows.push([file.file.name, field.field, field.displayValue, field.type, sourcesText(field)]);
      }
    }
  }
  return `${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}

export async function structuredXlsx(extract: StructuredExtract): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const data = workbook.addWorksheet("Extracted Data");
  if (extract.mode === "fields") {
    data.addRow(["FILE", ...extract.requestedFields]);
    for (const file of extract.files) {
      data.addRow([file.file.name, ...extract.requestedFields.map((name) => fieldValue(file.fields, name))]);
    }
  } else {
    data.addRow(["FILE", "FIELD", "VALUE", "TYPE", "SOURCE"]);
    for (const file of extract.files) {
      for (const field of file.fields) {
        data.addRow([file.file.name, field.field, field.displayValue, field.type, sourcesText(field)]);
      }
    }
  }

  const evidence = workbook.addWorksheet("Evidence");
  evidence.addRow(["FILE", "FIELD", "VALUE", "SOURCE", "QUOTE"]);
  for (const file of extract.files) {
    for (const field of file.fields) {
      for (const source of field.sources) {
        evidence.addRow([file.file.name, field.field, field.displayValue, sourceText(source), field.quote ?? source.quote ?? ""]);
      }
    }
  }

  // Repeating structures stay tables instead of being split into pairs.
  const withRecords = extract.files.filter((file) => file.records.length > 0);
  if (withRecords.length > 0) {
    const sheet = workbook.addWorksheet("Records");
    for (const file of withRecords) {
      for (const record of file.records) {
        sheet.addRow([file.file.name, record.title, ...record.columns]);
        for (const row of record.rows) sheet.addRow([file.file.name, record.title, ...row.cells]);
      }
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

export function structuredCsvExport(extract: StructuredExtract): DocumentExport {
  return {
    format: "csv",
    mimeType: CSV_MIME_TYPE,
    fileName: `worklens-extract-${extract.mode}.csv`,
    content: structuredCsv(extract),
  };
}

export async function structuredXlsxExport(extract: StructuredExtract): Promise<DocumentExport> {
  return {
    format: "xlsx",
    mimeType: XLSX_MIME_TYPE,
    fileName: `worklens-extract-${extract.mode}.xlsx`,
    content: await structuredXlsx(extract),
  };
}
