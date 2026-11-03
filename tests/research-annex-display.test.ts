import { describe, expect, it } from "vitest";
import { annexBlocks, type AnnexBlock } from "@/lib/research-annex";
import official from "./fixtures/law-annex-food-23.json";

const tables = (blocks: AnnexBlock[]) => blocks.filter((block) => block.kind === "table");
const paragraphs = (blocks: AnnexBlock[]) => blocks.filter((block) => block.kind === "text").map((block) => block.text);

describe("annexBlocks official original", () => {
  it("preserves every cell, blank, span and row of the full official annex", () => {
    const original = official.text;
    const displayed = tables(annexBlocks(original));
    const sourceTables = [...original.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/giu)];
    expect(original).toHaveLength(43981);
    expect(displayed).toHaveLength(4);
    expect(displayed.map((table) => table.rows.length)).toEqual([136, 61, 112, 7]);
    expect(displayed.flatMap((table) => table.rows)).toHaveLength(316);
    const cells = displayed.flatMap((table) => table.rows.flat());
    expect(cells).toHaveLength(1564);
    expect(cells.filter((cell) => cell.text === "")).toHaveLength(511);
    expect(cells.filter((cell) => cell.rowSpan !== undefined)).toHaveLength(8);
    expect(cells.filter((cell) => cell.colSpan !== undefined)).toHaveLength(4);
    for (const [index, table] of sourceTables.entries()) {
      const expectedRows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/giu)].map((row) =>
        [...row[1].matchAll(/<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1\s*>/giu)].map((cell) => ({
          text: cell[3].replace(/<br>/gu, "\n").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">"),
          rowSpan: /rowspan="(\d+)"/u.test(cell[2]) ? Number(/rowspan="(\d+)"/u.exec(cell[2])![1]) : undefined,
          colSpan: /colspan="(\d+)"/u.test(cell[2]) ? Number(/colspan="(\d+)"/u.exec(cell[2])![1]) : undefined,
        })));
      expect(displayed[index].rows.map((row) => row.map(({ text, rowSpan, colSpan }) => ({ text, rowSpan, colSpan })))).toEqual(expectedRows);
      expect(displayed[index].headerRows).toBe(2);
      expect(displayed[index].rows[1].every((cell) => cell.header)).toBe(true);
      expect(displayed[index].rows[2].every((cell) => !cell.header)).toBe(true);
      expect(displayed[index].columnKinds).toEqual(["content", "legal-basis", "stage", "stage", "stage"]);
    }
    expect(official.text).toBe(original);
  });

  it("keeps every paragraph and its order, removing only HWP format metadata", () => {
    const expected: { kind: string; text?: string }[] = [];
    let cursor = 0;
    const addParagraphs = (text: string) => {
      for (const paragraph of text.replace(/<\/?u>/gu, "").replace(/^\(파일 형식: HWP\)\n/gmu, "").split(/\n\s*\n/u)) {
        if (paragraph.trim()) expected.push({ kind: "text", text: paragraph });
      }
    };
    for (const table of official.text.matchAll(/<table\b[^>]*>[\s\S]*?<\/table\s*>/giu)) {
      addParagraphs(official.text.slice(cursor, table.index));
      expected.push({ kind: "table" });
      cursor = table.index + table[0].length;
    }
    addParagraphs(official.text.slice(cursor));
    expect(annexBlocks(official.text).map((block) => block.kind === "text" ? block : { kind: "table" })).toEqual(expected);
    expect(paragraphs(annexBlocks(official.text)).join("\n")).not.toContain("파일 형식: HWP");
  });
});

describe("annexBlocks display boundaries and safe fallback", () => {
  it("uses only actual boundaries, preserving numbering, single newlines, notes and characters", () => {
    const text = "Ⅰ. 일반기준\n\n1. 문장 그대로\n같은 문단\n\n가. 사항\n\n① 내용\n\n각주: a < b\n\n비고: 20260101 — get_law_text(id=1)";
    expect(paragraphs(annexBlocks(text))).toEqual(text.split("\n\n"));
    expect(annexBlocks("\n \n\n")).toEqual([]);
  });

  it("preserves p/div/br boundaries before stripping tags and decodes entities once", () => {
    expect(paragraphs(annexBlocks('<p>첫 문단<br>다음 줄</p><div>둘째 <u>문단</u></div>끝')))
      .toEqual(["첫 문단\n다음 줄", "둘째 문단", "끝"]);
    const table = tables(annexBlocks('<table><tr><td rowspan=2 colspan=3><p>A &amp; B</p><div>&lt;literal&gt;<br>&quot;&#39;&#x2460;&nbsp;</div></td><td></td></tr></table>'))[0];
    expect(table.rows[0][0]).toEqual({ text: '\n\nA & B\n\n\n\n<literal>\n"\'①\u00a0\n\n', header: false, rowSpan: 2, colSpan: 3 });
    expect(table.rows[0][1].text).toBe("");
    expect(paragraphs(annexBlocks("&amp;lt;tag&amp;gt;"))).toEqual(["&lt;tag&gt;"]);
  });

  it("removes only standalone HWP format lines, not other formats or legal prose", () => {
    expect(paragraphs(annexBlocks("제목\n(파일 형식: HWP)\n\n본문\n파일 형식: PDF\nHWP 파일 형식: 설명")))
      .toEqual(["제목", "본문\n파일 형식: PDF\nHWP 파일 형식: 설명"]);
    expect(paragraphs(annexBlocks("일부 원문…"))).toEqual(["일부 원문…"]);
  });

  it("does not invent headers for a general two-column or unknown table", () => {
    const general = tables(annexBlocks("<table><tr><td>항목</td><td>값</td></tr><tr><td>가</td><td>나</td></tr></table>"))[0];
    expect(general.headerRows).toBeUndefined();
    expect(general.columnKinds).toBeUndefined();
    expect(general.rows.flat().every((cell) => !cell.header)).toBe(true);
    const unknown = tables(annexBlocks("<table><tr><th>위반사항</th><th>알 수 없는 열</th></tr><tr><td>가</td><td>나</td></tr></table>"))[0];
    expect(unknown.headerRows).toBe(1);
    expect(unknown.columnKinds).toBeUndefined();
  });

  it("respects explicit thead and does not promote body rows below it", () => {
    const table = tables(annexBlocks('<table><thead><tr><td colspan="2">분류</td></tr><tr><td>첫째</td><td>둘째</td></tr></thead><tbody><tr><td>가</td><td>나</td></tr></tbody></table>'))[0];
    expect(table.headerRows).toBe(2);
    expect(table.rows.slice(0, 2).flat().every((cell) => cell.header)).toBe(true);
    expect(table.rows[2].every((cell) => !cell.header)).toBe(true);
    expect(table.columnKinds).toBeUndefined();
  });

  it("requires full explicit parent-group coverage before promoting second-row cells", () => {
    const table = tables(annexBlocks('<table><tr><th colspan="2">분류</th></tr><tr><td>첫째</td></tr><tr><td>가</td><td>나</td></tr></table>'))[0];
    expect(table.headerRows).toBe(1);
    expect(table.rows[1][0].header).toBe(false);
  });

  it.each([
    '<table><tr><td>앞<table><tr><td>안쪽</td></tr></table>뒤</td></tr></table>끝',
    '<table>앞<tr><td>안쪽</td></tr>뒤</table>끝',
    '<table><tr><td>앞</th>안쪽</tr>뒤</table>끝',
    '<table><tr><td>앞<br>안쪽\n뒤 끝',
    '<table><caption>앞</caption><tr><td>안쪽</td></tr>뒤</table>끝',
  ])("retains all content in nested, malformed or unhandled table markup: %s", (text) => {
    const blocks = annexBlocks(text);
    expect(tables(blocks)).toEqual([]);
    expect(paragraphs(blocks).join(" ").replace(/\s/gu, "")).toBe("앞안쪽뒤끝");
  });
});
