import { articleEvidence, articleLines } from "@/lib/citation-evidence";
import { lawDisplayText } from "@/lib/law-display";

export interface LawArticleTarget {
  hang?: number;
  ho?: number;
}

const JO_TITLE = /^\s*(제[1-9]\d{0,3}조(?:의[1-9]\d?)?)(?:\s+.+|\(.*\))?\s*$/u;
const JO_START = /^\s*제[1-9]\d{0,3}조/u;

export type LawArticleTargetResolution =
  | { fallback: true; shownLines: string[] }
  | { fallback: false; shownLines: string[]; targetIndices: Set<number> };

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
  const shownLines = shown.split("\n");
  const article = articleLines(shown);
  if (!article.length) return { fallback: true, shownLines };
  // articleLines drops the duplicate `제N조(제목)` heading when the plain
  // `제N조 제목` line precedes it, so the article's first line is not always
  // the first 조 line of the display text. Mirror that rule for the offset.
  const start = shownLines.findIndex((line) => JO_START.test(line));
  const startJo = start >= 0 ? JO_TITLE.exec(shownLines[start])?.[1] : undefined;
  const offset = startJo && shownLines[start + 1]?.trim().startsWith(`${startJo}(`) ? start + 1 : start;
  const firstJo = JO_TITLE.exec(article[0])?.[1];
  if (firstJo !== jo) return { fallback: true, shownLines };
  for (let index = 1; index < article.length; index++) {
    const other = JO_TITLE.exec(article[index])?.[1];
    if (other && other !== jo) return { fallback: true, shownLines };
  }
  const evidence = articleEvidence(article, target.hang, target.ho);
  if (evidence.kind === "part-missing") return { fallback: true, shownLines };
  const targetIndices = new Set<number>();
  let cursor = 0;
  for (const line of evidence.lines) {
    let found = -1;
    for (let index = cursor; index < article.length; index++) {
      if (article[index] === line) { found = index; break; }
    }
    if (found < 0) return { fallback: true, shownLines };
    targetIndices.add(offset + found);
    cursor = found + 1;
  }
  return { fallback: false, shownLines, targetIndices };
}
