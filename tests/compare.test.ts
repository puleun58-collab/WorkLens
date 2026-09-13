import { describe, expect, it } from "vitest";
import { buildComparison } from "@/domain/compare";
import { parseDocument } from "@/server/parsers";
import { createPdf, createXlsx, RATE_SHEET_V1, RATE_SHEET_V2 } from "./fixtures";

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
      label: expect.stringContaining("ambiguous duplicate key SEOUL"),
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
      label: expect.stringContaining("merge geometry"),
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
