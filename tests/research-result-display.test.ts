import { describe, expect, it } from "vitest";
import { articleDisplayKey, hasQuestionTermInTitle } from "../src/components/research/research-result-display";

describe("research source presentation", () => {
  const article = { law: "근로기준법", jo: "제23조", excerpt: "① 원문", effective: "2025.01.01" };
  it("links only the same law, article, version and excerpt", () => {
    const key = articleDisplayKey(article);
    expect(articleDisplayKey({ ...article })).toBe(key);
    for (const different of [
      { law: "다른 법률" }, { jo: "제24조" }, { effective: "2026.01.01" },
      { effective: undefined }, { excerpt: "① 다른 발췌" },
    ]) expect(articleDisplayKey({ ...article, ...different })).not.toBe(key);
  });
  it("does not infer title matches from body matches or explicit references", () => {
    const supplement = { law: article.law, jo: article.jo, excerpt: article.excerpt, title: "해고 등의 제한", matched: ["해고"] };
    const before = structuredClone(supplement);
    expect(hasQuestionTermInTitle(supplement)).toBe(true);
    expect(hasQuestionTermInTitle({ ...supplement, matched: ["임금"] })).toBe(false);
    expect(hasQuestionTermInTitle({ ...supplement, matched: [] })).toBe(false);
    expect(hasQuestionTermInTitle({ ...supplement, matched: [""] })).toBe(false);
    expect(hasQuestionTermInTitle({ ...supplement, explicit: true })).toBe(false);
    expect(supplement).toEqual(before);
  });
});
