import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { AggregationDraft, AggregationSelection } from "@/domain/aggregation";
import type { NormalizedDocument } from "@/domain/document";
import { buildAggregation } from "@/lib/aggregation/engine";
import { aggregationXlsxExport } from "@/lib/aggregation/export";
import { parseDocument } from "@/lib/parsers";
import { createXlsx } from "./fixtures";

const defaultSelection = (draft: AggregationDraft) => ({
  sheetIds: draft.workbooks.flatMap((workbook) => workbook.sheets.filter((sheet) => sheet.selectedByDefault).map((sheet) => sheet.id)),
  mappings: draft.mappings,
});

async function documentOf(fileId: string, configure: (book: ExcelJS.Workbook) => void) {
  const book = new ExcelJS.Workbook();
  configure(book);
  return parseDocument({ fileId, fileName: `${fileId}.xlsx`, bytes: new Uint8Array(await book.xlsx.writeBuffer() as ArrayBuffer) });
}

async function exportAndOpen(documents: NormalizedDocument[], selection?: AggregationSelection) {
  const draft = buildAggregation(documents);
  const output = new ExcelJS.Workbook();
  await output.xlsx.load((await aggregationXlsxExport(draft, selection ?? defaultSelection(draft), documents)).content as unknown as ExcelJS.Buffer);
  return { draft, output };
}

describe("aggregation workbook edge cases", () => {
  it("continues a restarted XX-prefixed sequence without renumbering adjacent business measures or formula results", async () => {
    const headers = ["배치", "내용", "연도", "금액", "수량", "비율", "식별 코드", "기준일", "계산"];
    const make = (id: string, prefix: string) => documentOf(id, (book) => {
      const sheet = book.addWorksheet("분기 실적");
      sheet.addRow(headers);
      for (let index = 0; index < 3; index += 1) {
        const row = sheet.addRow([`XX-${String(index + 1).padStart(2, "0")}`, `${prefix} ${index + 1}`, 2024 + index,
          100 + index, index + 1, (index + 1) / 100, `A${100 + index}`, new Date(Date.UTC(2026, 0, index + 1)),
          { formula: `E${index + 2}+1`, result: index + 2 }]);
        row.getCell(4).numFmt = '#,##0"원"';
        row.getCell(6).numFmt = "0.0%";
        row.getCell(8).numFmt = "dd mmm yyyy";
      }
    });
    const { draft, output } = await exportAndOpen([await make("target", "기준"), await make("source", "추가")]);
    expect(draft.workbooks[1].sheets[0].plan.kind).toBe("append");
    expect(output.worksheets.map((sheet) => sheet.name)).toEqual(["분기 실적"]);
    const sheet = output.getWorksheet("분기 실적")!;
    expect([2, 3, 4, 5, 6, 7].map((row) => sheet.getCell(row, 1).value)).toEqual(
      ["XX-01", "XX-02", "XX-03", "XX-04", "XX-05", "XX-06"],
    );
    expect([5, 6, 7].map((row) => [3, 4, 5, 6, 7, 9].map((column) => sheet.getCell(row, column).value))).toEqual([
      [2024, 100, 1, 0.01, "A100", 2],
      [2025, 101, 2, 0.02, "A101", 3],
      [2026, 102, 3, 0.03, "A102", 4],
    ]);
    expect(sheet.getCell("D7").numFmt).toBe('#,##0"원"');
    expect(sheet.getCell("F7").numFmt).toBe("0.0%");
    expect(sheet.getCell("H7").value).toEqual(new Date(Date.UTC(2026, 0, 3)));
    expect(sheet.getCell("H7").numFmt).toBe("dd mmm yyyy");
  });

  it("keeps a source-provided month helper rather than deriving another month from the mapped date", async () => {
    const target = await documentOf("target-month", (book) => {
      const sheet = book.addWorksheet("실적");
      sheet.getRow(1).values = [null, "관리번호", "내용", "등록일"];
      for (const row of [2, 3]) {
        sheet.getCell(row, 1).value = 8;
        sheet.getCell(row, 2).value = `T-${row}`;
        sheet.getCell(row, 3).value = "기준";
        sheet.getCell(row, 4).value = new Date(Date.UTC(2026, 7, row));
        sheet.getCell(row, 4).numFmt = "yyyy-mm-dd";
      }
    });
    const source = await documentOf("source-month", (book) => {
      const sheet = book.addWorksheet("실적");
      sheet.getRow(1).values = [null, "관리번호", "내용", "등록일"];
      for (const [row, month] of [[2, 11], [3, 12]] as const) {
        sheet.getCell(row, 1).value = month;
        sheet.getCell(row, 2).value = `S-${row}`;
        sheet.getCell(row, 3).value = "추가";
        sheet.getCell(row, 4).value = new Date(Date.UTC(2026, 8, row));
        sheet.getCell(row, 4).numFmt = "yyyy-mm-dd";
      }
    });
    const { output } = await exportAndOpen([target, source]);
    const sheet = output.getWorksheet("실적")!;
    expect([2, 3, 4, 5].map((row) => sheet.getCell(row, 1).value)).toEqual([8, 8, 11, 12]);
    expect(sheet.getCell("D4").value).toEqual(new Date(Date.UTC(2026, 8, 2)));
  });

  it("leaves a target month helper empty when the source has neither its helper nor a mapped date", async () => {
    const target = await documentOf("target-empty-month", (book) => {
      const sheet = book.addWorksheet("실적");
      sheet.getRow(1).values = [null, "관리번호", "내용", "등록일"];
      for (const row of [2, 3]) {
        sheet.getCell(row, 1).value = 8;
        sheet.getCell(row, 2).value = `T-${row}`;
        sheet.getCell(row, 3).value = "기준";
        sheet.getCell(row, 4).value = new Date(Date.UTC(2026, 7, row));
        sheet.getCell(row, 4).numFmt = "yyyy-mm-dd";
      }
    });
    const source = await documentOf("source-empty-month", (book) => {
      book.addWorksheet("실적").addRows([
        ["관리번호", "내용", "등록일"],
        ["S-1", "추가", null],
        ["S-2", "추가", null],
      ]);
    });
    const { draft, output } = await exportAndOpen([target, source]);
    expect(draft.workbooks[1].sheets[0].plan.kind).toBe("append");
    const sheet = output.getWorksheet("실적")!;
    expect([4, 5].map((row) => [sheet.getCell(row, 1).value, sheet.getCell(row, 4).value])).toEqual([[null, null], [null, null]]);
  });

  it("derives a missing helper from the sole mapped serial-date column, retaining the target's custom date format", async () => {
    const target = await documentOf("serial-target", (book) => {
      const sheet = book.addWorksheet("실적");
      sheet.getRow(1).values = [null, "관리번호", "내용", "등록일"];
      for (const row of [2, 3]) {
        sheet.getCell(row, 1).value = 2;
        sheet.getCell(row, 2).value = `T-${row}`;
        sheet.getCell(row, 3).value = "기준";
        sheet.getCell(row, 4).value = new Date(Date.UTC(2026, 1, row));
        sheet.getCell(row, 4).numFmt = "dd mmm yyyy";
      }
    });
    const source = await documentOf("serial-source", (book) => {
      book.addWorksheet("실적").addRows([
        ["관리번호", "내용", "등록일"],
        ["S-2", "추가", 46248],
        ["S-3", "추가", 46249],
      ]);
    });
    const { draft, output } = await exportAndOpen([target, source]);
    expect(draft.targets[0].helpers).toEqual([{ column: 1, fill: "formula", formula: "MONTH(D{ROW})" }]);
    const sheet = output.getWorksheet("실적")!;
    expect([4, 5].map((row) => sheet.getCell(row, 1).value)).toEqual([
      { formula: "MONTH(D4)" }, { formula: "MONTH(D5)" },
    ]);
    expect(sheet.getCell("D4").value).toEqual(new Date(Date.UTC(2026, 7, 14)));
    expect(sheet.getCell("D4").numFmt).toBe("dd mmm yyyy");
  });

  it("preserves a source month helper but derives its blank neighbor from that row's mapped date", async () => {
    const target = await documentOf("mixed-target", (book) => {
      const sheet = book.addWorksheet("실적");
      sheet.getRow(1).values = [null, "관리번호", "내용", "등록일"];
      for (const row of [2, 3]) {
        sheet.getCell(row, 1).value = 8;
        sheet.getCell(row, 2).value = `T-${row}`;
        sheet.getCell(row, 3).value = "기준";
        sheet.getCell(row, 4).value = new Date(Date.UTC(2026, 7, row));
        sheet.getCell(row, 4).numFmt = "yyyy-mm-dd";
      }
    });
    const source = await documentOf("mixed-source", (book) => {
      const sheet = book.addWorksheet("실적");
      sheet.getRow(1).values = [null, "관리번호", "내용", "등록일"];
      for (const row of [2, 3]) {
        sheet.getCell(row, 2).value = `S-${row}`;
        sheet.getCell(row, 3).value = "추가";
        sheet.getCell(row, 4).value = new Date(Date.UTC(2026, 8, row));
        sheet.getCell(row, 4).numFmt = "yyyy-mm-dd";
      }
      sheet.getCell("A2").value = 11;
    });
    const { output } = await exportAndOpen([target, source]);
    const sheet = output.getWorksheet("실적")!;
    expect(sheet.getCell("A4").value).toBe(11);
    expect(sheet.getCell("A5").value).toEqual({ formula: "MONTH(D5)" });
  });

  it("exports an explanation when the first workbook has only an unselected empty sheet", async () => {
    const document = await parseDocument({ fileId: "empty", fileName: "empty.xlsx", bytes: await createXlsx({ "빈 시트": [] }) });
    const { draft, output } = await exportAndOpen([document]);
    expect(draft.workbooks[0].sheets[0]).toMatchObject({ role: "empty", selectedByDefault: false });
    expect(output.worksheets.map((sheet) => sheet.name)).toEqual(["취합 결과"]);
    expect(output.getWorksheet("취합 결과")!.getCell("A2").value).toBe("선택한 시트에서 취합할 레코드를 찾지 못했습니다.");
  });

  it("does not absorb a matching source sheet when its selection is removed", async () => {
    const target = await parseDocument({ fileId: "selected-target", fileName: "selected-target.xlsx", bytes: await createXlsx({
      "주문": [["상품", "가격", "상태"], ["A", 1200, "확정"], ["B", 1400, "대기"]],
    }) });
    const source = await parseDocument({ fileId: "unselected-source", fileName: "unselected-source.xlsx", bytes: await createXlsx({
      "주문": [["상품", "가격", "상태"], ["C", 1600, "확정"]],
    }) });
    const draft = buildAggregation([target, source]);
    expect(draft.workbooks[1].sheets[0].plan.kind).toBe("append");
    const selection = defaultSelection(draft);
    const output = new ExcelJS.Workbook();
    await output.xlsx.load((await aggregationXlsxExport(draft, {
      ...selection, sheetIds: selection.sheetIds.filter((id) => id !== draft.workbooks[1].sheets[0].id),
    }, [target, source])).content as unknown as ExcelJS.Buffer);
    expect(output.worksheets.map((sheet) => sheet.name)).toEqual(["주문"]);
    expect([2, 3, 4].map((row) => output.getWorksheet("주문")!.getCell(row, 1).value)).toEqual(["A", "B", null]);
  });

  it("retains the first workbook layout while excluding unmatched and blank source sheets by default", async () => {
    const target = await parseDocument({ fileId: "first", fileName: "first.xlsx", bytes: await createXlsx({
      "주문": [["상품", "가격", "상태"], ["A", 1200, "확정"], ["B", 1400, "대기"]],
      "메모": [["담당", "비고"], ["운영", "기준 파일"]],
    }) });
    const source = await parseDocument({ fileId: "second", fileName: "second.xlsx", bytes: await createXlsx({
      "주문": [["상태", "상품", "가격"], ["확정", "C", 1600]],
      "창고": [["품번", "재고", "위치"], ["P1", 30, "서쪽"], ["P2", 40, "동쪽"]],
      "빈 시트": [],
    }) });
    const { draft, output } = await exportAndOpen([target, source]);
    expect(draft.workbooks[1].sheets.map((sheet) => sheet.plan.kind)).toEqual(["append", "unmatched", "ignored"]);
    expect(output.worksheets.map((sheet) => sheet.name)).toEqual(["주문", "메모"]);
    expect([2, 3, 4].map((row) => [1, 2, 3].map((column) => output.getWorksheet("주문")!.getCell(row, column).value))).toEqual([
      ["A", 1200, "확정"], ["B", 1400, "대기"], ["C", 1600, "확정"],
    ]);
    expect(output.getWorksheet("메모")!.getCell("B2").value).toBe("기준 파일");
  });
});
