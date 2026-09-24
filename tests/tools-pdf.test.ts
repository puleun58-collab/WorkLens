import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { unzipSync } from "fflate";
import { degrees, PDFDocument, PDFName, PDFRawStream, StandardFonts } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { describe, expect, it, vi } from "vitest";
import { exportPdfPages, movePdfPage, pagesForExport, pdfError, PDF_COMPRESSION, type PdfCompression, type PdfInputSource, type PdfPageItem } from "@/lib/tools/pdf";

const jpeg = new Uint8Array(Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AP//Z", "base64"));
const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
const KEEP: PdfCompression = { level: "quality", rasterize: false };
const RASTER: PdfCompression = { level: "balanced", rasterize: true };

const source = (name: string, bytes: Uint8Array): PdfInputSource => ({
  name,
  file: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }),
  document: {} as PDFDocumentProxy,
});

async function textPdf(labels: string[], firstRotation = 0): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const [index, label] of labels.entries()) {
    const page = document.addPage([400, 600]);
    page.drawText(label, { x: 30, y: 540, font, size: 16 });
    if (index === 0) page.setRotation(degrees(firstRotation));
  }
  return document.save();
}

describe("PDF tools output", () => {
  it("merges different originals in edited order, omits deleted pages and adds rotation to the source rotation without rasterizing text", async () => {
    const inputs = new Map([
      ["alpha", source("alpha.pdf", await textPdf(["ALPHA FIRST", "ALPHA SECOND"]))],
      ["beta", source("beta.pdf", await textPdf(["BETA FIRST"], 270))],
    ]);
    const pages: PdfPageItem[] = [
      { id: "b1", sourceId: "beta", pageNumber: 1, rotation: 90, selected: true },
      { id: "a2", sourceId: "alpha", pageNumber: 2, rotation: 270, selected: true },
      { id: "a1", sourceId: "alpha", pageNumber: 1, rotation: 0, selected: false },
    ];
    const selected = pagesForExport(pages, "selected");
    const result = await exportPdfPages({ pages: selected, sources: inputs, format: "pdf", compression: KEEP });
    const output = await PDFDocument.load(result.bytes);
    expect(output.getPageCount()).toBe(2);
    expect(output.getPages().map((page) => page.getRotation().angle)).toEqual([0, 270]);
    expect(result.pageCount).toBe(2);
    expect(result.inputBytes).toBe(inputs.get("alpha")!.file.size + inputs.get("beta")!.file.size);
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("../public/pdf.worker.mjs", import.meta.url).href;
    const task = pdfjs.getDocument({ data: result.bytes });
    try {
      const pdf = await task.promise;
      const text: string[] = [];
      for (let index = 1; index <= pdf.numPages; index++) {
        const page = await pdf.getPage(index);
        text.push((await page.getTextContent()).items.map((item) => "str" in item ? item.str : "").join(" "));
        page.cleanup();
      }
      expect(text).toEqual([expect.stringContaining("BETA FIRST"), expect.stringContaining("ALPHA SECOND")]);
      expect(text.join(" ")).not.toContain("ALPHA FIRST");
    } finally {
      await task.destroy();
    }
  });

  it("uses the same final sequence and rotations for numbered image entries, including selected-only export", async () => {
    const inputs = new Map([["a", source("one.pdf", await textPdf(["ONE", "TWO"]))]]);
    const original: PdfPageItem[] = [
      { id: "first", sourceId: "a", pageNumber: 1, rotation: 90, selected: true },
      { id: "second", sourceId: "a", pageNumber: 2, rotation: 270, selected: true },
      { id: "removed", sourceId: "a", pageNumber: 1, rotation: 0, selected: false },
    ];
    const pages = pagesForExport(movePdfPage(original, 1, 0), "selected");
    const calls: string[] = [];
    const result = await exportPdfPages({
      pages, sources: inputs, format: "png", compression: KEEP,
      render: async (_source, page, format) => {
        calls.push(`${page.pageNumber}:${page.rotation}:${format}`);
        return { bytes: new TextEncoder().encode(page.id), width: 400, height: 600 };
      },
    });
    const zipped = unzipSync(result.bytes);
    expect(result.mime).toBe("application/zip");
    expect(Object.keys(zipped).sort()).toEqual(["page-001.png", "page-002.png"]);
    expect(new TextDecoder().decode(zipped["page-001.png"])).toBe("second");
    expect(new TextDecoder().decode(zipped["page-002.png"])).toBe("first");
    expect(calls).toEqual(["2:270:png", "1:90:png"]);
  });

  it("can save a single selected JPG directly rather than wrapping it in a ZIP", async () => {
    const inputs = new Map([["a", source("one.pdf", await textPdf(["ONE"]))]]);
    const result = await exportPdfPages({
      pages: [{ id: "only", sourceId: "a", pageNumber: 1, rotation: 180, selected: true }],
      sources: inputs, format: "jpg", compression: KEEP,
      render: async () => ({ bytes: new Uint8Array([1, 2, 3]), width: 400, height: 600 }),
    });
    expect(result.name).toBe("page-001.jpg");
    expect(result.mime).toBe("image/jpeg");
    expect([...result.bytes]).toEqual([1, 2, 3]);
  });
  it("produces a smaller, correctly oriented raster PDF for an image-heavy original", async () => {
    const original = await PDFDocument.create();
    const page = original.addPage([400, 600]);
    for (let index = 0; index < 120; index++) {
      const tile = await original.embedJpg(jpeg);
      page.drawImage(tile, { x: (index % 12) * 33, y: Math.floor(index / 12) * 55, width: 32, height: 54 });
    }
    const input = source("tiles.pdf", await original.save());
    const result = await exportPdfPages({
      pages: [{ id: "tiles", sourceId: "tiles", pageNumber: 1, rotation: 90, selected: true }],
      sources: new Map([["tiles", input]]), format: "pdf", compression: RASTER,
      render: async (_source, selected, format, maxEdge) => {
        expect(selected.rotation).toBe(90);
        expect(format).toBe("jpg");
        expect(maxEdge).toBe(PDF_COMPRESSION.balanced.rasterEdge);
        return { bytes: jpeg, width: 600, height: 400 };
      },
    });
    const reduced = await PDFDocument.load(result.bytes);
    expect(reduced.getPageCount()).toBe(1);
    expect(reduced.getPage(0).getSize()).toEqual({ width: 600, height: 400 });
    expect(result.bytes.length).toBeLessThan(input.file.size);
  });
});

describe("PDF export validation and cancellation", () => {
  const page: PdfPageItem = { id: "first", sourceId: "original", pageNumber: 1, rotation: 0, selected: true };

  it("classifies cancellation, password, corruption, memory and otherwise preserves error details", () => {
    expect(pdfError(new DOMException("cancelled", "AbortError"))).toBe("작업이 취소되었습니다.");
    expect(pdfError(new Error("Encrypted document requires a password"))).toBe("암호화되거나 비밀번호가 설정된 PDF는 열 수 없습니다.");
    expect(pdfError(new Error("Invalid PDF: missing xref table"))).toBe("PDF 파일이 손상되었거나 올바른 PDF가 아닙니다.");
    expect(pdfError(new Error("Canvas allocation failed"))).toBe("페이지를 렌더링할 메모리가 부족합니다. 파일 수나 페이지 크기를 줄여 다시 시도하세요.");
    expect(pdfError(new Error("Disk read failed"))).toBe("Disk read failed");
    expect(pdfError("Unexpected response")).toBe("Unexpected response");
    expect(pdfError(new Error(""))).toBe("PDF 처리 중 오류가 발생했습니다.");
  });

  it("returns a separate unchanged sequence for invalid and same-index page moves", () => {
    const original = ["one", "two", "three"];
    for (const [from, to] of [[-1, 1], [3, 1], [1, -1], [1, 3], [1, 1]]) {
      const result = movePdfPage(original, from, to);
      expect(result).toEqual(original);
      expect(result).not.toBe(original);
    }
    expect(movePdfPage(original, 0, 2)).toEqual(["two", "three", "one"]);
    expect(original).toEqual(["one", "two", "three"]);
  });

  it("exports all pages regardless of selection, but selected scope excludes unselected pages", () => {
    const pages = [page, { ...page, id: "second", selected: false }];
    const all = pagesForExport(pages, "all");
    expect(all).toEqual(pages);
    expect(all).not.toBe(pages);
    expect(pagesForExport(pages, "selected")).toEqual([page]);
    expect(pages).toHaveLength(2);
  });

  it("rejects an empty selection before producing any output", async () => {
    await expect(exportPdfPages({ pages: [], sources: new Map(), format: "pdf", compression: KEEP }))
      .rejects.toThrow("내보낼 페이지를 선택하세요.");
  });

  it("rejects removed originals in both copy and renderer paths", async () => {
    const render = vi.fn(async () => ({ bytes: jpeg, width: 1, height: 1 }));
    await expect(exportPdfPages({ pages: [page], sources: new Map(), format: "pdf", compression: KEEP }))
      .rejects.toThrow("원본 PDF가 제거되었습니다.");
    await expect(exportPdfPages({ pages: [page], sources: new Map(), format: "png", compression: KEEP, render }))
      .rejects.toThrow("원본 PDF가 제거되었습니다.");
    expect(render).not.toHaveBeenCalled();
  });

  it("requires a renderer for image export and raster PDF export", async () => {
    const sources = new Map([["original", source("original.pdf", await textPdf(["ONE"]))]]);
    await expect(exportPdfPages({ pages: [page], sources, format: "png", compression: KEEP }))
      .rejects.toThrow("이 형식은 브라우저 페이지 렌더링이 필요합니다.");
    await expect(exportPdfPages({ pages: [page], sources, format: "jpg", compression: KEEP }))
      .rejects.toThrow("이 형식은 브라우저 페이지 렌더링이 필요합니다.");
    await expect(exportPdfPages({ pages: [page], sources, format: "pdf", compression: RASTER }))
      .rejects.toThrow("이 형식은 브라우저 페이지 렌더링이 필요합니다.");
  });

  it("rejects an already aborted export with AbortError before rendering", async () => {
    const controller = new AbortController();
    controller.abort();
    const render = vi.fn(async () => ({ bytes: jpeg, width: 1, height: 1 }));
    await expect(exportPdfPages({
      pages: [page], sources: new Map(), format: "jpg", compression: KEEP, signal: controller.signal, render,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(render).not.toHaveBeenCalled();
  });

  it("pads multi-page ZIP filenames so lexical order matches the page order past nine", async () => {
    const pages = Array.from({ length: 12 }, (_, index) => ({ ...page, id: String(index + 1) }));
    const sources = new Map([["original", source("original.pdf", await textPdf(["ONE"]))]]);
    const result = await exportPdfPages({
      pages, sources, format: "png", compression: KEEP,
      render: async (_source, item) => ({ bytes: new TextEncoder().encode(item.id), width: 1, height: 1 }),
    });
    const entries = unzipSync(result.bytes);
    expect(Object.keys(entries).sort()).toEqual(pages.map((_, index) => `page-${String(index + 1).padStart(3, "0")}.png`));
    expect(new TextDecoder().decode(entries["page-010.png"])).toBe("10");
    expect(result.pageCount).toBe(12);
  });

  it("terminates ZIP creation when cancelled after entries have been rendered", async () => {
    const controller = new AbortController();
    const addEventListener = controller.signal.addEventListener.bind(controller.signal);
    const onSubscription = vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
      addEventListener(...args);
      if (args[0] === "abort") controller.abort();
    });
    const sources = new Map([["original", source("original.pdf", await textPdf(["ONE"]))]]);
    const render = vi.fn(async () => ({ bytes: jpeg, width: 1, height: 1 }));
    try {
      await expect(exportPdfPages({
        pages: [page, { ...page, id: "second" }], sources, format: "jpg", compression: KEEP,
        render, signal: controller.signal,
      })).rejects.toMatchObject({ name: "AbortError" });
      expect(render).toHaveBeenCalledTimes(2);
      expect(onSubscription).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    } finally {
      onSubscription.mockRestore();
    }
  });
});

describe("PDF compression levels", () => {
  async function mixedPdf(): Promise<Uint8Array> {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([400, 600]);
    page.drawText("KEEP TEXT", { x: 30, y: 540, font, size: 16 });
    page.drawImage(await document.embedJpg(jpeg), { x: 30, y: 300, width: 200, height: 200 });
    page.drawImage(await document.embedPng(png), { x: 250, y: 300, width: 100, height: 100 });
    return document.save();
  }

  const imageStreams = (document: PDFDocument) => document.context.enumerateIndirectObjects()
    .map(([, object]) => object)
    .filter((object): object is PDFRawStream => object instanceof PDFRawStream && object.dict.lookup(PDFName.of("Subtype")) === PDFName.of("Image"));

  const page: PdfPageItem = { id: "p", sourceId: "mixed", pageNumber: 1, rotation: 0, selected: true };

  it("re-encodes only embedded JPEG images at the level's budget and keeps the page text", async () => {
    const sources = new Map([["mixed", source("mixed.pdf", await mixedPdf())]]);
    const smaller = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const recompress = vi.fn(async () => ({ bytes: smaller, width: 7, height: 5 }));
    const result = await exportPdfPages({ pages: [page], sources, format: "pdf", compression: { level: "size", rasterize: false }, recompress });
    expect(recompress).toHaveBeenCalledTimes(1);
    expect(recompress).toHaveBeenCalledWith(expect.any(Uint8Array), PDF_COMPRESSION.size.imageEdge, PDF_COMPRESSION.size.imageQuality, undefined);
    const output = await PDFDocument.load(result.bytes);
    const jpegImage = imageStreams(output).find((stream) => stream.dict.lookup(PDFName.of("Filter")) === PDFName.of("DCTDecode"))!;
    expect([...jpegImage.getContents()]).toEqual([...smaller]);
    expect([jpegImage.dict.lookup(PDFName.of("Width")), jpegImage.dict.lookup(PDFName.of("Height"))].map(String)).toEqual(["7", "5"]);
    expect(imageStreams(output).some((stream) => stream.dict.lookup(PDFName.of("Filter")) === PDFName.of("FlateDecode"))).toBe(true);
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("../public/pdf.worker.mjs", import.meta.url).href;
    const task = pdfjs.getDocument({ data: result.bytes });
    try {
      const text = await (await (await task.promise).getPage(1)).getTextContent();
      expect(text.items.map((item) => "str" in item ? item.str : "").join(" ")).toContain("KEEP TEXT");
    } finally {
      await task.destroy();
    }
  });

  it("keeps an embedded image whose re-encoding would not be smaller", async () => {
    const sources = new Map([["mixed", source("mixed.pdf", await mixedPdf())]]);
    const recompress = vi.fn(async () => ({ bytes: new Uint8Array(jpeg.length + 10), width: 1, height: 1 }));
    const result = await exportPdfPages({ pages: [page], sources, format: "pdf", compression: { level: "balanced", rasterize: false }, recompress });
    const jpegImage = imageStreams(await PDFDocument.load(result.bytes)).find((stream) => stream.dict.lookup(PDFName.of("Filter")) === PDFName.of("DCTDecode"))!;
    expect([...jpegImage.getContents()]).toEqual([...jpeg]);
  });

  it("never re-encodes images at quality level and refuses lossy levels without an image encoder", async () => {
    const sources = new Map([["mixed", source("mixed.pdf", await mixedPdf())]]);
    const recompress = vi.fn();
    await exportPdfPages({ pages: [page], sources, format: "pdf", compression: KEEP, recompress });
    expect(recompress).not.toHaveBeenCalled();
    await expect(exportPdfPages({ pages: [page], sources, format: "pdf", compression: { level: "balanced", rasterize: false } }))
      .rejects.toThrow("이미지 압축에는 브라우저 이미지 처리가 필요합니다.");
  });
});
