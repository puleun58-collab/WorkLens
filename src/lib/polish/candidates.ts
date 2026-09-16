import type { NormalizedDocument } from "@/domain/document";
import type { PolishCandidate } from "@/domain/polish";

/**
 * Prose selection.
 *
 * Polish only ever sees sentences. Numbers, dates, codes, identifiers, table
 * structure and one-word labels are not prose and never become candidates, so
 * the model is never in a position to "improve" a value.
 */

/** Below this a line is a label, not a sentence worth rewriting. */
const MIN_LENGTH = 12;
const MAX_LENGTH = 600;
/** A single pass stays bounded: long documents are reviewed, not regenerated. */
export const MAX_POLISH_CANDIDATES = 200;

const HAS_LETTERS = /[가-힣]|[A-Za-z]{3,}/u;
const CODE_LIKE = /^[\s\d.,%+\-/:()]*$/u;
const IDENTIFIER_LIKE = /^[A-Z0-9][A-Z0-9_\-.:]*$/;
const URL_OR_EMAIL_ONLY = /^(?:https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+\.[\w.-]+)$/i;

export function isProse(text: string): boolean {
  const value = text.trim();
  if (value.length < MIN_LENGTH || value.length > MAX_LENGTH) return false;
  if (CODE_LIKE.test(value)) return false;
  if (IDENTIFIER_LIKE.test(value)) return false;
  if (URL_OR_EMAIL_ONLY.test(value)) return false;
  if (!HAS_LETTERS.test(value)) return false;
  // A sentence has more than one word; a header cell usually does not.
  return value.split(/\s+/u).length >= 3;
}

/**
 * Paragraph text carries the document's prose. Table cells qualify only when
 * a cell genuinely holds a sentence — a comment column, not a value column —
 * and headings keep their wording so the document structure is preserved.
 */
export function collectPolishCandidates(
  document: NormalizedDocument,
  limit = MAX_POLISH_CANDIDATES,
): PolishCandidate[] {
  const candidates: PolishCandidate[] = [];
  for (const block of document.blocks) {
    if (candidates.length >= limit) break;
    if (block.type === "paragraph") {
      if (block.role === "heading") continue;
      if (!isProse(block.text)) continue;
      candidates.push({ id: block.source.nodeId, text: block.text.trim(), source: block.source, origin: "paragraph" });
      continue;
    }
    for (const row of block.rows) {
      for (const cell of row) {
        if (candidates.length >= limit) break;
        if (typeof cell.value !== "string") continue;
        if (!isProse(cell.display)) continue;
        candidates.push({ id: cell.source.nodeId, text: cell.display.trim(), source: cell.source, origin: "cell" });
      }
    }
  }
  return candidates;
}
