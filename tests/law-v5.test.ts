import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchInterpretation } from "@/lib/law-research";
import { rankPrecedent, researchEvidenceSources } from "@/lib/research-relevance";
import { runLegalResearch } from "@/server/law-research-mcp";
import { interpretResearchQuery } from "@/server/groq";
import { lookupIssue, type EnrichmentSources } from "@/server/research-enrichment";

vi.mock("@/server/groq", () => ({ interpretResearchQuery: vi.fn() }));

/** Chain text shaped like the live answers: law line, numbered article lines, body, 시행 line. */
function chain(articles: Array<{ law: string; jo: string; title: string; body: string }>): string {
  const lines = ["═══ 종합 리서치 ═══", "", "▶ AI 법령검색 결과", `지능형 법령검색 결과 (법령조문, ${articles.length}건):`, ""];
  for (const article of articles) {
    lines.push(article.law, `   ${article.jo} (${article.title})`, `   ${article.jo}(${article.title})`, ` ${article.body}`, "   시행: 2025.01.01 | 법무부", "");
  }
  return lines.join("\n");
}

const INSULT_311 = { law: "형법", jo: "제311조", title: "모욕", body: "공연히 사람을 모욕한 자는 1년 이하의 징역이나 금고 또는 200만원 이하의 벌금에 처한다." };
const INSULT_105 = { law: "형법", jo: "제105조", title: "국기·국장 모욕", body: "대한민국을 모욕할 목적으로 국기 또는 국장을 손상하거나 모욕한 자는 처벌한다." };
const INSULT_109 = { law: "형법", jo: "제109조", title: "외국 사절 모욕", body: "외국 사절을 모욕한 자는 처벌한다." };
const INSULT_138 = { law: "형법", jo: "제138조", title: "법정모욕", body: "법정에서 재판 중인 판사를 모욕한 자는 처벌한다." };
const HARASS_763 = {
  law: "근로기준법", jo: "제76조의3", title: "직장 내 괴롭힘 발생 시 조치",
  body: "사용자는 직장 내 괴롭힘 발생 사실을 신고한 근로자에게 불리한 처우를 하여서는 아니 되며, 신고 내용에 대하여 조사를 실시하고 필요한 조치를 하여야 한다.",
};
const HARASS_13 = { law: "근로기준법", jo: "제13조", title: "보고, 출석의 의무", body: "사용자는 보고 또는 출석의 의무를 진다." };
const HARASS_100 = { law: "근로기준법", jo: "제100조의2", title: "부속 기숙사의 유지관리 의무", body: "사용자는 부속 기숙사의 유지관리 의무를 진다." };

describe("V5-F3a: title-subject guard (adoption only, candidates untouched)", () => {
  it("vetoes insult variants for a general insult question but keeps 제311조", () => {
    const articles = researchEvidenceSources(chain([INSULT_311, INSULT_105, INSULT_109, INSULT_138]), "모욕",
      undefined, ["회사", "동료", "모욕"]).articles;
    expect(articles).toEqual([{ law: "형법", jo: "제311조" }]);
  });

  it("keeps 법정모욕 when the question itself is about a courtroom", () => {
    const articles = researchEvidenceSources(chain([INSULT_311, INSULT_105, INSULT_138]), "모욕",
      undefined, ["법정", "재판", "판사", "모욕"]).articles;
    expect(articles).toContainEqual({ law: "형법", jo: "제311조" });
    expect(articles).toContainEqual({ law: "형법", jo: "제138조" });
    expect(articles).not.toContainEqual({ law: "형법", jo: "제105조" });
  });

  it("keeps 제76조의3 for C3 but vetoes 보고·출석 의무 and 기숙사 유지관리 의무", () => {
    const articles = researchEvidenceSources(chain([HARASS_763, HARASS_13, HARASS_100]), "사용자 조치 의무",
      undefined, ["근로기준법", "직장", "괴롭힘", "발생", "사용자", "조치", "의무"]).articles;
    expect(articles).toEqual([{ law: "근로기준법", jo: "제76조의3" }]);
  });

  it("does not guard a title that names no issue term (벌칙 keeps its body adoption)", () => {
    const info70 = { law: "정보통신망 이용촉진 및 정보보호 등에 관한 법률", jo: "제70조", title: "벌칙",
      body: "사람을 비방할 목적으로 정보통신망을 통하여 공공연하게 명예훼손을 한 자는 처벌한다." };
    expect(researchEvidenceSources(chain([info70]), "명예훼손").articles)
      .toContainEqual({ law: "정보통신망 이용촉진 및 정보보호 등에 관한 법률", jo: "제70조" });
  });
});

describe("V5-F3a-disjunction: a disjunctive title is vetoed only when no branch matches", () => {
  const text = (title: string, body: string) => [
    "═══ 종합 리서치 ═══", "", "▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 1건):", "",
    "형법", `   제138조 (${title})`, `   제138조(${title})`, ` ${body}`, "   시행: 2025.01.01 | 법무부", "",
  ].join("\n");
  it("keeps 제138조 for a 법정 모욕 issue even though its title also names 국회회의장", () => {
    expect(researchEvidenceSources(
      text("법정 또는 국회회의장모욕", "법정에서 재판 중인 판사를 모욕한 자는 처벌한다."),
      "법정 모욕", undefined, ["법정", "재판", "판사", "모욕", "공무집행방해"]))
      .toEqual({ articles: [{ law: "형법", jo: "제138조" }], precedents: [] });
  });
  it("still vetoes a disjunctive title when neither branch matches the issue", () => {
    expect(researchEvidenceSources(
      text("국기 또는 국장 모욕", "대한민국을 모욕할 목적으로 국기 또는 국장을 손상하거나 모욕한 자는 처벌한다."),
      "모욕", undefined, ["회사", "동료", "모욕"]))
      .toEqual({ articles: [], precedents: [] });
  });
});

describe("V5-F3b: strict majority", () => {
  it("does not adopt on one of two terms alone (조사 의무 vs 조사 only)", () => {
    const survey = { law: "해양과학조사법 시행령", jo: "제2조", title: "조사", body: "대한민국 영해에서의 조사에 대한 허가절차를 정한다." };
    expect(researchEvidenceSources(chain([survey]), "조사 의무").articles).toEqual([]);
  });

  it("adopts on both of two terms", () => {
    const duty = { law: "근로기준법", jo: "제13조", title: "의무", body: "사용자는 출석의 의무를 진다." };
    expect(researchEvidenceSources(chain([duty]), "사용자 의무").articles)
      .toContainEqual({ law: "근로기준법", jo: "제13조" });
  });

  it("demotes a two-term precedent match on one term from related to low", () => {
    expect(rankPrecedent(["사용자", "의무"], { title: "보고", summary: "사용자는 보고하여야 한다." }).rank).toBe("low");
    // Three terms, two matched: a strict majority, so still related.
    expect(rankPrecedent(["사용자", "조치", "의무"], { title: "보고", summary: "사용자는 보고의 의무를 진다." }).rank).toBe("related");
    expect(rankPrecedent(["사용자", "조치", "의무"], { title: "보고", summary: "사용자는 보고하여야 한다." }).rank).toBe("low");
  });
});

describe("V5-F1b: subject-less issues are judged against the request's subjects", () => {
  const request = ["직장", "괴롭힘", "발생", "조사", "의무", "피해자", "보호", "가해자", "조치"];
  it("adopts 제76조의3 for 조사 의무 via the request subjects", () => {
    expect(researchEvidenceSources(chain([HARASS_763]), "조사 의무", undefined, request).articles)
      .toContainEqual({ law: "근로기준법", jo: "제76조의3" });
  });

  it("does not adopt a 조사-only article that names no request subject", () => {
    const survey = { law: "해양과학조사법 시행령", jo: "제2조", title: "조사", body: "영해에서의 조사를 실시한다." };
    expect(researchEvidenceSources(chain([survey]), "조사 의무", undefined, request).articles).toEqual([]);
  });

  it("does not adopt on subjects alone: the issue term itself must anchor", () => {
    const ban = { law: "근로기준법", jo: "제76조의2", title: "직장 내 괴롭힘의 금지",
      body: "사용자 또는 근로자는 직장 내 괴롭힘을 하여서는 아니 된다." };
    expect(researchEvidenceSources(chain([ban]), "조사 의무", undefined, request).articles).toEqual([]);
  });

  it("falls back to the issue-only rule when the request names no subject", () => {
    // With no request subject, the domain rule cannot apply, so the issue-only
    // rule decides: both terms present adopts, one term alone does not.
    const duty = { law: "근로기준법", jo: "제13조", title: "의무", body: "사용자는 출석의 의무를 진다." };
    expect(researchEvidenceSources(chain([duty]), "사용자 의무", undefined, []).articles)
      .toContainEqual({ law: "근로기준법", jo: "제13조" });
    const survey = { law: "해양과학조사법 시행령", jo: "제2조", title: "조사", body: "조사 의무를 진다." };
    expect(researchEvidenceSources(chain([survey]), "조사 의무", undefined, []).articles)
      .toContainEqual({ law: "해양과학조사법 시행령", jo: "제2조" });
    const surveyOnly = { law: "해양과학조사법 시행령", jo: "제2조", title: "조사", body: "영해에서의 조사를 실시한다." };
    expect(researchEvidenceSources(chain([surveyOnly]), "조사 의무", undefined, []).articles).toEqual([]);
  });

  it("does not let a subject-less rule leak into a subject-bearing issue", () => {
    // 모욕 has a subject, so 명예훼손 (a sibling subject) must not confirm it.
    expect(researchEvidenceSources(chain([{
      law: "형법", jo: "제307조", title: "명예훼손",
      body: "공연히 사실을 적시하여 사람의 명예를 훼손한 자는 처벌한다.",
    }]), "모욕", undefined, ["모욕", "명예훼손"]).articles).toEqual([]);
  });

  it("adopts a defamation-damages precedent and drops a damages-word-only one", () => {
    const enrichment = {
      precedents: {
        "607241": { rank: "direct" as const, matched: ["손해배상"] },
        "624793": { rank: "direct" as const, matched: ["손해배상"] },
      },
      precedentExcerpts: {
        "607241": "명예훼손으로 인한 손해배상을 청구할 수 있다.",
        "624793": "자발적인 퇴임 합의에 따라 수령한 금원은 손해배상이라 볼 수 없고 소득세법의 사례금에 해당한다.",
      },
    };
    expect(researchEvidenceSources("", "손해배상", enrichment, ["명예훼손", "손해배상"]).precedents)
      .toEqual(["607241"]);
  });
});

describe("V5-F7: an article with no excerpt text is never adopted", () => {
  it("does not adopt a title-only supplement article with an empty excerpt", () => {
    expect(researchEvidenceSources("", "모욕", {
      supplement: { status: "found", articles: [{ law: "형법", jo: "제311조", title: "모욕", excerpt: "", matched: ["모욕"] }] },
    }).articles).toEqual([]);
  });
});

describe("V5-F7: per-issue status situations through runLegalResearch", () => {
  const ctx = { requestId: "law-v5-test" };
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
  const caseText = (title: string, holding: string) => `=== ${title} ===\n판시사항:\n${holding}\n`;

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

  it("direct article only → found/matched; direct precedent only → found/matched (not ignored for lack of articles)", async () => {
    const question = "회사에서 모욕을 당했어";
    const interpretation: ResearchInterpretation = {
      original: question, situation: "", facts: [],
      issues: [{ label: "모욕", query: "모욕" }],
      confidence: "medium",
    };
    vi.mocked(interpretResearchQuery).mockResolvedValue(interpretation);
    const articleChain = chain([INSULT_311]);
    const queries = upstream({
      legal_research: () => articleChain,
      search_law: () => "[NOT_FOUND] 없음",
      search_decisions: () => "[NOT_FOUND] 없음",
    });
    const byArticle = await runLegalResearch({ task: "full_research", query: question }, ctx);
    expect(byArticle).toMatchObject({ found: true,
      evidence: { status: "matched", issues: [{ label: "모욕", status: "found", articles: [{ law: "형법", jo: "제311조" }] }] } });
    expect(queries("legal_research")).toHaveLength(1);

    vi.mocked(interpretResearchQuery).mockResolvedValue(interpretation);
    const precedentChain = [
      "═══ 종합 리서치 ═══", "", "▶ 관련 판례", "판례 검색 결과 (총 1건, 1페이지):", "",
      "[701] 모욕 손해배상", "  사건번호: 2024다701", "  법원: 대법원", "  선고일: 20240501", "",
    ].join("\n");
    upstream({
      legal_research: () => precedentChain,
      get_decision_text: () => caseText("모욕 손해배상", "공연히 사람을 모욕한 경우 손해배상책임이 인정되는 요건"),
      search_law: () => "[NOT_FOUND] 없음",
      search_decisions: () => "[NOT_FOUND] 없음",
    });
    const byPrecedent = await runLegalResearch({ task: "full_research", query: question }, ctx);
    expect(byPrecedent).toMatchObject({ found: true,
      evidence: { status: "matched", issues: [{ label: "모욕", status: "found", precedents: ["701"] }] } });
  });

  it("direct article + related precedent together → found/matched with both kept (neither drops the other)", async () => {
    const question = "회사에서 모욕을 당했어";
    vi.mocked(interpretResearchQuery).mockResolvedValue({
      original: question, situation: "", facts: [],
      issues: [{ label: "모욕", query: "모욕" }],
      confidence: "medium",
    });
    const mixedChain = [
      chain([INSULT_311]),
      "▶ 관련 판례", "판례 검색 결과 (총 1건, 1페이지):", "",
      "[701] 모욕 손해배상", "  사건번호: 2024다701", "  법원: 대법원", "  선고일: 20240501", "",
    ].join("\n");
    upstream({
      legal_research: () => mixedChain,
      get_decision_text: () => caseText("모욕 손해배상", "공연히 사람을 모욕한 경우 손해배상책임이 인정되는 요건"),
      search_law: () => "[NOT_FOUND] 없음",
      search_decisions: () => "[NOT_FOUND] 없음",
    });
    const result = await runLegalResearch({ task: "full_research", query: question }, ctx);
    expect(result).toMatchObject({ found: true,
      evidence: { status: "matched",
        issues: [{ label: "모욕", status: "found", articles: [{ law: "형법", jo: "제311조" }], precedents: ["701"] }] } });
  });

  it("irrelevant-only (insult variants) → none, not found: the guard removes a false confirmation", async () => {
    const question = "회사에서 동료에게 모욕을 당했어";
    vi.mocked(interpretResearchQuery).mockResolvedValue({
      original: question, situation: "", facts: [],
      issues: [{ label: "모욕", query: "모욕" }],
      confidence: "medium",
    });
    upstream({
      legal_research: () => chain([INSULT_105, INSULT_109]),
      search_law: () => "[NOT_FOUND] 없음",
      search_decisions: () => "[NOT_FOUND] 없음",
    });
    const result = await runLegalResearch({ task: "full_research", query: question }, ctx);
    expect(result).toMatchObject({ found: true,
      evidence: { status: "unverified", issues: [{ label: "모욕", status: "none", articles: [] }] } });
  });

  it("reference-only (a candidate that addresses nothing) → none", async () => {
    const question = "직장 내 괴롭힘 판단 기준";
    vi.mocked(interpretResearchQuery).mockResolvedValue({
      original: question, situation: "", facts: [],
      issues: [{ label: "직장 내 괴롭힘", query: "직장 내 괴롭힘" }],
      confidence: "medium",
    });
    upstream({
      legal_research: () => chain([{ law: "상업등기규칙", jo: "제69조", title: "사용자등록",
        body: "사용자등록의 신청은 본점 소재지에서 하며 신청인은 서류 제출의무를 진다." }]),
      search_law: () => "[NOT_FOUND] 없음",
      search_decisions: () => "[NOT_FOUND] 없음",
    });
    const result = await runLegalResearch({ task: "full_research", query: question }, ctx);
    expect(result).toMatchObject({ found: true,
      evidence: { issues: [{ label: "직장 내 괴롭힘", status: "none" }] } });
  });

  it("zero results → NOT_FOUND; some issues only → partial", async () => {
    const question = "모욕과 명예훼손이 궁금해";
    vi.mocked(interpretResearchQuery).mockResolvedValue({
      original: question, situation: "", facts: [],
      issues: [{ label: "모욕", query: "모욕" }, { label: "명예훼손", query: "명예훼손" }],
      confidence: "medium",
    });
    upstream({ legal_research: () => "[NOT_FOUND] 없음" });
    const absent = await runLegalResearch({ task: "full_research", query: question }, ctx);
    expect(absent).toMatchObject({ found: false, marker: "NOT_FOUND" });

    vi.mocked(interpretResearchQuery).mockResolvedValue({
      original: question, situation: "", facts: [],
      issues: [{ label: "모욕", query: "모욕" }, { label: "명예훼손", query: "명예훼손" }],
      confidence: "medium",
    });
    upstream({
      legal_research: () => chain([INSULT_311]),
      search_law: () => "[NOT_FOUND] 없음",
      search_decisions: () => "[NOT_FOUND] 없음",
    });
    const partial = await runLegalResearch({ task: "full_research", query: question }, ctx);
    expect(partial).toMatchObject({ found: true,
      evidence: { status: "partial",
        issues: [{ label: "모욕", status: "found" }, { label: "명예훼손", status: "none" }] } });
  });

  it("a fully failed combined search throws instead of confirming nothing", async () => {
    const question = "직장 내 괴롭힘";
    vi.mocked(interpretResearchQuery).mockResolvedValue({
      original: question, situation: "", facts: [],
      issues: [{ label: "직장 내 괴롭힘", query: "직장 내 괴롭힘" }],
      confidence: "medium",
    });
    upstream({ legal_research: () => new Error("down") });
    await expect(runLegalResearch({ task: "full_research", query: question }, ctx)).rejects.toThrow();
  });

  it("law branch failed while precedents covered the issue → found with lookupPartial", async () => {
    const sources: EnrichmentSources = {
      async summary() { return { text: "공연히 사람을 모욕한 경우 손해배상책임이 인정되는 요건", excerpt: false }; },
      async laws() { throw new Error("down"); },
      async toc() { return []; },
      async article() { return undefined; },
      async interpretations() { return []; },
      async precedents() { return [{ id: "701", title: "모욕 손해배상" } as never]; },
    };
    const lookup = await lookupIssue("모욕", [], sources, () => false, []);
    expect(lookup.status).toBe("found");
    expect(lookup.precedents.map((hit) => hit.id)).toEqual(["701"]);
    expect(lookup.partialFailure).toBe(true);
  });
});

describe("V5: chain supplement partial failure survives the merge", () => {
  const ctx = { requestId: "law-v5-supplement" };
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
    return calls;
  }
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

  it("keeps partialFailure on the merged supplement", async () => {
    const question = "근로기준법상 직장 내 괴롭힘 발생 시 사용자의 조치 의무는 무엇인가?";
    vi.mocked(interpretResearchQuery).mockResolvedValue({
      original: question, situation: "", facts: [],
      issues: [{ label: "직장 내 괴롭힘 조치 의무", query: "사용자 조치 의무" }],
      confidence: "medium",
    });
    const precedentChain = [
      "═══ 종합 리서치 ═══", "", "▶ 관련 판례", "판례 검색 결과 (총 1건, 1페이지):", "",
      "[701] 직장 내 괴롭힘 손해배상", "  사건번호: 2024다701", "  법원: 대법원", "  선고일: 20240501", "",
    ].join("\n");
    upstream({
      legal_research: () => precedentChain,
      get_decision_text: () => "=== 직장 내 괴롭힘 손해배상 ===\n판시사항:\n사용자가 직장 내 괴롭힘에 대해 필요한 조치를 하지 않은 경우 손해배상책임이 인정되는 요건\n",
      // The main chain is enriched for the first issue's phrase ("사용자 조치 의무"),
      // so the law lookups that matter are the issue-term ones: one law lands an
      // article, the other law's table of contents throws.
      search_law: (args) => {
        const query = (args as { query?: string }).query ?? "";
        if (query === "사용자") return "검색 결과 (총 2건):\n\n📍 정확매칭 (2건):\n1. 사용자보호법 [현행]\n   - 법령ID: 001872\n   - MST: M1\n   - 공포일: 20260219 / 시행일: 20260820\n   - 구분: 법률\n2. 사용자법 [현행]\n   - 법령ID: 009999\n   - MST: X1\n   - 공포일: 20200101 / 시행일: 20200101\n   - 구분: 법률";
        return "[NOT_FOUND] 없음";
      },
      get_law_text: (args) => {
        const { mst, jo } = args as { mst?: string; jo?: string };
        if (mst === "X1") return new Error("down");
        if (mst === "M1" && !jo) return "법령명: 사용자보호법\n\n목차 (총 1개 조문)\n제76조의3 직장 내 괴롭힘 발생 시 조치";
        if (mst === "M1" && jo) return "법령명: 사용자보호법\n\n제76조의3(직장 내 괴롭힘 발생 시 조치)\n 사용자는 직장 내 괴롭힘 발생 사실을 신고한 근로자에게 불리한 처우를 하여서는 아니 되며 필요한 조치를 하여야 한다.";
        return "[NOT_FOUND] 없음";
      },
      search_decisions: () => "[NOT_FOUND] 없음",
    });
    const result = await runLegalResearch({ task: "full_research", query: question }, ctx);
    expect(result).toMatchObject({ found: true,
      evidence: { status: "matched", issues: [{ label: "직장 내 괴롭힘 조치 의무", status: "found" }] } });
    const data = result as { enrichment?: { supplement?: { partialFailure?: boolean; articles?: Array<{ jo: string }> } } };
    expect(data.enrichment?.supplement?.partialFailure).toBe(true);
    expect(data.enrichment?.supplement?.articles?.map((article) => article.jo)).toContain("제76조의3");
  });
});

describe("V5 perf: a per-issue retry chain skips precedent summaries", () => {
  const ctx = { requestId: "law-v5-retry" };
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

  it("reads the main chain's precedent summary but not the retry chain's", async () => {
    const question = "상사가 지속적으로 모욕하고 괴롭혀서 출근이 두려워";
    vi.mocked(interpretResearchQuery).mockResolvedValue({
      original: question, situation: "", facts: [],
      issues: [
        { label: "직장 내 괴롭힘", query: "직장 내 괴롭힘" },
        { label: "모욕", query: "모욕" },
      ],
      confidence: "medium",
    });
    const mainChain = [
      "═══ 종합 리서치 ═══", "",
      "▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 1건):", "",
      "근로기준법", "   제0076조의2 (직장 내 괴롭힘의 금지)", "   제76조의2(직장 내 괴롭힘의 금지)", " 사용자 또는 근로자는 직장 내 괴롭힘을 하여서는 아니 된다.", "   시행: 2026.08.20 | 고용노동부", "",
      "▶ 관련 판례", "판례 검색 결과 (총 1건, 1페이지):", "",
      "[701] 직장 내 괴롭힘 손해배상", "  사건번호: 2024다701", "  법원: 대법원", "  선고일: 20240501", "",
    ].join("\n");
    const retryChain = [
      "═══ 종합 리서치 ═══", "",
      "▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 1건):", "",
      "형법", "   제0311조 (모욕)", "   제311조(모욕)", " 공연히 사람을 모욕한 자는 1년 이하의 징역이나 금고 또는 200만원 이하의 벌금에 처한다.", "   시행: 2025.01.01 | 법무부", "",
      "▶ 관련 판례", "판례 검색 결과 (총 1건, 1페이지):", "",
      "[702] 모욕 손해배상", "  사건번호: 2024다702", "  법원: 대법원", "  선고일: 20240501", "",
    ].join("\n");
    const queries = upstream({
      legal_research: (args) => (args as { query?: string }).query === "모욕" ? retryChain : mainChain,
      get_decision_text: (args) => {
        const id = (args as { id?: string }).id;
        return id === "701"
          ? "=== 직장 내 괴롭힘 손해배상 ===\n판시사항:\n직장 내 괴롭힘으로 인한 사용자의 손해배상책임이 인정되는 요건\n"
          : "=== 모욕 손해배상 ===\n판시사항:\n공연히 사람을 모욕한 경우 손해배상책임이 인정되는 요건\n";
      },
      search_law: () => "[NOT_FOUND] 없음",
      search_decisions: () => "[NOT_FOUND] 없음",
    });
    const result = await runLegalResearch({ task: "full_research", query: question }, ctx);
    expect(result).toMatchObject({ found: true,
      evidence: { status: "matched",
        issues: [{ label: "직장 내 괴롭힘", status: "found" },
          { label: "모욕", status: "found", articles: [{ law: "형법", jo: "제311조" }] }] } });
    const decisionTexts = queries("get_decision_text");
    expect(decisionTexts).toHaveLength(1);
    expect(JSON.stringify(decisionTexts[0])).toContain("701");
  });
});
