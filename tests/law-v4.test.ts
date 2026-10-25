import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchInterpretation } from "@/lib/law-research";
import { runLegalResearch } from "@/server/law-research-mcp";
import { interpretResearchQuery } from "@/server/groq";
import { lookupIssue, type EnrichmentSources } from "@/server/research-enrichment";

vi.mock("@/server/groq", () => ({ interpretResearchQuery: vi.fn() }));

/**
 * V4 regression tests.
 * - V4-1: lookupIssue inherits the user's own question terms for title
 *   candidates (C3#2: issue "사용자 의무" lost 조치·괴롭힘, and the official
 *   TOC title of 제76조의3 contains neither surviving term).
 * - V4-2: per-issue chain retry (M3-lite) recovers an article for an issue
 *   the main chain and its lookup left article-less, capped at two retries.
 * - V4-3: lookup partial failure now covers failures inside a branch.
 */

const TOC = [
  { jo: "제13조", title: "보고, 출석의 의무" },
  { jo: "제76조의2", title: "직장 내 괴롭힘의 금지" },
  { jo: "제76조의3", title: "직장 내 괴롭힘 발생 시 조치" },
  { jo: "제100조의2", title: "부속 기숙사의 유지관리 의무" },
];
const BODIES: Record<string, string> = {
  "제76조의3": "제76조의3(직장 내 괴롭힘 발생 시 조치)\n 사용자는 직장 내 괴롭힘 발생 사실을 신고한 근로자에게 불리한 처우를 하여서는 아니 되며, 신고 내용에 대하여 조사를 실시하고 필요한 조치를 하여야 한다.",
  "제76조의2": "제76조의2(직장 내 괴롭힘의 금지)\n 사용자는 직장 내 괴롭힘을 하여서는 아니 된다.",
  "제13조": "제13조(보고, 출석의 의무)\n 사용자는 보고 또는 출석의 의무를 진다.",
  "제100조의2": "제100조의2(부속 기숙사의 유지관리 의무)\n 사용자는 부속 기숙사의 유지관리 의무를 진다.",
};

function v41Sources(): EnrichmentSources {
  return {
    async summary() { return undefined; },
    async laws(query) { return query === "근로기준법" ? [{ name: "근로기준법", mst: "285279" }] : []; },
    async toc(mst) { return mst === "285279" ? TOC : []; },
    async article(mst, jo) {
      if (mst !== "285279" || !BODIES[jo]) return undefined;
      return { name: "근로기준법", text: BODIES[jo] };
    },
    async interpretations() { return []; },
    async precedents() { return []; },
  };
}

describe("V4-1: lookup title candidates inherit the question's own subject terms", () => {
  it("finds 제76조의3 for issue '사용자 의무' only with the question terms inherited", async () => {
    const without = await lookupIssue("사용자 의무", [], v41Sources(), () => false, ["근로기준법"]);
    expect(without.articles.map((a) => a.jo)).toEqual(["제13조", "제100조의2"]);
    const withTerms = await lookupIssue("사용자 의무", [], v41Sources(), () => false, ["근로기준법"],
      ["근로기준법", "직장", "괴롭힘", "발생", "사용자", "조치", "의무"]);
    expect(withTerms.articles.map((a) => `${a.law} ${a.jo}`)).toContain("근로기준법 제76조의3");
  });
});

describe("V4-3: lookup partial failure covers failures inside a branch", () => {
  it("flags a title lookup that landed one article while another law's lookup threw", async () => {
    const sources: EnrichmentSources = {
      async summary() { return undefined; },
      async laws(query) {
        if (query === "형법") return [{ name: "형법", mst: "F" }];
        if (query === "군형법") return [{ name: "군형법", mst: "G" }];
        return [];
      },
      async toc(mst) {
        if (mst === "F") throw new Error("down");
        if (mst === "G") return [{ jo: "제65조", title: "초병 모욕" }];
        return [];
      },
      async article(mst, jo) {
        if (mst === "G" && jo === "제65조") return { name: "군형법", text: "제65조(초병 모욕)\n 초병을 모욕한 자는 처벌한다." };
        return undefined;
      },
      async interpretations() { return []; },
      async precedents() { return []; },
    };
    const lookup = await lookupIssue("모욕", [], sources, () => false, ["형법", "군형법"]);
    expect(lookup.status).toBe("found");
    expect(lookup.articles.map((a) => `${a.law} ${a.jo}`)).toEqual(["군형법 제65조"]);
    expect(lookup.partialFailure).toBe(true);
  });

  it("flags a precedent summary that threw while articles covered the issue", async () => {
    const sources: EnrichmentSources = {
      async summary() { throw new Error("down"); },
      async laws(query) { return query === "근로기준법" ? [{ name: "근로기준법", mst: "M1" }] : []; },
      async toc(mst) { return mst === "M1" ? [{ jo: "제76조의3", title: "직장 내 괴롭힘 발생 시 조치" }] : []; },
      async article(mst, jo) {
        return mst === "M1" && jo === "제76조의3" ? { name: "근로기준법", text: BODIES["제76조의3"] } : undefined;
      },
      async interpretations() { return []; },
      async precedents() { return [{ id: "701", title: "직장 내 괴롭힘 손해배상" } as never]; },
    };
    const lookup = await lookupIssue("사용자 조치 의무", [], sources, () => false, ["근로기준법"]);
    expect(lookup.status).toBe("found");
    expect(lookup.articles.map((a) => a.jo)).toEqual(["제76조의3"]);
    expect(lookup.partialFailure).toBe(true);
  });
});

describe("V4-2: per-issue chain retry (M3-lite)", () => {
  const ctx = { requestId: "law-v4-test" };
  const mcpResponse = (text: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }));
  type Call = { name: string; arguments: Record<string, unknown> };
  function upstream(tools: Partial<Record<string, (args: Record<string, unknown>) => string | Error>>) {
    const calls: Call[] = [];
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      const call = JSON.parse(String(init.body)).params as Call;
      calls.push(call);
      const answer = tools[call.name]?.(call.arguments) ?? "[NOT_FOUND] 없음";
      return answer instanceof Error ? new Response("upstream failure", { status: 500 }) : mcpResponse(answer);
    });
    vi.stubGlobal("fetch", fetcher);
    return (name: string) => calls.filter((call) => call.name === name).map((call) => call.arguments);
  }
  const mainChain = [
    "═══ 종합 리서치 ═══", "",
    "▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 1건):", "",
    "근로기준법", "   제0076조의2 (직장 내 괴롭힘의 금지)", "   제76조의2(직장 내 괴롭힘의 금지)", " 사용자 또는 근로자는 직장 내 괴롭힘을 하여서는 아니 된다.", "   시행: 2026.08.20 | 고용노동부", "",
  ].join("\n");
  const insultChain = [
    "═══ 종합 리서치 ═══", "",
    "▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 1건):", "",
    "형법", "   제0311조 (모욕)", "   제311조(모욕)", " 공연히 사람을 모욕한 자는 1년 이하의 징역이나 금고 또는 200만원 이하의 벌금에 처한다.", "   시행: 2025.01.01 | 법무부", "",
  ].join("\n");

  beforeEach(() => {
    process.env.LAW_OC = "test-law-key";
    process.env.LAW_MCP_URL = "https://mcp.example.test/law";
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete process.env.LAW_OC;
    delete process.env.LAW_MCP_URL;
  });

  it("recovers 형법 제311조 for a second issue via its own chain search, shown through the supplement", async () => {
    const question = "상사가 지속적으로 모욕하고 괴롭혀서 출근이 두려워";
    const interpretation: ResearchInterpretation = {
      original: question, situation: "", facts: [],
      issues: [
        { label: "직장 내 괴롭힘", query: "직장 내 괴롭힘" },
        { label: "모욕", query: "모욕" },
      ],
      confidence: "medium",
    };
    vi.mocked(interpretResearchQuery).mockResolvedValue(interpretation);
    const queries = upstream({
      legal_research: (args) => (args as { query?: string }).query === "모욕" ? insultChain : mainChain,
      search_law: () => "[NOT_FOUND] 없음",
      search_decisions: () => "[NOT_FOUND] 없음",
    });
    const result = await runLegalResearch({ task: "full_research", query: question }, ctx);
    expect(queries("legal_research").map((a) => (a as { query?: string }).query)).toEqual(["직장 내 괴롭힘", "모욕"]);
    expect(result).toMatchObject({
      found: true,
      evidence: {
        status: "matched",
        articles: [{ law: "근로기준법", jo: "제76조의2" }, { law: "형법", jo: "제311조" }],
        issues: [
          { label: "직장 내 괴롭힘", status: "found" },
          { label: "모욕", status: "found", articles: [{ law: "형법", jo: "제311조" }] },
        ],
      },
    });
    // The retry article must be displayable through the existing supplement path.
    const data = result as { enrichment?: { supplement?: { articles?: Array<{ law: string; jo: string }> } } };
    expect(data.enrichment?.supplement?.articles).toEqual(
      expect.arrayContaining([expect.objectContaining({ law: "형법", jo: "제311조", title: "모욕" })]));
  });

  it("retries at most two article-less issues per request", async () => {
    const question = "모욕과 명예훼손과 손해배상과 형사고소가 모두 궁금해";
    const interpretation: ResearchInterpretation = {
      original: question, situation: "", facts: [],
      issues: [
        { label: "모욕", query: "모욕" },
        { label: "명예훼손", query: "명예훼손" },
        { label: "손해배상", query: "손해배상" },
      ],
      confidence: "medium",
    };
    vi.mocked(interpretResearchQuery).mockResolvedValue(interpretation);
    const queries = upstream({
      legal_research: (args) => {
        const q = (args as { query?: string }).query;
        return q === "모욕" ? insultChain : "[NOT_FOUND] 없음";
      },
      search_law: () => "[NOT_FOUND] 없음",
      search_decisions: () => "[NOT_FOUND] 없음",
    });
    const result = await runLegalResearch({ task: "full_research", query: question }, ctx);
    // Main chain (first issue) + retries for the first two article-less issues only.
    expect(queries("legal_research")).toHaveLength(3);
    expect(result).toMatchObject({ found: true });
  });
});
