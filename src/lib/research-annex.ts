export interface AnnexEvidence {
  law: string;
  label: string;
  sourceArticle: string;
  citation: string;
  status: "verified" | "identified" | "not-found" | "failed";
  title?: string;
  text?: string;
  truncated?: boolean;
  /** Official current-form route, only after response identity is checked. */
  url?: string;
  /** Why this annex was read for the question: `direct` when the citing
   * provision concerns the question's legal act (or the question names the
   * annex), `related` when it was only lexically ranked. Absent on lists. */
  relevance?: "direct" | "related";
}

/** Display-only structures; AnnexEvidence.text remains the official original. */
export interface AnnexCell {
  text: string;
  header: boolean;
  rowSpan?: number;
  colSpan?: number;
}
export type AnnexColumnKind = "content" | "legal-basis" | "stage";
export type AnnexBlock = { kind: "text"; text: string } | {
  kind: "table";
  rows: AnnexCell[][];
  /** Consecutive leading rows supported by explicit header markup. */
  headerRows?: number;
  /** Only supplied when every leaf column has an identifiable header. */
  columnKinds?: AnnexColumnKind[];
};

const ANNEX_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0",
  ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", ndash: "–", mdash: "—",
  middot: "·", bull: "•", hellip: "…", copy: "©", reg: "®", times: "×", divide: "÷",
};

function annexEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity: string, name: string) => {
    if (!name.startsWith("#")) return ANNEX_ENTITIES[name.toLowerCase()] ?? entity;
    const value = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
      ? String.fromCodePoint(value) : entity;
  });
}

/** Strip markup before decoding entities, so escaped literal tags stay text.
 * Do not use lawDisplayText here: it also rewrites dates and operator-looking
 * sentences, which must remain verbatim inside an official annex. */
function annexPlainText(html: string): string {
  return annexEntities(html.replace(/\r\n?/gu, "\n")
    .replace(/<\s*br\b[^>]*>/giu, "\n")
    .replace(/<\s*\/?\s*(?:p|div)\b[^>]*>/giu, "\n\n")
    .replace(/<\s*\/\s*(?:tr|table)\s*>/giu, "\n\n")
    .replace(/<\s*\/\s*t[dh]\s*>/giu, "\n")
    .replace(/<!--[\s\S]*?-->|<\/?[a-z][^>]*>/giu, ""));
}

function appendAnnexText(blocks: AnnexBlock[], html: string): void {
  const text = annexPlainText(html).split("\n")
    .filter((line) => !/^\s*\(?\s*파일\s*형식\s*[:：]\s*HWP\s*\)?\s*$/iu.test(line)).join("\n");
  for (const paragraph of text.split(/\n[ \t\u00a0]*\n(?:[ \t\u00a0]*\n)*/u)) {
    if (paragraph.trim()) blocks.push({ kind: "text", text: paragraph.replace(/^\n+|\n+$/gu, "") });
  }
}

function annexSpan(attrs: string, name: string): number | undefined {
  const value = Number(new RegExp(`\\b${name}\\s*=\\s*(?:"(\\d+)"|'(\\d+)'|(\\d+)(?=\\s|$))`, "iu")
    .exec(attrs)?.slice(1).find((part) => part !== undefined));
  return Number.isSafeInteger(value) && value > 1 ? value : undefined;
}

/** The second row is a header only when its cells fill explicit colspan
 * groups, not merely because their prose resembles column labels. */
function annexHeaders(rows: AnnexCell[][], explicitHead: boolean[]): number | undefined {
  for (let index = 0; index < rows.length; index++) {
    if (explicitHead[index]) rows[index].forEach((cell) => { cell.header = true; });
  }
  if (!explicitHead.some(Boolean) && rows[0]?.every((cell) => cell.header) && rows[1]) {
    let column = 0;
    const parent = rows[0].map((cell) => {
      const start = column;
      column += cell.colSpan ?? 1;
      return { start, end: column, cell };
    });
    let next = 0;
    const children = rows[1].map((cell) => {
      while (parent.some((group) => (group.cell.rowSpan ?? 1) > 1 && group.start <= next && next < group.end)) {
        next = parent.find((group) => (group.cell.rowSpan ?? 1) > 1 && group.start <= next && next < group.end)!.end;
      }
      const start = next;
      next += cell.colSpan ?? 1;
      return { start, end: next, cell };
    });
    const groups = parent.filter((group) => (group.cell.colSpan ?? 1) > 1 && !group.cell.rowSpan);
    if (groups.length && children.every((child) => groups.some((group) => group.start <= child.start && child.end <= group.end))
      && groups.every((group) => children.filter((child) => group.start <= child.start && child.end <= group.end)
        .reduce((width, child) => width + child.end - child.start, 0) === group.end - group.start)) {
      children.forEach(({ cell }) => { cell.header = true; });
    }
  }
  let count = 0;
  while (rows[count]?.every((cell) => cell.header)) count++;
  return count || undefined;
}

function annexColumnKinds(rows: AnnexCell[][], headerRows: number | undefined): AnnexColumnKind[] | undefined {
  if (!headerRows) return undefined;
  const kinds: AnnexColumnKind[] = [];
  let columns = 0;
  const occupied: { start: number; end: number; until: number }[] = [];
  for (let index = 0; index < headerRows; index++) {
    let column = 0;
    for (const cell of rows[index]) {
      let covering = occupied.find((span) => span.until > index && span.start <= column && column < span.end);
      while (covering) {
        column = covering.end;
        covering = occupied.find((span) => span.until > index && span.start <= column && column < span.end);
      }
      const width = cell.colSpan ?? 1;
      // A pathological span is still retained on the cell, not expanded into metadata.
      if (column + width > 1000) return undefined;
      const label = cell.text.replace(/\s/gu, "");
      const kind: AnnexColumnKind | undefined = /^(?:위반사항|위반내용)$/u.test(label) ? "content"
        : /^(?:근거법령|법적근거|근거조문)$/u.test(label) ? "legal-basis"
          : /^\d+차(?:위반)?$/u.test(label) ? "stage" : undefined;
      for (let offset = 0; offset < width; offset++) {
        if (kind) kinds[column + offset] = kind;
      }
      if (cell.rowSpan) occupied.push({ start: column, end: column + width, until: index + cell.rowSpan });
      column += width;
      columns = Math.max(columns, column);
    }
  }
  return columns && Array.from({ length: columns }, (_, index) => kinds[index]).every(Boolean)
    ? kinds : undefined;
}

function annexTable(html: string): Extract<AnnexBlock, { kind: "table" }> | undefined {
  const body = html.replace(/^<table\b[^>]*>/iu, "").replace(/<\/table\s*>$/iu, "");
  if (/<\/?table\b/iu.test(body)) return undefined;
  const rows: AnnexCell[][] = [];
  const explicitHead: boolean[] = [];
  let cursor = 0;
  const structuralOnly = (value: string) => !annexPlainText(value.replace(/<\/?(?:thead|tbody|tfoot|colgroup|col)\b[^>]*>/giu, "")).trim();
  for (const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/giu)) {
    if (!structuralOnly(body.slice(cursor, row.index))) return undefined;
    const cells: AnnexCell[] = [];
    let cellCursor = 0;
    for (const cell of row[1].matchAll(/<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1\s*>/giu)) {
      if (!structuralOnly(row[1].slice(cellCursor, cell.index)) || /<\/?(?:t[dh]|tr)\b/iu.test(cell[3])) return undefined;
      cells.push({
        text: annexPlainText(cell[3]), header: cell[1].toLowerCase() === "th",
        rowSpan: annexSpan(cell[2], "rowspan"), colSpan: annexSpan(cell[2], "colspan"),
      });
      cellCursor = cell.index + cell[0].length;
    }
    if (!cells.length || !structuralOnly(row[1].slice(cellCursor))) return undefined;
    const prefix = body.slice(0, row.index);
    explicitHead.push(prefix.search(/<thead\b[^>]*>(?:(?!<\/thead\s*>)[\s\S])*$/iu) >= 0);
    rows.push(cells);
    cursor = row.index + row[0].length;
  }
  if (!rows.length || !structuralOnly(body.slice(cursor))) return undefined;
  const headerRows = annexHeaders(rows, explicitHead);
  return { kind: "table", rows, headerRows, columnKinds: annexColumnKinds(rows, headerRows) };
}

/** Separate real paragraphs and intact tables. Unreadable/nested tables fall
 * back to ordered inert text rather than dropping unrecognized content.
 * No paragraph numbering, sentence, source field, or acquisition state changes. */
export function annexBlocks(text: string): AnnexBlock[] {
  const blocks: AnnexBlock[] = [];
  let cursor = 0;
  let start: number | undefined;
  let depth = 0;
  for (const tag of text.matchAll(/<\/?table\b[^>]*>/giu)) {
    const closing = /^<\//u.test(tag[0]);
    if (!closing) {
      if (depth === 0) {
        appendAnnexText(blocks, text.slice(cursor, tag.index));
        start = tag.index;
      }
      depth++;
    } else if (depth) {
      depth--;
      if (depth === 0 && start !== undefined) {
        const end = tag.index + tag[0].length;
        const html = text.slice(start, end);
        const table = annexTable(html);
        if (table) blocks.push(table);
        else appendAnnexText(blocks, html);
        cursor = end;
        start = undefined;
      }
    }
  }
  appendAnnexText(blocks, text.slice(start ?? cursor));
  return blocks;
}
