import { describe, expect, it } from "vitest";
import { resolveLawArticleTarget } from "@/lib/law-article-target";

const ARTICLE_60 = [
  "법령명: 근로기준법",
  "",
  "제60조 연차 유급휴가",
  "제60조(연차 유급휴가)",
  "① 사용자는 1년간 80퍼센트 이상 출근한 근로자에게 15일의 유급휴가를 주어야 한다.",
  "② 사용자는 계속하여 근로한 기간이 1년 미만인 근로자에게 1개월 개근 시 1일의 유급휴가를 주어야 한다.",
  "⑥ 제1항 및 제2항을 적용하는 경우 다음 각 호의 어느 하나에 해당하는 기간은 출근한 것으로 본다.",
  "1. 근로자가 업무상의 부상 또는 질병으로 휴업한 기간",
  "2. 임신 중의 여성이 제74조제1항부터 제3항까지의 규정에 따른 휴가로 휴업한 기간",
  "3. 육아휴직으로 휴업한 기간",
  "⑦ 제1항ㆍ제2항 및 제4항에 따른 휴가는 1년간 행사하지 아니하면 소멸된다.",
].join("\n");

function shownLinesOf(result: { shownLines: string[] }) {
  return result.shownLines;
}

describe("law article target resolution", () => {
  it("locates a 항 range and a 호 range with its 항 lead-in", () => {
    const hang = resolveLawArticleTarget(ARTICLE_60, "제60조", { hang: 6 });
    expect(hang.fallback).toBe(false);
    if (!hang.fallback) {
      expect([...hang.targetIndices].map((index) => hang.shownLines[index])).toEqual([
        "⑥ 제1항 및 제2항을 적용하는 경우 다음 각 호의 어느 하나에 해당하는 기간은 출근한 것으로 본다.",
        "1. 근로자가 업무상의 부상 또는 질병으로 휴업한 기간",
        "2. 임신 중의 여성이 제74조제1항부터 제3항까지의 규정에 따른 휴가로 휴업한 기간",
        "3. 육아휴직으로 휴업한 기간",
      ]);
    }
    const ho = resolveLawArticleTarget(ARTICLE_60, "제60조", { hang: 6, ho: 3 });
    expect(ho.fallback).toBe(false);
    if (!ho.fallback) {
      expect([...ho.targetIndices].map((index) => ho.shownLines[index])).toEqual([
        "⑥ 제1항 및 제2항을 적용하는 경우 다음 각 호의 어느 하나에 해당하는 기간은 출근한 것으로 본다.",
        "3. 육아휴직으로 휴업한 기간",
      ]);
    }
    expect(shownLinesOf(hang)).toEqual(shownLinesOf(ho));
  });

  it("resolves on display text, so <p>-separated 항/호 lines still locate", () => {
    const text = "제60조(연차 유급휴가)\n<P>① 항하나</P><P>⑥ 다음 각 호의</P><P>1. 호하나</P><P>2. 호둘</P>";
    const resolved = resolveLawArticleTarget(text, "제60조", { hang: 6, ho: 2 });
    expect(resolved.fallback).toBe(false);
    if (!resolved.fallback) {
      expect([...resolved.targetIndices].map((index) => resolved.shownLines[index])).toEqual(["⑥ 다음 각 호의", "2. 호둘"]);
    }
  });

  it("falls back for a missing 항, a marker-less article with a 항 query, and a wrong 조", () => {
    expect(resolveLawArticleTarget(ARTICLE_60, "제60조", { hang: 9 }).fallback).toBe(true);
    expect(resolveLawArticleTarget(ARTICLE_60, "제60조", { hang: 6, ho: 9 }).fallback).toBe(true);
    expect(resolveLawArticleTarget(ARTICLE_60, "제74조", { hang: 1 }).fallback).toBe(true);
    // A single-paragraph article has no ① marker: the 항 query is not
    // silently treated as "the whole article is the target".
    expect(resolveLawArticleTarget("제750조(불법행위의 내용)\n고의 또는 과실로 인한 위법행위로 타인에게 손해를 가한 자는 이를 배상할 책임이 있다.", "제750조", { hang: 1 }).fallback).toBe(true);
  });

  it("falls back when a second 조 title appears inside the range", () => {
    const text = `${ARTICLE_60}\n제61조 연차 유급휴가의 사용 촉진\n① 사용자는 제60조에 따른 휴가를 사용하도록 촉진하여야 한다.`;
    expect(resolveLawArticleTarget(text, "제60조", { hang: 6 }).fallback).toBe(true);
  });
});
