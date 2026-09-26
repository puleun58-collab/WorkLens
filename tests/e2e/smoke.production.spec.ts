import { expect, test, type Response } from "@playwright/test";
import { createCheckPptx } from "../fixtures";

const smokeUrl = process.env.WORKLENS_SMOKE_URL;

test.skip(!smokeUrl, "WORKLENS_SMOKE_URL is required for the deployed-environment smoke test.");

function isMainAsset(response: Response) {
  const resourceType = response.request().resourceType();
  return response.url().includes("/_next/static/") && (resourceType === "script" || resourceType === "stylesheet");
}

test("loads the deployed workspace and runs browser-only Check", async ({ page }) => {
  const responses: Response[] = [];
  page.on("response", (response) => responses.push(response));
  await page.route("**/api/ai", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: { kind: "claims", claims: [] } }),
  }));

  const documentResponse = await page.goto("/");
  expect(documentResponse?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "작업 파일" })).toBeVisible();
  // The file input's handler exists only after hydration.
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");

  await expect.poll(() => responses.filter(isMainAsset).length).toBeGreaterThan(0);
  for (const response of responses.filter(isMainAsset)) {
    expect(response.status(), response.url()).toBe(200);
    await expect(response.headerValue("content-type"), response.url()).resolves.toMatch(/(?:javascript|css)/i);
  }
  const icon = await page.request.get("/icon.svg");
  expect(icon.status()).toBe(200);
  expect(icon.headers()["content-type"]).toMatch(/image\/svg\+xml/i);

  // Files and results live only in browser memory, so this generated input leaves no server-side state to clean up.
  await page.locator('input[type="file"]').setInputFiles({
    name: "smoke-check.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(createCheckPptx()),
  });
  await expect(page.locator(".file-row").filter({ hasText: "smoke-check.pptx" })).toBeVisible();
  await page.getByLabel("smoke-check.pptx 선택").check();
  await page.getByRole("button", { name: "검수", exact: true }).click();
  await page.getByRole("button", { name: "검수 실행" }).click();
  await expect(page.locator(".check-issue").first()).toBeVisible();
  const finding = page.locator(".check-issue").first();
  expect(await finding.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 255, 255)");
  expect(await finding.locator(".check-recommendation").evaluate((element) =>
    getComputedStyle(element).backgroundColor)).toBe("rgb(245, 249, 255)");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const order = await finding.locator(".check-recommendation, .check-source").evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().top));
  expect(order[0]).toBeLessThan(order[1]);
});
