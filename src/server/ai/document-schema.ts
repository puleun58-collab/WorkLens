import { z } from "zod";

/**
 * The browser owns every document, so the optional Local AI endpoint has to
 * validate the documents it is handed before grounding runs against them.
 */
const spanBox = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).strict();

const locatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("csv"), record: z.number().int(), column: z.number().int() }).strict(),
  z.object({ kind: z.literal("xlsx"), sheet: z.string().max(200), range: z.string().max(100) }).strict(),
  z.object({ kind: z.literal("pdf"), page: z.number().int(), spans: z.array(spanBox).max(2_000) }).strict(),
  z.object({
    kind: z.literal("docx"),
    part: z.enum(["body", "header", "footer"]),
    block: z.number().int(),
    tableCell: z.object({ row: z.number().int(), column: z.number().int(), anchorCellId: z.string().max(200).optional() }).strict().optional(),
  }).strict(),
  z.object({
    kind: z.literal("pptx"),
    slide: z.number().int(),
    shape: z.number().int(),
    tableCell: z.object({ row: z.number().int(), column: z.number().int(), anchorCellId: z.string().max(200).optional() }).strict().optional(),
  }).strict(),
]);

const sourceRefSchema = z.object({
  fileId: z.string().min(1).max(200),
  documentId: z.string().max(200).optional(),
  documentVersion: z.string().max(200).optional(),
  nodeId: z.string().min(1).max(200),
  locator: locatorSchema.optional(),
  label: z.string().max(500),
  page: z.number().int().optional(),
  sheet: z.string().max(200).optional(),
  cellRange: z.string().max(100).optional(),
  row: z.number().int().optional(),
  column: z.number().int().optional(),
  quote: z.string().max(20_000).optional(),
  quoteHash: z.string().max(128).optional(),
}).strict();

const cellSchema = z.object({
  value: z.union([z.string().max(20_000), z.number(), z.boolean(), z.null()]),
  display: z.string().max(20_000),
  source: sourceRefSchema,
  rowSpan: z.number().int().optional(),
  colSpan: z.number().int().optional(),
}).strict();

const blockSchema = z.union([
  z.object({
    type: z.literal("paragraph"),
    id: z.string().min(1).max(200),
    text: z.string().max(200_000),
    source: sourceRefSchema,
    role: z.enum(["paragraph", "heading"]).optional(),
    headingLevel: z.number().int().min(1).max(9).optional(),
  }).strict(),
  z.object({
    type: z.literal("table"),
    id: z.string().min(1).max(200),
    source: sourceRefSchema,
    rows: z.array(z.array(cellSchema).max(1_000)).max(5_000),
  }).strict(),
]);

export const normalizedDocumentSchema = z.object({
  id: z.string().min(1).max(200),
  version: z.string().max(200).optional(),
  parserRevision: z.string().max(200).optional(),
  fileId: z.string().min(1).max(200),
  kind: z.enum(["xlsx", "csv", "pdf", "docx", "pptx"]),
  metadata: z.object({
    fileName: z.string().max(400),
    pageCount: z.number().int().optional(),
    sheets: z.array(z.object({
      name: z.string().max(200),
      visibility: z.enum(["visible", "hidden", "veryHidden"]),
      rowCount: z.number().int(),
      columnCount: z.number().int(),
    }).strict()).max(500).optional(),
  }).strict(),
  blocks: z.array(blockSchema).max(20_000),
  warnings: z.array(z.string().max(200)).max(200),
}).strict();
