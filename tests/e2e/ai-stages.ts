import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, test as base, type Page, type TestInfo } from "@playwright/test";
import { createCheckPptx, createXlsx, RATE_SHEET_V1 } from "../fixtures";
import { BROWSER_AI_BASELINE_MODEL_ID, BROWSER_AI_MODEL_ID } from "@/client/browser-ai-protocol";

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

/**
 * The product defines both ids; this only decides which one a run uses. An
 * unsupported value fails here rather than running a different model than the
 * one the operator asked for.
 */
export const SHIPPED_MODEL = BROWSER_AI_MODEL_ID;
export const BASELINE_MODEL = BROWSER_AI_BASELINE_MODEL_ID;
const SUPPORTED_MODELS = [SHIPPED_MODEL, BASELINE_MODEL];

function selectedModel(): string {
  const requested = process.env.WORKLENS_AI_MODEL;
  if (!requested) return SHIPPED_MODEL;
  if (!SUPPORTED_MODELS.includes(requested)) {
    throw new Error(
      `Unsupported WORKLENS_AI_MODEL: ${requested}. Supported: ${SUPPORTED_MODELS.join(", ")}`,
    );
  }
  return requested;
}

export const model = selectedModel();

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

/**
 * Which model tier a run exercises. Absent means the app's own decision
 * stands, which is the conservative one; `standard` is how an operator who
 * knows their machine tests the large model.
 */
export const tier = ((): "standard" | "light" | undefined => {
  const requested = process.env.WORKLENS_AI_TIER;
  if (!requested) return undefined;
  if (requested !== "standard" && requested !== "light") {
    throw new Error(`Unsupported WORKLENS_AI_TIER: ${requested}. Supported: standard, light`);
  }
  return requested;
})();

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
 * These runs exist to exercise a real adapter, so a machine without one is a
 * failure, not a pass: a silent skip reads as "the AI works". The only
 * exception is an environment that never had WebGPU — CI, or an explicit
 * `WORKLENS_AI_ALLOW_NO_WEBGPU=1` — where the run skips and says so.
 */
export function requireWebGpu(probe: WebGpuProbe, tracker: StageTracker): void {
  if (probe.device === "ok") return;
  const report = [
    `navigator.gpu: ${probe.navigatorGpu ? "present" : "missing"}`,
    `adapter: ${probe.adapter ? "acquired" : "not acquired"}`,
    `device: ${probe.device}`,
    `failed stage: ${!probe.navigatorGpu ? "navigator.gpu" : !probe.adapter ? "requestAdapter" : "requestDevice"}`,
  ].join(" · ");
  const skippable = Boolean(process.env.CI) || process.env.WORKLENS_AI_ALLOW_NO_WEBGPU === "1";
  if (skippable) {
    tracker.log(`   no WebGPU, skipping by policy — ${report}`);
    base.skip(true, `no usable WebGPU device (${report})`);
    return;
  }
  throw new Error(
    `this run requires a real WebGPU device — ${report}. `
    + "Set WORKLENS_AI_ALLOW_NO_WEBGPU=1 (or run in CI) to skip instead of failing.",
  );
}

/**
 * What the app decided to load, and the signals it decided from. Recorded in
 * the run artifact so a machine that freezes can be told apart from one that
 * was handed a model it could never hold.
 */
export interface AiModelDiagnostics {
  modelId: string;
  label: string;
  tier: string;
  contextWindowSize: number;
  downloadMb: number;
  reason: string;
  source: string;
  standardBlocked: boolean;
  signals: Record<string, number | undefined>;
}

export async function readModelDiagnostics(page: Page): Promise<AiModelDiagnostics | null> {
  return page.evaluate(() => {
    const reader: unknown = Reflect.get(window, "__worklensAiDiagnostics");
    return typeof reader === "function" ? (reader() as AiModelDiagnostics) : null;
  });
}

/** Asks the app to use a tier before any download starts. */
export async function selectTier(page: Page, tier: "standard" | "light"): Promise<void> {
  await page.evaluate((value) => {
    const select: unknown = Reflect.get(window, "__worklensAiSelectTier");
    if (typeof select === "function") select(value);
  }, tier);
}

/**
 * The upload input is server-rendered, so setting files on it before the page
 * hydrated drops the change event and nothing is ever parsed. The app marks
 * that point itself with `data-hydrated`, set in an effect that runs after the
 * commit which attached the handlers — no React internals are inspected.
 */
export async function waitForHydration(page: Page, timeoutMs: number): Promise<void> {
  await page.locator('.app-shell[data-hydrated="true"]').waitFor({ state: "attached", timeout: timeoutMs });
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

/** The phases the app publishes on `data-ai-state`. */
export type AiPhase = "idle" | "checking" | "awaiting-confirmation" | "loading" | "ready" | "failed" | "unsupported";

export async function aiState(page: Page): Promise<{ phase: AiPhase; code: string | null }> {
  const shell = page.locator(".app-shell");
  const phase = await shell.getAttribute("data-ai-state");
  return { phase: (phase ?? "idle") as AiPhase, code: await shell.getAttribute("data-ai-error") };
}

/** Progress copy, logged for diagnosis only — never used to decide the outcome. */
async function statusLine(page: Page): Promise<string> {
  const panels = await page.locator(".ai-status").allInnerTexts();
  return panels.join(" | ").replaceAll("\n", " ").replace(/\s+/g, " ").trim();
}

/**
 * Waits for the model to become usable, deciding on `data-ai-state` rather
 * than on Korean copy: the wording is a product decision that changes, the
 * phase is the contract. A failed or unsupported phase ends the wait at once
 * and reports its error code plus the last progress line it saw.
 */
export async function waitForModelReady(
  page: Page,
  tracker: StageTracker,
  timeoutMs: number,
): Promise<number> {
  const started = Date.now();
  let last = "";
  for (;;) {
    const { phase, code } = await aiState(page);
    const text = await statusLine(page);
    if (text && text !== last) {
      tracker.log(`   [${phase}] ${text.slice(0, 150)}`);
      last = text;
    }
    if (phase === "failed" || phase === "unsupported") {
      throw new Error(`model preparation ended in ${phase} (${code ?? "no code"}); status: ${text.slice(0, 200) || "none"}`);
    }
    if (phase === "ready") return Date.now() - started;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`model not ready within ${timeoutMs}ms; phase=${phase}; last status: ${last || "none"}`);
    }
    await page.waitForTimeout(500);
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
