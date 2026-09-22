import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildAggregation } from "@/lib/aggregation/engine";
import { aggregationXlsxExport } from "@/lib/aggregation/export";
import { improvementBankExport } from "@/lib/aggregation/improvement-export";
import { improvementBackdataExport } from "@/lib/aggregation/pptx-export";
import { parseDocument } from "@/lib/parsers";

async function workbookBytes(configure: (workbook: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  configure(workbook);
  return new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer);
}

async function aggregate(configure: (workbook: ExcelJS.Workbook) => void, fileId = "book-a") {
  const document = await parseDocument({ fileId, fileName: `${fileId}.xlsx`, bytes: await workbookBytes(configure) });
  return buildAggregation([document]);
}

describe("generic aggregation", () => {
  it("groups compatible sheets regardless of column order and keeps sheet sources", async () => {
    const draft = await aggregate((workbook) => {
      const bu = workbook.addWorksheet("BU");
      bu.addRows([["부서", "매출", "인원"], ["영업", 1200, 3], ["물류", 900, 5]]);
      const warehouse = workbook.addWorksheet("W-H");
      warehouse.addRows([["인원", "담당부서", "매출액"], [4, "운영", 800], [2, "지원", 400]]);
    });

    expect(draft.groups).toHaveLength(1);
    expect(draft.groups[0]).toMatchObject({ recordCount: 4, fields: expect.arrayContaining(["부서", "매출", "인원"]) });
    expect(draft.records).toHaveLength(4);
    expect(draft.records.every((record) => record.source.sheet && record.source.cellRange)).toBe(true);
    expect(draft.mappings.find((mapping) => mapping.targetField === "부서")?.sourceFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "부서" }),
      expect.objectContaining({ field: "담당부서" }),
    ]));
  });

  it("detects independent header rows and does not merge incompatible schemas", async () => {
    const draft = await aggregate((workbook) => {
      const detail = workbook.addWorksheet("자료");
      detail.addRows([["월간 상세"], [], ["부서", "비용", "기준일"], ["운영", 300, new Date("2026-08-01")], ["지원", 200, new Date("2026-08-02")]]);
      const inventory = workbook.addWorksheet("Sheet1");
      inventory.addRows([["설명"], ["재고", "입고량", "출고량"], [10, 4, 3], [11, 2, 1]]);
      workbook.addWorksheet("빈 시트");
    });

    expect(draft.groups).toHaveLength(2);
    const sheets = draft.workbooks[0].sheets;
    expect(sheets.find((sheet) => sheet.name === "자료")?.regions[0]).toMatchObject({ headerRange: "A3:C3", recordRange: "A4:C5" });
    expect(sheets.find((sheet) => sheet.name === "Sheet1")?.regions[0]).toMatchObject({ headerRange: "A2:C2", recordRange: "A3:C4" });
    expect(sheets.find((sheet) => sheet.name === "빈 시트")).toMatchObject({ role: "empty", selectedByDefault: false });
  });

  it("retains hidden sheets for review without selecting them automatically", async () => {
    const draft = await aggregate((workbook) => {
      const visible = workbook.addWorksheet("DATA");
      visible.addRows([["항목", "값", "기준일"], ["A", 1, "2026-08-01"], ["B", 2, "2026-08-02"]]);
      const hidden = workbook.addWorksheet("Lookup", { state: "hidden" });
      hidden.addRows([["코드", "명칭", "상태"], ["A", "운영", true], ["B", "지원", true]]);
    });

    const hidden = draft.workbooks[0].sheets.find((sheet) => sheet.name === "Lookup");
    expect(hidden).toMatchObject({ visibility: "hidden", role: "review", selectedByDefault: false });
    expect(hidden?.regions[0].records).toHaveLength(2);
  });

  it("preserves cached formula values and typed dates", async () => {
    const draft = await aggregate((workbook) => {
      const sheet = workbook.addWorksheet("실적");
      sheet.addRows([["부서", "합계", "기준일"], ["A", { formula: "1+2", result: 3 }, new Date("2026-08-01")], ["B", 4, new Date("2026-08-02")]]);
    });

    const [first] = draft.records;
    expect(first.fields.find((field) => field.label === "합계")?.value).toMatchObject({ value: 3, displayValue: "3" });
    expect(first.fields.find((field) => field.label === "기준일")?.value).toMatchObject({ type: "Date", normalizedValue: "2026-08-01" });
  });

  it("marks exact duplicates without deleting either record", async () => {
    const draft = await aggregate((workbook) => {
      const first = workbook.addWorksheet("A");
      first.addRows([["관리번호", "제목", "기준일"], ["ID-1", "동일 항목", "2026-08-01"], ["ID-2", "다른 항목", "2026-08-02"]]);
      const second = workbook.addWorksheet("B");
      second.addRows([["관리번호", "제목", "기준일"], ["ID-1", "동일 항목", "2026-08-01"], ["ID-3", "새 항목", "2026-08-03"]]);
    });

    expect(draft.records).toHaveLength(4);
    expect(draft.records.filter((record) => record.duplicateOf)).toHaveLength(1);
  });

  it("reopens safe multi-sheet exports with provenance columns", async () => {
    const draft = await aggregate((workbook) => {
      const costs = workbook.addWorksheet("비용");
      costs.addRows([["부서", "비용", "기준일"], ["운영", 300, "2026-08-01"], ["지원", 200, "2026-08-02"]]);
      const stock = workbook.addWorksheet("재고");
      stock.addRows([["품목", "입고", "출고"], ["A", 4, 3], ["B", 2, 1]]);
    });
    const exported = await aggregationXlsxExport(draft, {
      sheetIds: draft.workbooks[0].sheets.filter((sheet) => sheet.selectedByDefault).map((sheet) => sheet.id),
      mappings: draft.mappings,
    });
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(exported.content as unknown as ExcelJS.Buffer);

    expect(reopened.worksheets).toHaveLength(2);
    expect(reopened.worksheets.every((sheet) => (sheet.getRow(1).values as ExcelJS.CellValue[]).includes("_출처 범위"))).toBe(true);
    expect(reopened.worksheets.flatMap((sheet) => sheet.getColumn(1).values).filter(Boolean).length).toBeGreaterThan(2);
  });

  it("reopens improvement Bank and Backdata profile outputs", async () => {
    const sourceBytes = await workbookBytes((workbook) => {
      const sheet = workbook.addWorksheet("개선 Bank");
      sheet.addRows([
        ["공장", "구분", "현상 파악", "개선 결과", "진행 현황 등록", "진행 현황 종료"],
        ["BU", "S", "통로 적치물이 통행을 방해함", "적치 위치를 구획 밖으로 이동함", new Date("2026-08-01"), new Date("2026-08-02")],
        ["W-H", "Q", "표시가 불명확함", "표시판을 교체함", new Date("2026-08-03"), new Date("2026-08-04")],
      ]);
    });
    const document = await parseDocument({ fileId: "profile", fileName: "profile.xlsx", bytes: sourceBytes });
    document.media = [{
      id: "profile-image",
      kind: "image",
      mimeType: "image/png",
      extension: "png",
      data: new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZsXcAAAAASUVORK5CYII=", "base64")),
      source: { fileId: document.fileId, nodeId: "profile-image", label: "개선 Bank!E2 이미지", sheet: "개선 Bank", row: 2, column: 5, cellRange: "E2" },
      anchor: { x: 4, y: 1, width: 1, height: 1, unit: "cell" },
    }];
    const draft = buildAggregation([document]);
    const selection = { sheetIds: draft.workbooks[0].sheets.map((sheet) => sheet.id), mappings: draft.mappings };

    const bank = await improvementBankExport(draft, selection, [document]);
    const reopenedBank = new ExcelJS.Workbook();
    await reopenedBank.xlsx.load(bank.content as unknown as ExcelJS.Buffer);
    expect(reopenedBank.getWorksheet("개선 Bank")?.rowCount).toBe(6);
    expect(reopenedBank.getWorksheet("개선 Bank")?.getImages()).toHaveLength(1);
    expect(reopenedBank.getWorksheet("개선 Bank")?.getCell("G5").text).toContain("통로 적치물");

    const backdata = improvementBackdataExport(draft, selection, [document]);
    const reopenedSlides = await parseDocument({ fileId: "profile-ppt", fileName: backdata.fileName, bytes: backdata.content });
    expect(reopenedSlides.metadata.pageCount).toBe(3);
    expect(reopenedSlides.media).toHaveLength(1);
    expect(reopenedSlides.blocks.some((block) => block.type === "paragraph" && block.text.includes("통로 적치물"))).toBe(true);
  });
});
