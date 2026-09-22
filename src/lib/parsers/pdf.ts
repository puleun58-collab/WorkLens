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

/** One rendered line with the layout metadata pdf.js actually provides. */
interface PdfLine {
  page: number;
  text: string;
  spans: SpanBox[];
  degraded: boolean;
  top: number;
  height: number;
}

const LIST_MARKER = /^\s*(?:[•·▪◦-]|\(?\d{1,2}[).]|[①-⑳]|[가-힣][).])\s/u;
const STRUCTURAL_ONLY = /^[\s\d.,:;()[\]/·—–-]*$/u;
const HEADING_MAX_CHARS = 60;
/** Wrapped lines of one paragraph sit about one line-height apart. */
const LINE_GAP_RATIO = 2.1;
/** A run of same-sized lines is a table, list or colophon, never a heading. */
const BLOCK_RUN_LENGTH = 3;

const lineHeight = (spans: readonly SpanBox[]): number =>
  spans.length === 0 ? 0 : Math.round(Math.max(...spans.map((span) => span.h)) * 10) / 10;

const lineTop = (spans: readonly SpanBox[]): number =>
  spans.length === 0 ? 0 : Math.max(...spans.map((span) => span.y));

/** The size most of the document's text is set in; everything else is display type. */
function bodyHeightOf(lines: readonly PdfLine[]): number {
  const weight = new Map<number, number>();
  for (const line of lines) {
    if (line.height <= 0) continue;
    weight.set(line.height, (weight.get(line.height) ?? 0) + line.text.length);
  }
  let body = 0;
  let best = 0;
  for (const [height, total] of weight) if (total > best) { body = height; best = total; }
  return body;
}

/** Type size is part of the identity: a heading and its table-of-contents entry read alike. */
const repeatKey = (line: PdfLine): string =>
  `${line.height}\u0000${line.text.normalize("NFKC").replace(/\d+/gu, "").replace(/\s+/gu, " ").trim().toLocaleLowerCase()}`;

/** Running heads and footers repeat their wording across pages. */
function repeatedLineKeys(lines: readonly PdfLine[]): Set<string> {
  const pages = new Map<string, Set<number>>();
  for (const line of lines) {
    if (line.text.length > HEADING_MAX_CHARS) continue;
    const key = repeatKey(line);
    if (!key) continue;
    const seen = pages.get(key) ?? new Set<number>();
    seen.add(line.page);
    pages.set(key, seen);
  }
  return new Set([...pages].filter(([, seen]) => seen.size >= 2).map(([key]) => key));
}

/**
 * Rebuilds paragraphs and section headings from the layout pdf.js reports.
 *
 * A PDF has no paragraph or heading markup, so a page arrives as rendered
 * lines: sentences break mid-word and every subtitle looks like body text.
 * Line spacing and type size are the only structural evidence the format
 * gives, so wrapped lines rejoin when they share a size and sit one line
 * apart, and a standalone line set in a different size than the body — never
 * inside a table, list or repeated running head — is the document's own
 * heading. No guessing from length or punctuation alone.
 */
function paragraphBlocks(lines: readonly PdfLine[], fileId: string): ParagraphBlock[] {
  const body = bodyHeightOf(lines);
  const repeated = repeatedLineKeys(lines);
  const runLength = new Map<number, number>();
  lines.forEach((line, index) => {
    if (runLength.has(index)) return;
    let end = index;
    while (end + 1 < lines.length && lines[end + 1].page === line.page && lines[end + 1].height === line.height) end += 1;
    for (let cursor = index; cursor <= end; cursor += 1) runLength.set(cursor, end - index + 1);
  });

  const merged: Array<{ line: PdfLine; indexes: number[] }> = [];
  lines.forEach((line, index) => {
    const previous = merged[merged.length - 1];
    const last = previous?.line;
    const continues = last !== undefined
      && last.page === line.page
      && last.height === line.height
      && line.height === body
      && !LIST_MARKER.test(line.text)
      && last.top - line.top > 0
      && last.top - line.top <= line.height * LINE_GAP_RATIO;
    if (!continues) {
      merged.push({ line: { ...line, spans: [...line.spans] }, indexes: [index] });
      return;
    }
    previous.line = {
      ...last,
      text: `${last.text} ${line.text}`.replace(/\s+/gu, " ").trim(),
      spans: [...last.spans, ...line.spans],
      degraded: last.degraded || line.degraded,
      top: line.top,
    };
    previous.indexes.push(index);
  });

  const headingHeights = [...new Set(merged
    .filter((entry) => entry.indexes.length === 1)
    .map((entry) => entry.line.height))].sort((left, right) => right - left);
  const counters = new Map<number, number>();
  return merged.map(({ line, indexes }) => {
    const ordinal = (counters.get(line.page) ?? 0) + 1;
    counters.set(line.page, ordinal);
    const id = `pdf:p${line.page}:paragraph:${ordinal}`;
    // A line that has a same-sized neighbour one line away belongs to a
    // multi-line block, which is body text however short it looks.
    const index = indexes[0];
    const neighbours = [lines[index - 1], lines[index + 1]].filter((entry) =>
      entry !== undefined
      && entry.page === line.page
      && entry.height === line.height
      && Math.abs(entry.top - line.top) <= line.height * LINE_GAP_RATIO);
    const isHeading = indexes.length === 1
      && line.height !== body
      && line.height >= body * 0.9
      && line.text.length <= HEADING_MAX_CHARS
      && (runLength.get(index) ?? 1) < BLOCK_RUN_LENGTH
      && neighbours.length === 0
      && !repeated.has(repeatKey(line))
      && !STRUCTURAL_ONLY.test(line.text)
      && !LIST_MARKER.test(line.text);
    const level = isHeading ? Math.min(6, headingHeights.indexOf(line.height) + 1) : 0;
    return {
      type: "paragraph" as const,
      id,
      text: line.text,
      ...(isHeading ? { role: "heading" as const, headingLevel: Math.max(1, level) } : {}),
      source: {
        fileId,
        nodeId: id,
        label: `페이지 ${line.page}`,
        page: line.page,
        locator: { kind: "pdf" as const, page: line.page, spans: line.spans },
        quote: line.text,
      },
    };
  });
}

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

    const lines: PdfLine[] = [];
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
        for (const paragraph of paragraphText(items)) {
          if (paragraph.degraded || paragraph.spans.length === 0) {
            warnings.add("PDF_LOCATOR_DEGRADED_PAGE_QUOTE");
          }
          lines.push({
            page: pageNumber,
            text: paragraph.text,
            spans: paragraph.spans,
            degraded: paragraph.degraded,
            top: lineTop(paragraph.spans),
            height: lineHeight(paragraph.spans),
          });
        }
        page.cleanup();
      }
    } finally {
      await loadingTask.destroy();
    }
    const blocks = paragraphBlocks(lines, input.fileId);

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
