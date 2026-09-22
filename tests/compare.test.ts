import { describe, expect, it } from "vitest";
import { buildComparison } from "@/domain/compare";
import { parseDocument } from "@/lib/parsers";
import { createDocxParagraphs, createPdf, createPptxSlides, createXlsx, RATE_SHEET_V1, RATE_SHEET_V2 } from "./fixtures";

async function compareRateSheets() {
  const [baseBytes, targetBytes] = await Promise.all([
    createXlsx(RATE_SHEET_V1),
    createXlsx(RATE_SHEET_V2),
  ]);
  const [base, target] = await Promise.all([
    parseDocument({ fileId: "base", fileName: "운임현황_v1.xlsx", bytes: baseBytes }),
    parseDocument({ fileId: "target", fileName: "운임현황_v2.xlsx", bytes: targetBytes }),
  ]);
  return buildComparison(base, target);
}

describe("buildComparison", () => {
  it("computes numeric difference and change percent for a changed value", async () => {
    const result = await compareRateSheets();
    const seoul = result.items.find((item) => item.label.includes("SEOUL"));

    expect(seoul).toBeDefined();
    expect(seoul?.category).toBe("Important Change");
    expect(seoul?.previous).toBe("145000");
    expect(seoul?.current).toBe("158000");
    expect(seoul?.difference).toBe(13000);
    expect(seoul?.changePercent).toBeCloseTo(8.9655, 3);
    expect(seoul?.sources.map((source) => source.cellRange)).toEqual(["B2", "B2"]);
  });

  it("reports change percent as null when the previous value is zero", async () => {
    const result = await compareRateSheets();
    const jeju = result.items.find((item) => item.label.includes("JEJU"));

    expect(jeju?.difference).toBe(5000);
    expect(jeju?.changePercent).toBeNull();
  });

  it("detects added and removed rows", async () => {
    const result = await compareRateSheets();
    const added = result.items.filter((item) => item.category === "Added").map((item) => item.current);
    const removed = result.items.filter((item) => item.category === "Removed").map((item) => item.previous);

    expect(added).toContain("INCHEON");
    expect(removed).toContain("DAEGU");
    expect(result.summary.total).toBe(result.items.length);
    expect(result.summary.added).toBe(1);
    expect(result.summary.removed).toBe(1);
    expect(result.summary.important).toBeGreaterThanOrEqual(2);
  });

  it("reports no changes for identical documents", async () => {
    const bytes = await createXlsx(RATE_SHEET_V1);
    const [base, target] = await Promise.all([
      parseDocument({ fileId: "a", fileName: "a.xlsx", bytes }),
      parseDocument({ fileId: "b", fileName: "b.xlsx", bytes }),
    ]);
    expect(buildComparison(base, target).items).toEqual([]);
  });

  it("detects structural column changes", async () => {
    const [baseBytes, targetBytes] = await Promise.all([
      createXlsx({ 운송단가: [["지역", "단가"], ["SEOUL", 100]] }),
      createXlsx({ 운송단가: [["지역", "단가", "비고"], ["SEOUL", 100, "확정"]] }),
    ]);
    const [base, target] = await Promise.all([
      parseDocument({ fileId: "base", fileName: "v1.xlsx", bytes: baseBytes }),
      parseDocument({ fileId: "target", fileName: "v2.xlsx", bytes: targetBytes }),
    ]);
    const structural = buildComparison(base, target).items.filter(
      (item) => item.category === "Structural Change",
    );
    expect(structural.length).toBeGreaterThan(0);
  });

  it("compares PDF text blocks without AI", async () => {
    const [baseBytes, targetBytes] = await Promise.all([
      createPdf(["Contract term twelve months"]),
      createPdf(["Contract term twenty four months"]),
    ]);
    const [base, target] = await Promise.all([
      parseDocument({ fileId: "base", fileName: "v1.pdf", bytes: baseBytes }),
      parseDocument({ fileId: "target", fileName: "v2.pdf", bytes: targetBytes }),
    ]);
    const result = buildComparison(base, target);
    expect(result.items[0]).toMatchObject({ category: "Changed" });
    expect(result.items[0].sources[0].page).toBe(1);
  });

  it("reports a leading paragraph insertion as one Added, not a cascade", async () => {
    const [baseBytes, targetBytes] = await Promise.all([
      createPdf(["Alpha clause", "Beta clause", "Gamma clause"]),
      createPdf(["Preamble clause", "Alpha clause", "Beta clause", "Gamma clause"]),
    ]);
    const [base, target] = await Promise.all([
      parseDocument({ fileId: "base", fileName: "v1.pdf", bytes: baseBytes }),
      parseDocument({ fileId: "target", fileName: "v2.pdf", bytes: targetBytes }),
    ]);
    const result = buildComparison(base, target);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ category: "Added", current: "Preamble clause" });
  });

  it("reports a leading paragraph deletion as one Removed, not a cascade", async () => {
    const [baseBytes, targetBytes] = await Promise.all([
      createPdf(["Preamble clause", "Alpha clause", "Beta clause"]),
      createPdf(["Alpha clause", "Beta clause"]),
    ]);
    const [base, target] = await Promise.all([
      parseDocument({ fileId: "base", fileName: "v1.pdf", bytes: baseBytes }),
      parseDocument({ fileId: "target", fileName: "v2.pdf", bytes: targetBytes }),
    ]);
    const result = buildComparison(base, target);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ category: "Removed", previous: "Preamble clause" });
  });

  it("pairs adjacent PPTX edits by slide and shape without global fuzzy matching", async () => {
    const [base, target] = await Promise.all([
      parseDocument({
        fileId: "base",
        fileName: "v1.pptx",
        bytes: createPptxSlides([[
          "서울 운임은 130,000원입니다.",
          "부산 운임은 220,000원입니다.",
          "운영 인원은 75명입니다.",
        ]]),
      }),
      parseDocument({
        fileId: "target",
        fileName: "v2.pptx",
        bytes: createPptxSlides([[
          "서울 운임은 135,000원입니다.",
          "부산 운임은 225,000원입니다.",
          "운영 인원은 78명입니다.",
        ]]),
      }),
    ]);
    const first = buildComparison(base, target);
    const second = buildComparison(base, target);

    expect(first).toEqual(second);
    expect(first.summary).toMatchObject({ total: 3, added: 0, removed: 0, important: 3 });
    expect(first.items[0]).toMatchObject({
      previous: "서울 운임은 130,000원입니다.",
      current: "서울 운임은 135,000원입니다.",
      difference: 5000,
    });
    expect(first.items[0].sources.map((source) => source.locator)).toEqual([
      expect.objectContaining({ kind: "pptx", slide: 1, shape: 1 }),
      expect.objectContaining({ kind: "pptx", slide: 1, shape: 1 }),
    ]);
  });

  it("leaves incompatible text at the same PPTX shape as Removed and Added", async () => {
    const [base, target] = await Promise.all([
      parseDocument({
        fileId: "base",
        fileName: "v1.pptx",
        bytes: createPptxSlides([["서울 운임을 안내합니다."]]),
      }),
      parseDocument({
        fileId: "target",
        fileName: "v2.pptx",
        bytes: createPptxSlides([["회사 연혁을 소개합니다."]]),
      }),
    ]);
    const result = buildComparison(base, target);

    expect(result.summary).toMatchObject({ changed: 0, important: 0, added: 1, removed: 1 });
  });

  it("keeps DOCX block changes, additions, deletions, dates, and money deterministic", async () => {
    const [base, target] = await Promise.all([
      parseDocument({
        fileId: "base",
        fileName: "v1.docx",
        bytes: createDocxParagraphs([
          "2026년 운영 보고서",
          "기준일 2026.09.20",
          "운영 비용은 6억 원입니다.",
          "삭제할 문단입니다.",
          "중간 고정 문단입니다.",
          "변경하지 않는 결론입니다.",
        ]),
      }),
      parseDocument({
        fileId: "target",
        fileName: "v2.docx",
        bytes: createDocxParagraphs([
          "2026년 운영 보고서",
          "기준일 2026.09.21",
          "운영 비용은 7억 원입니다.",
          "중간 고정 문단입니다.",
          "추가한 문단입니다.",
          "변경하지 않는 결론입니다.",
        ]),
      }),
    ]);
    const result = buildComparison(base, target);
    expect(result.summary).toMatchObject({ total: 4, added: 1, removed: 1, changed: 1, important: 1 });
    expect(result.items).toContainEqual(expect.objectContaining({
      category: "Changed",
      previous: "기준일 2026.09.20",
      current: "기준일 2026.09.21",
    }));
    expect(result.items.filter((item) => item.category === "Important Change")).toEqual([
      expect.objectContaining({ previous: "운영 비용은 6억 원입니다.", current: "운영 비용은 7억 원입니다.", difference: 1 }),
    ]);
    const dateChange = result.items.find((item) => item.previous === "기준일 2026.09.20");
    expect(dateChange?.sources[0].locator).toEqual(expect.objectContaining({ kind: "docx", block: 2 }));
  });

  it("keeps PDF page sources and repeated output stable", async () => {
    const [baseBytes, targetBytes] = await Promise.all([
      createPdf(["Quarterly report amount 100", "Stable appendix"]),
      createPdf(["Quarterly report amount 120", "Stable appendix", "New final page"]),
    ]);
    const [base, target] = await Promise.all([
      parseDocument({ fileId: "base", fileName: "v1.pdf", bytes: baseBytes }),
      parseDocument({ fileId: "target", fileName: "v2.pdf", bytes: targetBytes }),
    ]);
    const result = buildComparison(base, target);

    expect(result).toEqual(buildComparison(base, target));
    // "amount 100 → 120" carries no unit, so the change is reported without an
    // invented difference.
    expect(result.summary).toMatchObject({ total: 2, added: 1, removed: 0, changed: 1, important: 0 });
    expect(result.items[0]).toMatchObject({ deltaText: null, changePercent: null });
    expect(result.items[0].sources.map((source) => source.locator)).toEqual([
      expect.objectContaining({ kind: "pdf", page: 1 }),
      expect.objectContaining({ kind: "pdf", page: 1 }),
    ]);
  });

  it("refuses to guess alignment for duplicate row keys", async () => {
    const [baseBytes, targetBytes] = await Promise.all([
      createXlsx({ Sheet1: [["지역", "금액"], ["SEOUL", 100], ["SEOUL", 200]] }),
      createXlsx({ Sheet1: [["지역", "금액"], ["SEOUL", 150], ["SEOUL", 250]] }),
    ]);
    const [base, target] = await Promise.all([
      parseDocument({ fileId: "base", fileName: "a.xlsx", bytes: baseBytes }),
      parseDocument({ fileId: "target", fileName: "b.xlsx", bytes: targetBytes }),
    ]);
    const result = buildComparison(base, target);
    expect(result.items).toContainEqual(expect.objectContaining({
      category: "Structural Change",
      label: "SEOUL · 중복 행",
    }));
    expect(result.items.filter((item) => item.category === "Important Change")).toEqual([]);
  });

  it("reports merged-cell geometry changes as structural", async () => {
    const baseBytes = await createXlsx({ Sheet1: [["Region", "Value"], ["Seoul", 100]] });
    const targetBytes = await createXlsx({ Sheet1: [["Region", "Value"], ["Seoul", 100]] });
    const [base, target] = await Promise.all([
      parseDocument({ fileId: "base", fileName: "base.xlsx", bytes: baseBytes }),
      parseDocument({ fileId: "target", fileName: "target.xlsx", bytes: targetBytes }),
    ]);
    const baseTable = base.blocks.find((block) => block.type === "table");
    if (!baseTable) throw new Error("table missing");
    baseTable.rows[1][1].colSpan = 2;
    const result = buildComparison(base, target);
    expect(result.items).toContainEqual(expect.objectContaining({
      category: "Structural Change",
      label: "Seoul · 셀 병합",
    }));
  });

  it("rejects comparison alignment beyond the bounded work budget", () => {
    const paragraphs = Array.from({ length: 1_001 }, (_, index) => ({
      type: "paragraph" as const,
      id: `p${index}`,
      text: `text ${index}`,
      source: { fileId: "base", nodeId: `p${index}`, label: `p${index}` },
    }));
    const base = {
      id: "document:base",
      fileId: "base",
      kind: "pdf" as const,
      metadata: { fileName: "base.pdf" },
      warnings: [],
      blocks: paragraphs,
    };
    const target = {
      ...base,
      id: "document:target",
      fileId: "target",
      blocks: paragraphs.map((paragraph) => ({
        ...paragraph,
        text: `changed ${paragraph.text}`,
        source: { ...paragraph.source, fileId: "target" },
      })),
    };
    expect(() => buildComparison(base, target)).toThrow("COMPARE_ALIGNMENT_LIMIT");
  });

  it("normalizes each paragraph once rather than once per matrix cell", () => {
    const reads = { count: 0 };
    const paragraphs = Array.from({ length: 50 }, (_, index) => ({
      type: "paragraph" as const,
      id: `p${index}`,
      get text() {
        reads.count += 1;
        return `text ${index}`;
      },
      source: { fileId: "base", nodeId: `p${index}`, label: `p${index}` },
    }));
    const base = { id: "d1", fileId: "base", kind: "pdf" as const, metadata: { fileName: "a.pdf" }, warnings: [], blocks: paragraphs };
    const current = { id: "d2", fileId: "current", kind: "pdf" as const, metadata: { fileName: "b.pdf" }, warnings: [], blocks: paragraphs };
    buildComparison(base, current);
    expect(reads.count).toBeLessThanOrEqual(200);
  });
});
