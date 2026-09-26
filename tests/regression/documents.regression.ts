import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import { strToU8, unzipSync, zipSync } from "fflate";
import {
  createDocxWithOmissions, createPptxSlides, createPptxWithOmissions, createUnicodePdf,
} from "../fixtures";
import { FIXTURES, OUT, noHorizontalOverflow, openView, regressionCase, selectFiles, upload, writeFixture } from "./record";

const input = (page: Page) => page.locator('input[aria-label="작업 파일 선택"]');
const row = (page: Page, name: string) => page.locator(".file-row").filter({ has: page.locator(".file-info strong", { hasText: name }) });
const goodContent = "항목,값\r\n기준,정상\r\n";
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const paragraph = (value: string, properties = "") => `<w:p>${properties}<w:r><w:t>${xml(value)}</w:t></w:r></w:p>`;
const table = (rows: string[][]) => `<w:tbl>${rows.map((cells) => `<w:tr>${cells.map((cell) => `<w:tc>${paragraph(cell)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
function docx(body: string, extra: Record<string, Uint8Array> = {}) {
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
    ...extra,
  });
}
function pptxTables(tables: string[][][]) {
  const files = unzipSync(createPptxSlides([["2026 운영 현황"]]));
  const frames = tables.map((rows) => {
    const cells = rows.map((entries) => `<a:tr>${entries.map((value) => `<a:tc><a:txBody><a:p><a:r><a:t>${xml(value)}</a:t></a:r></a:p></a:txBody></a:tc>`).join("")}</a:tr>`).join("");
    return `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${cells}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  }).join("");
  files["ppt/slides/slide1.xml"] = strToU8(`<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>2026 운영 현황</a:t></a:r></a:p></p:txBody></p:sp>${frames}</p:spTree></p:cSld></p:sld>`);
  return zipSync(files);
}

async function prepared(page: Page, name: string, data: Uint8Array | string) {
  await page.goto("/");
  const file = await writeFixture(name, data);
  await upload(page, file);
  await expect(row(page, name)).toContainText(/ready/i);
  await expect(row(page, name)).toContainText(path.extname(name).slice(1).toUpperCase());
  return file;
}
async function runExtract(page: Page, file: string) {
  await selectFiles(page, file);
  await openView(page, "추출");
  await page.getByRole("button", { name: "추출 실행" }).click();
  await expect(page.locator(".extract-results .result-status")).toHaveText("추출 완료");
  return page.locator(".extract-results");
}
async function csvRows(page: Page): Promise<string[][]> {
  const event = page.waitForEvent("download");
  await page.locator(".extract-results").getByRole("button", { name: "CSV 다운로드" }).click();
  const download = await event;
  const filename = path.join(OUT, `${Date.now()}-${download.suggestedFilename()}`);
  await download.saveAs(filename);
  const bytes = await readFile(filename);
  expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  return parseCsv(bytes.subarray(3).toString("utf8"));
}
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) { current.push(value); value = ""; }
    else if ((ch === "\r" || ch === "\n") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      current.push(value); rows.push(current); current = []; value = "";
    } else value += ch;
  }
  if (current.length || value) rows.push([...current, value]);
  return rows;
}
async function xlsxBook(page: Page) {
  const event = page.waitForEvent("download");
  await page.locator(".extract-results").getByRole("button", { name: "XLSX 다운로드" }).click();
  const download = await event;
  const filename = path.join(OUT, `${Date.now()}-${download.suggestedFilename()}`);
  await download.saveAs(filename);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filename);
  return workbook;
}
async function expectedReject(page: Page, name: string, data: Uint8Array | string | null, message: RegExp) {
  await page.goto("/");
  const good = await writeFixture(`DOC-good-${name}.csv`, goodContent);
  await upload(page, good);
  await selectFiles(page, good);
  const bad = data === null ? path.join(FIXTURES, name) : await writeFixture(name, data);
  await input(page).setInputFiles(bad);
  await expect(page.locator(".notice.error")).toContainText(message);
  const error = await page.locator(".notice.error").innerText();
  expect(error).not.toMatch(/TypeError|ReferenceError|SyntaxError|Error:|at [a-zA-Z]+\s*\(/);
  await expect(row(page, path.basename(good))).toContainText(/ready/i);
  // Exact match: the good file's name (DOC-good-<name>.csv) contains the rejected name.
  expect(await page.locator(".file-row .file-info strong").allInnerTexts()).not.toContain(name);
  await openView(page, "추출");
  await page.getByRole("button", { name: "추출 실행" }).click();
  await expect(page.locator(".extract-results .result-status")).toHaveText("추출 완료");
  return error;
}

const csvCases: Array<{ name: string; source: string; field: string; value: string; describe: string }> = [
  { name: "utf8", source: "항목,값\r\n지역,Seoul\r\n", field: "지역", value: "Seoul", describe: "plain UTF-8 CRLF" },
  { name: "bom", source: "\ufeff항목,값\r\n지역,부산\r\n", field: "지역", value: "부산", describe: "UTF-8 BOM stripped from first header" },
  { name: "korean", source: "항목,값\r\n담당부서,경영지원팀\r\n", field: "담당부서", value: "경영지원팀", describe: "Korean label and data" },
  { name: "quoted-comma", source: '항목,값\r\n메모,"서울, 부산"\r\n', field: "메모", value: "서울, 부산", describe: "comma inside quoted field" },
  { name: "quoted-newline", source: '항목,값\r\n메모,"첫 줄\n둘째 줄"\r\n', field: "메모", value: "첫 줄\n둘째 줄", describe: "newline inside quoted field" },
  { name: "blank-cells", source: "항목,값\r\n빈칸,\r\n담당자,김나래\r\n", field: "담당자", value: "김나래", describe: "empty value skipped; following value retained" },
  { name: "blank-row", source: "항목,값\r\n\r\n부서,기획실\r\n", field: "부서", value: "기획실", describe: "blank row does not swallow next row" },
  { name: "mixed-numbers-dates", source: "항목,값\r\n금액,145000\r\n기준일,2026-09-26\r\n", field: "기준일", value: "2026-09-26", describe: "number and ISO date as typed values" },
  { name: "ragged", source: "항목,값\r\n회의명,정기회의,별도 주석\r\n담당자,홍길동\r\n", field: "담당자", value: "홍길동", describe: "ragged row keeps next row aligned" },
  { name: "long-row", source: `항목,값\r\n메모,${"가".repeat(20_000)}\r\n담당자,김하늘\r\n`, field: "담당자", value: "김하늘", describe: "20k-character cell within parser limit; adjacent field retained" },
];
csvCases.forEach(({ name, source, field, value, describe }, index) => regressionCase({
  id: `DOC-${String(index + 1).padStart(2, "0")}`, category: "Extract", input: `${name}.csv`, format: "CSV", structure: describe,
  expected: `Uploaded CSV extracts ${field}=${value} and downloaded CSV/XLSX re-open with that field`,
}, async ({ page, note }) => {
  const file = await prepared(page, `DOC-${name}.csv`, source);
  const result = await runExtract(page, file);
  await expect(result.locator(".extract-auto-table")).toContainText(field);
  await expect(result.locator(".extract-auto-table")).toContainText(value);
  const rows = await csvRows(page);
  expect(rows).toContainEqual([path.basename(file), field, value, expect.any(String), expect.any(String)]);
  const book = await xlsxBook(page);
  const details = book.getWorksheet("Details")!;
  expect(details.getSheetValues().some((r) => Array.isArray(r) && r[2] === field && r[3] === value)).toBe(true);
  if (name === "blank-cells") expect(rows.every((r) => r[1] !== "빈칸")).toBe(true);
  if (name === "mixed-numbers-dates") expect(rows.some((r) => r[1] === "금액" && r[2] === "145000")).toBe(true);
  note(`READY; ${field}=${value}; CSV ${rows.length - 1} extracted rows, XLSX Details verified`);
}));

regressionCase({ id: "DOC-11", category: "Extract", input: "header-only.csv", format: "CSV", structure: "one header and zero data rows", expected: "READY, zero structured extraction and explicit empty-result message" }, async ({ page, note }) => {
  const file = await prepared(page, "DOC-header-only.csv", "항목,값\r\n");
  const result = await runExtract(page, file);
  await expect(result).toContainText("자동으로 추출할 수 있는 구조화된 항목을 찾지 못했습니다.");
  await expect(result.getByRole("button", { name: "CSV 다운로드" })).toHaveCount(0);
  note("READY; empty structured-extraction message; no download offered for zero records");
});

const documentCases: Array<{ body: string; name: string; contains: string; second?: string; warn?: string }> = [
  { name: "headings", body: paragraph("2026 사업 목표", '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>') + paragraph("담당부서: 전략기획팀"), contains: "전략기획팀" },
  { name: "one-table", body: table([["항목", "값"], ["담당자", "박민지"]]), contains: "박민지" },
  { name: "several-tables", body: table([["항목", "값"], ["담당자", "최승아"]]) + table([["항목", "값"], ["금액", "72000"]]), contains: "최승아", second: "72000" },
  { name: "mixed-blocks", body: paragraph("담당부서: 본부") + table([["항목", "값"], ["금액", "35000"]]) + paragraph("담당자: 홍길동"), contains: "본부", second: "홍길동" },
  { name: "empty-paragraphs", body: `${"<w:p/>".repeat(350)}${paragraph("담당자: 문서담당")}`, contains: "문서담당" },
  { name: "long-document", body: `${Array.from({ length: 600 }, (_, i) => paragraph(`문단 ${i + 1}의 본문 안내입니다`)).join("")}${paragraph("담당자: 마지막담당")}`, contains: "마지막담당" },
  { name: "image-only", body: '<w:p><w:r><w:drawing/></w:r></w:p>', contains: "", warn: "이미지 안의 내용은 읽지 않습니다." },
  { name: "list-and-pagebreak", body: paragraph("담당자: 목록담당", '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>') + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + paragraph("기준일: 2026-09-26"), contains: "목록담당", second: "2026-09-26" },
  { name: "header-footer", body: paragraph("담당자: 본문담당"), contains: "본문담당", second: "머리말담당" },
];
documentCases.forEach(({ body, name, contains, second, warn }, index) => regressionCase({
  id: `DOC-${index + 12}`, category: "Extract", input: `${name}.docx`, format: "DOCX", structure: name,
  expected: warn ? "Image omitted with visible warning and no made-up OCR content" : `Structured extraction retains ${contains}${second ? ` and ${second}` : ""} in download`,
}, async ({ page, note, classify }) => {
  const extra: Record<string, Uint8Array> = name === "image-only" ? { "word/media/picture.png": Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/dV0AAAAASUVORK5CYII=", "base64") }
    : name === "header-footer" ? {
      "word/header1.xml": strToU8(`<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${paragraph("담당자: 머리말담당")}</w:hdr>`),
      "word/footer1.xml": strToU8(`<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${paragraph("부서: 꼬리말부서")}</w:ftr>`),
    } : {};
  const file = await prepared(page, `DOC-${name}.docx`, docx(body, extra));
  if (warn) {
    await expect(row(page, path.basename(file)).locator(".warning")).toHaveAttribute("title", new RegExp(warn));
    const result = await runExtract(page, file);
    await expect(result).toContainText("자동으로 추출할 수 있는 구조화된 항목을 찾지 못했습니다.");
    classify("Unsupported");
    note("READY; image omission warning; no OCR-derived field");
    return;
  }
  const result = await runExtract(page, file);
  await expect(result).toContainText(contains);
  if (second) await expect(result).toContainText(second);
  const csv = await csvRows(page);
  expect(csv.some((r) => r.includes(contains))).toBe(true);
  if (second) expect(csv.some((r) => r.includes(second))).toBe(true);
  const book = await xlsxBook(page);
  expect(book.getWorksheet("Details")!.getSheetValues().flat().some((v) => v === contains)).toBe(true);
  note(`READY; DOCX text ${contains}${second ? `, ${second}` : ""} present in result, CSV and XLSX`);
}));

regressionCase({ id: "DOC-21", category: "Upload", input: "DOCX omission fixture", format: "DOCX", structure: "image/chart and malformed header/footer", expected: "Visible image and generic omission warnings; analysis completes" }, async ({ page, note, classify }) => {
  const file = await prepared(page, "DOC-omissions.docx", createDocxWithOmissions());
  await expect(row(page, path.basename(file)).locator(".warning")).toHaveAttribute("title", /이미지 안의 내용은 읽지 않습니다\.[\s\S]*일부 내용은 분석 대상에서 제외했습니다/);
  await selectFiles(page, file);
  await openView(page, "분석");
  await page.getByRole("button", { name: "분석 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toContainText("분석 완료");
  classify("Unsupported");
  note("Image and generic chart/header/footer omission warnings displayed; analysis completed");
});

const slideCases = [
  { name: "single-text", data: createPptxSlides([["담당자: 이서연"]], [1]), find: "이서연" },
  { name: "title-body", data: createPptxSlides([["분기 계획", "담당자: 황지수"]]), find: "황지수" },
  { name: "repeated-text", data: createPptxSlides([["담당자: 박소연"], ["담당자: 박소연"]], [1, 2]), find: "박소연", count: 1 },
  { name: "one-table", data: pptxTables([[["항목", "값"], ["담당자", "서지훈"]]]), find: "서지훈" },
  { name: "typed-table", data: pptxTables([[["항목", "값"], ["인원", "12"], ["기준일", "2026-09-26"], ["진행률", "75%"]]]), find: "75%", second: "2026-09-26" },
];
slideCases.forEach(({ name, data, find, second, count }, index) => regressionCase({
  id: `DOC-${index + 22}`, category: "Extract", input: `${name}.pptx`, format: "PPTX", structure: name,
  expected: `Slide data ${find} survives extraction and downloaded CSV/XLSX`,
}, async ({ page, note }) => {
  const file = await prepared(page, `DOC-${name}.pptx`, data);
  const result = await runExtract(page, file);
  await expect(result).toContainText(find);
  const rows = await csvRows(page);
  expect(rows.some((r) => r.includes(find))).toBe(true);
  if (second) expect(rows.some((r) => r.includes(second))).toBe(true);
  if (count) expect(rows.filter((r) => r.includes(find))).toHaveLength(count);
  const book = await xlsxBook(page);
  expect(book.getWorksheet("Details")!.getSheetValues().flat().some((v) => v === find)).toBe(true);
  note(`READY; ${find} in extraction, CSV and XLSX${count ? "; repeated slide value deduplicated" : ""}`);
}));
regressionCase({ id: "DOC-27", category: "Upload", input: "12 slides including empty slide", format: "PPTX", structure: "12 slides; slide 6 empty", expected: "Twelve slide metadata and last slide readable after blank slide" }, async ({ page, note }) => {
  const slides = Array.from({ length: 12 }, (_, index) => index === 5 ? [] : [`슬라이드 ${index + 1}`, index === 11 ? "담당자: 마지막슬라이드" : `항목: ${index + 1}`]);
  const file = await prepared(page, "DOC-12slides.pptx", createPptxSlides(slides));
  await expect(row(page, path.basename(file)).locator(".structure-counts")).toContainText("페이지/슬라이드: 12");
  const result = await runExtract(page, file);
  await expect(result).toContainText("마지막슬라이드");
  const csv = await csvRows(page);
  expect(csv.some((r) => r.includes("마지막슬라이드"))).toBe(true);
  note("12 slide metadata; slide 12 value remained after empty slide 6 and in downloaded CSV");
});
regressionCase({ id: "DOC-28", category: "Upload", input: "PPTX image/chart/notes omission", format: "PPTX", structure: "media, chart, speaker note and body", expected: "Three omission warnings visible; analysis completes" }, async ({ page, note, classify }) => {
  const file = await prepared(page, "DOC-pptx-omissions.pptx", createPptxWithOmissions());
  const warning = row(page, path.basename(file)).locator(".warning");
  await expect(warning).toContainText("주의 3");
  await expect(warning).toHaveAttribute("title", /이미지 안의 내용은 읽지 않습니다\.[\s\S]*차트 안의 값은 읽지 않습니다\.[\s\S]*발표자 노트는 읽지 않습니다/);
  await selectFiles(page, file);
  await openView(page, "분석");
  await page.getByRole("button", { name: "분석 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toContainText("분석 완료");
  classify("Unsupported");
  note("Image/chart/speaker-note omission warnings visible; analysis completed");
});

const pdfCases = [
  { id: "DOC-29", name: "one-page", texts: ["담당자: Alice"], value: "Alice", count: 1 },
  { id: "DOC-30", name: "multi-page", texts: ["담당자: Alice", "담당자: Bob", "담당자: Charlie"], value: "Charlie", count: 3 },
  { id: "DOC-31", name: "blank-middle", texts: ["담당자: Alice", "", "담당자: Charlie"], value: "Charlie", count: 3 },
  { id: "DOC-32", name: "number-heavy", texts: ["금액: 145000", "기준일: 2026-09-26"], value: "145000", count: 2 },
];
pdfCases.forEach(({ id, name, texts, value, count }) => regressionCase({
  id, category: "Extract", input: `${name}.pdf`, format: "PDF", structure: `${count} pages`, expected: `Page count ${count}; ${value} in downloaded CSV and XLSX`,
}, async ({ page, note }) => {
  // Standard PDF fonts are WinAnsi-only; Korean labels need the Identity-H fixture.
  const file = await prepared(page, `DOC-${name}.pdf`, await createUnicodePdf(texts.map((text) => text ? [{ text }] : [])));
  await expect(row(page, path.basename(file)).locator(".structure-counts")).toContainText(`페이지/슬라이드: ${count}`);
  const result = await runExtract(page, file);
  await expect(result).toContainText(value);
  const csv = await csvRows(page);
  expect(csv.some((r) => r.includes(value))).toBe(true);
  const book = await xlsxBook(page);
  expect(book.getWorksheet("Details")!.getSheetValues().flat().some((v) => v === value)).toBe(true);
  note(`${count} pages READY; ${value} in extracted result and both reopened downloads`);
}));
regressionCase({ id: "DOC-33", category: "Extract", input: "Korean Unicode PDF", format: "PDF", structure: "custom ToUnicode CMap text layer", expected: "Korean text survives browser PDF parsing and CSV/XLSX exports" }, async ({ page, note }) => {
  const file = await prepared(page, "DOC-korean.pdf", await createUnicodePdf([[{ text: "담당자: 김민준" }]]));
  const result = await runExtract(page, file);
  await expect(result).toContainText("김민준");
  expect((await csvRows(page)).some((r) => r.includes("김민준"))).toBe(true);
  expect((await xlsxBook(page)).getWorksheet("Details")!.getSheetValues().flat()).toContain("김민준");
  note("ToUnicode Korean 김민준 retained in extraction, CSV and XLSX");
});
regressionCase({ id: "DOC-34", category: "Upload", input: "scanned-like image-only PDF", format: "PDF", structure: "one page of embedded PNG, no text layer", expected: "Explicit Korean no-OCR notice and no fabricated extracted text" }, async ({ page, note, classify }) => {
  const pdf = await PDFDocument.create();
  const picture = await pdf.embedPng(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/dV0AAAAASUVORK5CYII=", "base64"));
  const sheet = pdf.addPage([595, 842]);
  sheet.drawImage(picture, { x: 30, y: 100, width: 500, height: 600 });
  const file = await prepared(page, "DOC-scanned.pdf", await pdf.save());
  await expect(row(page, path.basename(file)).locator(".warning")).toHaveAttribute("title", /스캔된 페이지의 글자는 읽지 않습니다/);
  const result = await runExtract(page, file);
  await expect(result).toContainText("자동으로 추출할 수 있는 구조화된 항목을 찾지 못했습니다.");
  classify("Unsupported");
  note("One page READY; no-OCR warning, no invented extracted text");
});

const unsupported = ["txt", "zip", "exe", "svg", "gif", "heic"] as const;
unsupported.forEach((extension, index) => regressionCase({
  id: `DOC-${35 + index}`, category: "Upload", input: `unsupported .${extension}`, format: extension.toUpperCase(), structure: "rejected extension alongside good CSV", expected: "Korean unsupported-format message, no raw exception, good CSV still runnable",
}, async ({ page, note, classify }) => {
  const error = await expectedReject(page, `DOC-unsupported.${extension}`, extension === "zip" ? zipSync({ "readme.txt": strToU8("a") }) : "unsupported-format", /지원하지 않는 파일 형식입니다/);
  classify("Unsupported");
  note(`${extension}: ${error}; prior good CSV READY and extraction completed`);
}));
const broken: Array<{ name: string; data: Uint8Array | string; error: RegExp }> = [
  { name: "wrong-extension.xlsx", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]), error: /파일 확장자와 실제 내용이 일치하지 않습니다/ },
  { name: "empty.csv", data: "", error: /업로드할 파일이 비어 있습니다/ },
  { name: "truncated.xlsx", data: Buffer.from([80, 75, 3, 4, 0, 0, 0, 0]), error: /압축 문서 구조가 유효하지 않습니다/ },
  { name: "truncated.pdf", data: "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>", error: /파일을 읽지 못했습니다/ },
];
broken.forEach(({ name, data, error }, index) => regressionCase({
  id: `DOC-${41 + index}`, category: "Upload", input: name, format: path.extname(name).slice(1).toUpperCase(), structure: "invalid bytes alongside valid CSV", expected: "Clear Korean parse error without exception internals; prior good file preserved",
}, async ({ page, note, classify }) => {
  const shown = await expectedReject(page, `DOC-${name}`, data, error);
  classify("Unsupported");
  note(`${name}: ${shown}; good CSV still READY and extractable`);
}));
regressionCase({ id: "DOC-45", category: "Upload", input: "tiny CSV", format: "CSV", structure: "single UTF-8 character", expected: "A one-byte, nonempty file is admitted and yields no structured fields" }, async ({ page, note }) => {
  const file = await prepared(page, "DOC-tiny.csv", "x");
  await expect(row(page, path.basename(file))).toContainText("1 B");
  const result = await runExtract(page, file);
  await expect(result).toContainText("자동으로 추출할 수 있는 구조화된 항목을 찾지 못했습니다.");
  note("1 B READY; no structured fields, rather than empty-file error");
});
regressionCase({ id: "DOC-46", category: "Upload", input: "100 MiB + 1-byte file", format: "CSV", structure: "sparse oversize file", expected: "Exact per-file threshold rejects without deleting good file" }, async ({ page, note, classify }) => {
  const file = await writeFixture("DOC-too-large.csv", "valid");
  const handle = await open(file, "r+");
  try { await handle.truncate(100 * 1024 * 1024 + 1); } finally { await handle.close(); }
  const message = await expectedReject(page, "DOC-too-large.csv", null, /최대 100 MB까지 처리할 수 있습니다/);
  classify("Unsupported");
  note(`100 MiB + 1: ${message}; good CSV intact`);
});
regressionCase({ id: "DOC-47", category: "Upload", input: "11 files", format: "CSV", structure: "11 individually accepted-size files", expected: "10 READY rows, 11th receives Korean max-count notice" }, async ({ page, note, classify }) => {
  await page.goto("/");
  const paths = await Promise.all(Array.from({ length: 11 }, (_, i) => writeFixture(`DOC-count-${i + 1}.csv`, `항목,값\r\n파일,${i + 1}\r\n`)));
  for (const file of paths.slice(0, 10)) await upload(page, file);
  await input(page).setInputFiles(paths[10]);
  await expect(page.locator(".notice.error")).toContainText("한 번에 최대 10개 파일까지 다룰 수 있습니다.");
  await expect(page.locator(".file-row")).toHaveCount(10);
  await expect(row(page, path.basename(paths[0]))).toContainText(/ready/i);
  classify("Unsupported");
  note("10 ready CSV rows; 11th denied with Korean max-count message");
});
regressionCase({ id: "DOC-48", category: "Upload", input: "Korean English digits spaces brackets hyphen underscore", format: "CSV", structure: "legal filename characters", expected: "Exact name in metadata and downloaded CSV file column" }, async ({ page, note }) => {
  const file = await prepared(page, "DOC-서울 Team_2026 (final)-v2.csv", "항목,값\r\n담당자,최진호\r\n");
  await expect(row(page, path.basename(file)).locator(".file-info strong")).toHaveText(path.basename(file));
  await runExtract(page, file);
  expect((await csvRows(page)).some((r) => r[0] === path.basename(file) && r[2] === "최진호")).toBe(true);
  note("Exact mixed-script filename in file list and downloaded CSV provenance");
});
regressionCase({ id: "DOC-49", category: "UI", input: "240-character filename", format: "CSV", structure: "long legal basename at 390×844", expected: "READY and no document-level horizontal overflow on mobile", mobile: true }, async ({ page, note }) => {
  const name = `${"가".repeat(236)}.csv`;
  // Uploaded from memory: the on-disk fixture path would exceed Windows' 260-character MAX_PATH.
  await page.goto("/");
  await input(page).setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from("항목,값\r\n담당자,김지은\r\n") });
  await expect(row(page, name)).toContainText(/ready/i);
  const file = name;
  await expect(row(page, name).locator(".file-info strong")).toHaveText(name);
  await noHorizontalOverflow(page);
  const result = await runExtract(page, file);
  await expect(result).toContainText("김지은");
  await noHorizontalOverflow(page);
  note("240-char basename READY; 390px viewport no horizontal overflow; extraction still usable");
});
regressionCase({ id: "DOC-50", category: "Upload", input: "two CSV files with same name", format: "CSV", structure: "same basename, distinct file data", expected: "Both rows distinguished by identity and both extraction values exported" }, async ({ page, note }) => {
  await page.goto("/");
  const first = await writeFixture("DOC-duplicate.csv", "항목,값\r\n담당자,첫번째\r\n");
  await upload(page, first);
  await input(page).setInputFiles({ name: "DOC-duplicate.csv", mimeType: "text/csv", buffer: Buffer.from("항목,값\r\n담당자,두번째\r\n") });
  const duplicates = row(page, "DOC-duplicate.csv");
  await expect(duplicates).toHaveCount(2);
  await duplicates.nth(0).getByRole("checkbox").check();
  await duplicates.nth(1).getByRole("checkbox").check();
  await openView(page, "추출");
  await page.getByRole("button", { name: "추출 실행" }).click();
  const results = page.locator(".extract-results");
  await expect(results).toContainText("첫번째");
  await expect(results).toContainText("두번째");
  const exported = await csvRows(page);
  expect(exported.filter((r) => r[1] === "담당자").map((r) => r[2])).toEqual(["첫번째", "두번째"]);
  note("Two same-name READY rows with independent checkboxes and separate exported values");
});

regressionCase({ id: "DOC-51", category: "Extract", input: "two separate slide tables", format: "PPTX", structure: "two key-value tables on one slide", expected: "Both table values survive extraction and CSV/XLSX exports" }, async ({ page, note }) => {
  const file = await prepared(page, "DOC-two-tables.pptx", pptxTables([
    [["항목", "값"], ["담당자", "첫표담당"]],
    [["항목", "값"], ["금액", "35000"]],
  ]));
  const result = await runExtract(page, file);
  await expect(result).toContainText("첫표담당");
  await expect(result).toContainText("35000");
  const rows = await csvRows(page);
  expect(rows.some((r) => r.includes("첫표담당"))).toBe(true);
  expect(rows.some((r) => r.includes("35000"))).toBe(true);
  const details = (await xlsxBook(page)).getWorksheet("Details")!.getSheetValues().flat();
  expect(details).toContain("첫표담당");
  expect(details).toContain("35000");
  note("Both independent tables appear in extracted result, CSV, and XLSX");
});
regressionCase({ id: "DOC-52", category: "Upload", input: "four large DOCX files exceed workspace", format: "DOCX", structure: "4 × 76 MiB non-inflated media; each individually valid", expected: "First three READY; fourth rejected by 300 MB aggregate budget; originals intact" }, async ({ page, note, classify }) => {
  await page.goto("/");
  const bytes = zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types/>'),
    "word/document.xml": strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>담당자: 보존</w:t></w:r></w:p></w:body></w:document>'),
    "word/media/large.bin": [new Uint8Array(76 * 1024 * 1024), { level: 0 }],
  });
  const file = await writeFixture("DOC-large-aggregate.docx", bytes);
  for (let i = 0; i < 3; i++) {
    await input(page).setInputFiles(file);
    await expect(page.locator(".file-row")).toHaveCount(i + 1, { timeout: 120_000 });
  }
  await input(page).setInputFiles(file);
  await expect(page.locator(".notice.error")).toContainText(/총 파일 용량\(300 MB\)을 초과합니다/, { timeout: 120_000 });
  await expect(page.locator(".file-row")).toHaveCount(3);
  await expect(page.locator(".file-row").first()).toContainText(/ready/i);
  classify("Unsupported");
  note("Three 76 MiB documents READY (228 MiB); fourth denied at 304 MiB total; three rows intact");
});

regressionCase({ id: "DOC-53", category: "Extract", input: "three-column CSV records", format: "CSV", structure: "header plus three data rows, quoted comma and ragged row", expected: "All three intact records in result and reopened CSV/XLSX Records sheet" }, async ({ page, note }) => {
  const file = await prepared(page, "DOC-records.csv", '지역,담당자,금액\r\n서울,김하늘,145000\r\n부산,"이,민수",90000\r\n제주,박지수\r\n');
  const result = await runExtract(page, file);
  await expect(result).toContainText("세부 표 1");
  await result.getByRole("button", { name: "세부 표 1개" }).click();
  await expect(result.locator(".extract-table")).toContainText("이,민수");
  const rows = await csvRows(page);
  expect(rows.filter((r) => r[3] === "Record")).toHaveLength(3);
  expect(rows.some((r) => r[2].includes("부산 | 이,민수 | 90000"))).toBe(true);
  const records = (await xlsxBook(page)).getWorksheet("Records")!;
  expect(records.getRow(3).getCell(4).value).toBe("이,민수");
  expect(records.getRow(4).getCell(5).value).toBe("");
  note("Three records retained; quoted comma and short row preserved in CSV and XLSX Records");
});
regressionCase({ id: "DOC-54", category: "Extract", input: "DOCX bullet and numbered paragraphs", format: "DOCX", structure: "w:numPr bullet and numbered item with explicit label:value text", expected: "Both list item text values retained in extraction and reopened CSV" }, async ({ page, note }) => {
  const bullet = paragraph("담당자: 글머리담당", '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>');
  const numbered = paragraph("기준일: 2026-10-01", '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr>');
  const file = await prepared(page, "DOC-list.docx", docx(bullet + numbered));
  const result = await runExtract(page, file);
  await expect(result).toContainText("글머리담당");
  await expect(result).toContainText("2026-10-01");
  const rows = await csvRows(page);
  expect(rows.some((r) => r.includes("글머리담당"))).toBe(true);
  expect(rows.some((r) => r.includes("2026-10-01"))).toBe(true);
  note("Bullet and numbered paragraph text retained; CSV values reopened");
});

regressionCase({ id: "DOC-55", category: "Extract", input: "DOCX footer part", format: "DOCX", structure: "body plus separate w:ftr part", expected: "Footer text is read, attributed and retained in reopened CSV and XLSX" }, async ({ page, note }) => {
  const file = await prepared(page, "DOC-footer.docx", docx(paragraph("담당자: 본문담당"), {
    "word/footer1.xml": strToU8(`<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${paragraph("부서: 꼬리말부서")}</w:ftr>`),
  }));
  const result = await runExtract(page, file);
  await expect(result).toContainText("꼬리말부서");
  expect((await csvRows(page)).some((r) => r.includes("꼬리말부서"))).toBe(true);
  expect((await xlsxBook(page)).getWorksheet("Details")!.getSheetValues().flat()).toContain("꼬리말부서");
  note("Footer 부서: 꼬리말부서 visible and present in reopened exports");
});
