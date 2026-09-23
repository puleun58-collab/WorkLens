/**
 * Formula text is only ever rewritten, never evaluated. Two rewrites exist:
 * a row-local helper formula is re-expressed for another row and column
 * layout, and a formula that reads a record range follows that range when
 * appended rows extend it. Anything the rewrite does not fully understand is
 * refused rather than guessed.
 */

const letters = (column: number): string => {
  let value = column;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
};

const columnNumber = (text: string): number =>
  text.toUpperCase().split("").reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);

/** Splits formula text into string literals (left untouched) and code. */
function segments(formula: string): Array<{ code: boolean; text: string }> {
  return formula.split(/("(?:[^"]|"")*")/u).map((text, index) => ({ code: index % 2 === 0, text }));
}

/** A reference to another workbook: never kept as a live formula. */
export function isExternalFormula(formula: string): boolean {
  return segments(formula).some((part) => part.code && /\[[^\]]*\]/u.test(part.text));
}

const CELL_REF = /(^|[^A-Za-z0-9_.!'$])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(A-Za-z_!])/gu;

/**
 * Re-expresses a formula that only reads cells of its own row, e.g.
 * `MONTH(K5)`, as a row template: `MONTH(K{ROW})`. Columns move through
 * `column`; any reference that is absolute, on another row, on another sheet,
 * or in an unmapped column makes the formula untranslatable.
 */
export function rowTemplate(formula: string, row: number, column: (source: number) => number | undefined): string | undefined {
  if (isExternalFormula(formula) || formula.includes("!")) return undefined;
  let valid = true;
  let references = 0;
  const translated = segments(formula).map((part) => part.code
    ? part.text.replace(CELL_REF, (match, lead: string, columnAbsolute: string, columnText: string, rowAbsolute: string, rowText: string) => {
      if (columnAbsolute || rowAbsolute || Number(rowText) !== row) {
        valid = false;
        return match;
      }
      const target = column(columnNumber(columnText));
      if (target === undefined) {
        valid = false;
        return match;
      }
      references += 1;
      return `${lead}${letters(target)}{ROW}`;
    })
    : part.text).join("");
  return valid && references > 0 ? translated : undefined;
}

export interface SheetGrowth {
  /** Last original record row; rows after it move down by `added`. */
  lastRow: number;
  added: number;
}

const sheetKey = (name: string): string => name.normalize("NFKC").toLocaleLowerCase("ko-KR");

const RANGE_REF = /((?:'(?:[^']|'')+'|[A-Za-z_\u3131-\uD7A3][\w.\u3131-\uD7A3]*)!)?(\$?)([A-Z]{1,3})(\$?)(\d+)(?::(\$?)([A-Z]{1,3})(\$?)(\d+))?(?![\d(A-Za-z_!])/gu;

/**
 * Keeps a formula pointing at the same data after rows were appended to a
 * record sheet: a range ending on the last original record row grows to the
 * last appended row, and references below the records move with the rows.
 * Whole-column references need no change.
 */
export function followGrowth(formula: string, currentSheet: string, growth: ReadonlyMap<string, SheetGrowth>): string {
  if (growth.size === 0 || isExternalFormula(formula)) return formula;
  return segments(formula).map((part) => part.code
    ? part.text.replace(RANGE_REF, (match, prefix: string | undefined, c1a: string, c1: string, r1a: string, r1: string, c2a?: string, c2?: string, r2a?: string, r2?: string, offset?: number, whole?: string) => {
      const before = typeof offset === "number" && typeof whole === "string" ? whole[offset - 1] : undefined;
      if (before && /[A-Za-z0-9_.$]/u.test(before)) return match;
      const sheet = prefix ? prefix.slice(0, -1).replace(/^'|'$/gu, "").replace(/''/gu, "'") : currentSheet;
      const change = growth.get(sheetKey(sheet));
      if (!change || change.added === 0) return match;
      const start = Number(r1);
      if (c2 === undefined || r2 === undefined) {
        return start > change.lastRow ? `${prefix ?? ""}${c1a}${c1}${r1a}${start + change.added}` : match;
      }
      const end = Number(r2);
      const nextStart = start > change.lastRow ? start + change.added : start;
      const nextEnd = end >= change.lastRow ? end + change.added : end;
      return `${prefix ?? ""}${c1a}${c1}${r1a}${nextStart}:${c2a}${c2}${r2a}${nextEnd}`;
    })
    : part.text).join("");
}

export { sheetKey };
