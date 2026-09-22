import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { AggregationDraft } from "@/domain/aggregation";
import { buildAggregation } from "@/lib/aggregation/engine";
import { aggregationXlsxExport } from "@/lib/aggregation/export";
import { mergePresentations } from "@/lib/aggregation/pptx-merge";
import { parseDocument } from "@/lib/parsers";
import { strToU8, unzipSync, zipSync } from "fflate";
import { createDocx, createPptxSlides } from "./fixtures";

const RELS = (entries: string) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
const REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * A deck shaped like PowerPoint's own output: master, layout, theme, an image,
 * a chart with its embedded workbook, and a notes slide. Merging has to carry
 * every dependency and leave the notes.
 */
function createAuthoredPptx(titles: readonly string[], image: Uint8Array): Uint8Array {
  const slideOverrides = titles.map((_, index) =>
    `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/><Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>${slideOverrides}</Types>`),
    "_rels/.rels": strToU8(RELS(`<Relationship Id="rId1" Type="${REL_BASE}/officeDocument" Target="ppt/presentation.xml"/>`)),
    "ppt/presentation.xml": strToU8(`<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${REL_BASE}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${titles.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": strToU8(RELS(`<Relationship Id="rId1" Type="${REL_BASE}/slideMaster" Target="slideMasters/slideMaster1.xml"/>${titles.map((_, index) => `<Relationship Id="rId${index + 2}" Type="${REL_BASE}/slide" Target="slides/slide${index + 1}.xml"/>`).join("")}`)),
    "ppt/slideMasters/slideMaster1.xml": strToU8(`<?xml version="1.0"?><p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL_BASE}"><p:cSld><p:spTree/></p:cSld><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": strToU8(RELS(`<Relationship Id="rId1" Type="${REL_BASE}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL_BASE}/theme" Target="../theme/theme1.xml"/>`)),
    "ppt/slideLayouts/slideLayout1.xml": strToU8(`<?xml version="1.0"?><p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sldLayout>`),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(RELS(`<Relationship Id="rId1" Type="${REL_BASE}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>`)),
    "ppt/theme/theme1.xml": strToU8(`<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Authored"/>`),
    "ppt/notesSlides/notesSlide1.xml": strToU8(`<?xml version="1.0"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:notes>`),
    "ppt/charts/chart1.xml": strToU8(`<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart/></c:chartSpace>`),
    "ppt/charts/_rels/chart1.xml.rels": strToU8(RELS(`<Relationship Id="rId1" Type="${REL_BASE}/package" Target="../embeddings/Microsoft_Excel_Worksheet.xlsx"/>`)),
    "ppt/embeddings/Microsoft_Excel_Worksheet.xlsx": strToU8("workbook"),
    "ppt/media/image1.png": image,
  };
  titles.forEach((title, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = strToU8(`<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL_BASE}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="1828800" cy="914400"/></a:xfrm></p:spPr></p:pic></p:spTree></p:cSld></p:sld>`);
    files[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = strToU8(RELS(`<Relationship Id="rId1" Type="${REL_BASE}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL_BASE}/image" Target="../media/image1.png"/><Relationship Id="rId3" Type="${REL_BASE}/notesSlide" Target="../notesSlides/notesSlide1.xml"/><Relationship Id="rId4" Type="${REL_BASE}/chart" Target="../charts/chart1.xml"/>`));
  });
  return zipSync(files);
}

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

describe("generic aggregation", () => {
  it("groups compatible sheets regardless of column order and keeps sheet sources", async () => {
    const draft = await aggregate((workbook) => {
      const bu = workbook.addWorksheet("BU");
      bu.addRows([["부서", "매출", "인원"], ["영업", 1200, 3], ["물류", 900, 5]]);
      const warehouse = workbook.addWorksheet("W-H");
      warehouse.addRows([["인원", "담당부서", "매출액"], [4, "운영", 800], [2, "지원", 400]]);
    });

    expect(draft.output).toBe("xlsx");
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

  it("merges presentations in the selected order without rebuilding slides", async () => {
    const first = createPptxSlides([["9월 교육 운영", "담당: 김하나"], ["일정", "09-30"]]);
    const second = createPptxSlides([["10월 교육 운영", "담당: 박민수"]]);
    const merged = mergePresentations([
      { fileId: "deck-1", fileName: "9월.pptx", bytes: first },
      { fileId: "deck-2", fileName: "10월.pptx", bytes: second },
    ]);

    expect(merged.fileName).toBe("worklens-aggregation.pptx");
    expect(merged.slideCount).toBe(3);
    const reparsed = await parseDocument({ fileId: "merged", fileName: merged.fileName, bytes: merged.content });
    expect(reparsed.metadata.pageCount).toBe(3);
    const bySlide = reparsed.blocks.flatMap((block) => block.type === "paragraph"
      ? [{ slide: block.source.page, text: block.text }]
      : []);
    expect(bySlide.filter((entry) => entry.slide === 1).map((entry) => entry.text)).toEqual(["9월 교육 운영", "담당: 김하나"]);
    expect(bySlide.filter((entry) => entry.slide === 3).map((entry) => entry.text)).toEqual(["10월 교육 운영", "담당: 박민수"]);
  });

  it("carries layouts, masters, themes and images across decks and leaves notes behind", async () => {
    const merged = mergePresentations([
      { fileId: "deck-1", fileName: "1분기.pptx", bytes: createAuthoredPptx(["1분기 실적", "1분기 과제"], PIXEL_PNG) },
      { fileId: "deck-2", fileName: "2분기.pptx", bytes: createAuthoredPptx(["2분기 실적"], PIXEL_PNG) },
    ]);
    const parts = unzipSync(merged.content);
    const names = Object.keys(parts);
    const contentTypes = new TextDecoder().decode(parts["[Content_Types].xml"]);
    const presentation = new TextDecoder().decode(parts["ppt/presentation.xml"]);

    expect(merged.slideCount).toBe(3);
    expect(merged.droppedNotes).toBe(1);
    expect(names.filter((name) => /^ppt\/slides\/slide|^ppt\/slides\/wl/u.test(name))).toHaveLength(3);
    expect(names).toContain("ppt/slideLayouts/wl2_slideLayout1.xml");
    expect(names).toContain("ppt/slideMasters/wl2_slideMaster1.xml");
    expect(names).toContain("ppt/theme/wl2_theme1.xml");
    expect(names).toContain("ppt/media/wl2_image1.png");
    expect(names).toContain("ppt/charts/wl2_chart1.xml");
    expect(names).toContain("ppt/embeddings/wl2_Microsoft_Excel_Worksheet.xlsx");
    expect(names.filter((name) => name.includes("notesSlides"))).toEqual(["ppt/notesSlides/notesSlide1.xml"]);
    expect(contentTypes).toContain('PartName="/ppt/slideLayouts/wl2_slideLayout1.xml"');
    expect((presentation.match(/<p:sldId\b/gu) ?? [])).toHaveLength(3);
    expect((presentation.match(/<p:sldMasterId\b/gu) ?? [])).toHaveLength(2);

    const copiedRels = new TextDecoder().decode(parts["ppt/slides/_rels/wl2_slide1.xml.rels"]);
    expect(copiedRels).toContain("../media/wl2_image1.png");
    expect(copiedRels).toContain("../slideLayouts/wl2_slideLayout1.xml");
    expect(copiedRels).not.toContain("notesSlide");
    expect(copiedRels).toContain("../charts/wl2_chart1.xml");
    expect(new TextDecoder().decode(parts["ppt/charts/_rels/wl2_chart1.xml.rels"]))
      .toContain("../embeddings/wl2_Microsoft_Excel_Worksheet.xlsx");
    expect(contentTypes).toContain('PartName="/ppt/charts/wl2_chart1.xml"');

    const reparsed = await parseDocument({ fileId: "merged", fileName: merged.fileName, bytes: merged.content });
    expect(reparsed.metadata.pageCount).toBe(3);
    expect(reparsed.media).toHaveLength(3);
  });

  it("names a document's table after the document, not its position", async () => {
    const document = await parseDocument({ fileId: "contract", fileName: "계약.docx", bytes: createDocx() });
    const draft = buildAggregation([document]);

    expect(draft.output).toBe("xlsx");
    expect(draft.workbooks[0].sheets.map((sheet) => sheet.name)).toEqual(["계약"]);
    expect(draft.groups.map((group) => group.name)).toEqual(["계약"]);
    const exported = await aggregationXlsxExport(draft, defaultSelection(draft), [document]);
    expect((await reopen(exported.content)).worksheets.map((sheet) => sheet.name)).toEqual(["계약"]);
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
});
