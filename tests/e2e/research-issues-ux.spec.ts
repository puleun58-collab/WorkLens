import { expect, test } from "@playwright/test";
import { navigateWorkspace } from "./navigation";

const article = { law: "근로기준법", jo: "제23조", currency: "current" };
const longExcerpt = `① ${"해고의 정당성은 구체적인 사실관계를 대조하여 확인한다. ".repeat(50)}\n② 원문 마지막 항도 그대로 확인한다.`;
const longTitle = `퇴직금과 해고 ${"구체적 사실관계와 법적 기준의 대조 ".repeat(15)}`;

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`리서치 진행 중 결과를 비우고 완료·재실행·미조회 상태를 표시 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    let release: (() => void) | undefined;
    let calls = 0;
    await page.route("**/api/law/research", async (route) => {
      const call = ++calls;
      await new Promise<void>((resolve) => { release = resolve; });
      const data = call === 1 ? {
        found: true, task: "full_research", text: "", markers: [],
        evidence: { status: "partial", articles: [article], precedents: [],
          issues: [{ label: "해고 제한", status: "found", articles: [article], precedents: [] },
            { label: "통지 방법", status: "failed", articles: [], precedents: [] }] },
      } : { found: false, task: "full_research", marker: "NOT_FOUND", text: "" };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
    });
    await page.goto("/");
    await navigateWorkspace(page, "법령");
    await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
    const form = page.getByRole("form", { name: "종합 리서치 입력" });
    const results = page.locator(".legal-research .legal-analysis-result");
    await form.getByLabel("질문 또는 검색어").fill("해고 제한과 통지 방법");
    await form.getByRole("button", { name: "실행", exact: true }).click();
    await expect(form.getByRole("button", { name: "리서치 중…" })).toBeDisabled();
    await expect(results).toHaveCount(0);
    await expect(page.locator(".legal-research .sr-only[role='status']")).toHaveText("리서치 중…");
    await expect.poll(() => Boolean(release)).toBe(true);
    release!();
    await expect(results.locator(".research-issue-evidence")).toHaveCount(2);
    await expect(results.locator(".research-issue-evidence").nth(1)).toHaveAttribute("data-status", "failed");
    await expect(results.locator(".research-overview h3")).toBeVisible();
    await expect(page.locator(".legal-research .sr-only[role='status']")).toBeEmpty();

    release = undefined;
    await form.getByLabel("질문 또는 검색어").fill("조회되지 않은 근거");
    await form.getByRole("button", { name: "실행", exact: true }).click();
    await expect(form.getByRole("button", { name: "리서치 중…" })).toBeDisabled();
    await expect(results).toHaveCount(0);
    await expect.poll(() => Boolean(release)).toBe(true);
    release!();
    await expect(results.locator(".legal-analysis-missing")).toContainText("조회되지 않았다고 관련 법령이나 판례가 없다는 뜻은 아닙니다.");
    await expect(results.locator(".research-issue-evidence")).toHaveCount(0);
    expect(calls).toBe(2);
  });

  test(`종합 리서치 쟁점 0/1/2/5와 독립 근거·바로가기 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    let calls = 0;
    await page.route("**/api/law/research", (route) => {
      calls++;
      const { query } = route.request().postDataJSON() as { query: string };
      const count = Number(query);
      const labels = ["퇴직금 지급", "부당해고 여부", longTitle, "해고 통지", "해고 예고"].slice(0, count);
      const issues = labels.map((label, index) => ({ label, status: index === 3 ? "failed" : index === 4 ? "timeout" : "found",
        articles: index < 3 ? [article] : [], precedents: index < 2 ? [String(71 + index)] : [] }));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        found: true, task: "full_research", markers: [],
        text: count ? `═══ 종합 리서치 ═══\n▶ AI 법령검색 결과\n지능형 법령검색 결과 (법령조문, 1건):\n\n근로기준법\n   제0023조 (해고 등의 제한)\n${longExcerpt}\n   시행: 2025.01.01 | 고용노동부` : "",
        interpretation: { original: query, situation: "", facts: [], issues: labels.map((label) => ({ label, query: label })), confidence: "high" },
        evidence: { status: count === 5 ? "partial" : count ? "matched" : "unverified", articles: count ? [article] : [], precedents: count ? ["71", "72"] : [], issues,
          precedentEntries: { "71": { title: "퇴직금 지급", caseNumber: "2025다71", body: "대법원" }, "72": { title: "부당해고 여부", caseNumber: "2025다72", body: "대법원" } },
          precedentExcerpts: { "71": "퇴직금 근거 원문 마지막 문장", "72": "해고 근거 원문 마지막 문장" } },
      } }) });
    });
    await page.goto("/");
    await navigateWorkspace(page, "법령");
    await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
    const form = page.getByRole("form", { name: "종합 리서치 입력" });
    const output = page.locator(".legal-research .legal-analysis-output");
    const savedPreference = await page.evaluate(() => localStorage.getItem("worklens:review-preferences:v1"));
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
        await expect(sections.nth(index)).toHaveAttribute("id", `research-issue-${index + 1}`);
        for (const label of ["핵심 검토 결과", "근거 상태", "추가 확인"]) await expect(sections.nth(index).locator(".research-issue-findings")).toContainText(label);
      }
      const expand = output.getByRole("button", { name: "전체 펼치기", exact: true });
      await expect(expand).toHaveAttribute("aria-pressed", "false");
      const descriptionId = await expand.getAttribute("aria-describedby");
      expect(descriptionId).toBeTruthy();
      await expect(output.locator(`[id="${descriptionId}"]`)).toHaveText("상세 근거");
      await expect(output.locator(".research-issue-refs[open]")).toHaveCount(0);
      if (count === 2) await output.screenshot({ path: `artifacts/research-issues-${viewport.width}.png` });
      await sections.first().locator("summary").click();
      await expect(sections.first().locator(".research-issue-refs")).toHaveAttribute("open", "");
      await expect(output.getByRole("button", { name: count === 1 ? "전체 접기" : "전체 펼치기", exact: true })).toBeVisible();
      await expect(sections.first().locator(".research-hits")).toContainText("② 원문 마지막 항도 그대로 확인한다.");
      await expect(sections.first().locator(".research-hits")).toContainText("퇴직금 지급");
      await expect(sections.first().locator(".research-hits")).toContainText("퇴직금 근거 원문 마지막 문장");
      if (count > 1) {
        await expect(sections.nth(1).locator(".research-issue-refs")).not.toHaveAttribute("open", "");
        await expect(output.getByRole("navigation").getByRole("button").nth(1)).toHaveAttribute("aria-controls", "research-issue-2");
        await output.getByRole("navigation").getByRole("button").nth(1).click();
        await expect(sections.nth(1)).toHaveClass(/is-focused/);
        await expect(sections.nth(1).locator("h3")).toBeFocused();
        await expect(sections.nth(1)).toBeInViewport();
        await sections.nth(1).locator("summary").click();
        await expect(sections.nth(1).locator("h3")).toContainText("부당해고 여부");
        await expect(sections.nth(1).locator(".research-hits")).toContainText("부당해고 여부");
        await expect(sections.nth(1).locator(".research-hits")).toContainText("해고 근거 원문 마지막 문장");
        await expect(sections.nth(1).locator(".research-hits")).not.toContainText("퇴직금 근거 원문 마지막 문장");
        await expect(sections.nth(1).locator(".research-hits")).toContainText("② 원문 마지막 항도 그대로 확인한다.");
        if (count === 2) await expect(output.getByRole("button", { name: "전체 접기", exact: true })).toBeVisible();
        await sections.nth(1).locator("summary").click();
        await expect(output.getByRole("button", { name: "전체 펼치기", exact: true })).toBeVisible();
      }
      await sections.first().locator("summary").click();
      await expect(output.getByRole("button", { name: "전체 펼치기", exact: true })).toHaveAttribute("aria-pressed", "false");
      const rawSource = output.locator(".research-source");
      await rawSource.locator("summary").click();
      const rawOpen = await rawSource.evaluate((element) => (element as HTMLDetailsElement).open);
      await expand.focus();
      await expand.press("Enter");
      await expect(output.locator(".research-issue-refs[open]")).toHaveCount(Math.min(count, 3));
      await expect(output.getByRole("button", { name: "전체 접기", exact: true })).toHaveAttribute("aria-pressed", "true");
      expect(await rawSource.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(rawOpen);
      await sections.first().locator("summary").focus();
      await sections.first().locator("summary").press("Space");
      await expect(output.getByRole("button", { name: "전체 펼치기", exact: true })).toHaveAttribute("aria-pressed", "false");
      await expect(output.locator(".research-issue-refs[open]")).toHaveCount(Math.min(count, 3) - 1);
      await expand.focus();
      await expand.press("Space");
      await expect(output.locator(".research-issue-refs[open]")).toHaveCount(Math.min(count, 3));
      const collapse = output.getByRole("button", { name: "전체 접기", exact: true });
      await expect(collapse).toHaveAttribute("aria-pressed", "true");
      await collapse.focus();
      await collapse.press("Enter");
      await expect(output.locator(".research-issue-refs[open]")).toHaveCount(0);
      await expect(expand).toHaveAttribute("aria-pressed", "false");
      expect(await rawSource.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(rawOpen);
      if (count === 5) {
        await expect(sections.nth(3)).toHaveAttribute("data-status", "failed");
        await expect(sections.nth(4)).toHaveAttribute("data-status", "timeout");
        await expect(sections.nth(3).locator(".research-issue-findings")).toContainText("자료 확인 실패");
        await expect(sections.nth(4).locator(".research-issue-findings")).toContainText("조회 미완료");
      }
      expect(calls).toBe([0, 1, 2, 5].indexOf(count) + 1);
      expect(await page.evaluate(() => localStorage.getItem("worklens:review-preferences:v1"))).toBe(savedPreference);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });

  test(`종합 리서치 저장된 근거 ON과 미확인 쟁점 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => localStorage.setItem("worklens:review-preferences:v1", JSON.stringify({ version: 1, preferences: { documentSource: "text", expandSources: true } })));
    await page.route("**/api/law/research", (route) => {
      const secondResult = route.request().postDataJSON().query === "두 번째 결과";
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        found: true, task: "full_research", text: "", markers: [],
        evidence: { status: "partial", articles: [], precedents: secondResult ? ["71", "72"] : ["71"],
          precedentEntries: { "71": { title: longTitle, caseNumber: "2025다71" }, "72": { title: "부당해고 여부", caseNumber: "2025다72" } },
          precedentExcerpts: { "71": longExcerpt, "72": "해고 판결 원문" },
          issues: [{ label: "퇴직금 지급", status: "found", articles: [], precedents: ["71"] },
            { label: "부당해고 여부", status: secondResult ? "found" : "none", articles: [], precedents: secondResult ? ["72"] : [] }] },
      } }) });
    });
    await page.goto("/");
    await navigateWorkspace(page, "법령");
    await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
    const form = page.getByRole("form", { name: "종합 리서치 입력" });
    const savedPreference = await page.evaluate(() => localStorage.getItem("worklens:review-preferences:v1"));
    await form.getByLabel("질문 또는 검색어").fill("퇴직금과 해고");
    await form.getByRole("button", { name: "실행", exact: true }).click();
    const output = page.locator(".legal-research .legal-analysis-output");
    await expect(output.locator(".research-issue-refs")).toHaveAttribute("open", "");
    await expect(output.locator(".research-issue-refs")).toContainText("② 원문 마지막 항도 그대로 확인한다.");
    const second = output.locator(".research-issue-evidence").nth(1);
    await expect(second.locator(".research-issue-findings")).toContainText("직접 관련 근거 미확인");
    await expect(second.locator(".research-issue-refs")).toHaveCount(0);
    await expect(second).not.toContainText("2025다71");
    await output.locator(".research-issue-refs summary").click();
    await expect(output.locator(".research-issue-refs")).not.toHaveAttribute("open", "");
    await expect(output.getByRole("button", { name: "전체 펼치기", exact: true })).toHaveAttribute("aria-pressed", "false");
    await form.getByLabel("질문 또는 검색어").fill("두 번째 결과");
    await form.getByRole("button", { name: "실행", exact: true }).click();
    await expect(output.locator(".research-issue-refs")).toHaveCount(2);
    await expect(output.locator(".research-issue-refs[open]")).toHaveCount(2);
    await expect(output.locator(".research-issue-evidence").nth(1).locator(".research-hits")).toContainText("해고 판결 원문");
    await expect(output.locator(".research-issue-evidence").first().locator(".research-hits")).not.toContainText("해고 판결 원문");
    expect(await page.evaluate(() => localStorage.getItem("worklens:review-preferences:v1"))).toBe(savedPreference);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`중복 쟁점 바로가기의 고유 대상·일시 강조·무근거 버튼 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const now = new Date("2026-10-08T00:00:00Z");
    await page.clock.install({ time: now });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let calls = 0;
    await page.route("**/api/law/research", route => {
      calls++;
      const empty = route.request().postDataJSON().query === "근거 없음";
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        found: true, task: "full_research", markers: [],
        text: `═══ 종합 리서치 ═══\n▶ AI 법령검색 결과\n지능형 법령검색 결과 (법령조문, 1건):\n\n근로기준법\n   제0023조 (해고 등의 제한)\n① 원문 법령 근거\n   시행: 2025.01.01 | 고용노동부`,
        interpretation: { original: empty ? "근거 없음" : "중복 쟁점", situation: "", facts: [], issues: [{ label: longTitle, query: "해고" }, { label: longTitle, query: "해고" }], confidence: "high" },
        evidence: { status: "matched", articles: [article], precedents: ["71"],
          precedentEntries: { "71": { title: "해고 판례", caseNumber: "2025다71" } }, precedentExcerpts: { "71": "원문 판례 근거" },
          issues: [{ label: longTitle, status: empty ? "none" : "found", articles: empty ? [] : [article], precedents: [] },
            { label: longTitle, status: empty ? "none" : "found", articles: [], precedents: empty ? [] : ["71"] }] },
      } }) });
    });
    await page.goto("/");
    await navigateWorkspace(page, "법령");
    await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
    const form = page.getByRole("form", { name: "종합 리서치 입력" });
    await form.getByLabel("질문 또는 검색어").fill("중복 쟁점");
    await form.getByRole("button", { name: "실행", exact: true }).click();
    const output = page.locator(".legal-research .legal-analysis-output");
    const sections = output.locator(".research-issue-evidence");
    await expect(sections).toHaveCount(2);
    await page.clock.pauseAt(new Date(now.getTime() + 60_000));
    await expect(sections.first()).toHaveAttribute("id", "research-issue-1");
    await expect(sections.last()).toHaveAttribute("id", "research-issue-2");
    const links = output.getByRole("navigation", { name: "쟁점 바로가기" }).getByRole("button");
    await links.first().focus();
    await links.first().press("Enter");
    await expect(sections.first().locator("h3")).toBeFocused();
    await links.last().click();
    await expect(sections.first()).not.toHaveClass(/is-focused/);
    await expect(sections.last()).toHaveClass(/is-focused/);
    await expect(sections.last().locator("h3")).toBeFocused();
    await expect(sections.last()).toBeInViewport();
    await output.screenshot({ path: `artifacts/research-issue-focus-${viewport.width}.png` });
    await page.clock.runFor(900);
    await expect(sections.last()).not.toHaveClass(/is-focus-fresh/);
    await links.last().click();
    await expect(sections.last()).toHaveClass(/is-focus-fresh/);
    await page.clock.runFor(3000);
    await expect(sections.last()).not.toHaveClass(/is-focused/);
    await expect(sections.last().locator("h3")).toContainText(longTitle);
    await output.getByRole("button", { name: "전체 펼치기", exact: true }).click();
    await expect(sections.first().locator(".research-hits")).toContainText("원문 법령 근거");
    await expect(sections.last().locator(".research-hits")).toContainText("원문 판례 근거");
    expect(calls).toBe(1);
    await form.getByLabel("질문 또는 검색어").fill("근거 없음");
    await form.getByRole("button", { name: "실행", exact: true }).click();
    await expect(output.locator(".research-issue-refs")).toHaveCount(0);
    await expect(output.locator(".research-expand")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    expect(calls).toBe(2);
  });
}
