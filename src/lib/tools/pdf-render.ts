import type * as PdfJs from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { ensureNotCancelled, normalizeRotation, type PdfInputSource, type PdfPageItem, type RenderedPdfPage } from "./pdf";

let pdfjsPromise: Promise<typeof PdfJs> | undefined;

export async function loadBrowserPdf(
  file: Blob,
  signal?: AbortSignal,
  onTask?: (task: PDFDocumentLoadingTask) => void,
): Promise<{ document: PDFDocumentProxy; task: PDFDocumentLoadingTask }> {
  // PDF.js is large; load it only after a user actually adds a local PDF.
  pdfjsPromise ??= import("pdfjs-dist");
  const pdfjs = await pdfjsPromise;
  ensureNotCancelled(signal);
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";
  // PDF.js transfers ownership of the bytes to its local worker. Keep only the Blob for exports.
  const bytes = await file.arrayBuffer();
  ensureNotCancelled(signal);
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), stopAtErrors: true });
  onTask?.(task);
  try {
    const document = await task.promise;
    ensureNotCancelled(signal);
    return { document, task };
  } catch (error) {
    await task.destroy();
    throw error;
  }
}

export async function renderBrowserPdfPage(
  source: PdfInputSource,
  item: PdfPageItem,
  format: "jpg" | "png",
  maxEdge: number,
  quality: number,
  signal?: AbortSignal,
): Promise<RenderedPdfPage> {
  ensureNotCancelled(signal);
  const page = await source.document.getPage(item.pageNumber);
  let canvas: HTMLCanvasElement | undefined;
  let task: RenderTask | undefined;
  try {
    ensureNotCancelled(signal);
    const rotation = normalizeRotation(page.rotate + item.rotation);
    const points = page.getViewport({ scale: 1, rotation });
    const scale = Math.min(1.8, maxEdge / Math.max(points.width, points.height));
    const viewport = page.getViewport({ scale, rotation });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));
    // A single page at a time; never render every source page at full resolution.
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: format === "png" });
    if (!context) throw new Error("이 브라우저에서는 PDF 페이지를 그릴 수 없습니다.");
    task = page.render({ canvas, canvasContext: context, viewport, background: format === "jpg" ? "#ffffff" : undefined });
    const onAbort = () => task?.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await task.promise;
      ensureNotCancelled(signal);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas?.toBlob((result) => result ? resolve(result) : reject(new Error("이미지를 인코딩할 수 없습니다. 메모리를 확인하세요.")), format === "jpg" ? "image/jpeg" : "image/png", quality);
      });
      ensureNotCancelled(signal);
      return { bytes: new Uint8Array(await blob.arrayBuffer()), width: points.width, height: points.height };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    if (task) {
      // Cancellation rejects the render promise; wait for it to settle before releasing the page.
      try { await task.promise; } catch { /* The original exception propagates. */ }
    }
    page.cleanup();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

/** Decodes one embedded JPEG, scales it to `maxEdge`, and re-encodes it; undefined if the browser cannot decode it. */
export async function recompressBrowserJpeg(
  jpeg: Uint8Array,
  maxEdge: number,
  quality: number,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; width: number; height: number } | undefined> {
  ensureNotCancelled(signal);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
  } catch {
    // CMYK or otherwise unsupported JPEGs keep their original bytes.
    return undefined;
  }
  const canvas = document.createElement("canvas");
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return undefined;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    ensureNotCancelled(signal);
    return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height } : undefined;
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}
