import { expect, test, type Page } from "@playwright/test";
import { createPdf, createXlsx } from "../fixtures";

const policy = "Travel regulations require approval before reimbursing exceptions.";
const review = "The compliance team reviews exceptions quarterly and reports issues.";

async function upload(page: Page, name: string, buffer: Uint8Array, mimeType: string) {
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType, buffer: Buffer.from(buffer) });
  const row = page.locator(".file-row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("checkbox").check();
}

async function runAnalyze(page: Page) {
  await page.getByRole("button", { name: "분석", exact: true }).click();
  await page.getByRole("button", { name: "분석 실행" }).click();
  const panel = page.locator(".results-panel");
  await expect(panel.getByRole("heading", { name: "분석 결과" })).toBeVisible();
  return panel;
}

test("analyzes generated regulation and workbook within one aligned result surface", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/ai", async (route) => {
    const body = route.request().postDataJSON() as {
      request: { operation: string };
      items: Array<{ handle: string; text: string }>;
    };
    expect(body.request.operation).toBe("analyze");
    requests += 1;
    const evidence = body.items.find((item) => item.text.includes(policy));
    const reviewEvidence = body.items.find((item) => item.text.includes(review));
    if (!evidence || !reviewEvidence) throw new Error("Generated regulation evidence was not shortlisted.");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { kind: "claims", claims: [
        { text: policy, handles: [evidence.handle], confidence: "high", presentation: { role: "summary" } },
        { text: review, handles: [reviewEvidence.handle], confidence: "low", presentation: { role: "insight" } },
      ] } }),
    });
  });
  await page.goto("/");
  await upload(page, "Travel regulation.pdf", await createPdf([policy, review]), "application/pdf");
  await upload(page, "Travel budget.xlsx", await createXlsx({ Budget: [
    ["항목", "값"], ["총예산", "64,550원"], ["확정 지출", "12,400원"],
  ] }), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const panel = await runAnalyze(page);
  await expect(panel.locator(".result-status")).toHaveText("분석 완료");
  await expect(panel.locator(".analysis-summary-section")).toContainText(policy);
  await expect(panel.locator(".analysis-concern-section")).toContainText(review);
  await expect(panel.locator(".analysis-insight-section")).toHaveCount(0);
  await expect(panel.locator(".analysis-metric-table tbody tr").first()).toBeVisible();
  await expect(panel.getByRole("table").getByRole("columnheader", { name: "근거" })).toBeVisible();
  await expect(panel.getByRole("table").getByRole("rowheader", { name: "총예산" })).toBeVisible();
  await expect(panel.locator(".analysis-report .status-panel")).toHaveCount(0);
  await expect(panel.locator(".analysis-report .panel")).toHaveCount(0);
  expect(requests).toBe(1);

  const headings = await panel.locator(".analysis-report-section h3").allTextContents();
  expect(headings[0]).toBe("핵심 요약");
  expect(headings.indexOf("확인된 수치")).toBeGreaterThan(headings.indexOf("핵심 요약"));
  const desktop = await panel.evaluate((root) => {
    const heading = root.querySelector(".result-heading h2")!.getBoundingClientRect();
    const summary = root.querySelector(".analysis-summary-section h3")!.getBoundingClientRect();
    const count = root.querySelector(".analysis-summary-section .subsection-heading span")!.getBoundingClientRect();
    const status = root.querySelector(".result-status")!.getBoundingClientRect();
    const report = root.querySelector(".analysis-report")!;
    return { left: Math.abs(heading.left - summary.left), right: Math.abs(status.right - count.right), surface: getComputedStyle(report).backgroundColor };
  });
  expect(desktop.left).toBeLessThanOrEqual(1);
  expect(desktop.right).toBeLessThanOrEqual(1);
  expect(desktop.surface).toBe("rgb(255, 255, 255)");

  const source = panel.locator(".analysis-summary-section .source-action").first();
  await source.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("complementary", { name: "근거 상세" });
  await expect(drawer).toContainText("Travel regulation.pdf");
  await expect(drawer).toContainText("Page 1");
  await drawer.getByRole("button", { name: "닫기" }).click();
  await expect(source).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.locator(".analysis-metric-table")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const mobile = await panel.evaluate((root) => ({
    heading: root.querySelector(".result-heading h2")!.getBoundingClientRect().left,
    summary: root.querySelector(".analysis-summary-section h3")!.getBoundingClientRect().left,
  }));
  expect(Math.abs(mobile.heading - mobile.summary)).toBeLessThanOrEqual(1);
});

test("keeps separate workbook values while grounding their comparison across files", async ({ page }) => {
  await page.route("**/api/ai", async (route) => {
    const body = route.request().postDataJSON() as {
      items: Array<{ handle: string; text: string }>;
    };
    const previous = body.items.find(({ text }) => /전환율.*Q2.*18/u.test(text));
    const current = body.items.find(({ text }) => /전환율.*Q2.*24/u.test(text));
    if (!previous || !current) throw new Error("Both workbook values must be available as evidence.");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { kind: "claims", claims: [{
        text: "Q2 전환율은 이전 보고서 18 대비 현재 보고서 24로 증가했습니다.",
        handles: [previous.handle, current.handle],
        confidence: "high",
        presentation: { role: "insight" },
      }] } }),
    });
  });
  await page.goto("/");
  await upload(page, "Prior KPI.xlsx", await createXlsx({ KPI: [["KPI", "Q2"], ["전환율", 18]] }),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await upload(page, "Current KPI.xlsx", await createXlsx({ KPI: [["KPI", "Q2"], ["전환율", 24]] }),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const panel = await runAnalyze(page);
  await expect(panel.locator(".analysis-metric-table")).toContainText("Prior KPI.xlsx");
  await expect(panel.locator(".analysis-metric-table")).toContainText("Current KPI.xlsx");
  await expect(panel.locator(".analysis-insight-section")).toContainText(/18.*24.*증가/u);
  await panel.locator(".analysis-insight-section .source-action").click();
  const drawer = page.getByRole("complementary", { name: "근거 상세" });
  await expect(drawer).toContainText("Prior KPI.xlsx");
  await expect(drawer).toContainText("Current KPI.xlsx");
});

test("retains grounded local results and places a rate-limit warning last", async ({ page }) => {
  await page.route("**/api/ai", (route) => route.fulfill({
    status: 429,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "AI_RATE_LIMITED" } }),
  }));
  await page.goto("/");
  await upload(page, "Exception regulation.pdf", await createPdf([policy, review]), "application/pdf");
  const panel = await runAnalyze(page);
  await expect(panel.locator(".result-status")).toHaveText("기본 분석 완료");
  await expect(panel.locator(".result-status")).toHaveClass(/warning/);
  await expect(panel.locator(".analysis-summary-section")).toHaveCount(0);
  await expect(panel.locator(".analysis-insight-section")).toHaveCount(0);
  await expect(panel.locator(".analysis-core-items-section .analysis-reading-row").first()).toBeVisible();
  await expect(panel.locator(".result-inline-warning")).toHaveCount(1);
  await expect(panel.locator(".analysis-warning-section .result-inline-warning")).toBeVisible();
  await expect(panel.locator(".analysis-report-section").last()).toHaveClass(/analysis-warning-section/);
  await expect(panel.locator(".analysis-report .status-panel")).toHaveCount(0);
  const source = panel.locator(".analysis-core-items-section .source-action").first();
  await source.click();
  await expect(page.getByRole("complementary", { name: "근거 상세" })).toContainText("Exception regulation.pdf");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
