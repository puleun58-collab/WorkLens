import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { expect, test, type Page } from "@playwright/test";
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

async function downloadBytes(page: Page, click: () => Promise<void>) {
  const pending = page.waitForEvent("download");
  await click();
  const download = await pending;
  return { name: download.suggestedFilename(), bytes: new Uint8Array(await readFile(await download.path())) };
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
  await page.getByLabel("3번 페이지 왼쪽으로 이동").click();
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

  await page.getByLabel("저장 형식").selectOption("png");
  const pngZip = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
  expect(Object.keys(unzipSync(pngZip.bytes)).sort()).toEqual(["page-001.png", "page-002.png", "page-003.png"]);
  const pngPages = unzipSync(pngZip.bytes);
  const firstPng = await imageDimensions(page, pngPages["page-001.png"], "image/png");
  const rotatedPng = await imageDimensions(page, pngPages["page-003.png"], "image/png");
  expect(firstPng.width).toBeLessThan(firstPng.height);
  expect(rotatedPng.width).toBeGreaterThan(rotatedPng.height);
  await page.getByLabel("저장 형식").selectOption("jpg");
  const jpgZip = await downloadBytes(page, () => page.getByRole("button", { name: /파일 다운로드/ }).click());
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
  const level = page.getByLabel("압축 수준");
  await expect(level).toHaveValue("balanced");
  await expect(level.locator("option")).toHaveText(["고화질", "균형 (권장)", "강력 압축"]);
  await expect(page.locator(".pdf-tool-compression-detail")).toHaveText("품질과 파일 크기를 균형 있게 조정합니다.");

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
  await expect(page.locator(".pdf-tool-compression-detail")).toHaveText("파일 크기를 더 줄이며 이미지 품질이 낮아질 수 있습니다.");
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
