import { describe, expect, it } from "vitest";
import { questionTerms, questionTermsSubjectLess, researchEvidenceSources } from "@/lib/research-relevance";
import { enrichResearch, explicitArticlePairs, lookupIssue, type EnrichmentSources } from "@/server/research-enrichment";

const CASE1_QUESTION = "개인정보보호법 제38조와 그 시행령의 관계는 무엇인가? 개인정보보호법 제38조와 제39조의 내용도 함께 알려주세요.";
const CASE2_QUESTION = "식품위생법에 따른 영업정지 처분의 요건은 무엇인가? 영업정지의 근거 조문과 정지 기간을 알려주세요.";

function chainArticle(law: string, jo: string, title: string, body: string): string[] {
  const num = jo.replace(/^제/u, "").replace(/조$/u, "");
  return [law, `   제${num.padStart(4, "0")}조 (${title})`, `   ${jo}(${title})`, ` ${body}`, "   시행: 2026.10.08 | 소관부처", ""];
}

function chain(...articles: string[][]): string {
  return ["═══ 종합 리서치 ═══", "", "▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 2건):", "", ...articles.flat()].join("\n");
}

describe("explicit article pairs", () => {
  it("pairs each 조 with the most recent law name before it", () => {
    expect(explicitArticlePairs(questionTerms(CASE1_QUESTION))).toEqual([
      { law: "개인정보보호법", jo: "제38조" },
      { law: "개인정보보호법", jo: "제39조" },
    ]);
    expect(explicitArticlePairs(questionTerms("근로기준법 제76조의3과 개인정보보호법 제38조를 비교해 줘"))).toEqual([
      { law: "근로기준법", jo: "제76조의3" },
      { law: "개인정보보호법", jo: "제38조" },
    ]);
  });

  it("does not let a bare '그 시행령' steal the following 조", () => {
    expect(explicitArticlePairs(questionTerms("개인정보보호법 제38조와 그 시행령의 관계"))).toEqual([
      { law: "개인정보보호법", jo: "제38조" },
    ]);
  });
});

describe("law-name guard in adoption", () => {
  const requestTerms = questionTerms(CASE2_QUESTION);
  const text = chain(
    chainArticle("미술진흥법", "제19조", "영업정지", "영업정지 처분을 받은 자는 영업정지 기간 동안 영업을 하여서는 아니 된다."),
    // Title carries no issue term, so the title-subject guard does not veto;
    // the body carries 영업정지 as a word, so only the law guard decides.
    chainArticle("식품위생법", "제75조", "허가취소 등", "영업자가 각 호에 해당하는 경우에는 영업정지 처분을 명할 수 있다."),
  );

  it("does not adopt an unrelated regime's article when the question named a law", () => {
    expect(researchEvidenceSources(text, "영업정지 요건", undefined, requestTerms).articles)
      .toEqual([{ law: "식품위생법", jo: "제75조" }]);
  });

  it("still admits the named law's own subordinate law", () => {
    const subordinate = chain(
      chainArticle("식품위생법 시행령", "제52조", "허가취소 등", "법 제75조에 따른 영업정지 처분은 서면으로 하여야 한다."),
    );
    expect(researchEvidenceSources(subordinate, "영업정지 요건", undefined, requestTerms).articles)
      .toEqual([{ law: "식품위생법 시행령", jo: "제52조" }]);
  });

  it("treats 관계 as a generic word, so a relationship issue cannot adopt on 관계 alone", () => {
    expect(questionTermsSubjectLess("법령·시행령 관계")).toBe(true);
    const purpose = chain(
      chainArticle("회계관계직원 등의 책임에 관한 법률", "제1조", "목적", "법령이나 그 밖의 관계 규정 및 예산에 정하여진 바를 위반하는 행위를 방지한다."),
    );
    expect(researchEvidenceSources(purpose, "법령·시행령 관계", undefined, questionTerms(CASE1_QUESTION)).articles)
      .toEqual([]);
  });
});

function privacySources(): EnrichmentSources {
  return {
    async summary() { return undefined; },
    async laws(query) { return query === "개인정보보호법" ? [{ name: "개인정보 보호법", mst: "M1" }] : []; },
    async toc() { return []; },
    async article(mst, jo) {
      if (mst !== "M1") return undefined;
      if (jo === "제38조") return { text: "제38조(권리행사의 방법 및 절차)\n① 정보주체는 문서 등 대통령령으로 정하는 방법ㆍ절차에 따라 대리인에게 하게 할 수 있다.", effectiveDate: "20260911" };
      if (jo === "제39조") return { text: "제39조(손해배상책임)\n① 정보주체는 개인정보처리자가 이 법을 위반한 행위로 손해를 입으면 손해배상을 청구할 수 있다.", effectiveDate: "20260911" };
      return undefined;
    },
    async interpretations() { return []; },
    async precedents() { return []; },
  };
}

describe("lookupIssue explicit articles", () => {
  const questionTermsList = questionTerms(CASE1_QUESTION);
  const extraNamed = questionTermsList.filter((term) => /(?:법|법률|령|규칙|조례)$/u.test(term));

  it("fetches articles the issue named by number, resolving the spaced official law name", async () => {
    const lookup = await lookupIssue("제38조 제39조 내용", [], privacySources(), () => false, extraNamed, questionTermsList);
    expect(lookup.status).toBe("found");
    expect(lookup.articles).toEqual([
      expect.objectContaining({ law: "개인정보 보호법", jo: "제38조", explicit: true }),
      expect.objectContaining({ law: "개인정보 보호법", jo: "제39조", explicit: true }),
    ]);
  });

  it("gives a subject-less relationship issue only the article whose text states the delegation", async () => {
    const lookup = await lookupIssue("법령·시행령 관계", [], privacySources(), () => false, extraNamed, questionTermsList);
    expect(lookup.status).toBe("found");
    expect(lookup.articles.map((article) => article.jo)).toEqual(["제38조"]);
  });

  it("does not guess when the same number belongs to two question laws", async () => {
    const ambiguous: EnrichmentSources = {
      async summary() { return undefined; },
      async laws(query) { return query === "민법" ? [{ name: "민법", mst: "A" }] : query === "형법" ? [{ name: "형법", mst: "B" }] : []; },
      async toc() { return []; },
      async article(mst, jo) { return (mst === "A" || mst === "B") && jo === "제38조" ? { text: "제38조(제목)\n본문." } : undefined; },
      async interpretations() { return []; },
      async precedents() { return []; },
    };
    const extra = questionTerms("민법 제38조와 형법 제38조를 비교해 줘");
    const lookup = await lookupIssue("제38조 내용", [], ambiguous, () => false,
      extra.filter((term) => /(?:법|법률|령|규칙|조례)$/u.test(term)), extra);
    expect(lookup.articles).toEqual([]);
    expect(lookup.status).toBe("none");
  });
});

describe("supplement refinement", () => {
  it("does not discover laws from generic words, so an unrelated regime cannot fill the related list", async () => {
    const calls: string[] = [];
    const sources: EnrichmentSources = {
      async summary() { return undefined; },
      async laws(query) { calls.push(query); return query === "조사" ? [{ name: "대일항쟁기 강제동원 피해조사 및 국외강제동원 희생자 등 지원에 관한 특별법", mst: "X" }] : []; },
      async toc(mst) { return mst === "X" ? [{ jo: "제13조", title: "비밀준수의무" }] : []; },
      async article(mst, jo) { return mst === "X" && jo === "제13조" ? { text: "제13조(비밀준수의무)\n위원은 비밀준수의무를 진다." } : undefined; },
      async interpretations() { return []; },
      async precedents() { return []; },
    };
    const enrichment = await enrichResearch("full_research", "조사 의무", "", sources);
    expect(calls).toEqual([]);
    expect(enrichment.supplement).toEqual({ status: "none", articles: [] });
  });

  it("keeps a subject-matched article and drops a title that matches only a generic word", async () => {
    const sources: EnrichmentSources = {
      async summary() { return undefined; },
      async laws(query) { return query === "식품위생법" ? [{ name: "식품위생법", mst: "M" }] : []; },
      async toc(mst) { return mst === "M" ? [
        { jo: "제82조", title: "영업정지 등의 처분에 갈음하여 부과하는 과징금 처분" },
        { jo: "제48조의2", title: "인증 유효기간" },
      ] : []; },
      async article(mst, jo) {
        if (mst !== "M") return undefined;
        if (jo === "제82조") return { text: "제82조(영업정지 등의 처분에 갈음하여 부과하는 과징금 처분)\n영업정지 처분을 갈음하여 과징금을 부과할 수 있다.", effectiveDate: "20261008" };
        if (jo === "제48조의2") return { text: "제48조의2(인증 유효기간)\n인증의 유효기간은 3년으로 한다.", effectiveDate: "20261008" };
        return undefined;
      },
      async interpretations() { return []; },
      async precedents() { return []; },
    };
    const enrichment = await enrichResearch("action_basis", "식품위생법 영업정지 요건", "", sources);
    expect(enrichment.supplement?.articles.map((article) => `${article.law} ${article.jo}`)).toEqual(["식품위생법 제82조"]);
  });
});
