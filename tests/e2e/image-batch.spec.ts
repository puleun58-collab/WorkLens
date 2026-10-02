import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { expect, test, type Page } from "@playwright/test";

async function addImages(page: Page, sizes: Array<[string, number, number]>) {
  const files = await page.evaluate((entries) => entries.map(([name, width, height], index) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.fillStyle = ["#dd3322", "#229955", "#3355dd"][index];
    context.fillRect(0, 0, width, height);
    return { name, bytes: canvas.toDataURL("image/png").split(",")[1] };
  }), sizes);
  await page.getByLabel("이미지 파일 선택").setInputFiles(files.map(({ name, bytes }) => ({
    name, mimeType: "image/png", buffer: Buffer.from(bytes, "base64"),
  })));
  await expect(page.locator(".image-tool-file")).toHaveCount(sizes.length);
}

async function download(page: Page) {
  const pending = page.waitForEvent("download");
  await page.locator(".image-tool-export .tool-export-button").click();
  const result = await pending;
  return new Uint8Array(await readFile(await result.path()));
}

async function dimensions(page: Page, bytes: Uint8Array, mime: string) {
  return page.evaluate(async ({ image, type }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(image)], { type }));
    const result = [bitmap.width, bitmap.height];
    bitmap.close();
    return result;
  }, { image: [...bytes], type: mime });
}

async function openEditor(page: Page) {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await page.getByRole("button", { name: "이미지 도구" }).click();
}

async function active(page: Page, name: string) {
  await page.locator(".image-tool-file").filter({ hasText: name }).locator(".image-tool-file-open").click();
}

async function size(page: Page, width: number, height: number) {
  await expect(page.locator(".image-tool-dimensions")).toHaveText(`${width} × ${height}px`);
}

test("batch image edits use selected items, each ratio, and keep active preview and unselected images", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await openEditor(page);
  await addImages(page, [["a.png", 1000, 500], ["b.png", 1000, 1000], ["c.png", 1920, 1080]]);
  await page.getByLabel("c.png 선택").uncheck();
  // Same width (1000), different heights: only the differing field is blank, as a hint, never a value.
  await expect(page.getByLabel("너비 px")).toHaveValue("1000");
  await expect(page.getByLabel("너비 px")).not.toHaveAttribute("placeholder", /./);
  await expect(page.getByLabel("높이 px")).toHaveValue("");
  await expect(page.getByLabel("높이 px")).toHaveAttribute("placeholder", "서로 다른 값");
  await page.getByLabel("너비 px").fill("500");
  await page.getByLabel("너비 px").press("Tab");
  await size(page, 500, 250);
  await active(page, "b.png");
  await size(page, 500, 500);
  await active(page, "c.png");
  await size(page, 1920, 1080);
  await expect(page.locator(".image-tool-file.is-current strong")).toHaveText("c.png");
  await page.getByRole("button", { name: /오른쪽 90°/ }).click();
  await size(page, 1920, 1080); // Preview remains on the unselected active image.
  await active(page, "a.png");
  await size(page, 250, 500);
  await active(page, "b.png");
  await size(page, 500, 500);
  await page.getByLabel("높이 px").fill("200");
  await page.getByLabel("높이 px").press("Tab");
  await size(page, 200, 200);
  await active(page, "a.png");
  await size(page, 100, 200); // Each rotated image retains its own current ratio.
  await expect(page.getByLabel("c.png 선택")).not.toBeChecked();
  expect(errors).toEqual([]);
});

test("batch unlocked sizes and rotations are encoded in JPG, PNG, WebP and PDF exports", async ({ page }) => {
  await openEditor(page);
  await addImages(page, [["a.png", 1000, 500], ["b.png", 1920, 1080], ["c.png", 500, 500]]);
  await page.getByLabel("c.png 선택").uncheck();
  await page.getByLabel("비율 유지").uncheck();
  await page.getByLabel("너비 px").fill("800");
  await page.getByLabel("너비 px").press("Tab");
  await size(page, 1000, 500); // Mixed values need both dimensions with the lock off.
  await page.getByLabel("높이 px").fill("600");
  await page.getByLabel("높이 px").press("Tab");
  await size(page, 800, 600);
  await active(page, "b.png");
  await size(page, 800, 600);
  await active(page, "c.png");
  await size(page, 500, 500);
  await page.getByRole("button", { name: /오른쪽 90°/ }).click();
  await size(page, 500, 500);
  await active(page, "a.png");
  await size(page, 600, 800);
  await active(page, "b.png");
  await size(page, 600, 800);
  await expect(page.locator(".image-tool-file.is-current strong")).toHaveText("b.png");
  for (const [format, mime] of [["jpg", "image/jpeg"], ["png", "image/png"], ["webp", "image/webp"]] as const) {
    await page.getByLabel("형식").selectOption(format);
    const files = unzipSync(await download(page));
    expect(Object.keys(files).sort()).toEqual([`a.${format}`, `b.${format}`]);
    for (const bytes of Object.values(files)) expect(await dimensions(page, bytes, mime)).toEqual([600, 800]);
  }
  await page.getByLabel("형식").selectOption("pdf");
  const pdf = await PDFDocument.load(await download(page));
  expect(pdf.getPages().map((entry) => [entry.getWidth(), entry.getHeight()])).toEqual([[600, 800], [600, 800]]);
  await page.getByLabel("b.png 선택").uncheck();
  await active(page, "a.png");
  await expect(page.getByLabel("너비 px")).toHaveValue("600");
  await page.getByLabel("너비 px").fill("300");
  await page.getByLabel("너비 px").press("Tab");
  await active(page, "a.png");
  await size(page, 300, 800);
  await active(page, "b.png");
  await size(page, 600, 800);
});

test("same-size selection displays shared dimensions and applies the same resize", async ({ page }) => {
  await openEditor(page);
  await addImages(page, [["a.png", 1000, 500], ["b.png", 1000, 500]]);
  await expect(page.getByLabel("너비 px")).toHaveValue("1000");
  await expect(page.getByLabel("높이 px")).toHaveValue("500");
  await page.getByLabel("너비 px").fill("800");
  await page.getByLabel("너비 px").press("Tab");
  await size(page, 800, 400);
  await active(page, "b.png");
  await size(page, 800, 400);
});
