import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createPdf } from "../fixtures";
import { fullResearchFixture } from "../fixtures/research";

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
    await page.getByRole("button", { name: "PDF 도구" }).click();
    await expect(page.locator(".context-bar h1")).toHaveText("PDF 도구");
    await expect(page.getByRole("heading", { name: "작업 파일" })).toHaveCount(0);
    await expect(page.locator(".file-row")).toHaveCount(0);
    await page.getByRole("button", { name: "이미지 도구" }).click();
    await expect(page.locator(".context-bar h1")).toHaveText("이미지 도구");
    await expect(page.locator(".file-row")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "분석", exact: true }).click();
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
  await page.getByRole("button", { name: "법령", exact: true }).click();
  const input = page.getByRole("searchbox");
  await expect(input).toHaveAttribute("placeholder", "법령명 또는 조문 검색 (예: 민법 제750조)");
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

  await page.getByRole("button", { name: "검증·분석", exact: true }).click();
  await page.getByRole("group", { name: "검증·분석 유형" }).getByRole("button", { name: "판례 유효성" }).click();
  await page.getByLabel("사건번호").fill("2013 다 61381");
  await page.locator(".legal-analysis-form").getByRole("button", { name: "확인" }).click();
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

  await expect(page.locator(".rail-group-label").filter({ hasText: "RESEARCH" })).toBeVisible();
  await page.getByRole("button", { name: "법령", exact: true }).click();
  await expect(page.getByRole("button", { name: "법령", exact: true })).toHaveAttribute("aria-current", "page");
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
  await page.getByRole("button", { name: "분석", exact: true }).click();
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
  await page.getByRole("button", { name: "법령", exact: true }).click();
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
  await page.getByRole("button", { name: "법령", exact: true }).click();
  await page.getByRole("button", { name: "판례·결정례", exact: true }).click();
  await expect(page.getByRole("combobox", { name: /자료 유형/ })).toHaveValue("precedent");
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
  await page.getByRole("combobox", { name: /자료 유형/ }).selectOption("constitutional");
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
  await page.getByRole("button", { name: "법령", exact: true }).click();
  await page.getByRole("searchbox").fill("근로기준법");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await page.locator(".law-search-list button").first().click();
  await page.getByRole("navigation", { name: "조문 목차" }).getByRole("button", { name: "제74조 임산부의 보호" }).click();
  await expect(page.locator(".law-detail-raw")).toContainText("조문 본문");
  await page.getByRole("button", { name: "관련 판례·결정례" }).click();
  await expect(page.getByRole("combobox", { name: /자료 유형/ })).toHaveValue("precedent");
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
  await page.getByRole("button", { name: "법령", exact: true }).click();
  await page.getByRole("searchbox").fill("근로기준법");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await page.locator(".law-search-list button").first().click();
  const article = page.locator(".law-detail-raw").first();
  await expect(article).toContainText("정당한 이유 없이 해고하지 못한다.");
  expect(await article.textContent()).toContain("제23조(해고 등의 제한)\n① 사용자는");
  await expect(article).toContainText("<img src=x onerror=");
  await expectClean();

  await page.getByRole("button", { name: "판례·결정례", exact: true }).click();
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

  await page.getByRole("button", { name: "검증·분석", exact: true }).click();
  await page.getByRole("group", { name: "검증·분석 유형" }).getByRole("button", { name: "시점별 적용 법령" }).click();
  await page.locator("#analysis-applicable-law").fill("근로기준법");
  await page.locator("#analysis-applicable-jo").fill("제23조");
  await page.locator("#analysis-applicable-date").fill("2023-05-10");
  await page.locator(".legal-analysis-form:visible button[type='submit']").click();
  await expect(page.locator(".legal-analysis-output")).toContainText("근로기준법 [시행 2023.04.04]");
  await expectClean();

  await page.locator(".law-view-tabs").getByRole("button", { name: "종합 리서치" }).click();
  await page.getByRole("form", { name: "종합 리서치 입력" }).getByLabel("질문 또는 검색어").fill("해고");
  await page.getByRole("form", { name: "종합 리서치 입력" }).getByRole("button", { name: "리서치 실행" }).click();
  const lines = page.locator(".legal-research .legal-analysis-lines").first();
  await expect(lines).toContainText("근로기준법 제24조");
  expect(await lines.textContent()).toContain("근로기준법 제23조\n근로기준법 제24조");
  await expectClean();
  await expect(page.locator(".legal-research .legal-analysis-output")).toContainText("본문 검색으로 찾은 결과입니다.");
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
  await page.getByRole("button", { name: "법령", exact: true }).click();
  await page.getByRole("button", { name: "검증·분석", exact: true }).click();
  const modes = page.getByRole("group", { name: "검증·분석 유형" });
  await expect(modes.getByRole("button")).toHaveText(["인용 검증", "판례 유효성", "시점별 적용 법령", "조문 영향도"]);

  const text = "민법 제750조와 형법 제9999조, 같은 법 시행규칙 제2조를 인용한다.";
  await expect(page.getByRole("button", { name: "인용 검증", exact: true }).last()).toBeDisabled();
  await page.getByLabel("검증할 문장을 입력하세요.").fill(text);
  await expect(page.getByText(`${text.length} / 5,000자`)).toBeVisible();
  await page.locator(".legal-analysis-form").getByRole("button", { name: "인용 검증" }).click();
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

  await modes.getByRole("button", { name: "판례 유효성" }).click();
  await page.getByLabel("사건번호").fill("2013다61381");
  await page.locator(".legal-analysis-form").getByRole("button", { name: "확인" }).click();
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

  await modes.getByRole("button", { name: "시점별 적용 법령" }).click();
  const analysisForm = page.locator(".legal-analysis-form");
  await analysisForm.getByLabel("법령명", { exact: true }).fill("도로교통법");
  await analysisForm.getByLabel("조문 (선택)").fill("44");
  const applicableSubmit = page.locator(".legal-analysis-form").getByRole("button", { name: "적용 법령 확인" });
  await expect(applicableSubmit).toBeDisabled();
  await analysisForm.getByLabel("기준일").fill("2023-05-10");
  await applicableSubmit.click();
  await expect(page.locator(".legal-analysis-title")).toHaveText("행위시법 판단: 도로교통법 · 기준일 2023.05.10");
  await expect(page.locator(".legal-analysis-output")).toContainText("현행과 비교: △ 변경됨");

  await modes.getByRole("button", { name: "조문 영향도" }).click();
  await analysisForm.getByLabel("법령명", { exact: true }).fill("민법");
  await analysisForm.getByLabel("조문", { exact: true }).fill("제103조");
  await page.locator(".legal-analysis-form").getByRole("button", { name: "영향도 확인" }).click();
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
  await modes.getByRole("button", { name: "인용 검증" }).click();
  await expect(citations).toHaveCount(3);
  expect(requests).toHaveLength(5);

  await page.setViewportSize({ width: 390, height: 844 });
  for (const mode of ["인용 검증", "판례 유효성", "시점별 적용 법령", "조문 영향도"]) {
    await modes.getByRole("button", { name: mode }).click();
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
  await page.getByRole("button", { name: "법령", exact: true }).click();
  await page.getByRole("button", { name: "검증·분석", exact: true }).click();
  const modes = page.getByRole("group", { name: "검증·분석 유형" });
  const input = "오늘은 맑습니다.";
  await page.getByLabel("검증할 문장을 입력하세요.").fill(input);
  await page.locator(".legal-analysis-form").getByRole("button", { name: "인용 검증" }).click();
  const output = page.locator(".legal-analysis-output");
  await expect(output.locator(".legal-analysis-overall")).toHaveText("검증할 법령·판례 인용을 찾지 못했습니다.");
  await expect(output).toContainText("법령명, 조문 또는 사건번호가 포함된 문장으로 다시 입력해 주세요.");
  await expect(output.locator(".legal-analysis-citations")).toHaveCount(0);
  await expect(output).not.toContainText("[NO_CITATIONS_FOUND]");
  await expect(output).not.toContainText(input);
  await expect(output.locator(".law-detail-source")).toHaveCount(0);
  await expect(page.getByLabel("검증할 문장을 입력하세요.")).toHaveValue(input);
  await modes.getByRole("button", { name: "판례 유효성" }).click();
  await page.getByLabel("사건번호").fill("2099다99999");
  await page.locator(".legal-analysis-form").getByRole("button", { name: "확인" }).click();
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
  await page.getByRole("button", { name: "법령", exact: true }).click();
  await page.getByRole("button", { name: "검증·분석", exact: true }).click();
  await page.getByLabel("검증할 문장을 입력하세요.").fill(input);
  await page.locator(".legal-analysis-form").getByRole("button", { name: "인용 검증" }).click();

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
  await page.getByRole("button", { name: "법령", exact: true }).click();
  await page.getByRole("button", { name: "검증·분석", exact: true }).click();
  await page.getByRole("group", { name: "검증·분석 유형" }).getByRole("button", { name: "시점별 적용 법령" }).click();
  const form = page.locator(".legal-analysis-form");
  await form.getByLabel("법령명", { exact: true }).fill("도로교통법");
  await form.getByLabel("조문 (선택)").fill("제44조");
  await form.getByLabel("기준일").fill("2023-05-10");
  const run = form.getByRole("button", { name: "적용 법령 확인" });
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
  await page.getByRole("button", { name: "법령", exact: true }).click();
  await page.getByRole("searchbox").fill("근로기준법");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await page.locator(".law-search-list button").first().click();
  await page.getByRole("navigation", { name: "조문 목차" }).getByRole("button", { name: "제74조 임산부의 보호" }).click();
  await expect(page.locator(".law-detail-raw")).toContainText("조문 본문");

  await page.getByRole("button", { name: "시점별 적용 법령" }).click();
  await expect(page.getByRole("button", { name: "시점별 적용 법령", pressed: true })).toBeVisible();
  // The official name from the article text wins over the search-result label.
  await expect(page.locator("#analysis-applicable-law")).toHaveValue("근로기준법");
  await expect(page.locator("#analysis-applicable-jo")).toHaveValue("제74조");
  await expect(page.locator("#analysis-applicable-date")).toHaveValue("");
  await expect(page.locator("#analysis-applicable-date")).toBeFocused();
  expect(analysis).toEqual([]);
  await page.locator("#analysis-applicable-date").fill("2024-01-15");
  await page.locator(".legal-analysis-form").getByRole("button", { name: "적용 법령 확인" }).click();
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

  await page.locator(".law-view-switch").getByRole("button", { name: "판례·결정례" }).click();
  await page.getByLabel("검색어", { exact: true }).fill("손해배상");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await page.getByRole("button", { name: /손해배상\(기\)/ }).click();
  await expect(page.locator(".decision-detail-raw")).toContainText("판결문 원문");
  await page.getByRole("button", { name: "판례 유효성 확인" }).click();
  await expect(page.getByRole("button", { name: "판례 유효성", pressed: true })).toBeVisible();
  await expect(page.locator("#analysis-case")).toHaveValue("2013다61381");
  await expect(page.locator(".legal-analysis-verdict")).toBeVisible();
  expect(analysis.at(-1)).toEqual({ mode: "cite_check", caseNumber: "2013다61381" });
  await page.getByRole("button", { name: "← 판례 상세로" }).click();
  await expect(page.locator(".decision-detail-raw")).toContainText("판결문 원문");
  await expect(page.getByRole("button", { name: "판례 유효성 확인" })).toBeFocused();

  await page.locator(".law-view-switch").getByRole("button", { name: "법령 검색" }).click();
  await expect(page.locator(".law-detail-raw")).toContainText("조문 본문");
  expect(lawCalls).toEqual([{ query: "근로기준법" }, { mst: "283457" }, { mst: "283457", jo: "제74조" }]);
  expect(decisionCalls).toEqual([{ domain: "precedent", query: "손해배상", page: 1 }, { domain: "precedent", id: "609561" }]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".law-view-switch").getByRole("button", { name: "검증·분석" }).click();
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
  await page.getByRole("button", { name: "법령", exact: true }).click();
  await page.locator(".law-view-tabs").getByRole("button", { name: "종합 리서치" }).click();
  const form = page.getByRole("form", { name: "종합 리서치 입력" });
  const task = form.getByLabel("리서치 유형");
  await expect(task.locator("option")).toHaveText(["종합 리서치", "법체계 확인", "처분·허가 근거", "분쟁·불복 자료", "개정 추적", "조례 비교", "절차·서식", "문서 검토"]);
  await expect(page.getByRole("heading", { name: "리서치 결과" })).toHaveCount(0);

  const query = form.getByLabel("질문 또는 검색어");
  await query.fill("직장 내 괴롭힘 판단 기준");
  await form.getByRole("button", { name: "리서치 실행" }).click();
  await expect(page.locator(".legal-analysis-result [role='alert']")).toContainText("일시적으로 응답하지 않습니다");
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByRole("heading", { name: "리서치 결과" })).toBeVisible();
  await expect(page.locator(".legal-research-partial")).toHaveText("일부 자료를 불러오지 못했습니다. 확인된 자료를 기준으로 결과를 표시합니다.");
  await expect(page.locator("[data-status='failed']")).toContainText("이 자료를 불러오지 못했습니다.");
  await expect(page.locator(".legal-analysis-section.is-unavailable")).toHaveCount(1);
  await expect(page.locator(".legal-analysis-note")).toContainText("조회 경로: 법제처 국가법령정보센터");
  expect(bodies).toEqual([{ task: "full_research", query: "직장 내 괴롭힘 판단 기준" }, { task: "full_research", query: "직장 내 괴롭힘 판단 기준" }]);

  await task.selectOption("dispute_prep");
  await expect(page.getByRole("heading", { name: "리서치 결과" })).toHaveCount(0);
  await form.getByLabel("분야").selectOption("labor");
  await form.getByRole("button", { name: "리서치 실행" }).click();
  await expect(page.getByRole("heading", { name: "리서치 결과" })).toBeVisible();

  await task.selectOption("amendment_track");
  await expect(form.getByLabel("분야")).toHaveCount(0);
  await expect(form.getByLabel("시작일")).toHaveCount(0);
  await form.getByLabel("추적 방식").selectOption("time_travel");
  await form.getByLabel("시작일").fill("2026-01-02");
  await form.getByLabel("종료일").fill("2026-01-01");
  await expect(form.getByRole("alert")).toHaveText("시작일은 종료일보다 늦을 수 없습니다.");
  await expect(form.getByRole("button", { name: "리서치 실행" })).toBeDisabled();
  await form.getByLabel("시작일").fill("2022-01-01");
  await expect(form.getByLabel("전체 개정 이력 포함")).not.toBeChecked();
  await form.getByRole("button", { name: "리서치 실행" }).click();
  await expect(page.getByRole("heading", { name: "리서치 결과" })).toBeVisible();

  await task.selectOption("law_system");
  await form.getByLabel("관련 조문 (선택)").fill("38, 제39조");
  await form.getByRole("button", { name: "리서치 실행" }).click();
  await task.selectOption("ordinance_compare");
  await expect(form.getByRole("button", { name: "리서치 실행" })).toBeDisabled();
  await expect(form).toContainText("서로 다른 비교 지역 두 곳");
  await form.getByLabel("비교 지역 1").fill("인천광역시");
  await expect(form.getByRole("button", { name: "리서치 실행" })).toBeDisabled();
  await form.getByLabel("비교 지역 2").fill("서울특별시");
  await form.getByLabel("상위 법령 (선택)").fill("주차장법");
  await form.getByRole("button", { name: "리서치 실행" }).click();
  for (const value of ["action_basis", "procedure_detail"]) {
    await task.selectOption(value);
    await form.getByRole("button", { name: "리서치 실행" }).click();
    await expect(page.getByRole("heading", { name: "리서치 결과" })).toBeVisible();
  }

  await task.selectOption("document_review");
  await expect(form.getByLabel("질문 또는 검색어")).toHaveCount(0);
  const documentText = form.getByLabel("검토할 문서 내용");
  await expect(form).not.toContainText("Korean Law MCP");
  await expect(form.getByRole("button", { name: "문서 검토" })).toBeDisabled();
  const sample = "제1조 갑은 계약 체결 즉시 대금 전액을 지급한다.\n제2조 을은 어떠한 경우에도 계약을 해지할 수 없다.";
  await documentText.fill(sample);
  await form.getByRole("button", { name: "문서 검토" }).click();
  await expect(page.getByRole("heading", { name: "검토 결과" })).toBeVisible();
  const review = page.locator(".contract-review");
  await expect(review).toContainText("서비스 이용계약");
  await expect(review).toContainText("사업자 간");
  await expect(review).toContainText("2026년 1월 1일부터 2026년 12월 31일까지");
  const clause = review.locator(".contract-review-clause");
  await expect(clause.getByRole("heading", { level: 3 })).toHaveText("제2조");
  await expect(clause).toContainText("중도해지 제한");
  await expect(clause).toContainText("을은 어떠한 경우에도 계약을 해지할 수 없다.");
  await expect(clause.locator("summary")).toContainText("약관의 규제에 관한 법률 제9조 (계약의 해제ㆍ해지)");
  await expect(clause).toContainText("이 계약이 약관에 해당하는 경우에 적용됩니다.");
  await expect(clause).toContainText("현재 검색 범위에서 직접 관련성이 높은 판례를 확인하지 못했습니다.");
  await expect(review).not.toContainText(/search_|get_|body_search|full=/u);

  expect(bodies.slice(2)).toEqual([
    { task: "dispute_prep", query: "직장 내 괴롭힘 판단 기준", domain: "labor" },
    { task: "amendment_track", query: "직장 내 괴롭힘 판단 기준", scenario: "time_travel", fromDate: "2022-01-01", toDate: "2026-01-01" },
    { task: "law_system", query: "직장 내 괴롭힘 판단 기준", articles: ["제38조", "제39조"] },
    { task: "ordinance_compare", query: "직장 내 괴롭힘 판단 기준\n비교 대상 지역: 인천광역시 / 서울특별시", parentLaw: "주차장법" },
    { task: "action_basis", query: "직장 내 괴롭힘 판단 기준" },
    { task: "procedure_detail", query: "직장 내 괴롭힘 판단 기준" },
    { task: "document_review", text: sample },
  ]);

  const descriptions: string[] = [];
  const examples: string[] = [];
  for (const value of ["full_research", "law_system", "action_basis", "dispute_prep", "amendment_track", "ordinance_compare", "procedure_detail", "document_review"]) {
    await task.selectOption(value);
    descriptions.push((await form.locator(".legal-research-description").textContent())!.trim());
    examples.push((await (value === "document_review" ? documentText : query).getAttribute("placeholder"))!);
  }
  expect(new Set(descriptions).size).toBe(8);
  expect(new Set(examples).size).toBe(8);

  // Previous task results and other research views survive switching.
  await task.selectOption("full_research");
  await expect(page.locator(".legal-research-partial")).toBeVisible();
  await page.locator(".law-view-tabs").getByRole("button", { name: "법령 검색" }).click();
  await page.locator(".law-view-tabs").getByRole("button", { name: "종합 리서치" }).click();
  await expect(query).toHaveValue("직장 내 괴롭힘 판단 기준");

  await page.setViewportSize({ width: 390, height: 844 });
  await task.selectOption("document_review");
  await documentText.fill(`${sample}\n`.repeat(200));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(outside).toEqual([]);
  expect(errors).toEqual([]);
});

test("RESEARCH ordinance comparison needs two regions and compares only sourced pairs", async ({ page }) => {
  const searches: string[] = [];
  await page.route("**/api/law/research", (route) => {
    const body = route.request().postDataJSON() as { task: string; query: string; parentLaw?: string };
    searches.push(body.query);
    const pair = !body.query.startsWith("한쪽만");
    const article = (law: string, content: string) =>
      `${law}\n   제0012조 (주차요금 감면)\n   제12조(주차요금 감면)\n ${content}\n   시행: 2025.01.01 | 지방자치단체`;
    const text = `═══ 조례 비교 ═══\n▶ 자치법규 조회\n지능형 법령검색 결과 (법령조문, ${pair ? 2 : 1}건):\n\n${article("인천광역시 주차장 조례", "장애인 주차요금 50퍼센트를 감면한다.")}`
      + (pair ? `\n\n${article("서울특별시 주차장 조례", "장애인 주차요금 80퍼센트를 감면한다.")}` : "");
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, task: body.task, text, markers: [] } }) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "법령", exact: true }).click();
  await page.locator(".law-view-tabs").getByRole("button", { name: "종합 리서치" }).click();
  const form = page.getByRole("form", { name: "종합 리서치 입력" });
  await form.getByLabel("리서치 유형").selectOption("ordinance_compare");
  await form.getByLabel("질문 또는 검색어").fill("장애인 주차요금 감면");
  await form.getByLabel("비교 지역 1").fill("인천광역시");
  await expect(form.getByRole("button", { name: "리서치 실행" })).toBeDisabled();
  await form.getByLabel("비교 지역 2").fill("인천광역시");
  await expect(form).toContainText("서로 다른 비교 지역 두 곳");
  await form.getByLabel("비교 지역 2").fill("서울특별시");
  await form.getByLabel("상위 법령 (선택)").fill("주차장법");
  await form.getByRole("button", { name: "리서치 실행" }).click();
  const comparison = page.locator(".research-comparison");
  await expect(comparison).toBeVisible();
  await expect(comparison.locator("tbody tr")).toHaveCount(1);
  await expect(comparison.locator("tbody tr")).toContainText("50퍼센트");
  await expect(comparison.locator("tbody tr")).toContainText("80퍼센트");
  await expect(page.locator(".research-overview")).toContainText("장애인 주차요금 감면");
  await expect(page.locator(".research-overview")).not.toContainText("비교 대상 지역:");
  await form.getByLabel("질문 또는 검색어").fill("한쪽만");
  await form.getByRole("button", { name: "리서치 실행" }).click();
  await expect(comparison).toHaveCount(0);
  await expect(page.getByRole("region", { name: "조례 대조" })).toContainText("함께 확인되지 않아");
  expect(searches).toEqual([
    "장애인 주차요금 감면\n비교 대상 지역: 인천광역시 / 서울특별시",
    "한쪽만\n비교 대상 지역: 인천광역시 / 서울특별시",
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("RESEARCH separates a verified article from search candidates and hides internal guidance", async ({ page }) => {
  await page.route("**/api/law/research", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
    found: true, task: "full_research", text: fullResearchFixture(), markers: ["NOT_FOUND"],
    interpretation: { original: "직장 내 괴롭힘 판단 기준", situation: "직장에서 괴롭힘 문제를 겪는 상황으로 이해했습니다.", issues: ["직장 내 괴롭힘"], searchTerms: ["직장 내 괴롭힘"], confidence: "high" },
    evidence: { status: "matched", articles: [{ law: "근로기준법", jo: "제76조의2" }], precedents: [] },
  } }) }));
  await page.goto("/");
  await page.getByRole("button", { name: "법령", exact: true }).click();
  await page.locator(".law-view-tabs").getByRole("button", { name: "종합 리서치" }).click();
  const form = page.getByRole("form", { name: "종합 리서치 입력" });
  await form.getByLabel("질문 또는 검색어").fill("직장 내 괴롭힘 판단 기준");
  await form.getByRole("button", { name: "리서치 실행" }).click();
  const output = page.locator(".legal-research .legal-analysis-output");
  await expect(output.locator(".research-overview")).toContainText("직장에서 괴롭힘 문제를 겪는 상황");
  await expect(output.locator(".research-overview")).toContainText("직장 내 괴롭힘 판단 기준");
  await expect(output.getByRole("heading", { name: "확인한 근거" })).toBeVisible();
  await expect(output.locator(".research-selected")).toContainText("근로기준법 제76조의2");
  await expect(output.locator(".research-selected")).toContainText("사용자 또는 근로자는 직장에서의 지위를 이용하여");
  await expect(output.locator("[data-kind='law_articles'] > .research-hits > li")).toHaveCount(3);
  await expect(output.locator("[data-kind='decision_search'] h3")).toContainText("후보 5건");
  await expect(output.locator("[data-status='not_found']")).toContainText("검색된 관련 자료가 없습니다.");
  await expect(output.locator(".legal-research-partial")).toContainText("일부 자료 조회가 완료되지 않아");
  const toc = output.locator("details[data-kind='law_toc']");
  await expect(toc).not.toHaveAttribute("open", "");
  await toc.locator("summary").click();
  await expect(toc.locator("pre")).toContainText("제132조 조문 제목 132");
  await output.locator(".research-source summary").click();
  await expect(output.locator(".research-source pre")).not.toContainText(/get_law_text|검색 보정 시도|법제처 API는 공백/u);
  await expect(output).not.toContainText("searchTerms");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("law views use the shared tool content width with one left and right edge", async ({ page }) => {
  await page.route("**/api/law", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, laws: [{ name: "근로기준법", mst: "283457", status: "현행" }] } }) }));
  await page.route("**/api/law/text", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, mode: "article", name: "근로기준법", text: "제74조(임산부의 보호)\n① 조문 본문" } }) }));
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "PDF 도구" }).click();
    const tool = (await page.locator(".pdf-tool").boundingBox())!;
    await page.getByRole("button", { name: "법령", exact: true }).click();
    await page.locator(".law-view-switch").getByRole("button", { name: "법령 검색" }).click();
    const research = (await page.locator(".law-research").boundingBox())!;
    expect(Math.abs(research.x - tool.x)).toBeLessThan(1);
    expect(Math.abs(research.width - tool.width)).toBeLessThan(1);
    const input = page.getByRole("searchbox");
    if (!(await page.locator(".law-search-list").count())) {
      await input.fill("근로기준법");
      await page.getByRole("button", { name: "검색", exact: true }).click();
    }
    await expect(page.getByRole("heading", { name: "검색 결과 · 1건" })).toBeVisible();
    for (const selector of [".law-view-band", ".law-search-row", "#law-results-heading", ".law-search-list"]) {
      expect(Math.abs((await page.locator(selector).boundingBox())!.x - research.x), selector).toBeLessThan(1);
    }
    for (const selector of [".law-search-row", ".law-search-list"]) {
      const box = (await page.locator(selector).boundingBox())!;
      expect(Math.abs(box.x + box.width - (research.x + research.width)), selector).toBeLessThan(1);
    }
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
    const selectors = [".tool-intro h2", ".tool-intro p", ".pdf-tool-upload, .image-tool-upload"];
    const boxes = selectors.map((selector) => {
      const box = root.querySelector(selector)!.getBoundingClientRect();
      return { x: box.x, y: box.y - top };
    });
    return { boxes, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }, { width: 900, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "PDF 도구" }).click();
    await expect(page.locator(".pdf-tool")).toBeVisible();
    await page.evaluate(() => scrollTo(0, 0));
    // Empty tools show only title, description and one upload zone.
    await expect(page.locator(".tool-eyebrow")).toHaveCount(0);
    await expect(page.locator(".pdf-tool-editor, .pdf-tool-export, .pdf-tool-badge")).toHaveCount(0);
    await expect(page.locator(".pdf-tool-upload").getByRole("button", { name: "PDF 추가" })).toBeVisible();
    await expect(page.getByText("PDF 파일 선택", { exact: true })).toHaveCount(0);
    const pdf = await geometry();
    await page.getByRole("button", { name: "이미지 도구" }).click();
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
  await page.getByRole("button", { name: "PDF 도구" }).click();
  await page.getByLabel("PDF 파일 선택").setInputFiles({ name: "one.pdf", mimeType: "application/pdf", buffer: Buffer.from(await createPdf(["ONE"])) });
  await expect(page.locator(".pdf-tool-page")).toHaveCount(1);
  await expect(page.locator(".pdf-tool-upload").getByRole("button", { name: "PDF 추가" })).toBeVisible();
  const toolbar = page.locator(".pdf-tool-export");
  await expect(toolbar).toContainText("1페이지");
  await expect(toolbar.getByLabel("형식").locator("option")).toHaveText(["PDF", "JPG", "PNG"]);
  await expect(toolbar.getByLabel("압축")).toHaveValue("balanced");
  await toolbar.getByLabel("형식").selectOption("png");
  await expect(toolbar.getByLabel("압축")).toHaveCount(0);
  await toolbar.getByLabel("형식").selectOption("pdf");
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width >= 1366) {
      const rows = await toolbar.locator(".tool-export-settings select, .tool-export-button").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().bottom));
      expect(Math.max(...rows) - Math.min(...rows)).toBeLessThan(3);
    } else {
      const rows = await toolbar.locator(".tool-export-settings > label, .pdf-tool-export-actions").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().y));
      expect(rows.every((row, index) => index === 0 || row > rows[index - 1])).toBe(true);
    }
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
  await page.getByRole("button", { name: "PDF 도구" }).click();
  await page.getByLabel("PDF 파일 선택").setInputFiles({
    name: "composed.pdf", mimeType: "application/pdf",
    buffer: Buffer.from(await createPdf(["FIRST", "SECOND", "THIRD", "FOURTH"])),
  });
  const pages = page.locator(".pdf-tool-page");
  await expect(pages).toHaveCount(4);
  await page.getByLabel("2번 페이지 선택").check();
  await page.getByRole("button", { name: /오른쪽 90°/ }).click();
  await page.getByLabel("2번 페이지 선택").uncheck();
  await page.getByLabel("3번 페이지 선택").check();
  await page.getByRole("button", { name: "선택 삭제" }).click();
  await expect(pages).toHaveCount(3);
  await expect(page.getByRole("button", { name: /(왼쪽|오른쪽|위로|아래로)으로? 이동/ })).toHaveCount(0);
  // Selection follows the page, not the slot it occupied.
  await page.getByLabel("3번 페이지 선택").check();
  await dragGrip(page, page.getByRole("button", { name: "3번 페이지 순서 변경" }), pages.nth(1), "before", "x");
  await expect(pages.locator(".pdf-tool-page-meta span")).toHaveText(["원본 1페이지", "원본 4페이지", "원본 2페이지 · +90°"]);
  await expect(page.getByLabel("2번 페이지 선택")).toBeChecked();
  await expect(page.getByLabel("3번 페이지 선택")).not.toBeChecked();
  await expect(page.locator(".tool-reorder-live")).toHaveText("2번째 위치로 이동했습니다.");
  // Keyboard users move one step with the arrow keys on the focused grip.
  await page.getByRole("button", { name: "2번 페이지 순서 변경" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(pages.locator(".pdf-tool-page-meta span")).toHaveText(["원본 1페이지", "원본 2페이지 · +90°", "원본 4페이지"]);
  await expect(page.getByRole("button", { name: "3번 페이지 순서 변경" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(pages.locator(".pdf-tool-page-meta span")).toHaveText(["원본 1페이지", "원본 4페이지", "원본 2페이지 · +90°"]);
  await page.getByLabel("2번 페이지 선택").uncheck();
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

  await page.getByLabel("형식").selectOption("png");
  const pngZip = await downloadBytes(page, () => page.getByRole("button", { name: /다운로드/ }).click());
  expect(Object.keys(unzipSync(pngZip.bytes)).sort()).toEqual(["page-001.png", "page-002.png", "page-003.png"]);
  const pngPages = unzipSync(pngZip.bytes);
  const firstPng = await imageDimensions(page, pngPages["page-001.png"], "image/png");
  const rotatedPng = await imageDimensions(page, pngPages["page-003.png"], "image/png");
  expect(firstPng.width).toBeLessThan(firstPng.height);
  expect(rotatedPng.width).toBeGreaterThan(rotatedPng.height);
  await page.getByLabel("형식").selectOption("jpg");
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
  await page.getByLabel("전체 선택").check();
  await page.getByRole("button", { name: "선택 삭제" }).click();
  // Removing every page returns the tool to its upload-only empty state.
  await expect(page.locator(".pdf-tool-editor, .pdf-tool-export")).toHaveCount(0);
  await expect(page.locator(".pdf-tool-upload").getByRole("button", { name: "PDF 추가" })).toBeVisible();
  expect(posted).toEqual([]);
  expect(errors).toEqual([]);
});

test("PDF export keeps the byte-identical text original when compression does not shrink it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "PDF 도구" }).click();
  const document = await PDFDocument.create();
  const sheet = document.addPage([400, 600]);
  sheet.drawText("SMALL TEXT", { x: 30, y: 500, font: await document.embedFont(StandardFonts.Helvetica) });
  const original = await document.save();
  await page.getByLabel("PDF 파일 선택").setInputFiles({
    name: "small-text.pdf", mimeType: "application/pdf", buffer: Buffer.from(original),
  });
  await expect(page.locator(".pdf-tool-page")).toHaveCount(1);
  for (const level of ["balanced", "size"]) {
    await page.getByLabel("압축").selectOption(level);
    const result = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
    expect(result.bytes).toEqual(original);
    await expect(page.locator(".pdf-tool-export .pdf-tool-notice")).toContainText("파일 크기가 줄어들지 않아 원본을 유지합니다.");
    await expect(page.locator(".pdf-tool-export .pdf-tool-notice")).not.toContainText("감소");
  }
});

test("PDF compression is one level select defaulting to balanced, and each level keeps text", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "PDF 도구" }).click();
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
  await expect(level).toHaveValue("balanced");
  await expect(level.locator("option")).toHaveText(["고화질", "균형 (권장)", "강력 압축"]);

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

  await level.selectOption("size");
  expect(await save()).toBeLessThan(balanced);

  await level.selectOption("quality");
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
  await page.getByRole("button", { name: "이미지 도구" }).click();
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
  await page.getByLabel("품질").selectOption("high");
  const high = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  await page.getByLabel("품질").selectOption("small");
  const small = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(small.bytes.length).toBeLessThan(high.bytes.length);
  await page.getByLabel("형식").selectOption("webp");
  await page.getByLabel("품질").selectOption("high");
  const webpHigh = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  await page.getByLabel("품질").selectOption("small");
  const webpSmall = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(webpSmall.bytes.length).toBeLessThan(webpHigh.bytes.length);
  await page.getByLabel("형식").selectOption("png");
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
  await page.getByLabel("선택 이미지 한 장으로 결합").check();
  await page.getByLabel("형식").selectOption("png");
  const merged = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(await imageDimensions(page, merged.bytes, "image/png")).toEqual({ width: 1600, height: 1600 });
  await page.getByLabel("선택 이미지 한 장으로 결합").uncheck();
  const zipped = await downloadBytes(page, () => page.getByRole("button", { name: /ZIP 다운로드/ }).click());
  expect(Object.keys(unzipSync(zipped.bytes)).sort()).toEqual(["pattern.png", "second.png"]);
  await page.getByLabel("형식").selectOption("pdf");
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
  await page.getByRole("button", { name: "이미지 도구" }).click();
  const upload = page.locator(".image-tool-upload");
  await expect(upload).toBeVisible();
  await expect(page.locator(".image-tool-layout, .image-tool-export")).toHaveCount(0);
  const intro = (await page.locator(".image-tool-intro").boundingBox())!;
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
  await page.getByRole("button", { name: "이미지 도구" }).click();
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

  await page.getByLabel("형식").selectOption("jpg");
  await expect(page.getByLabel("품질")).toHaveValue("balanced");
  await expect(page.getByLabel("품질").locator("option")).toHaveText(["고화질", "균형 (권장)", "강력 압축"]);
  await expect(page.locator(".image-tool-export")).not.toContainText("%");

  await page.locator(".image-tool-file-open").filter({ hasText: "b.png" }).click();
  await page.getByLabel("a.png 선택").uncheck();
  await dragGrip(page, page.getByRole("button", { name: "c.png 순서 변경" }), page.locator(".image-tool-file").first(), "before", "y");
  await expect(files).toHaveText(["c.png", "a.png", "b.png"]);
  await expect(page.locator(".image-tool-file.is-current strong")).toHaveText("b.png");
  await expect(page.getByLabel("a.png 선택")).not.toBeChecked();
  await expect(page.getByLabel("c.png 선택")).toBeChecked();
  await page.getByLabel("a.png 선택").check();

  await page.getByRole("button", { name: "b.png 순서 변경" }).focus();
  await page.keyboard.press("ArrowUp");
  await expect(files).toHaveText(["c.png", "b.png", "a.png"]);
  await page.keyboard.press("ArrowDown");
  await expect(files).toHaveText(["c.png", "a.png", "b.png"]);
  await expect(page.locator(".tool-reorder-live")).toHaveText("3번째 위치로 이동했습니다.");

  await page.getByLabel("형식").selectOption("png");
  const zipped = await downloadBytes(page, () => page.getByRole("button", { name: /ZIP 다운로드/ }).click());
  expect(Object.keys(unzipSync(zipped.bytes))).toEqual(["c.png", "a.png", "b.png"]);
  await page.getByLabel("형식").selectOption("pdf");
  const pdf = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  const widths = (await PDFDocument.load(pdf.bytes)).getPages().map((item) => item.getWidth());
  expect(widths[0]).toBeGreaterThan(widths[2]);
  expect(widths[2]).toBeGreaterThan(widths[1]);
  await page.getByLabel("선택 이미지 한 장으로 결합").check();
  await page.getByLabel("형식").selectOption("png");
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
  await page.getByRole("button", { name: "이미지 도구" }).click();
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
  await page.getByRole("button", { name: "이미지 도구" }).click();
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
  await page.getByLabel("형식").selectOption("png");
  await expect(page.getByLabel("품질")).toHaveCount(0);
  const exported = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(await imageDimensions(page, exported.bytes, "image/png")).toEqual({ width: 2400, height: 1600 });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("rejects oversized and excessive-page PDF imports before retaining them", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop");
  await page.goto("/");
  await page.getByRole("button", { name: "PDF 도구" }).click();
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
