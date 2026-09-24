import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { unzipSync } from "fflate";
import { degrees, PDFDocument, StandardFonts } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { describe, expect, it } from "vitest";
import { exportPdfPages, movePdfPage, pagesForExport, type PdfInputSource, type PdfPageItem } from "@/lib/tools/pdf";

const jpeg = new Uint8Array(Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AP//Z", "base64"));

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
    const result = await exportPdfPages({ pages: selected, sources: inputs, format: "pdf", compression: "off" });
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
      pages, sources: inputs, format: "png", compression: "off",
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
      sources: inputs, format: "jpg", compression: "off",
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
      sources: new Map([["tiles", input]]), format: "pdf", compression: "raster",
      render: async (_source, selected, format, maxEdge) => {
        expect(selected.rotation).toBe(90);
        expect(format).toBe("jpg");
        expect(maxEdge).toBe(1300);
        return { bytes: jpeg, width: 600, height: 400 };
      },
    });
    const reduced = await PDFDocument.load(result.bytes);
    expect(reduced.getPageCount()).toBe(1);
    expect(reduced.getPage(0).getSize()).toEqual({ width: 600, height: 400 });
    expect(result.bytes.length).toBeLessThan(input.file.size);
  });
});
