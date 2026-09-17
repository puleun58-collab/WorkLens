import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  acceptConsent,
  clearProfile,
  expect,
  fixtures,
  model,
  profileDir,
  probeWebGpu,
  readModelDiagnostics,
  requireWebGpu,
  selectTier,
  test,
  tier,
  TIMEOUTS,
  waitForHydration,
  waitForModelReady,
  writeFixtures,
} from "./ai-stages";

/**
 * First-run model download, on a real WebGPU adapter.
 *
 * This is the only run that pays for the network: it starts from an empty
 * browser profile, takes the opt-in, watches the progress panel and then
 * proves the weights are reused from the browser cache after a reload. The
 * functional smoke (`ai-smoke.spec.ts`) reads the profile this run leaves
 * behind, so it never downloads anything.
 *
 *   bun run test:ai:model                                  # shipped model
 *   WORKLENS_AI_MODEL=Qwen2.5-1.5B-Instruct-q4f16_1-MLC bun run test:ai:model
 *   WORKLENS_AI_DOWNLOAD_TIMEOUT_MS=900000 bun run test:ai:model
 */
test.beforeAll(async () => {
  await writeFixtures();
  // A first run means a first run: no cached weights, no remembered consent.
  await clearProfile();
});

test("downloads the model once and then serves it from the browser cache", async ({ aiPage: page, tracker }) => {
  test.setTimeout(TIMEOUTS.download + 5 * 60_000);
  const measured: Record<string, unknown> = { model, profile: profileDir() };

  await tracker.run("1. page load", async () => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForHydration(page, TIMEOUTS.document);
  });

  const probe = await tracker.run("2. WebGPU init", async () => {
    const result = await probeWebGpu(page);
    tracker.log(`   navigator.gpu=${result.navigatorGpu} adapter=${result.adapter} device=${result.device}`);
    return result;
  });
  measured.webgpu = probe;
  requireWebGpu(probe, tracker);

  await tracker.run("3. upload and parse", async () => {
    await page.locator('input[type="file"]').setInputFiles([fixtures.rateSheet]);
    await expect(page.locator(".file-row")).toHaveCount(1, { timeout: TIMEOUTS.document });
    // The badge is uppercased in CSS, so the text itself reads "ready".
    await expect(page.locator(".file-row .status")).toContainText(/ready/i, { timeout: TIMEOUTS.document });
    await page.locator(".file-row input[type='checkbox']").first().check();
  });

  await tracker.run("4. consent prompt", async () => {
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    // The tier is settled before a byte is fetched: WORKLENS_AI_TIER names it,
    // otherwise the app's own conservative decision stands.
    if (tier) await selectTier(page, tier);
    const diagnostics = await readModelDiagnostics(page);
    measured.decision = diagnostics;
    tracker.log(`   model ${diagnostics?.modelId} context=${diagnostics?.contextWindowSize} — ${diagnostics?.reason}`);
    // Nothing is downloaded before the user accepts, and the prompt is drawn
    // only once the WebGPU probe resolves.
    expect(await acceptConsent(page, tracker)).toBe(true);
    // The download really started: the phase says so, not the sentence.
    await expect(page.locator(".app-shell")).toHaveAttribute("data-ai-state", "loading", { timeout: TIMEOUTS.document });
  });

  measured.downloadMs = await tracker.run("5. model ready (cold download)", () =>
    waitForModelReady(page, tracker, TIMEOUTS.download));

  measured.cachedReadyMs = await tracker.run("6. model ready from cache after reload", async () => {
    await page.reload();
    await page.locator('input[type="file"]').setInputFiles([fixtures.rateSheet]);
    await expect(page.locator(".file-row")).toHaveCount(1, { timeout: TIMEOUTS.document });
    await page.locator(".file-row input[type='checkbox']").first().check();
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    // Consent survives a reload, so the second run goes straight to loading.
    expect(await acceptConsent(page, tracker, 3_000)).toBe(false);
    await page.getByPlaceholder("선택한 문서에서 확인할 내용을 입력하세요").fill("SEOUL 운임은 얼마인가요?");
    await page.getByRole("button", { name: "Ask 실행" }).click();
    return waitForModelReady(page, tracker, TIMEOUTS.ready);
  });

  await tracker.run("7. first answer", async () => {
    await expect(page.getByText("Ask 결과를 준비했습니다.")).toBeVisible({ timeout: TIMEOUTS.generate });
    measured.answer = await page.locator(".claim-row").first().innerText();
  });

  measured.stages = tracker.stages;
  await writeFile(
    path.join(process.cwd(), "artifacts", `ai-model-download-${model}.json`),
    `${JSON.stringify(measured, null, 2)}\n`,
  );
});
