import type ExcelJS from "exceljs";

const HEADER_FILL = "FFF3F6F9";
const HEADER_BORDER = "FFD7DEE7";

export interface WorksheetFormatOptions {
  /** Rows that contain column labels. Records sheets may contain several. */
  headerRows?: readonly number[];
  /** Freeze the first row only when it is the single header for one table. */
  freezeHeader?: boolean;
  /** Add a filter only when the sheet is one rectangular table. */
  autoFilter?: boolean;
  minWidth?: number;
  maxWidth?: number;
}

function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    width += character.codePointAt(0)! > 0xff ? 2 : 1;
  }
  return width;
}

/**
 * A number format decides how wide a value reads: `#,##0"원"` turns 2258000
 * into `2,258,000원`, and a column measured on the raw digits shows `########`.
 * ExcelJS never renders formats, so the rendered width is estimated here.
 */
function formattedWidth(cell: ExcelJS.Cell): number {
  const format = cell.numFmt;
  if (!format) return 0;
  const tokens = format.replace(/\\./gu, "").replace(/\[[^\]]*\]/gu, "");
  const literals = [...tokens.matchAll(/"([^"]*)"/gu)].map((match) => match[1]).join("");
  if (cell.value instanceof Date) {
    return displayWidth(tokens.replace(/"[^"]*"/gu, literals)) + 1;
  }
  if (typeof cell.value !== "number") return 0;
  const percent = tokens.includes("%");
  const magnitude = Math.abs(percent ? cell.value * 100 : cell.value);
  const digits = magnitude < 1 ? 1 : Math.floor(Math.log10(magnitude)) + 1;
  const decimals = /\.(0+)/u.exec(tokens)?.[1].length ?? 0;
  const grouping = tokens.includes("#,#") ? Math.floor((digits - 1) / 3) : 0;
  const signs = (cell.value < 0 ? 1 : 0) + (percent ? 1 : 0);
  return digits + grouping + (decimals > 0 ? decimals + 1 : 0) + signs + displayWidth(literals) + 1;
}

/**
 * Applies WorkLens' restrained workbook presentation without changing values.
 * Widths are content-aware but bounded; only text that no longer fits is
 * wrapped, leaving numeric and date cell types and their native alignment intact.
 */
export function formatWorksheet(
  sheet: ExcelJS.Worksheet,
  options: WorksheetFormatOptions = {},
): void {
  const headerRows = new Set(options.headerRows ?? [1]);
  const minWidth = options.minWidth ?? 10;
  const maxWidth = options.maxWidth ?? 48;

  for (const rowNumber of headerRows) {
    const row = sheet.getRow(rowNumber);
    if (!row.hasValues) continue;
    row.height = Math.max(row.height ?? 0, 22);
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.font = { ...cell.font, bold: true, color: { argb: "FF263445" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
      cell.border = {
        top: { style: "thin", color: { argb: HEADER_BORDER } },
        left: { style: "thin", color: { argb: HEADER_BORDER } },
        bottom: { style: "thin", color: { argb: HEADER_BORDER } },
        right: { style: "thin", color: { argb: HEADER_BORDER } },
      };
      cell.alignment = { ...cell.alignment, horizontal: "left", vertical: "middle", wrapText: true };
    });
  }

  // `columnCount` walks every row on each read; read it once.
  for (let columnNumber = 1, columnCount = sheet.columnCount; columnNumber <= columnCount; columnNumber += 1) {
    const column = sheet.getColumn(columnNumber);
    let measured = minWidth;
    column.eachCell({ includeEmpty: false }, (cell) => {
      const lines = cell.text.split(/\r?\n/u);
      for (const line of lines) measured = Math.max(measured, displayWidth(line) + 2);
      measured = Math.max(measured, formattedWidth(cell) + 2);
    });
    column.width = Math.min(maxWidth, measured);
  }

  sheet.eachRow((row) => {
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      if (headerRows.has(row.number) || typeof cell.value !== "string") return;
      const width = sheet.getColumn(columnNumber).width ?? maxWidth;
      const shouldWrap = cell.value.includes("\n") || displayWidth(cell.text) > width;
      cell.alignment = {
        ...cell.alignment,
        horizontal: cell.alignment?.horizontal ?? "left",
        vertical: "top",
        ...(shouldWrap ? { wrapText: true } : {}),
      };
    });
  });

  if (options.freezeHeader && sheet.rowCount > 1) {
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  }
  if (options.autoFilter && sheet.rowCount > 1 && sheet.columnCount > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheet.columnCount },
    };
  }
}
