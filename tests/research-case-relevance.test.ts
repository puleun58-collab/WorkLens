import { describe, expect, it } from "vitest";
import {
  orderByRelevance, questionTerms, rankPrecedent, researchDecisionDomain,
  type ResearchDecisionDomain,
} from "@/lib/research-relevance";
import { enrichResearch, precedentEvidence, sharedSources, type EnrichmentSources } from "@/server/research-enrichment";

const QUERY = "식품위생법 무신고 영업정지 재량권 남용 판단 기준";
const HOLDING = "식품위생법상 무신고 영업정지 처분의 재량권 남용 여부를 판단하는 기준";
const TERMS = questionTerms(QUERY);

function sources(overrides: Partial<EnrichmentSources> = {}): EnrichmentSources {
  return {
    async summary() { return undefined; },
    async laws() { return []; },
    async toc() { return []; },
    async article() { return undefined; },
    async interpretations() { return []; },
    async precedents() { return []; },
    ...overrides,
  };
}

const THREE_DOMAINS = [
  "═══ 종합 리서치: 식품위생법 ═══", "",
  "▶ 관련 판례", "판례 검색 결과 (총 2건, 1페이지):", "",
  "[1] 영업정지처분취소", "  사건번호: 2025두100", "  법원: 대법원", "",
  "[2] 무신고 영업정지", "  사건번호: 2025두101", "",
  "▶ 법령 해석례", "법령해석례 검색 결과 (총 1건, 1페이지):", "",
  "[1] 무신고 영업정지 해석", "  해석례번호: 25-0001", "  해석기관: 법제처", "",
  "▶ 행정심판례", "행정심판례 검색 결과 (총 1건, 1페이지):", "",
  "[1] 영업정지 취소청구", "  사건번호: 2025-00100", "  재결청: 중앙행정심판위원회", "",
].join("\n");

describe("body-supported decision relevance dimensions", () => {
  it("uses the issue, violation, disposition and judgment standard together", () => {
    const direct = rankPrecedent(TERMS, { title: "영업정지처분취소", summary: HOLDING }, [], { query: QUERY });
    expect(direct.rank).toBe("direct");
    expect(direct.basis).toMatchObject({
      violation: ["무신고"], action: ["영업정지"], standard: ["재량권", "남용"], articles: [],
    });
    expect(rankPrecedent(TERMS, {
      title: HOLDING,
      summary: "식품위생법상 시설기준 위반 영업정지 처분의 재량권 남용 판단 기준",
    }, [], { query: QUERY }).rank).toBe("related");
    expect(rankPrecedent(TERMS, {
      title: HOLDING, summary: "식품위생법상 시설기준과 음식점의 정의에 관한 해석",
    }, [], { query: QUERY }).rank).toBe("low");
  });

  it("does not let an identical law name promote a different issue", () => {
    expect(rankPrecedent(["식품위생법"], { summary: "식품위생법상 조리사의 자격" }).rank).toBe("low");
    expect(rankPrecedent(["식품위생법", "영업정지"], {
      title: "식품위생법 영업정지", summary: "식품위생법상 조리사의 자격",
    }).rank).toBe("low");
  });

  it("matches the exact cited article but not its neighboring or inserted article", () => {
    expect(rankPrecedent(["괴롭힘"], { summary: "근로기준법 제76조의2에서 정한 행위의 판단 기준" },
      ["근로기준법 제76조의2"]).rank).toBe("direct");
    for (const summary of ["식품위생법 제75조의2에서 정한 행위", "식품위생법 제750조에서 정한 행위"]) {
      expect(rankPrecedent(["무신고"], { summary }, ["식품위생법 제75조"]).rank).toBe("low");
    }
  });

  it("keeps an article match supplementary when requested violation evidence is missing", () => {
    const ranked = rankPrecedent(TERMS, {
      summary: "식품위생법 제75조에 따른 시설기준 위반 영업정지 처분의 재량권 남용 판단 기준",
    }, ["식품위생법 제75조"], { query: QUERY });
    expect(ranked.rank).toBe("related");
    expect(ranked.basis?.articles).toEqual(["식품위생법 제75조"]);
    expect(ranked.basis?.violation).toEqual([]);
  });

  it("keeps other dispositions and missing legal standards supplementary", () => {
    for (const summary of [
      "무신고 허가취소 처분의 재량권 남용 판단 기준",
      "무신고 영업정지 처분의 기간 산정 기준",
    ]) {
      const ranked = rankPrecedent(TERMS, { summary }, ["식품위생법 제75조"], { query: QUERY });
      expect(ranked.rank).not.toBe("direct");
    }
  });

  it("never upgrades an opening or invents a holding for an unread body", () => {
    expect(rankPrecedent(TERMS, { title: "영업정지처분취소", summary: HOLDING, excerpt: true }, [], { query: QUERY }).rank).toBe("related");
    for (const summary of [undefined, "", "   "]) {
      expect(rankPrecedent(TERMS, { title: HOLDING, summary }, [], { query: QUERY })).toEqual({ rank: "unknown", matched: [] });
    }
    expect(rankPrecedent(TERMS, { title: HOLDING, summary: `=== ${HOLDING} ===\n  사건번호: 2025두100` }).rank).toBe("unknown");
  });

  it("requires a judgment standard when the request asks for one", () => {
    const query = "영업정지 판단 기준";
    expect(rankPrecedent(questionTerms(query), { summary: "영업정지 처분을 받은 사실" }, [], { query }).rank).toBe("related");
    expect(rankPrecedent(questionTerms(query), { summary: "영업정지 처분에 해당하는지 판단하는 기준" }, [], { query }).rank).toBe("direct");
  });
});

describe("official holding and interpretation evidence", () => {
  it("does not turn a citation list, question or bare disposition into a holding", () => {
    for (const sections of [
      [{ heading: "참조조문", text: "식품위생법 제75조" }],
      [{ heading: "질의요지", text: HOLDING }],
      [{ heading: "주문", text: "청구를 기각한다." }],
    ]) {
      expect(precedentEvidence({ text: HOLDING, sections })).toBeUndefined();
    }
  });

  it("does not use reference-list overlap to overstate an unrelated holding", () => {
    const evidence = precedentEvidence({ text: HOLDING, sections: [
      { heading: "판결요지", text: "조리사의 자격에 관한 판단 기준" },
      { heading: "참조조문", text: "식품위생법 제75조" },
    ] })!;
    expect(evidence.text).not.toContain("제75조");
    expect(rankPrecedent(TERMS, { summary: evidence.text }, ["식품위생법 제75조"], { query: QUERY }).rank).toBe("low");
  });

  it("reads replies, administrative holdings and reasons instead of a matching question", () => {
    expect(precedentEvidence({ text: "원문", sections: [
      { heading: "질의요지", text: HOLDING },
      { heading: "회답", text: "무신고 영업정지에 해당하지 않습니다." },
    ] })).toEqual({ text: "무신고 영업정지에 해당하지 않습니다.", excerpt: false });
    expect(precedentEvidence({ text: "원문", sections: [
      { heading: "재결요지", text: HOLDING },
    ] })).toEqual({ text: HOLDING, excerpt: false });
    expect(precedentEvidence({ text: "원문", sections: [
      { heading: "이유", text: HOLDING },
    ] })).toEqual({ text: HOLDING, excerpt: false });
  });
});

describe("stable ordering and identity-preserving case deduplication", () => {
  it("places direct first and preserves every original identifier and source", () => {
    const entries = [
      { id: "a", caseNumber: "2025두100", title: "영업정지처분취소", body: "대법원" },
      { id: "b", caseNumber: "2025 두 100", date: "2025.10.01", source: "법제처" },
      { id: "c", caseNumber: "2025두101", title: "별도 사건" },
      { id: "d", title: "미확인 사건" },
    ];
    const ordered = orderByRelevance(entries, {
      a: { rank: "related", matched: [] }, b: { rank: "direct", matched: [] },
      c: { rank: "low", matched: [] }, d: { rank: "unknown", matched: [] },
    });
    expect(ordered.map((entry) => entry.id)).toEqual(["b", "d", "c"]);
    expect(ordered[0]).toMatchObject({ id: "b", body: "대법원", date: "2025.10.01", source: "법제처" });
    expect(ordered[0].duplicateEntries).toEqual([entries[1], entries[0]]);
    expect(entries[1]).not.toHaveProperty("body");
  });

  it("deduplicates repeated IDs without rankings and joins transitive identities", () => {
    const entries = [
      { id: "a", caseNumber: "2025두100" }, { id: "b", caseNumber: "2025두101" },
      { id: "a", caseNumber: "2025두101" },
    ];
    const ordered = orderByRelevance(entries, undefined);
    expect(ordered).toHaveLength(1);
    expect(ordered[0].duplicateEntries).toHaveLength(3);
    expect(ordered[0].duplicateEntries).toEqual(expect.arrayContaining(entries));
  });

  it("never merges different domains or masked case numbers", () => {
    expect(orderByRelevance([
      { id: "1", domain: "precedent", caseNumber: "2025두100" },
      { id: "1", domain: "interpretation", caseNumber: "2025두100" },
      { id: "2", domain: "precedent", caseNumber: "2025두***" },
      { id: "3", domain: "precedent", caseNumber: "2025두***" },
    ], undefined)).toHaveLength(4);
  });
});

describe("research enrichment across all three official decision domains", () => {
  it("identifies section domains without conflating reused IDs", () => {
    expect(researchDecisionDomain("관련 판례")).toBe("precedent");
    expect(researchDecisionDomain("법령 해석례")).toBe("interpretation");
    expect(researchDecisionDomain("행정심판례")).toBe("tribunal");
    expect(researchDecisionDomain("헌재 결정례 상세")).toBe("constitutional");
    expect(researchDecisionDomain("조세심판원 재결례")).toBe("tax_tribunal");
    expect(researchDecisionDomain("개인정보위 결정례 상세")).toBe("pipc");
    expect(researchDecisionDomain("관련 조문")).toBeUndefined();
  });

  it("ranks official bodies independently and leaves unread judgment bodies unknown", async () => {
    const calls: string[] = [];
    const enrichment = await enrichResearch("full_research", QUERY, THREE_DOMAINS, sources({
      async summary(id) { calls.push(`precedent:${id}`); return id === "1" ? { text: HOLDING, excerpt: false } : undefined; },
      async decisionSummary(domain, id) {
        calls.push(`${domain}:${id}`);
        return { text: domain === "interpretation" ? "식품위생법상 조리사 자격의 해석" : HOLDING, excerpt: false };
      },
    }));
    expect(calls.sort()).toEqual(["interpretation:1", "precedent:1", "precedent:2", "tribunal:1"]);
    expect(enrichment.decisions?.["precedent:1"].rank).toBe("direct");
    expect(enrichment.decisions?.["precedent:2"].rank).toBe("unknown");
    expect(enrichment.decisions?.["interpretation:1"].rank).toBe("low");
    expect(enrichment.decisions?.["tribunal:1"].rank).toBe("direct");
    expect(enrichment.decisionExcerpts?.["tribunal:1"]).toBe(HOLDING);
    expect(enrichment.decisionExcerpts?.["precedent:2"]).toBeUndefined();
    expect(enrichment.precedents?.["1"]).toEqual(enrichment.decisions?.["precedent:1"]);
  });

  it("keeps missing or failed interpretation and tribunal bodies unknown", async () => {
    const enrichment = await enrichResearch("full_research", QUERY, THREE_DOMAINS, sources({
      async decisionSummary(domain) {
        if (domain === "tribunal") throw new Error("official source unavailable");
        return undefined;
      },
    }));
    expect(Object.values(enrichment.decisions ?? {})).toHaveLength(4);
    expect(Object.values(enrichment.decisions ?? {}).every((value) => value.rank === "unknown")).toBe(true);
    expect(enrichment.decisionExcerpts).toEqual({});
  });

  it("reads each unique ID even when another source for the same case has no body", async () => {
    const duplicated = THREE_DOMAINS.replace("2025두101", "2025두100");
    const calls: string[] = [];
    const enrichment = await enrichResearch("full_research", QUERY, duplicated, sources({
      async summary(id) { calls.push(id); return id === "2" ? { text: HOLDING, excerpt: false } : undefined; },
    }));
    expect(calls.sort()).toEqual(["1", "2"]);
    expect(enrichment.decisions?.["precedent:1"].rank).toBe("unknown");
    expect(enrichment.decisions?.["precedent:2"].rank).toBe("direct");
  });

  it("ranks retried interpretations from the official reply, not the matching title", async () => {
    const text = "═══ 종합 리서치 ═══\n▶ 법령 해석례 [NOT_FOUND / FAILED]\n   사유: [NOT_FOUND] 검색 결과가 없습니다.";
    const enrichment = await enrichResearch("full_research", QUERY, text, sources({
      async interpretations() { return [{ id: "9", title: HOLDING, caseNumber: "25-0009" }]; },
      async decisionSummary() { return { text: "식품위생법상 조리사 자격을 판단하는 기준", excerpt: false }; },
    }));
    expect(enrichment.interpretations?.entries[0].caseNumber).toBe("25-0009");
    expect(enrichment.decisions?.["interpretation:9"].rank).toBe("low");
    expect(enrichment.decisionExcerpts?.["interpretation:9"]).toBeUndefined();
  });

  it("caches official summaries by domain and ID, not by reused ID alone", async () => {
    const calls: string[] = [];
    const shared = sharedSources(sources({
      async decisionSummary(domain, id) { calls.push(`${domain}:${id}`); return { text: HOLDING, excerpt: false }; },
    }));
    await Promise.all((["interpretation", "tribunal", "interpretation"] as ResearchDecisionDomain[])
      .map((domain) => shared.decisionSummary!(domain, "1")));
    expect(calls).toEqual(["interpretation:1", "tribunal:1"]);
  });
});
