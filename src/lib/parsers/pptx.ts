import { SaxesParser } from "saxes";

import { unzipOoxml } from "./ooxml-zip";

import type {
  DocumentBlock,
  DocumentMedia,
  NormalizedDocument,
  SourceRef,
  TableCell,
  TableBlock,
} from "@/domain/document";
import { FORMAT_INPUT_LIMITS, StructureLimitError } from "./policy";

import { DocumentError } from "@/lib/upload";


const malformedFileError = (): Error =>
  new DocumentError("DOCUMENT_UNREADABLE", "파일을 읽지 못했습니다.", "지원되는 PowerPoint 파일인지 확인한 뒤 다시 시도해 주세요.");

const structureLimitError = (): Error => new StructureLimitError();

const unzip = (input: Uint8Array): Map<string, Uint8Array> => unzipOoxml(input, {
  maxInputBytes: FORMAT_INPUT_LIMITS.pptx,
  keepOtherParts: false,
  malformed: malformedFileError,
  limitExceeded: structureLimitError,
});

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

const mediaMimeType = (extension: string): string => {
  switch (extension.toLowerCase()) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "svg": return "image/svg+xml";
    case "emf": return "image/x-emf";
    case "wmf": return "image/x-wmf";
    default: return "application/octet-stream";
  }
};

function slideMedia(
  input: { fileId: string; slide: number; path: string; xml: string },
  files: Map<string, Uint8Array>,
): DocumentMedia[] {
  const fileName = input.path.slice(input.path.lastIndexOf("/") + 1);
  const relationships = files.get(`ppt/slides/_rels/${fileName}.rels`);
  if (!relationships) return [];
  const targets = new Map<string, string>();
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    if (tag.name !== "Relationship" || !attribute(tag, "Type")?.endsWith("/image")) return;
    const id = attribute(tag, "Id");
    const target = attribute(tag, "Target");
    if (!id || !target || !target.startsWith("../media/") || target.includes("..", 3)) return;
    targets.set(id, `ppt/media/${target.slice("../media/".length)}`);
  });
  parser.write(xml(relationships)).close();

  const media: DocumentMedia[] = [];
  const pictures = input.xml.matchAll(/<p:pic>[\s\S]*?<p:cNvPr[^>]*name="([^"]*)"[\s\S]*?<a:blip[^>]*r:embed="([^"]+)"[\s\S]*?<a:xfrm>[\s\S]*?<a:off[^>]*x="(\d+)"[^>]*y="(\d+)"[\s\S]*?<a:ext[^>]*cx="(\d+)"[^>]*cy="(\d+)"[\s\S]*?<\/p:pic>/gu);
  for (const [index, match] of [...pictures].entries()) {
    const path = targets.get(match[2]);
    const data = path ? files.get(path) : undefined;
    if (!path || !data?.byteLength) continue;
    const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    const id = `pptx:s${input.slide}:image:${index + 1}`;
    media.push({
      id,
      kind: "image",
      mimeType: mediaMimeType(extension),
      extension,
      data,
      source: {
        fileId: input.fileId,
        nodeId: id,
        label: `슬라이드 ${input.slide} · ${match[1] || `이미지 ${index + 1}`}`,
        page: input.slide,
        locator: { kind: "pptx", slide: input.slide, shape: 1000 + index },
        quote: "",
      },
      anchor: {
        x: Number(match[3]),
        y: Number(match[4]),
        width: Number(match[5]),
        height: Number(match[6]),
        unit: "emu",
      },
    });
  }
  return media;
}

export const parsePptx = async (input: { fileId: string; fileName: string; bytes: Uint8Array }): Promise<NormalizedDocument> => {
  try {
    const files = unzip(input.bytes);
    const paths = slidePaths(files);
    const blocks = paths.flatMap((path, index) => parseSlide({ fileId: input.fileId, slide: index + 1, xml: xml(files.get(path)!) }));
    const media = paths.flatMap((path, index) =>
      slideMedia({ fileId: input.fileId, slide: index + 1, path, xml: xml(files.get(path)!) }, files));
    const warnings = new Set<string>();
    const archivedImageCount = [...files.keys()].filter((name) => name.startsWith("ppt/media/")).length;
    if (archivedImageCount > media.length) warnings.add("PPTX_IMAGE_OMITTED");
    for (const name of files.keys()) {
      if (name.startsWith("ppt/charts/")) warnings.add("PPTX_CHART_OMITTED");
      else if (name.startsWith("ppt/notesSlides/")) warnings.add("PPTX_SPEAKER_NOTES_OMITTED");
    }
    return { id: `document:${input.fileId}`, fileId: input.fileId, kind: "pptx", metadata: { fileName: input.fileName, pageCount: paths.length }, blocks, media, warnings: [...warnings] };
  } catch (error) {
    if (error instanceof StructureLimitError) throw error;
    throw malformedFileError();
  }
};
