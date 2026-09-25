import ExcelJS from "exceljs";
import { expect, test, type Page } from "@playwright/test";

/**
 * Aggregation through the real UI with workbooks generated here (never files
 * from disk): upload, choose the order, run, adjust the selection, download,
 * then open the downloaded XLSX and check what it actually contains.
 */

const PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZsXcAAAAASUVORK5CYII=", "base64");

async function xlsx(configure: (workbook: ExcelJS.Workbook) => void): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  configure(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer() as ArrayBuffer);
}

async function upload(page: Page, files: ReadonlyArray<readonly [string, Buffer]>) {
  // The file input's handler exists only after hydration; production's first load is slower.
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  for (const [name, buffer] of files) {
    await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
    await expect(page.locator(".file-row").filter({ hasText: name })).toBeVisible();
  }
}

/** Selects the files in the given order (the first becomes the target) and runs aggregation. */
async function aggregate(page: Page, names: readonly string[]) {
  await page.getByRole("button", { name: "취합", exact: true }).click();
  for (const name of names) await page.getByLabel(`${name} 선택`).check();
  await expect(page.locator(".file-row").filter({ hasText: names[0] }).locator(".compare-selection-role")).toHaveText("기준 파일");
  await page.getByRole("button", { name: "취합 실행" }).click();
  const panel = page.locator(".aggregation-results");
  await expect(panel.locator(".result-status")).toHaveText("취합 완료");
  return panel;
}

async function download(page: Page): Promise<ExcelJS.Workbook> {
  const pending = page.waitForEvent("download");
  await page.locator(".aggregation-results").getByRole("button", { name: "XLSX 다운로드" }).click();
  const file = await pending;
  expect(file.suggestedFilename()).toBe("worklens-aggregation.xlsx");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile((await file.path())!);
  return workbook;
}

function rows(sheet: ExcelJS.Worksheet, from = 1): unknown[][] {
  return Array.from({ length: sheet.rowCount - from + 1 }, (_, index) =>
    Array.from({ length: sheet.columnCount }, (__, column) => {
      const value = sheet.getCell(from + index, column + 1).value;
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      if (value && typeof value === "object" && "formula" in value) return `=${(value as { formula: string }).formula}`;
      return value ?? null;
    }));
}

const metric = (panel: ReturnType<Page["locator"]>, label: string) => panel.locator(".check-summary-line .metric").filter({ hasText: label }).locator("b");

const target = () => xlsx((workbook) => {
  const sheet = workbook.addWorksheet("실적");
  sheet.addRows([["부서", "등록일", "매출", "비용"], ["운영", new Date(Date.UTC(2026, 7, 1)), 1200, 300], ["지원", new Date(Date.UTC(2026, 7, 2)), 900, 200]]);
  sheet.getColumn(2).eachCell((cell, row) => { if (row > 1) cell.numFmt = "yyyy-mm-dd"; });
  sheet.getColumn(3).eachCell((cell, row) => { if (row > 1) cell.numFmt = "#,##0"; });
  sheet.getRow(1).eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } }; });
});
// Columns reordered, 비용 missing, dates typed as text.
const reordered = () => xlsx((workbook) => workbook.addWorksheet("실적").addRows([["매출", "부서", "등록일"], [700, "영업", "2026.08.03"], [500, "물류", "2026-08-04"]]));
// An extra field the target lacks.
const extra = () => xlsx((workbook) => workbook.addWorksheet("실적").addRows([["부서", "등록일", "매출", "비용", "비고"], ["구매", "2026-08-05", 400, 100, "신규 거래처"]]));

test("aggregates three generated workbooks by header meaning and downloads a verified XLSX", async ({ page }) => {
  await page.goto("/");
  await upload(page, [["기준_실적.xlsx", await target()], ["순서변경_실적.xlsx", await reordered()], ["추가항목_실적.xlsx", await extra()]]);
  const panel = await aggregate(page, ["기준_실적.xlsx", "순서변경_실적.xlsx", "추가항목_실적.xlsx"]);

  await expect(metric(panel, "취합 레코드")).toHaveText("5");
  await expect(panel.locator(".aggregation-result-sheets li strong")).toHaveText(["실적"]);
  await expect(panel.locator(".aggregation-preview thead th")).toHaveText(["부서", "등록일", "매출", "비용"]);
  // The extra field is offered for review, not merged silently.
  await expect(panel.locator(".aggregation-mapping").filter({ hasText: "비고" })).toBeVisible();

  const output = await download(page);
  expect(output.worksheets.map((sheet) => sheet.name)).toEqual(["실적"]);
  const sheet = output.getWorksheet("실적")!;
  expect(rows(sheet)).toEqual([
    ["부서", "등록일", "매출", "비용"],
    ["운영", "2026-08-01", 1200, 300], ["지원", "2026-08-02", 900, 200],
    ["영업", "2026-08-03", 700, null], ["물류", "2026-08-04", 500, null],
    ["구매", "2026-08-05", 400, 100],
  ]);
  expect(sheet.getCell("C6").numFmt).toBe("#,##0");
  expect(sheet.getCell("B4").numFmt).toBe("yyyy-mm-dd");

  // Included by the user, the extra field becomes a new column for its own row only.
  await panel.locator(".aggregation-mapping").filter({ hasText: "비고" }).getByRole("checkbox").check();
  const withExtra = (await download(page)).getWorksheet("실적")!;
  expect(rows(withExtra).map((row) => row[4] ?? null)).toEqual(["비고", null, null, null, null, "신규 거래처"]);
});

test("follows the first selected workbook as the target in either order", async ({ page }) => {
  await page.goto("/");
  await upload(page, [["기준_실적.xlsx", await target()], ["순서변경_실적.xlsx", await reordered()]]);
  await aggregate(page, ["순서변경_실적.xlsx", "기준_실적.xlsx"]);
  const reversed = (await download(page)).getWorksheet("실적")!;
  // The reordered workbook's layout wins: its column order, and its unstyled header, not the other file's blue fill.
  expect(rows(reversed).map((row) => row.slice(0, 2))).toEqual([["매출", "부서"], [700, "영업"], [500, "물류"], [1200, "운영"], [900, "지원"]]);
  expect(rows(reversed)[0]).toHaveLength(3);
  expect(reversed.getCell("A1").fill?.type).not.toBe("pattern");
});

test("keeps an unmatched sheet for review, recalculates the summary and honours sheet deselection", async ({ page }) => {
  const book = (prefix: string, names: string[], extraSheet: boolean) => xlsx((workbook) => {
    workbook.addWorksheet("데이터").addRows([["부서", "금액", "상태"], ...names.map((name, index) => [`${prefix}-${name}`, (index + 1) * 100, index % 2 ? "완료" : "진행"])]);
    const summary = workbook.addWorksheet("요약");
    summary.addRows([["항목", "값"], ["합계", { formula: `SUM(데이터!B2:B${names.length + 1})`, result: 0 }], ["완료", { formula: `COUNTIF(데이터!C2:C${names.length + 1},"완료")`, result: 0 }]]);
    if (extraSheet) workbook.addWorksheet("재고").addRows([["품목", "재고", "창고"], ["볼트", 10, "A"], ["너트", 20, "B"]]);
  });
  await page.goto("/");
  await upload(page, [["본사.xlsx", await book("본사", ["가", "나", "다"], false)], ["지사.xlsx", await book("지사", ["라", "마"], true)]]);
  const panel = await aggregate(page, ["본사.xlsx", "지사.xlsx"]);
  const sheetBox = (file: string, sheet: string) => panel.locator(".aggregation-workbook").filter({ hasText: file }).locator(".aggregation-sheet").filter({ hasText: sheet }).getByRole("checkbox");

  await expect(panel.locator(".aggregation-result-sheets li strong")).toHaveText(["데이터", "요약"]);
  await expect(sheetBox("지사.xlsx", "재고")).not.toBeChecked();
  await expect(metric(panel, "확인 필요")).not.toHaveText("0");

  const first = await download(page);
  expect(first.worksheets.map((sheet) => sheet.name)).toEqual(["데이터", "요약"]);
  expect(rows(first.getWorksheet("데이터")!, 2).map((row) => row[0])).toEqual(["본사-가", "본사-나", "본사-다", "지사-라", "지사-마"]);
  expect(rows(first.getWorksheet("요약")!, 2).map((row) => row[1])).toEqual(["=SUM(데이터!B2:B6)", "=COUNTIF(데이터!C2:C6,\"완료\")"]);

  await sheetBox("지사.xlsx", "재고").check();
  await sheetBox("지사.xlsx", "데이터").uncheck();
  await expect(metric(panel, "취합 레코드")).toHaveText("5");
  const second = await download(page);
  expect(second.worksheets.map((sheet) => sheet.name)).toEqual(["데이터", "요약", "재고"]);
  expect(rows(second.getWorksheet("데이터")!, 2).map((row) => row[0])).toEqual(["본사-가", "본사-나", "본사-다"]);
  expect(rows(second.getWorksheet("요약")!, 2).map((row) => row[1])).toEqual(["=SUM(데이터!B2:B4)", "=COUNTIF(데이터!C2:C4,\"완료\")"]);
  expect(rows(second.getWorksheet("재고")!, 2)).toEqual([["볼트", 10, "A"], ["너트", 20, "B"]]);
});

test("continues numbering, keeps duplicates and places each record's pictures in its own cell", async ({ page }) => {
  const bank = (prefix: string, count: number) => xlsx((workbook) => {
    const sheet = workbook.addWorksheet("개선 Bank");
    sheet.addRow(["순번", "관리번호", "Before", "After", "내용"]);
    for (let index = 0; index < count; index += 1) sheet.addRow([index + 1, index === 0 ? "BP-01" : `${prefix}-${index + 1}`, null, null, `${prefix} 개선 ${index + 1}`]);
    const image = workbook.addImage({ buffer: PIXEL_PNG as unknown as ExcelJS.Buffer, extension: "png" });
    for (let index = 0; index < count; index += 1) {
      sheet.addImage(image, { tl: { col: 2.1, row: index + 1.1 }, br: { col: 2.9, row: index + 1.9 } } as ExcelJS.ImageRange);
      sheet.addImage(image, { tl: { col: 3.1, row: index + 1.1 }, br: { col: 3.9, row: index + 1.9 } } as ExcelJS.ImageRange);
    }
  });
  await page.goto("/");
  await upload(page, [["개선_본사.xlsx", await bank("HQ", 3)], ["개선_지사.xlsx", await bank("BR", 2)]]);
  const panel = await aggregate(page, ["개선_본사.xlsx", "개선_지사.xlsx"]);
  await expect(metric(panel, "취합 레코드")).toHaveText("5");
  await expect(panel.locator(".aggregation-preview tbody tr").first()).toContainText("이미지 1개");

  const sheet = (await download(page)).getWorksheet("개선 Bank")!;
  expect(rows(sheet, 2).map((row) => [row[0], row[1], row[4]])).toEqual([
    [1, "BP-01", "HQ 개선 1"], [2, "HQ-2", "HQ 개선 2"], [3, "HQ-3", "HQ 개선 3"],
    // The source restarts at 1; the combined list continues. BP-01 appears twice and both rows stay.
    [4, "BP-01", "BR 개선 1"], [5, "BR-2", "BR 개선 2"],
  ]);
  const placed = sheet.getImages().map((image) => `${Math.floor(image.range.tl.nativeRow) + 1}:${Math.floor(image.range.tl.nativeCol) + 1}`).sort();
  expect(placed).toEqual(["2:3", "2:4", "3:3", "3:4", "4:3", "4:4", "5:3", "5:4", "6:3", "6:4"]);
});

test("runs the aggregation flow on a 390px screen without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const longName = "2026년_하반기_전사_부서별_운영실적_최종취합본_검토완료_매우긴파일명.xlsx";
  const wide = () => xlsx((workbook) => workbook.addWorksheet("실적").addRows([
    ["부서", "등록일", "매출", "비용", "아주 긴 항목 이름이 들어간 운영 지표 설명 컬럼"],
    ["운영", "2026-08-01", 1200, 300, "설명"], ["지원", "2026-08-02", 900, 200, "설명"],
  ]));
  await page.goto("/");
  await upload(page, [[longName, await wide()], ["추가항목_실적.xlsx", await extra()]]);
  const panel = await aggregate(page, [longName, "추가항목_실적.xlsx"]);
  await expect(metric(panel, "취합 레코드")).toHaveText("3");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  // 비고 sits in the one unmatched slot between the same neighbours: paired with the
  // long column but flagged for confirmation, and the user can take it back out.
  const pairing = panel.locator(".aggregation-mapping").filter({ hasText: "비고" });
  await expect(pairing.locator("em")).toHaveText("확인");
  await expect(metric(panel, "확인 필요")).toHaveText("1");
  expect(rows((await download(page)).getWorksheet("실적")!, 4)).toEqual([["구매", "2026-08-05", 400, 100, "신규 거래처"]]);
  const include = pairing.getByRole("checkbox");
  await include.scrollIntoViewIfNeeded();
  await include.uncheck();
  expect(rows((await download(page)).getWorksheet("실적")!, 2)).toEqual([
    ["운영", "2026-08-01", 1200, 300, "설명"], ["지원", "2026-08-02", 900, 200, "설명"], ["구매", "2026-08-05", 400, 100, null],
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
