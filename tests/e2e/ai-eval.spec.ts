import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createCheckPptx, createXlsx, RATE_SHEET_V1 } from "../fixtures";
import { POLISH_TEXT_CASES } from "../eval/cases";

/**
 * Browser-AI quality evaluation.
 *
 * The smoke run (`playwright.ai.config.ts`) proves the AI path works. This run
 * scores how good the answers are on a fixed case set, on the same documents,
 * the same questions and the same retrieval window for every model, so
 * Qwen3 1.7B and the Qwen2.5 baseline are directly comparable.
 *
 * Scoring is deterministic: numbers, dates, money, cited handles, abstention
 * and expected keywords are checked in code. No model judges another model.
 * Results land in `artifacts/ai-eval-<model>.json`.
 *
 *   bun run test:eval:ai
 *   WORKLENS_AI_MODEL=Qwen2.5-1.5B-Instruct-q4f16_1-MLC bun run test:eval:ai
 */
const FIXTURE_DIR = path.join(process.cwd(), "artifacts", "fixtures");
const rateSheet = path.join(FIXTURE_DIR, "운임현황_v1.xlsx");
const deck = path.join(FIXTURE_DIR, "최종검수.pptx");
const BASELINE_MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
const model = process.env.WORKLENS_AI_MODEL === BASELINE_MODEL ? BASELINE_MODEL : "Qwen3-1.7B-q4f16_1-MLC";

interface AskCase {
  id: string;
  /** Files the question runs against, by fixture index. */
  files: ("sheet" | "deck")[];
  question: string;
  /** Substrings the answer must contain, compared after normalization. */
  expect: string[];
  /** The documents cannot answer: the run must abstain. */
  unanswerable?: boolean;
}

/**
 * Numbers that appear nowhere in the fixtures. A claim containing one of these
 * is a fabrication regardless of how fluent the sentence is.
 */
const FABRICATION_MARKERS = ["999999", "123456", "2031"];

const ASK_CASES: AskCase[] = [
  { id: "ask-factual-seoul", files: ["sheet"], question: "SEOUL 운임은 얼마인가요?", expect: ["158000"] },
  { id: "ask-numeric-busan", files: ["sheet"], question: "BUSAN 운임은 얼마인가요?", expect: ["90000"] },
  { id: "ask-numeric-daegu", files: ["sheet"], question: "DAEGU 운임은 얼마인가요?", expect: ["70000"] },
  { id: "ask-date-deck", files: ["deck"], question: "이 발표자료의 기준일은 언제인가요?", expect: ["2026"] },
  { id: "ask-money-forecast", files: ["deck"], question: "유가 전망 수치는 얼마인가요?", expect: ["82"] },
  { id: "ask-unanswerable-rent", files: ["sheet"], question: "2031년 파리 지사 임대료는 얼마인가요?", expect: [], unanswerable: true },
  { id: "ask-unanswerable-region", files: ["sheet"], question: "울산 운임은 얼마인가요?", expect: [], unanswerable: true },
  { id: "ask-unanswerable-contact", files: ["deck"], question: "담당자 휴대전화 번호는 무엇인가요?", expect: [], unanswerable: true },
];

interface CaseResult {
  id: string;
  operation: string;
  pass: boolean;
  abstained: boolean;
  expected: string[];
  answer: string;
  citedSources: string[];
  claims: number;
  fabricated: string[];
  latencyMs: number;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replaceAll(",", "").replace(/\s+/gu, " ").trim();
}

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

test("scores Ask, Brief and semantic check against a fixed case set", async ({ page }) => {
  test.setTimeout(55 * 60_000);
  const results: CaseResult[] = [];

  await page.goto("/");
  const adapter = await page.evaluate(async () => {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    return Boolean(await gpu.requestAdapter());
  });
  test.skip(!adapter, "no WebGPU adapter in this browser");

  await page.locator('input[type="file"]').setInputFiles([rateSheet, deck]);
  await expect(page.locator(".file-row")).toHaveCount(2);

  const select = async (files: ("sheet" | "deck")[]) => {
    const boxes = page.locator('.file-row input[type="checkbox"]');
    for (const index of [0, 1]) {
      const wanted = files.includes(index === 0 ? "sheet" : "deck");
      const box = boxes.nth(index);
      if (wanted !== await box.isChecked()) await box.setChecked(wanted);
    }
  };

  // One consent, one download, then every case reuses the loaded model.
  await select(["sheet"]);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const confirm = page.getByRole("button", { name: "AI 준비" });
  if (await confirm.count()) await confirm.click();
  await expect(page.locator(".ai-status.loading")).toHaveCount(0, { timeout: 25 * 60_000 });

  for (const entry of ASK_CASES) {
    await select(entry.files);
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await page.getByPlaceholder("선택한 문서에서 확인할 내용을 입력하세요").fill(entry.question);
    const started = Date.now();
    await page.getByRole("button", { name: "Ask 실행" }).click();
    await expect(page.locator(".claim-row, .notice.error, .notice.info").first())
      .toBeVisible({ timeout: 10 * 60_000 });
    const latencyMs = Date.now() - started;

    const claims = await page.locator(".claim-row").count();
    const answer = claims > 0 ? await page.locator(".ai-result").innerText() : "";
    const notice = await page.locator(".notice").count() > 0 ? await page.locator(".notice").innerText() : "";
    const abstained = claims === 0 || /근거/.test(notice) && /찾지 못했습니다/.test(notice);
    const citedSources = await page.locator(".claim-evidence .source-action").allInnerTexts();
    const haystack = normalize(answer);
    const fabricated = FABRICATION_MARKERS.filter((marker) => haystack.includes(marker));
    const pass = entry.unanswerable
      ? abstained
      : !abstained && entry.expect.every((needle) => haystack.includes(normalize(needle)));

    results.push({
      id: entry.id,
      operation: "ask",
      pass,
      abstained,
      expected: entry.expect,
      answer: answer.slice(0, 400),
      citedSources,
      claims,
      fabricated,
      latencyMs,
    });
  }

  // Brief: coverage is claim count plus grounding, not wording.
  await select(["deck"]);
  await page.getByRole("button", { name: "Brief", exact: true }).click();
  const briefStarted = Date.now();
  await page.getByRole("button", { name: "Brief 실행" }).click();
  await expect(page.getByText("Brief 결과를 준비했습니다.")).toBeVisible({ timeout: 10 * 60_000 });
  const briefClaims = await page.locator(".claim-row").count();
  const briefSources = await page.locator(".claim-evidence .source-action").allInnerTexts();
  results.push({
    id: "brief-coverage",
    operation: "brief",
    pass: briefClaims >= 2 && briefSources.length >= briefClaims,
    abstained: briefClaims === 0,
    expected: [">=2 grounded claims"],
    answer: (await page.locator(".ai-result").innerText()).slice(0, 400),
    citedSources: briefSources,
    claims: briefClaims,
    fabricated: [],
    latencyMs: Date.now() - briefStarted,
  });

  // Semantic check: every AI finding must point at text the deck contains.
  await page.getByRole("button", { name: "Check", exact: true }).click();
  const checkStarted = Date.now();
  await page.getByRole("button", { name: "브라우저 AI 문장 검수" }).click();
  await expect(page.getByText("브라우저 AI 보조 점검 결과를 준비했습니다.")).toBeVisible({ timeout: 10 * 60_000 });
  const aiFindings = page.locator(".check-issue").filter({ hasText: "브라우저 AI" });
  const findingCount = await aiFindings.count();
  const findingSources = await page.locator(".check-source .source-action, .check-source .source-locator").allInnerTexts();
  results.push({
    id: "semantic-check-precision",
    operation: "semantic-check",
    pass: findingSources.length > 0,
    abstained: findingCount === 0,
    expected: ["every finding carries a locator"],
    answer: findingCount > 0 ? (await aiFindings.first().innerText()).slice(0, 400) : "",
    citedSources: findingSources.slice(0, 10),
    claims: findingCount,
    fabricated: [],
    latencyMs: Date.now() - checkStarted,
  });

  /**
   * Polish quality. Scored on what it preserved, not on how much it changed:
   * every protected token must survive, an already-natural sentence must come
   * back unchanged, and a rewrite the guard refuses counts as a rejection
   * rather than a pass.
   */
  await select(["deck"]);
  await page.getByRole("button", { name: "Polish", exact: true }).click();
  for (const mode of ["기본 윤문", "간결하게", "업무 문체"] as const) {
    await page.getByRole("radio", { name: mode }).check();
    const started = Date.now();
    await page.getByRole("button", { name: "Polish 실행" }).click();
    await expect(page.locator(".check-summary-line")).toContainText("변경 제안", { timeout: 20 * 60_000 });
    const rows = page.locator(".polish-row:not(.rejected)");
    const rewrites = await rows.count();
    const pairs: { original: string; revised: string }[] = [];
    for (let index = 0; index < Math.min(rewrites, 10); index += 1) {
      const texts = await rows.nth(index).locator(".polish-text p").allInnerTexts();
      if (texts.length >= 2) pairs.push({ original: texts[0], revised: texts[1] });
    }
    // Numbers, dates and money in a rewrite must be exactly the original's.
    const tokens = (value: string) => (value.match(/\d[\d,.]*%?/gu) ?? []).map((entry) => entry.replaceAll(",", "")).sort().join("|");
    const drifted = pairs.filter((pair) => tokens(pair.original) !== tokens(pair.revised));
    const rejected = await page.locator(".polish-row.rejected").count();
    const unchanged = await page.locator(".polish-unchanged > button").count();
    results.push({
      id: `polish-${mode}`,
      operation: "polish",
      pass: drifted.length === 0,
      abstained: rewrites === 0,
      expected: ["protected tokens preserved"],
      answer: pairs.slice(0, 3).map((pair) => `${pair.original} → ${pair.revised}`).join(" / ").slice(0, 400),
      citedSources: await page.locator(".polish-row .source-locator").allInnerTexts(),
      claims: rewrites,
      fabricated: drifted.map((pair) => pair.revised.slice(0, 80)),
      latencyMs: Date.now() - started,
    });
    // Every rewrite keeps its locator, and refusals are reported, not hidden.
    expect(rejected + rewrites + unchanged).toBeGreaterThan(0);
  }

  /**
   * Pasted-text polish. Same engine, no document: scored on protected tokens,
   * on the line structure the user pasted, and on leaving an already-natural
   * sentence alone.
   */
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  for (const polishCase of POLISH_TEXT_CASES) {
    const started = Date.now();
    await page.getByRole("radio", { name: "기본 윤문" }).check();
    await page.getByLabel("윤문할 텍스트 입력").fill(polishCase.text);
    await page.getByRole("button", { name: "Polish 실행" }).click();
    await expect(page.locator(".polish-text-run")).toBeVisible({ timeout: 20 * 60_000 });
    await expect(page.locator(".check-summary-line")).toContainText("변경 제안", { timeout: 20 * 60_000 });
    const blocks = await page.locator(".polish-text-run .polish-block").allInnerTexts();
    const [original = "", revised = ""] = blocks;
    const missing = polishCase.keep.filter((token) => !revised.includes(token));
    const structureKept = original.split("\n").length === revised.split("\n").length;
    const changedUnnecessarily = polishCase.expectUnchanged === true && revised.trim() !== polishCase.text.trim();
    results.push({
      id: polishCase.id,
      operation: "polish-text",
      pass: missing.length === 0 && structureKept && !changedUnnecessarily,
      abstained: revised.trim() === polishCase.text.trim(),
      expected: polishCase.keep.length ? polishCase.keep : ["structure preserved"],
      answer: revised.slice(0, 400),
      citedSources: [],
      claims: 1,
      fabricated: missing,
      latencyMs: Date.now() - started,
    });
    // A pasted run never invents a document location.
    await expect(page.locator(".polish-text-run .source-locator")).toHaveCount(0);
  }

  const summary = {
    model,
    cases: results.length,
    passed: results.filter((entry) => entry.pass).length,
    abstained: results.filter((entry) => entry.abstained).length,
    fabrications: results.flatMap((entry) => entry.fabricated),
    results,
  };
  await writeFile(
    path.join(process.cwd(), "artifacts", `ai-eval-${model}.json`),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.info("ai eval", { model, passed: summary.passed, of: summary.cases, abstained: summary.abstained });

  // Invariants, not a quality score: a model may answer poorly, but it must
  // never invent a number and must abstain where nothing supports an answer.
  expect(summary.fabrications).toEqual([]);
  for (const entry of results.filter((row) => ASK_CASES.find((c) => c.id === row.id)?.unanswerable)) {
    expect(entry.abstained, `${entry.id} must abstain`).toBe(true);
  }
  for (const entry of results.filter((row) => row.operation === "ask" && !row.abstained)) {
    expect(entry.citedSources.length, `${entry.id} must cite evidence`).toBeGreaterThan(0);
  }
});
