import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { ComparisonResult } from "@/domain/compare";
import { comparisonCsv, comparisonCsvExport, comparisonXlsx, comparisonXlsxExport } from "@/lib/comparison-export";

const result: ComparisonResult = {
  summary: { total: 3, added: 1, removed: 1, changed: 0, structural: 0, important: 1 },
  items: [
    {
      id: "change:1",
      category: "Important Change",
      label: "서울 단가",
      previous: "130,000원",
      current: "135,000원",
      difference: 5000,
      changePercent: 3.846,
      sources: [
        { fileId: "base", nodeId: "base:1", label: "Slide 2", locator: { kind: "pptx", slide: 2, shape: 5 } },
        { fileId: "current", nodeId: "current:1", label: "Slide 2", locator: { kind: "pptx", slide: 2, shape: 5 } },
      ],
    },
    {
      id: "change:2",
      category: "Added",
      label: "신규 항목",
      previous: null,
      current: "추가 값",
      difference: null,
      changePercent: null,
      sources: [{ fileId: "current", nodeId: "current:2", label: "Sheet1 B4", locator: { kind: "xlsx", sheet: "Sheet1", range: "B4" } }],
    },
    {
      id: "change:3",
      category: "Removed",
      label: "삭제 항목",
      previous: "이전 값",
      current: null,
      difference: null,
      changePercent: null,
      sources: [{ fileId: "base", nodeId: "base:3", label: "Page 3", locator: { kind: "pdf", page: 3, spans: [] } }],
    },
  ],
};

describe("comparison exports", () => {
  it("writes deterministic CSV columns, empty added/removed cells, and split sources", () => {
    const csv = comparisonCsv(result);

    expect(csv).toContain("변경 유형,항목,기준 파일 값,대상 파일 값,차이,변화율,기준 근거,대상 근거");
    expect(csv).toContain("중요 변경,서울 단가,\"130,000원\",\"135,000원\",5000,3.85%,Slide 2,Slide 2");
    expect(csv).toContain("추가,신규 항목,,추가 값,,,,Sheet1 · B4");
    expect(csv).toContain("삭제,삭제 항목,이전 값,,,,Page 3,");
    expect(csv).not.toContain("해당 없음");
    expect(comparisonCsvExport(result).fileName).toBe("worklens-version-compare.csv");
  });

  it("writes the same rows to XLSX without semantic enrichment", async () => {
    const bytes = await comparisonXlsx(result);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.getWorksheet("버전 비교");

    expect(sheet?.getRow(1).values).toEqual([undefined, "변경 유형", "항목", "기준 파일 값", "대상 파일 값", "차이", "변화율", "기준 근거", "대상 근거"]);
    expect(sheet?.getRow(2).values).toEqual([undefined, "중요 변경", "서울 단가", "130,000원", "135,000원", "5000", "3.85%", "Slide 2", "Slide 2"]);
    expect(sheet?.getRow(3).getCell(3).value).toBe("");
    expect((await comparisonXlsxExport(result)).fileName).toBe("worklens-version-compare.xlsx");
  });
});
