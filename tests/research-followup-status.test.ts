import { describe, expect, it } from "vitest";
import { retrieveResearchFollowup } from "../src/server/research-followup";
import type { EnrichmentSources } from "../src/server/research-enrichment";

function sources(overrides: Partial<EnrichmentSources> = {}): EnrichmentSources {
  return {
    async summary() { return undefined; },
    async laws(name) { return [{ name, mst: name }]; },
    async toc() { return []; },
    async article(_mst, jo) { return { text: `${jo}(수수료)\n수수료는 대통령령으로 정한다.` }; },
    async interpretations() { return []; },
    async precedents() { return []; },
    ...overrides,
  };
}

const query = "예시법 제8조와 시행령 관계";

describe("followup attempted evidence versus unread limits", () => {
  it("reports an exhausted stage as not searched, retaining limited audit without missing evidence", async () => {
    let ticks = 0;
    let calls = 0;
    const result = await retrieveResearchFollowup("law_system", query, "", undefined,
      sources({ async laws() { calls++; return []; } }), [], () => ticks++ ? 15_000 : 0);
    expect(calls).toBe(0);
    expect(result.report).toMatchObject({ status: "not-searched", attempted: 0, failed: 0, missing: 0, limited: true });
    expect(result.report.unavailable).toContainEqual({ type: "법령", name: "예시법", reason: "limited" });
  });

  it("keeps a normal attempted empty law search separate from an MCP failure", async () => {
    const empty = await retrieveResearchFollowup("law_system", query, "", undefined,
      sources({ async laws() { return []; } }), [], () => 0);
    expect(empty.report).toMatchObject({ status: "partial", failed: 0, missing: 1, limited: false });
    expect(empty.report.attempted).toBeGreaterThan(0);
    expect(empty.report.unavailable).toContainEqual({ type: "법령", name: "예시법", reason: "not-found" });
    const failed = await retrieveResearchFollowup("law_system", query, "", undefined,
      sources({ async laws() { throw new Error("MCP unavailable"); } }), [], () => 0);
    expect(failed.report).toMatchObject({ status: "failed", missing: 1, limited: false });
    expect(failed.report.failed).toBe(failed.report.attempted);
    expect(failed.report.unavailable).toContainEqual({ type: "법령", name: "예시법", reason: "failed" });
  });

  it("does not call a skipped article missing when the budget expires between admission guards", async () => {
    let articleGuard = false;
    let guardChecks = 0;
    let reads = 0;
    const result = await retrieveResearchFollowup("law_system", query, "", undefined, sources({
      async laws(name) { articleGuard = true; return [{ name, mst: name }]; },
      async article() { reads++; return undefined; },
    }), [], () => !articleGuard ? 0 : ++guardChecks === 1 ? 14_999 : 15_000);
    expect(reads).toBe(0);
    expect(result.report).toMatchObject({ status: "partial", attempted: 1, failed: 0, missing: 0, limited: true });
    expect(result.report.unavailable).toContainEqual({ type: "조문", name: "예시법 제8조", reason: "limited" });
  });

  it("does not classify an unread subordinate law or TOC as not-found", async () => {
    let expired = false;
    const lowerSkipped = await retrieveResearchFollowup("law_system", query, "", undefined, sources({
      async article(_mst, jo) { expired = true; return { text: `${jo}(수수료)\n수수료는 대통령령으로 정한다.` }; },
    }), [], () => expired ? 15_000 : 0);
    expect(lowerSkipped.report).toMatchObject({ missing: 0, limited: true });
    expect(lowerSkipped.report.unavailable).toContainEqual({ type: "법령", name: "예시법 시행령", reason: "limited" });
    expired = false;
    const tocSkipped = await retrieveResearchFollowup("law_system", query, "", undefined, sources({
      async laws(name) { if (name.endsWith("시행령")) expired = true; return [{ name, mst: name }]; },
    }), [], () => expired ? 15_000 : 0);
    expect(tocSkipped.report).toMatchObject({ missing: 0, limited: true });
    expect(tocSkipped.report.unavailable).toContainEqual({ type: "법령", name: "예시법 시행령 목차", reason: "limited" });
  });

  it("preserves actual article and TOC failures as attempted unavailable reads", async () => {
    const article = await retrieveResearchFollowup("law_system", query, "", undefined,
      sources({ async article() { return undefined; } }), [], () => 0);
    expect(article.report).toMatchObject({ missing: 1, failed: 0, limited: false });
    expect(article.report.unavailable).toContainEqual({ type: "조문", name: "예시법 제8조", reason: "not-found" });
    const toc = await retrieveResearchFollowup("law_system", query, "", undefined,
      sources({ async toc() { throw new Error("MCP timeout"); } }), [], () => 0);
    expect(toc.report).toMatchObject({ status: "partial", missing: 1, failed: 1, limited: false });
    expect(toc.report.unavailable).toContainEqual({ type: "법령", name: "예시법 시행령 목차", reason: "failed" });
  });

  it("keeps a successfully fetched irrelevant candidate out of adopted evidence without inventing a retrieval gap", async () => {
    const result = await retrieveResearchFollowup("law_system", query, "", undefined, sources({
      async toc() { return [{ jo: "제9조", title: "수수료" }]; },
      async article(mst, jo) { return { text: `${jo}(수수료)\n${mst.endsWith("시행령") ? "법 제7조에 따라 수수료를 정한다." : "수수료는 대통령령으로 정한다."}` }; },
    }), [], () => 0);
    expect(result.articles.map((article) => article.jo)).toEqual(["제8조"]);
    expect(result.report).toMatchObject({ status: "complete", missing: 0, failed: 0, limited: false });
  });

  it("reports complete retrieval when every requested source succeeds", async () => {
    const result = await retrieveResearchFollowup("law_system", query, "", undefined, sources({
      async toc() { return [{ jo: "제9조", title: "수수료" }]; },
      async article(mst, jo) { return { text: `${jo}(수수료)\n${mst.endsWith("시행령") ? "법 제8조에 따라 수수료를 정한다." : "수수료는 대통령령으로 정한다."}` }; },
    }), [], () => 0);
    expect(result.articles.map((article) => article.jo)).toEqual(["제8조", "제9조"]);
    expect(result.report).toMatchObject({ status: "complete", missing: 0, failed: 0, limited: false });
    expect(result.report.unavailable).toBeUndefined();
  });
});
