import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { AggregationDraft } from "@/domain/aggregation";
import { buildAggregation } from "@/lib/aggregation/engine";
import { aggregationXlsxExport } from "@/lib/aggregation/export";
import { parseDocument } from "@/lib/parsers";

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZsXcAAAAASUVORK5CYII=",
  "base64",
);


async function workbookBytes(configure: (workbook: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  configure(workbook);
  return new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer);
}

async function documentOf(configure: (workbook: ExcelJS.Workbook) => void, fileId = "book-a") {
  return parseDocument({ fileId, fileName: `${fileId}.xlsx`, bytes: await workbookBytes(configure) });
}

async function aggregate(configure: (workbook: ExcelJS.Workbook) => void, fileId = "book-a") {
  return buildAggregation([await documentOf(configure, fileId)]);
}

const defaultSelection = (draft: AggregationDraft) => ({
  sheetIds: draft.workbooks.flatMap((workbook) => workbook.sheets.filter((sheet) => sheet.selectedByDefault).map((sheet) => sheet.id)),
  mappings: draft.mappings,
});

async function reopen(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  return workbook;
}

function fillArgb(cell: ExcelJS.Cell): string | undefined {
  return cell.fill.type === "pattern" ? cell.fill.fgColor?.argb : undefined;
}

async function styledTemplateDocument(
  fileId: string,
  headerColor: string,
  dataColor: string,
  departments: readonly string[],
  withDecoration = false,
) {
  return documentOf((workbook) => {
    const sheet = workbook.addWorksheet("실적", { views: [{ state: "frozen", ySplit: 2 }] });
    sheet.mergeCells("A1:D1");
    sheet.getCell("A1").value = `${fileId} 월간 실적`;
    sheet.getCell("A1").font = { name: "맑은 고딕", size: 16, bold: true, color: { argb: "FF303640" } };
    sheet.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };
    sheet.getRow(1).height = 30;
    sheet.addRow(["담당부서", "비용", "달성률", "기준일"]);
    sheet.getRow(2).eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: "맑은 고딕", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: headerColor } };
      cell.border = { bottom: { style: "medium", color: { argb: "FF6B7280" } } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });
    sheet.getRow(2).height = 26;
    departments.forEach((department, index) => {
      const row = sheet.addRow([department, 1_200_000 + index * 50_000, 0.075 + index * 0.01, new Date(Date.UTC(2026, 7, index + 1))]);
      row.height = index === 0 ? 24 : 31;
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.font = { name: "Arial", size: 10, color: { argb: "FF20242B" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: dataColor } };
        cell.border = { bottom: { style: "thin", color: { argb: "FFD1D5DB" } } };
        cell.alignment = { vertical: "middle" };
      });
      row.getCell(2).numFmt = '#,##0"원"';
      row.getCell(3).numFmt = "0.0%";
      row.getCell(4).numFmt = "yyyy-mm-dd";
    });
    [18, 16, 13, 15].forEach((width, index) => {
      sheet.getColumn(index + 1).width = width;
    });
    sheet.autoFilter = `A2:D${sheet.rowCount}`;
    if (withDecoration) {
      const image = workbook.addImage({ buffer: PIXEL_PNG as unknown as ExcelJS.Buffer, extension: "png" });
      sheet.addImage(image, { tl: { col: 0.1, row: 0.1 }, ext: { width: 12, height: 12 } });
    }
  }, fileId);
}

const salesCsv = () => parseDocument({
  fileId: "csv-source",
  fileName: "매출.csv",
  bytes: new TextEncoder().encode("부서,매출,기준일\r\n운영,800,2026-08-03\r\n지원,400,2026-08-04\r\n"),
});

describe("Excel-only aggregation input", () => {
  it("rejects a CSV on its own: it has no layout to use as the template", async () => {
    const csv = await salesCsv();

    expect(() => buildAggregation([csv])).toThrow("취합할 수 없는 파일이 포함되어 있습니다.");
  });

  it("refuses a workbook mixed with a CSV instead of silently dropping the CSV", async () => {
    const workbook = await documentOf((source) => {
      source.addWorksheet("매출").addRows([["부서", "매출", "기준일"], ["영업", 1200, "2026-08-01"]]);
    }, "xlsx-source");
    const csv = await salesCsv();

    for (const documents of [[workbook, csv], [csv, workbook]]) {
      let error: unknown;
      try {
        buildAggregation(documents);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: "AGGREGATE_FORMAT_UNSUPPORTED",
        message: "취합할 수 없는 파일이 포함되어 있습니다.",
        detail: "취합은 Excel 파일만 지원합니다. 지원하지 않는 파일을 선택 해제한 뒤 다시 실행해 주세요.",
      });
    }
  });

  it.each(["pptx", "pdf", "docx"] as const)("rejects %s instead of silently aggregating it", (kind) => {
    const document = {
      id: `${kind}:document`,
      fileId: `${kind}:file`,
      kind,
      metadata: { fileName: `자료.${kind}` },
      blocks: [],
      warnings: [],
    };

    expect(() => buildAggregation([document])).toThrow("취합할 수 없는 파일이 포함되어 있습니다.");
  });
});

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

  it("reads rich text, hyperlink and error cells as their displayed text", async () => {
    const draft = await aggregate((workbook) => {
      const sheet = workbook.addWorksheet("표");
      sheet.addRow([]);
      sheet.getCell("A1").value = { richText: [{ text: "구분" }, { text: " 코드" }] };
      sheet.getCell("B1").value = "담당";
      sheet.getCell("C1").value = { richText: [{ text: "비고" }] };
      sheet.getCell("A2").value = "SAFETY";
      sheet.getCell("B2").value = { text: "담당자", hyperlink: "https://example.com" };
      sheet.getCell("C2").value = { error: "#REF!" };
      sheet.getCell("A3").value = "QUALITY";
      sheet.getCell("B3").value = "김담당";
      sheet.getCell("C3").value = "확인";
    });

    const headers = draft.workbooks[0].sheets[0].regions[0].headers;
    expect(headers).toEqual(["구분 코드", "담당", "비고"]);
    const values = draft.records.flatMap((record) => record.fields.map((field) => field.value.displayValue));
    expect(values).toContain("담당자");
    expect(values.join(" ")).not.toContain("[object");
  });

  it("treats a serial number as a date only when its number format says so", async () => {
    const draft = await aggregate((workbook) => {
      const sheet = workbook.addWorksheet("KPI");
      sheet.addRow(["부서", "기준일", "건수"]);
      sheet.addRow(["운영", 45658, 45658]);
      sheet.getCell("B2").numFmt = "yyyy-mm-dd";
      sheet.getCell("C2").numFmt = "#,##0";
      sheet.addRow(["지원", 45659, 12]);
      sheet.getCell("B3").numFmt = "yyyy-mm-dd";
    });

    const [first] = draft.records;
    expect(first.fields.find((field) => field.label === "기준일")?.value).toMatchObject({
      type: "Date",
      normalizedValue: "2025-01-01",
      displayValue: "2025-01-01",
    });
    expect(first.fields.find((field) => field.label === "건수")?.value).toMatchObject({ type: "Number", value: 45658 });
  });

  it("maps the same calendar day written differently onto one field", async () => {
    const draft = await aggregate((workbook) => {
      const left = workbook.addWorksheet("KPI-A");
      left.addRows([["부서", "2026-01-01", "2026-02-01"], ["운영", 3, 4], ["지원", 5, 6]]);
      const right = workbook.addWorksheet("KPI-B");
      right.addRows([["부서", "2026.1.1", "2026.2.1"], ["물류", 7, 8], ["영업", 9, 10]]);
    });

    const dateMappings = draft.mappings.filter((mapping) => /^\d{4}\./u.test(mapping.targetField));
    expect(dateMappings.map((mapping) => mapping.targetField)).toEqual(["2026.01.01", "2026.02.01"]);
    expect(dateMappings.every((mapping) => mapping.status === "confirmed")).toBe(true);
    expect(dateMappings[0].sourceFields).toHaveLength(2);
  });

  it("names result sheets after their source sheets and keeps typed values", async () => {
    const draft = await aggregate((workbook) => {
      const costs = workbook.addWorksheet("비용");
      costs.addRow(["부서", "비용", "기준일"]);
      costs.addRow(["운영", 300, new Date("2026-08-01")]);
      costs.addRow(["지원", 200, new Date("2026-08-02")]);
      const stock = workbook.addWorksheet("재고");
      stock.addRows([["품목", "입고", "출고"], ["A", 4, 3], ["B", 2, 1]]);
    });
    const exported = await aggregationXlsxExport(draft, defaultSelection(draft));
    const reopened = await reopen(exported.content);

    expect(exported.fileName).toBe("worklens-aggregation.xlsx");
    expect(reopened.worksheets.map((sheet) => sheet.name)).toEqual(["비용", "재고"]);
    const costSheet = reopened.getWorksheet("비용")!;
    expect((costSheet.getRow(1).values as ExcelJS.CellValue[]).filter(Boolean)).toEqual(["부서", "비용", "기준일", "출처 파일", "출처 시트", "출처 범위"]);
    expect(costSheet.getCell("C2").value).toBeInstanceOf(Date);
    expect(costSheet.getCell("C2").numFmt).toBe("yyyy.mm.dd");
    expect(costSheet.getCell("B2").value).toBe(300);
    expect(costSheet.getCell("E2").value).toBe("비용");
    expect(costSheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(costSheet.autoFilter).toBeTruthy();
    expect(reopened.worksheets.every((sheet) => sheet.getImages().length === 0)).toBe(true);
    expect(reopened.worksheets.some((sheet) => sheet.name === "이미지" || sheet.name === "첨부 이미지")).toBe(false);
  });

  it("carries record images into the generic export and lists unlinked ones", async () => {
    const document = await documentOf((workbook) => {
      const sheet = workbook.addWorksheet("점검");
      sheet.addRows([["구분", "현상", "조치"], ["안전", "통로 적치", "이동"], ["품질", "표시 불명확", "교체"]]);
      const linked = workbook.addImage({ buffer: PIXEL_PNG as unknown as ExcelJS.Buffer, extension: "png" });
      sheet.addImage(linked, { tl: { col: 3, row: 1 }, ext: { width: 60, height: 40 } });
      const loose = workbook.addImage({ buffer: PIXEL_PNG as unknown as ExcelJS.Buffer, extension: "png" });
      sheet.addImage(loose, { tl: { col: 6, row: 40 }, ext: { width: 60, height: 40 } });
    }, "images");
    const draft = buildAggregation([document]);
    const exported = await aggregationXlsxExport(draft, defaultSelection(draft), [document]);
    const reopened = await reopen(exported.content);

    const records = reopened.getWorksheet("점검")!;
    expect((records.getRow(1).values as ExcelJS.CellValue[]).filter(Boolean)).toContain("이미지");
    expect(records.getImages()).toHaveLength(1);
    const attachments = reopened.getWorksheet("첨부 이미지");
    expect(attachments?.getImages()).toHaveLength(1);
    expect(attachments?.getCell("B2").value).toBe("점검");
  });


  it("sizes number-formatted columns to what the workbook renders", async () => {
    const draft = await aggregate((workbook) => {
      const sheet = workbook.addWorksheet("실적");
      sheet.addRow(["부서", "금액", "비율"]);
      sheet.addRow(["운영", 2258000, 0.075]);
      sheet.getCell("B2").numFmt = '#,##0"원"';
      sheet.getCell("C2").numFmt = "0.0%";
      sheet.addRow(["지원", 1680000, 0.05]);
      sheet.getCell("B3").numFmt = '#,##0"원"';
      sheet.getCell("C3").numFmt = "0.0%";
    });
    const exported = await aggregationXlsxExport(draft, defaultSelection(draft));
    const sheet = (await reopen(exported.content)).getWorksheet("실적")!;

    // `2,258,000원` needs eleven characters plus the Korean unit; a column
    // measured on the raw digits renders `########` in Excel.
    expect(sheet.getColumn(2).width ?? 0).toBeGreaterThanOrEqual(13);
    expect(sheet.getCell("B2").value).toBe(2258000);
    expect(sheet.getCell("B2").numFmt).toBe('#,##0"원"');
    expect(sheet.getCell("C2").numFmt).toBe("0.0%");
  });

  it("uses the first compatible XLSX as the template and reverses cleanly with selection order", async () => {
    const orange = await styledTemplateDocument("A", "FFF28C28", "FFFFF3E0", ["A-운영", "A-지원"], true);
    const blue = await styledTemplateDocument("B", "FF2563EB", "FFEFF6FF", ["B-영업", "B-물류"]);
    const fill = fillArgb;

    const exportInOrder = async (documents: Parameters<typeof buildAggregation>[0]) => {
      const draft = buildAggregation(documents);
      return reopen((await aggregationXlsxExport(draft, defaultSelection(draft), documents)).content);
    };
    const orangeFirst = (await exportInOrder([orange, blue])).getWorksheet("실적")!;

    expect(orangeFirst.getCell("A1").value).toBe("A 월간 실적");
    expect(orangeFirst.model.merges).toContain("A1:D1");
    expect(fill(orangeFirst.getCell("A2"))).toBe("FFF28C28");
    expect(fill(orangeFirst.getCell("A6"))).toBe("FFFFF3E0");
    expect(orangeFirst.getColumn(1).width).toBe(18);
    expect(orangeFirst.getRow(2).height).toBe(26);
    expect(orangeFirst.getRow(6).height).toBe(24);
    expect(orangeFirst.views[0]).toMatchObject({ state: "frozen", ySplit: 2 });
    expect(orangeFirst.autoFilter).toBe("A2:D6");
    expect([3, 4, 5, 6].map((row) => orangeFirst.getCell(row, 1).value)).toEqual(["A-운영", "A-지원", "B-영업", "B-물류"]);
    expect(orangeFirst.getCell("B6").value).toBe(1_250_000);
    expect(orangeFirst.getCell("B6").numFmt).toBe('#,##0"원"');
    expect(orangeFirst.getCell("C6").numFmt).toBe("0.0%");
    expect(orangeFirst.getCell("D6").value).toBeInstanceOf(Date);
    expect(orangeFirst.getCell("D6").numFmt).toBe("yyyy-mm-dd");
    expect(orangeFirst.getImages()).toHaveLength(1);
    expect(fill(orangeFirst.getCell("E2"))).not.toBe("FFF28C28");

    const blueFirst = (await exportInOrder([blue, orange])).getWorksheet("실적")!;
    expect(blueFirst.getCell("A1").value).toBe("B 월간 실적");
    expect(fill(blueFirst.getCell("A2"))).toBe("FF2563EB");
    expect(fill(blueFirst.getCell("A6"))).toBe("FFEFF6FF");
    expect([3, 4, 5, 6].map((row) => blueFirst.getCell(row, 1).value)).toEqual(["B-영업", "B-물류", "A-운영", "A-지원"]);
  });

  it("chooses a separate first template for every incompatible schema group", async () => {
    const orange = await styledTemplateDocument("A", "FFF28C28", "FFFFF3E0", ["A-운영", "A-지원"]);
    const inventory = await documentOf((workbook) => {
      const sheet = workbook.addWorksheet("재고", { views: [{ state: "frozen", ySplit: 1 }] });
      sheet.addRows([["품목", "입고", "출고"], ["볼트", 10, 3], ["너트", 12, 4]]);
      sheet.getRow(1).eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16803C" } };
      });
      sheet.getRow(2).eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFECFDF3" } };
      });
      sheet.autoFilter = "A1:C3";
    }, "C");
    const blue = await styledTemplateDocument("B", "FF2563EB", "FFEFF6FF", ["B-영업", "B-물류"]);
    const documents = [orange, inventory, blue];
    const draft = buildAggregation(documents);
    const output = await reopen((await aggregationXlsxExport(draft, defaultSelection(draft), documents)).content);
    const fill = fillArgb;

    expect(output.getWorksheet("실적")).toBeTruthy();
    expect(output.getWorksheet("재고")).toBeTruthy();
    expect(fill(output.getWorksheet("실적")!.getCell("A2"))).toBe("FFF28C28");
    expect(fill(output.getWorksheet("재고")!.getCell("A1"))).toBe("FF16803C");
    expect(output.getWorksheet("재고")!.getCell("A3").value).toBe("너트");
  });
});
