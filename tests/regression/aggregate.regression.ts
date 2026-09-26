import ExcelJS from "exceljs";
import { expect, type Page } from "@playwright/test";
import { createXlsx } from "../fixtures";
import { regressionCase, writeFixture, upload, openView, selectFiles, noHorizontalOverflow } from "./record";

type Row = (string | number | null)[];
const headers = ["부서", "금액", "상태"];
const baseRows: Row[] = [["본사", 100, "완료"], ["영업", 200, "진행"]];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZsXcAAAAASUVORK5CYII=", "base64");

async function workbook(sheets: Record<string, Row[]>, configure?: (book: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  if (!configure) return createXlsx(Object.fromEntries(Object.entries(sheets).map(([name, rows]) => [name, rows.map((row) => row.map((cell) => cell ?? ""))])));
  const book = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) book.addWorksheet(name).addRows(rows);
  configure(book);
  return new Uint8Array(await book.xlsx.writeBuffer() as ArrayBuffer);
}

async function styled(sheets: Record<string, Row[]>, configure?: (book: ExcelJS.Workbook) => void) {
  return workbook(sheets, (book) => {
    for (const sheet of book.worksheets) {
      sheet.getColumn(1).width = 26;
      sheet.getCell("A1").font = { bold: true, color: { argb: "FF2455AA" } };
    }
    configure?.(book);
  });
}

async function begin(page: Page, items: readonly (readonly [string, Uint8Array | string | Promise<Uint8Array>])[]) {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  const names: string[] = [];
  for (const [name, bytes] of items) {
    const file = await writeFixture(name, await bytes);
    await upload(page, file);
    names.push(file);
  }
  await openView(page, "취합");
  await selectFiles(page, ...names);
  return names;
}

async function run(page: Page) {
  await page.getByRole("button", { name: "취합 실행" }).click();
  const panel = page.locator(".aggregation-results");
  await expect(panel.locator(".result-status")).toHaveText("취합 완료");
  return panel;
}

async function downloaded(page: Page) {
  const pending = page.waitForEvent("download");
  await page.locator(".aggregation-results").getByRole("button", { name: "XLSX 다운로드" }).click();
  const file = await pending;
  expect(file.suggestedFilename()).toBe("worklens-aggregation.xlsx");
  const output = new ExcelJS.Workbook();
  await output.xlsx.readFile((await file.path())!);
  for (const sheet of output.worksheets) sheet.eachRow((row) => row.eachCell((cell) => expect(String(cell.value)).not.toContain("#REF!")));
  return output;
}

function values(sheet: ExcelJS.Worksheet): Row[] {
  return Array.from({ length: sheet.rowCount }, (_, index) =>
    Array.from({ length: sheet.columnCount }, (__, column) => sheet.getCell(index + 1, column + 1).value as string | number | null));
}

function verify(book: ExcelJS.Workbook, expected: Record<string, Row[]>, styledSheets: readonly string[] = ["실적"]) {
  expect(book.worksheets.map((sheet) => sheet.name)).toEqual(Object.keys(expected));
  for (const [name, rows] of Object.entries(expected)) {
    const sheet = book.getWorksheet(name)!;
    expect(values(sheet)).toEqual(rows);
    expect(sheet.rowCount).toBe(rows.length);
    if (styledSheets.includes(name)) {
      expect(sheet.getColumn(1).width).toBe(26);
      expect(sheet.getCell("A1").font.bold).toBe(true);
    }
    for (const row of rows.slice(1)) expect(row.some((cell) => cell !== null && cell !== "")).toBe(true);
  }
}

const standard = (name: string, data = baseRows) => [name, styled({ 실적: [headers, ...data] })] as const;
const extra = (name: string, rows: Row[], heading = headers) => [name, workbook({ 실적: [heading, ...rows] })] as const;

regressionCase({ id: "AGG-01", category: "Aggregate", input: "base and one target", format: "XLSX", structure: "identical three-column sheets", expected: "Rows concatenate, number types and template formatting persist", mobile: true }, async ({ page, note }) => {
  await begin(page, [standard("agg01-base.xlsx"), extra("agg01-target.xlsx", [["지원", 300, "완료"]])]);
  const panel = await run(page);
  await expect(panel.locator(".aggregation-result-sheets li strong")).toHaveText(["실적"]);
  verify(await downloaded(page), { 실적: [headers, ...baseRows, ["지원", 300, "완료"]] });
  await noHorizontalOverflow(page);
  note("One result sheet, three records; numeric 300 and the base width/font survived download.");
});

regressionCase({ id: "AGG-02", category: "Aggregate", input: "base and four targets", format: "XLSX", structure: "five files, one matched sheet each", expected: "All records append in selected file order" }, async ({ page, note }) => {
  const names = ["동부", "서부", "남부", "북부"];
  await begin(page, [standard("agg02-base.xlsx"), ...names.map((name, i) => extra(`agg02-${i}.xlsx`, [[name, (i + 3) * 100, "완료"]]))]);
  await run(page);
  verify(await downloaded(page), { 실적: [headers, ...baseRows, ...names.map((name, i) => [name, (i + 3) * 100, "완료"])] });
  note("Five files yielded six ordered records without truncation or blank rows.");
});

regressionCase({ id: "AGG-03", category: "Aggregate", input: "same schema across two populated targets", format: "XLSX", structure: "both sources carry two rows", expected: "Every source row appears once" }, async ({ page, note }) => {
  const a: Row[] = [["개발", 11, "완료"], ["기획", 12, "진행"]];
  const b: Row[] = [["구매", 13, "완료"], ["재무", 14, "진행"]];
  await begin(page, [standard("agg03-base.xlsx"), extra("agg03-a.xlsx", a), extra("agg03-b.xlsx", b)]);
  await run(page);
  verify(await downloaded(page), { 실적: [headers, ...baseRows, ...a, ...b] });
  note("Two multi-row targets retained their four separate numeric records.");
});

regressionCase({ id: "AGG-04", category: "Aggregate", input: "reordered source columns", format: "XLSX", structure: "source has 금액, 상태, 부서 order", expected: "Headers map by name, not position" }, async ({ page, note }) => {
  await begin(page, [standard("agg04-base.xlsx"), extra("agg04-reordered.xlsx", [[321, "완료", "법무"]], ["금액", "상태", "부서"])]);
  await run(page);
  verify(await downloaded(page), { 실적: [headers, ...baseRows, ["법무", 321, "완료"]] });
  note("Reordered input produced 법무 / numeric 321 / 완료 in base column order.");
});

regressionCase({ id: "AGG-05", category: "Aggregate", input: "missing source column", format: "XLSX", structure: "source omits 상태", expected: "Existing status survives and missing value remains empty" }, async ({ page, note }) => {
  await begin(page, [standard("agg05-base.xlsx"), extra("agg05-missing.xlsx", [["인사", 420]], ["부서", "금액"])]);
  await run(page);
  verify(await downloaded(page), { 실적: [headers, ...baseRows, ["인사", 420, null]] });
  note("Missing 상태 mapped to an empty cell, not a shifted or fabricated value.");
});

regressionCase({ id: "AGG-06", category: "Aggregate", input: "extra source column review", format: "XLSX", structure: "source adds 비고", expected: "Extra field excluded until selected, then included with original value" }, async ({ page, note }) => {
  await begin(page, [standard("agg06-base.xlsx"), extra("agg06-extra.xlsx", [["홍보", 45, "완료", "신규" ]], [...headers, "비고"])]);
  const panel = await run(page);
  const mapping = panel.locator(".aggregation-mapping").filter({ hasText: "비고" });
  await expect(mapping.locator("em")).toHaveText("대응 없음");
  verify(await downloaded(page), { 실적: [headers, ...baseRows, ["홍보", 45, "완료"]] });
  await mapping.getByRole("checkbox").check();
  verify(await downloaded(page), { 실적: [[...headers, "비고"], ...baseRows.map((row) => [...row, null]), ["홍보", 45, "완료", "신규"]] });
  note("Unmatched 비고 was reviewed, excluded by default, then downloaded as a fourth column.");
});

regressionCase({ id: "AGG-07", category: "Aggregate", input: "header name synonyms", format: "XLSX", structure: "부서명 / 매출액 / 비용액 aliases", expected: "Established synonyms map with visible connection" }, async ({ page, note }) => {
  const original = ["부서", "매출", "비용"];
  await begin(page, [["agg07-base.xlsx", await styled({ 실적: [original, ["운영", 100, 20], ["영업", 200, 30]] })], extra("agg07-alias.xlsx", [["법무", 350, 70]], ["부서명", "매출액", "비용액"])]);
  const panel = await run(page);
  await panel.getByRole("button", { name: "전체 매핑 보기" }).click();
  await expect(panel.locator(".aggregation-mapping").filter({ hasText: "부서명" })).toBeVisible();
  verify(await downloaded(page), { 실적: [original, ["운영", 100, 20], ["영업", 200, 30], ["법무", 350, 70]] });
  note("Three synonym headers connected to their canonical base columns with numeric values intact.");
});

regressionCase({ id: "AGG-08", category: "Aggregate", input: "multi-sheet source", format: "XLSX", structure: "matched 실적 plus unmatched 재고 sheet", expected: "Unmatched sheet awaits explicit review and can be included" }, async ({ page, note }) => {
  await begin(page, [standard("agg08-base.xlsx"), ["agg08-source.xlsx", await workbook({ 실적: [headers, ["연구", 515, "완료"]], 재고: [["품목", "재고", "창고"], ["볼트", 10, "A"]] })]]);
  const panel = await run(page);
  const review = panel.locator(".aggregation-workbook").filter({ hasText: "agg08-source.xlsx" }).locator(".aggregation-sheet").filter({ hasText: "재고" }).getByRole("checkbox");
  await expect(review).not.toBeChecked();
  verify(await downloaded(page), { 실적: [headers, ...baseRows, ["연구", 515, "완료"]] });
  await review.check();
  verify(await downloaded(page), { 실적: [headers, ...baseRows, ["연구", 515, "완료"]], 재고: [["품목", "재고", "창고"], ["볼트", 10, "A"]] });
  note("Source 재고 was not silently absorbed; explicit inclusion exported its own sheet and row.");
});

regressionCase({ id: "AGG-09", category: "Aggregate", input: "multi-sheet base", format: "XLSX", structure: "base 실적 and 재고 both matched by source", expected: "Both base sheets grow independently" }, async ({ page, note }) => {
  const stock: Row[] = [["품목", "재고", "창고"], ["볼트", 10, "A"], ["너트", 20, "B"]];
  await begin(page, [["agg09-base.xlsx", await styled({ 실적: [headers, ...baseRows], 재고: stock })], ["agg09-target.xlsx", await workbook({ 실적: [headers, ["지원", 77, "완료"]], 재고: [["품목", "재고", "창고"], ["와셔", 35, "C"]] })]]);
  await run(page);
  verify(await downloaded(page), { 실적: [headers, ...baseRows, ["지원", 77, "완료"]], 재고: [...stock, ["와셔", 35, "C"]] }, ["실적", "재고"]);
  note("Two sheets matched independently and both retained base formatting and numeric values.");
});

regressionCase({ id: "AGG-10", category: "Aggregate", input: "linked record image", format: "XLSX with PNG", structure: "each workbook has one image anchored to its record", expected: "Both picture placements survive at their own rows" }, async ({ page, note }) => {
  const picture = async (label: string, amount: number) => styled({ 실적: [["부서", "금액", "사진"], [label, amount, null]] }, (book) => {
    const image = book.addImage({ buffer: png as unknown as ExcelJS.Buffer, extension: "png" });
    book.getWorksheet("실적")!.addImage(image, { tl: { col: 2.1, row: 1.1 }, br: { col: 2.9, row: 1.9 } } as ExcelJS.ImageRange);
  });
  await begin(page, [["agg10-base.xlsx", await picture("본사", 100)], ["agg10-target.xlsx", await picture("지사", 200)]]);
  await run(page);
  const book = await downloaded(page);
  verify(book, { 실적: [["부서", "금액", "사진"], ["본사", 100, null], ["지사", 200, null]] });
  expect(book.getWorksheet("실적")!.getImages().map((image) => Math.floor(image.range.tl.nativeRow) + 1)).toEqual([2, 3]);
  note("Two source pictures anchored in rows 2 and 3 of the downloaded sheet.");
});

regressionCase({ id: "AGG-11", category: "Aggregate", input: "unlinked source image", format: "XLSX with PNG", structure: "picture outside source table columns", expected: "Unlinked picture appears with provenance on attachment sheet" }, async ({ page, note }) => {
  const source = await workbook({ 실적: [headers, ["고객", 600, "완료"]] }, (book) => {
    const image = book.addImage({ buffer: png as unknown as ExcelJS.Buffer, extension: "png" });
    book.getWorksheet("실적")!.addImage(image, { tl: { col: 5.1, row: 1.1 }, br: { col: 5.9, row: 1.9 } } as ExcelJS.ImageRange);
  });
  await begin(page, [standard("agg11-base.xlsx"), ["agg11-target.xlsx", source]]);
  const panel = await run(page);
  await expect(panel.locator(".aggregation-unlinked")).toContainText("미연결 이미지 1건");
  const book = await downloaded(page);
  const attachment = book.getWorksheet("첨부 이미지")!;
  const range = attachment.getCell("C2").value;
  expect(String(range)).toMatch(/[A-Z]+\d+/u);
  verify(book, {
    실적: [headers, ...baseRows, ["고객", 600, "완료"]],
    "첨부 이미지": [["출처 파일", "출처 시트", "출처 범위", "이미지"], ["agg11-target.xlsx", "실적", range as string, null]],
  });
  expect(attachment.getImages()).toHaveLength(1);
  note("One unlinked PNG retained on an attachment sheet with target filename and source sheet.");
});

regressionCase({ id: "AGG-12", category: "Aggregate", input: "merged base data cells", format: "XLSX", structure: "base D2:E2 merge and source appended row", expected: "Base merge remains and record template merge extends to appended row" }, async ({ page, note }) => {
  const heading = [...headers, "메모"];
  await begin(page, [["agg12-base.xlsx", await styled({ 실적: [heading, ["본사", 100, "완료", "원본"], ["영업", 200, "진행", "기존"]] }, (book) => book.getWorksheet("실적")!.mergeCells("D2:E2"))], extra("agg12-target.xlsx", [["지원", 300, "완료", "추가"]], heading)]);
  await run(page);
  const book = await downloaded(page);
  const sheet = book.getWorksheet("실적")!;
  expect(sheet.getCell("D2").value).toBe("원본");
  expect(sheet.getCell("A4").value).toBe("지원");
  expect(sheet.getCell("B4").value).toBe(300);
  expect(sheet.getCell("C4").value).toBe("완료");
  expect(sheet.getCell("E2").isMerged).toBe(true);
  expect(sheet.getCell("D4").value).toBe("추가");
  expect(sheet.getCell("E4").isMerged).toBe(true);
  expect(sheet.getColumn(1).width).toBe(26);
  expect(sheet.getCell("A1").font.bold).toBe(true);
  expect(sheet.rowCount).toBe(4);
  note("Base D2:E2 merge persisted and new record D4:E4 copied its template merge.");
});

regressionCase({ id: "AGG-13", category: "Aggregate", input: "blank row inside source records", format: "XLSX", structure: "empty source row separates valid records", expected: "Valid records append contiguously without blank output row" }, async ({ page, note }) => {
  await begin(page, [standard("agg13-base.xlsx"), extra("agg13-target.xlsx", [["연구", 400, "완료"], [null, null, null], ["개발", 500, "진행"]])]);
  await run(page);
  verify(await downloaded(page), { 실적: [headers, ...baseRows, ["연구", 400, "완료"], ["개발", 500, "진행"]] });
  note("Blank input row omitted; two separated source records appended contiguously.");
});

regressionCase({ id: "AGG-14", category: "Aggregate", input: "identical duplicate records", format: "XLSX", structure: "base and target contain the same entire row", expected: "Duplicates flagged but not silently deleted" }, async ({ page, note }) => {
  await begin(page, [standard("agg14-base.xlsx"), extra("agg14-target.xlsx", [["본사", 100, "완료"]])]);
  await run(page);
  verify(await downloaded(page), { 실적: [headers, ...baseRows, ["본사", 100, "완료"]] });
  note("Repeated 본사/100/완료 retained twice, including numeric types.");
});

regressionCase({ id: "AGG-15", category: "Aggregate", input: "single base without target", format: "XLSX", structure: "one selected file", expected: "Standalone workbook is downloadable with original rows" }, async ({ page, note }) => {
  await begin(page, [standard("agg15-only.xlsx")]);
  await run(page);
  verify(await downloaded(page), { 실적: [headers, ...baseRows] });
  note("One selected file produced the unchanged two-record styled workbook.");
});

regressionCase({ id: "AGG-16", category: "Aggregate", input: "CSV mixed with Excel", format: "XLSX + CSV", structure: "two selected files then deselect CSV", expected: "Exact warning disables run; deselection restores normal XLSX aggregation", mobile: true }, async ({ page, note, classify }) => {
  const [xlsx, csv] = await begin(page, [standard("agg16-base.xlsx"), ["agg16-extra.csv", "부서,금액,상태\n지원,300,완료\n"]]);
  const warning = page.locator(".aggregation-selection-error");
  await expect(warning.locator("strong")).toHaveText("Excel이 아닌 파일이 포함되어 있습니다.");
  await expect(warning.locator("span")).toHaveText("Excel 파일만 취합할 수 있습니다. 해당 파일을 선택 해제한 후 다시 실행해 주세요.");
  await expect(page.getByRole("button", { name: "취합 실행" })).toBeDisabled();
  await page.getByLabel("agg16-extra.csv 선택", { exact: true }).uncheck();
  await expect(warning).toHaveCount(0);
  await expect(page.getByRole("button", { name: "취합 실행" })).toBeEnabled();
  await run(page);
  verify(await downloaded(page), { 실적: [headers, ...baseRows] });
  expect(xlsx).toContain("agg16-base.xlsx");
  expect(csv).toContain("agg16-extra.csv");
  await noHorizontalOverflow(page);
  classify("Expected");
  note("Mixed CSV produced exact rejection copy and disabled run; unchecking restored downloadable base XLSX.");
});
