import type {
  NormalizedDocument,
  SourceRef,
  TableCell,
  TableBlock,
} from "@/domain/document";
import { FORMAT_INPUT_LIMITS, StructureLimitError } from "./policy";

const MAX_ROWS = 100_000;
const MAX_COLUMNS = 1_000;
const MAX_CELL_LENGTH = 1_000_000;

const malformedFileError = (): Error =>
  new Error("파일을 읽을 수 없습니다. 지원되는 정상 파일인지 확인해 주세요.");

/** Size is admissible but the row/column/cell budget is not. */
const structureLimitError = (): Error => new StructureLimitError();

const detectDelimiter = (text: string): "," | ";" | "\t" => {
  const counts = new Map<"," | ";" | "\t", number>([[",", 0], [";", 0], ["\t", 0]]);
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && (character === "\r" || character === "\n")) {
      break;
    } else if (!quoted && counts.has(character as "," | ";" | "\t")) {
      const delimiter = character as "," | ";" | "\t";
      counts.set(delimiter, (counts.get(delimiter) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  if (ranked[0][1] > 0 && ranked[0][1] === ranked[1][1]) {
    throw new Error("CSV_DIALECT_AMBIGUOUS");
  }
  return ranked[0][1] === 0 ? "," : ranked[0][0];
};

const parseRows = (text: string, delimiter: "," | ";" | "\t"): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;

  const pushCell = (): void => {
    if (cell.length > MAX_CELL_LENGTH || row.length >= MAX_COLUMNS) {
      throw structureLimitError();
    }
    row.push(cell);
    cell = "";
    afterQuote = false;
  };
  const pushRow = (): void => {
    pushCell();
    if (rows.length >= MAX_ROWS) {
      throw structureLimitError();
    }
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        cell += character;
      }
      continue;
    }
    if (afterQuote && character !== delimiter && character !== "\n" && character !== "\r") {
      throw malformedFileError();
    }
    if (character === delimiter) {
      pushCell();
    } else if (character === "\n") {
      pushRow();
    } else if (character === "\r") {
      if (text[index + 1] !== "\n") {
        throw malformedFileError();
      }
      pushRow();
      index += 1;
    } else if (character === '"') {
      if (cell !== "") {
        throw malformedFileError();
      }
      quoted = true;
    } else {
      cell += character;
    }
  }
  if (quoted) {
    throw malformedFileError();
  }
  if (cell !== "" || row.length > 0 || text.length > 0) {
    pushRow();
  }
  return rows;
};

export const parseCsv = async (input: {
  fileId: string;
  fileName: string;
  bytes: Uint8Array;
}): Promise<NormalizedDocument> => {
  try {
    if (input.bytes.byteLength > FORMAT_INPUT_LIMITS.csv) {
      throw malformedFileError();
    }
    let text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    if (text.startsWith("\uFEFF")) {
      text = text.slice(1);
    }
    const parsedRows = parseRows(text, detectDelimiter(text));
    const tableId = "csv:table";
    const source: SourceRef = {
      fileId: input.fileId,
      nodeId: tableId,
      label: "CSV",
    };
    const rows: TableCell[][] = parsedRows.map((row, rowIndex) =>
      row.map((display, columnIndex) => {
        const rowNumber = rowIndex + 1;
        const columnNumber = columnIndex + 1;
        const nodeId = `csv:r${rowNumber}:c${columnNumber}`;
        return {
          value: display,
          display,
          source: {
            fileId: input.fileId,
            nodeId,
            label: `CSV R${rowNumber}C${columnNumber}`,
            row: rowNumber,
            column: columnNumber,
            cellRange: `R${rowNumber}C${columnNumber}`,
            quote: display,
          },
        };
      }),
    );
    const table: TableBlock = { type: "table", id: tableId, source, rows };

    return {
      id: `document:${input.fileId}`,
      fileId: input.fileId,
      kind: "csv",
      metadata: { fileName: input.fileName },
      blocks: [table],
      warnings: [],
    };
  } catch (error) {
    if (error instanceof StructureLimitError) throw error;
    if (error instanceof Error && error.message === "CSV_DIALECT_AMBIGUOUS") {
      throw new Error("CSV 구분자를 명확히 판별할 수 없습니다. CSV_DIALECT_AMBIGUOUS");
    }
    throw malformedFileError();
  }
};
