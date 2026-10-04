import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { unzipSync } from "fflate";
import sharp from "sharp";
import * as pdfjs from "pdfjs-dist";
import { createPdf } from "../fixtures";
import { OUT, openView, regressionCase, writeFixture, noHorizontalOverflow } from "./record";

type Result = { name: string; bytes: Buffer };
type Size = { width: number; height: number };

async function enter(page: Page, tool: "PDF 도구" | "이미지 도구") {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await openView(page, tool);
}

async function saved(page: Page, click?: () => Promise<void>): Promise<Result> {
  const pending = page.waitForEvent("download");
  await (click ?? (() => page.locator(".tool-export-button").click()))();
  const download = await pending;
  const name = download.suggestedFilename();
  const destination = path.join(OUT, `${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
  await download.saveAs(destination);
  return { name, bytes: await readFile(destination) };
}

async function pdfInput(page: Page, filename: string, bytes: Uint8Array) {
  const file = await writeFixture(filename, bytes);
  await page.getByLabel("PDF 파일 선택").setInputFiles(file);
  await expect(page.locator(".pdf-tool-source-name").filter({ hasText: filename })).toBeVisible();
  await expect(page.getByRole("button", { name: "PDF 추가" })).toBeEnabled();
}

async function sizedPdf(...sizes: [number, number][]) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  sizes.forEach(([width, height], index) => {
    const page = pdf.addPage([width, height]);
    page.drawText(`LABEL ${index + 1}`, { x: 20, y: height - 35, size: 14, font });
  });
  return pdf.save();
}

async function pdfSizes(result: Result): Promise<Size[]> {
  expect(result.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  const pdf = await PDFDocument.load(result.bytes);
  return pdf.getPages().map((page) => ({ width: page.getWidth(), height: page.getHeight() }));
}

async function imageInput(page: Page, name: string, width: number, height: number, color = "#d13254") {
  const extension = name.split(".").pop()!.toLowerCase();
  const format = extension === "jpg" || extension === "jpeg" ? "jpeg" : extension;
  const data = await sharp({ create: { width, height, channels: 4, background: color } }).toFormat(format as "jpeg" | "png" | "webp").toBuffer();
  const file = await writeFixture(name, data);
  await page.getByLabel("이미지 파일 선택").setInputFiles(file);
  await expect(page.locator(".image-tool-file").filter({ hasText: name })).toBeVisible();
  return file;
}

async function imageFiles(page: Page, specs: [string, number, number, string][]) {
  const paths = await Promise.all(specs.map(async ([name, width, height, color]) => {
    const format = name.split(".").pop()!.replace(/^jpe?g$/, "jpeg");
    const bytes = await sharp({ create: { width, height, channels: 4, background: color } }).toFormat(format as "jpeg" | "png" | "webp").toBuffer();
    return writeFixture(name, bytes);
  }));
  await page.getByLabel("이미지 파일 선택").setInputFiles(paths);
  await expect(page.locator(".image-tool-file")).toHaveCount(paths.length);
}

async function decoded(result: Result, format: "jpeg" | "png" | "webp", size: Size) {
  const info = await sharp(result.bytes).metadata();
  expect(info.format).toBe(format);
  expect({ width: info.width, height: info.height }).toEqual(size);
  return info;
}

// coss Select exposes a combobox trigger and portal-mounted listbox options.
async function selectToolOption(page: Page, surface: Locator, label: string, option: string | RegExp) {
  const trigger = surface.getByRole("combobox", { name: label, exact: true });
  await trigger.click();
  await page.getByRole("listbox").getByRole("option", { name: option, exact: true }).click();
  await expect(trigger).toHaveText(option);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
}

async function imageExport(page: Page, format: "jpg" | "png" | "webp" | "pdf") {
  const labels = { jpg: "JPG", png: "PNG", webp: "WebP", pdf: "PDF" };
  await selectToolOption(page, page.locator(".image-tool-export"), "형식", labels[format]);
  return saved(page);
}

async function dragRegion(page: Page, mode: "자르기" | "모자이크") {
  const controls = page.locator(".image-tool-control-section").filter({ has: page.getByRole("heading", { name: mode }) });
  await controls.getByRole("button", { name: "영역 지정" }).click();
  const target = page.locator(".image-tool-pointer");
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 8 });
  await page.mouse.up();
}

regressionCase({ id: "TOOL-01", category: "PDF", input: "Single portrait PDF", format: "PDF", structure: "One page", expected: "Downloaded PDF retains its page dimensions", mobile: true }, async ({ page, note }) => {
  await enter(page, "PDF 도구");
  await pdfInput(page, "tool-single.pdf", await createPdf(["SINGLE"]));
  const result = await saved(page);
  const dimensions = await pdfSizes(result);
  note(`${result.name}: ${JSON.stringify(dimensions)}`);
  expect(result.name).toBe("worklens-pages.pdf");
  expect(dimensions).toEqual([{ width: 595, height: 842 }]);
  await noHorizontalOverflow(page);
});

regressionCase({ id: "TOOL-02", category: "PDF", input: "Three mixed-size PDFs interleaved via keyboard", format: "PDF", structure: "5 pages / 3 sources", expected: "Export preserves cross-file page order and exact page sizes" }, async ({ page, note }) => {
  await enter(page, "PDF 도구");
  await pdfInput(page, "tool-alpha.pdf", await sizedPdf([301, 501], [302, 502]));
  await pdfInput(page, "tool-beta.pdf", await sizedPdf([701, 401]));
  await pdfInput(page, "tool-gamma.pdf", await sizedPdf([504, 704], [505, 705]));
  await expect(page.locator(".pdf-tool-page")).toHaveCount(5);
  await page.getByRole("button", { name: "4번 페이지 순서 변경" }).focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".pdf-tool-page-meta strong")).toHaveText(["tool-alpha.pdf", "tool-gamma.pdf", "tool-alpha.pdf", "tool-beta.pdf", "tool-gamma.pdf"]);
  const sizes = await pdfSizes(await saved(page));
  note(`Interleaved page dimensions: ${JSON.stringify(sizes)}`);
  expect(sizes).toEqual([{ width: 301, height: 501 }, { width: 504, height: 704 }, { width: 302, height: 502 }, { width: 701, height: 401 }, { width: 505, height: 705 }]);
});

regressionCase({ id: "TOOL-03", category: "PDF", input: "Select none, some, then all", format: "PDF", structure: "3 distinct pages", expected: "Selected export disabled at zero, contains only checked page, then all three", mobile: true }, async ({ page, note }) => {
  await enter(page, "PDF 도구");
  await pdfInput(page, "tool-selection.pdf", await sizedPdf([210, 310], [220, 320], [230, 330]));
  await selectToolOption(page, page.locator(".pdf-tool-export"), "페이지", /^선택 \(\d+\)$/u);
  await expect(page.locator(".tool-export-button")).toBeDisabled();
  await page.getByRole("checkbox", { name: "2번 페이지 선택", exact: true }).check();
  const some = await pdfSizes(await saved(page));
  await page.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  const all = await pdfSizes(await saved(page));
  await page.getByRole("checkbox", { name: "전체 선택", exact: true }).uncheck();
  await expect(page.locator(".tool-export-button")).toBeDisabled();
  note(`Selected ${JSON.stringify(some)}, all ${JSON.stringify(all)}, none disables export`);
  expect(some).toEqual([{ width: 220, height: 320 }]);
  expect(all.map((item) => item.width)).toEqual([210, 220, 230]);
  await noHorizontalOverflow(page);
});

regressionCase({ id: "TOOL-04", category: "PDF", input: "Rotate selected pages both directions", format: "PDF", structure: "Portrait and landscape", expected: "Downloaded pages carry independent 270° and 90° rotations" }, async ({ page, note }) => {
  await enter(page, "PDF 도구");
  await pdfInput(page, "tool-rotation.pdf", await sizedPdf([410, 610], [810, 510]));
  await page.getByRole("checkbox", { name: "1번 페이지 선택", exact: true }).check();
  await page.getByRole("button", { name: /왼쪽 90°/ }).click();
  await page.getByRole("checkbox", { name: "1번 페이지 선택", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "2번 페이지 선택", exact: true }).check();
  await page.getByRole("button", { name: /오른쪽 90°/ }).click();
  const pdf = await PDFDocument.load((await saved(page)).bytes);
  const rotations = pdf.getPages().map((item) => item.getRotation().angle);
  note(`Rotations ${rotations.join(", ")}`);
  expect(rotations).toEqual([270, 90]);
  expect(pdf.getPages().map((item) => item.getWidth())).toEqual([410, 810]);
});

regressionCase({ id: "TOOL-05", category: "PDF", input: "Delete selection and remove an entire source", format: "PDF", structure: "3 sources; 4 pages", expected: "Removed pages do not appear in downloaded PDF" }, async ({ page, note }) => {
  await enter(page, "PDF 도구");
  await pdfInput(page, "tool-delete-a.pdf", await sizedPdf([311, 411], [312, 412]));
  await pdfInput(page, "tool-delete-b.pdf", await sizedPdf([313, 413]));
  await pdfInput(page, "tool-delete-c.pdf", await sizedPdf([314, 414]));
  await page.getByRole("checkbox", { name: "2번 페이지 선택", exact: true }).check();
  await page.getByRole("button", { name: "선택 삭제" }).click();
  await page.getByRole("button", { name: "tool-delete-b.pdf 제거" }).click();
  const sizes = await pdfSizes(await saved(page));
  note(`Surviving source widths: ${sizes.map(({ width }) => width).join(", ")}`);
  expect(sizes.map(({ width }) => width)).toEqual([311, 314]);
  await expect(page.locator(".pdf-tool-source")).toHaveCount(2);
});

regressionCase({ id: "TOOL-06", category: "PDF", input: "Delete every page and add fresh input", format: "PDF", structure: "Empty then re-populated", expected: "Empty state disables export and later upload yields only new content" }, async ({ page, note }) => {
  await enter(page, "PDF 도구");
  await pdfInput(page, "tool-clear.pdf", await sizedPdf([340, 440], [341, 441]));
  await page.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  await page.getByRole("button", { name: "선택 삭제" }).click();
  await expect(page.locator(".pdf-tool-page")).toHaveCount(0);
  await expect(page.locator(".pdf-tool-source")).toHaveCount(0);
  await expect(page.locator(".pdf-tool-export")).toHaveCount(0);
  await pdfInput(page, "tool-readded.pdf", await sizedPdf([540, 640]));
  const sizes = await pdfSizes(await saved(page));
  note(`After empty state: ${JSON.stringify(sizes)}`);
  expect(sizes).toEqual([{ width: 540, height: 640 }]);
});

regressionCase({ id: "TOOL-07", category: "PDF", input: "Single PDF page to JPG", format: "JPG", structure: "Landscape page", expected: "Download is JPEG with landscape pixel dimensions" }, async ({ page, note }) => {
  await enter(page, "PDF 도구");
  await pdfInput(page, "tool-jpeg.pdf", await sizedPdf([800, 400]));
  await selectToolOption(page, page.locator(".pdf-tool-export"), "형식", "JPG");
  const result = await saved(page);
  const meta = await sharp(result.bytes).metadata();
  note(`${result.name}: ${meta.format} ${meta.width}x${meta.height}`);
  expect(result.name).toBe("page-001.jpg");
  expect(meta.format).toBe("jpeg");
  expect(meta.width).toBe(1440);
  expect(meta.height).toBe(720);
});

regressionCase({ id: "TOOL-08", category: "PDF", input: "Selected pages to PNG ZIP", format: "PNG ZIP", structure: "3 PDFs; select two differently oriented pages", expected: "Two correctly ordered PNGs with orientation and count", mobile: true }, async ({ page, note }) => {
  await enter(page, "PDF 도구");
  await pdfInput(page, "tool-z1.pdf", await sizedPdf([400, 800]));
  await pdfInput(page, "tool-z2.pdf", await sizedPdf([800, 400]));
  await pdfInput(page, "tool-z3.pdf", await sizedPdf([550, 800]));
  await page.getByRole("checkbox", { name: "1번 페이지 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: "2번 페이지 선택", exact: true }).check();
  await page.getByRole("button", { name: /오른쪽 90°/ }).click();
  await page.getByRole("checkbox", { name: "1번 페이지 선택", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "3번 페이지 선택", exact: true }).check();
  await selectToolOption(page, page.locator(".pdf-tool-export"), "페이지", /^선택 \(\d+\)$/u);
  await selectToolOption(page, page.locator(".pdf-tool-export"), "형식", "PNG");
  const result = await saved(page);
  const files = unzipSync(result.bytes);
  const names = Object.keys(files);
  const sizes = await Promise.all(names.map(async (name) => { const meta = await sharp(files[name]).metadata(); expect(meta.format).toBe("png"); return [meta.width, meta.height]; }));
  note(`${result.name}: ${names.join(", ")} ${JSON.stringify(sizes)}`);
  expect(names).toEqual(["page-001.png", "page-002.png"]);
  expect(sizes).toEqual([[720, 1440], [990, 1440]]);
  await noHorizontalOverflow(page);
});

regressionCase({ id: "TOOL-09", category: "PDF", input: "Three PDF pages to JPG ZIP", format: "JPG ZIP", structure: "1 file, 3 page sizes", expected: "Each ZIP member is a JPEG in page order" }, async ({ page, note }) => {
  await enter(page, "PDF 도구");
  await pdfInput(page, "tool-jpg-zip.pdf", await sizedPdf([300, 600], [600, 300], [400, 400]));
  await selectToolOption(page, page.locator(".pdf-tool-export"), "형식", "JPG");
  const result = await saved(page);
  const files = unzipSync(result.bytes);
  const names = Object.keys(files);
  const sizes = await Promise.all(names.map(async (name) => { const meta = await sharp(files[name]).metadata(); expect(meta.format).toBe("jpeg"); return [meta.width, meta.height]; }));
  note(`${result.name}: ${names.join(", ")} ${JSON.stringify(sizes)}`);
  expect(names).toEqual(["page-001.jpg", "page-002.jpg", "page-003.jpg"]);
  expect(sizes).toEqual([[540, 1080], [1080, 540], [720, 720]]);
});

regressionCase({ id: "TOOL-10", category: "PDF", input: "Three PDF compression levels", format: "PDF", structure: "Image-heavy page with text", expected: "Every level keeps original page geometry and text-bearing page", mobile: true }, async ({ page, note }) => {
  await enter(page, "PDF 도구");
  const pixels = Buffer.alloc(1000 * 1000 * 3);
  let state = 17;
  for (let index = 0; index < pixels.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pixels[index] = state >>> 24;
  }
  const noise = await sharp(pixels, { raw: { width: 1000, height: 1000, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const doc = await PDFDocument.create();
  const image = await doc.embedJpg(noise);
  const pageIn = doc.addPage([640, 740]);
  pageIn.drawImage(image, { x: 10, y: 100, width: 620, height: 620 });
  pageIn.drawText("RETAIN TEXT", { x: 20, y: 30, font: await doc.embedFont(StandardFonts.Helvetica) });
  await pdfInput(page, "tool-compression.pdf", await doc.save());
  const lengths: number[] = [];
  for (const compression of ["고화질", "균형 (권장)", "강력 압축"]) {
    await selectToolOption(page, page.locator(".pdf-tool-export"), "압축", compression);
    const output = await saved(page);
    expect(await pdfSizes(output)).toEqual([{ width: 640, height: 740 }]);
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("../../public/pdf.worker.mjs", import.meta.url).href;
    const task = pdfjs.getDocument({ data: new Uint8Array(output.bytes) });
    try {
      const text = (await (await (await task.promise).getPage(1)).getTextContent()).items
        .map((item) => "str" in item ? item.str : "").join(" ");
      expect(text).toContain("RETAIN TEXT");
    } finally {
      await task.destroy();
    }
    lengths.push(output.bytes.length);
  }
  note(`Quality/balanced/size bytes: ${lengths.join("/")}`);
  expect(lengths[2]).toBeLessThan(lengths[0]);
  await noHorizontalOverflow(page);
});

regressionCase({ id: "TOOL-11", category: "PDF", input: "Corrupt PDF and non-PDF inputs", format: "Invalid PDF + TXT", structure: "Two unsupported uploads followed by a valid one", expected: "Both errors displayed; valid upload still works" }, async ({ page, note, classify }) => {
  await enter(page, "PDF 도구");
  const corrupt = await writeFixture("tool-corrupt.pdf", Buffer.from("not a pdf"));
  await page.getByLabel("PDF 파일 선택").setInputFiles(corrupt);
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText("tool-corrupt.pdf");
  const corruptError = await page.locator('[role="alert"]:not(#__next-route-announcer__)').innerText();
  const invalid = await writeFixture("tool-not-pdf.txt", "not a pdf");
  await page.getByLabel("PDF 파일 선택").setInputFiles(invalid);
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText("PDF 파일을 선택하세요.");
  await expect(page.locator(".pdf-tool-source")).toHaveCount(0);
  await pdfInput(page, "tool-recovery.pdf", await sizedPdf([321, 421]));
  expect(await pdfSizes(await saved(page))).toEqual([{ width: 321, height: 421 }]);
  note(`Corrupt: ${corruptError}; wrong extension: PDF 파일을 선택하세요.; valid file recovered`);
  classify("Unsupported");
});

regressionCase({ id: "TOOL-12", category: "PDF", input: "Export cancellation", format: "PNG then PDF", structure: "Multi-page render cancelled mid-operation", expected: "Cancellation preserves source pages for subsequent PDF export" }, async ({ page, note }) => {
  await enter(page, "PDF 도구");
  await pdfInput(page, "tool-cancel.pdf", await sizedPdf(...Array.from({ length: 18 }, (_, index) => [450 + index, 650] as [number, number])));
  await selectToolOption(page, page.locator(".pdf-tool-export"), "형식", "PNG");
  await page.locator(".tool-export-button").click();
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("button", { name: "취소", exact: true })).toHaveCount(0);
  await expect(page.locator(".pdf-tool-page")).toHaveCount(18);
  await selectToolOption(page, page.locator(".pdf-tool-export"), "형식", "PDF");
  const sizes = await pdfSizes(await saved(page));
  note(`Cancelled rendering, then ${sizes.length} pages exported`);
  expect(sizes.map(({ width }) => width)).toEqual(Array.from({ length: 18 }, (_, index) => 450 + index));
});

for (const [id, extension, width, height, format] of [
  ["TOOL-13", "jpg", 240, 360, "jpeg"],
  ["TOOL-14", "jpeg", 360, 240, "jpeg"],
  ["TOOL-15", "png", 180, 180, "png"],
  ["TOOL-16", "webp", 2400, 1600, "webp"],
] as const) {
  regressionCase({ id, category: "Image", input: `${extension.toUpperCase()} ${width}×${height} round-trip`, format: extension, structure: "One original image", expected: "Decoded download has requested format and full source dimensions", mobile: id === "TOOL-13" || id === "TOOL-16" }, async ({ page, note }) => {
    await enter(page, "이미지 도구");
    await imageInput(page, `tool-format-${id}.${extension}`, width, height);
    const result = await imageExport(page, extension === "jpeg" ? "jpg" : extension);
    const info = await decoded(result, format, { width, height });
    note(`${result.name}: ${info.format} ${info.width}×${info.height}`);
    await noHorizontalOverflow(page);
  });
}

regressionCase({ id: "TOOL-17", category: "Image", input: "Tiny image and aspect-locked width and height resizing", format: "PNG", structure: "1×1 and 800×600 inputs", expected: "Tiny image exports unchanged; width/height edits retain original ratio" }, async ({ page, note }) => {
  await enter(page, "이미지 도구");
  await imageInput(page, "tool-tiny.png", 1, 1);
  await decoded(await imageExport(page, "png"), "png", { width: 1, height: 1 });
  await imageInput(page, "tool-resize.png", 800, 600);
  await page.locator(".image-tool-file-open").filter({ hasText: "tool-resize.png" }).click();
  await page.getByRole("checkbox", { name: "tool-tiny.png 선택", exact: true }).uncheck();
  await page.getByLabel("너비 px").fill("400");
  await page.getByLabel("너비 px").press("Tab");
  await expect(page.getByLabel("높이 px")).toHaveValue("300");
  await decoded(await saved(page), "png", { width: 400, height: 300 });
  await page.getByLabel("높이 px").fill("150");
  await page.getByLabel("높이 px").press("Tab");
  const result = await saved(page);
  await decoded(result, "png", { width: 200, height: 150 });
  note(`Tiny 1×1; locked width 400×300 then locked height ${200}×${150}`);
});

regressionCase({ id: "TOOL-18", category: "Image", input: "Unlinked dimensions and both rotations", format: "PNG", structure: "300×180 asymmetric input", expected: "Unlocked resize is independent; left then right restores size" }, async ({ page, note }) => {
  await enter(page, "이미지 도구");
  await imageInput(page, "tool-unlocked.png", 300, 180);
  await page.getByRole("checkbox", { name: "비율 유지", exact: true }).uncheck();
  await page.getByLabel("너비 px").fill("200");
  await page.getByLabel("너비 px").press("Tab");
  await imageExport(page, "png").then((result) => decoded(result, "png", { width: 200, height: 180 }));
  await page.getByRole("button", { name: /왼쪽 90°/ }).click();
  await decoded(await saved(page), "png", { width: 180, height: 200 });
  await page.getByRole("button", { name: /오른쪽 90°/ }).click();
  const result = await saved(page);
  await decoded(result, "png", { width: 200, height: 180 });
  note(`Independent 200×180; left 180×200; right restored 200×180`);
});

regressionCase({ id: "TOOL-19", category: "Image", input: "Free cropped area", format: "PNG", structure: "400×300 image; drag from 20% to 70%", expected: "Export is 200×150 and crop reset restores source", mobile: true }, async ({ page, note }) => {
  await enter(page, "이미지 도구");
  await imageInput(page, "tool-crop-free.png", 400, 300);
  await expect(page.locator(".image-tool-control-section").filter({ has: page.getByRole("heading", { name: "자르기", exact: true }) }).getByLabel("선택 비율")).toHaveCount(0);
  await dragRegion(page, "자르기");
  const output = await imageExport(page, "png");
  const info = await decoded(output, "png", { width: 200, height: 150 });
  await page.locator(".image-tool-control-section").filter({ has: page.getByRole("heading", { name: "자르기", exact: true }) }).getByRole("button", { name: "자르기 해제" }).click();
  await decoded(await saved(page), "png", { width: 400, height: 300 });
  note(`Free crop ${info.width}×${info.height}; reset 400×300`);
  await noHorizontalOverflow(page);
});

regressionCase({ id: "TOOL-23", category: "Image", input: "Mosaic region and reset", format: "PNG", structure: "Patterned PNG with center mosaic", expected: "Region pixels change while outside stays unchanged; reset restores exact bytes" }, async ({ page, note }) => {
  await enter(page, "이미지 도구");
  const image = await sharp({ create: { width: 160, height: 160, channels: 3, background: "#ffffff" } }).raw().toBuffer();
  for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) {
    const offset = (y * 160 + x) * 3;
    image[offset] = (x * 37 + y * 13) % 256;
    image[offset + 1] = (x * 11 + y * 29) % 256;
    image[offset + 2] = (x * 3 + y * 43) % 256;
  }
  const file = await writeFixture("tool-mosaic.png", await sharp(image, { raw: { width: 160, height: 160, channels: 3 } }).png().toBuffer());
  await page.getByLabel("이미지 파일 선택").setInputFiles(file);
  await expect(page.locator(".image-tool-file")).toHaveCount(1);
  const clean = await imageExport(page, "png");
  await dragRegion(page, "모자이크");
  const mosaic = await saved(page);
  const cleanPixels = await sharp(clean.bytes).removeAlpha().raw().toBuffer();
  const mosaicPixels = await sharp(mosaic.bytes).removeAlpha().raw().toBuffer();
  const pixel = (data: Buffer, x: number, y: number) => [...data.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3)];
  expect(pixel(mosaicPixels, 10, 10)).toEqual(pixel(cleanPixels, 10, 10));
  expect(pixel(mosaicPixels, 70, 70)).not.toEqual(pixel(cleanPixels, 70, 70));
  await page.locator(".image-tool-control-section").filter({ has: page.getByRole("heading", { name: "모자이크", exact: true }) }).getByRole("button", { name: "모자이크 해제" }).click();
  const reset = await saved(page);
  await decoded(reset, "png", { width: 160, height: 160 });
  expect(await sharp(reset.bytes).removeAlpha().raw().toBuffer()).toEqual(cleanPixels);
  note(`Center changed ${pixel(cleanPixels, 70, 70)}→${pixel(mosaicPixels, 70, 70)}; outside and reset retained`);
});

regressionCase({ id: "TOOL-23b", category: "Image", input: "Default blur strength on a hard edge", format: "PNG", structure: "Black/white edge inside selected region", expected: "Default blur creates intermediate pixels; higher strength widens the softened edge without changing outside" }, async ({ page, note }) => {
  await enter(page, "이미지 도구");
  const pixels = Buffer.alloc(160 * 160 * 3);
  for (let y = 0; y < 160; y++) for (let x = 80; x < 160; x++) pixels.fill(255, (y * 160 + x) * 3, (y * 160 + x + 1) * 3);
  await page.getByLabel("이미지 파일 선택").setInputFiles(await writeFixture("tool-blur-edge.png", await sharp(pixels, { raw: { width: 160, height: 160, channels: 3 } }).png().toBuffer()));
  await expect(page.locator(".image-tool-controls h4")).toHaveText(["크기 · 회전", "자르기", "모자이크", "결합"]);
  const slider = page.getByRole("slider", { name: /강도/ });
  await expect(slider).toHaveValue("12");
  await dragRegion(page, "모자이크");
  const blurred = await imageExport(page, "png");
  const light = await sharp(blurred.bytes).removeAlpha().raw().toBuffer();
  const at = (data: Buffer, x: number, y: number) => data[(y * 160 + x) * 3];
  expect(at(light, 10, 80)).toBe(0);
  expect(at(light, 78, 80)).toBeGreaterThan(0);
  expect(at(light, 78, 80)).toBeLessThan(255);
  await slider.fill("48");
  const strong = await sharp((await saved(page)).bytes).removeAlpha().raw().toBuffer();
  expect(at(strong, 60, 80)).toBeGreaterThan(at(light, 60, 80));
  expect(at(strong, 10, 80)).toBe(0);
  note(`Blur 12px at edge ${at(light, 78, 80)}; 48px at x60 ${at(strong, 60, 80)} > ${at(light, 60, 80)}`);
});

const COLORS = { red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0], magenta: [255, 0, 255] } as const;
for (const [id, count, label, cells] of [
  ["TOOL-24", 2, "좌우", [[0.25, 0.5], [0.75, 0.5]]],
  ["TOOL-25", 2, "상하", [[0.5, 0.25], [0.5, 0.75]]],
  ["TOOL-26", 3, "위 2 · 아래 1", [[0.25, 0.25], [0.75, 0.25], [0.5, 0.75]]],
  ["TOOL-26b", 3, "위 1 · 아래 2", [[0.5, 0.25], [0.25, 0.75], [0.75, 0.75]]],
  ["TOOL-26c", 4, "2×2", [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]],
  ["TOOL-26d", 5, "격자", [[1 / 6, 0.25], [0.5, 0.25], [5 / 6, 0.25], [0.25, 0.75], [0.75, 0.75]]],
] as const) {
  regressionCase({ id, category: "Image", input: `1:1 merge · ${count} images · ${label}`, format: "PNG", structure: `${count} differently sized colored images`, expected: "Square output; each cell filled by its image in list order; gap 0", mobile: id === "TOOL-26" }, async ({ page, note }) => {
    await enter(page, "이미지 도구");
    const colors = (["red", "green", "blue", "yellow", "magenta"] as const).slice(0, count);
    await imageFiles(page, colors.map((color, index) => [`tool-merge-${id}-${index}.png`, 60 + index * 30, 90 - index * 20, color] as [string, number, number, string]));
    await page.getByRole("checkbox", { name: "선택 이미지 한 장으로 결합", exact: true }).check();
    await expect(page.getByLabel("간격 px")).toHaveCount(0); await expect(page.getByLabel("배경")).toHaveCount(0);
    await expect(page.locator('[aria-label="배치"]').getByRole("radio")).toHaveCount(count >= 4 ? 1 : 2);
    await page.locator('[aria-label="비율"]').getByRole("radio", { name: "1:1" }).check({ force: true });
    await page.locator('[aria-label="배치"]').getByRole("radio", { name: label }).check({ force: true });
    const output = await imageExport(page, "png");
    const meta = await sharp(output.bytes).metadata();
    expect(meta.width).toBe(meta.height);
    const pixels = await sharp(output.bytes).raw().ensureAlpha().toBuffer();
    const at = (fx: number, fy: number) => { const i = (Math.floor(fy * meta.height!) * meta.width! + Math.floor(fx * meta.width!)) * 4; return [...pixels.subarray(i, i + 3)]; };
    cells.forEach(([fx, fy], index) => expect(at(fx, fy), `cell ${index + 1}`).toEqual([...COLORS[colors[index]]]));
    // Check both pixels at a split; the cells meet with no unpainted band.
    if (label === "상하" || label === "위 1 · 아래 2") {
      const edge = Math.round(meta.height! / 2);
      expect(at(0.25, (edge - 1) / meta.height!)).toEqual([...COLORS.red]);
      expect(at(0.25, edge / meta.height!)).toEqual([...COLORS.green]);
    } else {
      const edge = Math.round(meta.width! / (count === 5 ? 3 : 2));
      expect(at((edge - 1) / meta.width!, 0.25)).toEqual([...COLORS.red]);
      expect(at(edge / meta.width!, 0.25)).toEqual([...COLORS.green]);
    }
    note(`${meta.width}×${meta.height}; cells ${colors.join(" → ")} in order, no gap`);
    await noHorizontalOverflow(page);
  });
}

regressionCase({ id: "TOOL-26e", category: "Image", input: "4:3 vertical merge preview/export", format: "PNG", structure: "2 asymmetric colored images", expected: "Preview pixels and downloaded PNG share dimensions, layout and colors" }, async ({ page, note }) => {
  await enter(page, "이미지 도구");
  await imageFiles(page, [["tool-ratio-red.png", 80, 120, "red"], ["tool-ratio-blue.png", 100, 60, "blue"]]);
  await page.getByRole("checkbox", { name: "선택 이미지 한 장으로 결합", exact: true }).check();
  await page.locator('[aria-label="비율"]').getByRole("radio", { name: "4:3" }).check({ force: true });
  await page.locator('[aria-label="배치"]').getByRole("radio", { name: "상하" }).check({ force: true });
  const canvas = page.getByLabel("결합 이미지 미리보기");
  await expect.poll(async () => canvas.evaluate((element: HTMLCanvasElement) => element.width / element.height)).toBeCloseTo(4 / 3, 2);
  const preview = await canvas.evaluate((element: HTMLCanvasElement) => {
    const ctx = element.getContext("2d")!;
    return { width: element.width, height: element.height,
      top: [...ctx.getImageData(element.width / 2, element.height / 4, 1, 1).data].slice(0, 3),
      bottom: [...ctx.getImageData(element.width / 2, 3 * element.height / 4, 1, 1).data].slice(0, 3) };
  });
  const output = await imageExport(page, "png");
  const info = await sharp(output.bytes).metadata();
  const raw = await sharp(output.bytes).ensureAlpha().raw().toBuffer();
  const at = (y: number) => [...raw.subarray((Math.floor(y * info.height!) * info.width! + Math.floor(info.width! / 2)) * 4, (Math.floor(y * info.height!) * info.width! + Math.floor(info.width! / 2)) * 4 + 3)];
  expect(preview).toEqual({ width: info.width, height: info.height, top: [...COLORS.red], bottom: [...COLORS.blue] });
  expect(at(0.25)).toEqual(preview.top);
  expect(at(0.75)).toEqual(preview.bottom);
  note(`${info.width}×${info.height} 4:3; preview equals export in both cells`);
});

regressionCase({ id: "TOOL-27", category: "Image", input: "Four selected images into ZIP", format: "PNG ZIP", structure: "JPG, JPEG, PNG, WebP inputs", expected: "Four independently decoded PNG entries preserve source sizes" }, async ({ page, note }) => {
  await enter(page, "이미지 도구");
  await imageFiles(page, [["tool-four-a.jpg", 80, 50, "red"], ["tool-four-b.jpeg", 90, 60, "green"], ["tool-four-c.png", 100, 70, "blue"], ["tool-four-d.webp", 110, 80, "yellow"]]);
  await selectToolOption(page, page.locator(".image-tool-export"), "형식", "PNG");
  const result = await saved(page);
  const files = unzipSync(result.bytes);
  const names = Object.keys(files);
  const dimensions = await Promise.all(names.map(async (name) => { const image = await sharp(files[name]).metadata(); expect(image.format).toBe("png"); return [image.width, image.height]; }));
  note(`${result.name}: ${names.join(", ")}; ${JSON.stringify(dimensions)}`);
  expect(names).toEqual(["tool-four-a.png", "tool-four-b.png", "tool-four-c.png", "tool-four-d.png"]);
  expect(dimensions).toEqual([[80, 50], [90, 60], [100, 70], [110, 80]]);
});

regressionCase({ id: "TOOL-28", category: "Image", input: "Multiple images into PDF", format: "PDF", structure: "3 differently oriented images", expected: "PDF page dimensions and ordering match selected images" }, async ({ page, note }) => {
  await enter(page, "이미지 도구");
  await imageFiles(page, [["tool-pdf-a.png", 100, 200, "red"], ["tool-pdf-b.jpg", 220, 120, "green"], ["tool-pdf-c.webp", 80, 80, "blue"]]);
  const result = await imageExport(page, "pdf");
  const sizes = await pdfSizes(result);
  note(`${result.name}: ${JSON.stringify(sizes)}`);
  expect(result.name).toBe("images.pdf");
  expect(sizes).toEqual([{ width: 100, height: 200 }, { width: 220, height: 120 }, { width: 80, height: 80 }]);
});

regressionCase({ id: "TOOL-29", category: "Image", input: "Merged image exported as PDF", format: "PDF", structure: "2 PNGs 좌우 at default 1:1", expected: "One square PDF page" }, async ({ page, note }) => {
  await enter(page, "이미지 도구");
  await imageFiles(page, [["tool-pdf-merge-a.png", 100, 70, "red"], ["tool-pdf-merge-b.png", 90, 80, "blue"]]);
  await page.getByRole("checkbox", { name: "선택 이미지 한 장으로 결합", exact: true }).check();
  const result = await imageExport(page, "pdf");
  const sizes = await pdfSizes(result);
  note(`${result.name}: ${JSON.stringify(sizes)}`);
  expect(result.name).toBe("merged-images.pdf");
  expect(sizes).toEqual([{ width: 200, height: 200 }]);
});

regressionCase({ id: "TOOL-30", category: "Image", input: "Invalid image type and corrupt PNG", format: "TXT and invalid PNG", structure: "Rejected inputs then valid image", expected: "Visible rejection and recovery with valid PNG", mobile: true }, async ({ page, note, classify }) => {
  await enter(page, "이미지 도구");
  const invalid = await writeFixture("tool-image-invalid.txt", "not an image");
  await page.getByLabel("이미지 파일 선택").setInputFiles(invalid);
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText("JPG, PNG, WebP 파일만 사용할 수 있습니다.");
  const corrupt = await writeFixture("tool-image-corrupt.png", "not a png");
  await page.getByLabel("이미지 파일 선택").setInputFiles(corrupt);
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText("tool-image-corrupt.png");
  await expect(page.locator(".image-tool-file")).toHaveCount(0);
  await imageInput(page, "tool-image-recovered.png", 33, 22);
  const result = await imageExport(page, "png");
  const info = await decoded(result, "png", { width: 33, height: 22 });
  note(`Wrong type and corrupt image rejected; valid ${info.width}×${info.height} recovered`);
  classify("Unsupported");
  await noHorizontalOverflow(page);
});
