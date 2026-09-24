import { zip } from "fflate";
import { degrees, PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import type { PDFObject } from "pdf-lib";
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
export type PdfCompressionLevel = "quality" | "balanced" | "size";
/** How hard to compress, and whether pages may be replaced by pictures of themselves. */
export interface PdfCompression {
  level: PdfCompressionLevel;
  rasterize: boolean;
}

/**
 * Per level: embedded JPEG re-encode budget (absent = images untouched) and the
 * render budget used only when pages are rasterized.
 */
export const PDF_COMPRESSION: Record<PdfCompressionLevel, { imageEdge?: number; imageQuality?: number; rasterEdge: number; rasterQuality: number }> = {
  quality: { rasterEdge: 1800, rasterQuality: 0.85 },
  balanced: { imageEdge: 2400, imageQuality: 0.78, rasterEdge: 1300, rasterQuality: 0.7 },
  size: { imageEdge: 1600, imageQuality: 0.6, rasterEdge: 1000, rasterQuality: 0.55 },
};

/** Re-encodes one JPEG no larger than `maxEdge`; undefined when the browser cannot decode it. */
export type PdfImageRecompressor = (
  jpeg: Uint8Array,
  maxEdge: number,
  quality: number,
  signal?: AbortSignal,
) => Promise<{ bytes: Uint8Array; width: number; height: number } | undefined>;

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
  recompress?: PdfImageRecompressor;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}): Promise<PdfExportResult> {
  const { pages, sources, format, compression, render, recompress, signal, onProgress } = options;
  const settings = PDF_COMPRESSION[compression.level];
  if (!pages.length) throw new Error("내보낼 페이지를 선택하세요.");
  ensureNotCancelled(signal);
  const includedSources = new Set(pages.map((page) => page.sourceId));
  const inputBytes = [...includedSources].reduce((sum, id) => sum + (sources.get(id)?.file.size ?? 0), 0);
  const name = format === "pdf" ? "worklens-pages.pdf" : pages.length === 1 ? `page-001.${format}` : `worklens-pages-${format}.zip`;

  if (format === "pdf" && !compression.rasterize) {
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
    if (settings.imageEdge !== undefined && settings.imageQuality !== undefined) {
      if (!recompress) throw new Error("이미지 압축에는 브라우저 이미지 처리가 필요합니다.");
      await recompressJpegImages(result, settings.imageEdge, settings.imageQuality, recompress, signal);
    }
    // Object streams are lossless; the caller reports the measured size either way.
    const bytes = await result.save({ useObjectStreams: true });
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
    const rendered = await render(source, item, imageFormat, format === "pdf" ? settings.rasterEdge : 1800, format === "pdf" ? settings.rasterQuality : 0.86, signal);
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

/** Number of colour components a JPEG image XObject declares, or undefined when unsafe to re-encode. */
function jpegComponents(pdf: PDFDocument, colorSpace: PDFObject | undefined): number | undefined {
  const space = pdf.context.lookup(colorSpace);
  if (space === PDFName.of("DeviceRGB")) return 3;
  if (space === PDFName.of("DeviceGray")) return 1;
  if (space instanceof PDFArray && space.size() === 2 && space.lookup(0) === PDFName.of("ICCBased")) {
    const profile = space.lookup(1);
    const count = profile instanceof PDFRawStream ? profile.dict.lookup(PDFName.of("N")) : undefined;
    return count instanceof PDFNumber && (count.asNumber() === 3 || count.asNumber() === 1) ? count.asNumber() : undefined;
  }
  return undefined;
}

/**
 * Lossy only for photographs: each plain RGB/Gray JPEG image is re-encoded at the
 * level's size and quality and kept only if that is smaller. Text, vectors,
 * links and forms are untouched; CMYK, masked, indexed or decoded images are skipped.
 */
async function recompressJpegImages(
  pdf: PDFDocument,
  maxEdge: number,
  quality: number,
  recompress: PdfImageRecompressor,
  signal?: AbortSignal,
): Promise<void> {
  const dct = PDFName.of("DCTDecode");
  const images = pdf.context.enumerateIndirectObjects().filter(([, object]) => {
    if (!(object instanceof PDFRawStream) || object.dict.lookup(PDFName.of("Subtype")) !== PDFName.of("Image")) return false;
    const filter = object.dict.lookup(PDFName.of("Filter"));
    const onlyJpeg = filter === dct || (filter instanceof PDFArray && filter.size() === 1 && filter.lookup(0) === dct);
    const bits = object.dict.lookup(PDFName.of("BitsPerComponent"));
    return onlyJpeg && bits instanceof PDFNumber && bits.asNumber() === 8
      && !object.dict.has(PDFName.of("Decode")) && !object.dict.has(PDFName.of("ImageMask"))
      && jpegComponents(pdf, object.dict.get(PDFName.of("ColorSpace"))) !== undefined;
  });
  for (const [ref, object] of images) {
    ensureNotCancelled(signal);
    const stream = object as PDFRawStream;
    const original = stream.getContents();
    const next = await recompress(original, maxEdge, quality, signal);
    if (!next || next.bytes.length >= original.length) continue;
    const dict = stream.dict.clone(pdf.context);
    dict.set(PDFName.of("Width"), PDFNumber.of(next.width));
    dict.set(PDFName.of("Height"), PDFNumber.of(next.height));
    // The browser encoder writes baseline sRGB JPEG, so the declared space follows it.
    dict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
    dict.set(PDFName.of("Filter"), dct);
    dict.delete(PDFName.of("DecodeParms"));
    pdf.context.assign(ref, PDFRawStream.of(dict, next.bytes));
  }
}
