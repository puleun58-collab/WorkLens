import type { NormalizedDocument, TableCell } from "@/domain/document";
import { evidenceTokens, normalizeText } from "@/lib/ai/retrieval";
import { AX_LIMITS } from "./schema";

export interface AxFileEvidence {
  text: string;
  partial: boolean;
  empty: boolean;
  warnings: string[];
}

interface EvidencePart {
  order: number;
  text: string;
  score: number;
}

const hasContent = (cell: TableCell): boolean => Boolean(cell.formula?.trim())
  || (cell.valueType !== "blank" && (cell.display.trim().length > 0
    || (cell.value !== null && cell.value !== "")));

/** Local, session-only excerpts. No storage, logging, model call or raw bytes. */
export function buildAxFileEvidence(document: NormalizedDocument, question: string): AxFileEvidence {
  const limit = AX_LIMITS.attachmentSummary;
  const terms = [...new Set(evidenceTokens(question))];
  const longestTerms = [...terms].sort((a, b) => b.length - a.length);
  const best: EvidencePart[] = [];
  const structures: EvidencePart[] = [];
  const formulas: EvidencePart[] = [];
  let count = 0;
  let totalLength = 0;
  // Retain only a bounded shortlist while examining every parsed content unit.
  const retain = (pool: EvidencePart[], part: EvidencePart, size: number): void => {
    pool.push(part);
    pool.sort((a, b) => b.score - a.score || a.order - b.order);
    if (pool.length > size) pool.pop();
  };
  const offer = (text: string, structure = false, formula = false): void => {
    const normalized = normalizeText(text);
    const score = terms.reduce((sum, term) => sum + (normalized.includes(term) ? term.length : 0), 0);
    const part = { order: count++, text, score };
    totalLength += text.length + (count > 1 ? 1 : 0);
    retain(best, part, 40);
    if (structure) retain(structures, part, 8);
    if (formula) retain(formulas, part, 8);
  };
  // Workbook tables also contain hidden sheets; do not silently read them when
  // the parser's public blocks deliberately omit them.
  for (const block of document.blocks) {
    if (block.type === "paragraph") {
      if (block.text.trim()) {
        // Rank across long paragraphs too, not just their leading characters.
        for (let offset = 0; offset < block.text.length; offset += 500) {
          const excerpt = block.text.slice(offset, offset + 500);
          if (excerpt.trim()) offer(`[문단 ${block.source.label}] ${excerpt}`);
        }
      }
      continue;
    }
    let firstContentRow = true;
    for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
      const row = block.rows[rowIndex];
      if (!row.some(hasContent)) continue;
      for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
        const cell = row[columnIndex];
        if (!hasContent(cell)) continue;
        const source = cell.source;
        const sheet = source.sheet ?? block.source.sheet;
        const address = source.cellRange ?? source.label;
        const position = sheet ? `시트 ${sheet} / ${address}` : `${address} / 행 ${rowIndex + 1}, 열 ${columnIndex + 1}`;
        // Only report a semantic type if parsing actually retained one.
        const type = cell.valueType ? ` 유형=${cell.valueType}` : "";
        const formula = cell.formula !== undefined ? ` 수식=${cell.formula}` : "";
        const value = cell.display || (cell.value === null ? "" : String(cell.value));
        offer(`[${position}${firstContentRow ? " / 표 첫 행" : ""}]${type}${formula} 값=${value}`,
          firstContentRow, cell.formula !== undefined);
      }
      firstContentRow = false;
    }
  }
  const warnings = [...document.warnings];
  const parserPartial = warnings.some(warning => /OMITTED|TRUNCAT|PARTIAL|TEXT_LAYER_EMPTY/u.test(warning));
  if (count === 0) return { text: "", partial: parserPartial, empty: true, warnings };

  if (count <= best.length && totalLength <= limit) {
    return { text: [...best].sort((a, b) => a.order - b.order).map(part => part.text).join("\n"),
      partial: parserPartial, empty: false, warnings };
  }

  // Reserve room for actual first-row labels and formulas as well as question
  // matches. Neither prose ranking nor cached formula values can erase them.
  const selected = new Map<number, EvidencePart>();
  const take = (part: EvidencePart | undefined): void => { if (part) selected.set(part.order, part); };
  for (const part of structures.slice(0, 3)) take(part);
  for (const part of formulas.slice(0, 2)) take(part);
  for (const part of best) {
    take(part);
    if (selected.size >= 10) break;
  }
  const parts = [...selected.values()].sort((a, b) => a.order - b.order);
  const notice = "※ 일부 추출: 선택 범위 밖 내용 또는 긴 내용은 생략되었습니다.";
  let remaining = limit - notice.length - 1;
  const lines: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const allowance = Math.floor((remaining - (parts.length - index - 1)) / (parts.length - index));
    // Ellipsis is an explicit excerpt boundary, never an invented continuation.
    let line = part.text;
    if (line.length > allowance) {
      let start = 0;
      if (line.startsWith("[문단 ")) {
        // Retain the locator and an actual question-related substring.
        const prefixEnd = line.indexOf("] ") + 2;
        const lower = line.toLocaleLowerCase("ko-KR");
        for (const term of longestTerms) {
          const match = lower.indexOf(term, prefixEnd);
          if (match < 0) continue;
          start = Math.max(prefixEnd, match - 24);
          break;
        }
        if (start > prefixEnd) {
          const prefix = line.slice(0, prefixEnd);
          line = `${prefix}…${line.slice(start, start + Math.max(0, allowance - prefix.length - 2))}…`;
        } else line = `${line.slice(0, Math.max(0, allowance - 1))}…`;
      } else line = `${line.slice(0, Math.max(0, allowance - 1))}…`;
    }
    if (line.length > allowance) line = `${line.slice(0, Math.max(0, allowance - 1))}…`;
    lines.push(line);
    remaining -= line.length + 1;
  }
  return { text: `${lines.join("\n")}\n${notice}`, partial: true, empty: false, warnings };
}
