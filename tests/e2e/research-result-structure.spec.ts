import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";

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
  test(`결과 구조: 핵심 근거는 펼침, 공통 원문과 추가 조회는 정확한 대상으로 이동 ${width}`, async ({ page }) => {
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
    await expect(output.locator(".research-issue-refs .legal-analysis-lines")).toHaveCount(1);
    const supplement = output.getByRole("region", { name: "추가 조회 자료" });
    await expect(supplement).toContainText("제목에 질문 용어가 포함된 조문 1건");
    await expect(supplement).toContainText("조문 제목에 질문 용어가 포함된 자료를 추가로 조회했습니다.");
    await expect(supplement.locator(".legal-analysis-lines")).toHaveCount(0);
    const jump = supplement.getByRole("button", { name: "상세 근거에서 원문 보기" });
    await jump.focus();
    await jump.press("Enter");
    const target = output.locator("#research-article-1");
    await expect(target).toBeFocused();
    await expect(target).toBeVisible();
    await expect(output.locator(".research-issue-refs").first()).toHaveAttribute("open", "");
    expect((await target.boundingBox())!.y).toBeGreaterThanOrEqual(64);
    await expect(target).toContainText("② 마지막 항도 보존한다.");
    await output.locator(".research-issue-refs summary").nth(1).click();
    const common = output.getByRole("button", { name: "공통 근거 원문 보기" });
    await common.focus();
    await common.press("Space");
    await expect(target).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`결과 구조: 위임 검증 고유 정보는 하단 보존, 없는 근거 버튼은 숨김 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const expression = "대통령령으로 정하는 상세 위임 문언을 전부 보존한다.";
    await page.route("**/api/law/research", route => route.fulfill({ json: { data: {
      found: true, task: "law_system", text: "═══ 법체계 ═══\n▶ 3단 비교\n[법률] 근로기준법 제23조 (해고 등의 제한)\n[시행령] 근로기준법 시행령 제7조 (적용범위)", markers: [],
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
    await expect(top.getByRole("button", { name: "근거 보기", exact: true })).toHaveCount(1);
    await expect(top).toContainText("고유 조문 1건 · 직접 위임 확인됨");
    const details = output.getByRole("region", { name: "항목별 법적 근거" });
    await expect(details).toContainText(expression);
    await expect(details.locator("details[open]")).toHaveCount(0);
    const jump = top.getByRole("button", { name: "근거 보기", exact: true });
    await jump.focus();
    await jump.press("Enter");
    await expect(details.locator("h3[tabindex='-1']")).toBeFocused();
    await expect(details.getByText(expression, { exact: false })).toBeVisible();
    expect((await details.locator("#research-task-evidence-1").boundingBox())!.y).toBeGreaterThanOrEqual(64);
    await expect(output.locator(".research-hierarchy")).toContainText("근로기준법 시행령 제7조");
    await expect(top.locator("h3")).toHaveAttribute("data-status", "partial");
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
    const supplement = output.getByRole("region", { name: "추가 조회 자료" });
    await expect(supplement).toContainText("제목에 질문 용어가 포함된 조문 4건");
    await expect(supplement).toContainText("추가로 조회한 조문 1건");
    await expect(supplement.getByRole("button", { name: "상세 근거에서 원문 보기" })).toHaveCount(1);
    await expect(supplement.locator(".legal-analysis-lines")).toHaveCount(4);
    await expect(output.locator(".research-overview h3")).toHaveAttribute("data-status", "viewed");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
