import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { NormalizedDocument, SourceRef, TableCell } from "@/domain/document";
import { analyzeDocument, checkDocument, extractDocument } from "@/lib/deterministic";
import { exportCsv, exportXlsx } from "@/lib/export";

const source = (nodeId: string, quote: string): SourceRef => ({
  fileId: "file-1",
  nodeId,
  label: `Sheet1!${nodeId}`,
  sheet: "Sheet1",
  cellRange: nodeId,
  quote,
});
const cell = (nodeId: string, value: TableCell["value"], display = String(value ?? "")): TableCell => ({
  value,
  display,
  source: source(nodeId, display),
});
const fixture = (): NormalizedDocument => ({
  id: "document:file-1",
  fileId: "file-1",
  kind: "xlsx",
  metadata: { fileName: "점검.xlsx" },
  warnings: [],
  blocks: [
    { type: "paragraph", id: "p1", text: "담당자 user@example.com", source: source("P1", "담당자 user@example.com") },
    {
      type: "table",
      id: "t1",
      source: source("A1:C5", "표"),
      rows: [
        [cell("A1", "항목"), cell("B1", "금액"), cell("C1", "수식 안전")],
        [cell("A2", "서울"), cell("B2", 100, "100"), cell("C2", "=1+1")],
        [cell("A3", "부산"), cell("B3", 200, "200.0"), cell("C3", "+SUM(A1:A2)")],
        [cell("A4", "Total"), cell("B4", 350, "350"), cell("C4", "")],
        [cell("A5", "서울"), cell("B5", null, ""), cell("C5", "@cmd")],
      ],
    },
  ],
});

describe("deterministic operations", () => {
  it("analyzes ordered structure and exact numeric summaries", () => {
    const result = analyzeDocument(fixture());
    expect(result.structure).toMatchObject({ paragraphCount: 1, tableCount: 1 });
    expect(result.structure.tables[0]).toMatchObject({ rowCount: 5, columnCount: 3 });
    expect(result.numeric).toMatchObject({ count: 3, sum: 650, minimum: 100, maximum: 350 });
    expect(result.totals[0]).toMatchObject({ actual: 350, expected: 300 });
  });

  it("treats repeated three-digit groups as thousands separators", () => {
    const document = fixture();
    const table = document.blocks.find((block) => block.type === "table");
    if (!table) throw new Error("table fixture missing");
    table.rows[1][1] = cell("B2", "1,234,567");
    const result = analyzeDocument(document);
    expect(result.numeric.maximum).toBe(1_234_567);
  });

  it("detects privacy, duplicate, empty, formatting, and total issues with sources", () => {
    const result = checkDocument(fixture());
    const codes = result.findings.map((finding) => finding.code);
    expect(codes).toEqual(expect.arrayContaining([
      "privacy-email",
      "duplicate-value",
      "empty-cell",
      "inconsistent-number-format",
      "invalid-total",
    ]));
    for (const finding of result.findings) expect(finding.sources.length).toBeGreaterThan(0);
    expect(result.findings.find((finding) => finding.code === "invalid-total")).toMatchObject({
      severity: "critical",
      reason: expect.any(String),
      recommendation: expect.any(String),
    });
  });

  it("extracts all content without losing provenance", () => {
    const result = extractDocument(fixture());
    expect(result.paragraphs[0].source.nodeId).toBe("P1");
    expect(result.tables[0].rows[1][1]).toMatchObject({ value: 100, source: { cellRange: "B2" } });
  });

  it("neutralizes spreadsheet formulas and follows RFC4180 quoting in CSV", () => {
    const csv = exportCsv(extractDocument(fixture()));
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'+SUM(A1:A2)");
    expect(csv).toContain("'@cmd");
    expect(csv).toContain("\r\n");
  });

  it("exports machine-usable provenance that disambiguates same-locator files", async () => {
    const first = fixture();
    const second: NormalizedDocument = {
      ...fixture(),
      id: "document:file-2",
      fileId: "file-2",
      blocks: fixture().blocks.map((block) => block.type === "paragraph"
        ? { ...block, source: { ...block.source, fileId: "file-2", documentVersion: "v2" } }
        : {
            ...block,
            source: { ...block.source, fileId: "file-2", documentVersion: "v2" },
            rows: block.rows.map((row) => row.map((cell) => ({
              ...cell,
              source: { ...cell.source, fileId: "file-2", documentVersion: "v2" },
            }))),
          }),
    };

    const csv = exportCsv(extractDocument(first));
    expect(csv).toContain("file_id,document_version,node_id,source");
    expect(csv).toContain("file-1");

    // Same sheet/range in a different file must remain distinguishable.
    const secondCsv = exportCsv(extractDocument(second));
    expect(secondCsv).toContain("file-2");
    expect(secondCsv).toContain("v2");
    expect(csv).not.toEqual(secondCsv);

    const bytes = await exportXlsx(extractDocument(second));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const provenance = workbook.getWorksheet("Table 1 Source");
    expect(provenance?.getRow(1).values).toEqual(
      expect.arrayContaining(["file_id", "document_version", "node_id", "source"]),
    );
    expect(provenance?.getRow(2).values).toEqual(expect.arrayContaining(["file-2", "v2"]));
  });

  it("neutralizes formula strings in XLSX exports", async () => {
    const bytes = await exportXlsx(extractDocument(fixture()));
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const table = workbook.getWorksheet("Table 1");
    expect(table?.getCell("C2").value).toBe("'=1+1");
    expect(table?.getCell("C3").value).toBe("'+SUM(A1:A2)");
    expect(table?.getCell("C5").value).toBe("'@cmd");
    expect(typeof table?.getCell("C2").value).toBe("string");
  });
});
