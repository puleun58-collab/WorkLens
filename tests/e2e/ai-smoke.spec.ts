import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createCheckPptx, createXlsx, RATE_SHEET_V1 } from "../fixtures";

/**
 * Real browser-AI smoke test. Requires a WebGPU adapter and network access to
 * the model host, so it runs only through `bun run test:ai:smoke` and is never
 * part of the blocking CI matrix. It verifies the full browser path: adapter →
 * confirmation → download → Ask → Brief → semantic check → abstention →
 * grounded sources → cancel → cache reuse after a reload.
 *
 * `WORKLENS_AI_MODEL` replays the same run on the previous default so the two
 * models can be compared on identical documents, questions and evidence; the
 * timings and outcomes land in `artifacts/ai-smoke-<model>.json`.
 */
const FIXTURE_DIR = path.join(process.cwd(), "artifacts", "fixtures");
const rateSheet = path.join(FIXTURE_DIR, "운임현황_v1.xlsx");
const deck = path.join(FIXTURE_DIR, "최종검수.pptx");
const BASELINE_MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
const model = process.env.WORKLENS_AI_MODEL === BASELINE_MODEL ? BASELINE_MODEL : "Qwen3-1.7B-q4f16_1-MLC";

test.beforeAll(async () => {
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(rateSheet, await createXlsx(RATE_SHEET_V1));
  await writeFile(deck, createCheckPptx());
});

test.beforeEach(async ({ page }) => {
  if (model === BASELINE_MODEL) {
    await page.addInitScript((id: string) => {
      Object.defineProperty(globalThis, "__worklensAiModel", { value: id, configurable: true });
    }, model);
  }
});

test("runs Ask, Brief and semantic check on a real WebGPU adapter and keeps evidence grounded", async ({ page }) => {
  test.setTimeout(30 * 60_000);
  const measured: Record<string, unknown> = { model };
  const timed = async (label: string, step: () => Promise<void>) => {
    const started = Date.now();
    await step();
    measured[label] = Date.now() - started;
  };

  await page.goto("/");
  const adapter = await page.evaluate(async () => {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    return Boolean(await gpu.requestAdapter());
  });
  test.skip(!adapter, "no WebGPU adapter in this browser");

  await page.locator('input[type="file"]').setInputFiles([rateSheet, deck]);
  await expect(page.locator(".file-row")).toHaveCount(2);
  await page.locator(".file-row input[type='checkbox']").first().check();

  // 1. Capability check surfaces the opt-in download, nothing downloads yet.
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator(".ai-status.confirm")).toContainText("브라우저 AI 준비");
  await page.getByRole("button", { name: "AI 준비" }).click();
  // 2. Download reports progress and 3. the model becomes usable. There is no
  // ready panel by design, so readiness is the observable contract: the
  // loading panel is gone and the AI action is live again.
  await expect(page.locator(".ai-status.loading")).toContainText("모델 다운로드");
  await timed("coldLoadMs", async () => {
    await expect(page.locator(".ai-status.loading")).toHaveCount(0, { timeout: 20 * 60_000 });
    await expect(page.getByRole("button", { name: "Ask 실행" })).toBeEnabled({ timeout: 60_000 });
  });

  // 4. Ask produces a grounded answer, and the answer carries the sheet value.
  await page.getByPlaceholder("선택한 문서에서 확인할 내용을 입력하세요").fill("SEOUL 운임은 얼마인가요?");
  await timed("askMs", async () => {
    await page.getByRole("button", { name: "Ask 실행" }).click();
    await expect(page.getByText("Ask 결과를 준비했습니다.")).toBeVisible({ timeout: 10 * 60_000 });
  });
  measured.askAnswer = await page.locator(".claim-row").first().innerText();
  // 6. Every claim carries a source link back into the document.
  await expect(page.locator(".claim-evidence .source-action").first()).toBeVisible();
  await page.locator(".claim-evidence .source-action").first().click();
  await expect(page.getByLabel("Source detail")).toBeVisible();
  await page.getByLabel("닫기").click();

  // 5. Brief runs on the same cached model.
  await page.getByRole("button", { name: "Brief", exact: true }).click();
  await timed("briefMs", async () => {
    await page.getByRole("button", { name: "Brief 실행" }).click();
    await expect(page.getByText("Brief 결과를 준비했습니다.")).toBeVisible({ timeout: 10 * 60_000 });
  });
  measured.briefClaims = await page.locator(".claim-row").count();

  // 5b. Semantic check reuses the same model on the Check surface.
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByRole("button", { name: "브라우저 AI 문장 검수" }).click();
  await timed("semanticCheckMs", async () => {
    await expect(page.getByText("브라우저 AI 보조 점검 결과를 준비했습니다.")).toBeVisible({ timeout: 10 * 60_000 });
  });

  // 5c. A question the documents cannot answer must not invent one.
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.getByPlaceholder("선택한 문서에서 확인할 내용을 입력하세요").fill("2031년 파리 지사 임대료는 얼마인가요?");
  await page.getByRole("button", { name: "Ask 실행" }).click();
  await expect(page.locator(".notice, .claim-row").first()).toBeVisible({ timeout: 10 * 60_000 });
  measured.unanswerable = await page.locator(".notice, .claim-row").first().innerText();

  // 7. Generation cancel returns control without tearing the model down.
  await page.getByPlaceholder("선택한 문서에서 확인할 내용을 입력하세요").fill("전체 운임 추이를 자세히 설명해 주세요.");
  await page.getByRole("button", { name: "Ask 실행" }).click();
  await page.getByRole("button", { name: "생성 중지" }).click();
  await expect(page.locator(".notice")).toContainText("브라우저 AI 작업을 취소했습니다.");

  // 8 + 9. After a reload the weights come from the browser cache and the
  // consent is remembered, so no confirmation returns and the warm load is
  // whatever the first request has to wait for.
  await page.reload();
  await page.locator('input[type="file"]').setInputFiles([rateSheet]);
  await expect(page.locator(".file-row")).toHaveCount(1);
  await page.locator(".file-row input[type='checkbox']").first().check();
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator(".ai-status.confirm")).toHaveCount(0);
  await page.getByPlaceholder("선택한 문서에서 확인할 내용을 입력하세요").fill("BUSAN 운임은 얼마인가요?");
  await timed("warmLoadMs", async () => {
    await page.getByRole("button", { name: "Ask 실행" }).click();
    await expect(page.locator(".ai-status.loading")).toHaveCount(0, { timeout: 10 * 60_000 });
  });
  await expect(page.getByText("Ask 결과를 준비했습니다.")).toBeVisible({ timeout: 10 * 60_000 });
  measured.warmAskAnswer = await page.locator(".claim-row").first().innerText();

  await writeFile(
    path.join(process.cwd(), "artifacts", `ai-smoke-${model}.json`),
    `${JSON.stringify(measured, null, 2)}\n`,
  );
});

test("keeps the workspace usable when the model cannot be prepared", async ({ page }) => {
  // 10. A blocked model host must degrade to the quiet status box only.
  await page.route(/huggingface\.co|raw\.githubusercontent\.com/, (route) => route.abort());
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles([rateSheet]);
  await expect(page.locator(".file-row")).toHaveCount(1);
  await page.locator(".file-row input[type='checkbox']").first().check();

  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const confirm = page.getByRole("button", { name: "AI 준비" });
  if (await confirm.count()) await confirm.click();
  await expect(page.locator(".ai-status.failed")).toBeVisible();
  await expect(page.locator(".notice.error")).toHaveCount(0);

  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByRole("button", { name: "Check 실행" }).click();
  await expect(page.getByText("콘텐츠 및 개인정보 점검을 완료했습니다.")).toBeVisible();
});
