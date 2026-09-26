import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { strToU8, unzipSync, zipSync } from "fflate";
import { createXlsx } from "../fixtures";
import { OUT, openView, regressionCase, selectFiles, upload, writeFixture } from "./record";

type Row = Array<ExcelJS.CellValue>;
type Setup = (book: ExcelJS.Workbook) => void;
const imagePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lY4AAAAASUVORK5CYII=", "base64");

async function bookFile(id: string, configure: Setup): Promise<string> {
  const book = new ExcelJS.Workbook();
  configure(book);
  return writeFixture(`${id}.xlsx`, new Uint8Array(await book.xlsx.writeBuffer() as ArrayBuffer));
}
async function pairs(id: string, rows: Row[], sheet = "자료"): Promise<string> {
  return writeFixture(`${id}.xlsx`, await createXlsx({ [sheet]: rows as Array<Array<string | number>> }));
}
async function ready(page: Page): Promise<void> {
  await page.route("**/api/ai", async (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("[data-hydrated]" )).toHaveAttribute("data-hydrated", "true");
}
function fileRow(page: Page, file: string) {
  return page.locator(".file-row").filter({ hasText: path.basename(file) }).first();
}
async function selectAndRunExtract(page: Page, files: string[], fields: string[] = []): Promise<void> {
  for (const file of files) await upload(page, file);
  await selectFiles(page, ...files);
  await openView(page, "추출");
  if (fields.length) {
    await page.getByRole("radio", { name: "항목 지정" }).check();
    for (const field of fields) {
      await page.getByLabel("추출할 항목").fill(field);
      await page.getByRole("button", { name: "항목 추가" }).click();
    }
  }
  await page.getByRole("button", { name: "추출 실행" }).click();
  await expect(page.locator(".extract-results")).toBeVisible();
}
async function downloadBytes(page: Page, id: string, label: string, extension: string): Promise<Buffer> {
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: label }).click();
  const download = await event;
  expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${extension}$`));
  const saved = path.join(OUT, `${id}-${label.replace(/\s/g, "-")}.${extension}`);
  await download.saveAs(saved);
  return readFile(saved);
}
function csvRows(text: string): string[][] {
  expect(text.charCodeAt(0), "CSV is UTF-8 with BOM").toBe(0xfeff);
  const result: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (c === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); result.push(row); row = []; cell = "";
    } else cell += c;
  }
  expect(quoted).toBe(false);
  if (row.length || cell) result.push([...row, cell]);
  return result;
}
async function checkExtractExports(page: Page, id: string, names: string[], values: string[], recordValues: string[] = []): Promise<string> {
  const table = page.locator(".extract-results");
  for (const value of values) await expect(table, `visible ${value}`).toContainText(value);
  if (recordValues.length) {
    const toggle = table.locator(".extract-records-toggle");
    if (await toggle.count() && await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    await expect(table.locator(".extract-table").first()).toBeVisible();
    for (const value of recordValues) await expect(table.locator(".extract-records"), `record ${value}`).toContainText(value);
  }
  const csv = csvRows((await downloadBytes(page, id, "CSV 다운로드", "csv")).toString("utf8"));
  const output = new ExcelJS.Workbook();
  await output.xlsx.load(new Uint8Array(await downloadBytes(page, id, "XLSX 다운로드", "xlsx")) as unknown as ExcelJS.Buffer);
  const data = output.getWorksheet("Extracted Data");
  expect(data, "data worksheet exists").toBeDefined();
  expect(data!.getColumn(1).values.slice(2)).toEqual(names);
  const allExportCells = output.worksheets.flatMap((sheet) => sheet.getRows(1, sheet.rowCount)?.flatMap((row) => (row.values as ExcelJS.CellValue[]).slice(1).map(String)) ?? []);
  const flatCsv = csv.flat();
  for (const value of values) {
    expect(allExportCells, `XLSX contains ${value}`).toContain(value);
    expect(flatCsv, `CSV contains ${value}`).toContain(value);
  }
  for (const value of recordValues) {
    expect(output.getWorksheet("Records"), "record worksheet exists").toBeDefined();
    expect(allExportCells, `XLSX record ${value}`).toContain(value);
    expect(flatCsv.join(" | "), `CSV record ${value}`).toContain(value);
  }
  return `visible fields/records and CSV + XLSX reopened: ${[...values, ...recordValues].join(", ")}`;
}
async function checkCompareExports(page: Page, id: string, values: string[], mode: "value" | "version", files: number): Promise<string> {
  const panel = page.locator(mode === "value" ? ".value-check-panel" : ".comparison-panel");
  await expect(panel).toBeVisible();
  for (const value of values) await expect(panel).toContainText(value);
  const csv = csvRows((await downloadBytes(page, id, "CSV 다운로드", "csv")).toString("utf8"));
  const output = new ExcelJS.Workbook();
  await output.xlsx.load(new Uint8Array(await downloadBytes(page, id, "XLSX 다운로드", "xlsx")) as unknown as ExcelJS.Buffer);
  const sheet = output.worksheets[0];
  expect(sheet.name).toBe(mode === "value" ? "비교 결과" : "버전 비교");
  if (mode === "value" && files > 2) {
    expect(output.getWorksheet("근거 상세")).toBeDefined();
    expect(sheet.getRow(1).cellCount).toBe(files + 2);
  }
  const cells = sheet.getRows(1, sheet.rowCount)!.flatMap((row) => (row.values as ExcelJS.CellValue[]).slice(1).map(String));
  for (const value of values) {
    expect(cells, `XLSX value ${value}`).toContain(value);
    expect(csv.flat(), `CSV value ${value}`).toContain(value);
  }
  return `${mode} result and CSV + XLSX reopened: ${values.join(", ")}`;
}
async function compare(page: Page, files: string[], mode: "value" | "version"): Promise<void> {
  for (const file of files) await upload(page, file);
  await selectFiles(page, ...files);
  await openView(page, "비교");
  if (mode === "value") await page.getByRole("radio", { name: "값 일치 확인" }).check();
  await page.getByRole("button", { name: "비교 실행" }).click();
  await expect(page.locator(mode === "value" ? ".value-check-panel" : ".comparison-panel")).toBeVisible();
}

// Each structural fixture has a different failure mode: tab visibility, headers,
// record recognition, data extent, or layout; none is a screenshot-only case.
const structureCases: Array<{ id: string; input: string; build: (id: string) => Promise<string>; values: string[]; records?: string[]; sheets?: number; fields?: string[]; mobile?: boolean }> = [
  { id: "XLSX-01", input: "one-sheet key/value workbook", build: (id) => pairs(id, [["담당부서", "운영팀"], ["금액", "145000원"]]), values: ["운영팀", "145000원"], sheets: 1, mobile: true },
  { id: "XLSX-02", input: "two separately named worksheets", build: (id) => bookFile(id, (b) => { b.addWorksheet("서울").addRows([["담당부서", "서울팀"]]); b.addWorksheet("부산").addRows([["금액", "2200원"]]); }), values: ["서울팀", "2200원"], sheets: 2 },
  { id: "XLSX-03", input: "five populated sheets", build: (id) => bookFile(id, (b) => { for (let i = 1; i <= 5; i++) b.addWorksheet(`분기${i}`).addRow([`항목${i}`, `값${i}`]); }), values: ["값1", "값2", "값3", "값4", "값5"], sheets: 5 },
  { id: "XLSX-04", input: "twelve-sheet workbook including final tab", build: (id) => bookFile(id, (b) => { for (let i = 1; i <= 12; i++) b.addWorksheet(`시트${i}`).addRow([`항목${i}`, `자료${i}`]); }), values: ["자료1", "자료12"], sheets: 12 },
  { id: "XLSX-05", input: "empty tab followed by populated tab", build: (id) => bookFile(id, (b) => { b.addWorksheet("빈 시트"); b.addWorksheet("실제 데이터").addRow(["담당부서", "실제팀"]); }), values: ["실제팀"], sheets: 2 },
  { id: "XLSX-06", input: "Korean, numeric-looking, long and near-duplicate tab names", build: (id) => bookFile(id, (b) => { for (const [name, value] of [["2026", "숫자명"], ["매출 보고서", "한국어명"], ["매출보고서", "유사명"], ["아주긴_시트이름_2026년_9월_최종확인본", "긴이름"]]) b.addWorksheet(name).addRow(["담당부서", value]); }), values: ["숫자명", "한국어명", "유사명", "긴이름"], sheets: 4 },
  { id: "XLSX-07", input: "header and records start at row one", build: (id) => bookFile(id, (b) => b.addWorksheet("매출").addRows([["지역", "담당자", "금액"], ["서울", "김나래", "120원"], ["부산", "이도윤", "240원"]])), values: [], records: ["김나래", "이도윤"], sheets: 1 },
  { id: "XLSX-08", input: "key/value table starts at row four", build: (id) => bookFile(id, (b) => { const s = b.addWorksheet("늦은 시작"); s.getCell("A4").value = "담당부서"; s.getCell("B4").value = "늦게시작팀"; }), values: ["늦게시작팀"] },
  { id: "XLSX-09", input: "two key/value tables separated by blank rows", build: (id) => pairs(id, [["금액", "310원"], [], [], ["담당부서", "후반부팀"]]), values: ["310원", "후반부팀"] },
  { id: "XLSX-10", input: "two tables separated by blank columns", build: (id) => bookFile(id, (b) => { const s = b.addWorksheet("나란히"); s.getCell("A1").value = "담당부서"; s.getCell("B1").value = "왼쪽팀"; s.getCell("D1").value = "금액"; s.getCell("E1").value = "410원"; }), values: ["왼쪽팀", "410원"] },
  { id: "XLSX-11", input: "merged title over a two-column value table", build: (id) => bookFile(id, (b) => { const s = b.addWorksheet("병합"); s.mergeCells("A1:B1"); s.getCell("A1").value = "월간 보고"; s.addRow(["담당부서", "병합팀"]); }), values: ["병합팀"] },
  { id: "XLSX-12", input: "duplicate column headings retain both record values", build: (id) => bookFile(id, (b) => b.addWorksheet("중복").addRows([["항목", "금액", "금액"], ["서울", "120원", "130원"], ["부산", "140원", "150원"]])), values: [], records: ["120원", "130원", "140원", "150원"] },
  { id: "XLSX-13", input: "empty header is labelled rather than losing its values", build: (id) => bookFile(id, (b) => b.addWorksheet("빈 제목").addRows([["지역", null, "담당자"], ["서울", "검토", "정하나"], ["부산", "승인", "이도윤"]])), values: [], records: ["검토", "승인", "정하나"] },
  { id: "XLSX-15", input: "60-column repeated table preserves final column", build: (id) => bookFile(id, (b) => b.addWorksheet("가로").addRows([Array.from({ length: 60 }, (_, i) => `열${i + 1}`), Array.from({ length: 60 }, (_, i) => `값${i + 1}`), Array.from({ length: 60 }, (_, i) => `다음${i + 1}`)])), values: [], records: ["값60", "다음60"] },
  { id: "XLSX-16", input: "3,000-row dataset preserves first and last record", build: (id) => bookFile(id, (b) => { const s = b.addWorksheet("대용량"); s.addRow(["순번", "담당부서", "금액"]); for (let i = 1; i < 3000; i++) s.addRow([i, `팀${i}`, `${i}원`]); }), values: [], records: ["팀1", "팀2999"] },
];

for (const entry of structureCases) regressionCase({ id: entry.id, category: "Extract", input: entry.input, format: "XLSX", structure: entry.input, expected: `Real result and reopened CSV/XLSX contain ${[...entry.values, ...(entry.records ?? [])].join(", ")}`, ...(entry.mobile ? { mobile: true } : {}) }, async ({ page, note }) => {
  await ready(page);
  const file = await entry.build(entry.id);
  await selectAndRunExtract(page, [file], entry.fields);
  if (entry.sheets) await expect(fileRow(page, file).locator(".structure-counts")).toContainText(`시트: ${entry.sheets}`);
  if (entry.id === "XLSX-16") await expect(fileRow(page, file).locator(".structure-counts")).toContainText("행: 3000");
  note(await checkExtractExports(page, entry.id, [path.basename(file)], entry.values, entry.records));
  if (entry.id === "XLSX-15") await expect(page.locator(".extract-records .extract-table th")).toHaveCount(60);
});

regressionCase({ id: "XLSX-14", category: "Compare", input: "very long cell text survives comparison", format: "XLSX", structure: "two revisions of a two-column sheet, 385-character value", expected: "Full replacement value visible and present in both downloaded formats" }, async ({ page, note }) => {
  await ready(page);
  const before = await pairs("XLSX-14-old", [["담당부서", "구버전"]]);
  const longValue = "가나다라마바사".repeat(55);
  const after = await pairs("XLSX-14-new", [["담당부서", longValue]]);
  await compare(page, [before, after], "version");
  note(await checkCompareExports(page, "XLSX-14", [longValue], "version", 2));
});

const typedCases: Array<{ id: string; input: string; value: ExcelJS.CellValue; shown: string; format?: string; type?: string }> = [
  { id: "XLSX-17", input: "integer cell", value: 42, shown: "42", type: "Number" },
  { id: "XLSX-18", input: "fractional decimal cell", value: 12.375, shown: "12.375", type: "Number" },
  { id: "XLSX-19", input: "negative numeric cell", value: -73, shown: "-73", type: "Number" },
  { id: "XLSX-20", input: "currency number format", value: 125000, format: '"₩"#,##0', shown: "₩125,000", type: "Money" },
  { id: "XLSX-21", input: "formatted percentage", value: 0.075, format: "0.0%", shown: "7.5%", type: "Percent" },
  { id: "XLSX-22", input: "calendar date cell", value: new Date("2026-09-15T00:00:00.000Z"), format: "yyyy-mm-dd", shown: "2026-09-15", type: "Date" },
  { id: "XLSX-23", input: "date and time cell", value: new Date("2026-09-15T13:40:00.000Z"), format: "yyyy-mm-dd hh:mm", shown: "2026-09-15 13:40", type: "DateTime" },
  { id: "XLSX-24", input: "boolean TRUE cell", value: true, shown: "true", type: "Text" },
  { id: "XLSX-25", input: "blank cell beside populated cell", value: null, shown: "문서에서 찾지 못함" },
  { id: "XLSX-26", input: "leading-zero text is not numeric", value: "00123", shown: "00123", type: "Number" },
  { id: "XLSX-27", input: "numeric-looking text with punctuation", value: "1,234.50", shown: "1,234.50", type: "Number" },
  { id: "XLSX-28", input: "Korean-English mixed value", value: "Seoul 영업팀", shown: "Seoul 영업팀", type: "Text" },
  { id: "XLSX-29", input: "formula uses its stored numeric result", value: { formula: "10*15", result: 150 }, shown: "150", type: "Number" },
];
for (const entry of typedCases) regressionCase({ id: entry.id, category: "Extract", input: entry.input, format: "XLSX", structure: `two-column key/value; ${entry.input}`, expected: `${entry.shown} appears in result and both exports (or is explicitly blank)` }, async ({ page, note, classify }) => {
  await ready(page);
  const file = await bookFile(entry.id, (b) => { const s = b.addWorksheet("유형"); s.addRow(["담당부서", "앵커팀"]); const c = s.getCell("B2"); s.getCell("A2").value = "검증값"; c.value = entry.value; if (entry.format) c.numFmt = entry.format; });
  await selectAndRunExtract(page, [file], entry.value === null ? ["담당부서", "검증값"] : []);
  if (entry.id === "XLSX-29") {
    await expect(fileRow(page, file).locator(".warning")).toHaveAttribute("title", /수식은 계산하지 않고 파일에 저장된 결과만 사용합니다/);
    classify("Expected");
  }
  if (entry.value === null) {
    await expect(page.locator(".extract-fields-table .data-row").filter({ hasText: "검증값" })).toContainText(entry.shown);
    const actual = await checkExtractExports(page, entry.id, [path.basename(file)], ["앵커팀"]);
    const csv = csvRows((await downloadBytes(page, `${entry.id}-blank`, "CSV 다운로드", "csv")).toString("utf8"));
    expect(csv[1][2]).toBe("");
    note(`${actual}; missing value displayed and CSV cell empty`);
  } else {
    const actual = await checkExtractExports(page, entry.id, [path.basename(file)], ["앵커팀", entry.shown]);
    const row = page.locator(".extract-auto-table .data-row").filter({ hasText: "검증값" });
    if (entry.type === "Text") await expect(row.locator("small")).toHaveCount(0);
    else if (entry.type) await expect(row.locator("small")).toContainText(({ Number: "숫자", Money: "금액", Percent: "비율", Date: "날짜", DateTime: "일시" } as Record<string, string>)[entry.type]);
    note(actual);
  }
});

async function externalFile(id: string, cached?: number): Promise<string> {
  const b = new ExcelJS.Workbook();
  const s = b.addWorksheet("연결");
  s.addRow(["담당부서", "연결팀"]);
  s.addRow(["연결값", cached === undefined ? { formula: "'[가격표.xlsx]Sheet1'!B4" } : { formula: "'[가격표.xlsx]Sheet1'!B4", result: cached }]);
  const parts = unzipSync(new Uint8Array(await b.xlsx.writeBuffer() as ArrayBuffer));
  parts["xl/externalLinks/externalLink1.xml"] = strToU8('<?xml version="1.0"?><externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><externalBook/></externalLink>');
  parts["xl/externalLinks/_rels/externalLink1.xml.rels"] = strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="file:///C:/가격표.xlsx" TargetMode="External"/></Relationships>');
  return writeFixture(`${id}.xlsx`, zipSync(parts));
}
for (const entry of [{ id: "XLSX-30", input: "external reference with cached value", cached: 125000, warning: "외부 연결 또는 매크로는 실행하지 않고 저장된 값만 사용합니다." }, { id: "XLSX-31", input: "external reference without cached value", cached: undefined, warning: "일부 연결된 값은 파일에 저장된 결과가 없어 제외되었습니다." }]) regressionCase({ id: entry.id, category: "Extract", input: entry.input, format: "XLSX", structure: "linked workbook with explicit external link ZIP part", expected: `${entry.warning}; cached values only` }, async ({ page, note, classify }) => {
  await ready(page);
  const file = await externalFile(entry.id, entry.cached);
  await selectAndRunExtract(page, [file], entry.cached === undefined ? ["담당부서", "연결값"] : []);
  await expect(fileRow(page, file).locator(".warning")).toHaveAttribute("title", new RegExp(entry.warning));
  if (entry.cached === undefined) await expect(page.locator(".extract-fields-table .data-row").filter({ hasText: "연결값" })).toContainText("문서에서 찾지 못함");
  const actual = await checkExtractExports(page, entry.id, [path.basename(file)], entry.cached === undefined ? ["연결팀"] : ["연결팀", "125000"]);
  classify("Expected");
  note(`${entry.warning}; ${actual}`);
});

for (const entry of [{ id: "XLSX-32", visibility: "hidden" as const }, { id: "XLSX-33", visibility: "veryHidden" as const }]) regressionCase({ id: entry.id, category: "Extract", input: `${entry.visibility} sheet is omitted`, format: "XLSX", structure: `visible + ${entry.visibility} sheet`, expected: "Visible value exported; hidden value omitted with documented warning" }, async ({ page, note, classify }) => {
  await ready(page);
  const file = await bookFile(entry.id, (b) => { b.addWorksheet("공개").addRow(["담당부서", "공개팀"]); const hidden = b.addWorksheet("비공개"); hidden.addRow(["담당부서", "비밀팀"]); hidden.state = entry.visibility; });
  await selectAndRunExtract(page, [file]);
  await expect(fileRow(page, file).locator(".warning")).toHaveAttribute("title", /숨김 시트는 분석 대상에서 제외했습니다/);
  await expect(page.locator(".extract-results")).not.toContainText("비밀팀");
  const actual = await checkExtractExports(page, entry.id, [path.basename(file)], ["공개팀"]);
  classify("Unsupported");
  note(`${entry.visibility} excluded with warning; ${actual}`);
});

regressionCase({ id: "XLSX-34", category: "Extract", input: "worksheet image does not erase adjacent data", format: "XLSX", structure: "anchored PNG plus key/value cells", expected: "Text extracted and exported without image bytes as a bogus cell" }, async ({ page, note }) => {
  await ready(page);
  const file = await bookFile("XLSX-34", (b) => { const s = b.addWorksheet("사진"); s.addRow(["담당부서", "사진팀"]); const image = b.addImage({ buffer: imagePng as unknown as ExcelJS.Buffer, extension: "png" }); s.addImage(image, { tl: { col: 3, row: 0 }, ext: { width: 30, height: 30 } }); });
  await selectAndRunExtract(page, [file]);
  await expect(page.locator(".extract-results")).not.toContainText("[object Object]");
  note(await checkExtractExports(page, "XLSX-34", [path.basename(file)], ["사진팀"]));
});
regressionCase({ id: "XLSX-35", category: "Extract", input: "unhandled chart package part preserves cell data", format: "XLSX", structure: "valid sheet with unsupported chart XML", expected: "Workbook data survives chart omission; CSV and XLSX contain ordinary cells" }, async ({ page, note }) => {
  await ready(page);
  const b = new ExcelJS.Workbook(); b.addWorksheet("차트").addRow(["담당부서", "차트팀"]);
  const parts = unzipSync(new Uint8Array(await b.xlsx.writeBuffer() as ArrayBuffer));
  parts["xl/charts/chart1.xml"] = strToU8('<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart/></c:chartSpace>');
  const file = await writeFixture("XLSX-35.xlsx", zipSync(parts));
  await selectAndRunExtract(page, [file]);
  note(await checkExtractExports(page, "XLSX-35", [path.basename(file)], ["차트팀"]));
});

// Value matching compares semantic field names; version comparison compares
// row keys and sheet identities. Both paths are exercised rather than treating
// one comparison operation as a surrogate for the other.
for (const entry of [{ id: "XLSX-36", count: 2 }, { id: "XLSX-37", count: 5 }, { id: "XLSX-38", count: 10 }]) regressionCase({ id: entry.id, category: "Compare", input: `${entry.count} identical-structure files`, format: "XLSX", structure: `${entry.count} matching workbooks`, expected: "Common item agrees across every file and exported comparison retains all columns", ...(entry.count === 10 ? { mobile: true } : {}) }, async ({ page, note }) => {
  await ready(page);
  const files: string[] = [];
  for (let i = 1; i <= entry.count; i++) files.push(await pairs(`${entry.id}-${i}`, [["담당부서", "공통팀"], ["금액", "420원"]]));
  await compare(page, files, "value");
  await expect(page.locator(".value-check-filters")).toContainText("일치 2");
  const result = await checkCompareExports(page, entry.id, ["담당부서", "공통팀", "금액", "420원"], "value", entry.count);
  const output = new ExcelJS.Workbook(); await output.xlsx.load(new Uint8Array(await downloadBytes(page, `${entry.id}-columns`, "XLSX 다운로드", "xlsx")) as unknown as ExcelJS.Buffer);
  if (entry.count > 2) for (const file of files) expect(output.worksheets[0].getRow(1).values).toContain(path.basename(file));
  note(`${entry.count} matching uploads; ${result}`);
});
regressionCase({ id: "XLSX-39", category: "Upload", input: "eleventh file rejected after ten accepted", format: "XLSX", structure: "11 separate tiny workbooks", expected: "10 ready rows; exact maximum-files error for 11th; no 11th row", mobile: true }, async ({ page, note, classify }) => {
  await ready(page);
  const files: string[] = [];
  for (let i = 1; i <= 11; i++) files.push(await pairs(`XLSX-39-${i}`, [["담당부서", `팀${i}`]]));
  for (const file of files.slice(0, 10)) await upload(page, file);
  expect(await page.locator(".file-row").count()).toBe(10);
  await page.locator('input[aria-label="작업 파일 선택"]').setInputFiles(files[10]);
  await expect(page.locator(".notice.error")).toContainText("한 번에 최대 10개 파일까지 다룰 수 있습니다.");
  await expect(fileRow(page, files[10])).toHaveCount(0);
  expect(await page.locator(".file-row").count()).toBe(10);
  await selectFiles(page, ...files.slice(0, 10));
  await openView(page, "추출"); await page.getByRole("button", { name: "추출 실행" }).click();
  await expect(page.locator(".extract-results")).toBeVisible();
  const result = await checkExtractExports(page, "XLSX-39", files.slice(0, 10).map((file) => path.basename(file)), ["팀1", "팀10"]);
  classify("Expected");
  note(`eleventh rejected with maximum-files message; ${result}`);
});

const valueVariants: Array<{ id: string; input: string; first: Setup; second: Setup; third?: Setup; values: string[]; status: string }> = [
  { id: "XLSX-40", input: "row order differs across files", first: (b) => b.addWorksheet("데이터").addRows([["담당부서", "공통팀"], ["금액", "200원"]]), second: (b) => b.addWorksheet("데이터").addRows([["금액", "200원"], ["담당부서", "공통팀"]]), values: ["담당부서", "공통팀", "금액", "200원"], status: "일치 2" },
  { id: "XLSX-41", input: "column missing from one keyed worksheet", first: (b) => b.addWorksheet("데이터").addRows([["담당부서", "공통팀"], ["금액", "200원"]]), second: (b) => b.addWorksheet("데이터").addRow(["담당부서", "공통팀"]), third: (b) => b.addWorksheet("데이터").addRows([["담당부서", "공통팀"], ["금액", "200원"]]), values: ["담당부서", "공통팀", "금액"], status: "일부 파일만 확인 1" },
  { id: "XLSX-42", input: "additional named item appears in second file", first: (b) => b.addWorksheet("데이터").addRow(["담당부서", "공통팀"]), second: (b) => b.addWorksheet("데이터").addRows([["담당부서", "공통팀"], ["금액", "200원"]]), third: (b) => b.addWorksheet("데이터").addRows([["담당부서", "공통팀"], ["금액", "200원"]]), values: ["담당부서", "공통팀", "금액"], status: "일부 파일만 확인 1" },
  { id: "XLSX-43", input: "slightly different header spelling", first: (b) => b.addWorksheet("데이터").addRow(["담당 부서", "공통팀"]), second: (b) => b.addWorksheet("데이터").addRow(["담당부서", "공통팀"]), values: ["담당 부서", "공통팀"], status: "일치 1" },
  { id: "XLSX-44", input: "same sheets arrive in different order", first: (b) => { b.addWorksheet("서울").addRow(["담당부서", "공통팀"]); b.addWorksheet("부산").addRow(["금액", "200원"]); }, second: (b) => { b.addWorksheet("부산").addRow(["금액", "200원"]); b.addWorksheet("서울").addRow(["담당부서", "공통팀"]); }, values: ["담당부서", "공통팀", "금액", "200원"], status: "일치 2" },
  { id: "XLSX-45", input: "one sheet against multiple sheets", first: (b) => b.addWorksheet("서울").addRow(["담당부서", "공통팀"]), second: (b) => { b.addWorksheet("서울").addRow(["담당부서", "공통팀"]); b.addWorksheet("추가").addRow(["금액", "200원"]); }, values: ["담당부서", "공통팀"], status: "일치 1" },
  { id: "XLSX-46", input: "empty sheet in only one file", first: (b) => { b.addWorksheet("빈칸"); b.addWorksheet("데이터").addRow(["담당부서", "공통팀"]); }, second: (b) => b.addWorksheet("데이터").addRow(["담당부서", "공통팀"]), values: ["담당부서", "공통팀"], status: "일치 1" },
  { id: "XLSX-47", input: "image in only one of two matching files", first: (b) => { const s = b.addWorksheet("데이터"); s.addRow(["담당부서", "공통팀"]); const image = b.addImage({ buffer: imagePng as unknown as ExcelJS.Buffer, extension: "png" }); s.addImage(image, { tl: { col: 3, row: 1 }, ext: { width: 12, height: 12 } }); }, second: (b) => b.addWorksheet("데이터").addRow(["담당부서", "공통팀"]), values: ["담당부서", "공통팀"], status: "일치 1" },
];
for (const entry of valueVariants) regressionCase({ id: entry.id, category: "Compare", input: entry.input, format: "XLSX", structure: `${entry.third ? "three" : "two"} independently uploaded workbooks`, expected: `Value comparison ${entry.status}; reopened CSV and XLSX preserve the row` }, async ({ page, note }) => {
  await ready(page);
  const files = [await bookFile(`${entry.id}-a`, entry.first), await bookFile(`${entry.id}-b`, entry.second)];
  if (entry.third) files.push(await bookFile(`${entry.id}-c`, entry.third));
  await compare(page, files, "value");
  await expect(page.locator(".value-check-filters")).toContainText(entry.status);
  if (entry.id === "XLSX-45") await expect(fileRow(page, files[1]).locator(".structure-counts")).toContainText("시트: 2");
  note(await checkCompareExports(page, entry.id, entry.values, "value", files.length));
});

regressionCase({ id: "XLSX-48", category: "Compare", input: "version direction swap reverses addition and removal", format: "XLSX", structure: "same named sheet; row added to target", expected: "Added becomes Removed after swap; both downloads re-open with correct orientation", mobile: true }, async ({ page, note }) => {
  await ready(page);
  const base = await pairs("XLSX-48-base", [["담당부서", "공통팀"]]);
  const target = await pairs("XLSX-48-target", [["담당부서", "공통팀"], ["추가항목", "새값"]]);
  await compare(page, [base, target], "version");
  const row = page.locator('[data-testid="change-row"]').filter({ hasText: "추가항목" });
  await expect(row).toHaveAttribute("data-category", "Added");
  const forward = await checkCompareExports(page, "XLSX-48-forward", ["추가", "추가항목"], "version", 2);
  const addedValueText = await row.innerText();
  await page.getByRole("button", { name: "기준/대상 바꾸기" }).click();
  await page.getByRole("button", { name: "비교 실행" }).click();
  const reversed = page.locator('[data-testid="change-row"]').filter({ hasText: "추가항목" });
  await expect(reversed).toHaveAttribute("data-category", "Removed");
  const backward = await checkCompareExports(page, "XLSX-48-backward", ["삭제", "추가항목"], "version", 2);
  note(`Added→Removed on swap; ${forward}; ${backward}`);
  expect(addedValueText, "an added row must not discard its second cell").toContain("새값");
});

regressionCase({ id: "XLSX-49", category: "Extract", input: "five-file field extraction shares requested columns", format: "XLSX", structure: "five independent two-column workbooks", expected: "All file-specific values occupy separate rows in XLSX and CSV", mobile: true }, async ({ page, note }) => {
  await ready(page);
  const files: string[] = [];
  for (let i = 1; i <= 5; i++) files.push(await pairs(`XLSX-49-${i}`, [["담당부서", `사업${i}팀`]]));
  await selectAndRunExtract(page, files, ["담당부서"]);
  note(await checkExtractExports(page, "XLSX-49", files.map((file) => path.basename(file)), files.map((_, i) => `사업${i + 1}팀`)));
});

regressionCase({ id: "XLSX-50", category: "Extract", input: "two workbooks reorder record columns", format: "XLSX", structure: "three-column repeated tables, second workbook swaps amount and owner", expected: "Both per-file record schemas and values survive the extracted table and both downloads" }, async ({ page, note }) => {
  await ready(page);
  const a = await bookFile("XLSX-50-a", (b) => b.addWorksheet("명세").addRows([["코드", "금액", "담당자"], ["A", "120원", "김수"], ["B", "240원", "이수"]]));
  const b = await bookFile("XLSX-50-b", (book) => book.addWorksheet("명세").addRows([["담당자", "코드", "금액"], ["김수", "A", "120원"], ["이수", "B", "240원"]]));
  await selectAndRunExtract(page, [a, b]);
  const tables = page.locator(".extract-results .extract-table");
  await page.locator(".extract-records-toggle").click();
  await expect(tables).toHaveCount(2);
  await expect(tables.first().locator("th")).toHaveText(["코드", "금액", "담당자"]);
  await expect(tables.nth(1).locator("th")).toHaveText(["담당자", "코드", "금액"]);
  note(await checkExtractExports(page, "XLSX-50", [path.basename(a), path.basename(b)], [], ["120원", "240원", "김수", "이수"]));
});

for (const entry of [
  { id: "XLSX-51", input: "record column absent in second workbook", base: [["ID", "금액", "담당자"], ["A", "120원", "김수"], ["B", "240원", "이수"]], next: [["ID", "금액"], ["A", "120원"], ["B", "240원"]], value: "김수" },
  { id: "XLSX-52", input: "new record column present only in second workbook", base: [["ID", "금액"], ["A", "120원"], ["B", "240원"]], next: [["ID", "금액", "담당자"], ["A", "120원", "김수"], ["B", "240원", "이수"]], value: "김수" },
]) regressionCase({ id: entry.id, category: "Compare", input: entry.input, format: "XLSX", structure: "two-row data table with changed header width", expected: "Version comparison marks added/removed cells as structural and exports their values" }, async ({ page, note }) => {
  await ready(page);
  const a = await writeFixture(`${entry.id}-a.xlsx`, await createXlsx({ 명세: entry.base }));
  const b = await writeFixture(`${entry.id}-b.xlsx`, await createXlsx({ 명세: entry.next }));
  await compare(page, [a, b], "version");
  const structural = page.locator('[data-testid="change-row"][data-category="Structural Change"]');
  await expect(structural.first()).toBeVisible();
  await expect(structural.filter({ hasText: entry.value }).first()).toBeVisible();
  note(await checkCompareExports(page, entry.id, ["구조 변경", entry.value], "version", 2));
});
