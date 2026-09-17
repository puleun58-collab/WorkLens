import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, test as base, type Page, type TestInfo } from "@playwright/test";
import { createCheckPptx, createXlsx, RATE_SHEET_V1 } from "../fixtures";

/**
 * Shared harness for the two real-WebGPU runs: the one-time model download
 * (`ai-model-download.spec.ts`) and the cached functional smoke
 * (`ai-smoke.spec.ts`).
 *
 * Both are staged and bounded. Every step logs when it starts and how long it
 * took, each wait carries its own deadline, and waiting on the model stops the
 * moment the UI reports a failure instead of sitting out the whole timeout —
 * a run that cannot prepare the model says which stage it died in and exits.
 */

export const BASELINE_MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
export const SHIPPED_MODEL = "Qwen3.5-4B-q4f16_1-MLC";
export const model = process.env.WORKLENS_AI_MODEL === BASELINE_MODEL ? BASELINE_MODEL : SHIPPED_MODEL;

/** Every wait is overridable, because a cold download and a cached load differ by minutes. */
function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const TIMEOUTS = {
  /** First run: weights, tokenizer and the WebGPU runtime library come over the network. */
  download: envMs("WORKLENS_AI_DOWNLOAD_TIMEOUT_MS", 25 * 60_000),
  /** Cached run: weights come from the browser cache, only shaders are rebuilt. */
  ready: envMs("WORKLENS_AI_READY_TIMEOUT_MS", 5 * 60_000),
  /** One generation on an integrated GPU. */
  generate: envMs("WORKLENS_AI_GENERATE_TIMEOUT_MS", 6 * 60_000),
  /** Deterministic browser work: upload, parse, Check. */
  document: envMs("WORKLENS_AI_DOCUMENT_TIMEOUT_MS", 60_000),
} as const;

const FIXTURE_DIR = path.join(process.cwd(), "artifacts", "fixtures");
export const fixtures = {
  rateSheet: path.join(FIXTURE_DIR, "운임현황_v1.xlsx"),
  deck: path.join(FIXTURE_DIR, "최종검수.pptx"),
};

export async function writeFixtures(): Promise<void> {
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(fixtures.rateSheet, await createXlsx(RATE_SHEET_V1));
  await writeFile(fixtures.deck, createCheckPptx());
}

/**
 * The model cache lives in the Cache API, which belongs to the browser
 * profile, so the two runs share one on-disk profile: the download run fills
 * it and the smoke run reads it. Playwright's default context is ephemeral and
 * could never reuse a downloaded model.
 */
export function profileDir(): string {
  return process.env.WORKLENS_AI_PROFILE
    ?? path.join(process.cwd(), ".playwright-tmp", `ai-model-cache-${model}`);
}

export async function clearProfile(): Promise<void> {
  await rm(profileDir(), { recursive: true, force: true });
}

export interface StageLog {
  stage: string;
  ms: number;
}

/** Start/finish lines per stage, plus the stage name on the way out of a failure. */
export class StageTracker {
  readonly stages: StageLog[] = [];
  private readonly startedAt = Date.now();

  constructor(private readonly title: string) {}

  private elapsed(): string {
    return `t+${((Date.now() - this.startedAt) / 1000).toFixed(1)}s`;
  }

  log(message: string): void {
    console.info(`[ai:${this.title}] ${this.elapsed()} ${message}`);
  }

  async run<T>(stage: string, step: () => Promise<T>): Promise<T> {
    this.log(`▶ ${stage}`);
    const started = Date.now();
    try {
      const value = await step();
      const ms = Date.now() - started;
      this.stages.push({ stage, ms });
      this.log(`✓ ${stage} in ${ms}ms`);
      return value;
    } catch (error) {
      const ms = Date.now() - started;
      this.stages.push({ stage: `${stage} (failed)`, ms });
      this.log(`✗ ${stage} failed after ${ms}ms`);
      this.log(`   completed stages: ${this.summary() || "none"}`);
      throw error instanceof Error
        ? new Error(`stage "${stage}" failed after ${ms}ms: ${error.message}`, { cause: error })
        : error;
    }
  }

  summary(): string {
    return this.stages.map(({ stage, ms }) => `${stage}=${ms}ms`).join(", ");
  }
}

/** Minimal WebGPU surface; the project does not depend on `@webgpu/types`. */
interface ProbeDevice { destroy(): void }
interface ProbeAdapter { requestDevice(): Promise<ProbeDevice> }
interface ProbeGpu { requestAdapter(): Promise<ProbeAdapter | null> }

export interface WebGpuProbe {
  navigatorGpu: boolean;
  adapter: boolean;
  device: string;
}

/** Stage 2 as its own report: presence, adapter, device, each named separately. */
export async function probeWebGpu(page: Page): Promise<WebGpuProbe> {
  return page.evaluate(async () => {
    const gpu: ProbeGpu | undefined = Reflect.get(navigator, "gpu");
    if (!gpu) return { navigatorGpu: false, adapter: false, device: "no navigator.gpu" };
    const adapter = await gpu.requestAdapter().catch(() => null);
    if (!adapter) return { navigatorGpu: true, adapter: false, device: "no adapter" };
    try {
      const device = await adapter.requestDevice();
      device.destroy();
      return { navigatorGpu: true, adapter: true, device: "ok" };
    } catch (error) {
      return { navigatorGpu: true, adapter: true, device: `failed: ${String(error).slice(0, 120)}` };
    }
  });
}

/**
 * The upload input is server-rendered, so setting files on it before React has
 * hydrated drops the change event and nothing is ever parsed. A cold load of a
 * deployment is slow enough for that race to be the normal case, so every run
 * waits for the handler to exist rather than for the markup.
 */
export async function waitForHydration(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(() => {
    const input = document.querySelector("input.file-input");
    return Boolean(input) && Object.keys(input ?? {}).some((key) => key.startsWith("__react"));
  }, undefined, { timeout: timeoutMs });
}

/** The completion line a feature writes when its run finishes. */
export async function noticeText(page: Page): Promise<string> {
  const notice = page.locator(".notice");
  if (await notice.count() === 0) return "";
  return (await notice.first().innerText()).replaceAll("\n", " ").replace(/\s+/g, " ").trim();
}

/**
 * Waits for *this* run's notice rather than any notice on screen: a stage that
 * accepted the previous stage's line passed instantly and left the next stage
 * clicking into a generation that was still running.
 */
export async function waitForNewNotice(
  page: Page,
  tracker: StageTracker,
  previous: string,
  timeoutMs: number,
): Promise<string> {
  const started = Date.now();
  for (;;) {
    const current = await noticeText(page);
    if (current && current !== previous) {
      tracker.log(`   notice: ${current.slice(0, 160)}`);
      return current;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`no new notice within ${timeoutMs}ms; last: ${current || "none"}`);
    }
    await page.waitForTimeout(500);
  }
}

/**
 * Takes the one-time download consent when it is offered. The prompt is drawn
 * after the WebGPU probe resolves, so a bare `count()` right after opening the
 * tab reads zero and silently skips it — which leaves the run sitting on the
 * prompt with no model ever loading.
 */
export async function acceptConsent(page: Page, tracker: StageTracker, timeoutMs = 20_000): Promise<boolean> {
  const consent = page.getByRole("button", { name: "사용 시작" });
  const offered = await consent.waitFor({ state: "visible", timeout: timeoutMs }).then(() => true).catch(() => false);
  if (!offered) {
    tracker.log("   consent already remembered by this profile");
    return false;
  }
  tracker.log("   consent offered; accepting the one-time download");
  await consent.click();
  return true;
}

/** The status box wording for a state the run cannot recover from. */
const FATAL_STATUS = /못했습니다|어렵습니다|사용할 수 없습니다/;

/**
 * Waits for the model to become usable. There is no ready panel by design, so
 * readiness is the absence of a status panel; a failure panel ends the wait
 * immediately, and a timeout reports the last progress line it saw.
 */
export async function waitForModelReady(
  page: Page,
  tracker: StageTracker,
  timeoutMs: number,
): Promise<number> {
  const started = Date.now();
  let last = "";
  for (;;) {
    const panels = await page.locator(".ai-status").allInnerTexts();
    const text = panels.join(" | ").replaceAll("\n", " ").replace(/\s+/g, " ").trim();
    if (text && text !== last) {
      tracker.log(`   status: ${text.slice(0, 160)}`);
      last = text;
    }
    if (FATAL_STATUS.test(text)) {
      throw new Error(`model preparation reported a failure: ${text.slice(0, 300)}`);
    }
    if (panels.length === 0) return Date.now() - started;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`model not ready within ${timeoutMs}ms; last status: ${last || "none"}`);
    }
    await page.waitForTimeout(1_000);
  }
}

/**
 * A page on the shared profile, with the console and failed requests of both
 * the page and its workers printed, so a failure is diagnosed from the run's
 * own log instead of a rerun.
 */
export const test = base.extend<{ aiPage: Page; tracker: StageTracker }>({
  tracker: async ({}, use, testInfo: TestInfo) => {
    const tracker = new StageTracker(testInfo.title.split(" ").slice(0, 3).join(" "));
    await use(tracker);
    tracker.log(`stages: ${tracker.summary() || "none"}`);
  },
  aiPage: async ({}, use, testInfo: TestInfo) => {
    const context = await chromium.launchPersistentContext(profileDir(), {
      headless: false,
      viewport: { width: 1440, height: 900 },
      args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
      baseURL: testInfo.project.use.baseURL,
    });
    const page = context.pages()[0] ?? (await context.newPage());
    page.on("console", (message) => {
      const text = message.text();
      if (message.type() === "error" || text.startsWith("[AI]")) {
        console.info(`  [console:${message.type()}] ${text.slice(0, 240)}`);
      }
    });
    page.on("pageerror", (error) => console.info(`  [pageerror] ${error.message.slice(0, 240)}`));
    page.on("requestfailed", (request) => {
      console.info(`  [requestfailed] ${request.url().slice(0, 110)} ${request.failure()?.errorText ?? ""}`);
    });
    if (model === BASELINE_MODEL) {
      await page.addInitScript((id: string) => {
        Object.defineProperty(globalThis, "__worklensAiModel", { value: id, configurable: true });
      }, model);
    }
    await use(page);
    await context.close();
  },
});

export { expect } from "@playwright/test";
