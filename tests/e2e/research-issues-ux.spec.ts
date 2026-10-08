import { expect, test } from "@playwright/test";
import { navigateWorkspace } from "./navigation";

const article = { law: "근로기준법", jo: "제23조", currency: "current" };
const longExcerpt = `① ${"해고의 정당성은 구체적인 사실관계를 대조하여 확인한다. ".repeat(50)}\n② 원문 마지막 항도 그대로 확인한다.`;
const longTitle = `퇴직금과 해고 ${"구체적 사실관계와 법적 기준의 대조 ".repeat(15)}`;

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`종합 리서치 쟁점 0/1/2/5와 독립 근거·바로가기 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    let calls = 0;
    await page.route("**/api/law/research", (route) => {
      calls++;
      const { query } = route.request().postDataJSON() as { query: string };
      const count = Number(query);
      const labels = ["퇴직금", "해고", longTitle, "해고 통지", "해고 예고"].slice(0, count);
      const issues = labels.map((label, index) => ({ label, status: index === 3 ? "failed" : index === 4 ? "timeout" : "found",
        articles: index < 3 ? [article] : [], precedents: index < 2 ? [String(71 + index)] : [] }));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        found: true, task: "full_research", markers: [],
        text: count ? `═══ 종합 리서치 ═══\n▶ AI 법령검색 결과\n지능형 법령검색 결과 (법령조문, 1건):\n\n근로기준법\n   제0023조 (해고 등의 제한)\n${longExcerpt}\n   시행: 2025.01.01 | 고용노동부` : "",
        interpretation: { original: query, situation: "", facts: [], issues: labels.map((label) => ({ label, query: label })), confidence: "high" },
        evidence: { status: count === 5 ? "partial" : count ? "matched" : "unverified", articles: count ? [article] : [], precedents: count ? ["71", "72"] : [], issues,
          precedentEntries: { "71": { title: "퇴직금 지급", caseNumber: "2025다71", body: "대법원" }, "72": { title: "해고 정당성", caseNumber: "2025다72", body: "대법원" } },
          precedentExcerpts: { "71": "퇴직금 근거 원문 마지막 문장", "72": "해고 근거 원문 마지막 문장" } },
      } }) });
    });
    await page.goto("/");
    await navigateWorkspace(page, "법령");
    await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
    const form = page.getByRole("form", { name: "종합 리서치 입력" });
    const output = page.locator(".legal-research .legal-analysis-output");
    for (const count of [0, 1, 2, 5]) {
      await form.getByLabel("질문 또는 검색어").fill(String(count));
      await form.getByRole("button", { name: "실행", exact: true }).click();
      const sections = output.locator(".research-issue-evidence");
      await expect(sections).toHaveCount(count);
      await expect(output.getByRole("navigation", { name: "쟁점 바로가기" })).toHaveCount(count > 1 ? 1 : 0);
      if (!count) {
        await expect(output.locator(".research-overview h3")).toHaveText("관련 근거를 확인하지 못했습니다");
        continue;
      }
      for (let index = 0; index < count; index++) {
        await expect(sections.nth(index).locator("h3")).toContainText(String(index + 1).padStart(2, "0"));
      }
      await expect(output.locator(".research-issue-refs[open]")).toHaveCount(0);
      if (count === 2) await output.screenshot({ path: `artifacts/research-issues-${viewport.width}.png` });
      await sections.first().locator("summary").click();
      await expect(sections.first().locator(".research-issue-refs")).toHaveAttribute("open", "");
      await expect(sections.first().locator(".research-hits")).toContainText("② 원문 마지막 항도 그대로 확인한다.");
      await expect(sections.first().locator(".research-hits")).toContainText("퇴직금 근거 원문 마지막 문장");
      if (count > 1) {
        await expect(sections.nth(1).locator(".research-issue-refs")).not.toHaveAttribute("open", "");
        await output.getByRole("navigation").getByRole("button").nth(1).click();
        await expect(sections.nth(1)).toHaveClass(/is-focused/);
        await expect(sections.nth(1).locator("h3")).toBeFocused();
        expect(await sections.nth(1).evaluate((element) => element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(64);
        await sections.nth(1).locator("summary").click();
        await expect(sections.nth(1).locator(".research-hits")).toContainText("해고 근거 원문 마지막 문장");
        await expect(sections.nth(1).locator(".research-hits")).not.toContainText("퇴직금 근거 원문 마지막 문장");
        await expect(sections.nth(1).locator(".research-hits")).toContainText("② 원문 마지막 항도 그대로 확인한다.");
      }
      const rawSource = output.locator(".research-source");
      await rawSource.locator("summary").click();
      const rawOpen = await rawSource.evaluate((element) => (element as HTMLDetailsElement).open);
      await output.getByRole("button", { name: "근거 펼치기", exact: true }).click();
      await expect(output.locator(".research-issue-refs[open]")).toHaveCount(Math.min(count, 3));
      expect(await rawSource.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(rawOpen);
      await output.getByRole("button", { name: "근거 접기", exact: true }).click();
      await expect(output.locator(".research-issue-refs[open]")).toHaveCount(0);
      expect(await rawSource.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(rawOpen);
      if (count === 5) {
        await expect(sections.nth(3)).toHaveAttribute("data-status", "failed");
        await expect(sections.nth(4)).toHaveAttribute("data-status", "timeout");
        await expect(sections.nth(3).locator(".research-issue-findings")).toContainText("자료 확인 실패");
        await expect(sections.nth(4).locator(".research-issue-findings")).toContainText("조회 미완료");
      }
      expect(calls).toBe([0, 1, 2, 5].indexOf(count) + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });

  test(`종합 리서치 저장된 근거 ON과 미확인 쟁점 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => localStorage.setItem("worklens:review-preferences:v1", JSON.stringify({ version: 1, preferences: { documentSource: "text", expandSources: true } })));
    await page.route("**/api/law/research", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
      found: true, task: "full_research", text: "", markers: [],
      evidence: { status: "partial", articles: [], precedents: ["71"], precedentEntries: { "71": { title: longTitle, caseNumber: "2025다71" } }, precedentExcerpts: { "71": longExcerpt },
        issues: [{ label: "퇴직금", status: "found", articles: [], precedents: ["71"] }, { label: "해고", status: "none", articles: [], precedents: [] }] },
    } }) }));
    await page.goto("/");
    await navigateWorkspace(page, "법령");
    await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
    const form = page.getByRole("form", { name: "종합 리서치 입력" });
    await form.getByLabel("질문 또는 검색어").fill("퇴직금과 해고");
    await form.getByRole("button", { name: "실행", exact: true }).click();
    const output = page.locator(".legal-research .legal-analysis-output");
    await expect(output.locator(".research-issue-refs")).toHaveAttribute("open", "");
    await expect(output.locator(".research-issue-refs")).toContainText("② 원문 마지막 항도 그대로 확인한다.");
    const second = output.locator(".research-issue-evidence").nth(1);
    await expect(second.locator(".research-issue-findings")).toContainText("직접 관련 근거 미확인");
    await expect(second.locator(".research-issue-refs")).toHaveCount(0);
    await expect(second).not.toContainText("2025다71");
    await output.getByRole("button", { name: "근거 접기", exact: true }).click();
    await expect(output.locator(".research-issue-refs")).not.toHaveAttribute("open", "");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
