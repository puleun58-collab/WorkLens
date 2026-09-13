import { describe, expect, it } from "vitest";
import { parseCanonicalNumber } from "@/domain/numeric";
import { buildComparison } from "@/domain/compare";
import type { NormalizedDocument, TableCell } from "@/domain/document";

const cell = (nodeId: string, display: string): TableCell => ({
  value: display,
  display,
  source: { fileId: "file-1", nodeId, label: nodeId },
});

const tableDocument = (fileId: string, amount: string): NormalizedDocument => ({
  id: `document:${fileId}`,
  fileId,
  kind: "csv",
  metadata: { fileName: `${fileId}.csv` },
  warnings: [],
  blocks: [{
    type: "table",
    id: "t1",
    source: { fileId, nodeId: "t1", label: "표" },
    rows: [[cell("A1", "지역"), cell("B1", "금액")], [cell("A2", "서울"), cell("B2", amount)]],
  }],
});

describe("canonical numeric parsing", () => {
  it("reads repeated three-digit groups as thousands separators", () => {
    expect(parseCanonicalNumber("1,234,567")?.value).toBe(1_234_567);
    expect(parseCanonicalNumber("1.234.567")?.value).toBe(1_234_567);
  });

  it("reads a single separator with non-three-digit tail as a decimal mark", () => {
    expect(parseCanonicalNumber("1.25")?.value).toBe(1.25);
    expect(parseCanonicalNumber("1,25")?.value).toBe(1.25);
  });

  it("refuses a lone separator followed by exactly three digits as ambiguous", () => {
    expect(parseCanonicalNumber("1.234")).toBeUndefined();
    expect(parseCanonicalNumber("1,234")).toBeUndefined();
  });

  it("handles parentheses negatives and percentages", () => {
    expect(parseCanonicalNumber("(1.5)")?.value).toBe(-1.5);
    expect(parseCanonicalNumber("12.5%")?.value).toBe(0.125);
  });

  it("rejects non-numeric text", () => {
    expect(parseCanonicalNumber("abc")).toBeUndefined();
    expect(parseCanonicalNumber("")).toBeUndefined();
    expect(parseCanonicalNumber("(12.5")).toBeUndefined();
    expect(parseCanonicalNumber("12.5)")).toBeUndefined();
    expect(parseCanonicalNumber("1,2.3")).toBeUndefined();
    expect(parseCanonicalNumber("1.2,3")).toBeUndefined();
    expect(parseCanonicalNumber("1 2")).toBeUndefined();
    expect(parseCanonicalNumber("2026 09 12")).toBeUndefined();
  });

  it("uses the same rules inside comparison deltas", () => {
    const result = buildComparison(tableDocument("file-1", "1,234,567"), tableDocument("file-1", "2,234,567"));
    const change = result.items.find((item) => item.difference !== null);
    expect(change?.difference).toBe(1_000_000);
  });

  it("does not invent a delta for an ambiguous grouped value", () => {
    const result = buildComparison(tableDocument("file-1", "1,234"), tableDocument("file-1", "1,567"));
    const changed = result.items.find((item) => item.category === "Changed");
    expect(changed?.difference).toBeNull();
  });
});
