import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test as base, type Page } from "@playwright/test";

/**
 * One regression case = one Playwright test declared through `regressionCase`.
 * The outcome (with Case ID, category, input, structure, expected, actual,
 * duration and console/network errors) is appended to
 * artifacts/regression/cases.jsonl. A test that throws is recorded FAIL with
 * the error; `classification` is filled by the author for known
 * expected/unsupported behaviour, never to hide a failure.
 */
export type CaseMeta = {
  id: string;
  category: "Analyze" | "Ask" | "Compare" | "Check" | "Polish" | "Extract" | "Aggregate" | "PDF" | "Image" | "Law" | "Dictionary" | "Settings" | "Upload" | "UI";
  input: string;
  format: string;
  structure: string;
  expected: string;
  /** Also run on the 390×844 project. */
  mobile?: boolean;
};

export type CaseContext = {
  page: Page;
  /** What was actually observed; recorded as `actual`. */
  note: (actual: string) => void;
  /** Record a policy outcome (e.g. warning shown for an unsupported element). */
  classify: (classification: "Expected" | "Unsupported") => void;
  warn: (warning: string) => void;
};

export const OUT = path.join(process.cwd(), "artifacts", "regression");
export const FIXTURES = path.join(OUT, "fixtures");
const KNOWN_NOISE = [/Download the React DevTools/u, /\[Fast Refresh\]/u];

export function regressionCase(meta: CaseMeta, body: (context: CaseContext) => Promise<void>) {
  base(`${meta.id} ${meta.input}${meta.mobile ? " @mobile" : ""}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error" && !KNOWN_NOISE.some((noise) => noise.test(message.text()))) errors.push(`console: ${message.text()}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 500) errors.push(`http ${response.status()} ${new URL(response.url()).pathname}`);
    });
    let actual = "";
    let classification: string | undefined;
    const warnings: string[] = [];
    const started = Date.now();
    let failure: unknown;
    try {
      await body({ page, note: (value) => { actual = value; }, classify: (value) => { classification = value; }, warn: (value) => warnings.push(value) });
      expect(errors.filter((error) => error.startsWith("pageerror")), "uncaught page errors").toEqual([]);
    } catch (error) {
      failure = error;
    }
    // expect.soft failures do not throw; they must still record as FAIL.
    if (!failure && info.errors.length) failure = new Error(info.errors.map((error) => error.message ?? "").join(" | "));
    await mkdir(OUT, { recursive: true });
    await appendFile(path.join(OUT, "cases.jsonl"), `${JSON.stringify({
      ...meta, viewport: info.project.name, result: failure ? "FAIL" : "PASS", classification: failure ? undefined : classification ?? "PASS",
      actual: actual || (failure ? String((failure as Error).message).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").filter((line) => /\S/u.test(line) && !/^\s*(Call log|- )/u.test(line)).slice(0, 5).join(" | ").slice(0, 600) : ""),
      durationMs: Date.now() - started, warnings, errors,
    })}\n`);
    if (failure) throw failure;
  });
}

export async function writeFixture(name: string, content: Buffer | Uint8Array | string): Promise<string> {
  await mkdir(FIXTURES, { recursive: true });
  const file = path.join(FIXTURES, name);
  await writeFile(file, content);
  return file;
}

/** Upload into the document workspace and wait for the row. */
export async function upload(page: Page, ...files: string[]) {
  await page.locator('input[aria-label="작업 파일 선택"]').setInputFiles(files);
  for (const file of files) await expect(page.locator(".file-row").filter({ hasText: path.basename(file) }).first()).toBeVisible();
}

/** Rail navigation works at every width (mobile rail is a grid, not a drawer). */
export async function openView(page: Page, label: string) {
  await page.locator(".rail").getByRole("button", { name: label, exact: true }).click();
}

export async function selectFiles(page: Page, ...files: string[]) {
  for (const file of files) await page.getByLabel(`${path.basename(file)} 선택`, { exact: true }).check();
}

export async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}
