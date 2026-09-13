import { createHash } from "node:crypto";
import type { NormalizedDocument, SourceLocator, SourceRef } from "@/domain/document";

import { parseCsv } from "./csv";
import { parseDocx } from "./docx";
import { parsePdf } from "./pdf";
import { parsePptx } from "./pptx";
import { parseXlsx } from "./xlsx";

export interface ParseDocumentInput {
  fileId: string;
  fileName: string;
  bytes: Uint8Array;
}

const PARSER_REVISION = "worklens-parser-v2";
const unsupportedFileError = (): Error =>
  new Error("지원하지 않는 파일 형식입니다. CSV, DOCX, PPTX, XLSX 또는 PDF 파일만 업로드할 수 있습니다.");

export const parseDocument = async (input: ParseDocumentInput): Promise<NormalizedDocument> => {
  const extension = input.fileName.slice(input.fileName.lastIndexOf(".")).toLowerCase();
  // pdfjs (and potentially other parsers) transfers ownership of the input
  // buffer, zeroing its contents after parse. Compute the content hash before
  // any parser touches the bytes.
  const contentHash = createHash("sha256").update(input.bytes).digest("hex");
  let document: NormalizedDocument;
  if (extension === ".xlsx") document = await parseXlsx(input);
  else if (extension === ".csv") document = await parseCsv(input);
  else if (extension === ".docx") document = await parseDocx(input);
  else if (extension === ".pptx") document = await parsePptx(input);
  else if (extension === ".pdf") document = await parsePdf(input);
  else throw unsupportedFileError();
  return addCanonicalProvenance(document, contentHash);
};

function addCanonicalProvenance(document: NormalizedDocument, contentHash: string): NormalizedDocument {
  const version = createHash("sha256")
    .update(`${PARSER_REVISION}\0${contentHash}`)
    .digest("hex");
  const warnings = new Set(document.warnings);
  const canonicalNodeId = (structuralPath: string): string =>
    createHash("sha256")
      .update(`${version}\0${PARSER_REVISION}\0${structuralPath}`)
      .digest("hex");
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
      quoteHash: createHash("sha256").update(quote).digest("hex"),
    };
  };
  return {
    ...document,
    version,
    parserRevision: PARSER_REVISION,
    blocks: document.blocks.map((block, blockIndex) => {
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
    }),
    warnings: [...warnings],
  };
}
