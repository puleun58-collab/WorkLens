import { inflateSync } from "fflate";

import { SaxesParser } from "saxes";

import type {
  DocumentBlock,
  NormalizedDocument,
  SourceRef,
  TableCell,
  TableBlock,
} from "@/domain/document";
import { FORMAT_INPUT_LIMITS, StructureLimitError } from "./policy";

/**
 * Structural limits bound expansion work, not file size: only XML parts are
 * inflated and counted, so a 100 MiB media-heavy deck stays admissible while
 * zip-bomb defence is unchanged.
 */
const MAX_ZIP_ENTRIES = 2_000;
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 30 * 1024 * 1024;
const isReadablePart = (name: string): boolean => name.endsWith(".xml") || name.endsWith(".rels");

const malformedFileError = (): Error =>
  new Error("파일을 읽을 수 없습니다. 지원되는 정상 파일인지 확인해 주세요.");

const structureLimitError = (): Error => new StructureLimitError();

const uint16 = (bytes: Uint8Array, offset: number): number => {
  if (offset < 0 || offset + 2 > bytes.byteLength) throw malformedFileError();
  return bytes[offset] | (bytes[offset + 1] << 8);
};
const uint32 = (bytes: Uint8Array, offset: number): number => {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw malformedFileError();
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
};

const unzip = (input: Uint8Array): Map<string, Uint8Array> => {
  if (input.byteLength > FORMAT_INPUT_LIMITS.pptx || input.byteLength < 22) throw malformedFileError();
  let end = -1;
  for (let offset = input.byteLength - 22; offset >= Math.max(0, input.byteLength - 65_557); offset -= 1) {
    if (uint32(input, offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0 || uint16(input, end + 4) !== 0 || uint16(input, end + 6) !== 0) throw malformedFileError();
  const count = uint16(input, end + 10);
  const centralSize = uint32(input, end + 12);
  const centralOffset = uint32(input, end + 16);
  if (count > MAX_ZIP_ENTRIES) throw structureLimitError();
  if (centralOffset + centralSize > end) throw malformedFileError();
  const files = new Map<string, Uint8Array>();
  let offset = centralOffset;
  let totalSize = 0;
  for (let index = 0; index < count; index += 1) {
    if (uint32(input, offset) !== 0x02014b50) throw malformedFileError();
    const flags = uint16(input, offset + 8);
    const compression = uint16(input, offset + 10);
    const compressedSize = uint32(input, offset + 20);
    const uncompressedSize = uint32(input, offset + 24);
    const nameLength = uint16(input, offset + 28);
    const extraLength = uint16(input, offset + 30);
    const commentLength = uint16(input, offset + 32);
    const localOffset = uint32(input, offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if ((flags & 1) !== 0 || compression !== 0 && compression !== 8 || nextOffset > centralOffset + centralSize || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw malformedFileError();
    const name = new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(offset + 46, offset + 46 + nameLength));
    if (name === "" || name.includes("\\") || name.includes("..") || files.has(name)) throw malformedFileError();
    if (uint32(input, localOffset) !== 0x04034b50) throw malformedFileError();
    const dataOffset = localOffset + 30 + uint16(input, localOffset + 26) + uint16(input, localOffset + 28);
    if (dataOffset + compressedSize > input.byteLength) throw malformedFileError();
    // Slide media is never read, so it is walked past instead of inflated: a
    // picture-heavy deck costs no expansion budget.
    if (isReadablePart(name)) {
      if (uncompressedSize > MAX_ENTRY_BYTES || totalSize + uncompressedSize > MAX_TOTAL_UNCOMPRESSED_BYTES) throw structureLimitError();
      const compressed = input.subarray(dataOffset, dataOffset + compressedSize);
      const content = compression === 0 ? compressed : inflateSync(compressed, { out: new Uint8Array(uncompressedSize) });
      if (content.byteLength !== uncompressedSize) throw malformedFileError();
      totalSize += uncompressedSize;
      files.set(name, content);
    } else {
      files.set(name, new Uint8Array(0));
    }
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize) throw malformedFileError();
  return files;
};

const xml = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const attribute = (tag: { attributes: Record<string, string> | Record<string, { value: string }> }, name: string): string | undefined => {
  const value = tag.attributes[name];
  return typeof value === "string" ? value : value?.value;
};

const slidePaths = (files: Map<string, Uint8Array>): string[] => {
  const relationships = files.get("ppt/_rels/presentation.xml.rels");
  const presentation = files.get("ppt/presentation.xml");
  if (relationships === undefined || presentation === undefined) throw malformedFileError();
  const relationTargets = new Map<string, string>();
  const relationParser = new SaxesParser({ xmlns: false });
  let failure: Error | undefined;
  relationParser.on("error", (error) => { failure = error; });
  relationParser.on("opentag", (tag) => {
    if (tag.name === "Relationship" && attribute(tag, "Type")?.endsWith("/slide") === true) {
      const id = attribute(tag, "Id");
      const target = attribute(tag, "Target");
      if (id === undefined || target === undefined || !target.startsWith("slides/") || target.includes("..") || relationTargets.has(id)) throw malformedFileError();
      relationTargets.set(id, `ppt/${target}`);
    }
  });
  relationParser.write(xml(relationships)).close();
  if (failure !== undefined) throw malformedFileError();
  const paths: string[] = [];
  const presentationParser = new SaxesParser({ xmlns: false });
  failure = undefined;
  presentationParser.on("error", (error) => { failure = error; });
  presentationParser.on("opentag", (tag) => {
    if (tag.name === "p:sldId") {
      const id = attribute(tag, "r:id");
      const path = id === undefined ? undefined : relationTargets.get(id);
      if (path === undefined || files.get(path) === undefined) throw malformedFileError();
      paths.push(path);
    }
  });
  presentationParser.write(xml(presentation)).close();
  if (failure !== undefined || paths.length === 0 || new Set(paths).size !== paths.length) throw malformedFileError();
  return paths;
};

const parseSlide = (input: { fileId: string; slide: number; xml: string }): DocumentBlock[] => {
  const blocks: DocumentBlock[] = [];
  const parser = new SaxesParser({ xmlns: false });
  let failure: Error | undefined;
  let textDepth = 0;
  let paragraphIndex = 0;
  let shapeOrdinal = 0;
  let currentShape: number | undefined;
  let currentShapeRole: "heading" | undefined;
  let tableIndex = 0;
  let tableDepth = 0;
  let currentParagraph: string | undefined;
  let currentTable: { id: string; source: SourceRef; rows: TableCell[][] } | undefined;
  let currentRow: TableCell[] | undefined;
  let currentCell: { text: string; column: number; gridSpan?: number; hMerge: boolean; vMerge: boolean } | undefined;
  let openVerticalMerges = new Map<number, TableCell>();
  let incrementedAnchorsThisRow = new Set<TableCell>();
  parser.on("error", (error) => { failure = error; });
  parser.on("opentag", (tag) => {
    if (tag.name === "p:sp" || tag.name === "p:graphicFrame") {
      shapeOrdinal += 1;
      currentShape = shapeOrdinal;
      currentShapeRole = undefined;
    } else if (
      tag.name === "p:ph"
      && (attribute(tag, "type") === "title" || attribute(tag, "type") === "ctrTitle")
    ) {
      currentShapeRole = "heading";
    }
    if (tag.name === "a:tbl") {
      tableDepth += 1;
      if (tableDepth === 1) {
        tableIndex += 1;
        const id = `pptx:s${input.slide}:table:${tableIndex}`;
        if (currentShape === undefined) {
          shapeOrdinal += 1;
          currentShape = shapeOrdinal;
        }
        currentTable = {
          id,
          source: {
            fileId: input.fileId,
            nodeId: id,
            label: `슬라이드 ${input.slide} 표 ${tableIndex}`,
            page: input.slide,
            locator: { kind: "pptx", slide: input.slide, shape: currentShape },
          },
          rows: [],
        };
        openVerticalMerges = new Map<number, TableCell>();
      }
    } else if (tag.name === "a:tr" && tableDepth === 1) {
      currentRow = [];
      incrementedAnchorsThisRow = new Set<TableCell>();
    } else if (tag.name === "a:tc" && tableDepth === 1 && currentRow !== undefined) {
      const gridSpanRaw = attribute(tag, "gridSpan");
      const gridSpan = gridSpanRaw === undefined ? undefined : Number(gridSpanRaw);
      const hMergeRaw = attribute(tag, "hMerge");
      const vMergeRaw = attribute(tag, "vMerge");
      currentCell = {
        text: "",
        column: currentRow.length + 1,
        gridSpan: Number.isInteger(gridSpan) && gridSpan! > 0 ? gridSpan : undefined,
        hMerge: hMergeRaw !== undefined && hMergeRaw !== "0" && hMergeRaw !== "false",
        vMerge: vMergeRaw !== undefined && vMergeRaw !== "0" && vMergeRaw !== "false",
      };
    }
    else if (tag.name === "a:p") currentParagraph = "";
    else if (tag.name === "a:t" && currentParagraph !== undefined) textDepth += 1;
  });
  parser.on("text", (text) => { if (textDepth > 0 && currentParagraph !== undefined) currentParagraph += text; });
  parser.on("cdata", (text) => { if (textDepth > 0 && currentParagraph !== undefined) currentParagraph += text; });
  parser.on("closetag", (tag) => {
    if (tag.name === "a:t" && textDepth > 0) textDepth -= 1;
    else if (tag.name === "a:p" && currentParagraph !== undefined) {
      const text = currentParagraph;
      currentParagraph = undefined;
      if (currentCell !== undefined) currentCell.text += `${currentCell.text === "" ? "" : "\n"}${text}`;
      else if (tableDepth === 0 && text !== "") {
        paragraphIndex += 1;
        if (currentShape === undefined) {
          shapeOrdinal += 1;
          currentShape = shapeOrdinal;
        }
        const id = `pptx:s${input.slide}:text:${paragraphIndex}`;
        blocks.push({
          type: "paragraph",
          id,
          text,
          ...(currentShapeRole ? { role: currentShapeRole, headingLevel: 1 } : {}),
          source: {
            fileId: input.fileId,
            nodeId: id,
            label: `슬라이드 ${input.slide}`,
            page: input.slide,
            locator: { kind: "pptx", slide: input.slide, shape: currentShape },
            quote: text,
          },
        });
      }
    } else if (tag.name === "a:tc" && currentCell !== undefined && currentRow !== undefined && currentTable !== undefined) {
      const row = currentTable.rows.length + 1;
      const column = currentCell.column;
      const colSpan = currentCell.gridSpan ?? 1;
      const isContinuation = currentCell.hMerge || currentCell.vMerge;
      const id = `${currentTable.id}:r${row}:c${column}`;
      const anchor = currentCell.vMerge
        ? openVerticalMerges.get(column)
        : currentCell.hMerge ? currentRow[currentRow.length - 1] : undefined;
      if (currentCell.vMerge) {
        if (anchor !== undefined && !incrementedAnchorsThisRow.has(anchor)) {
          anchor.rowSpan = (anchor.rowSpan ?? 1) + 1;
          incrementedAnchorsThisRow.add(anchor);
        }
      }
      const cell: TableCell = {
        value: isContinuation ? null : currentCell.text,
        display: isContinuation ? "" : currentCell.text,
        source: {
          fileId: input.fileId,
          nodeId: id,
          label: `슬라이드 ${input.slide} 표 ${tableIndex} 행 ${row} 열 ${column}`,
          page: input.slide,
          row,
          column,
          cellRange: `R${row}C${column}`,
          locator: {
            kind: "pptx",
            slide: input.slide,
            shape: currentTable.source.locator?.kind === "pptx" ? currentTable.source.locator.shape : 1,
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
      if (!currentCell.hMerge && !currentCell.vMerge) {
        for (let c = column; c < column + colSpan; c += 1) openVerticalMerges.set(c, cell);
      }
      currentCell = undefined;
    } else if (tag.name === "a:tr" && currentRow !== undefined && currentTable !== undefined) {
      currentTable.rows.push(currentRow);
      currentRow = undefined;
    } else if (tag.name === "a:tbl") {
      if (tableDepth === 1 && currentTable !== undefined) {
        blocks.push({ type: "table", id: currentTable.id, source: currentTable.source, rows: currentTable.rows } as TableBlock);
        currentTable = undefined;
      }
      tableDepth -= 1;
    } else if (tag.name === "p:sp" || tag.name === "p:graphicFrame") {
      currentShape = undefined;
    }
  });
  parser.write(input.xml).close();
  if (failure !== undefined || tableDepth !== 0 || currentParagraph !== undefined) throw malformedFileError();
  return blocks;
};

export const parsePptx = async (input: { fileId: string; fileName: string; bytes: Uint8Array }): Promise<NormalizedDocument> => {
  try {
    const files = unzip(input.bytes);
    const paths = slidePaths(files);
    const blocks = paths.flatMap((path, index) => parseSlide({ fileId: input.fileId, slide: index + 1, xml: xml(files.get(path)!) }));
    const warnings = new Set<string>();
    for (const name of files.keys()) {
      if (name.startsWith("ppt/media/")) warnings.add("PPTX_IMAGE_OMITTED");
      else if (name.startsWith("ppt/charts/")) warnings.add("PPTX_CHART_OMITTED");
      else if (name.startsWith("ppt/notesSlides/")) warnings.add("PPTX_SPEAKER_NOTES_OMITTED");
    }
    return { id: `document:${input.fileId}`, fileId: input.fileId, kind: "pptx", metadata: { fileName: input.fileName, pageCount: paths.length }, blocks, warnings: [...warnings] };
  } catch (error) {
    if (error instanceof StructureLimitError) throw error;
    throw malformedFileError();
  }
};
