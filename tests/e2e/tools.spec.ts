import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createPdf } from "../fixtures";

test("TOOLS navigation keeps document files in their own workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await page.getByLabel("작업 파일 선택").setInputFiles({
    name: "workspace-contract.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await createPdf(["Document workspace stays intact"])),
  });
  await expect(page.locator(".file-row").filter({ hasText: "workspace-contract.pdf" })).toBeVisible();

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "PDF 도구" }).click();
    await expect(page.locator(".context-bar h1")).toHaveText("PDF 도구");
    await expect(page.getByRole("heading", { name: "작업 파일" })).toHaveCount(0);
    await expect(page.locator(".file-row")).toHaveCount(0);
    await page.getByRole("button", { name: "이미지 도구" }).click();
    await expect(page.locator(".context-bar h1")).toHaveText("이미지 도구");
    await expect(page.locator(".file-row")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "분석", exact: true }).click();
    await expect(page.locator(".file-row").filter({ hasText: "workspace-contract.pdf" })).toBeVisible();
  }
});

test("RESEARCH law search sends only the query and separates results, no result and outages", async ({ page }) => {
  const bodies: unknown[] = [];
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  let reply: { status: number; body: unknown } = { status: 200, body: { requestId: "r1", data: { found: true, text: "raw", laws: [
    { name: "근로기준법", status: "현행", lawId: "001872", mst: "283457", promulgationDate: "20260219", effectiveDate: "20260820", kind: "법률" },
    { name: "근로기준법 시행령", status: "현행", lawId: "003058", mst: "270551", effectiveDate: "20251023", kind: "대통령령" },
  ] } } };
  await page.route("**/api/law", async (route) => {
    bodies.push(route.request().postDataJSON());
    await page.waitForTimeout(150);
    await route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body) });
  });
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await page.getByLabel("작업 파일 선택").setInputFiles({ name: "keep.pdf", mimeType: "application/pdf", buffer: Buffer.from(await createPdf(["kept"])) });
  await expect(page.locator(".file-row").filter({ hasText: "keep.pdf" })).toBeVisible();

  await expect(page.locator(".rail-group-label").filter({ hasText: "RESEARCH" })).toBeVisible();
  await page.getByRole("button", { name: "법령", exact: true }).click();
  await expect(page.getByRole("button", { name: "법령", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".context-bar h1")).toHaveText("법령");
  await expect(page.getByText("법령명 또는 키워드를 입력해 검색하세요.")).toBeVisible();

  const input = page.getByRole("searchbox");
  await input.fill("근로기준법");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "검색 중…" })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "검색 결과 · 2건" })).toBeVisible();
  const first = page.locator(".law-search-list li").first();
  await expect(first).toContainText("근로기준법");
  await expect(first).toContainText("법률");
  await expect(first).toContainText("시행일 2026.08.20");
  await expect(page.getByText("283457")).toHaveCount(0);
  await expect(page.getByText("raw", { exact: true })).toHaveCount(0);
  expect(bodies).toEqual([{ query: "근로기준법" }]);

  reply = { status: 200, body: { requestId: "r2", data: { found: false, marker: "NOT_FOUND", text: "[NOT_FOUND]" } } };
  await input.fill("없는법령");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "검색 결과가 없습니다." })).toBeVisible();

  reply = { status: 504, body: { requestId: "r3", error: { code: "LAW_UPSTREAM_TIMEOUT", message: "법령 검색 응답이 지연되고 있습니다." } } };
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.locator(".law-search-error[role=alert]")).toHaveText("법령 검색 응답이 지연되고 있습니다.");
  await expect(page.getByText("검색 결과가 없습니다.")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "분석", exact: true }).click();
  await expect(page.locator(".file-row").filter({ hasText: "keep.pdf" })).toBeVisible();
  expect(errors.filter((text) => !/504/.test(text))).toEqual([]);
});

test("RESEARCH law detail browses raw TOC and articles, recovers, and preserves results", async ({ page }) => {
  const requests: unknown[] = [];
  let retryCount = 0;
  await page.route("**/api/law", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { found: true, laws: [
      { name: "근로기준법", mst: "283457", lawId: "001872", effectiveDate: "20260820" },
      { name: "시행령", lawId: "003058" },
      { name: "식별자 없는 법" },
    ] } }) });
  });
  await page.route("**/api/law/text", async (route) => {
    const request = route.request().postDataJSON();
    requests.push(request);
    const jo = request.jo;
    const status = jo === "제10조의2" && retryCount++ === 0 ? 503 : 200;
    const data = jo === "제9999조"
      ? { found: false, marker: "NOT_FOUND", text: "[NOT_FOUND] 조문 내용을 찾을 수 없습니다." }
      : jo
        ? { found: true, mode: "article", text: `${jo} 임산부의 보호\n${jo}(임산부의 보호)\n① 원문 그대로` }
        : { found: true, mode: "toc", text: `법령명: 근로기준법\n공포일: 20260219\n시행일: 20260820\n\n목차 (총 132개 조문)\n\n제74조 ${"긴원문".repeat(150)}`, name: "근로기준법", promulgationDate: "20260219", effectiveDate: "20260820", articles: [{ jo: "제74조", title: "임산부의 보호" }] };
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 503 ? { error: { message: "원문 서비스 오류" } } : { data }) });
  });

  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await page.getByRole("button", { name: "법령", exact: true }).click();
  await page.getByRole("searchbox").fill("근로기준법");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByRole("heading", { name: "검색 결과 · 3건" })).toBeVisible();
  await expect(page.locator(".law-search-unavailable")).toContainText("원문 조회 불가");
  await expect(page.locator(".law-search-list button")).toHaveCount(2);

  await page.locator(".law-search-list button").first().click();
  await expect(page.getByRole("heading", { name: "근로기준법" })).toBeVisible();
  await expect(page.locator(".law-detail-raw")).toContainText("목차 (총 132개 조문)");
  await page.getByText("원문 보기", { exact: true }).click();
  await expect(page.locator(".law-detail-raw")).toBeVisible();
  await page.getByText("원문 보기", { exact: true }).click();
  await expect(page.getByText("공포일 2026.02.19")).toBeVisible();
  expect(requests).toEqual([{ mst: "283457" }]);
  await page.getByRole("navigation", { name: "조문 목차" }).getByRole("button", { name: "제74조 임산부의 보호" }).click();
  await expect(page.locator(".law-detail-raw")).toHaveText("제74조 임산부의 보호\n제74조(임산부의 보호)\n① 원문 그대로");
  await page.getByRole("button", { name: "← 목차로" }).click();
  await expect(page.locator(".law-detail-raw")).toContainText("목차 (총 132개 조문)");
  expect(requests).toEqual([{ mst: "283457" }, { mst: "283457", jo: "제74조" }]);

  const article = page.getByLabel("조문 번호로 찾기");
  await article.fill("74");
  await page.getByRole("button", { name: "조문 보기" }).click();
  await expect(page.locator(".law-article-form [role=alert]")).toContainText("제74조 또는 제10조의2");
  expect(requests).toHaveLength(2);
  await article.fill("제9999조");
  await page.getByRole("button", { name: "조문 보기" }).click();
  await expect(page.getByRole("status").filter({ hasText: "조문을 찾을 수 없습니다." })).toBeVisible();
  await expect(page.locator(".law-detail-raw")).toHaveCount(0);
  await article.fill("제10조의2");
  await page.getByRole("button", { name: "조문 보기" }).click();
  await expect(page.locator(".law-detail-feedback[role=alert]")).toContainText("원문 서비스 오류");
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.locator(".law-detail-raw")).toContainText("제10조의2(임산부의 보호)");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "← 목차로" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "← 검색 결과로" }).click();
  await expect(page.getByRole("searchbox")).toHaveValue("근로기준법");
  await expect(page.getByRole("heading", { name: "검색 결과 · 3건" })).toBeVisible();
  await page.locator(".law-search-list button").nth(1).click();
  await expect(page.locator(".law-detail-raw")).toContainText("목차 (총 132개 조문)");
  expect(requests.at(-1)).toEqual({ lawId: "003058" });
});

async function downloadBytes(page: Page, click: () => Promise<void>) {
  const pending = page.waitForEvent("download");
  await click();
  const download = await pending;
  return { name: download.suggestedFilename(), bytes: new Uint8Array(await readFile(await download.path())) };
}

/** Drags an item by its grip onto one side of a target, the way a mouse user does. */
async function dragGrip(page: Page, grip: Locator, target: Locator, side: "before" | "after", axis: "x" | "y") {
  // Start away from the viewport edges so edge auto-scroll does not move the target mid-gesture.
  await grip.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
  const from = (await grip.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 8, { steps: 3 });
  const fraction = side === "before" ? 0.25 : 0.75;
  for (let step = 0; step < 8; step++) {
    const to = (await target.boundingBox())!;
    const x = axis === "x" ? to.x + to.width * fraction : to.x + to.width / 2;
    const y = axis === "y" ? to.y + to.height * fraction : to.y + to.height / 2;
    await page.mouse.move(x, y, { steps: 2 });
  }
  await expect(target).toHaveAttribute("data-drop", side);
  await page.mouse.up();
}

async function imageDimensions(page: Page, bytes: Uint8Array, mime: string) {
  return page.evaluate(async ({ image, type }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(image)], { type }));
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dimensions;
  }, { image: [...bytes], type: mime });
}

async function imagePixel(page: Page, bytes: Uint8Array, x: number, y: number) {
  return page.evaluate(async ({ image, x, y }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(image)], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return [...context.getImageData(x, y, 1, 1).data];
  }, { image: [...bytes], x, y });
}

test("PDF and image tools align their workspace and share a responsive export pattern", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  const geometry = () => page.evaluate(() => {
    const root = document.querySelector(".pdf-tool, .image-tool")!;
    const selectors = [".tool-eyebrow", ".tool-intro h2", ".tool-intro p:not(.tool-eyebrow)", ".pdf-tool-upload, .image-tool-layout"];
    const boxes = selectors.map((selector) => {
      const box = root.querySelector(selector)!.getBoundingClientRect();
      return { x: box.x, y: box.y };
    });
    const button = root.querySelector(".tool-export-button") as HTMLButtonElement;
    const style = getComputedStyle(button);
    return { boxes, button: { height: button.getBoundingClientRect().height, background: style.backgroundColor, radius: style.borderRadius, font: style.font, opacity: style.opacity }, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }, { width: 900, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "PDF 도구" }).click();
    await expect(page.locator(".pdf-tool")).toBeVisible();
    await page.evaluate(() => scrollTo(0, 0));
    const pdf = await geometry();
    const toolbar = page.locator(".pdf-tool-export");
    await expect(toolbar).toContainText(`${0}페이지`);
    await expect(toolbar.getByLabel("형식").locator("option")).toHaveText(["PDF", "JPG", "PNG"]);
    await expect(toolbar.getByLabel("페이지").locator("option")).toHaveText(["전체 (0)", "선택 (0)"]);
    await expect(toolbar.getByLabel("압축")).toHaveValue("balanced");
    await toolbar.getByLabel("형식").selectOption("png");
    await expect(toolbar.getByLabel("압축")).toHaveCount(0);
    await toolbar.getByLabel("형식").selectOption("pdf");
    await expect(toolbar.getByLabel("압축")).toHaveValue("balanced");
    if (viewport.width >= 1366) {
      const rows = await toolbar.locator(".tool-export-settings select, .tool-export-button").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().bottom));
      expect(Math.max(...rows) - Math.min(...rows)).toBeLessThan(3);
    }
    if (viewport.width === 390) {
      const rows = await toolbar.locator(".tool-export-settings > label, .pdf-tool-export-actions").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().y));
      expect(rows.every((row, index) => index === 0 || row > rows[index - 1])).toBe(true);
    }
    await page.getByRole("button", { name: "이미지 도구" }).click();
    await expect(page.locator(".image-tool")).toBeVisible();
    await page.evaluate(() => scrollTo(0, 0));
    const image = await geometry();
    for (let index = 0; index < pdf.boxes.length; index++) {
      expect(Math.abs(pdf.boxes[index].x - image.boxes[index].x)).toBeLessThan(1);
      expect(Math.abs(pdf.boxes[index].y - image.boxes[index].y)).toBeLessThan(1);
    }
    expect(pdf.button).toEqual(image.button);
    expect(pdf.overflow || image.overflow).toBe(false);
  }
  expect(errors).toEqual([]);
});

test("PDF editor composes reordered, rotated and deleted pages into real files", async ({ page }) => {
  const posted: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST") posted.push(request.url()); });
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await page.getByRole("button", { name: "PDF 도구" }).click();
  await page.getByLabel("PDF 파일 선택").setInputFiles({
    name: "composed.pdf", mimeType: "application/pdf",
    buffer: Buffer.from(await createPdf(["FIRST", "SECOND", "THIRD", "FOURTH"])),
  });
  const pages = page.locator(".pdf-tool-page");
  await expect(pages).toHaveCount(4);
  await page.getByLabel("2번 페이지 선택").check();
  await page.getByRole("button", { name: /오른쪽 90°/ }).click();
  await page.getByLabel("2번 페이지 선택").uncheck();
  await page.getByLabel("3번 페이지 선택").check();
  await page.getByRole("button", { name: "선택 삭제" }).click();
  await expect(pages).toHaveCount(3);
  await expect(page.getByRole("button", { name: /(왼쪽|오른쪽|위로|아래로)으로? 이동/ })).toHaveCount(0);
  // Selection follows the page, not the slot it occupied.
  await page.getByLabel("3번 페이지 선택").check();
  await dragGrip(page, page.getByRole("button", { name: "3번 페이지 순서 변경" }), pages.nth(1), "before", "x");
  await expect(pages.locator(".pdf-tool-page-meta span")).toHaveText(["원본 1페이지", "원본 4페이지", "원본 2페이지 · +90°"]);
  await expect(page.getByLabel("2번 페이지 선택")).toBeChecked();
  await expect(page.getByLabel("3번 페이지 선택")).not.toBeChecked();
  await expect(page.locator(".tool-reorder-live")).toHaveText("2번째 위치로 이동했습니다.");
  // Keyboard users move one step with the arrow keys on the focused grip.
  await page.getByRole("button", { name: "2번 페이지 순서 변경" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(pages.locator(".pdf-tool-page-meta span")).toHaveText(["원본 1페이지", "원본 2페이지 · +90°", "원본 4페이지"]);
  await expect(page.getByRole("button", { name: "3번 페이지 순서 변경" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(pages.locator(".pdf-tool-page-meta span")).toHaveText(["원본 1페이지", "원본 4페이지", "원본 2페이지 · +90°"]);
  await page.getByLabel("2번 페이지 선택").uncheck();
  await expect(pages.locator(".pdf-tool-page-meta span")).toHaveText(["원본 1페이지", "원본 4페이지", "원본 2페이지 · +90°"]);
  const pdf = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(pdf.name).toBe("worklens-pages.pdf");
  const output = await PDFDocument.load(pdf.bytes);
  expect(output.getPageCount()).toBe(3);
  expect(output.getPages().map((item) => item.getRotation().angle)).toEqual([0, 0, 90]);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("../../public/pdf.worker.mjs", import.meta.url).href;
  const task = pdfjs.getDocument({ data: pdf.bytes });
  try {
    const document = await task.promise;
    const labels: string[] = [];
    for (let index = 1; index <= document.numPages; index++) {
      const item = await document.getPage(index);
      labels.push((await item.getTextContent()).items.map((entry) => "str" in entry ? entry.str : "").join(" "));
      item.cleanup();
    }
    expect(labels).toEqual([expect.stringContaining("FIRST"), expect.stringContaining("FOURTH"), expect.stringContaining("SECOND")]);
    expect(labels.join(" ")).not.toContain("THIRD");
  } finally { await task.destroy(); }

  await page.getByLabel("형식").selectOption("png");
  const pngZip = await downloadBytes(page, () => page.getByRole("button", { name: /다운로드/ }).click());
  expect(Object.keys(unzipSync(pngZip.bytes)).sort()).toEqual(["page-001.png", "page-002.png", "page-003.png"]);
  const pngPages = unzipSync(pngZip.bytes);
  const firstPng = await imageDimensions(page, pngPages["page-001.png"], "image/png");
  const rotatedPng = await imageDimensions(page, pngPages["page-003.png"], "image/png");
  expect(firstPng.width).toBeLessThan(firstPng.height);
  expect(rotatedPng.width).toBeGreaterThan(rotatedPng.height);
  await page.getByLabel("형식").selectOption("jpg");
  const jpgZip = await downloadBytes(page, () => page.getByRole("button", { name: /다운로드/ }).click());
  expect(Object.keys(unzipSync(jpgZip.bytes)).sort()).toEqual(["page-001.jpg", "page-002.jpg", "page-003.jpg"]);
  const jpgPages = unzipSync(jpgZip.bytes);
  const rotatedJpg = await imageDimensions(page, jpgPages["page-003.jpg"], "image/jpeg");
  expect(rotatedJpg.width).toBeGreaterThan(rotatedJpg.height);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: "artifacts/tools-pdf-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "artifacts/tools-pdf-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel("전체 선택").check();
  await page.getByRole("button", { name: "선택 삭제" }).click();
  await expect(page.getByText("내보낼 페이지가 없습니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: /파일 다운로드/ })).toBeDisabled();
  expect(posted).toEqual([]);
  expect(errors).toEqual([]);
});

test("PDF compression is one level select defaulting to balanced, and each level keeps text", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "PDF 도구" }).click();
  const jpeg = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 512;
    const context = canvas.getContext("2d")!;
    const pixels = context.createImageData(512, 512);
    let state = 17;
    for (let index = 0; index < pixels.data.length; index += 4) {
      state = (state * 1664525 + 1013904223) >>> 0;
      pixels.data[index] = state & 255;
      pixels.data[index + 1] = (state >>> 8) & 255;
      pixels.data[index + 2] = (state >>> 16) & 255;
      pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.94).split(",")[1];
  }), "base64");
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  const sheet = source.addPage([600, 600]);
  for (let index = 0; index < 6; index++) {
    const embedded = await source.embedJpg(jpeg);
    sheet.drawImage(embedded, { x: 0, y: 0, width: 600, height: 600 });
  }
  sheet.drawText("KEEP TEXT", { x: 40, y: 40, font, size: 18 });
  const original = await source.save();
  await page.getByLabel("PDF 파일 선택").setInputFiles({
    name: "image-heavy.pdf", mimeType: "application/pdf", buffer: Buffer.from(original),
  });
  await expect(page.locator(".pdf-tool-page")).toHaveCount(1);
  await expect(page.locator(".pdf-tool-badge")).toHaveText(["페이지 1", "선택 0"]);
  await expect(page.getByText("PDF 작업공간", { exact: true })).toBeVisible();
  await expect(page.getByText(/브라우저 작업공간|브라우저 내 처리|서버 전송 없음/)).toHaveCount(0);
  await expect(page.getByText("고급 옵션")).toHaveCount(0);
  await expect(page.getByRole("radio")).toHaveCount(0);
  const level = page.getByLabel("압축");
  await expect(level).toHaveValue("balanced");
  await expect(level.locator("option")).toHaveText(["고화질", "균형 (권장)", "강력 압축"]);

  const textOf = async (bytes: Uint8Array) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("../../public/pdf.worker.mjs", import.meta.url).href;
    const task = pdfjs.getDocument({ data: bytes.slice() });
    try {
      return (await (await (await task.promise).getPage(1)).getTextContent()).items.map((item) => "str" in item ? item.str : "").join(" ");
    } finally { await task.destroy(); }
  };
  const save = async () => {
    const saved = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
    expect(Buffer.from(saved.bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    expect((await PDFDocument.load(saved.bytes)).getPageCount()).toBe(1);
    expect(await textOf(saved.bytes)).toContain("KEEP TEXT");
    return saved.bytes.length;
  };
  const balanced = await save();
  expect(balanced).toBeLessThan(original.length);
  await expect(page.locator(".pdf-tool-outcome")).toContainText(/감소/);

  await level.selectOption("size");
  expect(await save()).toBeLessThan(balanced);

  await level.selectOption("quality");
  expect(await save()).toBeGreaterThan(balanced);
  // Changing the level never touches the page workspace.
  await expect(page.locator(".pdf-tool-badge")).toHaveText(["페이지 1", "선택 0"]);
});

test("image editor chains resize, rotation, crop and merge with browser-only exports", async ({ page }) => {
  const posted: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST") posted.push(request.url()); });
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await page.getByRole("button", { name: "이미지 도구" }).click();
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const context = canvas.getContext("2d")!;
    for (let y = 0; y < 600; y += 10) for (let x = 0; x < 800; x += 10) {
      context.fillStyle = `rgb(${(x * 37 + y * 19) % 255}, ${(x * 13 + y * 47) % 255}, ${(x * 7 + y * 11) % 255})`;
      context.fillRect(x, y, 10, 10);
    }
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.getByLabel("이미지 파일 선택").setInputFiles({
    name: "pattern.png", mimeType: "image/png", buffer: Buffer.from(image, "base64"),
  });
  await expect(page.locator(".image-tool-preview canvas")).toHaveAttribute("width", "800");
  await page.getByLabel("너비 px").fill("400");
  await page.getByLabel("너비 px").press("Tab");
  await expect(page.getByLabel("높이 px")).toHaveValue("300");
  await page.getByRole("button", { name: /오른쪽 90°/ }).click();
  await expect(page.locator(".image-tool-preview canvas")).toHaveAttribute("width", "300");
  await page.locator(".image-tool-control-section").filter({ hasText: "영역 자르기" }).getByRole("button", { name: "영역 지정" }).click();
  const target = page.locator(".image-tool-pointer");
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.25, box!.y + box!.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.75, box!.y + box!.height * 0.75, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".image-tool-preview canvas")).toHaveAttribute("width", "150");
  const jpg = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(await imageDimensions(page, jpg.bytes, "image/jpeg")).toEqual({ width: 150, height: 200 });
  await page.getByLabel("품질").selectOption("high");
  const high = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  await page.getByLabel("품질").selectOption("small");
  const small = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(small.bytes.length).toBeLessThan(high.bytes.length);
  await page.getByLabel("형식").selectOption("webp");
  await page.getByLabel("품질").selectOption("high");
  const webpHigh = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  await page.getByLabel("품질").selectOption("small");
  const webpSmall = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(webpSmall.bytes.length).toBeLessThan(webpHigh.bytes.length);
  await page.getByLabel("형식").selectOption("png");
  const clean = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  await page.locator(".image-tool-control-section").filter({ hasText: "부분 모자이크" }).getByRole("button", { name: "영역 지정" }).click();
  const mosaicBox = await page.locator(".image-tool-pointer").boundingBox();
  await page.mouse.move(mosaicBox!.x + mosaicBox!.width * 0.25, mosaicBox!.y + mosaicBox!.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(mosaicBox!.x + mosaicBox!.width * 0.55, mosaicBox!.y + mosaicBox!.height * 0.55, { steps: 6 });
  await page.mouse.up();
  const mosaicked = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(await imagePixel(page, mosaicked.bytes, 10, 10)).toEqual(await imagePixel(page, clean.bytes, 10, 10));
  expect(await imagePixel(page, mosaicked.bytes, 60, 70)).not.toEqual(await imagePixel(page, clean.bytes, 60, 70));

  await page.getByLabel("이미지 파일 선택").setInputFiles({
    name: "second.png", mimeType: "image/png", buffer: Buffer.from(image, "base64"),
  });
  await expect(page.locator(".image-tool-file")).toHaveCount(2);
  await page.getByLabel("선택 이미지 한 장으로 결합").check();
  await page.getByLabel("형식").selectOption("png");
  const merged = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(await imageDimensions(page, merged.bytes, "image/png")).toEqual({ width: 950, height: 600 });
  await page.getByLabel("선택 이미지 한 장으로 결합").uncheck();
  const zipped = await downloadBytes(page, () => page.getByRole("button", { name: /ZIP 다운로드/ }).click());
  expect(Object.keys(unzipSync(zipped.bytes)).sort()).toEqual(["pattern.png", "second.png"]);
  await page.getByLabel("형식").selectOption("pdf");
  const pdf = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect((await PDFDocument.load(pdf.bytes)).getPageCount()).toBe(2);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: "artifacts/tools-image-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "artifacts/tools-image-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(posted).toEqual([]);
  expect(errors).toEqual([]);
});

test("image tool starts from the preview and exports in the dragged order with identity kept", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await page.getByRole("button", { name: "이미지 도구" }).click();
  const library = page.locator(".image-tool-library");
  await expect(library.getByText("추가된 이미지가 없습니다.", { exact: true })).toBeVisible();
  await expect(library.getByRole("button", { name: "+ 파일 추가" })).toHaveCount(0);
  await expect(page.getByText("이미지를 이곳에 놓으세요")).toHaveCount(0);
  const preview = page.locator(".image-tool-preview");
  await expect(preview.getByText("이미지를 추가해 편집을 시작하세요", { exact: true })).toBeVisible();
  await expect(preview.getByText("한 장씩 편집하거나 여러 이미지를 결합할 수 있습니다.", { exact: true })).toBeVisible();
  await expect(preview.getByRole("button", { name: "이미지 선택" })).toBeVisible();

  // Solid swatches of distinct widths make every output order observable.
  const swatches = await page.evaluate(() => [["a.png", "#ff0000", 100], ["b.png", "#00ff00", 120], ["c.png", "#0000ff", 140]].map(([name, color, width]) => {
    const canvas = document.createElement("canvas");
    canvas.width = Number(width);
    canvas.height = 50;
    const context = canvas.getContext("2d")!;
    context.fillStyle = String(color);
    context.fillRect(0, 0, canvas.width, canvas.height);
    return { name: String(name), data: canvas.toDataURL("image/png").split(",")[1] };
  }));
  const fileChooser = page.waitForEvent("filechooser");
  await preview.getByRole("button", { name: "이미지 선택" }).click();
  await (await fileChooser).setFiles(swatches.map(({ name, data }) => ({ name, mimeType: "image/png", buffer: Buffer.from(data, "base64") })));
  const files = page.locator(".image-tool-file strong");
  await expect(files).toHaveText(["a.png", "b.png", "c.png"]);
  await expect(library.getByRole("button", { name: "+ 파일 추가" })).toBeVisible();
  await expect(page.getByText(/별개입니다/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /(위로|아래로) 이동/ })).toHaveCount(0);

  await page.getByLabel("형식").selectOption("jpg");
  await expect(page.getByLabel("품질")).toHaveValue("balanced");
  await expect(page.getByLabel("품질").locator("option")).toHaveText(["고화질", "균형 (권장)", "강력 압축"]);
  await expect(page.locator(".image-tool-export")).not.toContainText("%");

  await page.locator(".image-tool-file-open").filter({ hasText: "b.png" }).click();
  await page.getByLabel("a.png 선택").uncheck();
  await dragGrip(page, page.getByRole("button", { name: "c.png 순서 변경" }), page.locator(".image-tool-file").first(), "before", "y");
  await expect(files).toHaveText(["c.png", "a.png", "b.png"]);
  await expect(page.locator(".image-tool-file.is-current strong")).toHaveText("b.png");
  await expect(page.getByLabel("a.png 선택")).not.toBeChecked();
  await expect(page.getByLabel("c.png 선택")).toBeChecked();
  await page.getByLabel("a.png 선택").check();

  await page.getByRole("button", { name: "b.png 순서 변경" }).focus();
  await page.keyboard.press("ArrowUp");
  await expect(files).toHaveText(["c.png", "b.png", "a.png"]);
  await page.keyboard.press("ArrowDown");
  await expect(files).toHaveText(["c.png", "a.png", "b.png"]);
  await expect(page.locator(".tool-reorder-live")).toHaveText("3번째 위치로 이동했습니다.");

  await page.getByLabel("형식").selectOption("png");
  const zipped = await downloadBytes(page, () => page.getByRole("button", { name: /ZIP 다운로드/ }).click());
  expect(Object.keys(unzipSync(zipped.bytes))).toEqual(["c.png", "a.png", "b.png"]);
  await page.getByLabel("형식").selectOption("pdf");
  const pdf = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  const widths = (await PDFDocument.load(pdf.bytes)).getPages().map((item) => item.getWidth());
  expect(widths[0]).toBeGreaterThan(widths[2]);
  expect(widths[2]).toBeGreaterThan(widths[1]);
  await page.getByLabel("선택 이미지 한 장으로 결합").check();
  await page.getByLabel("형식").selectOption("png");
  const merged = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect((await imagePixel(page, merged.bytes, 5, 25)).slice(0, 3)).toEqual([0, 0, 255]);
  expect((await imagePixel(page, merged.bytes, 145, 25)).slice(0, 3)).toEqual([255, 0, 0]);
  expect((await imagePixel(page, merged.bytes, 245, 25)).slice(0, 3)).toEqual([0, 255, 0]);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("mobile touch grip auto-scrolls a long image list and drops at the visible target", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Touch input is exercised through Chromium CDP.");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "이미지 도구" }).click();
  const data = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    canvas.getContext("2d")!.fillRect(0, 0, 16, 16);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.getByLabel("이미지 파일 선택").setInputFiles(Array.from({ length: 18 }, (_, i) => ({
    name: `touch-${String(i).padStart(2, "0")}.png`, mimeType: "image/png", buffer: Buffer.from(data, "base64"),
  })));
  await expect(page.getByText("이미지를 읽는 중…")).toHaveCount(0);
  const list = page.locator(".image-tool-file-list");
  await expect(page.locator(".image-tool-file")).toHaveCount(18);
  await list.evaluate((element) => { element.scrollIntoView({ block: "center", behavior: "instant" }); element.scrollTop = 0; });
  const grip = page.getByRole("button", { name: "touch-00.png 순서 변경" });
  const from = (await grip.boundingBox())!;
  const rect = (await list.boundingBox())!;
  const x = from.x + from.width / 2;
  const y = from.y + from.height / 2;
  const edgeY = Math.min(rect.y + rect.height - 24, 820);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const touch = async (type: "touchStart" | "touchMove" | "touchEnd", clientY: number) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: clientY, id: 1 }] });
  await touch("touchStart", y);
  await touch("touchMove", y + 8);
  await touch("touchMove", edgeY);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  const target = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-reorder-id]")?.getAttribute("data-reorder-id"), { x, y: edgeY });
  expect(target).toBeTruthy();
  await touch("touchEnd", edgeY);
  await expect(page.locator(".image-tool-file strong").first()).not.toHaveText("touch-00.png");
  await expect(page.locator(".tool-reorder-live")).toContainText("위치로 이동했습니다.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await cdp.detach();
});

test("large WebP sources use bounded previews without downscaling the export", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "이미지 도구" }).click();
  const webp = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2400;
    canvas.height = 1600;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#174c84";
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/webp").split(",")[1];
  }), "base64");
  await page.getByLabel("이미지 파일 선택").setInputFiles({
    name: "large.webp", mimeType: "image/webp", buffer: webp,
  });
  await expect(page.locator(".image-tool-dimensions")).toHaveText("2400 × 1600px");
  await expect(page.locator(".image-tool-preview canvas")).toHaveAttribute("width", "1440");
  await page.getByLabel("형식").selectOption("png");
  await expect(page.getByLabel("품질")).toHaveCount(0);
  const exported = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(await imageDimensions(page, exported.bytes, "image/png")).toEqual({ width: 2400, height: 1600 });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
