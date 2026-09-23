import ExcelJS from "exceljs";

import type {
  DocumentMedia,
  DocumentMetadata,
  NormalizedDocument,
  SourceRef,
  TableCell,
  WorkbookSheet,
  XlsxStyleSnapshot,
  XlsxWorksheetTemplate,
} from "@/domain/document";

import { DocumentError } from "@/lib/upload";
import { isDateNumberFormat, serialToDate } from "@/lib/xlsx-values";

const malformedFileError = (): Error =>
  new DocumentError("DOCUMENT_UNREADABLE", "파일을 읽지 못했습니다.", "지원되는 Excel 파일인지 확인한 뒤 다시 시도해 주세요.");

const cellAddress = (column: number, row: number): string => {
  let value = column;
  let address = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    address = String.fromCharCode(65 + remainder) + address;
    value = Math.floor((value - 1) / 26);
  }
  return `${address}${row}`;
};

const rangeBounds = (
  range: string,
): { startRow: number; startColumn: number; endRow: number; endColumn: number } | undefined => {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(range);
  if (match === null) {
    return undefined;
  }
  const column = (letters: string): number =>
    letters.toUpperCase().split("").reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
  return {
    startColumn: column(match[1]),
    startRow: Number(match[2]),
    endColumn: column(match[3]),
    endRow: Number(match[4]),
  };
};

const snapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const styleSnapshot = (style: Partial<ExcelJS.Style>): XlsxStyleSnapshot | undefined => {
  const cloned = snapshot(style) as XlsxStyleSnapshot;
  return Object.keys(cloned).length > 0 ? cloned : undefined;
};

const cellPosition = (value: unknown): { row: number; column: number } | undefined => {
  if (typeof value === "string") {
    const match = /^([A-Z]+)(\d+)$/iu.exec(value);
    if (!match) return undefined;
    return {
      row: Number(match[2]),
      column: match[1].toUpperCase().split("").reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0),
    };
  }
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { row?: unknown; column?: unknown };
  return typeof candidate.row === "number" && typeof candidate.column === "number"
    ? { row: candidate.row, column: candidate.column }
    : undefined;
};

const autoFilterSnapshot = (value: unknown): XlsxWorksheetTemplate["autoFilter"] => {
  if (typeof value === "string") {
    const bounds = rangeBounds(value);
    return bounds ? {
      from: { row: bounds.startRow, column: bounds.startColumn },
      to: { row: bounds.endRow, column: bounds.endColumn },
    } : undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { from?: unknown; to?: unknown };
  const from = cellPosition(candidate.from);
  const to = cellPosition(candidate.to);
  return from && to ? { from, to } : undefined;
};

/**
 * Rich text, hyperlinks and cached formula results are objects in ExcelJS.
 * Reducing them to their readable text keeps `String(value)` — and with it
 * `[object Object]` — out of every downstream reader.
 */
const richTextOf = (value: object): string | undefined => {
  if (!("richText" in value)) return undefined;
  const runs = value.richText;
  if (!Array.isArray(runs)) return undefined;
  return runs.map((run: unknown) => {
    if (typeof run !== "object" || run === null || !("text" in run)) return "";
    return typeof run.text === "string" ? run.text : "";
  }).join("");
};

const scalarValue = (value: unknown): string | number | boolean | null => {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object" && value !== null) {
    const rich = richTextOf(value);
    if (rich !== undefined) return rich;
    if ("error" in value) return null;
    if ("result" in value) return scalarValue(value.result);
    if ("text" in value) return scalarValue(value.text);
  }
  return null;
};

const imageMimeType = (extension: string): string => {
  switch (extension.toLowerCase()) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
};

/** A serial number is a calendar value only when its number format says so. */

const numericOf = (value: unknown): number | undefined => {
  if (typeof value === "number") return value;
  if (typeof value === "object" && value !== null && "result" in value) {
    return numericOf(value.result);
  }
  return undefined;
};

/** Text dates are promoted only with an explicit calendar value AND a date cell format. */
const explicitDate = (value: unknown): Date | undefined => {
  const raw = typeof value === "string" ? value : undefined;
  const match = raw?.trim().match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?\.?$/u);
  if (!match) return undefined;
  const [, year, month, day, hour = "0", minute = "0", second = "0"] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() + 1 === Number(month)
    && date.getUTCDate() === Number(day)
    && date.getUTCHours() === Number(hour)
    && date.getUTCMinutes() === Number(minute)
    && date.getUTCSeconds() === Number(second)
    ? date : undefined;
};

const cellDate = (cell: ExcelJS.Cell): Date | undefined => {
  const raw = cell.value;
  if (raw instanceof Date) return raw;
  if (typeof raw === "object" && raw !== null && "result" in raw && raw.result instanceof Date) {
    return raw.result;
  }
  if (isDateNumberFormat(cell.numFmt)) {
    const explicit = explicitDate(typeof raw === "object" && raw !== null && "result" in raw ? raw.result : raw);
    if (explicit) return explicit;
  }
  const numeric = numericOf(raw);
  return numeric !== undefined && isDateNumberFormat(cell.numFmt) ? serialToDate(numeric) : undefined;
};

const cellValueType = (cell: ExcelJS.Cell, date: Date | undefined): TableCell["valueType"] => {
  if (date !== undefined) return "date";
  if (cell.type === ExcelJS.ValueType.Formula) return "formula";
  if (typeof cell.value === "number") return "number";
  if (typeof cell.value === "boolean") return "boolean";
  if (cell.value === null || cell.value === undefined || cell.text === "") return "blank";
  return "text";
};

/**
 * ExcelJS's `cell.text` calls the native `Date.prototype.toString()` for date
 * cells, which leaks the process's local timezone and weekday name (e.g.
 * "Mon Jul 13 2026 09:00:00 GMT+0900 (한국 표준시)") instead of the calendar
 * date the workbook actually stores. Render the UTC calendar date instead,
 * matching the ISO convention `scalarValue` already uses for `value`. Excel
 * time-only cells serialize against the 1899/1900 epoch, so a year that old
 * means only the time of day was ever meaningful.
 */
const formatCellDate = (date: Date): string => {
  const pad = (part: number): string => String(part).padStart(2, "0");
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  if (date.getUTCFullYear() <= 1900) return time;
  const isoDate = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const hasTimeOfDay = date.getUTCHours() !== 0 || date.getUTCMinutes() !== 0 || date.getUTCSeconds() !== 0;
  return hasTimeOfDay ? `${isoDate} ${time}` : isoDate;
};

const percentText = (cell: ExcelJS.Cell): string | undefined => {
  const format = cell.numFmt;
  const value = numericOf(cell.value);
  if (value === undefined || !format) return undefined;
  const tokens = format.replace(/\\./gu, "").replace(/"[^"]*"/gu, "").replace(/\[[^\]]*\]/gu, "");
  if (!tokens.includes("%")) return undefined;
  const decimals = /\.(0+)/u.exec(tokens)?.[1].length ?? 0;
  return `${(value * 100).toFixed(decimals)}%`;
};

/** The text a person reads in the cell, never an object's default stringification. */
const cellText = (cell: ExcelJS.Cell, date: Date | undefined): string => {
  if (date !== undefined) return formatCellDate(date);
  const raw = cell.value;
  if (typeof raw === "object" && raw !== null && !(raw instanceof Date)) {
    const rich = richTextOf(raw);
    if (rich !== undefined) return rich;
    if ("error" in raw) return typeof raw.error === "string" ? raw.error : "";
    if ("text" in raw && typeof raw.text === "string") {
      return raw.text;
    }
  }
  // ExcelJS returns the stored fraction for a percentage cell; the workbook
  // shows `7.5%`, and every reader downstream compares what the workbook shows.
  const percent = percentText(cell);
  if (percent !== undefined) return percent;
  const text = cell.text;
  return typeof text === "string" && !text.startsWith("[object ") ? text : "";
};

export const parseXlsx = async (input: {
  fileId: string;
  fileName: string;
  bytes: Uint8Array;
}): Promise<NormalizedDocument> => {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(input.bytes.slice().buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

    const metadata: DocumentMetadata = {
      fileName: input.fileName,
      sheets: workbook.worksheets.map((worksheet) => ({
        name: worksheet.name,
        visibility: worksheet.state,
        rowCount: worksheet.rowCount,
        columnCount: worksheet.columnCount,
      })),
    };
    const warnings = new Set<string>();
    if (workbook.worksheets.some((worksheet) => worksheet.state === "hidden" || worksheet.state === "veryHidden")) {
      warnings.add("XLSX_HIDDEN_SHEET_OMITTED");
    }

    const workbookSheets: WorkbookSheet[] = workbook.worksheets.map(
      (worksheet, sheetIndex) => {
        const tableId = `xlsx:${sheetIndex + 1}:table`;
        const tableSource: SourceRef = {
          fileId: input.fileId,
          nodeId: tableId,
          label: worksheet.name,
          sheet: worksheet.name,
          cellRange: `A1:${cellAddress(Math.max(1, worksheet.columnCount), Math.max(1, worksheet.rowCount))}`,
        };
        const mergedCells = new Map<
          string,
          { rowSpan: number; colSpan: number; isAnchor: boolean }
        >();
        for (const range of worksheet.model.merges) {
          const bounds = rangeBounds(range);
          if (bounds === undefined) {
            continue;
          }
          for (let row = bounds.startRow; row <= bounds.endRow; row += 1) {
            for (
              let column = bounds.startColumn;
              column <= bounds.endColumn;
              column += 1
            ) {
              mergedCells.set(cellAddress(column, row), {
                rowSpan: bounds.endRow - bounds.startRow + 1,
                colSpan: bounds.endColumn - bounds.startColumn + 1,
                isAnchor:
                  row === bounds.startRow && column === bounds.startColumn,
              });
            }
          }
        }

        const rows: TableCell[][] = [];
        for (let row = 1; row <= worksheet.rowCount; row += 1) {
          const cells: TableCell[] = [];
          for (let column = 1; column <= worksheet.columnCount; column += 1) {
            const address = cellAddress(column, row);
            const merge = mergedCells.get(address);
            const cell = worksheet.getCell(row, column);
            const date = cellDate(cell);
            const text = cellText(cell, date);
            const isMergedChild = merge !== undefined && !merge.isAnchor;
            const source: SourceRef = {
              fileId: input.fileId,
              nodeId: `xlsx:${sheetIndex + 1}:r${row}:c${column}`,
              label: `${worksheet.name}!${address}`,
              sheet: worksheet.name,
              cellRange: address,
              row,
              column,
              quote: text,
            };
            const formula = cell.type === ExcelJS.ValueType.Formula
              && typeof cell.value === "object"
              && cell.value !== null
              && "formula" in cell.value
              && typeof cell.value.formula === "string"
              ? cell.value.formula
              : undefined;
            if (formula) {
              warnings.add("XLSX_FORMULA_VALUE_ONLY");
              // Nothing here calculates: an external reference is usable only
              // when Excel already stored its result in this file.
              const stored = scalarValue(cell.value);
              if (/\[[^\]]+\]/u.test(formula)) {
                warnings.add(stored === null ? "XLSX_EXTERNAL_REFERENCE_NO_CACHE" : "XLSX_EXTERNAL_REFERENCE_VALUE_ONLY");
              }
            }
            const style = isMergedChild ? undefined : styleSnapshot(cell.style);
            const tableCell: TableCell = {
              value: isMergedChild ? null : date !== undefined ? date.toISOString() : scalarValue(cell.value),
              display: isMergedChild ? "" : text,
              source,
              valueType: isMergedChild ? "blank" : cellValueType(cell, date),
              ...(formula ? { formula } : {}),
              ...(cell.numFmt ? { numberFormat: cell.numFmt } : {}),
              ...(style ? { style } : {}),
            };
            if (merge?.isAnchor) {
              tableCell.rowSpan = merge.rowSpan;
              tableCell.colSpan = merge.colSpan;
            }
            cells.push(tableCell);
          }
          rows.push(cells);
        }
        const table = { type: "table" as const, id: tableId, source: tableSource, rows };
        const autoFilter = autoFilterSnapshot(worksheet.autoFilter);
        const template: XlsxWorksheetTemplate = {
          columns: Array.from({ length: worksheet.columnCount }, (_, columnIndex) => {
            const column = worksheet.getColumn(columnIndex + 1);
            const style = styleSnapshot(column.style);
            return {
              index: columnIndex + 1,
              ...(column.width !== undefined ? { width: column.width } : {}),
              ...(column.hidden ? { hidden: true } : {}),
              ...(style ? { style } : {}),
            };
          }),
          rows: Array.from({ length: worksheet.rowCount }, (_, rowIndex) => {
            const row = worksheet.getRow(rowIndex + 1);
            return {
              number: rowIndex + 1,
              ...(row.height !== undefined ? { height: row.height } : {}),
              ...(row.hidden ? { hidden: true } : {}),
            };
          }),
          merges: [...worksheet.model.merges],
          views: Array.isArray(worksheet.views) ? snapshot(worksheet.views) as Array<Record<string, unknown>> : [],
          ...(autoFilter ? { autoFilter } : {}),
        };
        return { index: sheetIndex + 1, name: worksheet.name, visibility: worksheet.state, table, template };
      },
    );
    const blocks = workbookSheets
      .filter((sheet) => sheet.visibility === "visible")
      .map((sheet) => sheet.table);

    const media: DocumentMedia[] = [];
    for (const sheet of workbookSheets) {
      const worksheet = workbook.worksheets[sheet.index - 1];
      worksheet.getImages().forEach((placement, placementIndex) => {
        const image = workbook.getImage(Number(placement.imageId));
        if (!image?.buffer || !image.extension) return;
        const startColumn = Math.floor(placement.range.tl.nativeCol) + 1;
        const startRow = Math.floor(placement.range.tl.nativeRow) + 1;
        const bottomRight = placement.range.br;
        const endColumn = bottomRight ? Math.max(startColumn, Math.floor(bottomRight.nativeCol) + 1) : startColumn;
        const endRow = bottomRight ? Math.max(startRow, Math.floor(bottomRight.nativeRow) + 1) : startRow;
        const range = `${cellAddress(startColumn, startRow)}:${cellAddress(endColumn, endRow)}`;
        const id = `xlsx:${sheet.index}:image:${placementIndex + 1}`;
        media.push({
          id,
          kind: "image",
          mimeType: imageMimeType(image.extension),
          extension: image.extension,
          data: new Uint8Array(image.buffer),
          source: {
            fileId: input.fileId,
            nodeId: id,
            label: `${sheet.name}!${range} 이미지`,
            sheet: sheet.name,
            cellRange: range,
            row: startRow,
            column: startColumn,
            quote: "",
          },
          anchor: {
            x: placement.range.tl.col,
            y: placement.range.tl.row,
            width: bottomRight ? bottomRight.col - placement.range.tl.col : 1,
            height: bottomRight ? bottomRight.row - placement.range.tl.row : 1,
            unit: "cell",
          },
        });
      });
    }

    return {
      id: `document:${input.fileId}`,
      fileId: input.fileId,
      kind: "xlsx",
      metadata,
      blocks,
      media,
      workbookSheets,
      warnings: [...warnings],
    };
  } catch {
    throw malformedFileError();
  }
};
