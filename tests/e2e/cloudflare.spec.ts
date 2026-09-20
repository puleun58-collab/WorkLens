import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page, type Response } from "@playwright/test";
import { createCheckPptx, createXlsx, RATE_SHEET_V1, RATE_SHEET_V2 } from "../fixtures";

const FIXTURE_DIR = path.join(process.cwd(), "artifacts", "fixtures", "cloudflare");
const files = {
  v1: path.join(FIXTURE_DIR, "cloudflare-rate-v1.xlsx"),
  v2: path.join(FIXTURE_DIR, "cloudflare-rate-v2.xlsx"),
  check: path.join(FIXTURE_DIR, "cloudflare-check.pptx"),
};

function fileRow(page: Page, filePath: string) {
  return page.locator(".file-row").filter({ hasText: path.basename(filePath) });
}

async function upload(page: Page, filePath: string) {
  await page.locator('input[type="file"]').setInputFiles(filePath);
  await expect(fileRow(page, filePath)).toBeVisible();
}

function isMainAsset(response: Response) {
  const resourceType = response.request().resourceType();
  return response.url().includes("/_next/static/") && (resourceType === "script" || resourceType === "stylesheet");
}

function expectSaneStaticAsset(response: Response) {
  expect(response.status(), response.url()).toBe(200);
  expect(response.headerValue("content-type"), response.url()).resolves.toMatch(/(?:javascript|css|svg|image\/x-icon|icon)/i);
}

test.describe("Cloudflare Worker production build", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await mkdir(FIXTURE_DIR, { recursive: true });
    await writeFile(files.v1, await createXlsx(RATE_SHEET_V1));
    await writeFile(files.v2, await createXlsx(RATE_SHEET_V2));
    await writeFile(files.check, createCheckPptx());
  });

  test("serves the full in-browser workspace from wrangler without failed requests", async ({ page }) => {
    const responses: Response[] = [];
    const failedResponses: string[] = [];
    page.on("response", (response) => {
      responses.push(response);
      if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
    });
    await page.route("**/api/ai", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { kind: "claims", claims: [] } }),
      });
    });

    const documentResponse = await page.goto("/");
    expect(documentResponse?.status()).toBe(200);
    await expect(page).toHaveTitle(/WorkLens/);
    await expect(page.getByRole("heading", { name: "작업 파일" })).toBeVisible();

    await expect.poll(() => responses.filter(isMainAsset).length).toBeGreaterThan(0);
    for (const response of responses.filter(isMainAsset)) await expectSaneStaticAsset(response);
    const icon = await page.request.get("/icon.svg");
    const favicon = await page.request.get("/favicon.ico");
    expect(icon.status()).toBe(200);
    expect(icon.headers()["content-type"]).toMatch(/image\/svg\+xml/i);
    expect(favicon.status()).toBe(200);
    expect(favicon.headers()["content-type"]).toMatch(/(?:image\/x-icon|image\/vnd\.microsoft\.icon|image\/icon)/i);
    const subset = await page.request.get("/fonts/pretendard/woff2-dynamic-subset/PretendardVariable.subset.0.woff2");
    expect(subset.status()).toBe(200);
    await expect(page.evaluate(() => document.fonts.check('16px "Pretendard Variable"'))).resolves.toBe(true);

    // No files: upload owns the workspace; the only add action lives inside it.
    await expect(page.locator(".dropzone")).toBeVisible();
    await expect(page.locator(".dropzone").getByRole("button", { name: "파일 추가" })).toHaveCount(1);
    await expect(page.locator(".context-actions").getByRole("button", { name: "파일 추가" })).toHaveCount(0);

    // Central company dictionary is readable by every user.
    const companyTerms = await page.request.get("/api/company-terms");
    expect(companyTerms.status()).toBe(200);
    const termsPayload = await companyTerms.json();
    expect(Array.isArray(termsPayload.data.terms)).toBe(true);
    expect(termsPayload.data.terms.length).toBeGreaterThan(0);

    // Admin mutations require a session, not just a hidden UI.
    const unauthorized = await page.request.post("/api/admin/company-terms", {
      data: { term: "Unauthorized" },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(unauthorized.status()).toBe(401);

    await upload(page, files.v1);
    // With files present the workspace leads and the add action moves to the bar.
    await expect(page.locator(".dropzone")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "파일 추가" })).toBeVisible();
    await page.getByLabel("cloudflare-rate-v1.xlsx 선택").check();
    await page.getByRole("button", { name: "분석", exact: true }).click();
    await page.getByRole("button", { name: "분석 실행" }).click();
    await expect(page.locator(".results-panel .result-status")).toHaveText("분석 완료");
    await expect(page.locator(".results-panel .numeric").first()).toBeVisible();

    await upload(page, files.check);
    await page.getByLabel("cloudflare-check.pptx 선택").check();
    await page.getByRole("button", { name: "검수", exact: true }).click();
    await page.getByRole("button", { name: "검수 실행" }).click();
    const finding = page.locator(".check-issue").first();
    await expect(finding).toBeVisible();
    const source = finding.locator(".source-action").first();
    await expect(source).toBeVisible();
    await source.click();
    await expect(page.getByLabel("근거 상세")).toBeVisible();
    await page.getByLabel("닫기").click();

    await page.getByLabel("cloudflare-check.pptx 선택").uncheck();
    await upload(page, files.v2);
    await page.getByLabel("cloudflare-rate-v2.xlsx 선택").check();
    await page.getByRole("button", { name: "비교", exact: true }).click();
    await page.getByRole("button", { name: "비교 실행" }).click();
    await expect(page.getByTestId("change-row").first()).toBeVisible();

    await page.getByRole("button", { name: "추출", exact: true }).click();
    await page.getByRole("button", { name: "추출 실행" }).click();
    // Automatic extraction reports its own count even when a sheet holds only
    // records; either a structured row or the "nothing to structure" panel is
    // the correct production outcome.
    await expect(page.locator(".results-panel .check-summary-line, .results-panel .status-panel")).not.toHaveCount(0);

    await page.reload();
    await expect(page.locator(".dropzone")).toBeVisible();
    await expect(page.getByRole("heading", { name: "작업 파일" }).locator("..")).toContainText("0");
    await expect(page.locator(".results-panel")).toHaveCount(0);
    expect(failedResponses).toEqual([]);
  });
});
