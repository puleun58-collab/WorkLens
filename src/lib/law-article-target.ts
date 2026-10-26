import { articleEvidence, articleLines } from "@/lib/citation-evidence";
import { lawDisplayText } from "@/lib/law-display";

export interface LawArticleTarget {
  hang?: number;
  ho?: number;
}

const JO_TITLE = /^\s*(제[1-9]\d{0,3}조(?:의[1-9]\d?)?)(?:\s+.+|\(.*\))?\s*$/u;
const JO_START = /^\s*제[1-9]\d{0,3}조/u;

/**
 * One leading article heading line, in either of the forms the MCP returns:
 * `제25조 우선 재고용 등` (plain), `제25조(우선 재고용 등)` (parenthesized),
 * or a bare `제25조`. A line that continues past the heading (a body line
 * that happens to start with a 조 number) never parses as a heading: the
 * plain form must end at the title, and a title that opens with a 항 mark
 * or a 호 number is body content, not a heading.
 */
const TITLE_LINE = /^\s*(제[1-9]\d{0,3}조(?:의[1-9]\d?)?)(?:\s*\((.+)\)\s*|\s+(.+?)\s*)?$/u;
const HANG_MARKS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚";

interface ParsedTitleLine {
  jo: string;
  title?: string;
  form: "paren" | "plain" | "bare";
}

function parseTitleLine(line: string): ParsedTitleLine | undefined {
  const match = TITLE_LINE.exec(line);
  if (!match) return undefined;
  const title = (match[2] ?? match[3])?.trim();
  if (match[3] !== undefined && title !== undefined
    && (HANG_MARKS.includes(title[0]) || /^\d+\s*\./u.test(title))) return undefined;
  return {
    jo: match[1],
    title: title ? title : undefined,
    form: match[2] !== undefined ? "paren" : match[3] !== undefined ? "plain" : "bare",
  };
}

/** Titles compare with whitespace collapsed, so `제25조 우선 재고용 등` and `제25조(우선 재고용 등)` match. */
const normalizeTitle = (title: string): string => title.replace(/[\s\u00a0]+/gu, " ").trim();

export interface ArticleTitleDisplay {
  /** Unified heading for the detail header; the bare 조 when no title resolves. */
  title: string;
  /** Display lines with the leading heading line(s) removed when they resolve. */
  bodyLines: string[];
  /** Indices into the input lines that were removed. */
  droppedIndices: number[];
  /** True when heading line(s) were removed. */
  deduped: boolean;
  /** Why lines were left untouched, when they were. */
  mismatch?: string;
}

/**
 * Detail-view-only heading cleanup (never applied to lawDisplayText, so
 * research, precedent and decision views keep the raw heading lines).
 *
 * The detail header shows the article once as `제25조(우선 재고용 등)`; the
 * body then holds only real content. Only the leading heading lines of the
 * requested 조 are touched, and only when they resolve to one title:
 * plain + parenthesized forms with the same normalized title, a single
 * titled line, a parenthesized line after a bare 조 line, or two bare
 * lines. Anything else — a different 조, mismatched titles, a heading
 * followed by another article's heading — leaves the text untouched, so a
 * disagreement is never silently resolved by picking one side.
 */
export function articleTitleDisplayLines(lines: readonly string[], jo: string): ArticleTitleDisplay {
  const untouched = (mismatch: string): ArticleTitleDisplay =>
    ({ title: jo, bodyLines: [...lines], droppedIndices: [], deduped: false, mismatch });
  const start = lines.findIndex((line) => JO_START.test(line));
  if (start < 0) return untouched("no-jo-line");
  const first = parseTitleLine(lines[start]);
  if (!first) return untouched("not-title-line");
  if (first.jo !== jo) return untouched("jo-mismatch");
  const second = start + 1 < lines.length ? parseTitleLine(lines[start + 1]) : undefined;
  if (second && second.jo !== jo) return untouched("next-jo-mismatch");
  const drop = (count: number, title: string): ArticleTitleDisplay => ({
    title,
    bodyLines: [...lines.slice(0, start), ...lines.slice(start + count)],
    droppedIndices: Array.from({ length: count }, (_, index) => start + index),
    deduped: true,
  });
  if (first.title && second?.title) {
    if (normalizeTitle(first.title) !== normalizeTitle(second.title)) return untouched("title-mismatch");
    const titleText = first.form === "paren" ? first.title : second.form === "paren" ? second.title : first.title;
    return drop(2, `${jo}(${titleText})`);
  }
  if (first.title) return drop(1, `${jo}(${first.title})`);
  if (second?.title) return drop(2, `${jo}(${second.title})`);
  if (second && !second.title) return drop(2, jo);
  return drop(1, jo);
}

/** Text form of articleTitleDisplayLines: the display text with heading lines removed. */
export function articleTitleDisplay(text: string, jo: string): { title: string; body: string; deduped: boolean; mismatch?: string } {
  const display = articleTitleDisplayLines(lawDisplayText(text).split("\n"), jo);
  return { title: display.title, body: display.bodyLines.join("\n"), deduped: display.deduped, mismatch: display.mismatch };
}

export type LawArticleTargetResolution =
  | { fallback: true; shownLines: string[]; title: string }
  | { fallback: false; shownLines: string[]; targetIndices: Set<number>; title: string };

/**
 * Locates the requested 항/호 on the display text (never the raw text, so
 * display normalization cannot shift the target). No new parser: the
 * citation-evidence parser does the locating.
 *
 * Fallback (show the whole article + status notice) when: no article lines,
 * the first article line is not the requested 조, a second 조 title appears
 * inside the range (cross-article guard), or the parser cannot find the 항/호.
 * A 호 without its 항 never reaches here — the query parser drops it.
 */
export function resolveLawArticleTarget(text: string, jo: string, target: LawArticleTarget): LawArticleTargetResolution {
  const shown = lawDisplayText(text);
  const allLines = shown.split("\n");
  const display = articleTitleDisplayLines(allLines, jo);
  // Target indices are computed on the full display lines, then remapped
  // past the dropped heading lines, so 항/호 highlighting and scrolling
  // still land on the exact body line. Heading lines are never targets:
  // evidence ranges hold body lines only.
  const remap = (index: number): number => index - display.droppedIndices.filter((dropped) => dropped < index).length;
  const article = articleLines(shown);
  if (!article.length) return { fallback: true, shownLines: display.bodyLines, title: display.title };
  // articleLines drops the duplicate `제N조(제목)` heading when the plain
  // `제N조 제목` line precedes it, so the article's first line is not always
  // the first 조 line of the display text. Mirror that rule for the offset.
  const start = allLines.findIndex((line) => JO_START.test(line));
  const startJo = start >= 0 ? JO_TITLE.exec(allLines[start])?.[1] : undefined;
  const offset = startJo && allLines[start + 1]?.trim().startsWith(`${startJo}(`) ? start + 1 : start;
  const firstJo = JO_TITLE.exec(article[0])?.[1];
  if (firstJo !== jo) return { fallback: true, shownLines: display.bodyLines, title: display.title };
  for (let index = 1; index < article.length; index++) {
    const other = JO_TITLE.exec(article[index])?.[1];
    if (other && other !== jo) return { fallback: true, shownLines: display.bodyLines, title: display.title };
  }
  const evidence = articleEvidence(article, target.hang, target.ho);
  if (evidence.kind === "part-missing") return { fallback: true, shownLines: display.bodyLines, title: display.title };
  const targetIndices = new Set<number>();
  let cursor = 0;
  for (const line of evidence.lines) {
    let found = -1;
    for (let index = cursor; index < article.length; index++) {
      if (article[index] === line) { found = index; break; }
    }
    if (found < 0) return { fallback: true, shownLines: display.bodyLines, title: display.title };
    targetIndices.add(remap(offset + found));
    cursor = found + 1;
  }
  return { fallback: false, shownLines: display.bodyLines, targetIndices, title: display.title };
}
