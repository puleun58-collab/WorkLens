import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchInterpretation } from "@/lib/law-research";
import { researchEvidenceSources } from "@/lib/research-relevance";
import { runLegalResearch } from "@/server/law-research-mcp";
import { interpretResearchQuery } from "@/server/groq";
import { lookupIssue, type EnrichmentSources } from "@/server/research-enrichment";

vi.mock("@/server/groq", () => ({ interpretResearchQuery: vi.fn() }));

/** Chain text shaped like the live B (명예훼손) answer: 307조 is present, but its body splits the compound. */
const DEFAMATION_CHAIN = [
  "═══ 종합 리서치 ═══", "",
  "▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 2건):", "",
  "형법", "   제0307조 (명예훼손)", "   제307조(명예훼손)", " ①공연히 사실을 적시하여 사람의 명예를 훼손한 자는 2년 이하의 징역이나 금고 또는 500만원 이하의 벌금에 처한다.",
  " ②공연히 허위의 사실을 적시하여 사람의 명예를 훼손한 자는 5년 이하의 징역, 10년 이하의 자격정지 또는 1천만원 이하의 벌금에 처한다.", "   시행: 2025.01.01 | 법무부", "",
  "정보통신망 이용촉진 및 정보보호 등에 관한 법률", "   제0070조 (벌칙)", "   제70조(벌칙)", " 사람을 비방할 목적으로 정보통신망을 통하여 공공연하게 거짓의 사실을 드러내어 다른 사람의 명예를 훼손한 자는 7년 이하의 징역, 10년 이하의 자격정지 또는 5천만원 이하의 벌금에 처한다.", "   시행: 2025.01.01 | 과학기술정보통신부", "",
].join("\n");

const PARTIAL_TITLE_CHAIN = [
  "═══ 종합 리서치 ═══", "",
  "▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 1건):", "",
  "정보통신망 이용촉진 및 정보보호 등에 관한 법률", "   제0044조의7 (명예훼손분쟁조정부)", "   제44조의7(명예훼손분쟁조정부)", " 분쟁조정부의 구성과 운영에 관한 사항을 정한다.", "   시행: 2025.01.01 | 과학기술정보통신부", "",
].join("\n");

function fakeLookupSources(overrides: Partial<EnrichmentSources> = {}): EnrichmentSources & { calls: string[] } {
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

describe("F1 M1: an already-parsed article title is adoption evidence under the anchored standard", () => {
  it("adopts 형법 제307조 for 명예훼손 when only its title carries the compound term", () => {
    expect(researchEvidenceSources(DEFAMATION_CHAIN, "명예훼손").articles)
      .toContainEqual({ law: "형법", jo: "제307조" });
  });

  it("does not promote a partial title: 명예훼손 inside 명예훼손분쟁조정부 is a modifier, not the word", () => {
    expect(researchEvidenceSources(PARTIAL_TITLE_CHAIN, "명예훼손").articles).toEqual([]);
  });

  it("does not let a generic title adopt an article whose body also misses the term", () => {
    const generic = DEFAMATION_CHAIN.replace("사람의 명예를 훼손한 자는 2년", "사람에 대하여 거짓을 퍼뜨린 자는 2년")
      .replace("사람의 명예를 훼손한 자는 5년", "사람에 대하여 거짓을 퍼뜨린 자는 5년");
    // The 벌칙 article's body still carries 명예를 훼손한, so only the 307조 title case is removed here:
    // assert the 307조 article itself is not adopted once both its body and title signals are gone.
    const noSignal = generic.replace("제0307조 (명예훼손)", "제0307조 (벌칙)").replace("제307조(명예훼손)", "제307조(벌칙)");
    expect(researchEvidenceSources(noSignal, "명예훼손").articles)
      .not.toContainEqual({ law: "형법", jo: "제307조" });
  });

  it("keeps the compound guard: 사용자 inside 사용자등록 (title or body) still adopts nothing", () => {
    const registry = [
      "═══ 종합 리서치 ═══", "",
      "▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 1건):", "",
      "상업등기규칙", "   제0069조 (사용자등록)", "   제69조(사용자등록)", " 사용자등록의 신청은 본점 소재지에서 하며 신청인은 서류 제출의무를 진다.", "   시행: 2025.01.01 | 법무부", "",
    ].join("\n");
    expect(researchEvidenceSources(registry, "사용자 의무").articles).toEqual([]);
  });

  it("applies the same title rule to supplement articles from the official lookup", () => {
    expect(researchEvidenceSources("", "명예훼손", {
      supplement: { status: "found", articles: [{
        law: "형법", jo: "제307조", title: "명예훼손",
        excerpt: "공연히 사실을 적시하여 사람의 명예를 훼손한 자는 처벌한다.", matched: ["명예훼손"],
      }] },
    }).articles).toContainEqual({ law: "형법", jo: "제307조" });
  });
});

describe("F1 M2: the supplement gate is articles==0, regardless of precedents", () => {
  const ctx = { requestId: "f7-f1-f3-test" };
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
  const lawList = () => "검색 결과 (총 1건):\n\n📍 정확매칭 (1건):\n1. 근로기준법 [현행]\n   - 법령ID: 001872\n   - MST: M1\n   - 공포일: 20260219 / 시행일: 20260820\n   - 구분: 법률";
  const toc = () => "법령명: 근로기준법\n\n목차 (총 1개 조문)\n제76조의3 직장 내 괴롭힘 발생 시 조치";
  const articleText = () => "법령명: 근로기준법\n\n제76조의3(직장 내 괴롭힘 발생 시 조치)\n 사용자는 직장 내 괴롭힘 발생 사실을 신고한 근로자에게 불리한 처우를 하여서는 아니 되며 필요한 조치를 하여야 한다.";
  const caseText = (title: string, holding: string) => `=== ${title} ===\n판시사항:\n${holding}\n`;
  const question = "근로기준법상 직장 내 괴롭힘 발생 시 사용자의 조치 의무는 무엇인가?";
  const interpretation: ResearchInterpretation = {
    original: question,
    situation: "직장 내 괴롭힘 조치 의무를 묻는 상황으로 이해했습니다.",
    facts: ["직장 내 괴롭힘", "사용자 조치 의무"],
    issues: [{ label: "직장 내 괴롭힘 조치 의무", query: "사용자 조치 의무" }],
    confidence: "medium",
  };
  // Chain: one precedent covers the issue, no article does — the old gate (articles==0 && precedents==0) never ran lookup.
  const chain = [
    "═══ 종합 리서치 ═══", "",
    "▶ 관련 판례", "판례 검색 결과 (총 1건, 1페이지):", "",
    "[701] 직장 내 괴롭힘 손해배상", "  사건번호: 2024다701", "  법원: 대법원", "  선고일: 20240501", "",
  ].join("\n");

  beforeEach(() => {
    process.env.LAW_OC = "test-law-key";
    process.env.LAW_MCP_URL = "https://mcp.example.test/law";
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.mocked(interpretResearchQuery).mockResolvedValue(interpretation);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete process.env.LAW_OC;
    delete process.env.LAW_MCP_URL;
  });

  it("runs the supplement lookup for an issue covered only by a precedent, and adopts 제76조의3 via the question's law name", async () => {
    const queries = upstream({
      legal_research: () => chain,
      get_decision_text: () => caseText("직장 내 괴롭힘 손해배상", "사용자가 직장 내 괴롭힘에 대해 필요한 조치를 하지 않은 경우 손해배상책임이 인정되는 요건"),
      search_law: () => lawList(),
      get_law_text: (args) => (args as { jo?: string }).jo ? articleText() : toc(),
      search_decisions: () => "[NOT_FOUND] 없음",
    });
    const result = await runLegalResearch({ task: "full_research", query: question }, ctx);
    expect(queries("get_law_text").length).toBeGreaterThan(0);
    expect(result).toMatchObject({
      found: true,
      evidence: {
        articles: [{ law: "근로기준법", jo: "제76조의3" }],
        issues: [{ label: "직장 내 괴롭힘 조치 의무", status: "found", articles: [{ law: "근로기준법", jo: "제76조의3" }] }],
      },
    });
  });

  it("surfaces a lookup partial failure on the issue while the server status stays matched", async () => {
    const queries = upstream({
      legal_research: () => chain,
      get_decision_text: () => caseText("직장 내 괴롭힘 손해배상", "사용자가 직장 내 괴롭힘에 대해 필요한 조치를 하지 않은 경우 손해배상책임이 인정되는 요건"),
      search_law: () => lawList(),
      get_law_text: (args) => (args as { jo?: string }).jo ? articleText() : toc(),
      search_decisions: () => new Error("down"),
    });
    const result = await runLegalResearch({ task: "full_research", query: question }, ctx);
    expect(queries("get_law_text").length).toBeGreaterThan(0);
    expect(result).toMatchObject({
      evidence: {
        // The server status is unchanged: only the UI notice (lookupPartial) demotes the display to partial.
        status: "matched",
        issues: [{ lookupPartial: true, status: "found", articles: [{ law: "근로기준법", jo: "제76조의3" }] }],
      },
    });
  });

  it("keeps the old behaviour when the chain already adopted an article: no issue lookup runs", async () => {
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({
      ...interpretation,
      issues: [{ label: "직장 내 괴롭힘 금지", query: "직장 내 괴롭힘" }],
    });
    const chainWithArticle = [
      "═══ 종합 리서치 ═══", "",
      "▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 1건):", "",
      "근로기준법", "   제0076조의2 (직장 내 괴롭힘의 금지)", "   제76조의2(직장 내 괴롭힘의 금지)", " 사용자 또는 근로자는 직장 내 괴롭힘을 하여서는 아니 된다.", "   시행: 2026.08.20 | 고용노동부", "",
    ].join("\n");
    const queries = upstream({
      legal_research: () => chainWithArticle,
      search_law: () => lawList(),
      get_law_text: (args) => (args as { jo?: string }).jo ? articleText() : toc(),
      search_decisions: () => "[NOT_FOUND] 없음",
    });
    const result = await runLegalResearch({ task: "full_research", query: question }, ctx);
    // The chain supplement is not an issue lookup: with the question's law name
    // inherited (law-supplement-trace), its toc + article lookups still run for
    // the display-only reference even when the chain already adopted an article.
    // What must not run is the issue lookup itself: no precedent search.
    // The supplement article is then judged by the unchanged adoption logic:
    // 제76조의3's title and excerpt genuinely carry the issue's subject terms
    // (직장 내 괴롭힘), so it is adopted as evidence — unlike B4, where a
    // generic-only supplement article is not promoted.
    expect(queries("search_decisions")).toEqual([]);
    expect(result).toMatchObject({
      evidence: { articles: [{ law: "근로기준법", jo: "제76조의2" }, { law: "근로기준법", jo: "제76조의3" }] },
      enrichment: { supplement: { articles: [{ law: "근로기준법", jo: "제76조의3" }] } },
    });
  });
});

describe("F7 lookup partial failure: a failed branch must not vanish when the other branch covers the issue", () => {
  it("flags a lookup whose precedent search failed but whose statute lookup found an article", async () => {
    const sources = fakeLookupSources({
      async precedents() { throw new Error("down"); },
    });
    const lookup = await lookupIssue("사용자 조치 의무", [], sources, () => false, ["근로기준법"]);
    expect(lookup.status).toBe("found");
    expect(lookup.articles.map((article) => `${article.law} ${article.jo}`)).toEqual(["근로기준법 제76조의3"]);
    expect(lookup.partialFailure).toBe(true);
  });

  it("does not flag a lookup where both branches answered", async () => {
    const lookup = await lookupIssue("사용자 조치 의무", [], fakeLookupSources(), () => false, ["근로기준법"]);
    expect(lookup.status).toBe("found");
    expect(lookup.partialFailure).toBeFalsy();
  });
});
