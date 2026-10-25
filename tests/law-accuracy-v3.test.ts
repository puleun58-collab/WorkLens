import { describe, expect, it } from "vitest";
import { researchEvidenceSources, rankPrecedent } from "@/lib/research-relevance";
import { enrichResearch, lookupIssue, type EnrichmentSources } from "@/server/research-enrichment";

function fakeSources(overrides: Partial<EnrichmentSources> = {}): EnrichmentSources & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async summary() { calls.push("summary"); return undefined; },
    async laws(query) {
      calls.push(`laws:${query}`);
      return query === "근로기준법" ? [{ name: "근로기준법", mst: "M1" }] : [];
    },
    async toc(mst) {
      calls.push(`toc:${mst}`);
      return mst === "M1" ? [{ jo: "제76조의3", title: "직장 내 괴롭힘 발생 시 조치" }] : [];
    },
    async article(mst, jo) {
      calls.push(`article:${mst}:${jo}`);
      return mst === "M1" && jo === "제76조의3"
        ? { name: "근로기준법", text: "제76조의3(직장 내 괴롭힘 발생 시 조치)\n 사용자는 직장 내 괴롭힘 발생 사실을 신고한 근로자에게 불리한 처우를 하여서는 아니 되며 필요한 조치를 하여야 한다." }
        : undefined;
    },
    async interpretations() { return []; },
    async precedents() { return []; },
    ...overrides,
  };
}

describe("law-accuracy-v3: citation requires read holding text (F4)", () => {
  it("does not cite a ranked precedent whose holding text was never read", () => {
    const relevance = rankPrecedent(["모욕죄"], { title: "모욕", summary: "공연히 사람을 모욕한 행위의 위법성" });
    expect(relevance.rank).toBe("direct");
    // Before the fix, the matched-term list (the question's own terms)
    // verified itself and this precedent was cited.
    expect(researchEvidenceSources("", "모욕죄", {
      precedents: { 9: relevance },
    }).precedents).toEqual([]);
  });

  it("still cites the same precedent once its holding text is read", () => {
    const relevance = rankPrecedent(["모욕죄"], { title: "모욕", summary: "공연히 사람을 모욕한 행위의 위법성" });
    expect(researchEvidenceSources("", "모욕죄", {
      precedents: { 9: relevance },
      precedentExcerpts: { 9: "공연히 사람을 모욕한 행위의 위법성" },
    }).precedents).toEqual(["9"]);
  });
});

describe("law-accuracy-v3: issue lookup inherits the question's law names (F2)", () => {
  it("finds nothing for a lawless issue phrase alone", async () => {
    const lookup = await lookupIssue("사용자 조치 의무", [], fakeSources(), () => false);
    expect(lookup.articles).toEqual([]);
  });

  it("finds the named law's title-matched article when the question's law name is passed", async () => {
    const lookup = await lookupIssue("사용자 조치 의무", [], fakeSources(), () => false, ["근로기준법"]);
    expect(lookup.articles.map((article) => `${article.law} ${article.jo}`)).toEqual(["근로기준법 제76조의3"]);
    expect(lookup.status).toBe("found");
  });
});

describe("law-accuracy-v3: truncated precedent excerpts are marked (C-2)", () => {
  const HARASSMENT = [
    "═══ 종합 리서치: 직장 내 괴롭힘 판단 기준 ═══", "",
    "▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 1건):", "",
    "근로기준법", "   제0076조의2 (직장 내 괴롭힘의 금지)", "   제76조의2(직장 내 괴롭힘의 금지)", " 사용자 또는 근로자는 …", "   시행: 2026.08.20 | 고용노동부", "",
    "▶ 관련 판례", "판례 검색 결과 (총 67건, 1페이지):", "",
    "[1] 방해금지청구", "  사건번호: 2024나25137", "",
    "[2] 부당이득금반환", "  사건번호: 2017다35588", "",
    "[3] 손해배상(기)", "  사건번호: 2023다1", "",
    "[4] 징계처분취소", "  사건번호: 2022두4", "",
    "[5] 해고무효확인", "  사건번호: 2021다5", "",
  ].join("\n");

  it("marks a cut excerpt with an ellipsis and leaves a short one unmarked", async () => {
    const long = `${"직장 내 괴롭힘으로 인한 사용자의 손해배상책임이 인정되는 요건. ".repeat(30)}`;
    const sources = fakeSources({
      async summary(id) {
        if (id === "3") return { text: long, excerpt: false };
        if (id === "1") return { text: "이사장 직무집행 방해 금지를 구한다.", excerpt: true };
        return undefined;
      },
    });
    const enrichment = await enrichResearch("full_research", "직장 내 괴롭힘 판단 기준", HARASSMENT, sources);
    expect(enrichment.precedentExcerpts?.["3"]).toMatch(/ …$/u);
    expect(enrichment.precedentExcerpts?.["3"].length).toBeLessThanOrEqual(603);
  });
});
