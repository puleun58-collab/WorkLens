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

    const documentResponse = await page.goto("/");
    expect(documentResponse?.status()).toBe(200);
    await expect(page).toHaveTitle(/WorkLens/);
    await expect(page.getByRole("heading", { name: "분석 파일" })).toBeVisible();

    await expect.poll(() => responses.filter(isMainAsset).length).toBeGreaterThan(0);
    for (const response of responses.filter(isMainAsset)) await expectSaneStaticAsset(response);
    const icon = await page.request.get("/icon.svg");
    const favicon = await page.request.get("/favicon.ico");
    expect(icon.status()).toBe(200);
    expect(icon.headers()["content-type"]).toMatch(/image\/svg\+xml/i);
    expect(favicon.status()).toBe(200);
    expect(favicon.headers()["content-type"]).toMatch(/(?:image\/x-icon|image\/vnd\.microsoft\.icon|image\/icon)/i);
    const font = await page.request.get("/fonts/pretendard/PretendardVariable.woff2");
    expect(font.status()).toBe(200);
    expect(font.headers()["content-type"]).toMatch(/font\/woff2|application\/octet-stream/i);
    await expect(page.evaluate(() => document.fonts.check('16px "Pretendard Variable"'))).resolves.toBe(true);

    await upload(page, files.v1);
    await page.getByLabel("cloudflare-rate-v1.xlsx 선택").check();
    await page.getByRole("button", { name: "Analyze", exact: true }).click();
    await page.getByRole("button", { name: "Analyze 실행" }).click();
    await expect(page.getByText("구조 및 수치 분석을 완료했습니다.")).toBeVisible();
    await expect(page.locator(".results-panel .numeric").first()).toBeVisible();

    await upload(page, files.check);
    await page.getByLabel("cloudflare-check.pptx 선택").check();
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await page.getByRole("button", { name: "Check 실행" }).click();
    const finding = page.locator(".check-issue").first();
    await expect(finding).toBeVisible();
    const source = finding.locator(".source-link").first();
    await expect(source).toBeVisible();
    await source.click();
    await expect(page.getByLabel("Source detail")).toBeVisible();
    await page.getByLabel("닫기").click();

    await page.getByLabel("cloudflare-check.pptx 선택").uncheck();
    await upload(page, files.v2);
    await page.getByLabel("cloudflare-rate-v2.xlsx 선택").check();
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await page.getByRole("button", { name: "Compare 실행" }).click();
    await expect(page.getByTestId("change-row").first()).toBeVisible();

    await page.getByRole("button", { name: "Extract", exact: true }).click();
    await page.getByRole("button", { name: "Extract 실행" }).click();
    await expect(page.locator(".extract-table").first()).toBeVisible();

    await page.reload();
    await expect(page.getByText("아직 파일이 없습니다.", { exact: false })).toBeVisible();
    await expect(page.locator(".results-panel")).toHaveCount(0);
    expect(failedResponses).toEqual([]);
  });
});
