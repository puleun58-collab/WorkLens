import type { NormalizedDocument, ParagraphBlock, SpanBox } from "@/domain/document";

import { DocumentError } from "@/lib/upload";

/**
 * pdf.js needs its worker as a URL in both runtimes. The browser loads the
 * copy published under `public/`, and Node resolves the same file from disk so
 * parser behaviour is identical in tests and in the browser worker.
 */
const PDF_WORKER_ASSET = "pdf.worker.mjs";

function pdfWorkerSource(): string {
  const scope = globalThis as { WorkerGlobalScope?: unknown; location?: { origin?: string } };
  if (typeof window !== "undefined" || scope.WorkerGlobalScope !== undefined) {
    return new URL(`/${PDF_WORKER_ASSET}`, scope.location?.origin ?? "http://localhost").href;
  }
  const cwd = globalThis.process.cwd().replaceAll("\\", "/");
  return `file:///${cwd.replace(/^\/+/, "")}/public/${PDF_WORKER_ASSET}`;
}

const malformedFileError = (cause: unknown): Error => {
  const error = new DocumentError("DOCUMENT_UNREADABLE", "파일을 읽지 못했습니다.", "지원되는 PDF 파일인지 확인한 뒤 다시 시도해 주세요.");
  error.cause = cause;
  return error;
};

const paragraphText = (
  items: ReadonlyArray<{ str?: unknown; hasEOL?: unknown; transform?: unknown; width?: unknown; height?: unknown }>,
): Array<{ text: string; spans: SpanBox[]; degraded: boolean }> => {
  const paragraphs: Array<{ text: string; spans: SpanBox[]; degraded: boolean }> = [];
  let text = "";
  let spans: SpanBox[] = [];
  let degraded = false;
  for (const item of items) {
    const itemText = typeof item.str === "string" ? item.str : "";
    if (itemText !== "") {
      text += text === "" ? itemText : ` ${itemText}`;
      const transform = Array.isArray(item.transform) ? item.transform : undefined;
      const x = transform?.[4];
      const y = transform?.[5];
      const width = typeof item.width === "number" ? item.width : undefined;
      const height = typeof item.height === "number"
        ? item.height
        : typeof transform?.[3] === "number" ? Math.abs(transform[3]) : undefined;
      if (
        typeof x === "number" && Number.isFinite(x) &&
        typeof y === "number" && Number.isFinite(y) &&
        width !== undefined && Number.isFinite(width) &&
        height !== undefined && Number.isFinite(height)
      ) spans.push({ x, y, w: Math.abs(width), h: Math.abs(height) });
      else degraded = true;
    }
    if (item.hasEOL === true && text !== "") {
      paragraphs.push({ text, spans, degraded });
      text = "";
      spans = [];
      degraded = false;
    }
  }
  if (text !== "") {
    paragraphs.push({ text, spans, degraded });
  }
  return paragraphs;
};

export const parsePdf = async (input: {
  fileId: string;
  fileName: string;
  bytes: Uint8Array;
}): Promise<NormalizedDocument> => {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSource();
    const loadingTask = pdfjs.getDocument({
      data: input.bytes,
      disableFontFace: true,
      useWorkerFetch: false,
      stopAtErrors: true,
    });

    const blocks: ParagraphBlock[] = [];
    const warnings = new Set<string>();
    let pageCount = 0;
    try {
      const pdf = await loadingTask.promise;
      pageCount = pdf.numPages;
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const items = content.items.map((item) => ({
          str: "str" in item ? item.str : undefined,
          hasEOL: "hasEOL" in item ? item.hasEOL : undefined,
          transform: "transform" in item ? item.transform : undefined,
          width: "width" in item ? item.width : undefined,
          height: "height" in item ? item.height : undefined,
        }));
        for (const [paragraphIndex, paragraph] of paragraphText(items).entries()) {
          if (paragraph.degraded || paragraph.spans.length === 0) {
            warnings.add("PDF_LOCATOR_DEGRADED_PAGE_QUOTE");
          }
          const id = `pdf:p${pageNumber}:paragraph:${paragraphIndex + 1}`;
          blocks.push({
            type: "paragraph",
            id,
            text: paragraph.text,
            source: {
              fileId: input.fileId,
              nodeId: id,
              label: `페이지 ${pageNumber}`,
              page: pageNumber,
              locator: { kind: "pdf", page: pageNumber, spans: paragraph.spans },
              quote: paragraph.text,
            },
          });
        }
        page.cleanup();
      }
    } finally {
      await loadingTask.destroy();
    }

    return {
      id: `document:${input.fileId}`,
      fileId: input.fileId,
      kind: "pdf",
      metadata: { fileName: input.fileName, pageCount },
      blocks,
      warnings: [
        ...(blocks.length === 0 ? ["PDF_TEXT_LAYER_EMPTY"] : []),
        ...warnings,
      ],
    };
  } catch (error) {
    throw malformedFileError(error);
  }
};
