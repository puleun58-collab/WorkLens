import ExcelJS from "exceljs";
import type { DocumentExport, ExtractResult } from "@/domain/operations";
import type { NormalizedDocument, SourceRef } from "@/domain/document";
import { extractDocument } from "./deterministic";

const CSV_MIME_TYPE = "text/csv; charset=utf-8";
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function csvField(value: string | number | boolean | null): string {
  let text = value === null ? "" : String(value);
  // Spreadsheet applications evaluate fields beginning with these characters as formulas.
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Provenance columns carried by every exported record. Display labels alone are
 * ambiguous once several files share a sheet/range, so file identity, document
 * version, and the canonical node locator are exported as separate fields.
 */
const SOURCE_COLUMNS = ["file_id", "document_version", "node_id", "source"] as const;

function sourceFields(source: SourceRef): Array<string | null> {
  return [
    source.fileId,
    source.documentVersion ?? null,
    source.nodeId,
    source.label,
  ];
}

function exportedFileName(fileName: string, extension: "csv" | "xlsx"): string {
  return `${fileName.replace(/\.[^.]+$/, "")}.${extension}`;
}

/** Produces RFC 4180 CSV with spreadsheet formula injection neutralized. */
export function exportCsv(extraction: ExtractResult): string {
  const rows: Array<Array<string | number | boolean | null>> = [
    ["record_type", "block_id", "row", "column", "value", ...SOURCE_COLUMNS],
  ];
  for (const paragraph of extraction.paragraphs) {
    rows.push(["paragraph", paragraph.blockId, null, null, paragraph.text, ...sourceFields(paragraph.source)]);
  }
  for (const table of extraction.tables) {
    table.rows.forEach((row, rowIndex) => {
      row.forEach((cell, columnIndex) => {
        const value = cell.value ?? cell.display;
        rows.push(["table_cell", table.blockId, rowIndex + 1, columnIndex + 1, value, ...sourceFields(cell.source)]);
      });
    });
  }
  return `${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}

function worksheetName(preferred: string, used: Set<string>): string {
  const base = preferred.replace(/[\\/?*\[\]:]/g, " ").trim() || "Sheet";
  let name = base.slice(0, 31);
  let suffix = 2;
  while (used.has(name.toLocaleLowerCase())) {
    const suffixText = ` (${suffix})`;
    name = `${base.slice(0, 31 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  used.add(name.toLocaleLowerCase());
  return name;
}

/** Produces an XLSX workbook with one worksheet per extracted table and a Paragraphs worksheet. */
export async function exportXlsx(extraction: ExtractResult): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const names = new Set<string>();
  if (extraction.paragraphs.length > 0) {
    const sheet = workbook.addWorksheet(worksheetName("Paragraphs", names));
    sheet.addRow(["Block ID", "Text", "File ID", "Document Version", "Node ID", "Source"]);
    for (const paragraph of extraction.paragraphs) {
      sheet.addRow([paragraph.blockId, paragraph.text, ...sourceFields(paragraph.source)]);
    }
  }
  extraction.tables.forEach((table, index) => {
    const sheet = workbook.addWorksheet(worksheetName(`Table ${index + 1}`, names));
    for (const row of table.rows) {
      sheet.addRow(row.map((cell) => {
        const value = cell.value ?? cell.display;
        return typeof value === "string" && /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
      }));
    }
    // Machine-usable provenance for every exported cell, kept on a paired sheet so
    // the table sheet itself stays a faithful reproduction of the source grid.
    const provenance = workbook.addWorksheet(worksheetName(`Table ${index + 1} Source`, names));
    provenance.addRow(["Row", "Column", ...SOURCE_COLUMNS]);
    table.rows.forEach((row, rowIndex) => {
      row.forEach((cell, columnIndex) => {
        provenance.addRow([rowIndex + 1, columnIndex + 1, ...sourceFields(cell.source)]);
      });
    });
  });
  return new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer);
}

export function exportDocumentCsv(document: NormalizedDocument): DocumentExport {
  return {
    format: "csv",
    mimeType: CSV_MIME_TYPE,
    fileName: exportedFileName(document.metadata.fileName, "csv"),
    content: exportCsv(extractDocument(document)),
  };
}

export async function exportDocumentXlsx(document: NormalizedDocument): Promise<DocumentExport> {
  return {
    format: "xlsx",
    mimeType: XLSX_MIME_TYPE,
    fileName: exportedFileName(document.metadata.fileName, "xlsx"),
    content: await exportXlsx(extractDocument(document)),
  };
}
