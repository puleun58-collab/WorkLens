import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function css(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

/** All rule blocks for a selector, in source order. */
function ruleBlocks(source: string, selector: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(selector, from);
    if (start < 0) break;
    const end = source.indexOf("}", start);
    expect(end).toBeGreaterThan(start);
    blocks.push(source.slice(start, end));
    from = end + 1;
  }
  return blocks;
}

describe("citation reason layout", () => {
  const source = css("../src/components/research/legal-analysis.css");
  const reasonSelector = ".legal-analysis-citations > li > .law-search-note";

  it("keeps the two-column citation row intact", () => {
    const block = ruleBlocks(source, ".legal-analysis-citations > li {")[0];
    expect(block).toContain("grid-template-columns: 96px minmax(0, 1fr)");
  });

  it("places the claim-support reason under the citation text on desktop", () => {
    const blocks = ruleBlocks(source, reasonSelector);
    expect(blocks.length).toBe(2);
    // Desktop rule comes first: column 2 is the citation-text column, so the
    // reason sits below the law name/article and uses the full remaining width.
    expect(blocks[0]).toContain("grid-column: 2");
    expect(blocks[0]).toContain("min-width: 0");
    expect(blocks[0]).toContain("overflow-wrap: anywhere");
  });

  it("does not force the reason with nowrap or a fixed width", () => {
    for (const block of ruleBlocks(source, reasonSelector)) {
      expect(block).not.toContain("nowrap");
      expect(block).not.toMatch(/width:\s*\d+px/);
    }
  });

  it("stacks the reason into the single column on mobile", () => {
    const blocks = ruleBlocks(source, reasonSelector);
    expect(blocks[1]).toContain("grid-column: 1");
  });

  it("scopes the reason placement to citation list items only", () => {
    // No bare .law-search-note grid-column rule: evidence notes and other
    // screens keep their own layout.
    expect(source).not.toMatch(/(^|[;{}])\s*\.law-search-note\s*\{[^}]*grid-column/m);
  });

  it("keeps the #305 keep-all/pretty baseline on the law view root", () => {
    const block = ruleBlocks(source, ".legal-analysis {")[0];
    expect(block).toContain("word-break: keep-all");
    expect(block).toContain("text-wrap: pretty");
  });
});
