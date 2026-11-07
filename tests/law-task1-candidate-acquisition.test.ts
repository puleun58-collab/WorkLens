import { describe, expect, it } from "vitest";
import {
  lookupIssue, rereadShownArticles, selectRereadCandidates, type EnrichmentSources,
} from "@/server/research-enrichment";

/**
 * Task 1 (DESIGN-FOLLOWUP §2.3) — 후보 확보: F5 게이트 완화 + partial
 * 미리보기 전문 재조회. 범위 한정과 대상 선정 규칙을 단위 테스트로 고정한다.
 */

const ARTICLE_43 = [
  "제43조(임금 지급)",
  "① 임금은 통화로 직접 근로자에게 그 전액을 지급하여야 한다.",
].join("\n");
const ARTICLE_36 = [
  "제36조(금품 청산)",
  "① 사용자는 근로자가 사망 또는 퇴직한 경우에는 그 지급 사유가 발생한 때부터 14일 이내에 임금, 보상금, 그 밖의 모든 금품을 지급하여야 한다.",
].join("\n");

function lookupSources(): EnrichmentSources & { lawQueries: string[] } {
  const lawQueries: string[] = [];
  return {
    lawQueries,
    async summary() { return undefined; },
    async laws(query) {
      lawQueries.push(query);
      if (query === "근로기준법") return [{ name: "근로기준법", mst: "285279" }];
      if (query === "퇴직") return [{ name: "근로자퇴직급여 보장법", mst: "999001" }];
      if (query === "임금") return [{ name: "임금채권보장법", mst: "999002" }];
      return [];
    },
    async toc(mst) {
      if (mst === "285279") return [
        { jo: "제43조", title: "임금 지급" },
        { jo: "제36조", title: "금품 청산" },
      ];
      if (mst === "999001") return [{ jo: "제1조", title: "퇴직급여 지급" }];
      if (mst === "999002") return [{ jo: "제7조", title: "임금 지급" }];
      return [];
    },
    async article(mst, jo) {
      if (mst === "285279" && jo === "제43조") return { text: ARTICLE_43, name: "근로기준법", effectiveDate: "20261008" };
      if (mst === "285279" && jo === "제36조") return { text: ARTICLE_36, name: "근로기준법", effectiveDate: "20261008" };
      if (mst === "999001" && jo === "제1조") return { text: "제1조(퇴직급여 지급)\n① 퇴직급여를 지급한다.", name: "근로자퇴직급여 보장법" };
      if (mst === "999002" && jo === "제7조") return { text: "제7조(임금 지급)\n① 임금을 지급한다.", name: "임금채권보장법" };
      return undefined;
    },
    async interpretations() { return []; },
    async precedents() { return []; },
  };
}

describe("Task 1 (A안) lookupIssue restrictToNamedLaws", () => {
  const shown = [{ law: "근로기준법", jo: "제37조" }];

  it("한정 시 키워드로 새 법령을 발견하지 않고 named 법령의 제목 일치 조문만 반환한다", async () => {
    const sources = lookupSources();
    const lookup = await lookupIssue("퇴직 임금 지급 기한", shown, sources, () => false, [], [], [],
      { restrictToNamedLaws: true });
    // 법령 조회는 named(체인 등장 근로기준법)로만 한다 — 키워드 조회 없음.
    expect(sources.lawQueries).toEqual(["근로기준법"]);
    expect(lookup.status).toBe("found");
    // 제목이 쟁점 용어와 일치하는 제43조만 후보가 된다. 금품 청산(제36조)은
    // 제목에 쟁점 용어가 없어 제목 조회로는 오지 않는다.
    expect(lookup.articles.map((article) => `${article.law} ${article.jo}`)).toEqual(["근로기준법 제43조"]);
  });

  it("한정 없이는 기존 동작 그대로 키워드로 법령을 발견한다", async () => {
    const sources = lookupSources();
    const lookup = await lookupIssue("퇴직 임금 지급 기한", shown, sources, () => false);
    expect(sources.lawQueries).toContain("퇴직");
    expect(sources.lawQueries).toContain("임금");
    const found = lookup.articles.map((article) => `${article.law} ${article.jo}`);
    expect(found).toContain("근로기준법 제43조");
    expect(found).toContain("근로자퇴직급여 보장법 제1조");
    expect(found).toContain("임금채권보장법 제7조");
  });
});

describe("Task 1 (C안) selectRereadCandidates / rereadShownArticles", () => {
  const terms = ["퇴직", "임금", "지급", "기한"];
  const partial36 = { law: "근로기준법", jo: "제36조", title: "금품 청산", excerpt: "사용자는 근로자가 사망 또는 퇴직한 경우에는 …" };

  it("제목 일치가 없어도 partial 미리보기가 체인에 반복 등장하면 재독 대상이다", () => {
    const chainText = [
      "[관련 조문] 근로기준법 제36조(금품 청산)",
      "근로기준법 제36조에 따라 퇴직한 근로자에게 금품을 청산해야 한다.",
    ].join("\n");
    const selected = selectRereadCandidates([partial36], terms, chainText);
    expect(selected).toHaveLength(1);
    expect(selected[0].article.jo).toBe("제36조");
    expect(selected[0].partial).toBe(true);
    expect(selected[0].repeats).toBe(2);
  });

  it("한 번만 등장하거나 완전 원문이면 반복 등장 규칙으로 선택되지 않는다", () => {
    const once = "[관련 조문] 근로기준법 제36조(금품 청산)";
    expect(selectRereadCandidates([partial36], terms, once)).toEqual([]);
    const complete = { ...partial36, excerpt: "사용자는 근로자가 사망 또는 퇴직한 경우에는 그 지급 사유가 발생한 때부터 14일 이내에 지급하여야 한다." };
    const twice = `${once}\n근로기준법 제36조에 따라 청산한다.`;
    expect(selectRereadCandidates([complete], terms, twice)).toEqual([]);
  });

  it("제136조·제360조·제36조의2는 제36조 언급으로 세지 않는다", () => {
    const chainText = [
      "근로기준법 제136조를 본다.",
      "근로기준법 제360조를 본다.",
      "근로기준법 제36조의2를 본다.",
      "근로기준법 제36조(금품 청산)",
    ].join("\n");
    // 제36조 자체는 한 번만 등장하므로 반복 규칙에 닿지 않는다.
    expect(selectRereadCandidates([partial36], terms, chainText)).toEqual([]);
  });

  it("재독은 반복 등장 partial 미리보기의 전문을 가져온다", async () => {
    const sources = lookupSources();
    const chainText = [
      "[관련 조문] 근로기준법 제36조(금품 청산)",
      "근로기준법 제36조에 따라 퇴직한 근로자에게 금품을 청산해야 한다.",
    ].join("\n");
    const articles = await rereadShownArticles([partial36], terms, sources, () => false, 2, chainText);
    expect(articles).toHaveLength(1);
    expect(articles[0].law).toBe("근로기준법");
    expect(articles[0].jo).toBe("제36조");
    expect(articles[0].stage).toBe("reread");
    expect(articles[0].excerpt).toContain("14일 이내");
  });

  it("재독은 쟁점당 최대 2건까지만 가져온다", async () => {
    const three = [
      { law: "근로기준법", jo: "제43조", title: "임금 지급", excerpt: "임금은 …" },
      { law: "근로기준법", jo: "제36조", title: "금품 청산", excerpt: "사용자는 …" },
      { law: "근로기준법", jo: "제37조", title: "준용 규정", excerpt: "제37조는 …" },
    ];
    const chainText = "근로기준법 제43조와 제36조와 제37조를 본다. 근로기준법 제43조·제36조·제37조를 다시 본다.";
    const selected = selectRereadCandidates(three, terms, chainText);
    expect(selected).toHaveLength(2);
  });
});
