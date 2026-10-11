import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { createDocxParagraphs } from "../fixtures";
import { navigateWorkspace } from "./navigation";

const fileA = "갑과 을은 서비스 계약을 체결한다. 갑은 계약을 임의로 해지할 수 없다.";
const fileB = "갑과 을은 공급 계약을 체결한다. 을은 대금 지급을 임의로 중단할 수 없다.";
const textB = "제1조 갑은 월 이용료를 지급한다. 제2조 을은 계약을 임의로 해지할 수 없다.";
const textC = textB.replace("임의로", "일방에");
const textD = "제1조 갑은 월 이용료를 지급한다. 제2조 을은 계약을 즉시 해지할 수 없다.";
const inputs = { fileA, fileB, textB, textC, textD } as const;
type Source = keyof typeof inputs;
type Request = { task: string; text?: string; document?: { name: string; segments: Array<{ text: string }> } };

function sourceOf(body: Request): Source {
  if (body.task !== "document_review") throw new Error(`Unexpected task: ${body.task}`);
  const text = body.document ? body.document.segments.map((segment) => segment.text).join("\n") : body.text?.trim() ?? "";
  const source = (Object.keys(inputs) as Source[]).find((key) => text.includes(inputs[key]));
  if (!source) throw new Error(`Unrecognized review input: ${text.slice(0, 100)}`);
  if (body.document && source !== "fileA" && source !== "fileB") throw new Error("Pasted text sent as a workspace file");
  if (!body.document && (source === "fileA" || source === "fileB")) throw new Error("Workspace file sent as pasted text");
  return source;
}

function responseFor(source: Source) {
  const fact = inputs[source];
  return { data: { found: true, task: "document_review", text: "", markers: [], review: {
    document: { type: "b2b_service", label: `계약 검토 ${source}`, relationship: "business", relationshipLabel: "사업자 간", confidence: "high", evidence: [], domains: ["civil"] },
    risk: { score: 2, level: "보통", high: 0, medium: 2, low: 0 },
    facts: [],
    clauses: [{ number: "제1조", text: fact, segments: source.startsWith("file") ? [0] : undefined, issues: [
      { id: `issue-${source}-first`, label: `${source} 첫 쟁점`, severity: "medium", point: `${source} 첫 검토`, fact,
        segments: source.startsWith("file") ? [0] : undefined, laws: [`law-${source}`], precedents: [], lawStatus: "found", precedentStatus: "none" },
      { id: `issue-${source}-second`, label: `${source} 둘째 쟁점`, severity: "medium", point: `${source} 둘째 검토`, fact,
        segments: source.startsWith("file") ? [0] : undefined, laws: [`law-${source}`], precedents: [], lawStatus: "found", precedentStatus: "none" },
    ] }],
    laws: { [`law-${source}`]: { key: `law-${source}`, law: `${source} 법률`, jo: "제1조", excerpt: `${source} 별도 근거` } },
    precedents: {}, stats: { calls: 1, queries: 1, excludedPrecedents: 0, excludedLaws: 0 },
  } } };
}

async function openReview(page: Page) {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await navigateWorkspace(page, "법령");
  await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
  const form = page.getByRole("form", { name: /^(종합 리서치|문서 검토) 입력$/ });
  await form.getByLabel("리서치 유형").click();
  await page.getByRole("option", { name: "문서 검토", exact: true }).click();
  return form;
}

function fileFixture(name: string, text: string) {
  return { name, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from(createDocxParagraphs([text])) };
}

async function selectFile(page: Page, form: Locator, name: string) {
  await form.getByRole("radio", { name: "작업 파일", exact: true }).check();
  await form.locator("#research-file").click();
  await page.getByRole("option", { name, exact: true }).click();
}

async function runReview(form: Locator) {
  await form.getByRole("button", { name: "실행", exact: true }).click();
}

async function expectSource(page: Page, source: Source, filename?: string) {
  const result = page.getByRole("region", { name: "검토 결과" });
  const review = result.locator(".contract-review");
  await expect(review).toContainText(`계약 검토 ${source}`);
  await expect(review.locator(".contract-review-issue")).toHaveCount(2);
  await expect(review.locator(".contract-review-fact").first()).toHaveText(inputs[source]);
  await expect(review.locator(".contract-review-file")).toHaveCount(filename ? 1 : 0);
  if (filename) {
    await expect(review.locator(".contract-review-file")).toContainText(filename);
    await expect(review.locator(".contract-review-place").first()).toContainText("번째 문단");
  } else {
    await expect(review.locator(".contract-review-place")).toHaveCount(0);
    await expect(review.locator("[data-coverage]")).toHaveCount(0);
  }
  await expect(review).not.toContainText("계약 검토 " + (source === "fileA" ? "textB" : "fileA"));
  await expect(page.locator("[data-review-stale=true]")).toHaveCount(0);
}

function trackBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource: the server responded with a status of 503/.test(message.text())) errors.push(message.text());
  });
  return errors;
}

async function expectNoOverflow(page: Page, errors: string[]) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`review file/text mode, exact edits and disclosures stay with their source at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const errors = trackBrowserErrors(page);
    const requests: Source[] = [];
    await page.route("**/api/law/research", (route) => {
      const source = sourceOf(route.request().postDataJSON() as Request);
      requests.push(source);
      return route.fulfill({ json: responseFor(source) });
    });
    await page.goto("/");
    await page.getByLabel("작업 파일 선택").setInputFiles(fileFixture("original.docx", fileA));
    await expect(page.locator(".file-row")).toHaveCount(1);
    await navigateWorkspace(page, "법령");
    await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
    const form = page.getByRole("form", { name: /^(종합 리서치|문서 검토) 입력$/ });
    await form.getByLabel("리서치 유형").click();
    await page.getByRole("option", { name: "문서 검토", exact: true }).click();
    await runReview(form);
    await expectSource(page, "fileA", "original.docx");
    const review = page.locator(".contract-review");
    await review.locator(".contract-review-source summary").first().click();
    await review.locator(".research-issue-nav button").last().click();
    await expect(review.locator(".contract-review-issue.is-focused")).toHaveCount(1);
    await form.getByRole("radio", { name: "직접 입력" }).check();
    const input = form.getByLabel("검토할 문서 내용");
    await expect(page.locator(".legal-analysis-result, [data-review-stale=true]")).toHaveCount(0);
    await input.fill(textB);
    await runReview(form);
    await expectSource(page, "textB");
    await expect(page.locator(".contract-review-source[open], .contract-review-issue.is-focused")).toHaveCount(0);
    await review.locator(".contract-review-source summary").first().click();
    await selectFile(page, form, "original.docx");
    await expectSource(page, "fileA", "original.docx");
    await expect(page.locator(".contract-review-source[open], .contract-review-issue.is-focused")).toHaveCount(0);
    await form.getByRole("radio", { name: "직접 입력" }).check();
    await expect(input).toHaveValue(textB);
    await expectSource(page, "textB");
    await expect(page.locator(".contract-review-source[open]")).toHaveCount(0);
    await input.fill(textC);
    expect(textB.length).toBe(textC.length);
    await expect(page.locator(".legal-analysis-result, [data-review-stale=true]")).toHaveCount(0);
    await input.fill(`  ${textB}  `);
    await expectSource(page, "textB");
    await input.fill(textC);
    await runReview(form);
    await expectSource(page, "textC");
    // A new direct review replaces the earlier one; the earlier text no longer has a current result.
    await input.fill(textB);
    await expect(page.locator(".legal-analysis-result, [data-review-stale=true]")).toHaveCount(0);
    await input.fill(textC);
    await expectSource(page, "textC");
    await selectFile(page, form, "original.docx");
    await expectSource(page, "fileA", "original.docx");
    expect(requests).toEqual(["fileA", "textB", "textC"]);
    await expectNoOverflow(page, errors);
  });

  test(`review A/B file selection and replaced same-name file do not inherit results at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const errors = trackBrowserErrors(page);
    const requests: Source[] = [];
    await page.route("**/api/law/research", (route) => {
      const body = route.request().postDataJSON() as Request;
      const source = sourceOf(body);
      requests.push(source);
      expect(body.document?.name).toBe("shared.docx");
      return route.fulfill({ json: responseFor(source) });
    });
    await page.goto("/");
    await page.getByLabel("작업 파일 선택").setInputFiles([fileFixture("shared.docx", fileA), fileFixture("shared.docx", fileB)]);
    await expect(page.locator(".file-row")).toHaveCount(2);
    await navigateWorkspace(page, "법령");
    await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
    const form = page.getByRole("form", { name: /^(종합 리서치|문서 검토) 입력$/ });
    await form.getByLabel("리서치 유형").click();
    await page.getByRole("option", { name: "문서 검토", exact: true }).click();
    await runReview(form);
    await expectSource(page, "fileA", "shared.docx");
    await form.locator("#research-file").click();
    await page.getByRole("option", { name: "shared.docx" }).last().click();
    await expect(page.locator(".legal-analysis-result, [data-review-stale=true]")).toHaveCount(0);
    await runReview(form);
    await expectSource(page, "fileB", "shared.docx");
    await form.locator("#research-file").click();
    await page.getByRole("option", { name: "shared.docx" }).first().click();
    await expectSource(page, "fileA", "shared.docx");
    expect(requests).toEqual(["fileA", "fileB"]);
    await expectNoOverflow(page, errors);
  });

  for (const ordering of ["file-first", "text-first"] as const) {
    test(`review pending file/text ${ordering} results and errors remain isolated at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const errors = trackBrowserErrors(page);
      const pending = new Map<Source, { route: Route; release: () => void }>();
      const requests: Source[] = [];
      await page.route("**/api/law/research", async (route) => {
        const source = sourceOf(route.request().postDataJSON() as Request);
        requests.push(source);
        if (source === "fileA" || source === "textB") {
          await new Promise<void>((resolve) => pending.set(source, { route, release: resolve }));
        }
        if (source === "textB" && ordering === "file-first" || source === "fileA" && ordering === "text-first") {
          await route.fulfill({ status: 503, json: { error: { message: `${source} review unavailable` } } });
        } else {
          await route.fulfill({ json: responseFor(source) });
        }
      });
      await page.goto("/");
      await page.getByLabel("작업 파일 선택").setInputFiles(fileFixture("original.docx", fileA));
      await expect(page.locator(".file-row")).toHaveCount(1);
      await navigateWorkspace(page, "법령");
      await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
      const form = page.getByRole("form", { name: /^(종합 리서치|문서 검토) 입력$/ });
      await form.getByLabel("리서치 유형").click();
      await page.getByRole("option", { name: "문서 검토", exact: true }).click();
      const text = form.getByLabel("검토할 문서 내용");
      if (ordering === "text-first") {
        await form.getByRole("radio", { name: "직접 입력" }).check();
        await text.fill(textB);
      }
      await runReview(form);
      const first = ordering === "file-first" ? "fileA" : "textB";
      const second = ordering === "file-first" ? "textB" : "fileA";
      await expect.poll(() => pending.has(first)).toBe(true);
      await expect(form.getByRole("button", { name: "문서 검토 중…" })).toBeDisabled();
      if (ordering === "file-first") {
        await form.getByRole("radio", { name: "직접 입력" }).check();
        await text.fill(textB);
      } else await form.getByRole("radio", { name: "작업 파일" }).check();
      await expect(page.locator(".legal-analysis-result")).toHaveCount(0);
      await runReview(form);
      await expect.poll(() => pending.has(second)).toBe(true);
      // The second target fails, the first succeeds afterward: each outcome stays with its own input.
      pending.get(second)!.release();
      await expect(page.locator(".contract-review")).toContainText(`${second} review unavailable`);
      pending.get(first)!.release();
      await expect(page.locator(".contract-review")).toContainText(`${second} review unavailable`);
      await form.getByRole("radio", { name: first === "fileA" ? "작업 파일" : "직접 입력", exact: true }).check();
      if (first === "fileA") await expectSource(page, "fileA", "original.docx");
      else await expectSource(page, "textB");
      await form.getByRole("radio", { name: second === "fileA" ? "작업 파일" : "직접 입력", exact: true }).check();
      await expect(page.locator(".contract-review")).toContainText(`${second} review unavailable`);
      await expect(page.locator("[data-review-stale=true]")).toHaveCount(0);
      expect(requests).toEqual([first, second]);
      await expectNoOverflow(page, errors);
    });
  }

  test(`review late earlier text, no-result and error never leak into another text at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const errors = trackBrowserErrors(page);
    let releaseOld: (() => void) | undefined;
    const requests: Source[] = [];
    await page.route("**/api/law/research", async (route) => {
      const source = sourceOf(route.request().postDataJSON() as Request);
      requests.push(source);
      if (source === "textB") {
        await new Promise<void>((resolve) => { releaseOld = resolve; });
        // The superseded request was aborted by the page; its late answer has nowhere to land.
        return route.fulfill({ json: responseFor(source) }).catch(() => undefined);
      }
      if (source === "textD") return route.fulfill({ json: { data: { found: false, task: "document_review", marker: "NOT_FOUND", text: "", markers: [] } } });
      return route.fulfill({ json: responseFor(source) });
    });
    const form = await openReview(page);
    await form.getByRole("radio", { name: "직접 입력" }).check();
    const input = form.getByLabel("검토할 문서 내용");
    await input.fill(textB);
    await runReview(form);
    await expect.poll(() => Boolean(releaseOld)).toBe(true);
    await input.fill(textC);
    await runReview(form);
    await expectSource(page, "textC");
    releaseOld!();
    await expectSource(page, "textC");
    await input.fill(textD);
    await runReview(form);
    await expect(page.locator(".legal-analysis-missing.contract-review")).toBeVisible();
    await expect(page.locator(".contract-review-issue, .contract-review-source, .contract-review-file")).toHaveCount(0);
    await input.fill(textC);
    await expect(page.locator(".legal-analysis-result, [data-review-stale=true]")).toHaveCount(0);
    await input.fill(textD);
    await expect(page.locator(".legal-analysis-missing.contract-review")).toBeVisible();
    await input.fill("");
    await expect(page.locator(".legal-analysis-result, [data-review-stale=true]")).toHaveCount(0);
    expect(requests).toEqual(["textB", "textC", "textD"]);
    await expectNoOverflow(page, errors);
  });
}
