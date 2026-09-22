import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { SourceRef } from "@/domain/document";
import type { ExtractValueType, FileExtraction } from "@/domain/extract";
import { buildValueCheck } from "@/domain/value-check";
import { valueCheckCsv, valueCheckXlsx } from "@/lib/value-check-export";

function source(fileId: string, nodeId: string, range = "B2"): SourceRef {
  return {
    fileId,
    nodeId,
    label: `기본 · ${range}`,
    locator: { kind: "xlsx", sheet: "기본", range },
    quote: `${nodeId} quote`,
  };
}

function file(id: string, fields: Array<{
  name: string;
  value: string;
  type?: ExtractValueType;
  normalizedValue?: string;
  sources?: SourceRef[];
}>): FileExtraction {
  return {
    file: { id, name: `${id}.xlsx` },
    fields: fields.map((field, index) => ({
      field: field.name,
      displayValue: field.value,
      type: field.type ?? "Text",
      sources: field.sources ?? [source(id, `${id}-${index}`, `B${index + 2}`)],
      ...(field.normalizedValue ? { normalizedValue: field.normalizedValue } : {}),
    })),
    records: [],
    missing: [],
  };
}

describe("buildValueCheck", () => {
  it("treats formatting-only money and field delimiter differences as consistent", () => {
    const result = buildValueCheck([
      file("a", [{ name: "목표 주가", value: "64,550원", type: "Money" }]),
      file("b", [{ name: "목표-주가", value: "64,550 원", type: "Money" }]),
    ]);

    expect(result.summary).toEqual({ total: 1, different: 0, partial: 0, consistent: 1 });
    expect(result.groups[0]).toMatchObject({ field: "목표 주가", status: "consistent", distinctValueCount: 1 });
    expect(result.groups[0].occurrences.map((entry) => entry.displayValue)).toEqual(["64,550원", "64,550 원"]);
  });

  it.each([
    ["money unit spacing", "2,258억 원", "2,258억원", "consistent"],
    ["numeric comma formatting", "2,258억 원", "2258억 원", "consistent"],
    ["different money values", "2,258억 원", "2,200억 원", "different"],
    ["different money scales", "2,258억 원", "2,258만 원", "different"],
  ] as const)("compares %s without converting scale units", (_case, left, right, status) => {
    const result = buildValueCheck([
      file("a", [{ name: "시가총액", value: left, type: "Money" }]),
      file("b", [{ name: "시가총액", value: right, type: "Money" }]),
    ]);

    expect(result.groups[0]).toMatchObject({ status });
    expect(result.groups[0].occurrences.map((entry) => entry.displayValue)).toEqual([left, right]);
  });

  it("keeps safe percent and counter spacing comparisons consistent", () => {
    const result = buildValueCheck([
      file("a", [
        { name: "상승여력", value: "232.4%", type: "Percent" },
        { name: "참석인원", value: "75명", type: "Number" },
      ]),
      file("b", [
        { name: "상승여력", value: "232.4 %", type: "Percent" },
        { name: "참석인원", value: "75 명", type: "Number" },
      ]),
    ]);

    expect(result.groups.map((group) => [group.field, group.status])).toEqual([
      ["상승여력", "consistent"],
      ["참석인원", "consistent"],
    ]);
  });

  it("marks a comparable field missing from one selected file as partial, not different", () => {
    const result = buildValueCheck([
      file("a", [{ name: "인원", value: "12명", type: "Number" }]),
      file("b", [{ name: "인원", value: "13명", type: "Number" }]),
      file("c", [{ name: "보고서명", value: "월간 현황" }]),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ status: "partial", missingFileIds: ["c"], distinctValueCount: 2 });
    expect(result.summary).toEqual({ total: 1, different: 0, partial: 1, consistent: 0 });
  });

  it("retains every differing same-file occurrence and every source", () => {
    const first = source("a", "a-1", "B2");
    const repeated = source("a", "a-2", "B8");
    const result = buildValueCheck([
      file("a", [
        { name: "예산", value: "100만원", type: "Money", sources: [first, repeated] },
        { name: "예산", value: "200만원", type: "Money" },
      ]),
      file("b", [{ name: "예산", value: "100만원", type: "Money" }]),
    ]);

    expect(result.groups[0].status).toBe("different");
    expect(result.groups[0].occurrences).toHaveLength(3);
    expect(result.groups[0].occurrences[0].sources).toEqual([first, repeated]);
    expect(result.groups[0].occurrences.map((entry) => entry.displayValue)).toEqual(["100만원", "200만원", "100만원"]);
  });

  it("normalizes dates conservatively while refusing fuzzy field containment", () => {
    const result = buildValueCheck([
      file("a", [
        { name: "기준일", value: "2025.1.2", type: "Date", normalizedValue: "2025-01-02" },
        { name: "기준일 상세", value: "잠정" },
      ]),
      file("b", [{ name: "기준일", value: "2025-01-02", type: "Date", normalizedValue: "2025-01-02" }]),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ field: "기준일", status: "consistent" });
  });

  it("sorts differences before partial and consistent groups", () => {
    const result = buildValueCheck([
      file("a", [
        { name: "일치", value: "같음" },
        { name: "부분", value: "A" },
        { name: "차이", value: "A" },
      ]),
      file("b", [
        { name: "일치", value: " 같음 " },
        { name: "부분", value: "B" },
        { name: "차이", value: "B" },
      ]),
      file("c", [
        { name: "일치", value: "같음" },
        { name: "차이", value: "C" },
      ]),
    ]);

    expect(result.groups.map((group) => group.status)).toEqual(["different", "partial", "consistent"]);
  });

  it("returns a normal empty result when no field is comparable", () => {
    const result = buildValueCheck([
      file("a", [{ name: "고유 항목 A", value: "A" }]),
      file("b", [{ name: "고유 항목 B", value: "B" }]),
    ]);
    expect(result.groups).toEqual([]);
    expect(result.summary.total).toBe(0);
  });
});

describe("value-check exports", () => {
  it("puts one item on one row with the compared files side by side", async () => {
    const result = buildValueCheck([
      file("a", [{ name: "목표주가", value: "64,550원", type: "Money" }]),
      file("b", [{ name: "목표주가", value: "70,000원", type: "Money" }]),
    ]);
    const csv = valueCheckCsv(result);
    expect(csv.split("\r\n")[0]).toBe("항목,기준 파일 값,대상 파일 값,판정,기준 근거,대상 근거");
    expect(csv.split("\r\n")).toHaveLength(3);
    expect(csv).toContain("목표주가,\"64,550원\",\"70,000원\",값 차이,기본 · B2,기본 · B2");

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await valueCheckXlsx(result) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.getWorksheet("비교 결과");
    expect(sheet?.getRow(1).values).toEqual([undefined, "항목", "기준 파일 값", "대상 파일 값", "판정", "기준 근거", "대상 근거"]);
    expect(sheet?.rowCount).toBe(2);
    expect(sheet?.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet?.autoFilter).toBe("A1:F1");
    expect(sheet?.getRow(1).getCell(1).font.bold).toBe(true);
    expect(sheet?.columns.every((column) => (column.width ?? 0) >= 10 && (column.width ?? 0) <= 48)).toBe(true);
    expect(workbook.getWorksheet("근거 상세")).toBeUndefined();
  });

  it("keeps one row per item across more files and moves evidence to its own sheet", async () => {
    const result = buildValueCheck([
      file("a", [{ name: "목표주가", value: "64,550원", type: "Money" }]),
      file("b", [{ name: "목표주가", value: "70,000원", type: "Money" }]),
      file("c", [{ name: "목표주가", value: "70,000원", type: "Money" }]),
    ]);
    const csv = valueCheckCsv(result);
    expect(csv.split("\r\n")[0]).toBe("항목,a.xlsx,b.xlsx,c.xlsx,판정");
    expect(csv.split("\r\n")).toHaveLength(3);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await valueCheckXlsx(result) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    expect(workbook.getWorksheet("비교 결과")?.rowCount).toBe(2);
    expect(workbook.getWorksheet("근거 상세")?.rowCount).toBe(4);
  });
});
