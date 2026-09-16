import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parseDocument } from "@/lib/parsers";
import { FORMAT_INPUT_LIMITS, MAX_CONFIGURED_FILE_BYTES, MAX_WORKSPACE_INPUT_BYTES, inputLimitFor } from "@/lib/parsers/policy";
import { assertSizeWithinLimit, assertWorkspaceWithinLimit } from "@/lib/upload";
import type { TableBlock } from "@/domain/document";
import {
  createDocx,
  createDocxWithMergedTable,
  createDocxWithNestedTable,
  createDocxWithOmissions,
  createPdf,
  createPptx,
  createPptxWithMergedTable,
  createPptxWithOmissions,
  createXlsx,
  createXlsxWithHiddenSheetAndFormula,
  RATE_SHEET_V1,
} from "./fixtures";

describe("parseDocument", () => {
  it("keeps upload admission aligned with format parser limits", () => {
    expect(inputLimitFor("csv")).toBe(FORMAT_INPUT_LIMITS.csv);
    expect(inputLimitFor("docx")).toBe(FORMAT_INPUT_LIMITS.docx);
    expect(inputLimitFor("pptx")).toBe(FORMAT_INPUT_LIMITS.pptx);
    expect(inputLimitFor("xlsx")).toBe(100 * 1024 * 1024);
  });

  it("admits a file at the ceiling and rejects the byte past it", () => {
    expect(() => assertSizeWithinLimit("pdf", MAX_CONFIGURED_FILE_BYTES)).not.toThrow();
    expect(() => assertSizeWithinLimit("pdf", MAX_CONFIGURED_FILE_BYTES + 1)).toThrow(/100 MiB/);
  });

  it("budgets the workspace separately from the per-file ceiling", () => {
    const held = MAX_WORKSPACE_INPUT_BYTES - 1024;
    expect(() => assertWorkspaceWithinLimit(held, 1024)).not.toThrow();
    expect(() => assertWorkspaceWithinLimit(held, 1025)).toThrow(/작업 공간/);
  });

  it("reports a structure limit, not a corrupt file, when a CSV exceeds the row cap", async () => {
    const rows = Array.from({ length: 100_002 }, (_, index) => `행${index},1`).join("\n");
    await expect(parseDocument({ fileId: "file-rows", fileName: "big.csv", bytes: new TextEncoder().encode(rows) }))
      .rejects.toThrow(/문서 구조가 안전 처리 한도/);
  });

  it("lets media-heavy OOXML through: only XML parts spend the expansion budget", async () => {
    const media = new Uint8Array(8 * 1024 * 1024).fill(7);
    const bytes = zipSync({
      "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      "word/document.xml": strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>미디어 포함 문서</w:t></w:r></w:p></w:body></w:document>'),
      "word/media/image1.png": [media, { level: 0 }],
    });
    const document = await parseDocument({ fileId: "file-media", fileName: "media.docx", bytes });
    expect(document.blocks[0]).toMatchObject({ type: "paragraph", text: "미디어 포함 문서" });
  });
  it("normalizes an XLSX workbook with sheet, row and cell locators", async () => {
    const bytes = await createXlsx(RATE_SHEET_V1);
    const document = await parseDocument({ fileId: "file-1", fileName: "운임현황.xlsx", bytes });

    expect(document.kind).toBe("xlsx");
    expect(document.version).toMatch(/^[a-f0-9]{64}$/);
    expect(document.parserRevision).toBe("worklens-parser-v2");
    expect(document.metadata.sheets).toEqual([
      { name: "운송단가", visibility: "visible", rowCount: 5, columnCount: 2 },
    ]);

    const table = document.blocks[0] as TableBlock;
    expect(table.type).toBe("table");
    expect(table.rows).toHaveLength(5);
    expect(table.rows[1][0].display).toBe("SEOUL");
    expect(table.rows[1][1].value).toBe(145000);
    expect(table.rows[1][1].source).toMatchObject({
      fileId: "file-1",
      label: "운송단가!B2",
      sheet: "운송단가",
      cellRange: "B2",
      row: 2,
      column: 2,
      quote: "145000",
      documentVersion: document.version,
      quoteHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("produces stable node ids for identical input", async () => {
    const bytes = await createXlsx(RATE_SHEET_V1);
    const first = await parseDocument({ fileId: "file-1", fileName: "a.xlsx", bytes });
    const second = await parseDocument({ fileId: "file-1", fileName: "a.xlsx", bytes });
    expect(first.blocks.map((block) => block.id)).toEqual(second.blocks.map((block) => block.id));
  });

  it("normalizes a PDF into page-ordered paragraphs with page sources", async () => {
    const bytes = await createPdf(["WorkLens contract page one", "WorkLens contract page two"]);
    const document = await parseDocument({ fileId: "file-2", fileName: "계약서.pdf", bytes });

    expect(document.kind).toBe("pdf");
    expect(document.metadata.pageCount).toBe(2);
    expect(document.blocks.length).toBeGreaterThanOrEqual(2);
    expect(document.blocks[0]).toMatchObject({ type: "paragraph" });
    expect(document.blocks[0].source).toMatchObject({ page: 1, label: "페이지 1" });
    expect(document.blocks.at(-1)?.source.page).toBe(2);
  });

  it("rejects unsupported extensions", async () => {
    await expect(
      parseDocument({ fileId: "x", fileName: "note.txt", bytes: new Uint8Array([1, 2, 3]) }),
    ).rejects.toThrow(/지원하지 않는 파일 형식/);
  });

  it("rejects malformed content with a safe message", async () => {
    await expect(
      parseDocument({ fileId: "x", fileName: "broken.xlsx", bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]) }),
    ).rejects.toThrow(/파일을 읽을 수 없습니다/);
  });

  it("accepts uppercase extensions", async () => {
    const bytes = await createXlsx(RATE_SHEET_V1);
    const document = await parseDocument({ fileId: "file-3", fileName: "REPORT.XLSX", bytes });
    expect(document.kind).toBe("xlsx");
  });

  it("preserves quoted CSV records and cell sources", async () => {
    const bytes = new TextEncoder().encode('\uFEFF지역,메모,금액\r\n서울,"쉼표, 포함",145000\r\n');
    const document = await parseDocument({ fileId: "csv-1", fileName: "운임.csv", bytes });
    const table = document.blocks[0] as TableBlock;
    expect(document.kind).toBe("csv");
    expect(table.rows[1][1]).toMatchObject({
      display: "쉼표, 포함",
      source: { row: 2, column: 2, quote: "쉼표, 포함" },
    });
  });

  it("detects semicolon CSV and rejects ambiguous dialects", async () => {
    const semicolon = await parseDocument({
      fileId: "csv-2",
      fileName: "유럽.csv",
      bytes: new TextEncoder().encode("지역;금액\n서울;145000\n"),
    });
    expect((semicolon.blocks[0] as TableBlock).rows[1][1].display).toBe("145000");
    await expect(parseDocument({
      fileId: "csv-3",
      fileName: "모호.csv",
      bytes: new TextEncoder().encode("a,b;c\n"),
    })).rejects.toThrow("CSV_DIALECT_AMBIGUOUS");
  });

  it("preserves DOCX body paragraph/table order and locators", async () => {
    const document = await parseDocument({
      fileId: "docx-1",
      fileName: "계약.docx",
      bytes: createDocx(),
    });
    expect(document.kind).toBe("docx");
    expect(document.blocks.map((block) => block.type)).toEqual(["paragraph", "table"]);
    expect(document.blocks[0].source).toMatchObject({ label: "문단 1", quote: "분기 계약 요약" });
    const table = document.blocks[1] as TableBlock;
    expect(table.rows[1][1].source).toMatchObject({ row: 2, column: 2, quote: "145000" });
  });

  it("preserves PPTX slide text/table order and slide locators", async () => {
    const document = await parseDocument({
      fileId: "pptx-1",
      fileName: "계획.pptx",
      bytes: createPptx(),
    });
    expect(document.kind).toBe("pptx");
    expect(document.metadata.pageCount).toBe(1);
    expect(document.blocks.map((block) => block.type)).toEqual(["paragraph", "table"]);
    expect(document.blocks[0].source).toMatchObject({ page: 1, quote: "2026 운영 계획" });
    const table = document.blocks[1] as TableBlock;
    expect(table.rows[1][1].source).toMatchObject({ page: 1, row: 2, column: 2, quote: "5000" });
  });

  it("rejects archive traversal and invalid UTF-8 input", async () => {
    const traversal = zipSync({
      "../word/document.xml": strToU8("<w:document/>"),
      "word/document.xml": strToU8("<w:document/>"),
    });
    await expect(parseDocument({
      fileId: "bad-docx",
      fileName: "악성.docx",
      bytes: traversal,
    })).rejects.toThrow(/파일을 읽을 수 없습니다/);
    await expect(parseDocument({
      fileId: "bad-csv",
      fileName: "깨짐.csv",
      bytes: new Uint8Array([0xff, 0xfe, 0xfd]),
    })).rejects.toThrow(/파일을 읽을 수 없습니다/);
  });

  it("sets rowSpan/colSpan on the anchor DOCX cell and empties continuation cells", async () => {
    const document = await parseDocument({
      fileId: "docx-merge",
      fileName: "병합.docx",
      bytes: createDocxWithMergedTable(),
    });
    const table = document.blocks[0] as TableBlock;
    expect(table.rows[0][0]).toMatchObject({ display: "Header", colSpan: 2 });
    expect(table.rows[0][1]).toMatchObject({ display: "H3" });
    expect(table.rows[0][1].colSpan).toBeUndefined();
    expect(table.rows[1][0]).toMatchObject({ display: "A1", rowSpan: 2 });
    expect(table.rows[2][0]).toMatchObject({ display: "", value: null });
    expect(table.rows[2][0].rowSpan).toBeUndefined();
    expect(table.rows[1][1]).toMatchObject({ display: "A2" });
    expect(table.rows[2][1]).toMatchObject({ display: "B2" });
  });

  it("emits stable DOCX warning codes for detected-but-omitted content", async () => {
    const document = await parseDocument({
      fileId: "docx-warn",
      fileName: "경고.docx",
      bytes: createDocxWithOmissions(),
    });
    expect(document.warnings.sort()).toEqual(["DOCX_CHART_OMITTED", "DOCX_HEADER_FOOTER_OMITTED", "DOCX_IMAGE_OMITTED"]);
  });

  it("emits no DOCX warnings when no omitted content is present", async () => {
    const document = await parseDocument({ fileId: "docx-clean", fileName: "깔끔.docx", bytes: createDocx() });
    expect(document.warnings).toEqual([]);
  });

  it("omits nested DOCX tables without corrupting the outer table", async () => {
    const document = await parseDocument({
      fileId: "docx-nested",
      fileName: "nested.docx",
      bytes: createDocxWithNestedTable(),
    });
    const table = document.blocks[0] as TableBlock;
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].map((cell) => cell.display)).toEqual(["Outer A", "Outer B"]);
    expect(document.warnings).toContain("DOCX_NESTED_TABLE_OMITTED");
  });

  it("sets rowSpan/colSpan on the anchor PPTX cell and empties continuation cells", async () => {
    const document = await parseDocument({
      fileId: "pptx-merge",
      fileName: "병합.pptx",
      bytes: createPptxWithMergedTable(),
    });
    const table = document.blocks[0] as TableBlock;
    expect(table.rows[0][0]).toMatchObject({ display: "Header", colSpan: 2 });
    expect(table.rows[0][1]).toMatchObject({ display: "", value: null });
    expect(table.rows[0][2]).toMatchObject({ display: "H3" });
    expect(table.rows[1][0]).toMatchObject({ display: "A1", rowSpan: 2 });
    expect(table.rows[2][0]).toMatchObject({ display: "", value: null });
    expect(table.rows[2][0].rowSpan).toBeUndefined();
  });

  it("emits stable PPTX warning codes for detected-but-omitted content", async () => {
    const document = await parseDocument({
      fileId: "pptx-warn",
      fileName: "경고.pptx",
      bytes: createPptxWithOmissions(),
    });
    expect(document.warnings.sort()).toEqual(["PPTX_CHART_OMITTED", "PPTX_IMAGE_OMITTED", "PPTX_SPEAKER_NOTES_OMITTED"]);
  });

  it("emits no PPTX warnings when no omitted content is present", async () => {
    const document = await parseDocument({ fileId: "pptx-clean", fileName: "깔끔.pptx", bytes: createPptx() });
    expect(document.warnings).toEqual([]);
  });

  it("emits XLSX hidden-sheet and formula-value-only warnings, deduplicated", async () => {
    const bytes = await createXlsxWithHiddenSheetAndFormula();
    const document = await parseDocument({ fileId: "xlsx-warn", fileName: "경고.xlsx", bytes });
    expect(document.warnings.sort()).toEqual(["XLSX_FORMULA_VALUE_ONLY", "XLSX_HIDDEN_SHEET_OMITTED"]);
    expect(document.blocks.every((block) => block.source.sheet !== "보조")).toBe(true);
  });

  it("emits no XLSX warnings for a workbook with no hidden sheets or formulas", async () => {
    const bytes = await createXlsx(RATE_SHEET_V1);
    const document = await parseDocument({ fileId: "xlsx-clean", fileName: "깔끔.xlsx", bytes });
    expect(document.warnings).toEqual([]);
  });
});
