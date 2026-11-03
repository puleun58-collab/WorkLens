import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import foodAnnex from "../fixtures/law-annex-food-23.json" with { type: "json" };

const excerpt = "① 해고의 기준을 확인한다.\n② 마지막 항도 보존한다.";
const lawArticle = { law: "근로기준법", jo: "제23조", title: "해고 등의 제한", excerpt, effectiveDate: "2025.01.01", matched: ["해고"] };
const text = `═══ 조회 결과 ═══\n▶ AI 법령검색 결과\n지능형 법령검색 결과 (법령조문, 1건):\n\n근로기준법\n   제0023조 (해고 등의 제한)\n${excerpt}\n   시행: 2025.01.01 | 고용노동부`;

async function openResearch(page: Page) {
  await page.goto("/");
  await navigateWorkspace(page, "법령");
  await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
  return page.getByRole("form", { name: "종합 리서치 입력" });
}

for (const width of [1440, 390]) {
  test(`결과 구조: 공통 원문은 쟁점별 독립 상세에서만 확인 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const article = { law: lawArticle.law, jo: lawArticle.jo, currency: "current" };
    await page.route("**/api/law/research", route => route.fulfill({ json: { data: {
      found: true, task: "full_research", text, markers: [],
      evidence: { status: "matched", articles: [article], precedents: [], issues: [
        { label: "해고 기준", status: "found", articles: [article], precedents: [] },
        { label: "해고 적용", status: "found", articles: [article], precedents: [] },
      ] },
      enrichment: { supplement: { status: "found", articles: [lawArticle] } },
    } } }));
    const form = await openResearch(page);
    await form.getByLabel("질문 또는 검색어").fill("해고");
    await form.getByRole("button", { name: "실행", exact: true }).click();
    const output = page.locator(".legal-analysis-output[data-task='full_research']");
    await expect(output.locator(".research-overview h3")).toHaveAttribute("data-status", "matched");
    await expect(output.getByRole("list", { name: "핵심 법적 근거" })).toHaveCount(2);
    await expect(output.getByRole("list", { name: "핵심 법적 근거" }).first()).toContainText("근로기준법 제23조 해고 등의 제한");
    await expect(output.locator(".research-issue-refs[open]")).toHaveCount(0);
    await expect(output.locator(".research-issue-refs .legal-analysis-lines")).toHaveCount(2);
    await expect(output.locator(".research-core-sources button, .research-core-sources a")).toHaveCount(0);
    const supplement = output.getByRole("region", { name: "추가 조회 자료" });
    await expect(supplement.locator(".research-source-jump")).toHaveCount(0);
    await expect(supplement.locator(".legal-analysis-lines")).toHaveCount(0);
    const toggle = output.locator(".research-issue-refs > summary").first();
    await toggle.focus();
    await toggle.press("Enter");
    const target = output.locator("#research-article-1");
    await expect(target).toBeVisible();
    await expect(output.locator(".research-issue-refs").first()).toHaveAttribute("open", "");
    const firstOriginal = target.locator(".research-original-body");
    await expect(firstOriginal).not.toHaveAttribute("open", "");
    await expect(firstOriginal.locator(".legal-analysis-lines")).not.toBeVisible();
    await firstOriginal.locator(":scope > summary").click();
    await expect(firstOriginal.locator(".legal-analysis-lines")).toBeVisible();
    await expect(target).toContainText("② 마지막 항도 보존한다.");
    await output.locator(".research-issue-refs > summary").nth(1).click();
    const common = output.locator("#research-article-1-issue-2");
    await expect(common).toBeVisible();
    await expect(common.locator(".research-original-body")).not.toHaveAttribute("open", "");
    await expect(firstOriginal).toHaveAttribute("open", "");
    await expect(common).toContainText("② 마지막 항도 보존한다.");
    await expect(common.getByRole("link")).toHaveAttribute("href", /^https:\/\/www\.law\.go\.kr\//u);
    await output.locator(".research-issue-refs > summary").first().click();
    await expect(target).not.toBeVisible();
    await expect(common).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`결과 구조: 위임 검증 고유 정보는 하단 보존, 없는 근거 버튼은 숨김 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const expression = "대통령령으로 정하는 상세 위임 문언을 전부 보존한다.";
    await page.route("**/api/law/research", route => route.fulfill({ json: { data: {
      found: true, task: "law_system", text: `═══ 법체계 ═══
▶ 3단 비교
[법률] 근로기준법 제23조 (해고 등의 제한)
[시행령] 근로기준법 시행령 제7조 (적용범위)
▶ 조회 조문 상세
[시행령] 근로기준법 시행령 제7조 (적용범위)
${expression}
▶ 관련 판례 상세
판결요지: 판례 원문을 보존한다.
▶ 근로기준법 본문
법령명: 근로기준법
목차 (총 2개 조문)
제1조 목적
제2조 정의`, markers: [],
      lawSystem: { status: "partial", items: [
        { label: "시행령", status: "found", detail: "검증 집계와 고유 설명", articles: [
          { law: "근로기준법 시행령", jo: "제7조", title: "적용범위", relation: "direct", expression },
        ] },
        { label: "시행규칙", status: "none", detail: "원문 미확보" },
      ] },
    } } }));
    const form = await openResearch(page);
    await form.getByLabel("리서치 유형").click();
    await page.getByRole("option", { name: "법체계 확인", exact: true }).click();
    await form.getByLabel("질문 또는 검색어").fill("근로기준법 제23조와 시행령 관계");
    await form.getByRole("button", { name: "실행", exact: true }).click();
    const output = page.locator(".legal-analysis-output[data-task='law_system']");
    const top = output.locator(".research-overview");
    await expect(top.locator("details")).toHaveCount(0);
    await expect(top).not.toContainText(expression);
    // A cross-reference without the parent's operative delegation cannot be
    // promoted to a direct link, even if an upstream summary labels it direct.
    await expect(top.getByRole("button", { name: "근거 보기", exact: true })).toHaveCount(0);
    await expect(top).toContainText("직접 위임관계 미확인");
    await expect(top).not.toContainText(expression);
    await expect(output.getByRole("region", { name: "법령 단계별 관계" })).toHaveCount(0);
    const source = output.getByRole("region", { name: "상세 근거" });
    await expect(source).toContainText(expression);
    await expect(source.locator('[data-law-system-relation="direct"]')).toHaveCount(1);
    await source.locator(".research-supporting-sources > summary").click();
    await expect(source.locator('[data-law-system-relation="direct"]')).toBeVisible();
    await expect(source.locator('li[data-source-role="직접 관련 근거"]')).toHaveCount(0);
    await expect(output.locator(".research-hierarchy")).toHaveCount(0);
    await expect(source).toContainText("근로기준법 시행령 제7조");
    await expect(top.locator("h3")).toHaveAttribute("data-status", "partial");
    const reference = output.locator(".research-supporting");
    await expect(reference.locator("h3")).toHaveText("참고 원자료");
    await expect(reference.locator("details")).toHaveCount(2);
    await expect(reference.locator("details").first()).toHaveAttribute("data-kind", "detail");
    await expect(reference.locator("details").last()).toHaveAttribute("data-kind", "law_toc");
    await expect(reference).toContainText("판례 원문을 보존한다.");
    await expect(reference).not.toContainText(expression);
    await expect(reference.locator("details[open]")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`결과 구조: 추가 조회의 다른 법령·판본·발췌와 혼합 경로 보존 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/law/research", route => route.fulfill({ json: { data: {
      found: true, task: "action_basis", text, markers: [],
      actionBasis: { status: "viewed", items: [{ label: "처분 근거", status: "viewed", detail: "자료만 조회" }] },
      enrichment: { supplement: { status: "found", articles: [
        lawArticle,
        { ...lawArticle, effectiveDate: "2026.01.01" },
        { ...lawArticle, law: "다른 법률" },
        { ...lawArticle, excerpt: "① 별도의 원문 발췌" },
        { ...lawArticle, jo: "제24조", title: "명시 조문", explicit: true, matched: [] },
      ] } },
    } } }));
    const form = await openResearch(page);
    await form.getByLabel("리서치 유형").click();
    await page.getByRole("option", { name: "처분·허가 근거", exact: true }).click();
    await form.getByLabel("질문 또는 검색어").fill("해고");
    await form.getByRole("button", { name: "실행", exact: true }).click();
    const output = page.locator(".legal-analysis-output[data-task='action_basis']");
    const source = output.getByRole("region", { name: "상세 근거" });
    await expect(source.locator(".research-hits > li")).toHaveCount(4);
    await source.locator(".research-supporting-sources > summary").click();
    const officialLinks = source.getByRole("link", { name: "법제처 원문 보기" });
    await expect(officialLinks).toHaveCount(4);
    for (const link of await officialLinks.all()) await expect(link).toHaveAttribute("href", /^https:\/\/www\.law\.go\.kr\//u);
    await expect(source).toContainText("① 별도의 원문 발췌");
    await expect(source).toContainText("다른 법률 제23조");
    await expect(source).toContainText("근로기준법 제23조");
    await expect(output.locator('[data-group="statutes"] [data-kind="law_articles"]')).toHaveCount(0);
    await expect(source.locator(".research-hits > li").first().locator("a")).toBeVisible();
    await expect(output.locator(".research-overview h3")).toHaveAttribute("data-status", "viewed");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`별표 HWP 원문은 기본 접힘·그룹 머리글·원래 표 구조와 내부 스크롤 유지 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/law/research", (route) => route.fulfill({ json: { data: {
      found: true, task: "action_basis", text: "", markers: [], actionBasis: { status: "viewed", items: [] },
      annexes: [{ law: foodAnnex.law, label: foodAnnex.label, sourceArticle: "제89조", citation: "별표 23",
        status: "verified", relevance: "direct", text: foodAnnex.text }],
    } } }));
    const form = await openResearch(page);
    await form.getByLabel("리서치 유형").click();
    await page.getByRole("option", { name: "처분·허가 근거", exact: true }).click();
    await form.getByLabel("질문 또는 검색어").fill("식품위생법 영업정지 기준");
    await form.getByRole("button", { name: "실행", exact: true }).click();
    const source = page.locator(".legal-analysis-output[data-task='action_basis']").getByRole("region", { name: "상세 근거" });
    const original = source.locator("details.research-original-body:has(.research-annex-original)");
    await expect(original).not.toHaveAttribute("open", "");
    await expect(original.locator(".research-annex-original")).not.toBeVisible();
    await original.locator(":scope > summary").click();
    const tables = original.locator("table");
    await expect(tables).toHaveCount(4);
    await expect(tables.locator("tr")).toHaveCount(316);
    await expect(tables.locator("th, td")).toHaveCount(1564);
    const first = tables.first();
    await expect(first.locator("thead tr")).toHaveCount(2);
    await expect(first.locator('thead th[rowspan="2"]')).toHaveCount(2);
    await expect(first.locator('thead th[colspan="3"]')).toHaveCount(1);
    const lowerHeaders = first.locator("thead tr").nth(1).locator("th");
    await expect(lowerHeaders).toHaveCount(3);
    const geometry = await first.evaluate((table) => {
      const headers = table.querySelectorAll<HTMLTableCellElement>("thead tr:first-child th");
      const lower = [...table.querySelectorAll<HTMLTableCellElement>("thead tr:nth-child(2) th")];
      const topStyle = getComputedStyle(headers[0]);
      const lowerStyle = getComputedStyle(lower[0]);
      return { contentWidth: headers[0].getBoundingClientRect().width, basisWidth: headers[1].getBoundingClientRect().width,
        stages: lower.map((cell) => cell.getBoundingClientRect().width), topAlign: topStyle.textAlign, topVertical: topStyle.verticalAlign,
        lowerAlign: lowerStyle.textAlign, lowerVertical: lowerStyle.verticalAlign, topColor: topStyle.backgroundColor, lowerColor: lowerStyle.backgroundColor };
    });
    expect(geometry.contentWidth).toBeGreaterThan(geometry.basisWidth);
    expect(Math.max(...geometry.stages) - Math.min(...geometry.stages)).toBeLessThanOrEqual(1);
    expect([geometry.topAlign, geometry.lowerAlign]).toEqual(["center", "center"]);
    expect([geometry.topVertical, geometry.lowerVertical]).toEqual(["middle", "middle"]);
    expect(geometry.topColor).not.toBe(geometry.lowerColor);
    if (width === 390) expect(await original.locator(".research-table-scroll").first().evaluate((frame) => frame.scrollWidth > frame.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await form.getByLabel("질문 또는 검색어").fill("식품위생법 다른 처분 기준");
    await expect(original).toHaveAttribute("open", "");
    await form.getByRole("button", { name: "실행", exact: true }).click();
    await expect(original).not.toHaveAttribute("open", "");
  });

  test(`절차 근거 이동은 접힌 원문을 열고 해당 조문으로 도달 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const reference = { law: lawArticle.law, jo: lawArticle.jo, title: lawArticle.title };
    await page.route("**/api/law/research", (route) => route.fulfill({ json: { data: {
      found: true, task: "procedure_detail", text, markers: [], procedure: {
        overall: "partial", incomplete: false, annexTruncated: false, annexOriginStage: "list-only", failedSections: 0,
        requirements: [{ kind: "procedure", label: "청구 절차", status: "found", articles: [reference],
          annexCount: 0, annexOriginStage: "list-only", annexRelatedCandidates: [] }],
        steps: [{ phase: "filing", label: "청구", articles: [reference], missing: false }],
      },
    } } }));
    const form = await openResearch(page);
    // procedure_detail is hidden from the menu; rendering keys on the response task.
    await form.getByLabel("리서치 유형").click();
    await page.getByRole("option", { name: "통합 조사", exact: true }).click();
    await form.getByLabel("질문 또는 검색어").fill("해고 구제 청구 절차");
    await form.getByRole("button", { name: "실행", exact: true }).click();
    const output = page.locator(".legal-analysis-output[data-task='procedure_detail']");
    const jump = output.locator("[data-procedure-steps] .research-source-jump");
    const targetId = await jump.getAttribute("aria-controls");
    expect(targetId).toBeTruthy();
    const target = output.locator(`[id="${targetId}"]`);
    await expect(target.locator(".research-original-body")).not.toHaveAttribute("open", "");
    await jump.click();
    await expect(target).toBeFocused();
    await expect(target.locator(".research-original-body")).toHaveAttribute("open", "");
    await expect(target.locator(".legal-analysis-lines")).toBeVisible();
    await expect(target.locator(".legal-analysis-lines")).toContainText(excerpt.split("\n")[1]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
