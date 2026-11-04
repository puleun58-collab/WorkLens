import { describe, expect, it, vi } from "vitest";
import { researchEvidenceSources, type SupplementArticle } from "@/lib/research-relevance";
import { articleExcerpt, lookupIssue, mcpEnrichmentSources, rereadShownArticles, sharedSources, type EnrichmentSources } from "@/server/research-enrichment";
import { getLawText } from "@/server/law-mcp";

vi.mock("@/server/law-mcp", () => ({ getLawText: vi.fn(), searchLaw: vi.fn() }));

// Synthetic offline fixtures exercise allocation and source identity, not any
// particular law, article number, or live legal conclusion.
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

const LAW = "사업안전법";
const VERSION = "20260101";

function regime(overrides: Partial<EnrichmentSources> = {}): EnrichmentSources {
  return sources({
    async laws(query) { return query === LAW ? [{ name: LAW, mst: "source-a", effectiveDate: VERSION }] : []; },
    async toc() {
      return [
        { jo: "제11조", title: "유해물질 반출" },
        { jo: "제12조", title: "유해물질 반출 제한" },
        { jo: "제13조", title: "유해물질 반출 확인" },
        { jo: "제21조", title: "사업자의 준수사항" },
      ];
    },
    async article(_mst, jo) {
      return { name: LAW, effectiveDate: VERSION, text: `${jo}(사업자의 준수사항)\n사업자는 유해물질 반출을 방지하여야 한다.` };
    },
    ...overrides,
  });
}

function supplement(articles: SupplementArticle[]) {
  return { supplement: { status: "found" as const, articles } };
}

describe("bounded issue candidate recall", () => {
  it("uses an existing article slot for a body obligation hidden behind a different title", async () => {
    const article = vi.fn(regime().article);
    const precedents = vi.fn(async () => []);
    const lookup = await lookupIssue("유해물질 반출", [], regime({ article, precedents }), () => false,
      [LAW], [], [], { direction: "obligation", query: "사업자 유해물질 준수 의무" });
    expect(lookup.articles.some((item) => item.jo === "제21조")).toBe(true);
    expect(lookup.articles).toHaveLength(3);
    expect(article).toHaveBeenCalledTimes(3);
    expect(precedents).toHaveBeenCalledTimes(1);
    expect(precedents).toHaveBeenCalledWith("사업자 유해물질 준수 의무");
    expect(lookup.articles.find((item) => item.jo === "제21조")?.original).toContain("사업자는 유해물질 반출을 방지하여야 한다");
    expect(researchEvidenceSources("", "유해물질 반출", supplement(lookup.articles)).articles.length).toBeGreaterThan(0);
    // Directional discovery never confirms another issue or relationship.
    expect(researchEvidenceSources("", "소비자 환불", supplement(lookup.articles)).articles).toEqual([]);
  });

  it("does not discover a generic obligation from an unnamed unrelated regime", async () => {
    const article = vi.fn(async () => ({ text: "제21조(준수사항)\n사업자는 보고하여야 한다." }));
    const lookup = await lookupIssue("유해물질 반출", [], sources({
      async laws() { return [{ name: "별도지원법", mst: "unrelated" }]; },
      async toc() { return [{ jo: "제21조", title: "준수사항" }]; }, article,
    }), () => false, [], [], [], { direction: "obligation" });
    expect(lookup.status).toBe("none");
    expect(lookup.articles).toEqual([]);
    expect(article).not.toHaveBeenCalled();
  });

  it("allocates the three article slots across named laws rather than the longest first TOC", async () => {
    const secondLaw = "시설안전법";
    const lookup = await lookupIssue("유해물질 반출", [], regime({
      async laws(query) { return [LAW, secondLaw].includes(query) ? [{ name: query, mst: query }] : []; },
      async article(mst, jo) { return { name: mst, text: `${jo}(유해물질 반출)\n유해물질 반출을 제한한다.` }; },
    }), () => false, [LAW, secondLaw]);
    expect(lookup.articles).toHaveLength(3);
    expect(new Set(lookup.articles.map((item) => item.law))).toEqual(new Set([LAW, secondLaw]));
  });

  it("accepts official MST bodies with optional date headers absent and retains the index version", async () => {
    const lookup = await lookupIssue("유해물질 반출", [], regime({
      async article(_mst, jo) { return { name: LAW, text: `${jo}(유해물질 반출)\\n사업자는 유해물질 반출을 통제한다.` }; },
    }), () => false, [LAW]);
    expect(lookup.status).toBe("found");
    expect(lookup.partialFailure).toBeUndefined();
    expect(lookup.articles).toHaveLength(3);
    expect(lookup.articles.every((article) => article.effectiveDate === VERSION)).toBe(true);
  });

  it("does not hide a failed article lookup, and rejects a mismatched version without calling it an outage", async () => {
    const failed = await lookupIssue("유해물질 반출", [], regime({ async article() { throw new Error("unavailable"); } }), () => false, [LAW]);
    expect(failed.status).toBe("failed");
    expect(failed.articles).toEqual([]);
    const stale = await lookupIssue("유해물질 반출", [], regime({
      async article(_mst, jo) { return { name: LAW, effectiveDate: "20250101", text: `${jo}(유해물질 반출)\n다른 버전` }; },
    }), () => false, [LAW]);
    expect(stale.status).toBe("none");
    expect(stale.articles).toEqual([]);
  });

  it("bounds law-index requests even when all search terms return zero results", async () => {
    const laws = vi.fn(async () => []);
    const article = vi.fn(async () => undefined);
    const lookup = await lookupIssue("유해물질 반출", [], sources({ laws, article }), () => false,
      [], ["환경오염", "시설관리", "보관방법", "운송사업", "산업단지", "안전교육", "저장시설", "폐기물", "수질오염"]);
    expect(laws).toHaveBeenCalledTimes(8);
    expect(article).not.toHaveBeenCalled();
    expect(lookup).toEqual({ status: "none", articles: [], precedents: [] });
  });

  it("does not transfer the question's explicit delegation article to a separate subject issue", async () => {
    const lookup = await lookupIssue("소비자 환불", [], regime({
      async article(_mst, jo) { return { name: LAW, effectiveDate: VERSION, text: `${jo}(위임)\\n대통령령으로 정하는 사항` }; },
    }), () => false, [LAW], [LAW, "제21조", "시행령", "관계"]);
    expect(lookup.articles).toEqual([]);
    expect(lookup.status).toBe("none");
  });

  it("retains timeout incompleteness when a sibling article already landed", async () => {
    let elapsed = false;
    const lookup = await lookupIssue("유해물질 반출", [], regime({
      async article(_mst, jo) {
        elapsed = true;
        return { name: LAW, effectiveDate: VERSION, text: `${jo}(유해물질 반출)\n사업자는 유해물질을 통제하여야 한다.` };
      },
    }), () => elapsed, [LAW]);
    expect(lookup.status).toBe("found");
    expect(lookup.partialFailure).toBe(true);
  });
});

describe("official primary body rereads", () => {
  it("focuses display on a late issue clause while preserving the fetched original", async () => {
    const body = `제21조(사업자의 준수사항)\n① ${"일반적인 보관 기록을 작성한다. ".repeat(70)}\n② 사업자는 유해물질 반출을 방지하여야 한다.`;
    const article = vi.fn(async () => ({ name: LAW, text: body, effectiveDate: VERSION }));
    const shared = sharedSources(regime({ article }));
    const primary = [{ law: LAW, jo: "제21조", title: "사업자의 준수사항", effectiveDate: VERSION }];
    const reread = await rereadShownArticles([...primary, ...primary], ["유해물질", "반출"], shared, () => false, 2, { includeUnmatched: true });
    expect(reread).toHaveLength(1);
    expect(reread[0].excerpt).toContain("유해물질 반출을 방지하여야 한다");
    expect(reread[0].original).toBe(body);
    expect(researchEvidenceSources("", "유해물질 반출", supplement(reread)).articles).toEqual([{ law: LAW, jo: "제21조" }]);
    await shared.article("source-a", "제21조");
    expect(article).toHaveBeenCalledTimes(1);
  });

  it("rejects a misdirected law and a primary version mismatch with explicit diagnostics", async () => {
    const incomplete = vi.fn();
    for (const fetched of [
      { name: "별도지원법", effectiveDate: VERSION, text: "제21조(준수사항)\n유해물질 반출" },
      { name: LAW, effectiveDate: "20250101", text: "제21조(준수사항)\n유해물질 반출" },
    ]) {
      const reread = await rereadShownArticles([{ law: LAW, jo: "제21조", effectiveDate: VERSION }], ["반출"],
        regime({ async article() { return fetched; } }), () => false, 2, { includeUnmatched: true, onIncomplete: incomplete });
      expect(reread).toEqual([]);
    }
    expect(incomplete.mock.calls).toEqual([["identity_mismatch"], ["identity_mismatch"]]);
  });

  it("does not claim a displayed version when neither index nor body identifies that version", async () => {
    const incomplete = vi.fn();
    const reread = await rereadShownArticles([{ law: LAW, jo: "제21조", effectiveDate: VERSION }], ["반출"], sources({
      async laws() { return [{ name: LAW, mst: "source-a" }]; },
      async article() { return { name: LAW, text: "제21조(준수사항)\\n유해물질 반출을 방지한다." }; },
    }), () => false, 2, { includeUnmatched: true, onIncomplete: incomplete });
    expect(reread).toEqual([]);
    expect(incomplete).toHaveBeenCalledWith("identity_mismatch");
  });

  it("surfaces reread errors and budget exhaustion instead of treating them as absent sources", async () => {
    const primary = [{ law: LAW, jo: "제21조" }];
    const failed = vi.fn();
    expect(await rereadShownArticles(primary, ["반출"], regime({
      async article() { throw new Error("unavailable"); },
    }), () => false, 2, { includeUnmatched: true, onIncomplete: failed })).toEqual([]);
    expect(failed).toHaveBeenCalledWith("failed");
    const timedOut = vi.fn();
    expect(await rereadShownArticles(primary, ["반출"], regime(), () => true, 2,
      { includeUnmatched: true, onIncomplete: timedOut })).toEqual([]);
    expect(timedOut).toHaveBeenCalledWith("timeout");
  });

  it("never attributes the next article body to the requested provision", () => {
    expect(articleExcerpt("제21조(준수사항)\n보관한다.\n제22조(환불)\n소비자 환불 의무", "제21조", ["환불"]))
      .toBe("보관한다.");
  });

  it("reuses a complete official law obtained by the TOC request without fabricating another article", async () => {
    const text = "제21조(준수사항)\n사업자는 유해물질 반출을 통제한다.\n제22조(통지)\n사업자는 통지하여야 한다.";
    vi.mocked(getLawText).mockResolvedValueOnce({ found: true, mode: "full", name: LAW, effectiveDate: VERSION, text });
    const official = mcpEnrichmentSources({ requestId: "candidate-recall-offline" });
    expect(await official.toc("source-a")).toEqual([{ jo: "제21조", title: "준수사항" }, { jo: "제22조", title: "통지" }]);
    expect(await official.article("source-a", "제21조")).toEqual(expect.objectContaining({
      name: LAW, effectiveDate: VERSION, text: "제21조(준수사항)\n사업자는 유해물질 반출을 통제한다.",
    }));
    expect(await official.article("source-a", "제99조")).toBeUndefined();
    expect(getLawText).toHaveBeenCalledTimes(1);
  });

  it("shares equivalent article handles and precedent detail handles once per request", async () => {
    const article = vi.fn(async () => undefined);
    const summary = vi.fn(async () => ({ text: "공식 요지", excerpt: false }));
    const domainSummary = vi.fn(async () => undefined);
    const shared = sharedSources(sources({ article, summary, decisionSummary: domainSummary }));
    expect(sharedSources(shared)).toBe(shared);
    await Promise.all([shared.article("source-a", "제 21 조"), shared.article("source-a", "제21조"),
      shared.summary("case-a"), shared.decisionSummary!("precedent", "case-a")]);
    expect(article).toHaveBeenCalledTimes(1);
    expect(article).toHaveBeenCalledWith("source-a", "제21조");
    expect(summary).toHaveBeenCalledTimes(1);
    expect(summary).toHaveBeenCalledWith("case-a");
    expect(domainSummary).not.toHaveBeenCalled();
  });
});
