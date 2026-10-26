import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function css(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function ruleBlock(source: string, selector: string): string {
  const start = source.indexOf(selector);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("}", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("line-break consistency", () => {
  it("applies orphan-avoiding wrap to the learn and AX diagnosis views", () => {
    expect(ruleBlock(css("../src/components/ax/ax.css"), ".ax-view")).toContain("text-wrap: pretty");
    expect(ruleBlock(css("../src/components/learn/learn.css"), ".learn-view")).toContain("text-wrap: pretty");
  });

  it("applies keep-all and orphan-avoiding wrap to the law view roots", () => {
    const lawSearch = css("../src/components/research/law-search.css");
    const decisionSearch = css("../src/components/research/decision-search.css");
    const legalAnalysis = css("../src/components/research/legal-analysis.css");
    for (const [source, selector] of [
      [lawSearch, ".law-research"],
      [lawSearch, ".law-search"],
      [decisionSearch, ".decision-search"],
      [legalAnalysis, ".legal-analysis"],
    ] as const) {
      const block = ruleBlock(source, selector);
      expect(block).toContain("word-break: keep-all");
      expect(block).toContain("text-wrap: pretty");
    }
  });

  it("does not leave mid-word break-word overrides in law raw-text blocks", () => {
    for (const path of [
      "../src/components/research/law-search.css",
      "../src/components/research/decision-search.css",
      "../src/components/research/legal-analysis.css",
    ]) {
      expect(css(path)).not.toContain("word-break: break-word");
    }
  });
});
