import { zip } from "fflate";
import { degrees, PDFDocument } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";

export interface PdfPageItem {
  id: string;
  sourceId: string;
  pageNumber: number;
  /** Clockwise quarter-turns beyond the source page's own rotation. */
  rotation: number;
  selected: boolean;
}

export interface PdfInputSource {
  name: string;
  file: Blob;
  document: PDFDocumentProxy;
}

export type PdfOutputFormat = "pdf" | "jpg" | "png";
export type PdfCompression = "off" | "structure" | "raster";

export interface PdfExportResult {
  bytes: Uint8Array;
  name: string;
  mime: string;
  pageCount: number;
  inputBytes: number;
}

export function normalizeRotation(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

export function movePdfPage<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return [...items];
  const next = [...items];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

export function pagesForExport(items: readonly PdfPageItem[], scope: "all" | "selected"): PdfPageItem[] {
  return scope === "selected" ? items.filter((page) => page.selected) : [...items];
}

export function pdfError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "작업이 취소되었습니다.";
  const message = error instanceof Error ? error.message : String(error);
  if (/password|encrypt|encrypted|decryption/i.test(message)) return "암호화되거나 비밀번호가 설정된 PDF는 열 수 없습니다.";
  if (/invalid pdf|missing pdf|corrupt|xref|parse|formaterror/i.test(message)) return "PDF 파일이 손상되었거나 올바른 PDF가 아닙니다.";
  if (/memory|allocation|out of memory|canvas/i.test(message)) return "페이지를 렌더링할 메모리가 부족합니다. 파일 수나 페이지 크기를 줄여 다시 시도하세요.";
  return message || "PDF 처리 중 오류가 발생했습니다.";
}

export function ensureNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
}

export interface RenderedPdfPage {
  bytes: Uint8Array;
  /** Rendered viewport dimensions at scale 1, in PDF points. */
  width: number;
  height: number;
}

export type PdfPageRenderer = (
  source: PdfInputSource,
  page: PdfPageItem,
  format: "jpg" | "png",
  maxEdge: number,
  quality: number,
  signal?: AbortSignal,
) => Promise<RenderedPdfPage>;

/** Export the current ordered selection; no network access and no intermediary document upload. */
export async function exportPdfPages(options: {
  pages: readonly PdfPageItem[];
  sources: ReadonlyMap<string, PdfInputSource>;
  format: PdfOutputFormat;
  compression: PdfCompression;
  render?: PdfPageRenderer;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}): Promise<PdfExportResult> {
  const { pages, sources, format, compression, render, signal, onProgress } = options;
  if (!pages.length) throw new Error("내보낼 페이지를 선택하세요.");
  ensureNotCancelled(signal);
  const includedSources = new Set(pages.map((page) => page.sourceId));
  const inputBytes = [...includedSources].reduce((sum, id) => sum + (sources.get(id)?.file.size ?? 0), 0);
  const name = format === "pdf" ? "worklens-pages.pdf" : pages.length === 1 ? `page-001.${format}` : `worklens-pages-${format}.zip`;

  if (format === "pdf" && compression !== "raster") {
    const result = await PDFDocument.create();
    const loaded = new Map<string, PDFDocument>();
    for (const [index, item] of pages.entries()) {
      ensureNotCancelled(signal);
      const source = sources.get(item.sourceId);
      if (!source) throw new Error("원본 PDF가 제거되었습니다.");
      let original = loaded.get(item.sourceId);
      if (!original) {
        original = await PDFDocument.load(await source.file.arrayBuffer(), { updateMetadata: false });
        loaded.set(item.sourceId, original);
      }
      ensureNotCancelled(signal);
      const originalPage = original.getPage(item.pageNumber - 1);
      const [copied] = await result.copyPages(original, [item.pageNumber - 1]);
      copied.setRotation(degrees(normalizeRotation(originalPage.getRotation().angle + item.rotation)));
      result.addPage(copied);
      onProgress?.(index + 1, pages.length);
    }
    ensureNotCancelled(signal);
    // Structure mode allows object streams. This may or may not reduce bytes; caller reports the measured result.
    const bytes = await result.save({ useObjectStreams: compression === "structure" });
    ensureNotCancelled(signal);
    return { bytes, name, mime: "application/pdf", pageCount: pages.length, inputBytes };
  }

  if (!render) throw new Error("이 형식은 브라우저 페이지 렌더링이 필요합니다.");
  const output = format === "pdf" ? await PDFDocument.create() : null;
  const images: Record<string, Uint8Array> = {};
  for (const [index, item] of pages.entries()) {
    ensureNotCancelled(signal);
    const source = sources.get(item.sourceId);
    if (!source) throw new Error("원본 PDF가 제거되었습니다.");
    const imageFormat = format === "png" ? "png" : "jpg";
    const rendered = await render(source, item, imageFormat, format === "pdf" ? 1300 : 1800, format === "pdf" ? 0.64 : 0.86, signal);
    ensureNotCancelled(signal);
    if (output) {
      const image = await output.embedJpg(rendered.bytes);
      const page = output.addPage([rendered.width, rendered.height]);
      page.drawImage(image, { x: 0, y: 0, width: rendered.width, height: rendered.height });
    } else {
      const filename = `page-${String(index + 1).padStart(Math.max(3, String(pages.length).length), "0")}.${format}`;
      images[filename] = rendered.bytes;
    }
    onProgress?.(index + 1, pages.length);
  }
  ensureNotCancelled(signal);
  if (output) {
    const bytes = await output.save({ useObjectStreams: true });
    ensureNotCancelled(signal);
    return { bytes, name, mime: "application/pdf", pageCount: pages.length, inputBytes };
  }
  if (pages.length === 1) {
    const bytes = images[name];
    return { bytes, name, mime: format === "png" ? "image/png" : "image/jpeg", pageCount: 1, inputBytes };
  }
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (const [filename, bytes] of Object.entries(images)) entries[filename] = [bytes, { level: 0 }];
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    const onAbort = () => {
      terminate();
      reject(new DOMException("Operation cancelled", "AbortError"));
    };
    const terminate = zip(entries, (error, archive) => {
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(archive);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  ensureNotCancelled(signal);
  return { bytes, name, mime: "application/zip", pageCount: pages.length, inputBytes };
}
