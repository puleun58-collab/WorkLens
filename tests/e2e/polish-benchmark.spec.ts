import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createUnicodePdf } from "../fixtures";

const lines = Array.from({ length: 58 }, (_, index) => `문장 ${index + 1}의 내용을 함께 검토하기 위한 논의를 진행했습니다.`);
const pages = Array.from({ length: 8 }, (_, page) => lines.slice(page * 8, page * 8 + 8).map((text) => ({ text })));
const file = path.join(process.cwd(), "artifacts", "polish-benchmark-58.pdf");

test("measures stable 58-sentence PDF polish workload", async ({ page }) => {
  await writeFile(file, await createUnicodePdf(pages));
  const requests: number[] = [];
  const started = performance.now();
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as { kind: string; items: Array<{ id: string; text: string }> };
    expect(request.kind).toBe("polish-batch");
    requests.push(request.items.length);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 120 + 6 * request.items.length);
    await promise;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
      kind: "polish-batch",
      proposals: request.items.map(({ id, text }) => ({ id, proposal: { changed: false, revisedText: text, reasons: [] } })),
    } }) });
  });
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByText("polish-benchmark-58.pdf")).toBeVisible();
  await page.getByLabel("polish-benchmark-58.pdf 선택").check();
  await page.getByRole("button", { name: "윤문", exact: true }).click();
  const processingStarted = performance.now();
  await page.getByRole("button", { name: "윤문 실행" }).click();
  const result = page.locator(".polish-results:not(.polish-text-results)");
  await expect(result.locator(".polish-summary-line")).toContainText("변경 없음 58", { timeout: 120_000 });
  const elapsedMs = Math.round(performance.now() - processingStarted);
  const metrics = {
    phase: process.env.BENCH_PHASE ?? "unlabelled",
    candidates: 58,
    providerRequests: requests.length,
    sizes: requests,
    successfulBatches: requests.length,
    splitBatches: 0,
    retries: 0,
    rateLimited: 0,
    timeouts: 0,
    invalidOutput: 0,
    changed: 0,
    unchanged: 58,
    rejected: 0,
    failed: 0,
    elapsedMs,
    totalWithUploadMs: Math.round(performance.now() - started),
    providerDelayMs: requests.reduce((sum, size) => sum + 120 + 6 * size, 0),
  };
  console.log(`POLISH_BENCHMARK ${JSON.stringify(metrics)}`);
  expect(requests.reduce((sum, size) => sum + size, 0)).toBe(58);
});
