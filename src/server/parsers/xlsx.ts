import ExcelJS from "exceljs";

import type {
  DocumentMetadata,
  NormalizedDocument,
  SourceRef,
  TableCell,
  TableBlock,
} from "@/domain/document";

const malformedFileError = (): Error =>
  new Error("파일을 읽을 수 없습니다. 지원되는 정상 파일인지 확인해 주세요.");

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

export const parseXlsx = async (input: {
  fileId: string;
  fileName: string;
  bytes: Uint8Array;
}): Promise<NormalizedDocument> => {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(input.bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0]);

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

    const blocks: TableBlock[] = workbook.worksheets
      .filter((worksheet) => worksheet.state !== "hidden" && worksheet.state !== "veryHidden")
      .map(
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
            const source: SourceRef = {
              fileId: input.fileId,
              nodeId: `xlsx:${sheetIndex + 1}:r${row}:c${column}`,
              label: `${worksheet.name}!${address}`,
              sheet: worksheet.name,
              cellRange: address,
              row,
              column,
              quote: cell.text,
            };
            const isMergedChild = merge !== undefined && !merge.isAnchor;
            if (cell.type === ExcelJS.ValueType.Formula) warnings.add("XLSX_FORMULA_VALUE_ONLY");
            const tableCell: TableCell = {
              value: isMergedChild ? null : scalarValue(cell.value),
              display: isMergedChild ? "" : cell.text,
              source,
            };
            if (merge?.isAnchor) {
              tableCell.rowSpan = merge.rowSpan;
              tableCell.colSpan = merge.colSpan;
            }
            cells.push(tableCell);
          }
          rows.push(cells);
        }
        return { type: "table", id: tableId, source: tableSource, rows };
      },
    );

    return {
      id: `document:${input.fileId}`,
      fileId: input.fileId,
      kind: "xlsx",
      metadata,
      blocks,
      warnings: [...warnings],
    };
  } catch {
    throw malformedFileError();
  }
};
