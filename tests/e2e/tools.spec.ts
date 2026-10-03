import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createDocxParagraphs, createPdf, createUnicodePdf } from "../fixtures";
import { fullResearchFixture } from "../fixtures/research";
import { classifyDocument, documentRisk, extractKeyFacts, reviewClauses, segmentsOf, splitClauses, type ContractReview } from "../../src/lib/contract-review";
import { B2B_SERVICE_CONTRACT, EMPLOYMENT_CONTRACT, SUPPLY_CONTRACT, NDA_CONTRACT } from "../fixtures/contracts";
import { CLEAN_WORK_RULES } from "../fixtures/review-scenarios";
import { navigateWorkspace } from "./navigation";

const researchTaskLabels: Record<string, string> = {
  full_research: "통합 조사", law_system: "법체계 확인", action_basis: "처분·허가 근거",
  dispute_prep: "분쟁·불복 자료", amendment_track: "개정 추적", ordinance_compare: "조례 비교",
  procedure_detail: "절차·서식", document_review: "문서 검토",
};

async function chooseOption(page: Page, trigger: Locator, label: string) {
  await trigger.click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

test("TOOLS navigation keeps document files in their own workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await page.getByLabel("작업 파일 선택").setInputFiles({
    name: "workspace-contract.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await createPdf(["Document workspace stays intact"])),
  });
  await expect(page.locator(".file-row").filter({ hasText: "workspace-contract.pdf" })).toBeVisible();

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await navigateWorkspace(page, "PDF 도구");
    await expect(page.locator(".context-bar h1")).toHaveText("PDF 도구");
    await expect(page.locator(".pdf-tool").getByRole("heading", { name: "페이지 편집", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "작업 파일" })).toHaveCount(0);
    await expect(page.locator(".file-row")).toHaveCount(0);
    await navigateWorkspace(page, "이미지 도구");
    await expect(page.locator(".context-bar h1")).toHaveText("이미지 도구");
    await expect(page.locator(".image-tool").getByRole("heading", { name: "이미지 편집", exact: true })).toHaveCount(0);
    await expect(page.locator(".file-row")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await navigateWorkspace(page, "분석");
    await expect(page.locator(".file-row").filter({ hasText: "workspace-contract.pdf" })).toBeVisible();
  }
});

test("RESEARCH law search opens an exact law article and falls back to results; case numbers go out canonical", async ({ page }) => {
  const searches: string[] = [];
  const texts: unknown[] = [];
  const analyses: unknown[] = [];
  await page.route("**/api/law", (route) => {
    const { query } = route.request().postDataJSON() as { query: string };
    searches.push(query);
    const laws = query === "근로기준법"
      ? [{ name: "근로기준법", status: "현행", lawId: "001872", mst: "283457", kind: "법률" }, { name: "근로기준법 시행령", status: "현행", lawId: "003058", mst: "270551", kind: "대통령령" }]
      : [{ name: "근로 관련 법", status: "현행", lawId: "000001", mst: "100001", kind: "법률" }];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, text: "", laws } }) });
  });
  await page.route("**/api/law/text", (route) => {
    texts.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, mode: "article", name: "근로기준법",
      text: "법령명: 근로기준법\n\n제74조 임산부의 보호\n제74조(임산부의 보호)\n① 사용자는 임신 중의 여성에게 출산 전과 출산 후를 통하여 90일의 출산전후휴가를 주어야 한다." } }) });
  });
  await page.route("**/api/law/analysis", (route) => {
    analyses.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: false, mode: "cite_check", marker: "NOT_FOUND", text: "[NOT_FOUND]" } }) });
  });
  await page.goto("/");
  await navigateWorkspace(page, "법령");
  const input = page.getByRole("searchbox");
  await input.fill("근로기준법 제74조 내용 알려줘");
  await input.press("Enter");
  await expect(page.locator("#law-detail-heading")).toHaveText("근로기준법");
  await expect(page.locator(".law-detail-content h3")).toHaveText("제74조");
  await expect(page.locator(".law-detail-content")).toContainText("90일의 출산전후휴가");
  await expect(page.locator("#law-article-number")).toHaveValue("제74조");
  expect(searches).toEqual(["근로기준법"]);
  expect(texts).toEqual([{ mst: "283457", jo: "제74조" }]);

  await page.getByRole("button", { name: "← 검색 결과로" }).click();
  await input.fill("근로 관련 제74조");
  await input.press("Enter");
  // No law is named exactly "근로 관련": the ordinary list is shown, nothing is opened.
  await expect(page.locator(".law-search-list li")).toHaveText([/근로 관련 법/u]);
  await expect(page.locator("#law-detail-heading")).toHaveCount(0);
  expect(texts).toHaveLength(1);

  await page.getByRole("tab", { name: "검증·분석", exact: true }).click();
  await page.getByRole("tablist", { name: "검증·분석 유형" }).getByRole("tab", { name: "판례 유효성" }).click();
  await page.getByLabel("사건번호").fill("2013 다 61381");
  await page.locator(".legal-analysis-form").getByRole("button", { name: "실행" }).click();
  await expect(page.locator(".legal-analysis-missing")).toBeVisible();
  await expect(page.getByLabel("사건번호")).toHaveValue("2013 다 61381");
  expect(analyses).toEqual([{ mode: "cite_check", caseNumber: "2013다61381" }]);
});

test("RESEARCH law search sends only the query and separates results, no result and outages", async ({ page }) => {
  const bodies: unknown[] = [];
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  let reply: { status: number; body: unknown } = { status: 200, body: { requestId: "r1", data: { found: true, text: "raw", laws: [
    { name: "근로기준법", status: "현행", lawId: "001872", mst: "283457", promulgationDate: "20260219", effectiveDate: "20260820", kind: "법률" },
    { name: "근로기준법 시행령", status: "현행", lawId: "003058", mst: "270551", effectiveDate: "20251023", kind: "대통령령" },
  ] } } };
  await page.route("**/api/law", async (route) => {
    bodies.push(route.request().postDataJSON());
    await page.waitForTimeout(150);
    await route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body) });
  });
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await page.getByLabel("작업 파일 선택").setInputFiles({ name: "keep.pdf", mimeType: "application/pdf", buffer: Buffer.from(await createPdf(["kept"])) });
  await expect(page.locator(".file-row").filter({ hasText: "keep.pdf" })).toBeVisible();

  await navigateWorkspace(page, "법령");
  // At tablet width the navigation is collapsed behind the menu button but still marks the current view.
  await expect(page.getByRole("button", { name: "법령", exact: true, includeHidden: true }).first()).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".context-bar h1")).toHaveText("법령");
  await expect(page.getByRole("heading", { name: /^검색 결과/ })).toHaveCount(0);
  await expect(page.locator(".law-search-results")).toHaveCount(0);
  await expect(page.getByText("법령명 또는 키워드로 현행 법령을 검색하세요.")).toHaveCount(0);

  const input = page.getByRole("searchbox");
  await input.fill("근로기준법");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "검색 중…" })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "검색 결과 · 2건" })).toBeVisible();
  const first = page.locator(".law-search-list li").first();
  await expect(first).toContainText("근로기준법");
  await expect(first).toContainText("법률");
  await expect(first).toContainText("시행일 2026.08.20");
  await expect(page.getByText("283457")).toHaveCount(0);
  await expect(page.getByText("raw", { exact: true })).toHaveCount(0);
  expect(bodies).toEqual([{ query: "근로기준법" }]);

  reply = { status: 200, body: { requestId: "r2", data: { found: false, marker: "NOT_FOUND", text: "[NOT_FOUND]" } } };
  await input.fill("없는법령");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "검색 결과가 없습니다." })).toBeVisible();

  reply = { status: 504, body: { requestId: "r3", error: { code: "LAW_UPSTREAM_TIMEOUT", message: "법령 검색 응답이 지연되고 있습니다." } } };
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.locator(".law-search-error[role=alert]")).toHaveText("법령 검색 응답이 지연되고 있습니다.");
  await expect(page.getByText("검색 결과가 없습니다.")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await navigateWorkspace(page, "분석");
  await expect(page.locator(".file-row").filter({ hasText: "keep.pdf" })).toBeVisible();
  expect(errors.filter((text) => !/504/.test(text))).toEqual([]);
});

test("RESEARCH law detail browses raw TOC and articles, recovers, and preserves results", async ({ page }) => {
  const requests: unknown[] = [];
  let retryCount = 0;
  await page.route("**/api/law", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, laws: [
      { name: "근로기준법", mst: "283457", lawId: "001872", effectiveDate: "20260820" },
      { name: "시행령", lawId: "003058" },
      { name: "식별자 없는 법" },
    ] } }) });
  });
  await page.route("**/api/law/text", async (route) => {
    const request = route.request().postDataJSON();
    requests.push(request);
    const jo = request.jo;
    const status = jo === "제10조의2" && retryCount++ === 0 ? 503 : 200;
    const data = jo === "제9999조"
      ? { found: false, marker: "NOT_FOUND", text: "[NOT_FOUND] 조문 내용을 찾을 수 없습니다." }
      : jo
        ? { found: true, mode: "article", text: `${jo} 임산부의 보호\n${jo}(임산부의 보호)\n① 원문 그대로` }
        : { found: true, mode: "toc", text: `법령명: 근로기준법\n공포일: 20260219\n시행일: 20260820\n\n목차 (총 132개 조문)\n\n제74조 ${"긴원문".repeat(150)}`, name: "근로기준법", promulgationDate: "20260219", effectiveDate: "20260820", articles: [{ jo: "제74조", title: "임산부의 보호" }] };
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 503 ? { error: { message: "원문 서비스 오류" } } : { data }) });
  });

  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await navigateWorkspace(page, "법령");
  await page.getByRole("searchbox").fill("근로기준법");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByRole("heading", { name: "검색 결과 · 3건" })).toBeVisible();
  await expect(page.locator(".law-search-unavailable")).toContainText("원문 조회 불가");
  await expect(page.locator(".law-search-list button")).toHaveCount(2);

  await page.locator(".law-search-list button").first().click();
  await expect(page.getByRole("heading", { name: "근로기준법" })).toBeVisible();
  await expect(page.locator(".law-detail-raw")).toContainText("목차 (총 132개 조문)");
  await page.getByText("원문 보기", { exact: true }).click();
  await expect(page.locator(".law-detail-raw")).toBeVisible();
  await page.getByText("원문 접기", { exact: true }).click();
  await expect(page.getByText("공포일 2026.02.19")).toBeVisible();
  expect(requests).toEqual([{ mst: "283457" }]);
  await page.getByRole("navigation", { name: "조문 목차" }).getByRole("button", { name: "제74조 임산부의 보호" }).click();
  await expect(page.locator(".law-detail-raw")).toHaveText("제74조 임산부의 보호\n제74조(임산부의 보호)\n① 원문 그대로");
  await page.getByRole("button", { name: "← 목차로" }).click();
  await expect(page.locator(".law-detail-raw")).toContainText("목차 (총 132개 조문)");
  expect(requests).toEqual([{ mst: "283457" }, { mst: "283457", jo: "제74조" }]);

  const article = page.getByLabel("조문 번호로 찾기");
  await article.fill("74");
  await page.getByRole("button", { name: "조문 보기" }).click();
  await expect(page.locator(".law-article-form [role=alert]")).toContainText("제74조 또는 제10조의2");
  expect(requests).toHaveLength(2);
  await article.fill("제9999조");
  await page.getByRole("button", { name: "조문 보기" }).click();
  await expect(page.getByRole("status").filter({ hasText: "조문을 찾을 수 없습니다." })).toBeVisible();
  await expect(page.locator(".law-detail-raw")).toHaveCount(0);
  await article.fill("제10조의2");
  await page.getByRole("button", { name: "조문 보기" }).click();
  await expect(page.locator(".law-detail-feedback[role=alert]")).toContainText("원문 서비스 오류");
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.locator(".law-detail-raw")).toContainText("제10조의2(임산부의 보호)");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "← 목차로" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "← 검색 결과로" }).click();
  await expect(page.getByRole("searchbox")).toHaveValue("근로기준법");
  await expect(page.getByRole("heading", { name: "검색 결과 · 3건" })).toBeVisible();
  await page.locator(".law-search-list button").nth(1).click();
  await expect(page.locator(".law-detail-raw")).toContainText("목차 (총 132개 조문)");
  expect(requests.at(-1)).toEqual({ lawId: "003058" });
});

test("RESEARCH decision search puts the exact case number first and keeps the other results", async ({ page }) => {
  const searches: unknown[] = [];
  await page.route("**/api/law/decisions/search", (route) => {
    const body = route.request().postDataJSON() as { domain: string; query: string };
    searches.push(body);
    const entries = body.domain === "precedent" && body.query === "2013다61381" ? [
      { domain: "precedent", id: "619495", caseNumber: "2023두54761", court: "대법원", date: "20260409", title: "원천징수법인세환급거부처분취소" },
      { domain: "precedent", id: "623079", caseNumber: "2024두65607", court: "대법원", date: "20260409", title: "법인세경정거부처분취소" },
      { domain: "precedent", id: "204201", caseNumber: "2013다61381", court: "대법원", date: "20181030", title: "손해배상(기)" },
      { domain: "precedent", id: "204201", caseNumber: "2013다61381", court: "대법원", date: "20181030", title: "손해배상(기)" },
    ] : body.query === "2099다1" ? [
      { domain: "precedent", id: "1", caseNumber: "2020다1", court: "대법원", date: "20200101", title: "다른 판례" },
    ] : [
      { domain: body.domain, id: "9", caseNumber: "2016부해OOO", date: "2016.05.09", title: "부당해고 구제신청" },
    ];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, page: 1, text: "", totalCount: entries.length, hasNext: false, entries } }) });
  });
  await page.goto("/");
  await navigateWorkspace(page, "법령");
  await page.getByRole("tab", { name: "판례·결정례", exact: true }).click();
  const input = page.locator("#decision-query");
  const results = page.locator(".decision-search-results");

  await input.fill("2013 다 61381");
  await input.press("Enter");
  await expect(results.locator("h2")).toHaveText("일치 결과 · 1건");
  await expect(results.locator(".decision-search-list").first().locator("li")).toHaveText([/손해배상\(기\)2013다61381/u]);
  await expect(results.locator("h3")).toHaveText("다른 검색 결과 · 2건");
  await expect(results.locator(".decision-search-list").nth(1).locator("li")).toHaveCount(2);
  await expect(input).toHaveValue("2013 다 61381");

  await input.fill("2099다1");
  await input.press("Enter");
  await expect(results.locator("h2")).toHaveText("일치 결과 · 0건");
  await expect(results).toContainText("일치하는 자료를 찾지 못했습니다.");
  await expect(results.locator("h3")).toHaveText("다른 검색 결과 · 1건");

  await input.fill("취업규칙 불이익 변경");
  await input.press("Enter");
  await expect(results.locator("h2")).toHaveText("검색 결과 · 1건");
  await expect(results.locator("h3")).toHaveCount(0);

  await chooseOption(page, page.locator("#decision-domain"), "노동위 결정문");
  await expect(results).toHaveCount(0);
  await input.fill("2013다61381");
  await input.press("Enter");
  // A 판례 number is only a keyword for 노동위.
  await expect(results.locator("h2")).toHaveText("검색 결과 · 1건");
  expect(searches).toEqual([
    { domain: "precedent", query: "2013다61381", page: 1 },
    { domain: "precedent", query: "2099다1", page: 1 },
    { domain: "precedent", query: "취업규칙 불이익 변경", page: 1 },
    { domain: "nlrc", query: "2013다61381", page: 1 },
  ]);
});

test("RESEARCH decision search keeps identifiers and results across detail and full-text states", async ({ page }) => {
  const searches: unknown[] = [];
  const details: unknown[] = [];
  let fullFails = true;
  await page.route("**/api/law/decisions/search", async (route) => {
    const input = route.request().postDataJSON();
    searches.push(input);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      data: input.domain === "precedent"
        ? { found: true, page: 1, totalCount: 2, text: "[609561] 부당해고 사건", entries: [
          { domain: "precedent", id: "609561", title: "부당해고 사건", caseNumber: "2023다12345", court: "대법원", date: "20240314" },
          { domain: "precedent", id: "609562", title: "다른 판결", caseNumber: "2022다67890" },
        ] }
        : { found: false, marker: "NOT_FOUND", text: "[NOT_FOUND] 검색 결과가 없습니다." },
    }) });
  });
  await page.route("**/api/law/decisions/text", async (route) => {
    const input = route.request().postDataJSON();
    details.push(input);
    const error = input.full && fullFails;
    await route.fulfill({ status: error ? 503 : 200, contentType: "application/json", body: JSON.stringify(error
      ? { error: { code: "LAW_UPSTREAM_UNAVAILABLE", message: "상세 서비스를 사용할 수 없습니다." } }
      : { data: { found: true, title: "부당해고 사건", expandable: !input.full, text: input.full
        ? "판시사항:\n판단 원문\n\n이유:\n긴 이유 원문 그대로"
        : "판시사항:\n판단 원문\n\n이유:\n요약된 원문" } }) });
  });
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await navigateWorkspace(page, "법령");
  await page.getByRole("tab", { name: "판례·결정례", exact: true }).click();
  await expect(page.getByRole("combobox", { name: /자료 유형/ })).toContainText("판례");
  await page.getByLabel("검색어", { exact: true }).fill("부당해고");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByRole("button", { name: /부당해고 사건/ })).toBeVisible();
  expect(searches).toEqual([{ domain: "precedent", query: "부당해고", page: 1 }]);
  await page.getByRole("button", { name: /부당해고 사건/ }).click();
  await expect(page.locator(".decision-detail-raw")).toContainText("요약된 원문");
  expect(details).toEqual([{ domain: "precedent", id: "609561" }]);

  await page.getByRole("button", { name: "전문 보기" }).click();
  await expect(page.locator(".decision-detail [role='alert']")).toContainText("상세 서비스를 사용할 수 없습니다.");
  await expect(page.locator(".decision-detail-raw")).toContainText("요약된 원문");
  fullFails = false;
  await page.getByRole("button", { name: "전문 보기" }).click();
  await expect(page.locator(".decision-detail-raw")).toContainText("긴 이유 원문 그대로");
  expect(details).toEqual([{ domain: "precedent", id: "609561" }, { domain: "precedent", id: "609561", full: true }, { domain: "precedent", id: "609561", full: true }]);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "← 검색 결과로" }).click();
  await expect(page.getByLabel("검색어", { exact: true })).toHaveValue("부당해고");
  await expect(page.getByRole("button", { name: /부당해고 사건/ })).toBeVisible();
  expect(searches).toHaveLength(1);
  await chooseOption(page, page.getByRole("combobox", { name: /자료 유형/ }), "헌재 결정례");
  await expect(page.getByRole("button", { name: /부당해고 사건/ })).toHaveCount(0);
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "검색 결과가 없습니다." })).toBeVisible();
  expect(searches.at(-1)).toEqual({ domain: "constitutional", query: "부당해고", page: 1 });
});

test("law article opens deterministic related decisions and returns without refetch", async ({ page }) => {
  const lawCalls: unknown[] = [];
  const decisionQueries: unknown[] = [];
  await page.route("**/api/law", async (route) => {
    lawCalls.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, laws: [{ name: "근로기준법", mst: "283457" }] } }) });
  });
  await page.route("**/api/law/text", async (route) => {
    const input = route.request().postDataJSON();
    lawCalls.push(input);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: input.jo
      ? { found: true, mode: "article", text: "제74조(임산부의 보호)\n① 조문 본문" }
      : { found: true, mode: "toc", text: "목차 (총 1개 조문)\n제74조 임산부의 보호", articles: [{ jo: "제74조", title: "임산부의 보호" }] } }) });
  });
  await page.route("**/api/law/decisions/search", async (route) => {
    decisionQueries.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, page: 1, text: "[609561] 관련 판결", entries: [{ domain: "precedent", id: "609561", title: "관련 판결" }] } }) });
  });
  await page.route("**/api/law/decisions/text", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, text: "판시사항:\n판결문 원문" } }) });
  });
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await navigateWorkspace(page, "법령");
  await page.getByRole("searchbox").fill("근로기준법");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await page.locator(".law-search-list button").first().click();
  await page.getByRole("navigation", { name: "조문 목차" }).getByRole("button", { name: "제74조 임산부의 보호" }).click();
  await expect(page.locator(".law-detail-raw")).toContainText("조문 본문");
  await page.getByRole("button", { name: "관련 판례·결정례" }).click();
  await expect(page.getByRole("combobox", { name: /자료 유형/ })).toContainText("판례");
  await expect(page.getByLabel("검색어", { exact: true })).toHaveValue("근로기준법 제74조");
  await expect(page.getByLabel("검색어", { exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "관련 판결" })).toBeVisible();
  expect(decisionQueries).toEqual([{ domain: "precedent", query: "근로기준법 제74조", page: 1 }]);
  await page.getByRole("button", { name: "관련 판결" }).click();
  await expect(page.locator(".decision-detail-raw")).toContainText("판결문 원문");
  await page.getByRole("button", { name: "← 검색 결과로" }).click();
  await page.getByRole("button", { name: "← 법령으로" }).click();
  await expect(page.locator(".law-detail-raw")).toContainText("조문 본문");
  await expect(page.getByRole("button", { name: "관련 판례·결정례" })).toBeFocused();
  expect(lawCalls).toEqual([{ query: "근로기준법" }, { mst: "283457" }, { mst: "283457", jo: "제74조" }]);
});

test("law results render MCP <br> tags as line breaks and keep other HTML inert in every law view", async ({ page }) => {
  const executed: string[] = [];
  await page.exposeFunction("markExecuted", (value: string) => executed.push(value));
  const judgment = (full: boolean) => ["판시사항:<br/>근로자 해고의 정당성", "이유:<BR/>첫째 문단<br />둘째 문단<br/>다음과 같이 판결한다.", ...(full ? Array.from({ length: 60 }, (_, index) => `【${index + 1}】 긴 판결 이유 문단입니다.`) : ["⋯ 중략 3,198자 (full=true로 전문 조회) ⋯"])]
    .join("<br/><br/>") + "<script>window.markExecuted('decision')</script>\n\n💡 다음: get_precedent_text(id=\"1\") 로 판결문 전문. full=true 로 축약 해제. 유사판례 원하면 find_similar_precedents 사용.";
  await page.route("**/api/law", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, laws: [{ name: "근로기준법", mst: "283457" }] } }) }));
  await page.route("**/api/law/text", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
    found: true, mode: "article", text: "제23조(해고 등의 제한)<br>① 사용자는 정당한 이유 없이 해고하지 못한다.<br><br>② 다음 각 호<img src=x onerror=\"window.markExecuted('law')\">",
  } }) }));
  await page.route("**/api/law/decisions/search", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
    found: true, page: 1, text: "[1] 해고 사건", entries: [{ domain: "precedent", id: "1", title: "해고 사건", caseNumber: "2023다1", summary: "요지 첫 줄" }],
  } }) }));
  await page.route("**/api/law/decisions/text", async (route) => {
    const input = route.request().postDataJSON() as { full?: boolean };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, title: "해고 사건", expandable: !input.full, text: judgment(Boolean(input.full)) } }) });
  });
  await page.route("**/api/law/analysis", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
    found: true, mode: "applicable_law", markers: [], text: "═══ 행위시법 판단: 근로기준법 @ 2023.05.10 ═══<br/><br/>▶ 기준일에 시행 중이던 버전<br>  근로기준법 [시행 2023.04.04]",
  } }) }));
  await page.route("**/api/law/research", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
    found: true, task: "full_research", markers: [], text: "═══ 리서치: 해고 ═══\n\n▶ 관련 법령\n근로기준법 제23조<br/>근로기준법 제24조<script>window.markExecuted('research')</script>\n특정 조문 조회: get_law_text(mst=\"283457\", jo=\"제XX조\")\n\n▶ 관련 판례\n검색 보정: body_search=\"해고 통고 기간\" (본문검색)\n자동 상세조회: search_precedents -> get_precedent_text (상위 2건, full=false)\n[1] 해고 사건",
  } }) }));
  const pres = page.locator("pre");
  const expectClean = async () => {
    for (const text of await pres.allTextContents()) {
      expect(text, text).not.toMatch(/<\s*\/?\s*br|get_precedent_text|find_similar_precedents|search_precedents|get_law_text|body_search|full=(?:true|false)/iu);
    }
  };

  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await navigateWorkspace(page, "법령");
  await page.getByRole("searchbox").fill("근로기준법");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await page.locator(".law-search-list button").first().click();
  const article = page.locator(".law-detail-raw").first();
  await expect(article).toContainText("정당한 이유 없이 해고하지 못한다.");
  expect(await article.textContent()).toContain("제23조(해고 등의 제한)\n① 사용자는");
  await expect(article).toContainText("<img src=x onerror=");
  await expectClean();

  await page.getByRole("tab", { name: "판례·결정례", exact: true }).click();
  await page.getByLabel("검색어", { exact: true }).fill("해고");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.locator(".decision-search-summary")).toHaveText("요지 첫 줄");
  await page.getByRole("button", { name: /해고 사건/ }).click();
  const decision = page.locator(".decision-detail-raw");
  await expect(decision).toContainText("첫째 문단");
  expect(await decision.textContent()).toContain("판시사항:\n근로자 해고의 정당성\n\n이유:\n첫째 문단\n둘째 문단");
  await expect(decision).toContainText("<script>window.markExecuted('decision')</script>");
  await expect(decision).toContainText("다음과 같이 판결한다.");
  await expect(decision).toContainText("⋯ 중략 3,198자 ⋯");
  await expectClean();
  await page.getByRole("button", { name: "전문 보기" }).click();
  await expect(decision).toContainText("【60】 긴 판결 이유 문단입니다.");
  expect((await decision.textContent())!.split("\n\n").length).toBeGreaterThanOrEqual(62);
  await expectClean();
  const lineHeight = await decision.evaluate((node) => parseFloat(getComputedStyle(node).lineHeight));
  expect((await decision.boundingBox())!.height).toBeGreaterThan(lineHeight * 100);

  await page.getByRole("tab", { name: "검증·분석", exact: true }).click();
  await page.getByRole("tablist", { name: "검증·분석 유형" }).getByRole("tab", { name: "시점별 적용 법령" }).click();
  await page.locator("#analysis-applicable-law").fill("근로기준법");
  await page.locator("#analysis-applicable-jo").fill("제23조");
  await page.locator("#analysis-applicable-date").fill("2023-05-10");
  await page.locator(".legal-analysis-form:visible button[type='submit']").click();
  await expect(page.locator(".legal-analysis-output")).toContainText("근로기준법 [시행 2023.04.04]");
  await expectClean();

  await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
  await page.getByRole("form", { name: /^(종합 리서치|문서 검토) 입력$/ }).getByLabel("질문 또는 검색어").fill("해고");
  await page.getByRole("form", { name: /^(종합 리서치|문서 검토) 입력$/ }).getByRole("button", { name: "실행" }).click();
  const lines = page.locator(".legal-research .legal-analysis-lines").first();
  await expect(lines).toContainText("근로기준법 제24조");
  expect(await lines.textContent()).toContain("근로기준법 제23조\n근로기준법 제24조");
  await expectClean();
  await expect(page.locator(".legal-research .legal-analysis-output")).toContainText("[1] 해고 사건");
  expect(executed).toEqual([]);
});

const ANALYSIS_TEXT: Record<string, string> = {
  verify_citations: "[PARTIAL_VERIFIED] == 인용 검증 결과 ==\n법령 인용 3건 | ✓ 1 실존 | ✗ 1 오류 | ⌛ 0 폐지 | ⚠ 1 확인필요\n판례 인용 0건 | ✓ 0 실존 | ✗ 0 실존불가 | ⚠ 0 미확인\n\n▶ 법령 인용\n✓ 민법 제750조(불법행위의 내용) 실존\n✗ 형법 제9999조 — [NOT_FOUND] 해당 조문 없음 (존재 범위: 제1조~제372조)\n⚠ 같은 법 시행규칙 제2조 — 법령명 불명확\n\n💡 ⚠ 항목은 법령명 불명확/부분 매칭/API 일시 실패 등. 법령명을 명시하거나 재시도하세요.",
  cite_check: "═══ 판례 인용 추적 (Citator): 2013다61381 ═══\n대상: 대법원 2018.10.30 선고 2013다61381 전원합의체 판결\n사건명: 손해배상(기)\n판시사항: [1] 조약의 해석 방법과 당사국 사이에 이루어진 합의의 적용 범위\n  기준 사건에서 당사자가 주장한 청구권의 적용 대상에 관한 설명\n\n📊 판정: ✅ 후속 인용 2건, 변경·폐기 신호 미감지 — 계속 인용되는 것으로 추정\n\n▶ 이 판례를 인용한 후속 판례 (2건, 최신순)\n  1. 대법원 2024.01.25 2019다3226 — 손해배상\n\n⚠️ 한계: 법제처 수록 판례(대법원 중심) 범위 내 검색입니다.",
  applicable_law: "═══ 행위시법 판단: 도로교통법 @ 2023.05.10 ═══\n\n▶ 기준일에 시행 중이던 버전\n  도로교통법 [시행 2023.04.04] (MST 247265)\n\n▶ 현행과 비교: △ 변경됨 — 현행 본문과 다릅니다.\n\n▶ 적용례·경과조치 발췌 (기준일 사건에 영향 가능 — 반드시 확인)\n  ◆ 부칙 <제20864호, 2025.04.01>\n    제2조(운전면허의 결격사유에 관한 적용례) 긴 부칙 문장이 줄바꿈 없이 이어지는 경우에도 화면 폭 안에서 줄바꿈되어야 합니다",
  impact_map: "═══ Impact Map: 민법 제103조 ═══\n\n▶ 대상 조문 본문\n제103조(반사회질서의 법률행위) 선량한 풍속 기타 사회질서에 위반한 사항을 내용으로 하는 법률행위는 무효로 한다.\n\n▶ 영향 그래프 (이 조문이 인용된 곳)\n├─ 📚 대법원 판례: 7건 확인 / 검색 42건 — 표본 10건만 경계 확인, 나머지는 미확인\n│   • [245007] 반사회적 법률행위 · 사건번호: 대법원-2023-다-302036\n├─ ⚖️ 헌재 결정례: 조회 실패 (업스트림 오류로 확인 못 함, 0건이 아님)\n└─ 🏛️ 자치법규(법령 단위·조번호 미반영): 2건\n\n▶ 총 영향 건수(경계 확인분): 9건 — 표본을 넘는 검색 결과가 있어 실제는 더 많을 수 있음",
};

async function routeAnalysis(page: Page, requests: unknown[], failFirst = new Set<string>()) {
  await page.route("**/api/law/analysis", async (route) => {
    const input = route.request().postDataJSON() as { mode: string };
    requests.push(input);
    if (failFirst.delete(input.mode)) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "LAW_UPSTREAM_UNAVAILABLE", message: "법령 검색 서비스가 일시적으로 응답하지 않습니다.", retryable: true } }) });
      return;
    }
    const text = ANALYSIS_TEXT[input.mode];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, mode: input.mode, text, markers: [...text.matchAll(/\[([A-Z][A-Z_]+)\]/gu)].map((match) => match[1]) } }) });
  });
}

test("RESEARCH analysis runs each fixed mode, keeps MCP meaning and retries without retyping", async ({ page }) => {
  const requests: unknown[] = [];
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await routeAnalysis(page, requests, new Set(["verify_citations"]));
  const evidenceRequests: string[] = [];
  await page.route("**/api/law", (route) => {
    evidenceRequests.push(`search:${(route.request().postDataJSON() as { query: string }).query}`);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, text: "", laws: [
      { name: "민법", status: "현행", lawId: "001706", mst: "284415", promulgationDate: "20260317", effectiveDate: "20260317", kind: "법률" },
    ] } }) });
  });
  await page.route("**/api/law/text", (route) => {
    evidenceRequests.push(`text:${JSON.stringify(route.request().postDataJSON())}`);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, mode: "article", name: "민법", promulgationDate: "20260317", effectiveDate: "20260317",
      text: "법령명: 민법\n공포일: 20260317\n시행일: 20260317\nℹ️ 조회기준일 20260929 — 위 시행일 버전 본문.\n\n제750조 불법행위의 내용\n고의 또는 과실로 인한 위법행위로 타인에게 손해를 가한 자는 그 손해를 배상할 책임이 있다.\n" } }) });
  });
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await navigateWorkspace(page, "법령");
  await page.getByRole("tab", { name: "검증·분석", exact: true }).click();
  const modes = page.getByRole("tablist", { name: "검증·분석 유형" });
  await expect(modes.getByRole("tab")).toHaveText(["인용 검증", "판례 유효성", "시점별 적용 법령", "조문 영향도"]);

  const text = "민법 제750조와 형법 제9999조, 같은 법 시행규칙 제2조를 인용한다.";
  await expect(page.locator(".legal-analysis-form").getByRole("button", { name: "실행" })).toBeDisabled();
  await page.getByLabel("검증할 문장을 입력하세요.").fill(text);
  await expect(page.getByText(`${text.length} / 5,000자`)).toBeVisible();
  await page.locator(".legal-analysis-form").getByRole("button", { name: "실행" }).click();
  await expect(page.locator(".legal-analysis-result [role='alert']")).toContainText("일시적으로 응답하지 않습니다");
  await page.getByRole("button", { name: "다시 시도" }).click();
  const citations = page.locator(".legal-analysis-citations li");
  await expect(citations).toHaveCount(3);
  await expect(citations.locator(".legal-analysis-status")).toHaveText(["확인됨", "찾을 수 없음", "확인 필요"]);
  await expect(citations.locator(".legal-analysis-citation-text")).toHaveText(["민법 제750조(불법행위의 내용)", "형법 제9999조", "같은 법 시행규칙 제2조"]);
  await expect(citations.nth(2)).toHaveClass(/is-unknown/);
  await expect(page.locator(".legal-analysis-overall")).toHaveText("확인이 필요한 인용이 있습니다.");
  await expect(citations.nth(1)).toHaveAttribute("data-markers", "NOT_FOUND");
  await expect(citations.nth(1)).not.toContainText("[NOT_FOUND]");
  await expect(page.locator(".legal-analysis-output > .legal-analysis-section").last()).toContainText("자료 조회가 일시적으로 실패한 경우");
  expect(requests).toEqual([{ mode: "verify_citations", text }, { mode: "verify_citations", text }]);
  const citationOutput = page.locator(".legal-analysis-output");
  await expect(citationOutput.locator(":scope > .legal-analysis-lines")).toHaveText("법령 인용 3건 · 확인 1건 · 찾을 수 없음 1건 · 확인 필요 1건\n판례 인용 없음");
  const citationSource = citationOutput.locator(".law-detail-source");
  await expect(citationSource).not.toHaveAttribute("open", "");
  await expect(citationOutput).not.toContainText("[PARTIAL_VERIFIED]");
  await expect(citationOutput).not.toContainText(/실존|입력 원문|⌛|✓/u);
  await expect(citationSource.locator("summary")).toContainText("근거 보기");
  await citationSource.locator("summary").click();
  await expect(citationSource).toContainText("고의 또는 과실로 인한 위법행위로 타인에게 손해를 가한 자는 그 손해를 배상할 책임이 있다.");
  await expect(citationSource).toContainText("시행일 2026.03.17 · 공포일 2026.03.17 · 법령 버전(MST) 284415 · 출처 국가법령정보센터(법제처)");
  await expect(citationSource).not.toContainText(/조문 확인$|조회기준일|조문·판결문 원문은/u);
  await expect(citationSource).toContainText("형법 제9999조 — 해당 조문 없음 (존재 범위: 제1조~제372조)");
  await expect(citationSource).not.toContainText(text);
  await citationSource.locator("summary").click();
  await citationSource.locator("summary").click();
  await expect(citationSource).toContainText("손해를 배상할 책임이 있다.");
  await citationSource.locator("summary").click();
  // Reopening reuses the evidence already loaded for this verification.
  expect(evidenceRequests).toEqual(["search:민법", 'text:{"mst":"284415","jo":"제750조"}']);

  await modes.getByRole("tab", { name: "판례 유효성" }).click();
  await page.getByLabel("사건번호").fill("2013다61381");
  await page.locator(".legal-analysis-form").getByRole("button", { name: "실행" }).click();
  await expect(page.locator(".legal-analysis-title")).toHaveText("판례 인용 추적: 2013다61381");
  await expect(page.locator(".legal-analysis-verdict")).toContainText("후속 인용 2건에서 변경·폐기 정황을 확인하지 못했습니다. 현재까지 계속 인용되는 것으로 보입니다.");
  await expect(page.locator(".legal-analysis-output")).toContainText("후속 판례를 기준으로 자동 확인한 결과입니다.");
  await expect(page.locator(".legal-analysis-output")).not.toContainText(/신호|휴리스틱|미감지/u);
  const citeOutput = page.locator(".legal-analysis-output");
  await expect(citeOutput.locator(":scope > .legal-analysis-lines").first()).toContainText("대상: 대법원");
  await expect(citeOutput.locator(":scope > .legal-analysis-lines").first()).not.toContainText("판시사항");
  await expect(citeOutput.locator(":scope > .legal-analysis-section")).toHaveCount(0);
  await citeOutput.locator(".law-detail-source summary").click();
  await expect(citeOutput.locator(".law-detail-source")).toContainText("2019다3226");
  await expect(citeOutput.locator(".law-detail-source")).toContainText("판시사항: [1] 조약의 해석 방법");
  await expect(citeOutput.locator(".law-detail-source")).toContainText("청구권의 적용 대상에 관한 설명");
  await expect(citeOutput.locator(".law-detail-source")).not.toContainText("계속 인용되는 것으로 보입니다");
  await citeOutput.locator(".law-detail-source summary").click();

  await modes.getByRole("tab", { name: "시점별 적용 법령" }).click();
  const analysisForm = page.locator(".legal-analysis-form");
  await analysisForm.getByLabel("법령명", { exact: true }).fill("도로교통법");
  await analysisForm.getByLabel("조문 (선택)").fill("44");
  const applicableSubmit = page.locator(".legal-analysis-form").getByRole("button", { name: "실행" });
  await expect(applicableSubmit).toBeDisabled();
  await analysisForm.getByLabel("기준일").fill("2023-05-10");
  await applicableSubmit.click();
  await expect(page.locator(".legal-analysis-title")).toHaveText("행위시법 판단: 도로교통법 · 기준일 2023.05.10");
  await expect(page.locator(".legal-analysis-output")).toContainText("현행과 비교: △ 변경됨");

  await modes.getByRole("tab", { name: "조문 영향도" }).click();
  await analysisForm.getByLabel("법령명", { exact: true }).fill("민법");
  await analysisForm.getByLabel("조문", { exact: true }).fill("제103조");
  await page.locator(".legal-analysis-form").getByRole("button", { name: "실행" }).click();
  await expect(page.locator(".legal-analysis-title")).toHaveText("조문 영향도: 민법 제103조");
  const failedAxis = page.locator(".legal-analysis-axes li.is-failed");
  await expect(failedAxis).toContainText("조회 실패");
  await expect(failedAxis).toContainText("0건이 아니라 확인하지 못한 상태입니다.");
  await expect(page.locator('.legal-analysis-axes li[data-state="partial"]').first()).toContainText("확인된 결과 7건검색 결과 42건 중 10건을 확인했습니다.");
  await expect(page.locator('.legal-analysis-axes li[data-state="law_only"]')).toContainText("조문 단위의 일치 여부는 확인되지 않았습니다.");
  await expect(page.locator(".legal-analysis-output")).toContainText("확인된 인용 결과 7건");
  await expect(page.locator(".legal-analysis-output")).toContainText("인용 현황");
  const shownImpact = await page.locator(".legal-analysis-output").evaluate((node) => [...node.children].filter((child) => !child.matches("details")).map((child) => child.textContent).join("\n"));
  expect(shownImpact).not.toMatch(/표본|보류|부분 일치|영향 그래프|총 영향 건수|미반영/u);
  await expect(page.locator(".legal-analysis-output")).not.toContainText("전체 영향");
  const impactOutput = page.locator(".legal-analysis-output");
  expect((await impactOutput.locator(":scope > .legal-analysis-section").allTextContents()).join("\n")).not.toContain("선량한 풍속");
  await expect(impactOutput.locator(".legal-analysis-axes")).not.toContainText("245007");
  await impactOutput.locator(".law-detail-source summary").click();
  await expect(impactOutput.locator(".legal-analysis-raw")).toContainText("제103조(반사회질서의 법률행위)");
  await expect(impactOutput.locator(".law-detail-source")).toContainText("245007");
  await expect(impactOutput.locator(".law-detail-source")).not.toContainText("7건 확인 / 검색 42건");
  await impactOutput.locator(".law-detail-source summary").click();

  expect(requests.slice(2)).toEqual([
    { mode: "cite_check", caseNumber: "2013다61381" },
    { mode: "applicable_law", lawName: "도로교통법", date: "2023-05-10", jo: "제44조" },
    { mode: "impact_map", lawName: "민법", jo: "제103조" },
  ]);
  await modes.getByRole("tab", { name: "인용 검증" }).click();
  await expect(citations).toHaveCount(3);
  expect(requests).toHaveLength(5);

  await page.setViewportSize({ width: 390, height: 844 });
  for (const mode of ["인용 검증", "판례 유효성", "시점별 적용 법령", "조문 영향도"]) {
    await modes.getByRole("tab", { name: mode }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  // The only expected console line is the browser's own log of the injected 503 before retry.
  expect(errors.filter((error) => !error.includes("status of 503"))).toEqual([]);
});

test("analysis distinguishes no citations and missing records without exposing machine markers", async ({ page }) => {
  await page.route("**/api/law/analysis", (route) => {
    const request = route.request().postDataJSON() as { mode: string };
    const noCitations = request.mode === "verify_citations";
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: noCitations
      ? { found: true, mode: request.mode, markers: ["NO_CITATIONS_FOUND"], text: "[NO_CITATIONS_FOUND] 입력 텍스트에서 조문·판례 인용이 발견되지 않았습니다.\n\n⚠️ 이 결과는 '검증 성공'이 아니라 '검증할 인용이 없음'입니다." }
      : { found: false, mode: request.mode, marker: "NOT_FOUND", text: "[NOT_FOUND] 사건번호를 찾지 못했습니다." } }) });
  });
  await page.goto("/");
  await navigateWorkspace(page, "법령");
  await page.getByRole("tab", { name: "검증·분석", exact: true }).click();
  const modes = page.getByRole("tablist", { name: "검증·분석 유형" });
  const input = "오늘은 맑습니다.";
  await page.getByLabel("검증할 문장을 입력하세요.").fill(input);
  await page.locator(".legal-analysis-form").getByRole("button", { name: "실행" }).click();
  const output = page.locator(".legal-analysis-output");
  await expect(output.locator(".legal-analysis-overall")).toHaveText("검증할 법령·판례 인용을 찾지 못했습니다.");
  await expect(output).toContainText("법령명, 조문 또는 사건번호가 포함된 문장으로 다시 입력해 주세요.");
  await expect(output.locator(".legal-analysis-citations")).toHaveCount(0);
  await expect(output).not.toContainText("[NO_CITATIONS_FOUND]");
  await expect(output).not.toContainText(input);
  await expect(output.locator(".law-detail-source")).toHaveCount(0);
  await expect(page.getByLabel("검증할 문장을 입력하세요.")).toHaveValue(input);
  await modes.getByRole("tab", { name: "판례 유효성" }).click();
  await page.getByLabel("사건번호").fill("2099다99999");
  await page.locator(".legal-analysis-form").getByRole("button", { name: "실행" }).click();
  await expect(page.locator(".legal-analysis-missing")).toContainText("찾지 못했습니다");
  await expect(page.locator(".legal-analysis-missing")).not.toContainText("[NOT_FOUND]");
  await expect(page.locator(".legal-analysis-output")).toHaveCount(0);
});

test("citation evidence checks a cited 호, recovers a failed lookup and shows precedent evidence", async ({ page }) => {
  const input = "근로기준법 제60조 제6항 제9호와 대법원 2013다61381 판결을 인용한다.";
  let textCalls = 0;
  await page.route("**/api/law/analysis", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
    found: true, mode: "verify_citations", markers: ["VERIFIED"],
    text: "[VERIFIED] == 인용 검증 결과 ==\n법령 인용 1건 | ✓ 1 실존 | ✗ 0 오류 | ⌛ 0 폐지 | ⚠ 0 확인필요\n판례 인용 1건 | ✓ 1 실존 | ✗ 0 실존불가 | ⚠ 0 미확인\n\n▶ 법령 인용\n✓ 근로기준법 제60조(연차 유급휴가) 제6항 실존\n\n▶ 판례 인용\n✓ 2013다61381 실존 — 대법원 2018.10.30 손해배상(기)",
  } }) }));
  await page.route("**/api/law", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, text: "", laws: [
    { name: "근로기준법", status: "현행", lawId: "001872", mst: "283457", promulgationDate: "20260219", effectiveDate: "20260820", kind: "법률" },
    { name: "근로기준법 시행령", status: "현행", lawId: "003058", mst: "270551", effectiveDate: "20251023", kind: "대통령령" },
  ] } }) }));
  await page.route("**/api/law/text", (route) => {
    textCalls += 1;
    // The eager 호 check and the retry on opening both fail; "다시 시도" then succeeds.
    if (textCalls <= 2) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "LAW_MCP_ERROR", message: "x" } }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, mode: "article", effectiveDate: "20260820",
      text: "법령명: 근로기준법\n시행일: 20260820\n\n제60조 연차 유급휴가\n제60조(연차 유급휴가)\n① 사용자는 15일의 유급휴가를 주어야 한다.\n⑥ 제1항 및 제2항을 적용하는 경우 다음 각 호의 어느 하나에 해당하는 기간은 출근한 것으로 본다.\n1. 근로자가 업무상의 부상 또는 질병으로 휴업한 기간\n2. 임신 중의 여성이 휴업한 기간\n⑦ 휴가는 1년간 행사하지 아니하면 소멸된다.\n" } }) });
  });
  await page.route("**/api/law/decisions/search", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, page: 1, text: "", entries: [
    { domain: "precedent", id: "619495", caseNumber: "2023두54761", court: "대법원", date: "20260409", title: "원천징수법인세환급거부처분취소" },
    { domain: "precedent", id: "204201", caseNumber: "2013다61381", court: "대법원", date: "20181030", title: "손해배상(기)" },
  ] } }) }));
  await page.route("**/api/law/decisions/text", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, text: "", title: "손해배상(기)", expandable: true, sections: [
    { heading: "판시사항", text: "[1] 조약의 해석 방법" }, { heading: "판결요지", text: "[1] 조약은 문맥에 따라 해석되어야 한다." }, { heading: "전문", text: "판결문 일부" },
  ] } }) }));
  await page.goto("/");
  await navigateWorkspace(page, "법령");
  await page.getByRole("tab", { name: "검증·분석", exact: true }).click();
  await page.getByLabel("검증할 문장을 입력하세요.").fill(input);
  await page.locator(".legal-analysis-form").getByRole("button", { name: "실행" }).click();

  const output = page.locator(".legal-analysis-output");
  const law = output.locator(".legal-analysis-citations li").first();
  // The verifier only checked 제6항; the 호 is not reported as confirmed while its text could not be read.
  await expect(law.locator(".legal-analysis-citation-text")).toHaveText("근로기준법 제60조(연차 유급휴가) 제6항 제9호");
  await expect(law.locator(".legal-analysis-status")).toHaveText("호 확인 필요");
  await expect(output.locator(".legal-analysis-overall")).toHaveText("확인이 필요한 인용이 있습니다.");
  const source = output.locator(".law-detail-source");
  await source.locator("summary").click();
  await expect(source).toContainText("검증에 사용된 조문 원문을 불러오지 못했습니다.");
  await source.getByRole("button", { name: "다시 시도" }).click();
  await expect(law.locator(".legal-analysis-status")).toHaveText("찾을 수 없음");
  await expect(source).toContainText("인용한 제6항 제9호을(를) 이 조문에서 찾지 못했습니다.");
  await expect(source).toContainText("⑥ 제1항 및 제2항을 적용하는 경우");
  await expect(source).not.toContainText("⑦ 휴가는");
  await expect(source).toContainText("대법원 · 2018.10.30 선고 · 2013다61381 · 손해배상(기)");
  await expect(source).toContainText("[1] 조약은 문맥에 따라 해석되어야 한다.");
  await expect(source).toContainText("판결문 전체 원문은 포함되지 않습니다.");
  await expect(source).not.toContainText("판결문 일부");
  expect(textCalls).toBe(3);
});

test("applicable law separates decision from legal source across transition and lookup states", async ({ page }) => {
  const title = "═══ 행위시법 판단: 도로교통법 @ 2023.05.10 ═══";
  const version = "▶ 기준일에 시행 중이던 버전\n  도로교통법 [시행 2023.04.04] (MST 247265)\n  ⚠️ 시행 예정 개정 1건 존재 — 시행 2027.06.03";
  const article = "▶ 기준일 시점 조문: 제44조\n제44조(술에 취한 상태에서의 운전 금지)\n① 누구든지 술에 취한 상태에서 운전하여서는 아니 된다.";
  const comparison = "▶ 현행과 비교: △ 변경됨 — 현행 본문과 다릅니다.";
  const addenda = "▶ 적용례·경과조치 발췌 (기준일 사건에 영향 가능)\n◆ 부칙 <제20864호, 2025.04.01>\n제2조(적용례) 종전 규정을 적용한다.";
  const unconfirmed = "▶ 적용례·경과조치: 관련 부칙에서 경과규정 신호 미발견 — 부칙 원문 확인: get_law_text";
  let transition = addenda;
  let sourceFails = false;
  const sourceCalls: unknown[] = [];
  await page.route("**/api/law/analysis", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ data: { found: true, mode: "applicable_law", markers: [], text: [title, version, article, comparison, transition].join("\n\n") } }),
  }));
  await page.route("**/api/law/text", (route) => {
    sourceCalls.push(route.request().postDataJSON());
    return route.fulfill(sourceFails
      ? { status: 502, contentType: "application/json", body: JSON.stringify({ error: { message: "get_law_text 내부 오류" } }) }
      : { status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        found: true, mode: "article", text: `법령명: 도로교통법\n\n제44조(술에 취한 상태에서의 운전 금지)\n① 누구든지 술에 취한 상태에서 운전하여서는 아니 된다.\n${"연속조문".repeat(80)}`,
      } }) });
  });
  await page.goto("/");
  await navigateWorkspace(page, "법령");
  await page.getByRole("tab", { name: "검증·분석", exact: true }).click();
  await page.getByRole("tablist", { name: "검증·분석 유형" }).getByRole("tab", { name: "시점별 적용 법령" }).click();
  const form = page.locator(".legal-analysis-form");
  await form.getByLabel("법령명", { exact: true }).fill("도로교통법");
  await form.getByLabel("조문 (선택)").fill("제44조");
  await form.getByLabel("기준일").fill("2023-05-10");
  const run = form.getByRole("button", { name: "실행" });
  await run.click();
  const output = page.locator(".legal-analysis-output");
  const decision = output.locator(".legal-analysis-section").filter({ hasText: "시행 예정 개정" }).first();
  await expect(decision).toContainText("도로교통법 [시행 2023.04.04]");
  await expect(output.locator(".legal-analysis-section").filter({ hasText: "기준일 시행 조문" })).not.toContainText("누구든지 술에 취한");
  await expect(output).toContainText("관련 부칙 발췌를 원문에서 확인해 주세요.");
  const raw = output.locator(".law-detail-source");
  await expect(raw).not.toHaveAttribute("open", "");
  expect(sourceCalls).toHaveLength(0);
  await raw.locator("summary").click();
  await expect(raw.locator(".legal-analysis-raw")).toContainText("① 누구든지 술에 취한 상태에서 운전하여서는 아니 된다.");
  await expect(raw).toContainText("제2조(적용례) 종전 규정을 적용한다.");
  await expect(raw).not.toContainText("현행과 비교:");
  await expect(output).not.toContainText(/get_law_text|경과규정 없음/u);
  expect(sourceCalls).toEqual([{ mst: "247265", jo: "제44조" }]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await raw.locator("summary").click();
  await expect(raw).not.toHaveAttribute("open", "");
  await page.setViewportSize({ width: 1440, height: 900 });

  transition = unconfirmed;
  await run.click();
  await expect(output).toContainText("적용례·경과조치: 관련 부칙에서 경과규정을 확인하지 못했습니다. 부칙 원문을 확인해 주세요.");
  await expect(output).not.toContainText(/get_law_text|경과규정 없음/u);
  sourceFails = true;
  await output.locator(".law-detail-source summary").click();
  await expect(output.locator(".law-detail-source")).toContainText("원문을 불러오지 못했습니다.");
  await expect(output).toContainText("기준일에 시행 중이던 버전");
  await expect(output).not.toContainText("get_law_text");
  await output.locator(".law-detail-source summary").click();
  await page.route("**/api/law/text", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ data: { found: false, marker: "NOT_FOUND", text: "[NOT_FOUND] 요청한 조문을 찾지 못했습니다." } }),
  }));
  await output.locator(".law-detail-source summary").click();
  await expect(output.locator(".law-detail-source")).toContainText("요청한 조문 원문을 찾지 못했습니다.");
  await expect(output).toContainText("관련 부칙에서 경과규정을 확인하지 못했습니다.");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await output.locator(".law-detail-source summary").click();
  await expect(output.locator(".law-detail-source")).not.toHaveAttribute("open", "");
});

test("law article and precedent detail open analyses with their structured identifiers and return without refetch", async ({ page }) => {
  const lawCalls: unknown[] = [];
  const decisionCalls: unknown[] = [];
  const analysis: unknown[] = [];
  await routeAnalysis(page, analysis);
  await page.route("**/api/law", async (route) => {
    lawCalls.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, laws: [{ name: "근로기준", mst: "283457" }] } }) });
  });
  await page.route("**/api/law/text", async (route) => {
    const input = route.request().postDataJSON();
    lawCalls.push(input);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: input.jo
      ? { found: true, mode: "article", name: "근로기준법", text: "제74조(임산부의 보호)\n① 조문 본문" }
      : { found: true, mode: "toc", name: "근로기준법", text: "목차 (총 1개 조문)\n제74조 임산부의 보호", articles: [{ jo: "제74조", title: "임산부의 보호" }] } }) });
  });
  await page.route("**/api/law/decisions/search", async (route) => {
    decisionCalls.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, page: 1, text: "[609561] 손해배상", entries: [{ domain: "precedent", id: "609561", title: "손해배상(기)", caseNumber: "2013다61381", court: "대법원" }] } }) });
  });
  await page.route("**/api/law/decisions/text", async (route) => {
    decisionCalls.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, text: "판시사항:\n판결문 원문" } }) });
  });
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await navigateWorkspace(page, "법령");
  await page.getByRole("searchbox").fill("근로기준법");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await page.locator(".law-search-list button").first().click();
  await page.getByRole("navigation", { name: "조문 목차" }).getByRole("button", { name: "제74조 임산부의 보호" }).click();
  await expect(page.locator(".law-detail-raw")).toContainText("조문 본문");

  await page.getByRole("button", { name: "시점별 적용 법령" }).click();
  await expect(page.getByRole("tab", { name: "시점별 적용 법령", selected: true })).toBeVisible();
  // The official name from the article text wins over the search-result label.
  await expect(page.locator("#analysis-applicable-law")).toHaveValue("근로기준법");
  await expect(page.locator("#analysis-applicable-jo")).toHaveValue("제74조");
  await expect(page.locator("#analysis-applicable-date")).toHaveValue("");
  await expect(page.locator("#analysis-applicable-date")).toBeFocused();
  expect(analysis).toEqual([]);
  await page.locator("#analysis-applicable-date").fill("2024-01-15");
  await page.locator(".legal-analysis-form").getByRole("button", { name: "실행" }).click();
  await expect(page.locator(".legal-analysis-output")).toBeVisible();
  await page.getByRole("button", { name: "← 법령으로" }).click();
  await expect(page.locator(".law-detail-raw")).toContainText("조문 본문");
  await expect(page.getByRole("button", { name: "시점별 적용 법령" })).toBeFocused();

  await page.getByRole("button", { name: "조문 영향도" }).click();
  await expect(page.locator(".legal-analysis-axes")).toBeVisible();
  await page.getByRole("button", { name: "← 법령으로" }).click();
  await expect(page.getByRole("button", { name: "조문 영향도" })).toBeFocused();
  expect(analysis).toEqual([
    { mode: "applicable_law", lawName: "근로기준법", date: "2024-01-15", jo: "제74조" },
    { mode: "impact_map", lawName: "근로기준법", jo: "제74조" },
  ]);

  await page.getByRole("tab", { name: "판례·결정례", exact: true }).click();
  await page.getByLabel("검색어", { exact: true }).fill("손해배상");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await page.getByRole("button", { name: /손해배상\(기\)/ }).click();
  await expect(page.locator(".decision-detail-raw")).toContainText("판결문 원문");
  await page.getByRole("button", { name: "판례 유효성 확인" }).click();
  await expect(page.getByRole("tab", { name: "판례 유효성", selected: true })).toBeVisible();
  await expect(page.locator("#analysis-case")).toHaveValue("2013다61381");
  await expect(page.locator(".legal-analysis-verdict")).toBeVisible();
  expect(analysis.at(-1)).toEqual({ mode: "cite_check", caseNumber: "2013다61381" });
  await page.getByRole("button", { name: "← 판례 상세로" }).click();
  await expect(page.locator(".decision-detail-raw")).toContainText("판결문 원문");
  await expect(page.getByRole("button", { name: "판례 유효성 확인" })).toBeFocused();

  await page.getByRole("tab", { name: "법령 검색", exact: true }).click();
  await expect(page.locator(".law-detail-raw")).toContainText("조문 본문");
  expect(lawCalls).toEqual([{ query: "근로기준법" }, { mst: "283457" }, { mst: "283457", jo: "제74조" }]);
  expect(decisionCalls).toEqual([{ domain: "precedent", query: "손해배상", page: 1 }, { domain: "precedent", id: "609561" }]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "검증·분석", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("RESEARCH 종합 리서치 runs all eight tasks through one fixed route with task-specific inputs", async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = [];
  const outside: string[] = [];
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("status of 503")) errors.push(message.text()); });
  page.on("request", (request) => { if (!request.url().startsWith("http://127.0.0.1")) outside.push(request.url()); });
  let failNext = true;
  await page.route("**/api/law/research", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    if (failNext) {
      failNext = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "LAW_UPSTREAM_UNAVAILABLE", message: "법령 검색 서비스가 일시적으로 응답하지 않습니다.", retryable: true } }) });
      return;
    }
    if (body.task === "document_review") {
      const review = {
        document: { type: "b2b_service", label: "서비스 이용계약", relationship: "business", relationshipLabel: "사업자 간", confidence: "high", evidence: [], domains: ["civil", "terms"] },
        risk: { score: 2, level: "보통", high: 0, medium: 1, low: 0 },
        facts: [{ label: "계약기간", value: "2026년 1월 1일부터 2026년 12월 31일까지", clause: "제1조" }],
        clauses: [{ number: "제2조", text: "을은 어떠한 경우에도 계약을 해지할 수 없다.", issues: [{
          id: "termination_restriction", label: "중도해지 제한", severity: "medium",
          point: "이용자의 중도해지를 전면 금지한 부분이 상대방의 해지권을 부당하게 제한하는지 검토가 필요합니다.",
          fact: "을은 어떠한 경우에도 계약을 해지할 수 없다.",
          laws: ["terms-9"], precedents: [], lawStatus: "found", precedentStatus: "none",
        }] }],
        laws: { "terms-9": { key: "terms-9", law: "약관의 규제에 관한 법률", jo: "제9조", title: "계약의 해제ㆍ해지", excerpt: "계약의 해제ㆍ해지에 관하여 정하고 있는 약관의 내용 중 …", effectiveDate: "20240807", condition: "이 계약이 약관에 해당하는 경우에 적용됩니다." } },
        precedents: {},
        stats: { calls: 3, queries: 2, excludedPrecedents: 5, excludedLaws: 0 },
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, task: body.task, text: "", markers: [], review } }) });
      return;
    }
    const text = `═══ 리서치: ${String(body.query)} ═══\n\n▶ 관련 법령\n근로기준법 제76조의2\n\n▶ 법령 해석례 [NOT_FOUND / FAILED]\n   사유: 조회 실패`;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, task: body.task, text, markers: text.includes("NOT_FOUND") ? ["NOT_FOUND"] : [] } }) });
  });
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await navigateWorkspace(page, "법령");
  await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
  const form = page.getByRole("form", { name: /^(종합 리서치|문서 검토) 입력$/ });
  const task = form.getByLabel("리서치 유형");
  await expect(page.getByRole("heading", { name: "리서치 결과" })).toHaveCount(0);

  const query = form.getByLabel("질문 또는 검색어");
  await query.fill("직장 내 괴롭힘 판단 기준");
  await form.getByRole("button", { name: "실행" }).click();
  await expect(page.locator(".legal-analysis-result [role='alert']")).toContainText("일시적으로 응답하지 않습니다");
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByRole("heading", { name: "리서치 결과" })).toBeVisible();
  await expect(page.locator(".legal-research-partial")).toHaveText("일부 자료를 불러오지 못했습니다. 확인된 자료를 기준으로 결과를 표시합니다.");
  await expect(page.locator("[data-status='failed']")).toContainText("불러오지 못했습니다");
  await expect(page.locator(".legal-analysis-section.is-unavailable")).toHaveCount(1);
  await expect(page.locator(".legal-analysis-note")).toContainText("조회 경로: 법제처 국가법령정보센터");
  expect(bodies).toEqual([{ task: "full_research", query: "직장 내 괴롭힘 판단 기준" }, { task: "full_research", query: "직장 내 괴롭힘 판단 기준" }]);

  await chooseOption(page, task, researchTaskLabels.dispute_prep);
  await expect(page.getByRole("heading", { name: "리서치 결과" })).toHaveCount(0);
  await chooseOption(page, form.getByLabel("분야"), "노동");
  await form.getByRole("button", { name: "실행" }).click();
  await expect(page.getByRole("heading", { name: "리서치 결과" })).toBeVisible();

  await chooseOption(page, task, researchTaskLabels.amendment_track);
  await expect(form.getByLabel("분야")).toHaveCount(0);
  await expect(form.getByLabel("시작일")).toHaveCount(0);
  await chooseOption(page, form.getByLabel("추적 방식"), "시점 비교");
  await form.getByLabel("시작일").fill("2026-01-02");
  await form.getByLabel("종료일").fill("2026-01-01");
  await expect(form.getByRole("alert")).toHaveText("시작일은 종료일보다 늦을 수 없습니다.");
  await expect(form.getByRole("button", { name: "실행" })).toBeDisabled();
  await form.getByLabel("시작일").fill("2022-01-01");
  await expect(form.getByRole("switch", { name: "전체 개정 이력 포함" })).not.toBeChecked();
  await form.getByRole("button", { name: "실행" }).click();
  await expect(page.getByRole("heading", { name: "리서치 결과" })).toBeVisible();

  await chooseOption(page, task, researchTaskLabels.law_system);
  await form.getByLabel("관련 조문 (선택)").fill("38, 제39조");
  await form.getByRole("button", { name: "실행" }).click();
  await chooseOption(page, task, researchTaskLabels.ordinance_compare);
  await expect(form.getByRole("button", { name: "실행" })).toBeDisabled();
  await expect(form).toContainText("서로 다른 비교 지역 2곳을 입력하세요. 비교할 주제는 위 질문에 입력하면 됩니다.");
  await form.getByLabel("비교 지역 1").fill("인천광역시");
  await expect(form.getByRole("button", { name: "실행" })).toBeDisabled();
  await form.getByLabel("비교 지역 2").fill("서울특별시");
  await form.getByLabel("관련 상위 법령 (선택)").fill("주차장법");
  await form.getByRole("button", { name: "실행" }).click();
  for (const value of ["action_basis", "procedure_detail"]) {
    await chooseOption(page, task, researchTaskLabels[value]);
    await form.getByRole("button", { name: "실행" }).click();
    await expect(page.getByRole("heading", { name: "리서치 결과" })).toBeVisible();
  }

  await chooseOption(page, task, researchTaskLabels.document_review);
  await expect(form.getByLabel("질문 또는 검색어")).toHaveCount(0);
  await expect(form.getByRole("switch", { name: "출처 표시", exact: true })).toBeVisible();
  await expect(form).not.toContainText("이 화면에서 변경한 값은 이번 실행에만 적용됩니다.");
  await expect(form.getByRole("button", { name: "실행", exact: true })).toHaveCount(0);
  // 법령 entered directly with no work files: the 작업 파일 empty state offers the shared upload, nothing runs.
  await expect(form.getByRole("radio", { name: "작업 파일" })).toBeChecked();
  await expect(form.getByText("검토할 문서를 추가하세요")).toBeVisible();
  await expect(form.getByRole("button", { name: "파일 추가" })).toBeEnabled();
  await form.getByRole("radio", { name: "직접 입력" }).check();
  const documentText = form.getByLabel("검토할 문서 내용");
  await expect(form).not.toContainText("Korean Law MCP");
  await expect(form.getByRole("button", { name: "실행", exact: true })).toBeDisabled();
  const sample = "제1조 갑은 계약 체결 즉시 대금 전액을 지급한다.\n제2조 을은 어떠한 경우에도 계약을 해지할 수 없다.";
  await documentText.fill(sample);
  await form.getByRole("button", { name: "실행", exact: true }).click();
  await expect(page.getByRole("heading", { name: "검토 결과", exact: true })).toBeVisible();
  const review = page.locator(".contract-review");
  await expect(review.locator(".research-overview .research-eyebrow")).toHaveText("문서 검토");
  await expect(review.locator(".research-overview h3")).toHaveText("관련 근거를 확인했습니다");
  await expect(review).toContainText("서비스 이용계약");
  await expect(review).toContainText("사업자 간");
  await expect(review).toContainText("2026년 1월 1일부터 2026년 12월 31일까지");
  const clause = review.locator(".contract-review-clause");
  await expect(clause.getByRole("heading", { level: 4 })).toContainText("제2조");
  await expect(clause).toContainText("중도해지 제한");
  await expect(clause).toContainText("을은 어떠한 경우에도 계약을 해지할 수 없다.");
  await expect(clause.locator(".contract-review-issue dt")).toHaveText(["검토 원문", "검토 결과", "우선순위", "확인한 근거"]);
  const lawEvidence = review.locator(".contract-review-details .law-detail-source");
  await expect(lawEvidence.locator("summary")).toHaveText(/관련 법령 1건 보기/u);
  await expect(lawEvidence).not.toHaveAttribute("open", "");
  await lawEvidence.locator("summary").click();
  await expect(lawEvidence).toContainText("약관의 규제에 관한 법률 제9조 (계약의 해제ㆍ해지)");
  await expect(lawEvidence).toContainText("이 계약이 약관에 해당하는 경우에 적용됩니다.");

  expect(bodies.slice(2)).toEqual([
    { task: "dispute_prep", query: "직장 내 괴롭힘 판단 기준", domain: "labor" },
    { task: "amendment_track", query: "직장 내 괴롭힘 판단 기준", scenario: "time_travel", fromDate: "2022-01-01", toDate: "2026-01-01" },
    { task: "law_system", query: "직장 내 괴롭힘 판단 기준", articles: ["제38조", "제39조"] },
    { task: "ordinance_compare", query: "직장 내 괴롭힘 판단 기준", regions: ["인천광역시", "서울특별시"], parentLaw: "주차장법" },
    { task: "action_basis", query: "직장 내 괴롭힘 판단 기준" },
    { task: "procedure_detail", query: "직장 내 괴롭힘 판단 기준" },
    { task: "document_review", text: sample },
  ]);


  // Previous task results and other research views survive switching.
  await chooseOption(page, task, researchTaskLabels.full_research);
  await expect(page.locator(".legal-research-partial")).toBeVisible();
  await page.getByRole("tab", { name: "법령 검색", exact: true }).click();
  await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
  await expect(query).toHaveValue("직장 내 괴롭힘 판단 기준");

  await page.setViewportSize({ width: 390, height: 844 });
  await chooseOption(page, task, researchTaskLabels.document_review);
  await documentText.fill(`${sample}\n`.repeat(200));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(outside).toEqual([]);
  expect(errors).toEqual([]);
});

test("RESEARCH 문서 검토 reviews one workspace file in place and shows where each issue is", async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  // The real clause engine; statutes are fixed so the evidence UI has something to open.
  await page.route("**/api/law/research", async (route) => {
    const body = route.request().postDataJSON() as { task: string; document: { segments: Array<{ text: string }> } };
    bodies.push(body);
    const texts = body.document.segments.map((segment) => segment.text);
    const profile = classifyDocument(texts.join("\n"));
    const clauses = reviewClauses(splitClauses(texts), profile);
    const review: ContractReview = {
      document: profile, risk: documentRisk(clauses), facts: extractKeyFacts(clauses),
      clauses: clauses.filter((clause) => clause.issues.length).map(({ sources, ...clause }) => ({
        ...clause, segments: segmentsOf({ ...clause, sources }),
        issues: clause.issues.map((issue) => ({ ...issue, laws: ["law-23"], precedents: [], lawStatus: "found" as const, precedentStatus: "none" as const })),
      })),
      laws: { "law-23": { key: "law-23", law: "근로기준법", jo: "제23조", title: "해고 등의 제한", excerpt: "사용자는 근로자에게 정당한 이유 없이 해고하지 못한다." } },
      precedents: {},
      stats: { calls: 1, queries: 0, excludedPrecedents: 0, excludedLaws: 0 },
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, task: body.task, text: "", markers: [], review } }) });
  });
  const longName = "2026년_신규입사자_표준_근로계약서_최종_검토본_인사팀_공유용.docx";
  const contractLines = EMPLOYMENT_CONTRACT.split("\n");
  const longContract = Array.from({ length: 1400 }, (_, index) => `제${index + 1}조(조항) 회사는 이 조항에 따라 상대방에게 서비스를 제공하며 상대방은 이에 따른 대가를 지급하여야 한다. 세부 사항은 별도 합의로 정한다.`);
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await page.getByLabel("작업 파일 선택").setInputFiles([
    { name: longName, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from(createDocxParagraphs(contractLines)) },
    { name: "근로계약서.pdf", mimeType: "application/pdf", buffer: Buffer.from(await createUnicodePdf([contractLines.slice(0, 4).map((text) => ({ text })), contractLines.slice(4).map((text) => ({ text }))])) },
    { name: "매출.csv", mimeType: "text/csv", buffer: Buffer.from("월,매출,비용,담당\n1월,1200,800,김철수\n2월,1300,900,이영희\n") },
    { name: "긴계약.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from(createDocxParagraphs(longContract)) },
  ]);
  await expect(page.locator(".file-row")).toHaveCount(4);
  await page.getByRole("checkbox", { name: "근로계약서.pdf 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: `${longName} 선택`, exact: true }).check();

  await navigateWorkspace(page, "법령");
  await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
  const form = page.getByRole("form", { name: /^(종합 리서치|문서 검토) 입력$/ });
  await chooseOption(page, form.getByLabel("리서치 유형"), researchTaskLabels.document_review);
  await expect(form.getByRole("radio", { name: "작업 파일" })).toBeChecked();
  const choice = form.locator("#research-file");
  await expect(choice).toHaveAccessibleName("검토할 문서");
  await expect(form.getByRole("button", { name: "파일 추가" })).toBeVisible();
  // Selected files come first; one is reviewed at a time.
  await choice.click();
  await expect(page.getByRole("option")).toHaveText([longName, "근로계약서.pdf", "매출.csv", "긴계약.docx"]);
  await page.keyboard.press("Escape");
  await form.getByRole("button", { name: "실행", exact: true }).click();
  const review = page.locator(".contract-review");
  await expect(review.locator(".contract-review-file")).toHaveText(`검토 문서: ${longName}`);
  await expect(review).toHaveAttribute("data-coverage", "complete");
  await expect(review).not.toContainText("이미지 안의 글자는 읽지 않습니다");
  const dismissal = review.locator(".contract-review-issue").filter({ hasText: "경고·예고 없는 징계·해고" });
  await expect(dismissal.locator(".contract-review-place")).toHaveText("제4조 해고");
  await dismissal.getByRole("button", { name: "상세 근거 보기" }).click();
  await expect(review.locator(".contract-review-details")).toContainText("근로기준법 제23조");

  // Only this file's identity and text segments were sent: no bytes, styles, other files or locators.
  expect(bodies).toHaveLength(1);
  const sent = bodies[0] as { task: string; document: Record<string, unknown> & { segments: Array<Record<string, unknown>> } };
  expect(JSON.stringify(sent)).not.toMatch(/근로계약서\.pdf|매출|긴계약/u);

  // Another file: the shown result says which file it belongs to until the new one is reviewed.
  await chooseOption(page, choice, "근로계약서.pdf");
  await expect(page.getByText(`지금 선택한 문서가 아닌 ${longName}의 검토 결과입니다.`)).toBeVisible();
  await form.getByRole("button", { name: "실행", exact: true }).click();
  await expect(review.locator(".contract-review-file")).toHaveText("검토 문서: 근로계약서.pdf");
  await expect(review).toContainText("2개 페이지 중 2개 검토");
  await expect(review.locator(".contract-review-issue").filter({ hasText: "경고·예고 없는 징계·해고" }).locator(".contract-review-place")).toHaveText("2페이지");

  // Raw data is not a contract: nothing is sent and nothing is called "no risk".
  await chooseOption(page, choice, "매출.csv");
  await form.getByRole("button", { name: "실행", exact: true }).click();
  await expect(page.locator("[data-coverage='excluded']")).toContainText("계약·규정 성격의 문장을 찾지 못했습니다");
  await expect(page.locator("[data-coverage='excluded']")).toContainText("위험 항목이 없다는 뜻이 아니라");
  expect(bodies).toHaveLength(2);

  // Past the bound: a partial review that says what was left and why.
  await chooseOption(page, choice, "긴계약.docx");
  await form.getByRole("button", { name: "실행", exact: true }).click();
  await expect(review).toHaveAttribute("data-coverage", "partial");
  await expect(review.getByRole("heading", { name: "검토한 범위 요약" })).toBeVisible();

  // Pasting stays available.
  await form.getByRole("radio", { name: "직접 입력" }).check();
  await expect(form.getByLabel("검토할 문서 내용")).toBeVisible();
  await expect(form.getByRole("button", { name: "실행", exact: true })).toBeDisabled();

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await form.getByRole("radio", { name: "작업 파일" }).check();
    await chooseOption(page, choice, longName);
    await form.getByRole("button", { name: "실행", exact: true }).click();
    await expect(review.locator(".contract-review-file")).toHaveText(`검토 문서: ${longName}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test("RESEARCH ordinance comparison needs two regions and shows each region's verified articles", async ({ page }) => {
  const searches: unknown[] = [];
  const longBody = `① 장애인 주차요금 50퍼센트를 감면한다.\n② ${"추가 설치 기준은 별표에 따른다. ".repeat(40)}\n1. 원문의 마지막 호까지 확인한다.`;
  const longFirstSentence = `① ${"장애인 주차요금은 관련 기준에 따라 80퍼센트를 ".repeat(7)}감면한다.\n② 후속 항을 그대로 표시한다.`;
  await page.route("**/api/law/research", (route) => {
    const body = route.request().postDataJSON() as { task: string; query: string; regions: [string, string]; parentLaw?: string };
    searches.push(body);
    const oneSided = body.query === "한쪽만";
    const noArticles = body.query === "조문 없음";
    const noOrdinances = body.query === "양쪽 없음";
    const failed = body.query === "조회 실패";
    const region = (name: string, place: string, rate?: string) => rate
      ? { region: name, status: "found", candidates: 3, ordinance: { id: name, name: `${name} 주차장 설치 및 관리 조례`, body: place, effective: "20260701" },
        articles: noArticles ? [] : [
          { jo: "제12조", title: "주차요금의 감면", body: rate === "50퍼센트" ? longBody : longFirstSentence, topic: "주차요금의 감면" },
          { jo: "제13조", title: "주차장의 설치기준", body: `① ${name} 주차장의 설치기준은 별표에 따른다.\n② 세부기준을 적용한다.`, topic: "주차장의 설치기준" },
        ] }
      : { region: name, status: failed ? "failed" : "none", candidates: 0, articles: [] };
    const comparison = { topic: body.query, topics: ["주차요금의 감면", "주차장의 설치기준"],
      regions: [region("인천광역시", "인천광역시", failed || noOrdinances ? undefined : "50퍼센트"),
        region("서울특별시", "서울특별시", oneSided || noOrdinances ? undefined : "80퍼센트")] };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
      found: true, task: body.task, text: "═══ 조례 비교 ═══\n▶ 상위 법령\n주차장법 (법률)", markers: [], comparison } }) });
  });
  await page.goto("/");
  await navigateWorkspace(page, "법령");
  await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
  const form = page.getByRole("form", { name: /^(종합 리서치|문서 검토) 입력$/ });
  await chooseOption(page, form.getByLabel("리서치 유형"), researchTaskLabels.ordinance_compare);
  await form.getByLabel("질문 또는 검색어").fill("장애인 주차요금 감면");
  await form.getByLabel("비교 지역 1").fill("인천광역시");
  await expect(form.getByRole("button", { name: "실행" })).toBeDisabled();
  const note = form.locator(".legal-research-input-note");
  await expect(note).toHaveText("서로 다른 비교 지역 2곳을 입력하세요. 비교할 주제는 위 질문에 입력하면 됩니다.");
  await expect(note).toHaveAttribute("data-state", "hint");
  await form.getByLabel("비교 지역 2").fill("인천광역시");
  await expect(note).toHaveAttribute("data-state", "error");
  await expect(form.getByRole("button", { name: "실행" })).toBeDisabled();
  await form.getByLabel("비교 지역 2").fill("서울특별시");
  await form.getByLabel("관련 상위 법령 (선택)").fill("주차장법");
  await form.getByRole("button", { name: "실행" }).click();
  const table = page.getByRole("region", { name: "조례 대조" }).locator(".research-comparison");
  await expect(table.locator("thead th")).toHaveText(["비교 항목", "인천광역시", "서울특별시"]);
  await expect(table.locator("tbody tr").first()).toContainText("인천광역시 주차장 설치 및 관리 조례");
  const row = table.locator("tbody tr").nth(1);
  const [first, second] = [row.locator("td").nth(0), row.locator("td").nth(1)];
  const otherRow = table.locator("tbody tr").nth(2);
  const other = otherRow.locator("td").nth(0);
  expect(longBody.length).toBeGreaterThan(600);
  await expect(row.locator(".research-comparison-status")).toHaveText("두 지역 조문 확인");
  await expect(first.locator(".research-comparison-title")).toHaveText("제12조(주차요금의 감면)");
  await expect(first.locator(".research-comparison-excerpt")).toHaveText("원문 발췌 · ① 장애인 주차요금 50퍼센트를 감면한다.");
  await expect(first.locator(".research-meta")).toHaveText("시행 2026.07.01");
  await expect(second.locator(".research-comparison-excerpt")).toHaveCount(0);
  await expect(table).not.toContainText("원문의 마지막 호까지 확인한다.");
  await expect(row).not.toContainText("80퍼센트");
  await expect(table.locator(".research-comparison-original")).toHaveCount(0);
  await expect(table.locator(".research-comparison-article svg, .research-comparison-article summary, .research-comparison-article .source-toggle")).toHaveCount(0);
  await expect(page.locator(".research-overview h3")).toHaveText("관련 근거를 확인했습니다");
  await expect(page.locator(".research-overview")).not.toContainText("비교 대상 지역:");
  await first.getByRole("button", { name: "조문 원문 보기" }).click();
  await expect(first.getByRole("button", { name: "조문 원문 닫기" })).toHaveAttribute("aria-expanded", "true");
  await expect(first.locator(".research-comparison-original pre")).toHaveText(longBody);
  await expect(second.locator(".research-comparison-original")).toHaveCount(0);
  await second.getByRole("button", { name: "조문 원문 보기" }).click();
  await other.getByRole("button", { name: "조문 원문 보기" }).click();
  await expect(second.locator(".research-comparison-original pre")).toHaveText(longFirstSentence);
  await expect(other.locator(".research-comparison-original pre")).toContainText("② 세부기준을 적용한다.");
  await first.getByRole("button", { name: "조문 원문 닫기" }).click();
  await expect(first.locator(".research-comparison-original")).toHaveCount(0);
  await expect(second.locator(".research-comparison-original")).toHaveCount(1);
  await expect(other.locator(".research-comparison-original")).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  const scroll = page.locator(".research-table-scroll");
  await scroll.evaluate((node) => { node.scrollLeft = 70; });
  const offset = await scroll.evaluate((node) => node.scrollLeft);
  expect(offset).toBeGreaterThan(0);
  await first.locator(".research-comparison-toggle").evaluate((node: HTMLElement) => node.click());
  await expect(first.locator(".research-comparison-original pre")).toHaveText(longBody);
  expect(await scroll.evaluate((node) => node.scrollLeft)).toBe(offset);
  await expect(second.locator(".research-comparison-original")).toHaveCount(1);
  await expect(other.locator(".research-comparison-original")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await form.getByLabel("질문 또는 검색어").fill("한쪽만");
  await form.getByLabel("관련 상위 법령 (선택)").fill("");
  await form.getByRole("button", { name: "실행" }).click();
  await expect(page.locator(".research-overview h3")).toHaveText("관련 근거를 일부 확인했습니다");
  await expect(row.locator(".research-comparison-status")).toHaveText("한 지역 조문 확인");
  await expect(second.locator(".research-comparison-missing")).toHaveText("관련 조례를 찾지 못해 조문이 없습니다.");
  await expect(table).toContainText("확인 가능한 관련 조례를 찾지 못했습니다.");
  await form.getByLabel("질문 또는 검색어").fill("조문 없음");
  await form.getByRole("button", { name: "실행" }).click();
  await expect(row.locator(".research-comparison-status")).toHaveText("확인된 조문 없음");
  await expect(row.locator(".research-comparison-missing")).toHaveText(["해당 제목의 조문을 확인하지 못했습니다.", "해당 제목의 조문을 확인하지 못했습니다."]);
  await form.getByLabel("질문 또는 검색어").fill("조회 실패");
  await form.getByRole("button", { name: "실행" }).click();
  await expect(first.locator(".research-comparison-missing")).toHaveText("조례 조회에 실패하여 조문을 확인하지 못했습니다.");
  await expect(row.locator(".research-comparison-status")).toHaveText("한 지역 조문 확인");
  await form.getByLabel("질문 또는 검색어").fill("양쪽 없음");
  await form.getByRole("button", { name: "실행" }).click();
  await expect(row.locator(".research-comparison-status")).toHaveText("확인된 조문 없음");
  await expect(row.locator(".research-comparison-missing")).toHaveText(["관련 조례를 찾지 못해 조문이 없습니다.", "관련 조례를 찾지 못해 조문이 없습니다."]);
  expect(searches).toEqual([
    { task: "ordinance_compare", query: "장애인 주차요금 감면", regions: ["인천광역시", "서울특별시"], parentLaw: "주차장법" },
    { task: "ordinance_compare", query: "한쪽만", regions: ["인천광역시", "서울특별시"] },
    { task: "ordinance_compare", query: "조문 없음", regions: ["인천광역시", "서울특별시"] },
    { task: "ordinance_compare", query: "조회 실패", regions: ["인천광역시", "서울특별시"] },
    { task: "ordinance_compare", query: "양쪽 없음", regions: ["인천광역시", "서울특별시"] },
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("RESEARCH distinguishes empty, low-relevance and partial evidence without adding facts", async ({ page }) => {
  await page.route("**/api/law/research", (route) => {
    const { query } = route.request().postDataJSON() as { query: string };
    const interpretation = {
      original: query, situation: "갑작스러운 해고 문제로 이해했습니다.", facts: ["해고 통보를 받음"],
      issues: [{ label: "해고의 정당성", query: "해고 정당성" }, { label: "해고 절차", query: "해고 서면통지" }, { label: "해고예고", query: "해고예고" }],
      confidence: "medium", uncertainty: "근로계약의 형태는 확인되지 않았습니다.", followUp: "근무 기간은 얼마나 되나요?",
    };
    if (query === "자료 없음") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      data: { found: false, task: "full_research", marker: "NOT_FOUND", text: "[NOT_FOUND] get_law_text failed", interpretation },
    }) });
    const source = query === "일부 근거" || query === "일부 실패";
    const text = source
      ? "═══ 종합 리서치 ═══\n▶ AI 법령검색 결과\n지능형 법령검색 결과 (법령조문, 1건):\n\n근로기준법\n   제0023조 (해고 등의 제한)\n근로자에 대한 해고의 정당성을 판단한다.\n   시행: 2025.01.01 | 고용노동부"
      : "═══ 종합 리서치 ═══\n▶ 관련 판례\n판례 검색 결과 (총 65건, 1페이지):\n\n[9] 다른 사건\n  사건번호: 2025다1";
    const article23 = { law: "근로기준법", jo: "제23조" };
    const issues = query === "일부 실패"
      ? [{ label: "해고의 정당성", status: "found", articles: [article23], precedents: [] },
        { label: "해고 절차", status: "failed", articles: [], precedents: [] },
        { label: "해고예고", status: "timeout", articles: [], precedents: [] }]
      : [{ label: "해고의 정당성", status: "found", articles: [article23], precedents: ["71", "72"] },
        { label: "해고 절차", status: "found", articles: [article23], precedents: [] },
        { label: "해고예고", status: "none", articles: [], precedents: [] }];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
      found: true, task: "full_research", text, markers: [], interpretation,
      evidence: source ? { status: "partial", articles: [article23], issues,
        // The same case under two serial ids, as the upstream sometimes returns it.
        ...(query === "일부 근거" ? { precedents: ["71", "72"], precedentEntries: {
          71: { title: "미지급퇴직금", caseNumber: "95다19256", body: "대법원" },
          72: { title: "미지급퇴직금", caseNumber: "95다19256", body: "대법원" },
        } } : { precedents: [] }) }
        : { status: "unverified", articles: [], precedents: [], issues: interpretation.issues.map(({ label }) => ({ label, status: "none", articles: [], precedents: [] })) },
    } }) });
  });
  await page.goto("/");
  await navigateWorkspace(page, "법령");
  await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
  const form = page.getByRole("form", { name: /^(종합 리서치|문서 검토) 입력$/ });
  const query = form.getByLabel("질문 또는 검색어");
  const run = form.getByRole("button", { name: "실행" });
  await query.fill("회사에서 갑자기 잘렸어");
  await run.click();
  const overview = page.locator(".research-overview");
  await expect(overview.locator("h3")).toHaveText("직접 관련된 근거가 충분하지 않습니다");
  // The specific follow-up replaces the generic uncertainty instead of repeating it.
  await expect(overview).toContainText("추가로 필요한 정보 근무 기간은 얼마나 되나요?");
  // After the search, each issue is a row naming how far its evidence got; "none" never reads as "no law".
  await expect(overview.locator(".research-issues > span").first()).toHaveText("확인한 쟁점");
  await expect(overview.locator(".research-issue-label")).toHaveText(["해고의 정당성", "해고 절차", "해고예고"]);
  await expect(overview.locator(".research-issue-status")).toHaveText(["직접 관련 근거 미확인", "직접 관련 근거 미확인", "직접 관련 근거 미확인"]);
  await expect(overview).not.toContainText(/근거 없음|NONE|FOUND/u);
  await expect(overview).not.toContainText("근로계약의 형태는 확인되지 않았습니다.");
  await expect(overview).not.toContainText("근로계약이 종료되었");
  await expect(page.locator(".research-selected")).toHaveCount(0);
  // Search statistics are not shown; only what was reviewed.
  await expect(page.locator("[data-kind='decision_search'] h3")).toContainText("1건");
  for (const part of [".research-overview", ".research-group"]) {
    await expect(page.locator(`.legal-research ${part}`).first()).not.toContainText(/후보|총 65건/u);
  }
  await query.fill("자료 없음");
  await run.click();
  await expect(page.locator(".legal-analysis-missing h3")).toHaveText("관련 근거를 확인하지 못했습니다");
  await expect(page.locator(".legal-analysis-missing")).toContainText("자료 없음");
  // Before any evidence is assessed, the issues flow on one line under their own rule.
  const pending = page.locator(".legal-analysis-missing .research-issues li");
  await expect(page.locator(".legal-analysis-missing .research-issues > span").first()).toHaveText("살펴볼 쟁점");
  await expect(pending).toHaveText(["해고의 정당성", "해고 절차", "해고예고"]);
  const [first, last] = [await pending.nth(0).boundingBox(), await pending.nth(2).boundingBox()];
  expect(Math.abs(first!.y - last!.y)).toBeLessThan(1);
  await expect(page.locator(".legal-analysis-missing")).not.toContainText("get_law_text");
  await query.fill("일부 근거");
  await run.click();
  await expect(overview.locator("h3")).toHaveText("관련 근거를 일부 확인했습니다");
  await expect(overview.locator(".research-caution")).toHaveText("확인한 근거는 관련 쟁점을 검토하기 위한 자료이며, 구체적인 사건의 법적 결론을 의미하지 않습니다.");
  // Evidence sits under the issue it supports; a source shared by two issues is shown once, and a gap is named.
  const selected = page.locator(".research-selected");
  const groups = selected.locator(".research-issue-evidence");
  await expect(groups.locator("h3")).toHaveText(["해고의 정당성", "해고 절차", "해고예고"]);
  await expect(overview.locator(".research-issue-status")).toHaveText(["근거 확인", "근거 확인", "직접 관련 근거 미확인"]);
  // The article and the case; the case filed under two ids is listed once.
  await expect(groups.nth(0).locator(".research-hits > li")).toHaveCount(2);
  await expect(groups.nth(0)).toContainText("근로기준법 제23조");
  await expect(groups.nth(0).getByText("사건번호 95다19256")).toHaveCount(1);
  await expect(groups.nth(1).locator(".research-hits")).toHaveCount(0);
  await expect(groups.nth(1)).toContainText("앞 쟁점에서 제시한 근거와 같습니다: 근로기준법 제23조");
  await expect(groups.nth(2)).toContainText("직접 관련된 근거를 찾지 못했습니다.");
  await expect(page.locator(".legal-research-partial")).toHaveCount(0);
  await expect(overview).not.toContainText("현행");
  // Issues whose lookups could not answer are named as such, and the partial notice says so.
  await query.fill("일부 실패");
  await run.click();
  await expect(overview.locator("h3")).toHaveText("관련 근거를 일부 확인했습니다");
  await expect(page.locator(".legal-research-partial")).toHaveText("일부 쟁점의 자료를 확인하지 못했습니다. 확인된 자료를 기준으로 결과를 표시합니다.");
  // Failed and unfinished lookups are not "not found".
  await expect(overview.locator(".research-issue-status")).toHaveText(["근거 확인", "자료 확인 실패", "조회 미완료"]);
  await expect(groups.nth(1)).toContainText("자료를 불러오지 못해 확인하지 못했습니다.");
  await expect(groups.nth(2)).toContainText("조회를 마치지 못해 확인하지 못했습니다.");
});

test("RESEARCH every task applies the same result rules while keeping its own structure", async ({ page }) => {
  await page.route("**/api/law/research", (route) => {
    const body = route.request().postDataJSON() as { task: string };
    const extra: Record<string, string> = {
      amendment_track: "\n\n▶ Time Travel — 근로기준법 (20211119 ↔ 20251023)\n변경 조문 3건",
      procedure_detail: "\n\n▶ 행정심판법 별표/서식\n별표/서식 목록 (총 2건)\n1. [별지 제30호서식] 행정심판 청구서\n2. [별지 제31호서식] 집행정지신청서",
      law_system: "\n\n▶ 3단 비교 (법률·시행령·시행규칙)\n[법률] 개인정보 보호법 제38조\n[시행령] 제41조\n[시행규칙] 제12조",
    };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
      found: true, task: body.task, text: fullResearchFixture() + (extra[body.task] ?? ""), markers: ["NOT_FOUND"],
      ...(body.task === "ordinance_compare" ? { comparison: { topic: "q", topics: [], regions: [
        { region: "인천광역시", status: "none", candidates: 0, articles: [] }, { region: "서울특별시", status: "none", candidates: 0, articles: [] }] } } : {}),
    } }) });
  });
  await page.goto("/");
  await navigateWorkspace(page, "법령");
  await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
  const form = page.getByRole("form", { name: /^(종합 리서치|문서 검토) 입력$/ });
  await form.getByLabel("질문 또는 검색어").fill("직장 내 괴롭힘 판단 기준");
  await chooseOption(page, form.getByLabel("리서치 유형"), researchTaskLabels.ordinance_compare);
  await form.getByLabel("비교 지역 1").fill("인천광역시");
  await form.getByLabel("비교 지역 2").fill("서울특별시");
  const tasks = ["full_research", "law_system", "action_basis", "dispute_prep", "amendment_track", "ordinance_compare", "procedure_detail"];
  const labels: Record<string, string> = { full_research: "통합 조사", law_system: "법체계 확인", action_basis: "처분·허가 근거", dispute_prep: "분쟁·불복 자료",
    amendment_track: "개정 추적", ordinance_compare: "조례 비교", procedure_detail: "절차·서식" };
  const statuses = new Set<string>();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const task of tasks) {
      await chooseOption(page, form.getByLabel("리서치 유형"), researchTaskLabels[task]);
      await form.getByRole("button", { name: "실행" }).click();
      const output = page.locator(".legal-research .legal-analysis-output");
      await expect(output.locator(".research-overview")).toBeVisible();
      // The first box reads as a result: no "· 조회 결과" label, no "…살펴보세요" instruction, one question label.
      await expect(output.locator(".research-overview .research-eyebrow").first(), task).toHaveText(labels[task]);
      await expect(output.locator(".research-overview h3"), task).toHaveText(/^관련 근거를 (?:확인했습니다|일부 확인했습니다|확인하지 못했습니다)$|^직접 관련된 근거가 충분하지 않습니다$/u);
      statuses.add(`${task}:${await output.locator(".research-overview h3").getAttribute("data-status")}`);
      await expect(output.locator(".research-original > span"), task).toHaveText("입력한 질문");
      // Search-engine vocabulary stays out of what the reader sees.
      for (const text of await output.locator(":scope > .research-overview, :scope > .research-group").allInnerTexts()) {
        expect(text, task).not.toMatch(/후보|검색 보정|시그널|STEP\s*\d|API 조건|내부 검색어/u);
      }
      // An empty section is one line; the whole-law TOC follows the detail material; "나머지 조문" keeps its fold.
      await expect(output.locator("p[data-status='not_found']"), task).toHaveText("법령 해석례 · 자료 없음");
      const supporting = await output.locator(".research-supporting details").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-kind")));
      expect(supporting.indexOf("detail"), task).toBeLessThan(supporting.indexOf("law_toc"));
      await expect(output.locator("details summary").filter({ hasText: /나머지 조문 \d+건 보기/u }), task).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), task).toBe(true);
    }
  }
  // The status follows adopted evidence, not a fixed title: this fixture gives full research no adopted
  // source (weak), a comparison with no regional ordinance (none), and the others partial results.
  expect([...statuses].filter((entry) => entry.startsWith("full_research:"))).toEqual(["full_research:weak"]);
  expect([...statuses].filter((entry) => entry.startsWith("ordinance_compare:"))).toEqual(["ordinance_compare:none"]);
  expect([...statuses].filter((entry) => entry.startsWith("law_system:"))).toEqual(["law_system:partial"]);
  // Each type keeps its own structure.
  await chooseOption(page, form.getByLabel("리서치 유형"), researchTaskLabels.amendment_track);
  await expect(page.locator(".research-group[data-group='change']")).toContainText("두 시점의 조문 비교");
  await chooseOption(page, form.getByLabel("리서치 유형"), researchTaskLabels.law_system);
  await expect(page.locator(".research-hierarchy dt")).toHaveText(["법률", "시행령", "시행규칙"]);
  await chooseOption(page, form.getByLabel("리서치 유형"), researchTaskLabels.ordinance_compare);
  await expect(page.getByRole("region", { name: "조례 대조" })).toBeVisible();
  await chooseOption(page, form.getByLabel("리서치 유형"), researchTaskLabels.procedure_detail);
  await expect(page.locator("[data-kind='annex']")).toContainText("행정심판 청구서");
});

test("RESEARCH separates a verified article from search candidates and hides internal guidance", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("worklens:review-preferences:v1", JSON.stringify({
    version: 1, preferences: { documentSource: "text", expandSources: true },
  })));
  await page.route("**/api/law/research", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
    found: true, task: "full_research", text: fullResearchFixture(), markers: ["NOT_FOUND"],
    interpretation: { original: "직장 내 괴롭힘 판단 기준", situation: "직장에서 괴롭힘 문제를 겪는 상황으로 이해했습니다.", facts: [], issues: [{ label: "직장 내 괴롭힘", query: "직장 내 괴롭힘" }], confidence: "high" },
    evidence: { status: "matched", articles: [{ law: "근로기준법", jo: "제76조의2", currency: "current" }], precedents: [] },
  } }) }));
  await page.goto("/");
  await navigateWorkspace(page, "법령");
  await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
  const form = page.getByRole("form", { name: /^(종합 리서치|문서 검토) 입력$/ });
  await expect(form.getByRole("heading", { name: "출처 표시", exact: true })).toHaveCount(0);
  await expect(form.getByRole("switch", { name: "출처 표시", exact: true })).toHaveCount(0);
  await form.getByLabel("질문 또는 검색어").fill("직장 내 괴롭힘 판단 기준");
  await form.getByRole("button", { name: "실행" }).click();
  const output = page.locator(".legal-research .legal-analysis-output");
  await expect(output.locator(".research-overview")).toContainText("직장에서 괴롭힘 문제를 겪는 상황");
  await expect(output.locator(".research-original").first()).toContainText("입력한 질문");
  await expect(output.locator(".research-understanding")).toContainText("이렇게 이해했어요");
  await expect(output.getByRole("heading", { name: "확인한 근거" })).toBeVisible();
  await expect(output.locator(".research-selected")).toContainText("근로기준법 제76조의2");
  await expect(output.locator(".research-selected")).toContainText("사용자 또는 근로자는 직장에서의 지위를 이용하여");
  await expect(output.locator(".research-selected [data-currency='current']")).toHaveText("현행 · 시행 2026.08.20");
  await expect(output.locator("[data-kind='law_articles'] > .research-hits > li")).toHaveCount(3);
  await expect(output.locator("[data-kind='decision_search'] h3")).toContainText("5건");
  // An empty section is one line: heading and state together.
  await expect(output.locator("p[data-status='not_found']")).toHaveText("법령 해석례 · 자료 없음");
  await expect(output.locator(".legal-research-partial")).toContainText("일부 자료 조회가 완료되지 않아");
  // What this answer drew on comes before the whole-law table of contents.
  const supporting = await output.locator(".research-supporting details").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-kind")));
  expect(supporting.indexOf("detail")).toBeLessThan(supporting.indexOf("law_toc"));
  const toc = output.locator("details[data-kind='law_toc']");
  await expect(toc.locator("summary")).toContainText("근로기준법 법령 전체 보기 · 132개 조문");
  await expect(toc).not.toHaveAttribute("open", "");
  await toc.locator("summary").click();
  await expect(toc.locator("pre")).toContainText("제132조 조문 제목 132");
  const source = output.locator(".research-source");
  await expect(source).not.toHaveAttribute("open", "");
  await source.locator("summary").click();
  await expect(output.locator(".research-source pre")).not.toContainText(/get_law_text|검색 보정 시도|법제처 API는 공백/u);
  await expect(output).not.toContainText("searchTerms");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("document review keeps issue guidance ahead of independent, grouped source disclosures on desktop and mobile", async ({ page }) => {
  const penalty = [...B2B_SERVICE_CONTRACT.split("\n").slice(0, 2), B2B_SERVICE_CONTRACT.split("\n")[7]].join("\n");
  const sale = [...SUPPLY_CONTRACT.split("\n").slice(0, 2), SUPPLY_CONTRACT.split("\n")[3]].join("\n");
  const nda = [...NDA_CONTRACT.split("\n").slice(0, 2), NDA_CONTRACT.split("\n")[4]].join("\n");
  const excerpt = "조문에 기재된 장문의 확인할 사항과 적용 조건 ".repeat(30);
  const partial = [...B2B_SERVICE_CONTRACT.split("\n").slice(0, 2), B2B_SERVICE_CONTRACT.split("\n")[7], B2B_SERVICE_CONTRACT.split("\n")[12]].join("\n");
  const lawEntries: ContractReview["laws"] = {
    "law-a": { key: "law-a", law: "민법", jo: "제398조", title: "배상액의 예정", excerpt },
    "law-b": { key: "law-b", law: "약관의 규제에 관한 법률", jo: "제8조", title: "손해배상액의 예정", excerpt },
  };
  const precedentEntries: ContractReview["precedents"] = {
    "case-a": { key: "case-a", id: "penalty-a", title: "위약금 과다 약정", caseNumber: "2024다101", court: "대법원", date: "20240101", holding: "위약금 약정이 부당히 과다한 경우 손해배상액의 예정 감액 여부", scope: "판시사항" },
    "case-b": { key: "case-b", id: "penalty-b", title: "손해배상 예정액", caseNumber: "2024다102", court: "대법원", date: "20240202", holding: "손해배상액의 예정이 부당히 과다하면 감액 가능 여부", scope: "판시사항" },
  };
  const fixtureReview = (input: string, mode: "both" | "statute" | "precedent" | "partial" | "excluded" | "empty"): ContractReview => {
    const document = classifyDocument(input);
    const clauses = reviewClauses(splitClauses(input), document);
    const lawKeys = mode === "both" ? ["law-a", "law-b"] : mode === "statute" ? ["law-a"] : [];
    const caseKeys = mode === "both" || mode === "precedent" || mode === "partial" ? ["case-a", "case-b"] : [];
    return {
      document, risk: documentRisk(clauses), facts: extractKeyFacts(clauses),
      clauses: clauses.filter((clause) => clause.issues.length > 0).map((clause, clauseIndex) => ({
        ...clause, issues: clause.issues.map((issue, issueIndex) => ({
          ...issue,
          laws: clauseIndex === 0 && issueIndex === 0 ? lawKeys : [],
          precedents: clauseIndex === 0 && issueIndex === 0 ? caseKeys : [],
          lawStatus: lawKeys.length ? "found" as const : "none" as const,
          precedentStatus: caseKeys.length ? "found" as const : "none" as const,
        })),
      })),
      laws: Object.fromEntries(lawKeys.map((key) => [key, lawEntries[key]])),
      precedents: Object.fromEntries(caseKeys.map((key) => [key, precedentEntries[key]])),
      stats: { calls: 0, queries: 0, excludedPrecedents: mode === "excluded" ? 1 : 0, excludedLaws: 0 },
    };
  };
  const fixtures = {
    both: { input: penalty, review: fixtureReview(penalty, "both"), status: "matched", title: "관련 근거를 확인했습니다", law: 2, precedent: 2, summary: "검토 조항 1개 · 높은 우선순위 1건" },
    statute: { input: sale, review: fixtureReview(sale, "statute"), status: "matched", title: "관련 근거를 확인했습니다", law: 1, precedent: 0, summary: "검토 조항 1개 · 높은 우선순위 1건" },
    precedent: { input: nda, review: fixtureReview(nda, "precedent"), status: "matched", title: "관련 근거를 확인했습니다", law: 0, precedent: 2, summary: "검토 조항 1개 · 높은 우선순위 1건" },
    partial: { input: partial, review: fixtureReview(partial, "partial"), status: "partial", title: "관련 근거를 일부 확인했습니다", law: 0, precedent: 2, summary: "검토 조항 2개 · 높은 우선순위 1건" },
    excluded: { input: `${penalty}\n제7조(중복) 이용자는 잔여기간 이용료의 50%를 위약금으로 지급한다.`, review: fixtureReview(`${penalty}\n제7조(중복) 이용자는 잔여기간 이용료의 50%를 위약금으로 지급한다.`, "excluded"), status: "weak", title: "직접 관련된 근거가 충분하지 않습니다", law: 0, precedent: 0, summary: "검토 조항 2개 · 높은 우선순위 1건" },
    clean: { input: CLEAN_WORK_RULES, review: fixtureReview(CLEAN_WORK_RULES, "empty"), status: "none", title: "검토할 쟁점을 찾지 못했습니다", law: 0, precedent: 0, summary: "검토 조항 0개 · 높은 우선순위 0건" },
  };
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.route("**/api/law/research", (route) => {
    const body = route.request().postDataJSON() as { task: string; text: string };
    const match = Object.values(fixtures).find(({ input }) => input === body.text);
    if (body.task !== "document_review" || !match) throw new Error("Unexpected document review request");
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, task: body.task, text: "", markers: [], review: match.review } }) });
  });
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await navigateWorkspace(page, "법령");
  await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
  const form = page.getByRole("form", { name: /^(종합 리서치|문서 검토) 입력$/ });
  await chooseOption(page, form.getByLabel("리서치 유형"), researchTaskLabels.document_review);
  await form.getByRole("radio", { name: "직접 입력" }).check();
  const input = form.getByLabel("검토할 문서 내용");

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const [name, fixture] of Object.entries(fixtures)) {
      await input.fill(fixture.input);
      await form.getByRole("button", { name: "실행", exact: true }).click();
      const review = page.locator(".contract-review");
      await expect(review.locator(".research-overview h3"), name).toHaveAttribute("data-status", fixture.status);
      await expect(review.locator(".research-overview h3"), name).toHaveText(fixture.title);
      const sections = await review.locator(":scope > .legal-analysis-section").evaluateAll((nodes) => nodes.map((node) => node.classList[1]));
      expect(sections.slice(0, 3), name).toEqual(["contract-review-overview", "contract-review-summary", "contract-review-results"]);
      await expect(review.locator(".contract-review-overview"), name).toContainText(fixture.review.document.label);
      await expect(review.locator(".contract-review-overview"), name).toContainText(fixture.review.risk.level);
      await expect(review.locator(".contract-review-summary"), name).toContainText(fixture.summary);
      const firstIssue = review.locator(".contract-review-issue").first();
      if (name === "clean") {
        await expect(firstIssue).toHaveCount(0);
        await expect(review.locator(".contract-review-results")).toContainText("검토할 쟁점을 찾지 못했습니다.");
      } else {
        await expect(firstIssue.locator("dt"), name).toHaveText(["검토 원문", "검토 결과", "우선순위", "수정 제안", "확인한 근거"]);
        await expect(firstIssue.locator("dd").nth(0), name).toHaveText(fixture.review.clauses[0].issues[0].fact);
        await expect(firstIssue.locator("dd").nth(3), name).toHaveText(fixture.review.clauses[0].issues[0].suggestion);
      }
      const detail = review.locator(".contract-review-detail").first();
      const disclosures = detail.locator(".law-detail-source");
      if (fixture.law + fixture.precedent === 0) {
        await expect(review.locator(".contract-review-details")).toHaveCount(0);
        if (name !== "clean") await expect(firstIssue.locator("dd").last()).toContainText("확인된 직접 근거 없음");
      } else {
        await expect(review.locator(".contract-review-details")).toBeVisible();
        await expect(disclosures).toHaveCount(Number(fixture.law > 0) + Number(fixture.precedent > 0));
        for (const disclosure of await disclosures.all()) await expect(disclosure).not.toHaveAttribute("open", "");
        if (fixture.law) {
          const law = disclosures.first();
          await expect(law.locator("summary")).toContainText(`관련 법령 ${fixture.law}건 보기`);
          await law.locator("summary").click();
          await expect(law.locator("li")).toHaveCount(fixture.law);
          await expect(law.locator("pre").first()).toContainText(excerpt.slice(0, 100));
          if (fixture.precedent) await expect(disclosures.last()).not.toHaveAttribute("open", "");
        }
        if (fixture.precedent) {
          const precedent = disclosures.last();
          await expect(precedent.locator("summary")).toContainText(`관련 판례 ${fixture.precedent}건 보기`);
          await precedent.locator("summary").click();
          await expect(precedent.locator("li")).toHaveCount(fixture.precedent);
          await expect(precedent).toContainText("2024다101");
          if (fixture.law) await expect(disclosures.first()).toHaveAttribute("open", "");
          await precedent.locator("summary").click();
          await expect(precedent).not.toHaveAttribute("open", "");
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} @ ${viewport.width}`).toBe(true);
    }
  }
  await chooseOption(page, form.getByLabel("리서치 유형"), researchTaskLabels.full_research);
  await expect(page.locator(".contract-review")).toHaveCount(0);
  await expect(form.getByLabel("질문 또는 검색어")).toBeVisible();
  await page.getByRole("tab", { name: "법령 검색", exact: true }).click();
  await expect(page.locator(".contract-review")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("document evidence links focus only the selected issue without changing disclosures or history", async ({ page }) => {
  const input = "제6조 휴가와 미사용 휴가를 정한다.\n제10조 개인정보 및 모니터링을 정한다.";
  const longExcerpt = `① 개인정보 처리 조건을 확인한다.\n${"관련 요건을 확인하고 해당 조항의 적용 여부를 대조한다. ".repeat(45)}`;
  const issue = (id: string, label: string, laws: string[], precedents: string[] = []) => ({
    id, label, severity: "medium" as const, point: `${label} 검토가 필요합니다.`, suggestion: `${label} 조건을 확인합니다.`,
    fact: `${label} 원문`, laws, precedents, lawStatus: "found" as const, precedentStatus: precedents.length ? "found" as const : "none" as const,
  });
  const review: ContractReview = {
    document: { type: "work_rules", label: "근로·인사 관련 내부 규정", relationship: "employment", relationshipLabel: "사용자·근로자", confidence: "high", evidence: [], domains: ["labor"] },
    risk: { score: 3, level: "보통", high: 0, medium: 3, low: 0 },
    facts: [],
    clauses: [
      { number: "제6조", title: "휴가", text: "휴가", issues: [
        issue("leave-use", "연차휴가 사용 제한", ["law-a"], ["case-a"]),
        issue("leave-unused", "미사용 휴가 처리", ["law-b"]),
      ] },
      { number: "제10조", title: "개인정보 및 모니터링에 관한 긴 조항 제목", text: "개인정보", issues: [
        issue("privacy", "개인정보 수집과 모니터링 범위", ["law-c"], ["case-b"]),
      ] },
    ],
    laws: {
      "law-a": { key: "law-a", law: "근로기준법", jo: "제60조", title: "연차휴가", excerpt: "① 연차휴가를 부여한다." },
      "law-b": { key: "law-b", law: "근로기준법", jo: "제61조", title: "연차휴가의 사용 촉진", excerpt: "① 사용 촉진 조치를 확인한다." },
      "law-c": { key: "law-c", law: "개인정보 보호법", jo: "제15조", title: "개인정보의 수집·이용", excerpt: longExcerpt },
    },
    precedents: {
      "case-a": { key: "case-a", id: "leave-case", title: "연차휴가 사건", holding: "연차휴가 관련 판시사항", scope: "판시사항" },
      "case-b": { key: "case-b", id: "privacy-case", title: "개인정보 처리 사건", holding: "개인정보 관련 판시사항", scope: "판시사항" },
    },
    stats: { calls: 0, queries: 0, excludedPrecedents: 0, excludedLaws: 0 },
  };
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.route("**/api/law/research", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ data: { found: true, task: "document_review", text: "", markers: [], review } }),
  }));
  // Phases are read from resolved styles, not mid-transition frames.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await navigateWorkspace(page, "법령");
  await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
  const form = page.getByRole("form", { name: /^(종합 리서치|문서 검토) 입력$/ });
  await chooseOption(page, form.getByLabel("리서치 유형"), researchTaskLabels.document_review);
  await form.getByRole("radio", { name: "직접 입력" }).check();
  await form.getByLabel("검토할 문서 내용").fill(input);
  await form.getByRole("button", { name: "실행", exact: true }).click();
  const reviewResult = page.locator(".contract-review");
  const links = reviewResult.getByRole("button", { name: "상세 근거 보기" });
  const details = reviewResult.locator(".contract-review-detail");
  await expect(links).toHaveCount(3);
  await expect(details).toHaveCount(3);
  const historyLength = await page.evaluate(() => history.length);

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const first = details.nth(0);
    const sameClause = details.nth(1);
    const last = details.nth(2);
    const layout = () => first.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const title = node.querySelector("h4")!.getBoundingClientRect();
      const row = node.querySelector("summary")!.getBoundingClientRect();
      const next = node.nextElementSibling!.getBoundingClientRect();
      return { boxLeft: box.left, boxRight: box.right, titleLeft: title.left, rowLeft: row.left, rowRight: row.right, nextOffset: next.top - title.top };
    });
    const resting = await layout();
    await links.nth(0).click();
    const fresh = await first.evaluate((node) => ({ fresh: node.classList.contains("is-focus-fresh"), bg: getComputedStyle(node).backgroundColor }));
    expect(fresh.fresh).toBe(true);
    const focused = await layout();
    // The box grows outward to give the text an inner margin; text and the following blocks stay put.
    expect(focused.titleLeft).toBeCloseTo(resting.titleLeft, 1);
    expect(focused.rowLeft).toBeCloseTo(focused.titleLeft, 1);
    expect(focused.nextOffset).toBeCloseTo(resting.nextOffset, 1);
    expect(focused.titleLeft - focused.boxLeft).toBeGreaterThanOrEqual(12);
    expect(focused.boxRight - focused.rowRight).toBeGreaterThanOrEqual(12);
    expect(focused.boxLeft).toBeGreaterThanOrEqual(0);
    expect(focused.boxRight).toBeLessThanOrEqual(viewport.width);
    await expect(first).not.toHaveClass(/is-focus-fresh/u);
    await expect(first).toHaveClass(/is-focused/u);
    const settled = await first.evaluate((node) => getComputedStyle(node).backgroundColor);
    const lightness = (color: string) => {
      const values = color.match(/[\d.]+/gu)!.slice(0, 3).map(Number);
      return values.reduce((sum, value) => sum + (color.startsWith("color(") ? value * 255 : value), 0);
    };
    expect(lightness(fresh.bg)).toBeLessThan(lightness(settled));
    expect(lightness(settled)).toBeLessThan(255 * 3);
    await expect(reviewResult.locator(".contract-review-detail.is-focused")).toHaveCount(1);
    await expect(first.locator(".law-detail-source")).toHaveCount(2);
    const firstLaw = first.locator(".law-detail-source").first();
    if (viewport.width > 700) await expect(firstLaw).not.toHaveAttribute("open", "");
    else await expect(firstLaw).toHaveAttribute("open", "");
    expect(await first.evaluate((node) => getComputedStyle(node).boxShadow)).not.toBe("none");
    if (viewport.width > 700) await firstLaw.locator("summary").click();
    await expect(firstLaw).toHaveAttribute("open", "");
    await links.nth(1).click();
    await expect(sameClause).toHaveClass(/is-focused/u);
    await expect(first).not.toHaveClass(/is-focused/u);
    await expect(firstLaw).toHaveAttribute("open", "");
    await links.nth(0).click();
    await links.nth(2).click();
    await expect(last).toHaveClass(/is-focused/u);
    await expect(reviewResult.locator(".contract-review-detail.is-focused")).toHaveCount(1);
    await expect(first).not.toHaveClass(/is-focused/u);
    await expect(last.locator(".law-detail-source[open]")).toHaveCount(0);
    // Desktop keeps the 64px context bar sticky; on phones it scrolls away.
    const headerOffset = viewport.width < 700 ? 0 : 64;
    await expect.poll(async () => last.evaluate((node, minTop) => {
      const { top, bottom } = node.getBoundingClientRect();
      return top >= minTop && bottom <= innerHeight;
    }, headerOffset)).toBe(true);
    await expect(last).not.toHaveClass(/is-focused/u, { timeout: 4_000 });
    // Back to the resting block: no tint, no inset.
    const rest = await last.evaluate((node) => ({
      bg: getComputedStyle(node).backgroundColor,
      inset: node.querySelector("h4")!.getBoundingClientRect().left - node.getBoundingClientRect().left,
    }));
    expect(rest.bg).toBe("rgba(0, 0, 0, 0)");
    expect(rest.inset).toBeCloseTo(0, 1);
    await links.nth(2).click();
    await expect(last).toHaveClass(/is-focused/u);
    await expect(reviewResult.locator(".contract-review-detail.is-focused")).toHaveCount(1);
    await expect(last).not.toHaveClass(/is-focus-fresh/u);
    await links.nth(2).click();
    expect(await last.evaluate((node) => node.classList.contains("is-focus-fresh"))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(page.url()).not.toContain("#");
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    await expect(last).not.toHaveClass(/is-focused/u, { timeout: 4_000 });
  }
  expect(errors).toEqual([]);
});


test("law views use the shared tool content width with one left and right edge", async ({ page }) => {
  await page.route("**/api/law", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, laws: [{ name: "근로기준법", mst: "283457", status: "현행" }] } }) }));
  await page.route("**/api/law/text", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, mode: "article", name: "근로기준법", text: "제74조(임산부의 보호)\n① 조문 본문" } }) }));
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await navigateWorkspace(page, "PDF 도구");
    const tool = (await page.locator(".pdf-tool").boundingBox())!;
    await navigateWorkspace(page, "법령");
    await page.getByRole("tab", { name: "법령 검색", exact: true }).click();
    const research = (await page.locator(".law-research").boundingBox())!;
    expect(Math.abs(research.x - tool.x)).toBeLessThan(1);
    expect(Math.abs(research.width - tool.width)).toBeLessThan(1);
    const input = page.getByRole("searchbox");
    if (!(await page.locator(".law-search-list").count())) {
      await input.fill("근로기준법");
      await page.getByRole("button", { name: "검색", exact: true }).click();
    }
    await expect(page.getByRole("heading", { name: "검색 결과 · 1건" })).toBeVisible();
    const surface = (await page.locator(".law-search-form").boundingBox())!;
    expect(Math.abs(surface.x - research.x)).toBeLessThan(1);
    expect(Math.abs(surface.x + surface.width - (research.x + research.width))).toBeLessThan(1);
    for (const selector of ["#law-results-heading", ".law-search-list"]) {
      expect(Math.abs((await page.locator(selector).boundingBox())!.x - research.x), selector).toBeLessThan(1);
    }
    const list = (await page.locator(".law-search-list").boundingBox())!;
    expect(Math.abs(list.x + list.width - (research.x + research.width))).toBeLessThan(1);
    const row = (await page.locator(".law-search-row").boundingBox())!;
    expect(Math.abs(row.x - surface.x)).toBeLessThan(1);
    expect(Math.abs(row.x + row.width - (surface.x + surface.width))).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

async function downloadBytes(page: Page, click: () => Promise<void>) {
  const pending = page.waitForEvent("download");
  await click();
  const download = await pending;
  return { name: download.suggestedFilename(), bytes: new Uint8Array(await readFile(await download.path())) };
}

/** Drags an item by its grip onto one side of a target, the way a mouse user does. */
async function dragGrip(page: Page, grip: Locator, target: Locator, side: "before" | "after", axis: "x" | "y") {
  // Start away from the viewport edges so edge auto-scroll does not move the target mid-gesture.
  await grip.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
  const from = (await grip.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 8, { steps: 3 });
  const fraction = side === "before" ? 0.25 : 0.75;
  for (let step = 0; step < 8; step++) {
    const to = (await target.boundingBox())!;
    const x = axis === "x" ? to.x + to.width * fraction : to.x + to.width / 2;
    const y = axis === "y" ? to.y + to.height * fraction : to.y + to.height / 2;
    await page.mouse.move(x, y, { steps: 2 });
  }
  await expect(target).toHaveAttribute("data-drop", side);
  await page.mouse.up();
}

async function imageDimensions(page: Page, bytes: Uint8Array, mime: string) {
  return page.evaluate(async ({ image, type }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(image)], { type }));
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dimensions;
  }, { image: [...bytes], type: mime });
}

async function imagePixel(page: Page, bytes: Uint8Array, x: number, y: number) {
  return page.evaluate(async ({ image, x, y }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(image)], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return [...context.getImageData(x, y, 1, 1).data];
  }, { image: [...bytes], x, y });
}

test("PDF and image tools align their workspace and share a responsive export pattern", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  const geometry = () => page.evaluate(() => {
    const root = document.querySelector(".pdf-tool, .image-tool")!;
    const top = root.getBoundingClientRect().top;
    const selectors = [".pdf-tool-upload, .image-tool-upload"];
    const boxes = selectors.map((selector) => {
      const box = root.querySelector(selector)!.getBoundingClientRect();
      return { x: box.x, y: box.y - top };
    });
    return { boxes, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }, { width: 900, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await navigateWorkspace(page, "PDF 도구");
    await expect(page.locator(".pdf-tool")).toBeVisible();
    await page.evaluate(() => scrollTo(0, 0));
    // The utility header supplies the title; tool bodies show one upload zone.
    await expect(page.locator(".tool-intro")).toHaveCount(0);
    await expect(page.locator(".tool-eyebrow")).toHaveCount(0);
    await expect(page.locator(".pdf-tool-editor, .pdf-tool-export, .pdf-tool-badge")).toHaveCount(0);
    await expect(page.locator(".pdf-tool-upload").getByRole("button", { name: "PDF 추가" })).toBeVisible();
    await expect(page.getByText("PDF 파일 선택", { exact: true })).toHaveCount(0);
    const pdf = await geometry();
    await navigateWorkspace(page, "이미지 도구");
    await expect(page.locator(".image-tool")).toBeVisible();
    await page.evaluate(() => scrollTo(0, 0));
    await expect(page.locator(".image-tool-layout, .image-tool-export")).toHaveCount(0);
    await expect(page.locator(".image-tool-upload").getByRole("button", { name: "이미지 추가" })).toBeVisible();
    const image = await geometry();
    for (let index = 0; index < pdf.boxes.length; index++) {
      expect(Math.abs(pdf.boxes[index].x - image.boxes[index].x)).toBeLessThan(1);
      expect(Math.abs(pdf.boxes[index].y - image.boxes[index].y)).toBeLessThan(1);
    }
    expect(pdf.overflow || image.overflow).toBe(false);
  }

  // The export toolbar appears once a PDF is added and keeps its responsive layout.
  await navigateWorkspace(page, "PDF 도구");
  await page.getByLabel("PDF 파일 선택").setInputFiles({ name: "one.pdf", mimeType: "application/pdf", buffer: Buffer.from(await createPdf(["ONE"])) });
  await expect(page.locator(".pdf-tool-page")).toHaveCount(1);
  await expect(page.locator(".pdf-tool-upload").getByRole("button", { name: "PDF 추가" })).toBeVisible();
  const toolbar = page.locator(".pdf-tool-export");
  await expect(toolbar).toContainText("1페이지");
  await expect(toolbar.getByLabel("압축")).toContainText("균형 (권장)");
  await chooseOption(page, toolbar.getByLabel("형식"), "PNG");
  await expect(toolbar.getByLabel("압축")).toHaveCount(0);
  await chooseOption(page, toolbar.getByLabel("형식"), "PDF");
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test("PDF editor composes reordered, rotated and deleted pages into real files", async ({ page }) => {
  const posted: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST") posted.push(request.url()); });
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await navigateWorkspace(page, "PDF 도구");
  await page.getByLabel("PDF 파일 선택").setInputFiles({
    name: "composed.pdf", mimeType: "application/pdf",
    buffer: Buffer.from(await createPdf(["FIRST", "SECOND", "THIRD", "FOURTH"])),
  });
  const pages = page.locator(".pdf-tool-page");
  await expect(pages).toHaveCount(4);
  await page.getByRole("checkbox", { name: "2번 페이지 선택", exact: true }).check();
  await page.getByRole("button", { name: /오른쪽 90°/ }).click();
  await page.getByRole("checkbox", { name: "2번 페이지 선택", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "3번 페이지 선택", exact: true }).check();
  await page.getByRole("button", { name: "선택 삭제" }).click();
  await expect(pages).toHaveCount(3);
  await expect(page.getByRole("button", { name: /(왼쪽|오른쪽|위로|아래로)으로? 이동/ })).toHaveCount(0);
  // Selection follows the page, not the slot it occupied.
  await page.getByRole("checkbox", { name: "3번 페이지 선택", exact: true }).check();
  await dragGrip(page, page.getByRole("button", { name: "3번 페이지 순서 변경" }), pages.nth(1), "before", "x");
  await expect(pages.locator(".pdf-tool-page-meta span")).toHaveText(["원본 1페이지", "원본 4페이지", "원본 2페이지 · +90°"]);
  await expect(page.getByRole("checkbox", { name: "2번 페이지 선택", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "3번 페이지 선택", exact: true })).not.toBeChecked();
  await expect(page.locator(".tool-reorder-live")).toHaveText("2번째 위치로 이동했습니다.");
  // Keyboard users move one step with the arrow keys on the focused grip.
  await page.getByRole("button", { name: "2번 페이지 순서 변경" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(pages.locator(".pdf-tool-page-meta span")).toHaveText(["원본 1페이지", "원본 2페이지 · +90°", "원본 4페이지"]);
  await expect(page.getByRole("button", { name: "3번 페이지 순서 변경" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(pages.locator(".pdf-tool-page-meta span")).toHaveText(["원본 1페이지", "원본 4페이지", "원본 2페이지 · +90°"]);
  await page.getByRole("checkbox", { name: "2번 페이지 선택", exact: true }).uncheck();
  await expect(pages.locator(".pdf-tool-page-meta span")).toHaveText(["원본 1페이지", "원본 4페이지", "원본 2페이지 · +90°"]);
  const pdf = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(pdf.name).toBe("worklens-pages.pdf");
  const output = await PDFDocument.load(pdf.bytes);
  expect(output.getPageCount()).toBe(3);
  expect(output.getPages().map((item) => item.getRotation().angle)).toEqual([0, 0, 90]);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("../../public/pdf.worker.mjs", import.meta.url).href;
  const task = pdfjs.getDocument({ data: pdf.bytes });
  try {
    const document = await task.promise;
    const labels: string[] = [];
    for (let index = 1; index <= document.numPages; index++) {
      const item = await document.getPage(index);
      labels.push((await item.getTextContent()).items.map((entry) => "str" in entry ? entry.str : "").join(" "));
      item.cleanup();
    }
    expect(labels).toEqual([expect.stringContaining("FIRST"), expect.stringContaining("FOURTH"), expect.stringContaining("SECOND")]);
    expect(labels.join(" ")).not.toContain("THIRD");
  } finally { await task.destroy(); }

  await chooseOption(page, page.getByLabel("형식"), "PNG");
  const pngZip = await downloadBytes(page, () => page.getByRole("button", { name: /다운로드/ }).click());
  expect(Object.keys(unzipSync(pngZip.bytes)).sort()).toEqual(["page-001.png", "page-002.png", "page-003.png"]);
  const pngPages = unzipSync(pngZip.bytes);
  const firstPng = await imageDimensions(page, pngPages["page-001.png"], "image/png");
  const rotatedPng = await imageDimensions(page, pngPages["page-003.png"], "image/png");
  expect(firstPng.width).toBeLessThan(firstPng.height);
  expect(rotatedPng.width).toBeGreaterThan(rotatedPng.height);
  await chooseOption(page, page.getByLabel("형식"), "JPG");
  const jpgZip = await downloadBytes(page, () => page.getByRole("button", { name: /다운로드/ }).click());
  expect(Object.keys(unzipSync(jpgZip.bytes)).sort()).toEqual(["page-001.jpg", "page-002.jpg", "page-003.jpg"]);
  const jpgPages = unzipSync(jpgZip.bytes);
  const rotatedJpg = await imageDimensions(page, jpgPages["page-003.jpg"], "image/jpeg");
  expect(rotatedJpg.width).toBeGreaterThan(rotatedJpg.height);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: "artifacts/tools-pdf-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "artifacts/tools-pdf-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  await page.getByRole("button", { name: "선택 삭제" }).click();
  // Removing every page returns the tool to its upload-only empty state.
  await expect(page.locator(".pdf-tool-editor, .pdf-tool-export")).toHaveCount(0);
  await expect(page.locator(".pdf-tool-upload").getByRole("button", { name: "PDF 추가" })).toBeVisible();
  expect(posted).toEqual([]);
  expect(errors).toEqual([]);
});

test("PDF export keeps the byte-identical text original when compression does not shrink it", async ({ page }) => {
  await page.goto("/");
  await navigateWorkspace(page, "PDF 도구");
  const document = await PDFDocument.create();
  const sheet = document.addPage([400, 600]);
  sheet.drawText("SMALL TEXT", { x: 30, y: 500, font: await document.embedFont(StandardFonts.Helvetica) });
  const original = await document.save();
  await page.getByLabel("PDF 파일 선택").setInputFiles({
    name: "small-text.pdf", mimeType: "application/pdf", buffer: Buffer.from(original),
  });
  await expect(page.locator(".pdf-tool-page")).toHaveCount(1);
  for (const level of ["balanced", "size"]) {
    await chooseOption(page, page.getByLabel("압축"), level === "balanced" ? "균형 (권장)" : "강력 압축");
    const result = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
    expect(result.bytes).toEqual(original);
    await expect(page.locator(".pdf-tool-export .pdf-tool-notice")).toContainText("파일 크기가 줄어들지 않아 원본을 유지합니다.");
    await expect(page.locator(".pdf-tool-export .pdf-tool-notice")).not.toContainText("감소");
  }
});

test("PDF compression is one level select defaulting to balanced, and each level keeps text", async ({ page }) => {
  await page.goto("/");
  await navigateWorkspace(page, "PDF 도구");
  const jpeg = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 512;
    const context = canvas.getContext("2d")!;
    const pixels = context.createImageData(512, 512);
    let state = 17;
    for (let index = 0; index < pixels.data.length; index += 4) {
      state = (state * 1664525 + 1013904223) >>> 0;
      pixels.data[index] = state & 255;
      pixels.data[index + 1] = (state >>> 8) & 255;
      pixels.data[index + 2] = (state >>> 16) & 255;
      pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.94).split(",")[1];
  }), "base64");
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  const sheet = source.addPage([600, 600]);
  for (let index = 0; index < 6; index++) {
    const embedded = await source.embedJpg(jpeg);
    sheet.drawImage(embedded, { x: 0, y: 0, width: 600, height: 600 });
  }
  sheet.drawText("KEEP TEXT", { x: 40, y: 40, font, size: 18 });
  const original = await source.save();
  await page.getByLabel("PDF 파일 선택").setInputFiles({
    name: "image-heavy.pdf", mimeType: "application/pdf", buffer: Buffer.from(original),
  });
  await expect(page.locator(".pdf-tool-page")).toHaveCount(1);
  await expect(page.locator(".pdf-tool-badge")).toHaveText(["페이지 1", "선택 0"]);
  await expect(page.getByText("PDF 작업공간", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/브라우저 작업공간|브라우저 내 처리|서버 전송 없음/)).toHaveCount(0);
  await expect(page.getByText("고급 옵션")).toHaveCount(0);
  await expect(page.getByRole("radio")).toHaveCount(0);
  const level = page.getByLabel("압축");
  await expect(level).toContainText("균형 (권장)");

  const textOf = async (bytes: Uint8Array) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("../../public/pdf.worker.mjs", import.meta.url).href;
    const task = pdfjs.getDocument({ data: bytes.slice() });
    try {
      return (await (await (await task.promise).getPage(1)).getTextContent()).items.map((item) => "str" in item ? item.str : "").join(" ");
    } finally { await task.destroy(); }
  };
  const save = async () => {
    const saved = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
    expect(Buffer.from(saved.bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    expect((await PDFDocument.load(saved.bytes)).getPageCount()).toBe(1);
    expect(await textOf(saved.bytes)).toContain("KEEP TEXT");
    return saved.bytes.length;
  };
  const balanced = await save();
  expect(balanced).toBeLessThan(original.length);
  await expect(page.locator(".pdf-tool-outcome")).toContainText(`약 ${Math.round((1 - balanced / original.length) * 100)}% 감소`);

  await chooseOption(page, level, "강력 압축");
  expect(await save()).toBeLessThan(balanced);

  await chooseOption(page, level, "고화질");
  expect(await save()).toBeGreaterThan(balanced);
  // Changing the level never touches the page workspace.
  await expect(page.locator(".pdf-tool-badge")).toHaveText(["페이지 1", "선택 0"]);
});

test("image editor chains resize, rotation, crop and merge with browser-only exports", async ({ page }) => {
  const posted: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST") posted.push(request.url()); });
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await navigateWorkspace(page, "이미지 도구");
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const context = canvas.getContext("2d")!;
    for (let y = 0; y < 600; y += 10) for (let x = 0; x < 800; x += 10) {
      context.fillStyle = `rgb(${(x * 37 + y * 19) % 255}, ${(x * 13 + y * 47) % 255}, ${(x * 7 + y * 11) % 255})`;
      context.fillRect(x, y, 10, 10);
    }
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.getByLabel("이미지 파일 선택").setInputFiles({
    name: "pattern.png", mimeType: "image/png", buffer: Buffer.from(image, "base64"),
  });
  await expect(page.locator(".image-tool-preview canvas")).toHaveAttribute("width", "800");
  await page.getByLabel("너비 px").fill("400");
  await page.getByLabel("너비 px").press("Tab");
  await expect(page.getByLabel("높이 px")).toHaveValue("300");
  await page.getByRole("button", { name: /오른쪽 90°/ }).click();
  await expect(page.locator(".image-tool-preview canvas")).toHaveAttribute("width", "300");
  await page.locator(".image-tool-control-section").filter({ has: page.getByRole("heading", { name: "자르기", exact: true }) }).getByRole("button", { name: "영역 지정" }).click();
  const target = page.locator(".image-tool-pointer");
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.25, box!.y + box!.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.75, box!.y + box!.height * 0.75, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".image-tool-preview canvas")).toHaveAttribute("width", "150");
  const jpg = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(await imageDimensions(page, jpg.bytes, "image/jpeg")).toEqual({ width: 150, height: 200 });
  await chooseOption(page, page.getByLabel("품질"), "고화질");
  const high = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  await chooseOption(page, page.getByLabel("품질"), "강력 압축");
  const small = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(small.bytes.length).toBeLessThan(high.bytes.length);
  await chooseOption(page, page.getByLabel("형식"), "WebP");
  await chooseOption(page, page.getByLabel("품질"), "고화질");
  const webpHigh = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  await chooseOption(page, page.getByLabel("품질"), "강력 압축");
  const webpSmall = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(webpSmall.bytes.length).toBeLessThan(webpHigh.bytes.length);
  await chooseOption(page, page.getByLabel("형식"), "PNG");
  const clean = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  await page.locator(".image-tool-control-section").filter({ has: page.getByRole("heading", { name: "모자이크", exact: true }) }).getByRole("button", { name: "영역 지정" }).click();
  const mosaicBox = await page.locator(".image-tool-pointer").boundingBox();
  await page.mouse.move(mosaicBox!.x + mosaicBox!.width * 0.25, mosaicBox!.y + mosaicBox!.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(mosaicBox!.x + mosaicBox!.width * 0.55, mosaicBox!.y + mosaicBox!.height * 0.55, { steps: 6 });
  await page.mouse.up();
  const mosaicked = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(await imagePixel(page, mosaicked.bytes, 10, 10)).toEqual(await imagePixel(page, clean.bytes, 10, 10));
  expect(await imagePixel(page, mosaicked.bytes, 60, 70)).not.toEqual(await imagePixel(page, clean.bytes, 60, 70));

  await page.getByLabel("이미지 파일 선택").setInputFiles({
    name: "second.png", mimeType: "image/png", buffer: Buffer.from(image, "base64"),
  });
  await expect(page.locator(".image-tool-file")).toHaveCount(2);
  await page.getByRole("checkbox", { name: "선택 이미지 한 장으로 결합", exact: true }).check();
  await chooseOption(page, page.getByLabel("형식"), "PNG");
  const merged = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(await imageDimensions(page, merged.bytes, "image/png")).toEqual({ width: 1600, height: 1600 });
  await page.getByRole("checkbox", { name: "선택 이미지 한 장으로 결합", exact: true }).uncheck();
  const zipped = await downloadBytes(page, () => page.getByRole("button", { name: /ZIP 다운로드/ }).click());
  expect(Object.keys(unzipSync(zipped.bytes)).sort()).toEqual(["pattern.png", "second.png"]);
  await chooseOption(page, page.getByLabel("형식"), "PDF");
  const pdf = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect((await PDFDocument.load(pdf.bytes)).getPageCount()).toBe(2);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: "artifacts/tools-image-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "artifacts/tools-image-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(posted).toEqual([]);
  expect(errors).toEqual([]);
});

test("image tool shows one upload zone when empty and a balanced three-column workspace once images exist", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await navigateWorkspace(page, "이미지 도구");
  const upload = page.locator(".image-tool-upload");
  await expect(upload).toBeVisible();
  await expect(page.locator(".image-tool-layout, .image-tool-export")).toHaveCount(0);
  await expect(page.locator(".image-tool-intro")).toHaveCount(0);
  const intro = (await page.locator(".image-tool").boundingBox())!;
  const zone = (await upload.boundingBox())!;
  expect(Math.abs(zone.x - intro.x)).toBeLessThan(1);
  expect(zone.height).toBeLessThan(215);
  await expect(upload.getByText(/끌어오세요/)).toHaveCount(0);
  const chooser = page.waitForEvent("filechooser");
  await upload.getByText("한 장씩 편집하거나 여러 이미지를 결합할 수 있습니다.").click();
  await chooser;
  expect(await upload.evaluate((node) => getComputedStyle(node).borderTopStyle)).toBe("dashed");

  const geometry = () => page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { top: rect.top, left: rect.left, width: rect.width, height: rect.height, right: rect.right };
    };
    const list = document.querySelector(".image-tool-file-list")!;
    return {
      files: box(".image-tool-library"), preview: box(".image-tool-stage"), adjust: box(".image-tool-controls"),
      layout: box(".image-tool-layout"), exported: box(".image-tool-export"),
      listScrolls: list.scrollHeight > list.clientHeight, overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    canvas.getContext("2d")!.fillRect(0, 0, 16, 16);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const add = (names: string[]) => page.getByLabel("이미지 파일 선택").setInputFiles(names.map((name) => ({ name, mimeType: "image/png", buffer: Buffer.from(png, "base64") })));
  await add(["a.png", "b.png", "c.png"]);
  await expect(page.locator(".image-tool-file")).toHaveCount(3);
  await expect(upload).toHaveCount(0);
  await expect(page.locator(".image-tool-library").getByRole("button", { name: "+ 이미지 추가" })).toBeVisible();
  const populated = await geometry();
  if (page.viewportSize()!.width > 1190) {
    // Settings are wider than the file list; the preview stays the widest column.
    expect(populated.adjust.width).toBeGreaterThan(populated.files.width);
    expect(populated.preview.width).toBeGreaterThan(populated.adjust.width);
    expect(populated.adjust.width).toBeGreaterThanOrEqual(280);
  }
  if (page.viewportSize()!.width > 760) expect(Math.abs(populated.files.height - populated.preview.height)).toBeLessThan(1);
  expect(Math.abs(populated.exported.left - populated.layout.left)).toBeLessThan(1);
  expect(Math.abs(populated.exported.right - populated.layout.right)).toBeLessThan(1);

  await add(Array.from({ length: 12 }, (_, index) => `more-${index + 1}.png`));
  await expect(page.locator(".image-tool-file")).toHaveCount(15);
  const long = await geometry();
  expect(long.listScrolls).toBe(true);
  expect(long.preview).toEqual(populated.preview);

  while (await page.locator(".image-tool-file").count()) await page.locator(".image-tool-order button").first().click();
  await expect(upload).toBeVisible();
  await expect(page.locator(".image-tool-layout")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await add(["a.png"]);
  const mobile = await geometry();
  expect(mobile.files.width).toBe(mobile.preview.width);
  expect(mobile.overflow).toBe(false);
});

test("image tool starts from the preview and exports in the dragged order with identity kept", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await navigateWorkspace(page, "이미지 도구");
  const upload = page.locator(".image-tool-upload");
  await expect(page.locator(".image-tool-library, .image-tool-stage, .image-tool-controls")).toHaveCount(0);
  await expect(page.getByText("추가된 이미지가 없습니다.")).toHaveCount(0);
  await expect(upload.getByText("이미지를 추가하세요", { exact: true })).toHaveCount(1);
  await expect(upload.getByText("한 장씩 편집하거나 여러 이미지를 결합할 수 있습니다.", { exact: true })).toBeVisible();
  await expect(upload.getByRole("button", { name: "이미지 추가" })).toBeVisible();
  const library = page.locator(".image-tool-library");

  // Solid swatches of distinct widths make every output order observable.
  const swatches = await page.evaluate(() => [["a.png", "#ff0000", 100], ["b.png", "#00ff00", 120], ["c.png", "#0000ff", 140]].map(([name, color, width]) => {
    const canvas = document.createElement("canvas");
    canvas.width = Number(width);
    canvas.height = 50;
    const context = canvas.getContext("2d")!;
    context.fillStyle = String(color);
    context.fillRect(0, 0, canvas.width, canvas.height);
    return { name: String(name), data: canvas.toDataURL("image/png").split(",")[1] };
  }));
  const fileChooser = page.waitForEvent("filechooser");
  await upload.getByRole("button", { name: "이미지 추가" }).click();
  await (await fileChooser).setFiles(swatches.map(({ name, data }) => ({ name, mimeType: "image/png", buffer: Buffer.from(data, "base64") })));
  const files = page.locator(".image-tool-file strong");
  await expect(files).toHaveText(["a.png", "b.png", "c.png"]);
  await expect(library.getByRole("button", { name: "+ 이미지 추가" })).toBeVisible();
  await expect(page.getByText(/별개입니다/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /(위로|아래로) 이동/ })).toHaveCount(0);

  await chooseOption(page, page.getByLabel("형식"), "JPG");
  await expect(page.getByLabel("품질")).toContainText("균형 (권장)");
  await expect(page.locator(".image-tool-export")).not.toContainText("%");

  await page.locator(".image-tool-file-open").filter({ hasText: "b.png" }).click();
  await page.getByRole("checkbox", { name: "a.png 선택", exact: true }).uncheck();
  await dragGrip(page, page.getByRole("button", { name: "c.png 순서 변경" }), page.locator(".image-tool-file").first(), "before", "y");
  await expect(files).toHaveText(["c.png", "a.png", "b.png"]);
  await expect(page.locator(".image-tool-file.is-current strong")).toHaveText("b.png");
  await expect(page.getByRole("checkbox", { name: "a.png 선택", exact: true })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "c.png 선택", exact: true })).toBeChecked();
  await page.getByRole("checkbox", { name: "a.png 선택", exact: true }).check();

  await page.getByRole("button", { name: "b.png 순서 변경" }).focus();
  await page.keyboard.press("ArrowUp");
  await expect(files).toHaveText(["c.png", "b.png", "a.png"]);
  await page.keyboard.press("ArrowDown");
  await expect(files).toHaveText(["c.png", "a.png", "b.png"]);
  await expect(page.locator(".tool-reorder-live")).toHaveText("3번째 위치로 이동했습니다.");

  await chooseOption(page, page.getByLabel("형식"), "PNG");
  const zipped = await downloadBytes(page, () => page.getByRole("button", { name: /ZIP 다운로드/ }).click());
  expect(Object.keys(unzipSync(zipped.bytes))).toEqual(["c.png", "a.png", "b.png"]);
  await chooseOption(page, page.getByLabel("형식"), "PDF");
  const pdf = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  const widths = (await PDFDocument.load(pdf.bytes)).getPages().map((item) => item.getWidth());
  expect(widths[0]).toBeGreaterThan(widths[2]);
  expect(widths[2]).toBeGreaterThan(widths[1]);
  await page.getByRole("checkbox", { name: "선택 이미지 한 장으로 결합", exact: true }).check();
  await chooseOption(page, page.getByLabel("형식"), "PNG");
  const merged = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  const { width, height } = await imageDimensions(page, merged.bytes, "image/png");
  expect(width).toBe(height);
  expect((await imagePixel(page, merged.bytes, Math.floor(width * 0.25), Math.floor(height * 0.25))).slice(0, 3)).toEqual([0, 0, 255]);
  expect((await imagePixel(page, merged.bytes, Math.floor(width * 0.75), Math.floor(height * 0.25))).slice(0, 3)).toEqual([255, 0, 0]);
  expect((await imagePixel(page, merged.bytes, Math.floor(width * 0.5), Math.floor(height * 0.75))).slice(0, 3)).toEqual([0, 255, 0]);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("mobile touch grip auto-scrolls a long image list and drops at the visible target", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Touch input is exercised through Chromium CDP.");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await navigateWorkspace(page, "이미지 도구");
  const data = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    canvas.getContext("2d")!.fillRect(0, 0, 16, 16);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.getByLabel("이미지 파일 선택").setInputFiles(Array.from({ length: 18 }, (_, i) => ({
    name: `touch-${String(i).padStart(2, "0")}.png`, mimeType: "image/png", buffer: Buffer.from(data, "base64"),
  })));
  await expect(page.getByText("이미지를 읽는 중…")).toHaveCount(0);
  const list = page.locator(".image-tool-file-list");
  await expect(page.locator(".image-tool-file")).toHaveCount(18);
  await list.evaluate((element) => { element.scrollIntoView({ block: "center", behavior: "instant" }); element.scrollTop = 0; });
  const grip = page.getByRole("button", { name: "touch-00.png 순서 변경" });
  const from = (await grip.boundingBox())!;
  const rect = (await list.boundingBox())!;
  const x = from.x + from.width / 2;
  const y = from.y + from.height / 2;
  const edgeY = Math.min(rect.y + rect.height - 24, 820);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const touch = async (type: "touchStart" | "touchMove" | "touchEnd", clientY: number) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: clientY, id: 1 }] });
  await touch("touchStart", y);
  await touch("touchMove", y + 8);
  await touch("touchMove", edgeY);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  await touch("touchEnd", edgeY);
  await expect(page.locator(".image-tool-file strong").first()).not.toHaveText("touch-00.png");
  await expect(page.locator(".tool-reorder-live")).toContainText("위치로 이동했습니다.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await cdp.detach();
});

test("large WebP sources use bounded previews without downscaling the export", async ({ page }) => {
  await page.goto("/");
  await navigateWorkspace(page, "이미지 도구");
  const webp = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2400;
    canvas.height = 1600;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#174c84";
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/webp").split(",")[1];
  }), "base64");
  await page.getByLabel("이미지 파일 선택").setInputFiles({
    name: "large.webp", mimeType: "image/webp", buffer: webp,
  });
  await expect(page.locator(".image-tool-dimensions")).toHaveText("2400 × 1600px");
  await expect(page.locator(".image-tool-preview canvas")).toHaveAttribute("width", "1440");
  await chooseOption(page, page.getByLabel("형식"), "PNG");
  await expect(page.getByLabel("품질")).toHaveCount(0);
  const exported = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(await imageDimensions(page, exported.bytes, "image/png")).toEqual({ width: 2400, height: 1600 });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("rejects oversized and excessive-page PDF imports before retaining them", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop");
  await page.goto("/");
  await navigateWorkspace(page, "PDF 도구");
  await expect(page.locator(".pdf-tool-upload")).toBeVisible();
  await page.evaluate(() => {
    const chunk = new Uint8Array(1024 * 1024);
    const file = new File(Array(101).fill(chunk), "too-big.pdf", { type: "application/pdf" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    document.querySelector(".pdf-tool-upload")!.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
  });
  await expect(page.locator(".pdf-tool-notice-error")).toContainText("100.00 MB 이하");
  await expect(page.getByLabel("불러온 PDF")).toHaveCount(0);

  const pdfDocument = await PDFDocument.create();
  for (let pageNumber = 0; pageNumber < 1001; pageNumber++) pdfDocument.addPage([72, 72]);
  await page.getByLabel("PDF 파일 선택").setInputFiles({
    name: "too-many-pages.pdf", mimeType: "application/pdf", buffer: Buffer.from(await pdfDocument.save()),
  });
  await expect(page.locator(".pdf-tool-notice-error")).toContainText("최대 1000페이지");
  await expect(page.getByLabel("불러온 PDF")).toHaveCount(0);
});


test("document review hides execution until a workspace file is added", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await navigateWorkspace(page, "법령");
  await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
  const form = page.getByRole("form", { name: /^(종합 리서치|문서 검토) 입력$/ });
  await expect(form.locator(".legal-research-description")).toHaveText("질문이나 상황을 바탕으로 관련 법령·판례·결정례를 함께 조사합니다.");
  await chooseOption(page, form.getByLabel("리서치 유형"), researchTaskLabels.document_review);
  await form.getByRole("radio", { name: "작업 파일", exact: true }).check();
  await expect(form.getByRole("button", { name: "실행", exact: true })).toHaveCount(0);
  await expect(form.getByRole("button", { name: "파일 추가", exact: true })).toBeVisible();
  await expect(form).not.toContainText("PDF · DOCX · PPTX · XLSX · CSV");
  await expect(form).not.toContainText("작업 파일의 분석된 텍스트를 사용하며, 한 번에 한 문서를 검토합니다.");
  await expect(form.locator(".research-result-display h2")).toHaveCount(0);
  const sourceRow = form.locator(".research-source-row");
  await expect(sourceRow.getByText("출처 표시", { exact: true })).toBeVisible();
  await expect(sourceRow.getByRole("switch", { name: "출처 표시", exact: true })).toBeVisible();
  const sourceBoxes = await Promise.all([sourceRow.locator("label").boundingBox(), sourceRow.getByRole("switch").boundingBox()]);
  expect(Math.abs(sourceBoxes[0]!.y + sourceBoxes[0]!.height / 2 - sourceBoxes[1]!.y - sourceBoxes[1]!.height / 2)).toBeLessThanOrEqual(2);
  await expect(form).not.toContainText("조회 범위와 법적 판단은 바뀌지 않습니다.");
  await expect(form).not.toContainText("이 화면에서 변경한 값은 이번 실행에만 적용됩니다.");
  await expect(page.locator(".research-review-guide li")).toHaveText([
    "문서 준비파일을 선택하거나 내용을 직접 입력합니다.",
    "실행검토할 내용을 확인하고 실행합니다.",
    "근거 확인관련 법령·판례와 상세 근거를 확인합니다.",
  ]);
  expect((await form.locator(".research-file-workarea").boundingBox())!.height).toBeLessThan(220);

  await form.getByRole("radio", { name: "직접 입력", exact: true }).check();
  await expect(form.getByRole("button", { name: "실행", exact: true })).toBeVisible();
  await expect(form.getByRole("button", { name: "실행", exact: true })).toBeDisabled();
  await form.getByRole("radio", { name: "작업 파일", exact: true }).check();
  await form.getByLabel("검토할 작업 파일 추가").setInputFiles({
    name: "review-ui.pdf", mimeType: "application/pdf",
    buffer: Buffer.from(await createPdf(["Document review workspace UI"])),
  });
  await expect(form.locator("#research-file")).toContainText("review-ui.pdf");
  await expect(form.locator(".research-upload-intro")).toHaveCount(0);
  expect((await form.locator(".research-file-workarea").boundingBox())!.height).toBeLessThan(180);
  await expect(form.getByRole("button", { name: "실행", exact: true })).toBeVisible();
  await expect(form.getByRole("button", { name: "실행", exact: true })).toBeEnabled();
  await expect(form.getByRole("button", { name: "파일 추가", exact: true })).toBeVisible();
});
