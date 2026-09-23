import ExcelJS from "exceljs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { AggregationDraft } from "@/domain/aggregation";
import { buildAggregation } from "@/lib/aggregation/engine";
import { aggregationXlsxExport } from "@/lib/aggregation/export";
import { mappedFields, targetCell } from "@/lib/aggregation/values";
import { parseDocument } from "@/lib/parsers";

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZsXcAAAAASUVORK5CYII=",
  "base64",
);
const WIDE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAAJElEQVR4nO3NMQEAAAgDILV/5xljDxRgMx1XesVisVgsFosLHjCnASdq4S4eAAAAAElFTkSuQmCC",
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
  it("appends a source table by header meaning regardless of its column order", async () => {
    const target = await documentOf((workbook) => {
      workbook.addWorksheet("BU").addRows([["부서", "매출", "인원"], ["영업", 1200, 3], ["물류", 900, 5]]);
    }, "bu");
    const source = await documentOf((workbook) => {
      workbook.addWorksheet("W-H").addRows([["인원", "담당부서", "매출액"], [4, "운영", 800], [2, "지원", 400]]);
    }, "wh");
    const documents = [target, source];
    const draft = buildAggregation(documents);

    expect(draft.targets.map((entry) => [entry.name, entry.kind, entry.recordCount])).toEqual([["BU", "records", 4]]);
    expect(draft.workbooks[1].sheets[0].plan).toMatchObject({ kind: "append" });
    expect(draft.mappings.find((mapping) => mapping.targetField === "부서")).toMatchObject({
      status: "suggested",
      sourceFields: expect.arrayContaining([expect.objectContaining({ field: "담당부서" })]),
    });
    const sheet = (await reopen((await aggregationXlsxExport(draft, defaultSelection(draft), documents)).content)).getWorksheet("BU")!;
    expect([2, 3, 4, 5].map((row) => [1, 2, 3].map((column) => sheet.getCell(row, column).value))).toEqual([
      ["영업", 1200, 3],
      ["물류", 900, 5],
      ["운영", 800, 4],
      ["지원", 400, 2],
    ]);
  });

  it("keeps every target sheet as its own result sheet", async () => {
    const draft = await aggregate((workbook) => {
      const detail = workbook.addWorksheet("자료");
      detail.addRows([["월간 상세"], [], ["부서", "비용", "기준일"], ["운영", 300, new Date("2026-08-01")], ["지원", 200, new Date("2026-08-02")]]);
      const inventory = workbook.addWorksheet("Sheet1");
      inventory.addRows([["설명"], ["재고", "입고량", "출고량"], [10, 4, 3], [11, 2, 1]]);
      workbook.addWorksheet("빈 시트");
    });

    expect(draft.targets.map((target) => [target.name, target.kind])).toEqual([["자료", "records"], ["Sheet1", "records"], ["빈 시트", "static"]]);
    const sheets = draft.workbooks[0].sheets;
    expect(sheets.find((sheet) => sheet.name === "자료")?.regions[0]).toMatchObject({ headerRange: "A3:C3", recordRange: "A4:C5", headerColumns: [1, 2, 3] });
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

  it("maps the same calendar day written differently onto one target field", async () => {
    const left = await documentOf((workbook) => {
      workbook.addWorksheet("KPI").addRows([["부서", "2026-01-01", "2026-02-01"], ["운영", 3, 4], ["지원", 5, 6]]);
    }, "kpi-a");
    const right = await documentOf((workbook) => {
      workbook.addWorksheet("KPI").addRows([["부서", "2026.1.1", "2026.2.1"], ["물류", 7, 8], ["영업", 9, 10]]);
    }, "kpi-b");
    const draft = buildAggregation([left, right]);

    const dateMappings = draft.mappings.filter((mapping) => /^\d{4}\./u.test(mapping.targetField));
    expect(dateMappings.map((mapping) => mapping.targetField)).toEqual(["2026.01.01", "2026.02.01"]);
    expect(dateMappings.every((mapping) => mapping.status === "confirmed" && mapping.targetColumn !== undefined)).toBe(true);
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
    expect((costSheet.getRow(1).values as ExcelJS.CellValue[]).filter(Boolean)).toEqual(["부서", "비용", "기준일"]);
    expect(costSheet.getCell("C2").value).toBeInstanceOf(Date);
    expect(costSheet.getCell("C2").numFmt).toBe("mm-dd-yy");
    expect(costSheet.getCell("B2").value).toBe(300);
    expect(costSheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(costSheet.autoFilter).toBeTruthy();
    expect(reopened.worksheets.every((sheet) => sheet.getImages().length === 0)).toBe(true);
    expect(reopened.worksheets.some((sheet) => sheet.name === "이미지" || sheet.name === "첨부 이미지")).toBe(false);
  });

  it("puts a target record's picture into its own cell and keeps the template's other drawings in place", async () => {
    const document = await documentOf((workbook) => {
      const sheet = workbook.addWorksheet("점검");
      sheet.addRows([["구분", "현상", "조치"], ["안전", "통로 적치", "이동"], ["품질", "표시 불명확", "교체"]]);
      const linked = workbook.addImage({ buffer: PIXEL_PNG as unknown as ExcelJS.Buffer, extension: "png" });
      sheet.addImage(linked, { tl: { col: 1.1, row: 1.1 }, ext: { width: 60, height: 40 } });
      const loose = workbook.addImage({ buffer: PIXEL_PNG as unknown as ExcelJS.Buffer, extension: "png" });
      sheet.addImage(loose, { tl: { col: 6, row: 40 }, ext: { width: 60, height: 40 } });
    }, "images");
    const draft = buildAggregation([document]);
    const reopened = await reopen((await aggregationXlsxExport(draft, defaultSelection(draft), [document])).content);

    const records = reopened.getWorksheet("점검")!;
    expect((records.getRow(1).values as ExcelJS.CellValue[]).filter(Boolean)).toEqual(["구분", "현상", "조치"]);
    const anchors = records.getImages().map((image) => [image.range.tl.nativeCol, image.range.tl.nativeRow]);
    expect(anchors).toEqual(expect.arrayContaining([[1, 1], [6, 40]]));
    expect(reopened.getWorksheet("첨부 이미지")).toBeUndefined();
  });

  it("lists a source picture that belongs to no record instead of dropping it", async () => {
    const target = await documentOf((workbook) => {
      workbook.addWorksheet("점검").addRows([["구분", "현상", "조치"], ["안전", "통로 적치", "이동"], ["품질", "표시 불명확", "교체"]]);
    }, "target");
    const source = await documentOf((workbook) => {
      const sheet = workbook.addWorksheet("점검");
      sheet.addRows([["구분", "현상", "조치"], ["환경", "누유", "청소"], ["설비", "소음", "교체"]]);
      const linked = workbook.addImage({ buffer: PIXEL_PNG as unknown as ExcelJS.Buffer, extension: "png" });
      sheet.addImage(linked, { tl: { col: 1.1, row: 1.1 }, ext: { width: 60, height: 40 } });
      const loose = workbook.addImage({ buffer: PIXEL_PNG as unknown as ExcelJS.Buffer, extension: "png" });
      sheet.addImage(loose, { tl: { col: 6, row: 40 }, ext: { width: 60, height: 40 } });
    }, "source");
    const documents = [target, source];
    const draft = buildAggregation(documents);
    const reopened = await reopen((await aggregationXlsxExport(draft, defaultSelection(draft), documents)).content);

    expect(reopened.getWorksheet("점검")!.getImages().map((image) => [image.range.tl.nativeCol, image.range.tl.nativeRow])).toEqual([[1, 3]]);
    const attachments = reopened.getWorksheet("첨부 이미지");
    expect(attachments?.getImages()).toHaveLength(1);
    expect(attachments?.getCell("A2").value).toBe("source.xlsx");
    expect(attachments?.getCell("B2").value).toBe("점검");
  });


  it("refuses an unsupported image format instead of silently dropping it", async () => {
    const document = await documentOf((book) => {
      const sheet = book.addWorksheet("사진");
      sheet.addRows([["관리 No", "내용"], ["ID-1", "확인"], ["ID-2", "완료"]]);
      const image = book.addImage({ buffer: PIXEL_PNG as unknown as ExcelJS.Buffer, extension: "png" });
      sheet.addImage(image, { tl: { col: 1.1, row: 1.1 }, ext: { width: 20, height: 20 } });
    }, "unsupported");
    const source = { ...document, media: document.media?.map((item) => ({ ...item, extension: "svg", mimeType: "image/svg+xml" })) };
    const draft = buildAggregation([source]);
    await expect(aggregationXlsxExport(draft, defaultSelection(draft), [source])).rejects.toThrow("지원 형식(PNG, JPEG, GIF)");
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

    const blueFirst = (await exportInOrder([blue, orange])).getWorksheet("실적")!;
    expect(blueFirst.getCell("A1").value).toBe("B 월간 실적");
    expect(fill(blueFirst.getCell("A2"))).toBe("FF2563EB");
    expect(fill(blueFirst.getCell("A6"))).toBe("FFEFF6FF");
    expect([3, 4, 5, 6].map((row) => blueFirst.getCell(row, 1).value)).toEqual(["B-영업", "B-물류", "A-운영", "A-지원"]);
  });

  it("leaves a source table the target has no sheet for to review, and keeps its own layout once included", async () => {
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
    const stock = draft.workbooks[1].sheets[0];
    expect(stock).toMatchObject({ plan: { kind: "unmatched" }, selectedByDefault: false });
    expect(draft.issues.some((issue) => issue.sheetName === "재고")).toBe(true);

    const byDefault = await reopen((await aggregationXlsxExport(draft, defaultSelection(draft), documents)).content);
    expect(byDefault.worksheets.map((sheet) => sheet.name)).toEqual(["실적"]);
    expect([3, 4, 5, 6].map((row) => byDefault.getWorksheet("실적")!.getCell(row, 1).value)).toEqual(["A-운영", "A-지원", "B-영업", "B-물류"]);

    const selection = defaultSelection(draft);
    const included = await reopen((await aggregationXlsxExport(draft, { ...selection, sheetIds: [...selection.sheetIds, stock.id] }, documents)).content);
    expect(included.worksheets.map((sheet) => sheet.name)).toEqual(["실적", "재고"]);
    expect(fillArgb(included.getWorksheet("실적")!.getCell("A2"))).toBe("FFF28C28");
    expect(fillArgb(included.getWorksheet("재고")!.getCell("A1"))).toBe("FF16803C");
    expect(included.getWorksheet("재고")!.getCell("A3").value).toBe("너트");
  });
});

describe("KPI logical workbook reconstruction", () => {
  async function summaryDocument(fileId: string, periods: readonly string[]) {
    return documentOf((book) => {
      const summary = book.addWorksheet("개선 Bank Summary");
      summary.addRow(["구분", "Total", "%", ...periods]);
      summary.addRow(["안전", 8, 0.5, ...periods.map((_, index) => index + 1)]);
      summary.addRow(["품질", 8, 0.5, ...periods.map((_, index) => index + 2)]);
      summary.getColumn(3).numFmt = "0.0%";
    }, fileId);
  }

  async function bankDocument(fileId: string, fill: string, withImages: boolean) {
    return documentOf((book) => {
      const sheet = book.addWorksheet("개선 Bank", { views: [{ state: "frozen", ySplit: 4 }] });
      sheet.mergeCells("B1:M1");
      sheet.getCell("B1").value = `${fileId} 개선 Bank`;
      sheet.mergeCells("B3:B4");
      sheet.mergeCells("C3:C4");
      sheet.mergeCells("D3:D4");
      sheet.mergeCells("E3:F3");
      sheet.mergeCells("G3:G4");
      sheet.mergeCells("H3:H4");
      sheet.mergeCells("I3:I4");
      sheet.mergeCells("J3:J4");
      sheet.mergeCells("K3:L3");
      sheet.mergeCells("M3:M4");
      [["B3", "관리 No"], ["C3", "공장"], ["D3", "구분"], ["E3", "Figure"], ["G3", "문제점"], ["H3", "개선 결과"], ["I3", "제안자"], ["J3", "N/O"], ["K3", "진행 현황"], ["M3", "비고"]]
        .forEach(([address, label]) => { sheet.getCell(address).value = label; });
      sheet.getCell("E4").value = "Before";
      sheet.getCell("F4").value = "After";
      sheet.getCell("K4").value = "등록";
      sheet.getCell("L4").value = "종료";
      for (let column = 2; column <= 13; column += 1) {
        const cell = sheet.getCell(3, column);
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        sheet.getColumn(column).width = column === 7 || column === 8 ? 40 : column === 5 || column === 6 ? 25 : 16;
      }
      sheet.getRow(3).height = 26;
      for (let index = 0; index < 2; index += 1) {
        const row = sheet.getRow(index + 5);
        row.getCell(2).value = `${fileId}-${index + 1}`;
        row.getCell(3).value = "BP";
        row.getCell(4).value = "안전";
        row.getCell(7).value = `문제 ${fileId}-${index + 1}`;
        row.getCell(8).value = `개선 ${fileId}-${index + 1}`;
        row.getCell(9).value = "제안자";
        row.getCell(10).value = 46195;
        row.getCell(10).numFmt = "#,##0";
        row.getCell(11).value = index === 0 ? 46235 : "2026.08.01";
        row.getCell(12).value = new Date(Date.UTC(2026, 7, 5 + index, 14, 30));
        row.getCell(11).numFmt = 'm"/"d;@';
        row.getCell(12).numFmt = 'm"/"d h:mm';
        row.getCell(13).value = "비고";
        row.getCell(7).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
        row.getCell(7).alignment = { wrapText: true, vertical: "top" };
        row.height = 85;
        if (fileId === "A" && index === 1) row.hidden = true;
      }
      sheet.autoFilter = "B4:M6";
      if (withImages) {
        for (const column of [4, 5]) {
          const image = book.addImage({ buffer: WIDE_PNG as unknown as ExcelJS.Buffer, extension: "png" });
          sheet.addImage(image, { tl: { col: column + 0.1, row: 4.15 }, br: { col: column + 0.8, row: 5.2 } } as unknown as ExcelJS.ImageRange);
        }
        const logo = book.addImage({ buffer: PIXEL_PNG as unknown as ExcelJS.Buffer, extension: "png" });
        sheet.addImage(logo, { tl: { col: 1.1, row: 0.1 }, ext: { width: 16, height: 16 } });
      }
    }, fileId);
  }

  it("extends the target's period columns with a source's new months and leaves a Bank the target lacks for review", async () => {
    const documents = [
      await summaryDocument("A", ["2026.01", "2026.02"]),
      await summaryDocument("B", ["2025.12", "2026.02", "2026.03", "2026.04"]),
      await bankDocument("C", "FF284878", false),
    ];
    const draft = buildAggregation(documents);
    expect(draft.targets.map((target) => [target.name, target.kind])).toEqual([["개선 Bank Summary", "records"], ["개선 Bank", "source"]]);
    expect(draft.targets[0].recordCount).toBe(4);
    expect(draft.workbooks[2].sheets[0].plan.kind).toBe("unmatched");
    const output = await reopen((await aggregationXlsxExport(draft, defaultSelection(draft), documents)).content);
    expect(output.worksheets.map((sheet) => sheet.name)).toEqual(["개선 Bank Summary"]);
    const sheet = output.getWorksheet("개선 Bank Summary")!;
    expect(sheet.getRow(1).values).toEqual(expect.arrayContaining(["2025.12", "2026.01", "2026.02", "2026.03", "2026.04"]));
    expect(sheet.getRow(1).values).not.toContain("2026.02 (2)");
  });

  it("keeps parent/child fields, typed date and DateTime, general numbers, template styles and image slots after reopening", async () => {
    const a = await bankDocument("A", "FF284878", true);
    const b = await bankDocument("B", "FF876743", true);
    const draft = buildAggregation([a, b]);
    expect(draft.targets.map((target) => target.name)).toEqual(["개선 Bank"]);
    const headers = draft.workbooks[0].sheets[0].regions[0].headers;
    expect(headers).toEqual(expect.arrayContaining(["Figure > Before", "Figure > After", "진행 현황 > 등록", "진행 현황 > 종료"]));
    const recordImages = draft.records.flatMap((record) => record.media.map((media) => [record.id, media.role]));
    expect(recordImages).toHaveLength(4);
    expect(recordImages.filter(([, role]) => role === "Figure > Before")).toHaveLength(2);
    expect(recordImages.filter(([, role]) => role === "Figure > After")).toHaveLength(2);
    const output = await reopen((await aggregationXlsxExport(draft, defaultSelection(draft), [a, b])).content);
    expect(output.worksheets.map((sheet) => sheet.name)).toEqual(["개선 Bank"]);
    const sheet = output.getWorksheet("개선 Bank")!;
    expect(sheet.model.merges).toEqual(expect.arrayContaining(["E3:F3", "K3:L3"]));
    expect(sheet.getCell("E4").value).toBe("Before");
    expect(sheet.getCell("F4").value).toBe("After");
    expect(sheet.getCell("G5").value).toBe("문제 A-1");
    expect(sheet.getCell("H7").value).toBe("개선 B-1");
    expect(sheet.getCell("J5").value).toBe(46195);
    expect(sheet.getCell("J5").numFmt).toBe("#,##0");
    expect(sheet.getCell("K5").value).toBeInstanceOf(Date);
    expect((sheet.getCell("K5").value as Date).toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(sheet.getCell("K5").numFmt).toBe('m"/"d;@');
    expect(sheet.getCell("K6").value).toBeInstanceOf(Date);
    expect(sheet.getCell("L5").value).toBeInstanceOf(Date);
    expect((sheet.getCell("L5").value as Date).toISOString()).toBe("2026-08-05T14:30:00.000Z");
    expect(sheet.getCell("L5").numFmt).toBe('m"/"d h:mm');
    expect(fillArgb(sheet.getCell("B3"))).toBe("FF284878");
    expect(fillArgb(sheet.getCell("G8"))).toBe("FF284878");
    expect(sheet.getColumn(7).width).toBe(40);
    expect(sheet.getRow(3).height).toBe(26);
    expect(sheet.getRow(6).hidden).toBe(true);
    expect(sheet.getRow(8).hidden).toBe(false);
    expect(sheet.getRow(8).height).toBeGreaterThanOrEqual(85);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 4 });
    expect(sheet.autoFilter).toBeTruthy();
    const images = sheet.getImages();
    expect(images).toHaveLength(5);
    expect(output.model.media).toHaveLength(5);
    const anchors = images.map((image) => [image.range.tl.nativeCol, image.range.tl.nativeRow]);
    expect(anchors).toEqual(expect.arrayContaining([[4, 4], [5, 4], [4, 6], [5, 6]]));
    // Each record picture fills its own cell: both corners inside the one cell.
    const recordPictures = images.filter((image) => image.range.tl.nativeRow >= 4);
    expect(recordPictures.every((image) => image.range.br.nativeCol === image.range.tl.nativeCol && image.range.br.nativeRow === image.range.tl.nativeRow)).toBe(true);
    expect(sheet.getRow(4).values).not.toContain("이미지");
    expect(sheet.getRow(4).values).not.toContain("출처 파일");
  });

  it("uses image center for semantic column and keeps a picture no row owns where the template had it", async () => {
    const document = await documentOf((book) => {
      const sheet = book.addWorksheet("사진");
      sheet.addRows([["관리 No", "Before", "After", "내용"], ["ID-01", null, null, "현상"], ["ID-02", null, null, "개선"]]);
      const centered = book.addImage({ buffer: WIDE_PNG as unknown as ExcelJS.Buffer, extension: "png" });
      sheet.addImage(centered, { tl: { col: 1.6, row: 1.1 }, br: { col: 2.5, row: 1.9 } } as unknown as ExcelJS.ImageRange);
      const tied = book.addImage({ buffer: PIXEL_PNG as unknown as ExcelJS.Buffer, extension: "png" });
      sheet.addImage(tied, { tl: { col: 1.1, row: 1.5 }, br: { col: 1.9, row: 2.5 } } as unknown as ExcelJS.ImageRange);
    }, "span");
    const draft = buildAggregation([document]);
    expect(draft.records.map((record) => record.media.map((image) => image.role))).toEqual([["After"], []]);
    const output = await reopen((await aggregationXlsxExport(draft, defaultSelection(draft), [document])).content);
    const pictures = output.getWorksheet("사진")!.getImages();
    expect(pictures.map((image) => [image.range.tl.nativeCol, image.range.tl.nativeRow])).toEqual([[2, 1], [1, 1]]);
    expect(output.getWorksheet("첨부 이미지")).toBeUndefined();
  });

  it("retains each record image when two selected workbooks have identical bytes", async () => {
    const bytes = await workbookBytes((book) => {
      const sheet = book.addWorksheet("사진");
      sheet.addRows([["관리 No", "Before", "After", "내용"], ["ID-01", null, null, "현상"], ["ID-02", null, null, "개선"]]);
      for (const column of [1, 2]) {
        const image = book.addImage({ buffer: PIXEL_PNG as unknown as ExcelJS.Buffer, extension: "png" });
        sheet.addImage(image, { tl: { col: column + 0.1, row: 1.1 }, ext: { width: 20, height: 20 } });
      }
    });
    const documents = await Promise.all(["same-a", "same-b"].map((fileId) =>
      parseDocument({ fileId, fileName: `${fileId}.xlsx`, bytes })));
    expect(documents[0].media?.[0].id).toBe(documents[1].media?.[0].id);
    const draft = buildAggregation(documents);
    const output = await reopen((await aggregationXlsxExport(draft, defaultSelection(draft), documents)).content);
    const sheet = output.getWorksheet("사진")!;
    expect(output.worksheets).toHaveLength(1);
    expect(sheet.getImages()).toHaveLength(4);
    expect(sheet.getImages().map((image) => [image.range.tl.nativeCol, image.range.tl.nativeRow]))
      .toEqual(expect.arrayContaining([[1, 1], [2, 1], [1, 3], [2, 3]]));
  });

  it("leaves normalized header collisions for review instead of merging two source columns", async () => {
    const draft = await aggregate((book) => {
      book.addWorksheet("관리").addRows([
        ["관리 No", "관리 N/O", "상태"],
        ["A-01", "B-01", "진행"],
        ["A-02", "B-02", "완료"],
      ]);
    });
    const colliding = draft.mappings.filter((mapping) => mapping.targetField === "관리 No" || mapping.targetField === "관리 N/O");
    expect(colliding).toHaveLength(2);
    expect(colliding.every((mapping) => mapping.status === "review" && mapping.sourceFields.length === 1)).toBe(true);
  });

  it("does not combine unrelated tables merely because their source sheet names coincide", async () => {
    const period = await documentOf((book) => {
      book.addWorksheet("Summary").addRows([
        ["구분", "Total", "%", "2026.01"],
        ["안전", 4, 0.5, 2],
        ["품질", 4, 0.5, 2],
      ]);
    }, "period");
    const stock = await documentOf((book) => {
      book.addWorksheet("Summary").addRows([
        ["품목", "입고", "출고", "재고"],
        ["볼트", 12, 4, 8],
        ["너트", 9, 3, 6],
      ]);
    }, "stock");
    const draft = buildAggregation([period, stock]);
    expect(draft.targets.map((target) => [target.name, target.kind])).toEqual([["Summary", "records"], ["Summary", "source"]]);
    const selection = defaultSelection(draft);
    const byDefault = await reopen((await aggregationXlsxExport(draft, selection, [period, stock])).content);
    expect(byDefault.worksheets.map((sheet) => sheet.name)).toEqual(["Summary"]);
    const both = await reopen((await aggregationXlsxExport(draft, { ...selection, sheetIds: [...selection.sheetIds, draft.workbooks[1].sheets[0].id] }, [period, stock])).content);
    expect(both.worksheets.map((sheet) => sheet.name)).toEqual(["Summary", "Summary (2)"]);
  });

  it("maps text, dotted, and typed-date header cells to one actual calendar field", async () => {
    const dates = ["2026-01-01", "2026.1.1", new Date(Date.UTC(2026, 0, 1))];
    const documents = await Promise.all(dates.map((header, index) => documentOf((book) => {
      const sheet = book.addWorksheet("기간");
      sheet.addRows([["구분", "Total", header], ["운영", 2, index + 1], ["품질", 3, index + 2]]);
      if (header instanceof Date) sheet.getCell("C1").numFmt = "yyyy.mm.dd";
    }, `date-${index}`)));
    const draft = buildAggregation(documents);
    expect(draft.targets).toHaveLength(1);
    expect(draft.mappings.filter((mapping) => mapping.sourceFields.some((field) => field.field.includes("2026")))).toHaveLength(1);
    expect(draft.targets[0].fields.filter((field) => field.includes("2026"))).toHaveLength(1);
    const sheet = (await reopen((await aggregationXlsxExport(draft, defaultSelection(draft), documents)).content)).getWorksheet("기간")!;
    expect(sheet.getCell("C1").value).toBe("2026-01-01");
  });
});

describe("first selected workbook as the target", () => {
  const TARGET_FILL = "FFFFF2CC";
  const SOURCE_FILL = "FFDDEBF7";

  interface BankOptions {
    fileId: string;
    /** First table column: the target starts at B, a source may start at C. */
    start: number;
    records: number;
    keyLabel: string;
    problemLabel: string;
    serialDates: boolean;
    fill: string;
    images: Array<{ record: number; field: "Before" | "After"; count?: number }>;
    summary?: boolean;
  }

  /** A department's 개선 Bank: two-row headers, merged parents, a month helper left of the table. */
  async function improvementBank(options: BankOptions) {
    return documentOf((book) => {
      if (options.summary) {
        const summary = book.addWorksheet("개선 Bank Summary");
        summary.getCell("B4").value = "구분";
        summary.getCell("C4").value = "Total";
        for (let month = 1; month <= 12; month += 1) {
          const cell = summary.getCell(4, 4 + month);
          cell.value = new Date(Date.UTC(2026, month - 1, 1));
          cell.numFmt = "mmm";
        }
        ["Safety", "Quality"].forEach((label, index) => {
          const row = 5 + index;
          summary.getCell(row, 2).value = label;
          summary.getCell(row, 3).value = { formula: `SUM(E${row}:P${row})`, result: 1 };
          for (let month = 1; month <= 12; month += 1) {
            const column = String.fromCharCode(68 + month);
            summary.getCell(row, 4 + month).value = { formula: `COUNTIFS('개선 Bank'!$D:$D,LEFT($B${row},1),'개선 Bank'!$A:$A,MONTH(${column}$4))`, result: 0 };
          }
        });
        summary.getCell("B8").value = "등록 건수";
        summary.getCell("C8").value = { formula: `COUNTA('개선 Bank'!$B$5:$B$${4 + options.records})`, result: options.records };
      }
      const sheet = book.addWorksheet("개선 Bank", { views: [{ state: "frozen", ySplit: 4 }] });
      const at = (offset: number) => options.start + offset;
      sheet.getCell(1, at(0)).value = "□ 2026 개선 Bank";
      const fields = [options.keyLabel, "공장", "구분", "Figure", "Figure", options.problemLabel, "개선 결과", "제안자", "N/O", "진행 현황", "진행 현황", "비고"];
      fields.forEach((label, offset) => { sheet.getCell(3, at(offset)).value = label; });
      ["Before", "After"].forEach((label, index) => { sheet.getCell(4, at(3 + index)).value = label; });
      ["등록", "종료"].forEach((label, index) => { sheet.getCell(4, at(9 + index)).value = label; });
      for (const offset of [0, 1, 2, 5, 6, 7, 8, 11]) sheet.mergeCells(3, at(offset), 4, at(offset));
      sheet.mergeCells(3, at(3), 3, at(4));
      sheet.mergeCells(3, at(9), 3, at(10));
      for (let offset = 0; offset < 12; offset += 1) {
        sheet.getCell(3, at(offset)).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
        sheet.getColumn(at(offset)).width = offset === 3 || offset === 4 ? 20 : offset === 5 || offset === 6 ? 40 : 11;
      }
      for (let index = 0; index < options.records; index += 1) {
        const rowNumber = 5 + index;
        const row = sheet.getRow(rowNumber);
        row.height = 90;
        const values: Array<[number, ExcelJS.CellValue]> = [
          [0, `${options.fileId}-${index + 1}`],
          [1, "BP"],
          [2, index % 2 === 0 ? "S" : "Q"],
          [5, `${options.fileId} 문제 ${index + 1}`],
          [6, `${options.fileId} 개선 ${index + 1}`],
          [7, "제안자"],
          [8, 46248],
          [11, "개선제안"],
        ];
        for (const [offset, value] of values) row.getCell(at(offset)).value = value;
        row.getCell(at(8)).numFmt = "#,##0";
        for (const offset of [9, 10]) {
          const cell = row.getCell(at(offset));
          if (options.serialDates) {
            cell.value = 46248;
          } else {
            cell.value = new Date(Date.UTC(2026, 7, 14));
            cell.numFmt = 'm"/"d;@';
          }
        }
        for (let offset = 0; offset < 12; offset += 1) {
          row.getCell(at(offset)).fill = { type: "pattern", pattern: "solid", fgColor: { argb: options.fill } };
        }
        // Month helper left of the table: the target types it, a source computes it.
        row.getCell(at(-1)).value = options.serialDates
          ? { formula: `MONTH(${String.fromCharCode(64 + at(9))}${rowNumber})`, result: 8 }
          : 8;
      }
      for (const image of options.images) {
        const column = at(image.field === "Before" ? 3 : 4) - 1;
        for (let copy = 0; copy < (image.count ?? 1); copy += 1) {
          const id = book.addImage({ buffer: WIDE_PNG as unknown as ExcelJS.Buffer, extension: "png" });
          sheet.addImage(id, { tl: { col: column + 0.1 + copy * 0.4, row: 3 + image.record + 0.1 }, br: { col: column + 0.45 + copy * 0.4, row: 3 + image.record + 0.8 } } as unknown as ExcelJS.ImageRange);
        }
      }
    }, options.fileId);
  }

  async function targetAndSource() {
    const target = await improvementBank({
      fileId: "T", start: 2, records: 3, keyLabel: "R", problemLabel: "문제점", serialDates: false, fill: TARGET_FILL,
      images: [{ record: 1, field: "Before" }], summary: true,
    });
    const source = await improvementBank({
      fileId: "S", start: 3, records: 6, keyLabel: "관리 No", problemLabel: "현상 파악", serialDates: true, fill: SOURCE_FILL,
      images: [{ record: 1, field: "Before" }, { record: 1, field: "After" }, { record: 2, field: "Before", count: 2 }], summary: true,
    });
    const documents = [target, source];
    const draft = buildAggregation(documents);
    const exported = await aggregationXlsxExport(draft, defaultSelection(draft), documents);
    return { draft, documents, exported, output: await reopen(exported.content) };
  }

  it("appends the source's six records under the target's three in one sheet with the target's headers", async () => {
    const { draft, output } = await targetAndSource();

    expect(draft.targets.map((target) => [target.name, target.kind])).toEqual([["개선 Bank Summary", "calculated"], ["개선 Bank", "records"]]);
    expect(draft.workbooks[1].sheets.map((sheet) => sheet.plan.kind)).toEqual(["summarized", "append"]);
    expect(output.worksheets.map((sheet) => sheet.name)).toEqual(["개선 Bank Summary", "개선 Bank"]);
    const sheet = output.getWorksheet("개선 Bank")!;
    expect(Array.from({ length: 10 }, (_, index) => sheet.getCell(5 + index, 2).value)).toEqual(["T-1", "T-2", "T-3", "S-1", "S-2", "S-3", "S-4", "S-5", "S-6", null]);
    // Target headers stay; the source's own names and column letters do not appear.
    expect(sheet.getCell("B3").value).toBe("R");
    expect(sheet.getCell("G3").value).toBe("문제점");
    expect([3, 4].flatMap((row) => (sheet.getRow(row).values as ExcelJS.CellValue[]))).not.toContain("현상 파악");
    expect(sheet.getCell("G8").value).toBe("S 문제 1");
    expect(sheet.getCell("C8").value).toBe("BP");
    expect(sheet.getCell("D9").value).toBe("Q");
    expect(sheet.getCell("N8").value).toBeNull();
    const problem = draft.mappings.find((mapping) => mapping.targetField === "문제점")!;
    expect(problem).toMatchObject({ status: "suggested", included: true, targetColumn: 7 });
    expect(draft.mappings.find((mapping) => mapping.targetField === "R")).toMatchObject({ status: "review", included: true });
  });

  it("restores a source serial into the target's date columns but keeps a count a number", async () => {
    const { draft, documents, output } = await targetAndSource();
    const sheet = output.getWorksheet("개선 Bank")!;

    for (const address of ["K8", "L8", "K13"]) {
      expect(sheet.getCell(address).value).toBeInstanceOf(Date);
      expect((sheet.getCell(address).value as Date).toISOString()).toBe("2026-08-14T00:00:00.000Z");
      expect(sheet.getCell(address).numFmt).toBe('m"/"d;@');
    }
    expect(sheet.getCell("J8").value).toBe(46248);
    expect(sheet.getCell("J8").numFmt).toBe("#,##0");
    // The preview reads the same way the workbook shows it.
    const registered = draft.mappings.find((mapping) => mapping.targetField === "진행 현황 > 등록")!;
    const sourceRecord = draft.records.find((record) => record.sheetId.startsWith(documents[1].fileId) && record.fields.some((field) => field.value.displayValue === "S-1"))!;
    expect(targetCell(mappedFields(sourceRecord, registered), registered).display).toBe("8/14");
    const count = draft.mappings.find((mapping) => mapping.targetField === "N/O")!;
    expect(targetCell(mappedFields(sourceRecord, count), count).value).toBe(46248);
  });

  it("styles appended rows from the target's data row, never the source's", async () => {
    const { output } = await targetAndSource();
    const sheet = output.getWorksheet("개선 Bank")!;
    for (const row of [8, 13]) {
      expect(fillArgb(sheet.getCell(row, 7))).toBe(TARGET_FILL);
      expect(sheet.getRow(row).height).toBe(90);
    }
    expect(sheet.getColumn(7).width).toBe(40);
    expect(sheet.model.merges).toEqual(expect.arrayContaining(["E3:F3", "K3:L3", "B3:B4"]));
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 4 });
  });

  it("keeps the summary's workbook formulas live over the final rows", async () => {
    const { output, exported } = await targetAndSource();
    const summary = output.getWorksheet("개선 Bank Summary")!;
    const bank = output.getWorksheet("개선 Bank")!;

    expect(summary.getCell("E5").value).toMatchObject({ formula: "COUNTIFS('개선 Bank'!$D:$D,LEFT($B5,1),'개선 Bank'!$A:$A,MONTH(E$4))" });
    expect(summary.getCell("C8").value).toMatchObject({ formula: "COUNTA('개선 Bank'!$B$5:$B$13)" });
    // The month the summary counts on: typed in the target's rows, computed for appended rows.
    expect(bank.getCell("A5").value).toBe(8);
    expect(Array.from({ length: 6 }, (_, index) => bank.getCell(8 + index, 1).value)).toEqual(
      Array.from({ length: 6 }, (_, index) => ({ formula: `MONTH(K${8 + index})` })),
    );
    const parts = unzipSync(exported.content);
    expect(strFromU8(parts["xl/workbook.xml"])).toContain('fullCalcOnLoad="1"');
    expect(Object.keys(parts).some((part) => /externalLink|vbaProject/iu.test(part))).toBe(false);
  });

  it("fills each picture's own Before or After cell, cropping to cover and tiling several", async () => {
    const { output, exported } = await targetAndSource();
    const sheet = output.getWorksheet("개선 Bank")!;
    const pictures = sheet.getImages().map((image) => ({ tl: image.range.tl, br: image.range.br }));
    const at = (column: number, row: number) => pictures.filter(({ tl, br }) => tl.nativeCol === column - 1 && tl.nativeRow === row - 1 && br.nativeCol === column - 1 && br.nativeRow === row - 1);

    expect(at(5, 5)).toHaveLength(1);
    expect(at(5, 8)).toHaveLength(1);
    expect(at(6, 8)).toHaveLength(1);
    const tiles = at(5, 9);
    expect(tiles).toHaveLength(2);
    const [left, right] = [...tiles].sort((a, b) => a.tl.nativeColOff - b.tl.nativeColOff);
    expect(left.br.nativeColOff).toBeLessThanOrEqual(right.tl.nativeColOff);
    expect(pictures).toHaveLength(5);
    expect(output.worksheets.some((entry) => entry.name === "첨부 이미지")).toBe(false);

    const drawing = Object.entries(unzipSync(exported.content)).find(([name]) => /drawings\/drawing\d+\.xml$/u.test(name) && strFromU8(unzipSync(exported.content)[name]).includes("xdr:pic"))!;
    const xml = strFromU8(drawing[1]);
    expect(xml.match(/editAs="twoCell"/gu)).toHaveLength(5);
    // A 2:1 picture in a taller cell keeps its ratio by cropping its sides equally.
    const crops = [...xml.matchAll(/<a:srcRect l="(\d+)" t="(\d+)" r="(\d+)" b="(\d+)"\/>/gu)];
    expect(crops.length).toBeGreaterThan(0);
    expect(crops.every(([, l, t, r, b]) => l === r && t === b && (Number(l) > 0) !== (Number(t) > 0))).toBe(true);
  });

  it("reads a picture placed in a cell as that record's image", async () => {
    const files = unzipSync(await workbookBytes((book) => {
      book.addWorksheet("사진").addRows([["관리 No", "Before", "내용"], ["ID-01", null, "현상"], ["ID-02", null, "개선"]]);
    }));
    const sheetPath = "xl/worksheets/sheet1.xml";
    files[sheetPath] = strToU8(strFromU8(files[sheetPath]).replace(/<c r="B2"[^>]*\/>|<c r="B2"[^>]*>[\s\S]*?<\/c>/u, "").replace(/(<c r="A2"[^>]*>[\s\S]*?<\/c>)/u, '$1<c r="B2" t="e" vm="1"><v>#VALUE!</v></c>'));
    files["xl/metadata.xml"] = strToU8('<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xlrd="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata"><futureMetadata name="XLRICHVALUE" count="1"><bk><extLst><ext uri="{x}"><xlrd:rvb i="0"/></ext></extLst></bk></futureMetadata><valueMetadata count="1"><bk><rc t="1" v="0"/></bk></valueMetadata></metadata>');
    files["xl/richData/rdrichvalue.xml"] = strToU8('<rvData xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="1"><rv s="0"><v>0</v><v>5</v></rv></rvData>');
    files["xl/richData/rdrichvaluestructure.xml"] = strToU8('<rvStructures xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="1"><s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/></s></rvStructures>');
    files["xl/richData/richValueRel.xml"] = strToU8('<richValueRels xmlns="http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><rel r:id="rId1"/></richValueRels>');
    files["xl/richData/_rels/richValueRel.xml.rels"] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>');
    files["xl/media/image1.png"] = new Uint8Array(WIDE_PNG);
    const document = await parseDocument({ fileId: "in-cell", fileName: "in-cell.xlsx", bytes: zipSync(files) });

    expect(document.workbookSheets?.[0].table.rows[1][1]).toMatchObject({ display: "", value: null });
    const draft = buildAggregation([document]);
    expect(draft.records[0].media.map((media) => media.role)).toEqual(["Before"]);
    const output = await reopen((await aggregationXlsxExport(draft, defaultSelection(draft), [document])).content);
    expect(output.getWorksheet("사진")!.getImages().map((image) => [image.range.tl.nativeCol, image.range.tl.nativeRow])).toEqual([[1, 1]]);
  });
});
