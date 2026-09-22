import ExcelJS from "exceljs";

import type {
  DocumentMedia,
  DocumentMetadata,
  NormalizedDocument,
  SourceRef,
  TableCell,
  WorkbookSheet,
} from "@/domain/document";

import { DocumentError } from "@/lib/upload";

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
  if (
    typeof value === "object" &&
    value !== null &&
    "result" in value
  ) {
    return scalarValue(value.result);
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

const cellValueType = (cell: ExcelJS.Cell): TableCell["valueType"] => {
  if (cell.type === ExcelJS.ValueType.Formula) return "formula";
  if (cell.value instanceof Date) return "date";
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

const cellText = (cell: ExcelJS.Cell): string =>
  cell.type === ExcelJS.ValueType.Date && cell.value instanceof Date ? formatCellDate(cell.value) : cell.text;

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
            const text = cellText(cell);
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
            const tableCell: TableCell = {
              value: isMergedChild ? null : scalarValue(cell.value),
              display: isMergedChild ? "" : text,
              source,
              valueType: isMergedChild ? "blank" : cellValueType(cell),
              ...(formula ? { formula } : {}),
              ...(cell.numFmt ? { numberFormat: cell.numFmt } : {}),
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
        return { index: sheetIndex + 1, name: worksheet.name, visibility: worksheet.state, table };
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
            x: placement.range.tl.nativeCol,
            y: placement.range.tl.nativeRow,
            width: bottomRight ? bottomRight.nativeCol - placement.range.tl.nativeCol : 1,
            height: bottomRight ? bottomRight.nativeRow - placement.range.tl.nativeRow : 1,
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
