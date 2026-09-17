import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  acceptConsent,
  aiState,
  expect,
  fixtures,
  model,
  noticeText,
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
  waitForNewNotice,
  writeFixtures,
} from "./ai-stages";

/**
 * Functional browser-AI smoke on a real WebGPU adapter, against an already
 * cached model: Ask → grounded sources → Brief → semantic check → abstention
 * → warm reuse. Run `bun run test:ai:model` first; that run fills the shared
 * browser profile, and this one only rebuilds shaders, so its waits are
 * minutes rather than tens of minutes.
 *
 * Every stage logs its start and duration, each wait has its own deadline, and
 * a model that does not become ready fails here with the stage name and the
 * last status line instead of holding the run open.
 *
 *   bun run test:ai:smoke
 *   WORKLENS_AI_READY_TIMEOUT_MS=600000 bun run test:ai:smoke
 *   WORKLENS_AI_MODEL=Qwen2.5-1.5B-Instruct-q4f16_1-MLC bun run test:ai:smoke
 */
test.beforeAll(writeFixtures);

test("answers, briefs and reviews on a cached model and keeps evidence grounded", async ({ aiPage: page, tracker }) => {
  test.setTimeout(TIMEOUTS.ready + 6 * TIMEOUTS.generate);
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
    await page.locator('input[type="file"]').setInputFiles([fixtures.rateSheet, fixtures.deck]);
    await expect(page.locator(".file-row")).toHaveCount(2, { timeout: TIMEOUTS.document });
    // The badge is uppercased in CSS, so the text itself reads "ready".
    await expect(page.locator(".file-row .status").first()).toContainText(/ready/i, { timeout: TIMEOUTS.document });
    await page.locator(".file-row input[type='checkbox']").first().check();
  });

  measured.readyMs = await tracker.run("4. model ready", async () => {
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    if (tier) await selectTier(page, tier);
    const diagnostics = await readModelDiagnostics(page);
    measured.decision = diagnostics;
    tracker.log(`   model ${diagnostics?.modelId} context=${diagnostics?.contextWindowSize} — ${diagnostics?.reason}`);
    // A cached profile remembers the consent; a fresh one still has to take it.
    await acceptConsent(page, tracker);
    // The run action also gates on a question, so readiness is read with one typed.
    await page.getByPlaceholder("선택한 문서에서 확인할 내용을 입력하세요").fill("SEOUL 운임은 얼마인가요?");
    await page.getByRole("button", { name: "Ask 실행" }).click();
    const ms = await waitForModelReady(page, tracker, TIMEOUTS.ready);
    expect((await aiState(page)).phase).toBe("ready");
    return ms;
  });

  await tracker.run("5. Ask answer", async () => {
    await expect(page.getByText("Ask 결과를 준비했습니다.")).toBeVisible({ timeout: TIMEOUTS.generate });
    measured.askAnswer = await page.locator(".claim-row").first().innerText();
  });

  await tracker.run("6. evidence link", async () => {
    await expect(page.locator(".claim-evidence .source-action").first()).toBeVisible();
    await page.locator(".claim-evidence .source-action").first().click();
    await expect(page.getByLabel("Source detail")).toBeVisible();
    await page.getByLabel("닫기").click();
  });

  await tracker.run("7. Brief on the same model", async () => {
    await page.getByRole("button", { name: "Brief", exact: true }).click();
    await page.getByRole("button", { name: "Brief 실행" }).click();
    await expect(page.getByText("Brief 결과를 준비했습니다.")).toBeVisible({ timeout: TIMEOUTS.generate });
    measured.briefClaims = await page.locator(".claim-row").count();
  });

  await tracker.run("8. semantic check on the same model", async () => {
    const before = await noticeText(page);
    await page.getByRole("button", { name: "Check", exact: true }).click();
    // Sentence review needs sentences: the deck carries prose, the rate sheet
    // is numbers.
    await page.locator(".file-row input[type='checkbox']").nth(1).check();
    await page.getByRole("button", { name: "AI 문장 검수" }).click();
    const notice = await waitForNewNotice(page, tracker, before, TIMEOUTS.generate);
    // Two legitimate outcomes: suggestions folded into the deterministic
    // result, or abstention when the model finds nothing it can ground. What
    // is not acceptable is the engine breaking, so the model must still be
    // loaded afterwards. Pinning a suggestion count would be pinning model
    // quality, which differs per model and per run.
    measured.semanticCheck = notice;
    expect(notice).toMatch(/AI 문장 검수|근거를 찾지 못했습니다/);
    expect((await aiState(page)).phase).toBe("ready");
  });

  await tracker.run("9. unanswerable question", async () => {
    const before = await noticeText(page);
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await page.getByPlaceholder("선택한 문서에서 확인할 내용을 입력하세요").fill("2031년 파리 지사 임대료는 얼마인가요?");
    await page.getByRole("button", { name: "Ask 실행" }).click();
    // This run's own line, not the one stage 8 left on screen: accepting that
    // one passed instantly and left this generation still running.
    measured.unanswerable = await waitForNewNotice(page, tracker, before, TIMEOUTS.generate);
  });

  measured.warmAskMs = await tracker.run("10. model stays loaded for the next request", async () => {
    // The cancel affordance is not part of this run: `begin()` only publishes a
    // loading phase when the model is not ready yet, so a warm generation shows
    // no status panel and no 생성 중지. Cancelling a load belongs to the
    // download run, where that panel exists.
    const before = await noticeText(page);
    const started = Date.now();
    // Back to the sheet alone, which is where this question's answer lives.
    await page.locator(".file-row input[type='checkbox']").nth(1).uncheck();
    await page.getByPlaceholder("선택한 문서에서 확인할 내용을 입력하세요").fill("BUSAN 운임은 얼마인가요?");
    await page.getByRole("button", { name: "Ask 실행" }).click();
    const notice = await waitForNewNotice(page, tracker, before, TIMEOUTS.generate);
    // What this stage proves is that the loaded model served a second request:
    // an answer and a grounded abstention both do, a broken engine does not.
    measured.warmAskNotice = notice;
    expect(notice).toMatch(/Ask 결과를 준비했습니다|근거를 찾지 못했습니다/);
    // Still ready, never re-downloaded: the weights never left memory.
    expect((await aiState(page)).phase).toBe("ready");
    await expect(page.locator(".ai-status.loading")).toHaveCount(0);
    return Date.now() - started;
  });

  measured.stages = tracker.stages;
  await writeFile(
    path.join(process.cwd(), "artifacts", `ai-smoke-${model}.json`),
    `${JSON.stringify(measured, null, 2)}\n`,
  );
});

/**
 * The decision that cannot be retried, checked without paying for it: on a
 * memory-tight machine loading the large model takes the whole desktop down,
 * so the tier has to be settled from the device's own report while nothing is
 * allocated. This test downloads nothing.
 */
test("settles which model to load before anything is downloaded", async ({ page, tracker }) => {
  test.setTimeout(TIMEOUTS.document * 3);

  await tracker.run("1. page load", async () => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForHydration(page, TIMEOUTS.document);
  });

  const probe = await tracker.run("2. WebGPU init", () => probeWebGpu(page));
  requireWebGpu(probe, tracker);

  await tracker.run("3. model decision", async () => {
    await page.locator('input[type="file"]').setInputFiles([fixtures.rateSheet]);
    await expect(page.locator(".file-row")).toHaveCount(1, { timeout: TIMEOUTS.document });
    await page.locator(".file-row input[type='checkbox']").first().check();
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(page.locator(".app-shell")).not.toHaveAttribute("data-ai-state", "checking", { timeout: TIMEOUTS.document });

    const diagnostics = await readModelDiagnostics(page);
    expect(diagnostics, "the app exposes its model decision").not.toBeNull();
    tracker.log(`   ${diagnostics?.modelId} context=${diagnostics?.contextWindowSize} — ${diagnostics?.reason}`);
    tracker.log(`   signals: ${JSON.stringify(diagnostics?.signals)}`);

    const memoryGb = diagnostics?.signals.deviceMemoryGb;
    if (memoryGb !== undefined && memoryGb > 8) {
      // Measured headroom above the reporting clamp: the standard model stays.
      expect(diagnostics?.tier).toBe("standard");
    } else {
      // At or below the clamp the report cannot prove headroom, so the
      // smaller model is what a first run loads.
      expect(diagnostics?.tier).toBe("light");
    }
    // A context small enough that the KV cache is not what fills memory.
    expect(diagnostics?.contextWindowSize).toBeLessThanOrEqual(2_048);
    // Still waiting on the user: nothing has been fetched or allocated.
    expect((await aiState(page)).phase).toBe("awaiting-confirmation");
  });
});

/**
 * This one deliberately uses Playwright's own ephemeral context rather than
 * the shared profile: with a cached model the blocked hosts would never be
 * reached, so the download failure it asserts needs an empty cache.
 */
test("keeps the workspace usable when the model cannot be prepared", async ({ page, tracker }) => {
  test.setTimeout(TIMEOUTS.ready + TIMEOUTS.generate);

  await tracker.run("1. page load with the model hosts blocked", async () => {
    await page.route(/huggingface\.co|hf\.co|raw\.githubusercontent\.com/, (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForHydration(page, TIMEOUTS.document);
  });

  const probe = await tracker.run("2. WebGPU init", () => probeWebGpu(page));
  requireWebGpu(probe, tracker);

  await tracker.run("3. upload and parse", async () => {
    await page.locator('input[type="file"]').setInputFiles([fixtures.rateSheet]);
    await expect(page.locator(".file-row")).toHaveCount(1, { timeout: TIMEOUTS.document });
    await page.locator(".file-row input[type='checkbox']").first().check();
  });

  await tracker.run("4. download failure is reported as itself", async () => {
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    // An ephemeral context has no stored consent, so the prompt is required
    // here: accepting it is what starts the download that must fail.
    expect(await acceptConsent(page, tracker)).toBe(true);
    // The state says which failure it is; the copy test below is what the user reads.
    const shell = page.locator(".app-shell");
    await expect(shell).toHaveAttribute("data-ai-state", "failed", { timeout: TIMEOUTS.ready });
    await expect(shell).toHaveAttribute("data-ai-error", "MODEL_DOWNLOAD_FAILED");
    await expect(page.locator(".ai-status.failed")).toContainText("모델 데이터를 불러오지 못했습니다");
    await expect(page.locator(".notice.error")).toHaveCount(0);
  });

  await tracker.run("5. deterministic work still runs", async () => {
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await page.getByRole("button", { name: "Check 실행" }).click();
    await expect(page.getByText("콘텐츠 및 개인정보 점검을 완료했습니다.")).toBeVisible({ timeout: TIMEOUTS.document });
  });
});
