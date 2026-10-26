/**
 * Displayed-supplement refinement (law-accuracy-refine, area B).
 *
 * Scope note: the chain section "관련 조문 N건" passes upstream chain text
 * through without a relevance filter by design (2026-10-26 user decision:
 * keep as-is). These tests cover only the displayed supplement path
 * (enrichment.supplement, strictCandidates), never the chain section.
 */
import { describe, expect, it } from "vitest";
import { enrichResearch, type EnrichmentSources } from "@/server/research-enrichment";
import { questionTerms, researchEvidenceSources, type ResearchEnrichment } from "@/lib/research-relevance";

function foodLawSources(toc: Array<{ jo: string; title: string }>, article: (jo: string) => { text: string; effectiveDate?: string } | undefined | Promise<never>): EnrichmentSources {
  return {
    async summary() { return undefined; },
    async laws(query) { return query === "식품위생법" ? [{ name: "식품위생법", mst: "M" }] : []; },
    async toc(mst) { return mst === "M" ? toc : []; },
    async article(mst, jo) {
      if (mst !== "M") return undefined;
      const found = article(jo);
      return found;
    },
    async interpretations() { return []; },
    async precedents() { return []; },
  };
}

describe("displayed supplement relevance (law-accuracy-refine)", () => {
  it("B2: a title matching only generic words does not enter the displayed supplement", async () => {
    const sources = foodLawSources(
      [
        { jo: "제82조", title: "영업정지 등의 처분에 갈음하여 부과하는 과징금 처분" },
        { jo: "제90조", title: "조사 의무" },
      ],
      (jo) => {
        if (jo === "제82조") return { text: "제82조(영업정지 등의 처분에 갈음하여 부과하는 과징금 처분)\n영업정지 처분을 갈음하여 과징금을 부과할 수 있다.", effectiveDate: "20261008" };
        if (jo === "제90조") return { text: "제90조(조사 의무)\n조사 의무를 진다.", effectiveDate: "20261008" };
        return undefined;
      },
    );
    const enrichment = await enrichResearch("action_basis", "식품위생법 영업정지 조사 의무", "", sources);
    expect(enrichment.supplement?.articles.map((article) => `${article.law} ${article.jo}`)).toEqual(["식품위생법 제82조"]);
  });

  it("B5: a landed article keeps its partial-failure flag when a sibling lookup fails", async () => {
    const sources = foodLawSources(
      [
        { jo: "제82조", title: "영업정지 등의 처분에 갈음하여 부과하는 과징금 처분" },
        { jo: "제83조", title: "영업정지 처분 절차" },
      ],
      (jo) => {
        if (jo === "제82조") return { text: "제82조(영업정지 등의 처분에 갈음하여 부과하는 과징금 처분)\n영업정지 처분을 갈음하여 과징금을 부과할 수 있다.", effectiveDate: "20261008" };
        if (jo === "제83조") throw new Error("upstream failure");
        return undefined;
      },
    );
    const enrichment = await enrichResearch("action_basis", "식품위생법 영업정지 조사 의무", "", sources);
    expect(enrichment.supplement?.articles.map((article) => `${article.law} ${article.jo}`)).toEqual(["식품위생법 제82조"]);
    expect(enrichment.supplement?.partialFailure).toBe(true);
  });

  it("B5: every lookup failing still reports failed, not an empty success", async () => {
    const sources: EnrichmentSources = {
      async summary() { return undefined; },
      async laws() { throw new Error("upstream failure"); },
      async toc() { return []; },
      async article() { return undefined; },
      async interpretations() { return []; },
      async precedents() { return []; },
    };
    const enrichment = await enrichResearch("action_basis", "식품위생법 영업정지", "", sources);
    expect(enrichment.supplement?.status).toBe("failed");
    expect(enrichment.supplement?.articles).toEqual([]);
  });

  it("B3: a user-named law + article stays adopted even when relevance rules would drop it", () => {
    const enrichment = {
      supplement: {
        status: "found" as const,
        articles: [{ law: "근로기준법", jo: "제76조의3", title: "직장 내 괴롭힘 발생 시 조치", excerpt: "사용자는 신고를 접수하면 조사를 실시하여야 한다.", matched: [], explicit: true }],
      },
    } as unknown as ResearchEnrichment;
    const adopted = researchEvidenceSources("", "근로기준법 제76조의3", enrichment, questionTerms("근로기준법 제76조의3")).articles;
    expect(adopted).toEqual([{ law: "근로기준법", jo: "제76조의3" }]);
  });

  it("B4: a supplement-only article with no direct evidence is not promoted to confirmed evidence", () => {
    const enrichment = {
      supplement: {
        status: "found" as const,
        articles: [{ law: "근로기준법", jo: "제99조", title: "조사 의무", excerpt: "조사 의무를 진다.", matched: ["조사", "의무"] }],
      },
    } as unknown as ResearchEnrichment;
    const requestTerms = questionTerms("근로기준법 제76조의3에 따른 직장 내 괴롭힘 발생 시 사용자의 의무는 무엇인가? 1) 조사 의무, 2) 피해자 보호 조치, 3) 가해자에 대한 조치를 각각 알려주세요.");
    const adopted = researchEvidenceSources("", "조사 의무", enrichment, requestTerms).articles;
    expect(adopted).toEqual([]);
  });
});
