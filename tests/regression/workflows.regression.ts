import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Download, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { createCheckPptx, createDocx, createDocxParagraphs, createExtractPptx, createPdf, createPptxSlides, createXlsx, RATE_SHEET_V1, RATE_SHEET_V2 } from "../fixtures";
import { noHorizontalOverflow, openView, regressionCase, selectFiles, upload, writeFixture } from "./record";

const f: Record<string, string> = {};

// Each input is constructed in this suite; nothing from a user's workspace is checked in.
async function fixtures() {
  const inputs: Record<string, Uint8Array | string> = {
    ratesOld: await createXlsx(RATE_SHEET_V1),
    ratesNew: await createXlsx(RATE_SHEET_V2),
    ratesSame: await createXlsx(RATE_SHEET_V1),
    ratesBlank: await createXlsx({ 운송단가: [["지역", "단가"], ["SEOUL", ""], ["BUSAN", 90000]] }),
    ratesFilled: await createXlsx({ 운송단가: [["지역", "단가"], ["SEOUL", 145000], ["BUSAN", 90000]] }),
    csv: "지역,단가\r\n서울,145000\r\n부산,90000\r\n",
    docOld: createDocxParagraphs(["계약 개요를 검토합니다.", "담당부서: 경영지원팀", "납품일은 2026년 9월입니다."]),
    docNew: createDocxParagraphs(["계약 개요를 검토합니다.", "담당부서: 운영지원팀", "납품일은 2026년 9월입니다."]),
    docTable: createDocx(),
    deckOld: createPptxSlides([["운영 현황", "예산: 5000원"], ["담당자", "담당부서: 경영지원팀"]]),
    deckNew: createPptxSlides([["운영 현황", "예산: 6000원"], ["담당자", "담당부서: 경영지원팀"]]),
    deckExtract: createExtractPptx(),
    deckCheck: createCheckPptx(),
    deckClean: createPptxSlides([["운영 개요", "운영 계획을 공유합니다."]]),
    pdfOld: await createPdf(["Contract budget: 5000 USD", "Delivery in October"]),
    pdfNew: await createPdf(["Contract budget: 6000 USD", "Delivery in October"]),
    valuesA: await createXlsx({ 주요값: [["목표주가", "64,550원"], ["기준일", "2026.09.15"], ["담당부서", "경영지원팀"]] }),
    valuesB: await createXlsx({ 주요값: [["목표주가", "62,000원"], ["기준일", "2026-09-15"], ["담당부서", "경영지원팀"]] }),
    valuesC: await createXlsx({ 주요값: [["목표주가", "64,550원"], ["기준일", "2026-09-15"]] }),
    valuesFormatted: await createXlsx({ 주요값: [["목표주가", "64550원"], ["기준일", "2026-09-15"], ["담당부서", "경영지원팀"]] }),
    polish: createDocxParagraphs(["김하나 차장님이 1,250만원의 매출 보고서를 검토 부탁드립니다."]),
  };
  for (const [key, bytes] of Object.entries(inputs)) {
    const extension = key === "csv" ? "csv" : key.startsWith("pdf") ? "pdf" : key.startsWith("deck") ? "pptx" : key.startsWith("doc") || key === "polish" ? "docx" : "xlsx";
    f[key] = await writeFixture(`WF_${key}.${extension}`, bytes);
  }
}

import { test } from "@playwright/test";
test.beforeAll(fixtures);

type AiItem = { handle: string; text: string };
async function mockAi(page: Page, claim: (items: AiItem[], operation: string) => object[] = () => []) {
  await page.route("**/api/ai", async (route) => {
    const req = route.request().postDataJSON() as { kind: string; request?: { operation: string }; items?: AiItem[]; text?: string; field?: string };
    const data = req.kind === "claims"
      ? { kind: "claims", claims: claim(req.items ?? [], req.request?.operation ?? "") }
      : req.kind === "polish"
        ? { kind: "polish", proposal: { changed: false, revisedText: req.text ?? "", reasons: [] } }
        : { kind: "extract", proposal: { field: req.field ?? "", value: null, handles: [], confidence: "low" } };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
  });
}
async function start(page: Page, keys: string[], feature: string, mocked = true) {
  if (mocked) await mockAi(page);
  await page.goto("/");
  await expect(page.locator("[data-hydrated='true']")).toBeVisible();
  for (const key of keys) await upload(page, f[key]);
  await selectFiles(page, ...keys.map((key) => f[key]));
  if (feature !== "분석") await openView(page, feature);
}
async function run(page: Page, feature: string) {
  await page.getByRole("button", { name: `${feature} 실행`, exact: true }).click();
  await expect(page.locator(".results-panel .result-status")).toBeVisible();
}
async function downloaded(download: Download) {
  const source = await download.path();
  expect(source).not.toBeNull();
  const saved = await writeFixture(`WF_download_${Date.now()}_${download.suggestedFilename()}`, await readFile(source!));
  return saved;
}
async function csvRows(download: Download): Promise<string[][]> {
  const bytes = await readFile(await downloaded(download));
  const content = bytes.toString("utf8");
  expect(content.startsWith("\uFEFF")).toBe(true);
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const text = content.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function xlsx(download: Download) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(await downloaded(download));
  return workbook;
}
async function version(page: Page, first: string, second: string) {
  await start(page, [first, second], "비교");
  await run(page, "비교");
  const panel = page.locator(".comparison-panel");
  await expect(panel.getByRole("heading", { name: "버전 비교 결과" })).toBeVisible();
  await expect(panel.locator(".comparison-file-map")).toContainText(path.basename(f[first]));
  await expect(panel.locator(".comparison-file-map")).toContainText(path.basename(f[second]));
  return panel;
}
async function valueCheck(page: Page, ...keys: string[]) {
  await start(page, keys, "비교");
  await page.getByRole("radio", { name: "값 일치 확인" }).check();
  await run(page, "비교");
  return page.locator(".value-check-panel");
}

regressionCase({ id: "WF-01", category: "Analyze", input: "XLSX sheet metric and source", format: "XLSX", structure: "key/value sheet", expected: "145000 has a workbook cell source", mobile: true }, async ({ page, note }) => {
  await start(page, ["ratesOld"], "분석"); await run(page, "분석");
  const panel = page.locator(".results-panel");
  await expect(panel.locator(".result-status")).toHaveText("분석 완료");
  const metric = panel.locator(".analysis-metric-table tbody tr").filter({ hasText: "145000" }).first();
  await expect(metric).toBeVisible(); await metric.locator(".source-action").click();
  await expect(page.getByLabel("근거 상세")).toContainText("운송단가");
  await noHorizontalOverflow(page); note("145000 surfaced with 운송단가 cell evidence");
});
regressionCase({ id: "WF-02", category: "Analyze", input: "CSV Korean row evidence", format: "CSV", structure: "header and two rows", expected: "CSV numeric metric cites original row" }, async ({ page, note }) => {
  await start(page, ["csv"], "분석"); await run(page, "분석");
  const panel = page.locator(".results-panel");
  await expect(panel.locator(".result-status")).toHaveText("분석 완료");
  const item = panel.locator(".analysis-metric-table tbody tr").filter({ hasText: "145000" }).first();
  await expect(item.locator(".source-action")).toBeVisible(); await item.locator(".source-action").click();
  // Evidence cites the cell (file · row · value); the row's label is not part of the evidence contract.
  const detail = page.getByLabel("근거 상세"); await expect(detail).toContainText("WF_csv.csv"); await expect(detail).toContainText("Row 2"); await expect(detail).toContainText("145000");
  note("CSV amount evidence cites WF_csv.csv Row 2 with its value");
});
regressionCase({ id: "WF-03", category: "Analyze", input: "DOCX table and prose", format: "DOCX", structure: "paragraph plus two-column table", expected: "document's 145000 value has source" }, async ({ page, note }) => {
  await start(page, ["docTable"], "분석"); await run(page, "분석");
  const panel = page.locator(".results-panel"); await expect(panel).toContainText("145000");
  const row = panel.locator(".analysis-metric-table tbody tr").filter({ hasText: "145000" }).first();
  await expect(row.locator(".source-action")).toBeVisible(); note("DOCX contract table amount and evidence appeared");
});
regressionCase({ id: "WF-04", category: "Analyze", input: "PPTX multi-slide headings", format: "PPTX", structure: "two slides", expected: "budget appears with correct slide source" }, async ({ page, note }) => {
  await start(page, ["deckOld"], "분석"); await run(page, "분석");
  const panel = page.locator(".results-panel"); await expect(panel).toContainText("5000");
  const source = panel.locator(".source-action").first(); await source.click();
  await expect(page.getByLabel("근거 상세")).toContainText("Slide"); note("PPTX budget rendered with slide locator");
});
regressionCase({ id: "WF-05", category: "Analyze", input: "Two-page PDF source order", format: "PDF", structure: "two pages", expected: "content sourced to PDF page" }, async ({ page, note }) => {
  await start(page, ["pdfOld"], "분석"); await run(page, "분석");
  const panel = page.locator(".results-panel"); await expect(panel).toContainText("5000");
  await panel.locator(".source-action").first().click();
  await expect(page.getByLabel("근거 상세")).toContainText(/page|페이지|Page/i); note("PDF budget retained page evidence");
});
regressionCase({ id: "WF-06", category: "Analyze", input: "Multi-file independent metrics", format: "XLSX + PPTX", structure: "sheet and slide", expected: "each value is attributed to its own file", mobile: true }, async ({ page, note }) => {
  await start(page, ["valuesA", "deckExtract"], "분석"); await run(page, "분석");
  const rows = page.locator(".analysis-metric-table tbody tr");
  await expect(rows.filter({ hasText: "64,550원" }).first()).toBeVisible();
  await expect(rows.filter({ hasText: path.basename(f.valuesA) }).first()).toBeVisible();
  await expect(rows.filter({ hasText: path.basename(f.deckExtract) }).first()).toBeVisible();
  await noHorizontalOverflow(page); note("Workbook and slide metrics attributed to their respective files");
});
regressionCase({ id: "WF-07", category: "Ask", input: "Specific rate with grounded source", format: "XLSX", structure: "keyed row", expected: "answer cites real sheet cell", mobile: true }, async ({ page, note }) => {
  await mockAi(page, (items, op) => op === "ask" ? items.filter((i) => i.text.includes("145000")).slice(0, 1).map((i) => ({ text: i.text, handles: [i.handle], confidence: "high" })) : []);
  await start(page, ["ratesOld"], "질문", false);
  await page.getByLabel("질문 입력").fill("SEOUL 단가는 얼마인가요?"); await run(page, "질문");
  const answer = page.locator(".ask-answer-row"); await expect(answer).toContainText("145000");
  await expect(answer).toContainText(path.basename(f.ratesOld)); await answer.locator(".source-action").first().click();
  await expect(page.getByLabel("근거 상세")).toContainText("운송단가"); await noHorizontalOverflow(page); note("SEOUL 145000 answer linked to original workbook cell");
});
regressionCase({ id: "WF-08", category: "Ask", input: "Unknown fact abstention", format: "XLSX", structure: "unrelated question", expected: "explicit no-answer warning, no invented source" }, async ({ page, note, classify }) => {
  await start(page, ["ratesOld"], "질문"); await page.getByLabel("질문 입력").fill("문서에 없는 대표이사의 혈액형은 무엇인가요?");
  await page.getByRole("button", { name: "질문 실행" }).click();
  await expect(page.locator(".notice.warning")).toContainText("질문에 답할 내용을 찾지 못했습니다.");
  await expect(page.locator(".ask-answer-row")).toHaveCount(0); classify("Expected"); note("No evidence: explicit abstention, zero sourced answers");
});
regressionCase({ id: "WF-09", category: "Ask", input: "Two-file evidence attribution", format: "XLSX", structure: "two revisions", expected: "each quoted answer identifies its source file" }, async ({ page, note }) => {
  await mockAi(page, (items, op) => op === "ask" ? ["145000", "158000"].flatMap((number) => { const item = items.find((i) => i.text.includes(number)); return item ? [{ text: item.text, handles: [item.handle], confidence: "high" }] : []; }) : []);
  await start(page, ["ratesOld", "ratesNew"], "질문", false);
  await page.getByLabel("질문 입력").fill("두 파일에서 SEOUL 단가가 각각 얼마인가요?"); await run(page, "질문");
  const rows = page.locator(".ask-answer-row"); await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "145000" })).toContainText(path.basename(f.ratesOld));
  await expect(rows.filter({ hasText: "158000" })).toContainText(path.basename(f.ratesNew)); note("Two differing rates remained attributed to correct revision");
});
regressionCase({ id: "WF-10", category: "Ask", input: "Unknown evidence handle", format: "XLSX", structure: "fabricated model citation", expected: "reject unsupported claim and warn", mobile: true }, async ({ page, note, classify }) => {
  await mockAi(page, (_, op) => op === "ask" ? [{ text: "허위 금액은 999999원입니다.", handles: ["E999"], confidence: "high" }] : []);
  await start(page, ["ratesOld"], "질문", false);
  await page.getByLabel("질문 입력").fill("SEOUL 단가는 얼마인가요?");
  await page.getByRole("button", { name: "질문 실행" }).click();
  await expect(page.locator(".notice.warning")).toContainText("질문에 답할 내용을 찾지 못했습니다.");
  await expect(page.locator(".ask-answer-row")).toHaveCount(0); await expect(page.locator(".workspace")).not.toContainText("999999");
  await noHorizontalOverflow(page); classify("Expected"); note("Fabricated E999 handle rejected; no answer leaked");
});
regressionCase({ id: "WF-11", category: "Compare", input: "XLSX rate change, added and removed cities", format: "XLSX", structure: "keyed rows", expected: "145000→158000, INCHEON added, DAEGU removed" }, async ({ page, note }) => {
  const panel = await version(page, "ratesOld", "ratesNew"); const rows = panel.getByTestId("change-row");
  await expect(rows.filter({ hasText: "145000" })).toContainText("158000");
  await expect(rows.filter({ hasText: "INCHEON" })).toHaveAttribute("data-category", "Added");
  await expect(rows.filter({ hasText: "DAEGU" })).toHaveAttribute("data-category", "Removed");
  await rows.filter({ hasText: "145000" }).locator(".source-action").first().click();
  await expect(page.getByLabel("근거 상세")).toContainText("운송단가"); note("Rate change and added/removed keyed rows with source");
});
regressionCase({ id: "WF-12", category: "Compare", input: "Identical XLSX revisions", format: "XLSX", structure: "same content, different names", expected: "no changes state", mobile: true }, async ({ page, note }) => {
  const panel = await version(page, "ratesOld", "ratesSame");
  await expect(panel.locator(".result-clear")).toContainText("비교된 변경 사항이 없습니다.");
  await expect(panel.getByTestId("change-row")).toHaveCount(0); await noHorizontalOverflow(page); note("Identical sheets yielded zero changes");
});
regressionCase({ id: "WF-13", category: "Compare", input: "Blank to numeric and direction swap", format: "XLSX", structure: "empty cell changed to number", expected: "145000 appears in target then base after swap" }, async ({ page, note }) => {
  const panel = await version(page, "ratesBlank", "ratesFilled");
  let row = panel.getByTestId("change-row").filter({ hasText: "145000" }); await expect(row.locator('[data-label="기준 파일 값"]')).toHaveText("—");
  await expect(row.locator('[data-label="대상 파일 값"]')).toHaveText("145000");
  await page.getByRole("button", { name: "기준/대상 바꾸기" }).click(); await expect(panel).toHaveCount(0);
  await run(page, "비교"); row = page.getByTestId("change-row").filter({ hasText: "145000" });
  await expect(row.locator('[data-label="기준 파일 값"]')).toHaveText("145000");
  await expect(row.locator('[data-label="대상 파일 값"]')).toHaveText("—"); note("Blank/value reversal followed displayed comparison direction");
});
regressionCase({ id: "WF-14", category: "Compare", input: "DOCX paragraph value revision", format: "DOCX", structure: "stable labelled paragraph", expected: "old and new departments appear in one change" }, async ({ page, note }) => {
  const panel = await version(page, "docOld", "docNew");
  const row = panel.getByTestId("change-row").filter({ hasText: "경영지원팀" });
  // The change table has no 항목 column by design (변경 유형/기준 값/대상 값/변동/근거); the label lives in the evidence.
  await expect(row).toContainText("운영지원팀");
  await row.locator(".source-action").first().click(); await expect(page.getByLabel("근거 상세")).toContainText(path.basename(f.docOld)); note("DOCX labelled department changed, source retained");
});
regressionCase({ id: "WF-15", category: "Compare", input: "PPTX slide budget change", format: "PPTX", structure: "two slides", expected: "5000 and 6000 tied to slide 1" }, async ({ page, note }) => {
  const panel = await version(page, "deckOld", "deckNew");
  const row = panel.getByTestId("change-row").filter({ hasText: "5000" }); await expect(row).toContainText("6000");
  await row.locator(".source-action").first().click(); await expect(page.getByLabel("근거 상세")).toContainText("Slide 1"); note("PPTX changed budget cited slide 1");
});
regressionCase({ id: "WF-16", category: "Compare", input: "PDF page budget change", format: "PDF", structure: "two text pages", expected: "5000/6000 change sourced to PDF page" }, async ({ page, note }) => {
  const panel = await version(page, "pdfOld", "pdfNew");
  const row = panel.getByTestId("change-row").filter({ hasText: "5000" }); await expect(row).toContainText("6000");
  await row.locator(".source-action").first().click(); await expect(page.getByLabel("근거 상세")).toContainText(/page|페이지|Page/i); note("PDF first-page budget changed and kept PDF locator");
});
regressionCase({ id: "WF-17", category: "Compare", input: "Version CSV and XLSX export round-trip", format: "CSV + XLSX", structure: "keyed-row diff", expected: "headers, count and Korean labels survive both downloads" }, async ({ page, note }) => {
  const panel = await version(page, "ratesOld", "ratesNew"); const count = await panel.getByTestId("change-row").count();
  const csvWait = page.waitForEvent("download"); await panel.getByRole("button", { name: "CSV 다운로드" }).click(); const csv = await csvRows(await csvWait);
  expect(csv[0]).toEqual(["변경 유형", "항목", "기준 파일 값", "대상 파일 값", "차이", "변화율", "기준 근거", "대상 근거"]);
  expect(csv).toHaveLength(count + 1); expect(csv.some((row) => row.includes("추가"))).toBe(true);
  const xlsxWait = page.waitForEvent("download"); await panel.getByRole("button", { name: "XLSX 다운로드" }).click(); const book = await xlsx(await xlsxWait);
  const sheet = book.getWorksheet("버전 비교"); expect(sheet).toBeDefined(); expect(sheet!.rowCount).toBe(count + 1);
  expect((sheet!.getRow(1).values as unknown[]).slice(1)).toEqual(csv[0]); expect(sheet!.getRow(2).getCell(1).value).toBe(csv[1][0]); note(`${count} UI changes round-tripped with Korean headers in CSV and XLSX`);
});
regressionCase({ id: "WF-18", category: "Compare", input: "Three-file value disagreement and absence", format: "XLSX", structure: "three extracted field lists", expected: "one differing value, one partially absent", mobile: true }, async ({ page, note }) => {
  const panel = await valueCheck(page, "valuesA", "valuesB", "valuesC");
  const target = panel.getByTestId("value-check-group").filter({ hasText: "목표주가" });
  await expect(target).toContainText("값 차이"); await expect(target).toContainText("62,000원");
  const partial = panel.getByTestId("value-check-group").filter({ hasText: "담당부서" });
  await expect(partial).toContainText("일부 파일만 확인"); await expect(partial).toContainText(path.basename(f.valuesC));
  await noHorizontalOverflow(page); note("Third file isolates disagreement and missing department without inventing a blank value");
});
regressionCase({ id: "WF-19", category: "Compare", input: "Value formatting equivalence", format: "XLSX", structure: "comma/dot date separators", expected: "64550원 and 64,550원 agree; dates agree" }, async ({ page, note }) => {
  const panel = await valueCheck(page, "valuesA", "valuesFormatted");
  const price = panel.getByTestId("value-check-group").filter({ hasText: "목표주가" });
  await expect(price).toContainText("64,550원"); await expect(price).toContainText("64550원"); await expect(price).toContainText("일치");
  await expect(panel.getByTestId("value-check-group").filter({ hasText: "기준일" })).toContainText("일치"); note("Equivalent numeric and date formatting normalized without losing display forms");
});
regressionCase({ id: "WF-20", category: "Compare", input: "Value-check CSV/XLSX three-file export", format: "CSV + XLSX", structure: "three-file matrix and evidence tab", expected: "UI group count, headers and Korean values survive both downloads" }, async ({ page, note }) => {
  const panel = await valueCheck(page, "valuesA", "valuesB", "valuesC"); const count = await panel.getByTestId("value-check-group").count();
  const csvWait = page.waitForEvent("download"); await panel.getByRole("button", { name: "CSV 다운로드" }).click(); const rows = await csvRows(await csvWait);
  expect(rows[0]).toEqual(["항목", ...["valuesA", "valuesB", "valuesC"].map((key) => path.basename(f[key])), "판정"]);
  expect(rows).toHaveLength(count + 1); expect(rows.some((row) => row.includes("목표주가") && row.includes("값 차이"))).toBe(true);
  const xlsxWait = page.waitForEvent("download"); await panel.getByRole("button", { name: "XLSX 다운로드" }).click(); const book = await xlsx(await xlsxWait);
  expect(book.getWorksheet("비교 결과")!.rowCount).toBe(count + 1); expect((book.getWorksheet("비교 결과")!.getRow(1).values as unknown[]).slice(1)).toEqual(rows[0]);
  const evidence = book.getWorksheet("근거 상세"); expect(evidence).toBeDefined();
  expect((evidence!.getRow(1).values as unknown[]).slice(1)).toEqual(["항목", "파일", "값", "위치"]); note(`${count} groups exported with Korean headings and separate evidence sheet`);
});
regressionCase({ id: "WF-21", category: "Check", input: "Korean typo and punctuation review", format: "PPTX", structure: "two inconsistent slides", expected: "known misspelling detected with slide evidence" }, async ({ page, note }) => {
  await start(page, ["deckCheck"], "검수"); await run(page, "검수");
  const typo = page.locator(".check-issue").filter({ hasText: "한글 맞춤법 오류 가능성" }); await expect(typo).toBeVisible();
  await expect(typo).toContainText("전먕"); await typo.locator(".source-action").click();
  await expect(page.getByLabel("근거 상세")).toContainText("Slide 1"); note("Misspelled 전먕 flagged with slide 1 evidence");
});
regressionCase({ id: "WF-22", category: "Check", input: "Number, unit and date inconsistencies", format: "PPTX", structure: "same labels with differing data", expected: "detect data conflicts and unit/date style differences" }, async ({ page, note }) => {
  await start(page, ["deckCheck"], "검수"); await run(page, "검수");
  const issues = page.locator(".check-issue");
  await expect(issues.filter({ hasText: "거리 단위 표기 불일치" })).toBeVisible();
  await expect(issues.filter({ hasText: /날짜 표기|날짜.*불일치/ }).first()).toBeVisible();
  await expect(issues.filter({ hasText: /수치.*불일치|숫자.*불일치/ }).first()).toBeVisible(); note("Detected numeric, date and km/KM unit inconsistencies");
});
regressionCase({ id: "WF-23", category: "Check", input: "Clean prose false-positive guard", format: "PPTX", structure: "one short consistent slide", expected: "zero findings" }, async ({ page, note }) => {
  await start(page, ["deckClean"], "검수"); await run(page, "검수");
  await expect(page.locator(".check-issue")).toHaveCount(0); note("Clean single-slide prose produced no findings");
});
regressionCase({ id: "WF-24", category: "Polish", input: "File prose rewrite retains name and amount", format: "DOCX", structure: "one sentence", expected: "valid rewrite accepted and source retained" }, async ({ page, note }) => {
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as { text: string };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "polish", proposal: { changed: true, revisedText: request.text.replace("검토 부탁드립니다", "검토해 주세요"), reasons: ["표현 정리"] } } }) });
  });
  await start(page, ["polish"], "윤문", false); await run(page, "윤문");
  const row = page.locator(".polish-results .polish-row"); await expect(row).toContainText("김하나"); await expect(row).toContainText("1,250만원");
  await expect(row.locator(".polish-copy-block.revised")).toContainText("검토해 주세요");
  await row.locator(".source-action").first().click(); await expect(page.getByLabel("근거 상세")).toContainText(path.basename(f.polish)); note("DOCX rewrite accepted with 김하나 and 1,250만원 preserved");
});
regressionCase({ id: "WF-25", category: "Polish", input: "Pasted text protects changed amount", format: "text", structure: "numbered sentence", expected: "model's 1500 substitution rejected, original 1250 kept", mobile: true }, async ({ page, note }) => {
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as { text: string };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "polish", proposal: { changed: true, revisedText: request.text.replace("1,250", "1,500"), reasons: ["표현 정리"] } } }) });
  });
  await page.goto("/"); await openView(page, "윤문"); await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  await page.getByLabel("윤문할 텍스트 입력").fill("1. 김하나의 매출은 1,250만원입니다."); await run(page, "윤문");
  const result = page.locator(".polish-text-results"); await expect(result).toContainText("보호 항목 1건 확인 필요");
  await expect(result.locator(".polish-copy-block.revised")).toContainText("1,250만원");
  await expect(result.locator(".polish-copy-block.revised")).not.toContainText("1,500만원"); await noHorizontalOverflow(page); note("Changed 1,500 rejected, original numbered 1,250 retained");
});
regressionCase({ id: "WF-26", category: "Extract", input: "Automatic labelled fields and export round-trip", format: "PPTX → CSV", structure: "slide label/value pairs", expected: "original Korean values, field count and sources survive CSV" }, async ({ page, note }) => {
  await start(page, ["deckExtract"], "추출"); await run(page, "추출");
  const panel = page.locator(".extract-results"); const rows = panel.locator(".extract-auto-table .data-row");
  await expect(rows.filter({ hasText: "작성부서" })).toContainText("경영지원팀");
  await expect(rows.filter({ hasText: "목표주가" })).toContainText("64,550원");
  const csvWait = page.waitForEvent("download"); await panel.getByRole("button", { name: "CSV 다운로드" }).click(); const csv = await csvRows(await csvWait);
  expect(csv[0]).toEqual(["FILE", "FIELD", "VALUE", "TYPE", "SOURCE"]);
  expect(csv.slice(1).filter((row) => row[3] !== "Record")).toHaveLength(await rows.count());
  expect(csv.some((row) => row[1] === "작성부서" && row[2] === "경영지원팀" && row[4].includes("Slide"))).toBe(true); note("Auto-extracted Korean field/value rows reopened from CSV with slide source");
});
regressionCase({ id: "WF-27", category: "Extract", input: "Named fields across two files", format: "PPTX → XLSX", structure: "two presentations with same labels", expected: "one workbook row per file and one column per requested field" }, async ({ page, note }) => {
  await start(page, ["deckExtract", "deckOld"], "추출"); await page.getByRole("radio", { name: "항목 지정" }).check();
  for (const field of ["작성부서", "예산"]) { await page.getByLabel("추출할 항목").fill(field); await page.getByRole("button", { name: "항목 추가" }).click(); }
  await run(page, "추출"); const panel = page.locator(".extract-results");
  await expect(panel.locator(".extract-fields-table .data-row")).toHaveCount(4);
  await expect(panel.locator(".extract-fields-table .data-row").filter({ hasText: "작성부서" }).first()).toContainText("경영지원팀");
  const download = page.waitForEvent("download"); await panel.getByRole("button", { name: "XLSX 다운로드" }).click(); const book = await xlsx(await download);
  const sheet = book.getWorksheet("Extracted Data")!; expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(["FILE", "작성부서", "예산"]);
  expect(sheet.rowCount).toBe(3); expect(sheet.getRow(2).getCell(2).value).toBe("경영지원팀");
  expect(book.getWorksheet("Evidence")!.rowCount).toBeGreaterThan(1); note("Named fields, two file rows, blanks and provenance reopened from XLSX");
});
regressionCase({ id: "WF-28", category: "Extract", input: "Extract offers only the shipped modes", format: "DOCX", structure: "paragraph plus table", expected: "자동 추출 and 항목 지정 only; the full-text mode was removed on purpose in eddd03d" }, async ({ page, note, classify }) => {
  await start(page, ["docTable"], "추출");
  const modes = page.getByRole("radiogroup", { name: "추출 방식" }).or(page.locator("fieldset.extract-modes"));
  await expect(modes.getByRole("radio")).toHaveCount(2);
  await expect(page.getByRole("radio", { name: "자동 추출" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "항목 지정" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /전체 텍스트/u })).toHaveCount(0);
  classify("Expected"); note("Full-text extract mode intentionally removed from the UI (commit eddd03d); only auto/fields offered");
});
