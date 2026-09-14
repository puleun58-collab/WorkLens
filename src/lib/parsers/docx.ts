import { inflateSync } from "fflate";

import { SaxesParser } from "saxes";

import type {
  DocumentBlock,
  NormalizedDocument,
  SourceRef,
  TableCell,
  TableBlock,
} from "@/domain/document";
import { FORMAT_INPUT_LIMITS } from "./policy";

const MAX_ZIP_ENTRIES = 200;
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 30 * 1024 * 1024;

const malformedFileError = (): Error =>
  new Error("파일을 읽을 수 없습니다. 지원되는 정상 파일인지 확인해 주세요.");

const readUint16 = (bytes: Uint8Array, offset: number): number => {
  if (offset < 0 || offset + 2 > bytes.byteLength) throw malformedFileError();
  return bytes[offset] | (bytes[offset + 1] << 8);
};
const readUint32 = (bytes: Uint8Array, offset: number): number => {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw malformedFileError();
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
};

const unzip = (input: Uint8Array): Map<string, Uint8Array> => {
  if (input.byteLength > FORMAT_INPUT_LIMITS.docx || input.byteLength < 22) throw malformedFileError();
  let end = -1;
  for (let offset = input.byteLength - 22; offset >= Math.max(0, input.byteLength - 65_557); offset -= 1) {
    if (readUint32(input, offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0 || readUint16(input, end + 4) !== 0 || readUint16(input, end + 6) !== 0) throw malformedFileError();
  const count = readUint16(input, end + 10);
  const centralSize = readUint32(input, end + 12);
  const centralOffset = readUint32(input, end + 16);
  if (count > MAX_ZIP_ENTRIES || centralOffset + centralSize > end) throw malformedFileError();
  const files = new Map<string, Uint8Array>();
  let offset = centralOffset;
  let totalSize = 0;
  for (let index = 0; index < count; index += 1) {
    if (readUint32(input, offset) !== 0x02014b50) throw malformedFileError();
    const flags = readUint16(input, offset + 8);
    const compression = readUint16(input, offset + 10);
    const compressedSize = readUint32(input, offset + 20);
    const uncompressedSize = readUint32(input, offset + 24);
    const nameLength = readUint16(input, offset + 28);
    const extraLength = readUint16(input, offset + 30);
    const commentLength = readUint16(input, offset + 32);
    const localOffset = readUint32(input, offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if ((flags & 1) !== 0 || compression !== 0 && compression !== 8 || uncompressedSize > MAX_ENTRY_BYTES || totalSize + uncompressedSize > MAX_TOTAL_UNCOMPRESSED_BYTES || nextOffset > centralOffset + centralSize || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw malformedFileError();
    const name = new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(offset + 46, offset + 46 + nameLength));
    if (name === "" || name.includes("\\") || name.includes("..") || files.has(name)) throw malformedFileError();
    if (readUint32(input, localOffset) !== 0x04034b50) throw malformedFileError();
    const localNameLength = readUint16(input, localOffset + 26);
    const localExtraLength = readUint16(input, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > input.byteLength) throw malformedFileError();
    const compressed = input.subarray(dataOffset, dataOffset + compressedSize);
    const content = compression === 0 ? compressed : inflateSync(compressed, { out: new Uint8Array(uncompressedSize) });
    if (content.byteLength !== uncompressedSize) throw malformedFileError();
    totalSize += uncompressedSize;
    files.set(name, content);
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize) throw malformedFileError();
  return files;
};

export const parseDocx = async (input: {
  fileId: string;
  fileName: string;
  bytes: Uint8Array;
}): Promise<NormalizedDocument> => {
  try {
    const files = unzip(input.bytes);
    const documentXml = files.get("word/document.xml");
    if (documentXml === undefined) throw malformedFileError();
    const warnings = new Set<string>();
    for (const name of files.keys()) {
      if (name.startsWith("word/media/")) warnings.add("DOCX_IMAGE_OMITTED");
      else if (name.startsWith("word/charts/")) warnings.add("DOCX_CHART_OMITTED");
    }
    const partContent = (bytes: Uint8Array, root: "document" | "hdr" | "ftr"): string => {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const match = new RegExp(`<w:${root}\\b[^>]*>([\\s\\S]*)<\\/w:${root}>\\s*$`).exec(content);
      if (match === null) {
        if (new RegExp(`<w:${root}\\b[^>]*/>\\s*$`).test(content)) return "";
        throw malformedFileError();
      }
      return match[1];
    };
    const parts: Array<{ kind: "body" | "header" | "footer"; content: string }> = [
      { kind: "body", content: partContent(documentXml, "document") },
    ];
    for (const [name, bytes] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const kind = /^word\/header\d+\.xml$/.test(name)
        ? "header"
        : /^word\/footer\d+\.xml$/.test(name) ? "footer" : undefined;
      if (kind === undefined) continue;
      try {
        parts.push({ kind, content: partContent(bytes, kind === "header" ? "hdr" : "ftr") });
      } catch {
        warnings.add("DOCX_HEADER_FOOTER_OMITTED");
      }
    }
    const blocks: DocumentBlock[] = [];
    const parser = new SaxesParser({ xmlns: false });
    let failure: Error | undefined;
    let tableDepth = 0;
    let currentPart: "body" | "header" | "footer" = "body";
    const partBlockCount = new Map<"body" | "header" | "footer", number>([
      ["body", 0],
      ["header", 0],
      ["footer", 0],
    ]);
    let paragraphIndex = 0;
    let tableIndex = 0;
    let currentParagraph: { text: string; topLevel: boolean; headingLevel?: number } | undefined;
    let currentTable: { id: string; source: SourceRef; rows: TableCell[][] } | undefined;
    let currentRow: TableCell[] | undefined;
    let currentCell: { text: string; column: number; gridSpan?: number; vMerge?: "restart" | "continue" } | undefined;
    let rowColumnCursor = 1;
    let openVerticalMerges = new Map<number, TableCell>();
    let touchedColumns = new Set<number>();
    let textDepth = 0;
    parser.on("error", (error) => { failure = error; });
    parser.on("opentag", (tag) => {
      if (tag.name === "part") {
        const raw = tag.attributes.kind;
        const part = typeof raw === "string" ? raw : String(raw ?? "");
        if (part !== "body" && part !== "header" && part !== "footer") throw malformedFileError();
        currentPart = part;
      } else if (tag.name === "w:tbl") {
        tableDepth += 1;
        if (tableDepth > 1) warnings.add("DOCX_NESTED_TABLE_OMITTED");
        if (tableDepth === 1) {
          tableIndex += 1;
          const id = `docx:table:${tableIndex}`;
          const block = (partBlockCount.get(currentPart) ?? 0) + 1;
          partBlockCount.set(currentPart, block);
          currentTable = {
            id,
            source: {
              fileId: input.fileId,
              nodeId: id,
              label: `표 ${tableIndex}`,
              locator: { kind: "docx", part: currentPart, block },
            },
            rows: [],
          };
          openVerticalMerges = new Map<number, TableCell>();
        }
      } else if (tag.name === "w:tr" && tableDepth === 1) {
        currentRow = [];
        rowColumnCursor = 1;
        touchedColumns = new Set<number>();
      } else if (tag.name === "w:tc" && tableDepth === 1 && currentRow !== undefined) {
        currentCell = { text: "", column: rowColumnCursor };
      } else if (tag.name === "w:gridSpan" && tableDepth === 1 && currentCell !== undefined) {
        const raw = tag.attributes["w:val"];
        const value = Number(typeof raw === "string" ? raw : String(raw ?? ""));
        if (Number.isInteger(value) && value > 0) currentCell.gridSpan = value;
      } else if (tag.name === "w:vMerge" && tableDepth === 1 && currentCell !== undefined) {
        const raw = tag.attributes["w:val"];
        const value = typeof raw === "string" ? raw : raw === undefined ? "continue" : String(raw);
        currentCell.vMerge = value === "restart" ? "restart" : "continue";
      } else if (tag.name === "w:p" && tableDepth <= 1) {
        currentParagraph = { text: "", topLevel: tableDepth === 0 };
      } else if (tag.name === "w:pStyle" && currentParagraph !== undefined) {
        const raw = tag.attributes["w:val"];
        const style = typeof raw === "string" ? raw : String(raw ?? "");
        const heading = /^Heading([1-9])$/i.exec(style ?? "");
        if (heading) currentParagraph.headingLevel = Number(heading[1]);
      } else if (tag.name === "w:t" && currentParagraph !== undefined) {
        textDepth += 1;
      }
    });
    parser.on("text", (text) => {
      if (textDepth > 0 && currentParagraph !== undefined) currentParagraph.text += text;
    });
    parser.on("cdata", (text) => {
      if (textDepth > 0 && currentParagraph !== undefined) currentParagraph.text += text;
    });
    parser.on("closetag", (tag) => {
      if (tag.name === "w:t" && textDepth > 0) textDepth -= 1;
      else if (tag.name === "w:p" && currentParagraph !== undefined) {
        const paragraph = currentParagraph;
        currentParagraph = undefined;
        if (currentCell !== undefined) currentCell.text += `${currentCell.text === "" ? "" : "\n"}${paragraph.text}`;
        else if (paragraph.topLevel && paragraph.text !== "") {
          paragraphIndex += 1;
          const block = (partBlockCount.get(currentPart) ?? 0) + 1;
          partBlockCount.set(currentPart, block);
          const id = `docx:paragraph:${paragraphIndex}`;
          blocks.push({
            type: "paragraph",
            id,
            text: paragraph.text,
            role: paragraph.headingLevel ? "heading" : "paragraph",
            ...(paragraph.headingLevel ? { headingLevel: paragraph.headingLevel } : {}),
            source: {
              fileId: input.fileId,
              nodeId: id,
              label: `문단 ${paragraphIndex}`,
              locator: { kind: "docx", part: currentPart, block },
              quote: paragraph.text,
            },
          });
        }
      } else if (tag.name === "w:tc" && tableDepth === 1 && currentCell !== undefined && currentRow !== undefined && currentTable !== undefined) {
        const row = currentTable.rows.length + 1;
        const column = currentCell.column;
        const colSpan = currentCell.gridSpan !== undefined && currentCell.gridSpan > 0 ? currentCell.gridSpan : 1;
        const isContinuation = currentCell.vMerge === "continue";
        const id = `${currentTable.id}:r${row}:c${column}`;
        const anchor = isContinuation ? openVerticalMerges.get(column) : undefined;
        if (isContinuation) {
          if (anchor !== undefined) anchor.rowSpan = (anchor.rowSpan ?? 1) + 1;
        }
        const cell: TableCell = {
          value: isContinuation ? null : currentCell.text,
          display: isContinuation ? "" : currentCell.text,
          source: {
            fileId: input.fileId,
            nodeId: id,
            label: `표 ${tableIndex} 행 ${row} 열 ${column}`,
            row,
            column,
            cellRange: `R${row}C${column}`,
            locator: {
              kind: "docx",
              part: currentPart,
              block: currentTable.source.locator?.kind === "docx" ? currentTable.source.locator.block : 1,
              tableCell: {
                row,
                column,
                ...(anchor === undefined ? {} : { anchorCellId: anchor.source.nodeId }),
              },
            },
            quote: currentCell.text,
          },
        };
        if (!isContinuation && colSpan > 1) cell.colSpan = colSpan;
        currentRow.push(cell);
        for (let c = column; c < column + colSpan; c += 1) {
          touchedColumns.add(c);
          if (isContinuation) continue;
          if (currentCell.vMerge === "restart") openVerticalMerges.set(c, cell);
          else openVerticalMerges.delete(c);
        }
        rowColumnCursor = column + colSpan;
        currentCell = undefined;
      } else if (tag.name === "w:tr" && tableDepth === 1 && currentRow !== undefined && currentTable !== undefined) {
        for (const column of [...openVerticalMerges.keys()]) {
          if (!touchedColumns.has(column)) openVerticalMerges.delete(column);
        }
        currentTable.rows.push(currentRow);
        currentRow = undefined;
      } else if (tag.name === "w:tbl") {
        if (tableDepth === 1 && currentTable !== undefined) {
          blocks.push({ type: "table", id: currentTable.id, source: currentTable.source, rows: currentTable.rows } as TableBlock);
          currentTable = undefined;
        }
        tableDepth -= 1;
      }
    });
    parser.write(`<root>${parts.map((part) => `<part kind="${part.kind}">${part.content}</part>`).join("")}</root>`).close();
    if (failure !== undefined || tableDepth !== 0 || currentParagraph !== undefined) throw malformedFileError();
    return { id: `document:${input.fileId}`, fileId: input.fileId, kind: "docx", metadata: { fileName: input.fileName }, blocks, warnings: [...warnings] };
  } catch {
    throw malformedFileError();
  }
};
