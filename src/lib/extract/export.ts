import ExcelJS from "exceljs";
import type { SourceRef } from "@/domain/document";
import type { DocumentExport } from "@/domain/operations";
import type { ExtractedField, StructuredExtract } from "@/domain/extract";
import { csvField } from "@/lib/csv";
import { formatWorksheet } from "@/lib/xlsx-format";

/**
 * Export of structured extraction.
 *
 * The workbook's main sheet stays horizontal (one row per file). Automatic
 * mode also keeps item-level Details; Evidence maps readings to source and
 * model confidence. Requested-field CSV retains the same horizontal shape,
 * with source and confidence mappings in trailing columns.
 */
const CSV_MIME_TYPE = "text/csv; charset=utf-8";
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";


/** Human-readable locator, the same wording the result rows show. */
export function sourceText(source: SourceRef): string {
  const locator = source.locator;
  if (!locator) return source.label;
  switch (locator.kind) {
    case "pptx": return locator.tableCell ? `Slide ${locator.slide} · 표` : `Slide ${locator.slide}`;
    case "pdf": return `Page ${locator.page}`;
    case "xlsx": return `${locator.sheet} · ${locator.range}`;
    case "docx": {
      const part = locator.part === "header" ? "머리글" : locator.part === "footer" ? "바닥글" : undefined;
      const position = locator.tableCell ? `표 · Row ${locator.tableCell.row + 1}` : `Paragraph ${locator.block + 1}`;
      return part ? `${part} · ${position}` : position;
    }
    case "csv": return `Row ${locator.record}`;
  }
}

const sourcesText = (field: ExtractedField): string => field.sources.map(sourceText).join("; ");

/** The requested-field CSV stays horizontal; map uncertain readings to the exact value. */
function confidenceText(fields: readonly ExtractedField[]): string {
  const modelFields = fields.filter((field) => field.confidence !== undefined);
  return modelFields.length
    ? JSON.stringify(modelFields.map((entry) => ({
      field: entry.field,
      value: entry.displayValue,
      confidence: entry.confidence,
      sources: entry.sources.map(sourceText),
    })))
    : "";
}

const truncatedText = (truncated?: boolean): string =>
  truncated ? "추출 한도(파일당 300개) 초과: 일부 항목 누락" : "";

/** Values are left empty when a field is not stated: no "없음" placeholders. */
function fieldValue(fields: readonly ExtractedField[], name: string): string {
  return fields.filter((entry) => entry.field === name).map((entry) => entry.displayValue).join(" | ");
}

/** Stable union in source order; no alphabetic reordering of document fields. */
function automaticFields(extract: StructuredExtract): string[] {
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const file of extract.files) {
    for (const field of file.fields) {
      if (seen.has(field.field)) continue;
      seen.add(field.field);
      fields.push(field.field);
    }
  }
  return fields;
}

const recordTitle = (record: StructuredExtract["files"][number]["records"][number]): string =>
  record.displayTitle ?? record.title;

export function structuredCsv(extract: StructuredExtract): string {
  const rows: Array<Array<string | number | null>> = [];
  if (extract.mode === "fields") {
    const hasTruncation = extract.files.some((file) => file.truncated);
    rows.push(["FILE", ...extract.requestedFields, "SOURCE", "AI CONFIDENCE", ...(hasTruncation ? ["STATUS"] : [])]);
    for (const file of extract.files) {
      rows.push([
        file.file.name,
        ...extract.requestedFields.map((name) => fieldValue(file.fields, name)),
        file.fields.map((entry) => `${entry.field}=${sourcesText(entry)}`).join("; "),
        confidenceText(file.fields),
        ...(hasTruncation ? [truncatedText(file.truncated)] : []),
      ]);
    }
  } else {
    const hasTruncation = extract.files.some((file) => file.truncated);
    rows.push(["FILE", "FIELD", "VALUE", "TYPE", "SOURCE", "AI CONFIDENCE", ...(hasTruncation ? ["STATUS"] : [])]);
    for (const file of extract.files) {
      for (const field of file.fields) {
        rows.push([file.file.name, field.field, field.displayValue, field.type, sourcesText(field), field.confidence ?? "", ...(hasTruncation ? [truncatedText(file.truncated)] : [])]);
      }
      for (const record of file.records) {
        for (const row of record.rows) {
          rows.push([file.file.name, recordTitle(record), row.cells.join(" | "), "Record", sourceText(row.source), "", ...(hasTruncation ? [truncatedText(file.truncated)] : [])]);
        }
      }
    }
  }
  return `${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}

export async function structuredXlsx(extract: StructuredExtract): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const data = workbook.addWorksheet("Extracted Data");
  if (extract.mode === "fields") {
    const hasTruncation = extract.files.some((file) => file.truncated);
    data.addRow(["FILE", ...extract.requestedFields, ...(hasTruncation ? ["STATUS"] : [])]);
    for (const file of extract.files) {
      data.addRow([file.file.name, ...extract.requestedFields.map((name) => fieldValue(file.fields, name)), ...(hasTruncation ? [truncatedText(file.truncated)] : [])]);
    }
  } else {
    const fields = automaticFields(extract);
    const hasTruncation = extract.files.some((file) => file.truncated);
    data.addRow(["FILE", ...fields, ...(hasTruncation ? ["STATUS"] : [])]);
    for (const file of extract.files) {
      data.addRow([file.file.name, ...fields.map((name) => fieldValue(file.fields, name)), ...(hasTruncation ? [truncatedText(file.truncated)] : [])]);
    }

    if (extract.files.some((file) => file.fields.length > 0)) {
      const details = workbook.addWorksheet("Details");
      details.addRow(["FILE", "FIELD", "VALUE", "TYPE", "SOURCE", "AI CONFIDENCE"]);
      for (const file of extract.files) {
        for (const field of file.fields) {
          details.addRow([file.file.name, field.field, field.displayValue, field.type, sourcesText(field), field.confidence ?? ""]);
        }
      }
      formatWorksheet(details, { freezeHeader: true, autoFilter: true });
    }
  }
  formatWorksheet(data, { freezeHeader: true, autoFilter: true });

  if (extract.mode === "fields" || extract.files.some((file) => file.fields.some((field) => field.sources.length > 0 || field.confidence))) {
    const evidence = workbook.addWorksheet("Evidence");
    evidence.addRow(["FILE", "FIELD", "VALUE", "SOURCE", "QUOTE", "AI CONFIDENCE"]);
    for (const file of extract.files) {
      for (const field of file.fields) {
        if (field.sources.length === 0 && field.confidence) {
          evidence.addRow([file.file.name, field.field, field.displayValue, "", field.quote ?? "", field.confidence]);
        }
        for (const source of field.sources) {
          evidence.addRow([file.file.name, field.field, field.displayValue, sourceText(source), field.quote ?? source.quote ?? "", field.confidence ?? ""]);
        }
      }
    }
    formatWorksheet(evidence, { freezeHeader: true });
  }

  // Repeating structures stay tables instead of being split into pairs.
  const withRecords = extract.files.filter((file) => file.records.length > 0);
  if (withRecords.length > 0) {
    const sheet = workbook.addWorksheet("Records");
    const headerRows: number[] = [];
    for (const file of withRecords) {
      for (const record of file.records) {
        headerRows.push(sheet.rowCount + 1);
        sheet.addRow([file.file.name, recordTitle(record), ...record.columns, "SOURCE"]);
        for (const row of record.rows) {
          sheet.addRow([file.file.name, recordTitle(record), ...row.cells, sourceText(row.source)]);
        }
      }
    }
    formatWorksheet(sheet, { headerRows });
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
