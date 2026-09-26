import { describe, expect, it } from "vitest";
import { orderByRelevance, questionTerms, rankPrecedent, titleMatches } from "@/lib/research-relevance";
import { enrichResearch, type EnrichmentSources } from "@/server/research-enrichment";

/** A full_research answer shaped like the live one for "직장 내 괴롭힘 판단 기준". */
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

function fakeSources(overrides: Partial<EnrichmentSources> = {}): EnrichmentSources & { calls: string[] } {
  const calls: string[] = [];
  const summaries: Record<string, { text: string; excerpt: boolean } | undefined> = {
    1: { text: "【원고】 이사장 직무집행 방해 금지를 구한다.", excerpt: true },
    2: { text: "[1] 부당이득반환청구권의 소멸시효 기산점", excerpt: false },
    3: { text: "[1] 직장 내 괴롭힘으로 인한 사용자의 손해배상책임이 인정되는 요건", excerpt: false },
    4: { text: "[1] 근로기준법 제76조의2에서 정한 행위에 해당하는지 판단하는 방법", excerpt: false },
    5: undefined,
  };
  return {
    calls,
    async summary(id) { calls.push(`summary:${id}`); return summaries[id]; },
    async laws(query) { calls.push(`laws:${query}`); return []; },
    async toc(mst) { calls.push(`toc:${mst}`); return []; },
    async article(mst, jo) { calls.push(`article:${mst}:${jo}`); return undefined; },
    ...overrides,
  };
}

describe("question terms", () => {
  it("keeps the subject and drops framing words and particles", () => {
    expect(questionTerms("직장 내 괴롭힘 판단 기준")).toEqual(["직장", "괴롭힘"]);
    expect(questionTerms("건축법 이행강제금 부과 근거")).toEqual(["건축법", "이행강제금", "부과"]);
    expect(questionTerms("임대차 보증금의 반환")).toEqual(["임대차", "보증금", "반환"]);
  });
});

describe("precedent relevance for 종합 리서치", () => {
  const terms = questionTerms("직장 내 괴롭힘 판단 기준");

  it("ranks by the 판시사항, not the case title", () => {
    expect(rankPrecedent(terms, { title: "손해배상(기)", summary: "직장 내 괴롭힘으로 인한 손해배상책임" }).rank).toBe("direct");
    expect(rankPrecedent(terms, { title: "직장 내 괴롭힘 손해배상", summary: "부당이득반환청구권의 소멸시효" }).rank).toBe("direct");
    expect(rankPrecedent(terms, { title: "부당이득금반환", summary: "부당이득반환청구권의 소멸시효 기산점" }).rank).toBe("low");
  });

  it("treats a cited statute article as a direct link, and a judgment opening as at most related", () => {
    expect(rankPrecedent(terms, { title: "징계처분취소", summary: "근로기준법 제76조의2에서 정한 행위" }, ["근로기준법 제76조의2"]).rank).toBe("direct");
    expect(rankPrecedent(terms, { title: "손해배상", summary: "직장 내 괴롭힘을 이유로", excerpt: true }).rank).toBe("related");
    expect(rankPrecedent(terms, { title: "방해금지청구", summary: "직무집행 방해 금지", excerpt: true }).rank).toBe("low");
  });

  it("never demotes a case it could not read", () => {
    expect(rankPrecedent(terms, { title: "해고무효확인" }).rank).toBe("unknown");
  });

  it("orders direct, related, unknown, low and keeps upstream order within a rank", () => {
    const ids = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
    const ranked = orderByRelevance(ids, {
      a: { rank: "low", matched: [] }, b: { rank: "direct", matched: [] }, c: { rank: "unknown", matched: [] },
      d: { rank: "direct", matched: [] }, e: { rank: "related", matched: [] },
    });
    expect(ranked.map((entry) => entry.id)).toEqual(["b", "d", "e", "c", "a"]);
  });

  it("re-ranks the live harassment answer: unrelated civil cases fall, harassment and article cases rise", async () => {
    const enrichment = await enrichResearch("full_research", "직장 내 괴롭힘 판단 기준", HARASSMENT, fakeSources());
    expect(Object.fromEntries(Object.entries(enrichment.precedents!).map(([id, value]) => [id, value.rank]))).toEqual({
      1: "low", 2: "low", 3: "direct", 4: "direct", 5: "unknown",
    });
  });

  it("keeps every case unknown when summaries fail, so nothing is hidden on an outage", async () => {
    const enrichment = await enrichResearch("full_research", "직장 내 괴롭힘 판단 기준", HARASSMENT,
      fakeSources({ async summary() { throw new Error("down"); } }));
    expect(Object.values(enrichment.precedents!).every((value) => value.rank === "unknown")).toBe(true);
  });
});

describe("title-matched article lookup", () => {
  it("ignores terms that are part of the law's own name", () => {
    expect(titleMatches(["임대차", "보증금", "반환"], "주택임대차보호법", "보증금의 회수")).toEqual(["보증금"]);
    expect(titleMatches(["임대차", "보증금"], "주택임대차보호법", "임대차기간 등")).toEqual([]);
    expect(titleMatches(["건축법", "이행강제금"], "건축법", "이행강제금")).toEqual(["이행강제금"]);
  });

  it("finds an article through the law named in the question and reads only what it cites", async () => {
    const sources = fakeSources({
      async laws(query) { return query === "건축법" ? [{ name: "건축법", mst: "m1" }] : []; },
      async toc() { return [{ jo: "제79조", title: "위반 건축물 등에 대한 조치 등" }, { jo: "제80조", title: "이행강제금" }]; },
      async article(_mst, jo) { return { text: `${jo}(이행강제금) ① 허가권자는 …`, effectiveDate: "20250101" }; },
    });
    const enrichment = await enrichResearch("action_basis", "건축법 이행강제금", "═══ 처분 근거 확인: 건축법 ═══\n", sources);
    expect(enrichment.supplement).toMatchObject({ status: "found", articles: [{ law: "건축법", jo: "제80조", title: "이행강제금", matched: ["이행강제금"] }] });
    expect(enrichment.supplement!.articles[0].excerpt).toContain("허가권자는");
  });

  it("finds laws through a question term when no law is named, and skips articles the answer already shows", async () => {
    const answer = "═══ 종합 리서치: 임대차 보증금 반환 ═══\n\n▶ AI 법령검색 결과\n지능형 법령검색 결과 (법령조문, 1건):\n\n주택임대차보호법\n   제0003조의2 (보증금의 회수)\n 본문\n   시행: 2025.01.01 | 법무부\n";
    const sources = fakeSources({
      async laws(query) { return query === "임대차" ? [{ name: "주택임대차보호법", mst: "h" }, { name: "상가건물 임대차보호법", mst: "s" }, { name: "임대차 등기 규칙", mst: "r" }] : []; },
      async toc(mst) { return mst === "h" ? [{ jo: "제3조의2", title: "보증금의 회수" }, { jo: "제8조", title: "보증금 중 일정액의 보호" }] : [{ jo: "제5조", title: "보증금의 회수" }]; },
      async article(mst, jo) { return { text: `${jo}(제목)\n${mst} 본문` }; },
    });
    const enrichment = await enrichResearch("full_research", "임대차 보증금 반환", answer, sources);
    expect(enrichment.supplement!.articles.map((article) => `${article.law} ${article.jo}`)).toEqual(["주택임대차보호법 제8조", "상가건물 임대차보호법 제5조"]);
    expect(sources.calls).not.toContain("toc:r");
  });

  it("reports none, failed and not searched as different states, and never invents an article", async () => {
    expect((await enrichResearch("action_basis", "건축법 이행강제금", "", fakeSources())).supplement).toEqual({ status: "none", articles: [] });
    const failing = fakeSources({ async laws() { throw new Error("down"); } });
    expect((await enrichResearch("action_basis", "건축법 이행강제금", "", failing)).supplement).toEqual({ status: "failed", articles: [] });
    expect((await enrichResearch("action_basis", "건축법 판단 기준", "", fakeSources())).supplement).toEqual({ status: "not_searched", articles: [] });
  });

  it("stops starting lookups once the budget is spent", async () => {
    let clock = 0;
    const sources = fakeSources({ async summary() { clock += 20_000; return { text: "직장 내 괴롭힘", excerpt: false }; } });
    const enrichment = await enrichResearch("full_research", "직장 내 괴롭힘 판단 기준", HARASSMENT, sources, () => clock);
    expect(sources.calls.filter((call) => call.startsWith("summary")).length).toBeLessThan(5);
    expect(Object.keys(enrichment.precedents!)).toHaveLength(5);
  });
});
