import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { ComparisonItem, ComparisonResult } from "@/domain/compare";
import { buildComparison } from "@/domain/compare";
import { comparisonCsv, comparisonCsvExport, comparisonXlsx, comparisonXlsxExport } from "@/lib/comparison-export";
import { parseDocument } from "@/lib/parsers";
import { createPptxSlides } from "./fixtures";

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
      deltaText: "+5,000원",
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
      deltaText: null,
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
      deltaText: null,
      sources: [{ fileId: "base", nodeId: "base:3", label: "Page 3", locator: { kind: "pdf", page: 3, spans: [] } }],
    },
  ],
};

async function compareDecks(base: readonly string[][], target: readonly string[][]): Promise<ComparisonItem[]> {
  const [left, right] = await Promise.all([
    parseDocument({ fileId: "base", fileName: "base.pptx", bytes: createPptxSlides(base) }),
    parseDocument({ fileId: "target", fileName: "target.pptx", bytes: createPptxSlides(target) }),
  ]);
  return buildComparison(left, right).items;
}

const changeFor = (items: readonly ComparisonItem[], label: string): ComparisonItem => {
  const item = items.find((entry) => entry.label === label);
  if (!item) throw new Error(`No change for ${label}: ${items.map((entry) => entry.label).join(" | ")}`);
  return item;
};

describe("comparison exports", () => {
  it("writes the item, both values and an explicit empty delta", () => {
    const csv = comparisonCsv(result);

    expect(csv).toContain("변경 유형,항목,기준 파일 값,대상 파일 값,차이,변화율,기준 근거,대상 근거");
    expect(csv).toContain("중요 변경,서울 단가,\"130,000원\",\"135,000원\",\"+5,000원\",+3.85%,Slide 2,Slide 2");
    expect(csv).toContain("추가,신규 항목,—,추가 값,—,—,—,Sheet1 · B4");
    expect(csv).toContain("삭제,삭제 항목,이전 값,—,—,—,Page 3,—");
    expect(csv).not.toContain("Text 1");
    expect(csv).not.toMatch(/undefined|NaN|\[object/u);
    expect(comparisonCsvExport(result).fileName).toBe("worklens-version-compare.csv");
  });

  it("writes the same rows to XLSX with a readable table", async () => {
    const bytes = await comparisonXlsx(result);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.getWorksheet("버전 비교");

    expect(sheet?.getRow(1).values).toEqual([undefined, "변경 유형", "항목", "기준 파일 값", "대상 파일 값", "차이", "변화율", "기준 근거", "대상 근거"]);
    expect(sheet?.getRow(2).values).toEqual([undefined, "중요 변경", "서울 단가", "130,000원", "135,000원", "+5,000원", "+3.85%", "Slide 2", "Slide 2"]);
    expect(sheet?.getRow(3).getCell(6).value).toBe("—");
    expect(sheet?.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet?.autoFilter).toBe("A1:H1");
    expect(sheet?.getRow(1).getCell(1).font.bold).toBe(true);
    expect(sheet?.columns.every((column) => (column.width ?? 0) >= 10 && (column.width ?? 0) <= 48)).toBe(true);
    expect((await comparisonXlsxExport(result)).fileName).toBe("worklens-version-compare.xlsx");
  });

  it("drops the item column when no change carries a user-facing name", () => {
    const unlabelled: ComparisonResult = {
      ...result,
      items: result.items.map((item) => ({ ...item, label: "" })),
    };
    expect(comparisonCsv(unlabelled).split("\r\n")[0]).toBe("변경 유형,기준 파일 값,대상 파일 값,차이,변화율,기준 근거,대상 근거");
  });
});

describe("comparison deltas", () => {
  it("computes a difference only for comparable measurements", async () => {
    const items = await compareDecks(
      [["교육 운영", "담당자: 김하나", "교육장소: 3층 대회의실", "교육일시: 2026.09.30 14:00", "예산: 2,258,000원", "출석률: 5%", "참석: 75명", "이월: 0건"]],
      [["교육 운영", "담당자: 박민수", "교육장소: 2층 교육장", "교육일시: 2026.10.28 10:00", "예산: 1,680,000원", "출석률: 7%", "참석: 32명", "이월: 10건"]],
    );

    expect(changeFor(items, "담당자")).toMatchObject({ previous: "김하나", current: "박민수", deltaText: null, changePercent: null });
    expect(changeFor(items, "교육장소")).toMatchObject({ deltaText: null, changePercent: null });
    expect(changeFor(items, "교육일시")).toMatchObject({ deltaText: null, changePercent: null });
    expect(changeFor(items, "예산")).toMatchObject({ deltaText: "-578,000원" });
    expect(changeFor(items, "예산").changePercent).toBeCloseTo(-25.6, 2);
    expect(changeFor(items, "출석률")).toMatchObject({ deltaText: "+2%p" });
    expect(changeFor(items, "출석률").changePercent).toBeCloseTo(40, 2);
    expect(changeFor(items, "참석")).toMatchObject({ deltaText: "-43명" });
    expect(changeFor(items, "이월")).toMatchObject({ deltaText: "+10건", changePercent: null });
  });

  it("leaves sequence numbers, versions and identifiers without a delta", async () => {
    const items = await compareDecks(
      [["9월 교육 운영 계획", "판: v1", "문서번호: 1001", "슬라이드 순서: 2"]],
      [["10월 교육 운영 계획", "판: v2", "문서번호: 1002", "슬라이드 순서: 3"]],
    );

    expect(items.every((item) => item.deltaText === null)).toBe(true);
    expect(items.every((item) => item.changePercent === null)).toBe(true);
    expect(items.every((item) => !item.label.startsWith("Text"))).toBe(true);
  });
});
