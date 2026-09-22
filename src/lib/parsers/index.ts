import { sha256Hex } from "@/domain/hash";
import type { NormalizedDocument, SourceLocator, SourceRef } from "@/domain/document";

import { parseCsv } from "./csv";
import { parseDocx } from "./docx";
import { parsePdf } from "./pdf";
import { parsePptx } from "./pptx";
import { parseXlsx } from "./xlsx";
import { DocumentError } from "@/lib/upload";

export interface ParseDocumentInput {
  fileId: string;
  fileName: string;
  bytes: Uint8Array;
}

const PARSER_REVISION = "worklens-parser-v2";
const unsupportedFileError = (): Error =>
  new DocumentError(
    "FILE_TYPE_UNSUPPORTED",
    "현재 이 파일 형식은 지원하지 않습니다.",
    "CSV, DOCX, PPTX, XLSX 또는 PDF 형식으로 저장한 뒤 다시 업로드해 주세요.",
  );

export const parseDocument = async (input: ParseDocumentInput): Promise<NormalizedDocument> => {
  const extension = input.fileName.slice(input.fileName.lastIndexOf(".")).toLowerCase();
  // pdfjs (and potentially other parsers) transfers ownership of the input
  // buffer, zeroing its contents after parse. Compute the content hash before
  // any parser touches the bytes.
  const contentHash = sha256Hex(input.bytes);
  let document: NormalizedDocument;
  // A macro-enabled workbook is the same OOXML package; the macro part is
  // never read, so the ordinary workbook parser applies.
  if (extension === ".xlsx" || extension === ".xlsm") document = await parseXlsx(input);
  else if (extension === ".csv") document = await parseCsv(input);
  else if (extension === ".docx") document = await parseDocx(input);
  else if (extension === ".pptx") document = await parsePptx(input);
  else if (extension === ".pdf") document = await parsePdf(input);
  else throw unsupportedFileError();
  return addCanonicalProvenance(document, contentHash);
};

function addCanonicalProvenance(document: NormalizedDocument, contentHash: string): NormalizedDocument {
  const version = sha256Hex(`${PARSER_REVISION}\0${contentHash}`);
  const warnings = new Set(document.warnings);
  const canonicalNodeId = (structuralPath: string): string =>
    sha256Hex(`${version}\0${PARSER_REVISION}\0${structuralPath}`);
  const canonicalIds = new Map<string, string>();
  document.blocks.forEach((block, blockIndex) => {
    const blockPath = `block/${blockIndex + 1}`;
    canonicalIds.set(block.source.nodeId, canonicalNodeId(`${blockPath}/${block.type}`));
    if (block.type === "table") {
      block.rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
        canonicalIds.set(
          cell.source.nodeId,
          canonicalNodeId(`${blockPath}/table/cell/${rowIndex + 1}/${columnIndex + 1}`),
        );
      }));
    }
  });
  const locatorFor = (source: SourceRef): SourceLocator => {
    if (source.locator !== undefined) {
      const locator = source.locator;
      if (
        (locator.kind === "docx" || locator.kind === "pptx") &&
        locator.tableCell?.anchorCellId !== undefined
      ) {
        const anchorCellId = canonicalIds.get(locator.tableCell.anchorCellId);
        if (anchorCellId === undefined) {
          warnings.add("MERGED_CELL_ANCHOR_DEGRADED");
          const tableCell = { ...locator.tableCell };
          delete tableCell.anchorCellId;
          return { ...locator, tableCell };
        }
        return {
          ...locator,
          tableCell: { ...locator.tableCell, anchorCellId },
        };
      }
      return locator;
    }
    if (document.kind === "csv") {
      const record = source.row ?? 1;
      const column = source.column ?? 1;
      if (source.row === undefined || source.column === undefined) {
        warnings.add("CSV_LOCATOR_DEGRADED_TO_FIRST_CELL");
      }
      return { kind: "csv", record, column };
    }
    if (document.kind === "xlsx") {
      const sheet = source.sheet ?? "";
      const range = source.cellRange ?? "";
      if (sheet === "" || range === "") warnings.add("XLSX_LOCATOR_DEGRADED");
      return { kind: "xlsx", sheet, range };
    }
    throw new Error("Parser emitted a source without a canonical locator.");
  };
  const enrich = (source: SourceRef, structuralPath: string, exactQuote?: string): SourceRef => {
    const quote = exactQuote ?? source.quote ?? "";
    if (source.quote === undefined && exactQuote === undefined) {
      warnings.add("SOURCE_QUOTE_DEGRADED_EMPTY");
    }
    return {
      ...source,
      documentId: document.id,
      documentVersion: version,
      nodeId: canonicalNodeId(structuralPath),
      locator: locatorFor(source),
      quote,
      quoteHash: sha256Hex(quote),
    };
  };
  const canonicalBlocks = document.blocks.map((block, blockIndex) => {
    if (block.type === "paragraph") {
      const source = enrich(block.source, `block/${blockIndex + 1}/paragraph`, block.text);
      return { ...block, id: source.nodeId, source };
    }
    const source = enrich(
      block.source,
      `block/${blockIndex + 1}/table`,
      block.rows.map((row) => row.map((cell) => cell.display).join("\t")).join("\n"),
    );
    return {
      ...block,
      id: source.nodeId,
      source,
      rows: block.rows.map((row, rowIndex) => row.map((cell, columnIndex) => ({
        ...cell,
        source: enrich(
          cell.source,
          `block/${blockIndex + 1}/table/cell/${rowIndex + 1}/${columnIndex + 1}`,
          cell.display,
        ),
      }))),
    };
  });
  const workbookSheets = document.workbookSheets?.map((sheet) => {
    const visible = canonicalBlocks.find((block) => block.type === "table" && block.source.sheet === sheet.name);
    if (visible?.type === "table") return { ...sheet, table: visible };
    const base = `workbook/sheet/${sheet.index}`;
    const source = enrich(
      sheet.table.source,
      `${base}/table`,
      sheet.table.rows.map((row) => row.map((cell) => cell.display).join("\t")).join("\n"),
    );
    return {
      ...sheet,
      table: {
        ...sheet.table,
        id: source.nodeId,
        source,
        rows: sheet.table.rows.map((row, rowIndex) => row.map((cell, columnIndex) => ({
          ...cell,
          source: enrich(cell.source, `${base}/table/cell/${rowIndex + 1}/${columnIndex + 1}`, cell.display),
        }))),
      },
    };
  });
  return {
    ...document,
    version,
    parserRevision: PARSER_REVISION,
    blocks: canonicalBlocks,
    ...(workbookSheets ? { workbookSheets } : {}),
    ...(document.media ? {
      media: document.media.map((media, index) => ({
        ...media,
        id: canonicalNodeId(`media/${index + 1}`),
        source: enrich(media.source, `media/${index + 1}`, media.source.quote ?? ""),
      })),
    } : {}),
    warnings: [...warnings],
  };
}
