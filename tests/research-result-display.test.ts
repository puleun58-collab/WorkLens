import { describe, expect, it } from "vitest";
import { articleDisplayKey, hasQuestionTermInTitle, taskSources } from "../src/components/research/research-result-display";

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

  it("shares one original across independently assessed basis and conditions without losing either status", () => {
    const source = { law: "식품위생법", jo: "제75조", title: "허가취소 등", excerpt: "① 영업자가 법을 위반한 경우 영업정지를 명할 수 있다.", effective: "20261008",
      source: "https://www.law.go.kr/법령/%EC%8B%9D%ED%92%88%EC%9C%84%EC%83%9D%EB%B2%95/%EC%A0%9C75%EC%A1%B0" };
    const rows = taskSources([
      { label: "처분·허가 근거", status: "found", basisRefs: [{ law: source.law, jo: source.jo, title: source.title, excerpt: source.excerpt }] },
      { label: "적용 요건", status: "viewed", requirementRefs: [{ law: source.law, jo: source.jo, title: source.title, excerpt: source.excerpt }] },
    ], [source, source]);
    expect(rows).toHaveLength(1);
    expect(rows[0].links.map(({ label, status }) => [label, status])).toEqual([["처분·허가 근거", "found"], ["적용 요건", "viewed"]]);
  });

  it("keeps different laws, provisions, versions, sources and nonoverlapping ranges distinct", () => {
    const original = { law: "식품위생법", jo: "제75조", excerpt: "① 영업정지", effective: "20261008",
      source: "https://www.law.go.kr/법령/식품위생법/제75조" };
    const rows = taskSources([], [original, { ...original }, { ...original, law: "다른 법" },
      { ...original, jo: "제76조" }, { ...original, effective: "20270901" },
      { ...original, source: "https://other.example/" }, { ...original, excerpt: "② 영업 폐쇄" }]);
    expect(rows).toHaveLength(6);
  });

  it("does not mistake a list-only source or a failed read for a confirmed link", () => {
    const rows = taskSources([{ label: "세부 기준(별표)", status: "none" }], [
      { law: "식품위생법 시행규칙", jo: "제89조", excerpt: "별표 23과 같다." },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].links).toEqual([]);
  });
});
