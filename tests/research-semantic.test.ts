import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchInterpretation } from "@/lib/law-research";
import { runLegalResearch } from "@/server/law-research-mcp";
import { interpretResearchQuery, verifyResearchAdoption } from "@/server/groq";
import { adoptionResponse } from "./research-adoption-fixtures";
import { ApiError } from "@/server/http";
import type * as GroqModule from "@/server/groq";

vi.mock("@/server/groq", () => ({ interpretResearchQuery: vi.fn(), verifyResearchAdoption: vi.fn() }));

const longQuery = "5년 일했는데 어제 팀장이 문자로 내일부터 나오지 말라고 했어. 두 달치 월급도 못 받았고 퇴직금도 아직 안 줬어. 이게 부당해고인지, 밀린 돈은 어떻게 받는지 알고 싶어.";
const interpretation: ResearchInterpretation = {
  original: longQuery,
  situation: "해고 통보와 임금·퇴직금 미지급 문제가 함께 있는 상황으로 이해했습니다.",
  facts: ["5년 근무", "문자로 해고 통보", "두 달치 임금 미지급", "퇴직금 미지급"],
  issues: [
    { label: "부당해고 여부", query: "부당해고" },
    { label: "임금체불", query: "임금 체불" },
    { label: "퇴직금", query: "퇴직금 지급" },
  ],
  confidence: "medium",
};
const article = (jo: string, title: string, body: string) =>
  `근로기준법\n   제${jo} (${title})\n${body}\n   시행: 2026.08.20 | 고용노동부`;
const dismissal = `═══ 종합 리서치 ═══\n▶ AI 법령검색 결과\n지능형 법령검색 결과 (법령조문, 1건):\n\n${article("0028조", "부당해고등의 구제신청",
  "사용자가 근로자에게 부당해고등을 하면 근로자는 노동위원회에 구제를 신청할 수 있다.")}\n\n[NOT_FOUND] 해석례 없음`;
const harassment = `═══ 종합 리서치 ═══\n▶ AI 법령검색 결과\n지능형 법령검색 결과 (법령조문, 1건):\n\n${article("0076조의2", "직장 내 괴롭힘의 금지",
  "사용자 또는 근로자는 직장 내 괴롭힘을 하여서는 아니 된다.")}\n\n[NOT_FOUND] 해석례 없음`;
const caseList = (id: string, title: string) => `판례 검색 결과 (총 1건, 1페이지):\n\n[${id}] ${title}\n  사건번호: 2024다${id}\n  법원: 대법원\n  선고일: 20240501\n`;
const caseText = (title: string, holding: string) => `=== ${title} ===\n판시사항:\n${holding}\n`;
const ctx = { requestId: "semantic-test" };
const mcpResponse = (text: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }));

type Call = { name: string; arguments: Record<string, unknown> };
/** Answers each law MCP tool by name; `Error` is an upstream failure, anything unanswered is NOT_FOUND. */
function upstream(tools: Partial<Record<string, (args: Record<string, unknown>) => string | Error>>) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    const call = JSON.parse(String(init.body)).params as Call;
    calls.push(call);
    const answer = tools[call.name]?.(call.arguments) ?? "[NOT_FOUND] 없음";
    return answer instanceof Error ? new Response("upstream failure", { status: 500 }) : mcpResponse(answer);
  });
  vi.stubGlobal("fetch", fetcher);
  return (name: string) => calls.filter((call) => call.name === name).map((call) => String(call.arguments.query ?? call.arguments.id));
}

beforeEach(() => {
  process.env.LAW_OC = "test-law-key";
  process.env.LAW_MCP_URL = "https://mcp.example.test/law";
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.mocked(interpretResearchQuery).mockResolvedValue(interpretation);
  vi.mocked(verifyResearchAdoption).mockResolvedValue([]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  delete process.env.LAW_OC;
  delete process.env.LAW_MCP_URL;
});

describe("full_research issue-by-issue retrieval", () => {
  it.each([
    { partial: false, chain: false }, { partial: true, chain: false },
    { partial: false, chain: true }, { partial: true, chain: true },
  ])("distinguishes display truncation from a partial original (partial=$partial, chain=$chain)", async ({ partial, chain }) => {
    const query = "근로기준법상 퇴사자 임금 지급";
    const quote = "임금은 통화로 직접 근로자에게 그 전액을 지급하여야 한다.";
    // A long MCP response exercises the display boundary without adding any retrieval.
    const body = `${quote}\n`.repeat(24) + (partial ? " …" : quote);
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({ original: query, situation: query, facts: [],
      issues: [{ label: "임금 지급", query: "임금 지급" }], confidence: "high" });
    upstream({
      legal_research: () => chain
        ? `═══ 종합 리서치 ═══\n▶ AI 법령검색 결과\n지능형 법령검색 결과 (법령조문, 1건):\n\n${article("0043조", "임금 지급", `${quote} …`)}`
        : "[NOT_FOUND] 없음",
      search_law: () => "검색 결과 (총 1건):\n\n📍 정확매칭 (1건):\n1. 근로기준법 [현행]\n   - 법령ID: 001872\n   - MST: 283457\n   - 공포일: 20260219 / 시행일: 20260820\n   - 구분: 법률",
      get_law_text: ({ jo }) => jo
        ? `법령명: 근로기준법\n공포일: 20260219\n시행일: 20260820\n제43조 임금 지급\n제43조(임금 지급)\n${body}`
        : "법령명: 근로기준법\n목차 (총 1개 조문)\n제43조 임금 지급",
    });
    const mcpFetch = globalThis.fetch;
    vi.stubEnv("GROQ_API_KEY", "long-original-regression");
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init: RequestInit) => {
      if (String(url).includes("mcp.example.test")) return mcpFetch(url, init);
      const payload = JSON.parse(String(init.body));
      const candidates = JSON.parse(payload.messages.find((message: { role: string }) => message.role === "user").content).candidates;
      const candidate = candidates.find((item: { law?: string; text: string }) => item.law === "근로기준법" && item.text.includes(body));
      return Response.json({ choices: [{ message: { content: JSON.stringify({ selections: candidate ? [{
        issueIndex: 0, candidateId: candidate.id, role: "direct", quote,
        reason: "퇴사자의 임금 지급 질문에 대해 근로자에게 임금 전액을 지급해야 하는 의무를 직접 정합니다.",
      }] : [] }) } }] });
    });
    const groq = await vi.importActual<typeof GroqModule>("@/server/groq");
    vi.mocked(verifyResearchAdoption).mockImplementationOnce(groq.verifyResearchAdoption);
    const result = await runLegalResearch({ task: "full_research", query }, ctx);
    if (!result.found) throw new Error("expected a research response");
    expect(result.evidence?.articles?.map(({ law, jo }) => ({ law, jo }))).toEqual(partial ? [] : [{ law: "근로기준법", jo: "제43조" }]);
    expect(result.evidence?.issues?.[0].status).toBe(partial ? "none" : "found");
  });

  it("searches each uncovered issue with its own short phrase and reports coverage per issue", async () => {
    const queries = upstream({
      legal_research: () => dismissal,
      search_decisions: ({ query }) => query === "임금 체불" ? caseList("501", "임금") : "[NOT_FOUND] 없음",
      get_decision_text: ({ id }) => id === "501" ? caseText("임금", "사용자가 임금을 체불한 경우 체불 임금의 지급 의무") : "[NOT_FOUND] 없음",
    });
    vi.mocked(verifyResearchAdoption).mockImplementationOnce(adoptionResponse([
      { issueIndex: 0, source: { law: "근로기준법", jo: "제28조" },
        quote: "사용자가 근로자에게 부당해고등을 하면 근로자는 노동위원회에 구제를 신청할 수 있다.",
        reason: "문자 해고를 당한 근로자가 부당해고 구제를 신청할 수 있는 절차를 직접 규정한다." },
      { issueIndex: 1, source: { precedentId: "501" },
        quote: "사용자가 임금을 체불한 경우 체불 임금의 지급 의무",
        reason: "두 달치 임금을 받지 못한 근로자에 대한 사용자의 체불임금 지급 의무를 판단한다." },
    ]));
    const result = await runLegalResearch({ task: "full_research", query: longQuery }, ctx);
    // The combined search runs with the first issue's phrase; each still
    // article-less issue then gets one chain search of its own phrase
    // (V4 M3-lite, capped) — the dismissal text adopts nothing for either,
    // so the evidence below is unchanged. The user's sentence is never a search query.
    expect(queries("legal_research")).toEqual(["부당해고", "임금 체불", "퇴직금 지급"]);
    expect(queries("search_decisions").sort()).toEqual(["임금 체불", "퇴직금 지급"]);
    expect([...queries("legal_research"), ...queries("search_decisions"), ...queries("search_law")]).not.toContain(longQuery);
    expect(result).toMatchObject({
      found: true,
      interpretation,
      evidence: {
        status: "partial",
        articles: [{ law: "근로기준법", jo: "제28조" }],
        precedents: ["501"],
        precedentEntries: { 501: { title: "임금", caseNumber: "2024다501" } },
        issues: [
          { label: "부당해고 여부", status: "found", articles: [{ law: "근로기준법", jo: "제28조" }], precedents: [] },
          { label: "임금체불", status: "found", articles: [], precedents: ["501"] },
          { label: "퇴직금", status: "none", articles: [], precedents: [] },
        ],
      },
    });
  });

  it("keeps what issue searches found when the combined search fails, and marks unconfirmed issues failed", async () => {
    upstream({
      legal_research: () => new Error("down"),
      search_decisions: ({ query }) => query === "부당해고" ? caseList("601", "부당해고구제재심판정취소")
        : query === "임금 체불" ? new Error("down") : "[NOT_FOUND] 없음",
      get_decision_text: () => caseText("부당해고구제재심판정취소", "부당해고를 당한 근로자가 노동위원회에 구제신청을 할 수 있는 요건"),
    });
    vi.mocked(verifyResearchAdoption).mockImplementationOnce(adoptionResponse([{
      issueIndex: 0, source: { precedentId: "601" },
      quote: "부당해고를 당한 근로자가 노동위원회에 구제신청을 할 수 있는 요건",
      reason: "문자로 해고된 근로자가 부당해고 구제를 신청할 수 있는 요건을 직접 판단한다.",
    }]));
    const result = await runLegalResearch({ task: "full_research", query: longQuery }, ctx);
    expect(result).toMatchObject({
      found: true, text: "",
      evidence: {
        status: "partial", searchFailed: true, precedents: ["601"],
        issues: [{ status: "found" }, { status: "failed" }, { status: "failed" }],
      },
    });
  });

  it("fails the request only when no issue could be confirmed at all", async () => {
    upstream({ legal_research: () => new Error("down"), search_decisions: () => new Error("down") });
    await expect(runLegalResearch({ task: "full_research", query: longQuery }, ctx)).rejects.toMatchObject({ code: expect.any(String) });
  });

  it("lists a source shared by two issues once while attributing it to both", async () => {
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({ ...interpretation,
      issues: [{ label: "부당해고 여부", query: "부당해고" }, { label: "구제 절차", query: "부당해고 구제" }] });
    const queries = upstream({ legal_research: () => dismissal });
    vi.mocked(verifyResearchAdoption).mockImplementationOnce(adoptionResponse([0, 1].map((issueIndex) => ({
      issueIndex, source: { law: "근로기준법", jo: "제28조" },
      quote: "사용자가 근로자에게 부당해고등을 하면 근로자는 노동위원회에 구제를 신청할 수 있다.",
      reason: "부당해고를 당한 근로자의 노동위원회 구제신청 절차와 구제 가능성을 직접 규정한다.",
    }))));
    const result = await runLegalResearch({ task: "full_research", query: longQuery }, ctx);
    const shared = { law: "근로기준법", jo: "제28조" };
    expect(result).toMatchObject({ evidence: { status: "matched", articles: [shared],
      issues: [{ status: "found", articles: [shared] }, { status: "found", articles: [shared] }] } });
    expect(queries("search_decisions")).toEqual([]);
  });

  it("retries a genuine absence once, with a keyword-short question as written but never a long one", async () => {
    const short = { ...interpretation, original: "회사에서 잘렸어", issues: [{ label: "해고의 정당성", query: "해고 정당성" }] };
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce(short);
    let first = true;
    const queries = upstream({ legal_research: () => (first ? (first = false, "[NOT_FOUND] 없음") : dismissal) });
    vi.mocked(verifyResearchAdoption).mockImplementationOnce(adoptionResponse([{
      issueIndex: 0, source: { law: "근로기준법", jo: "제28조" },
      quote: "사용자가 근로자에게 부당해고등을 하면 근로자는 노동위원회에 구제를 신청할 수 있다.",
      reason: "해고된 근로자의 정당성 다툼에 대해 노동위원회 구제신청 경로를 직접 규정한다.",
    }]));
    const result = await runLegalResearch({ task: "full_research", query: "회사에서 잘렸어" }, ctx);
    expect(queries("legal_research")).toEqual(["해고 정당성", "회사에서 잘렸어"]);
    expect(result).toMatchObject({ found: true, text: dismissal });

    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({ ...interpretation, issues: [interpretation.issues[0]] });
    const longQueries = upstream({ legal_research: () => "[NOT_FOUND] 없음" });
    await runLegalResearch({ task: "full_research", query: longQuery }, ctx);
    expect(longQueries("legal_research")).toEqual(["부당해고"]);
  });

  it("searches the unchanged question once when interpretation is unavailable", async () => {
    vi.mocked(interpretResearchQuery).mockRejectedValueOnce(new Error("unavailable"));
    const queries = upstream({ legal_research: () => harassment });
    vi.mocked(verifyResearchAdoption).mockImplementationOnce(adoptionResponse([{
      issueIndex: 0, source: { law: "근로기준법", jo: "제76조의2" },
      quote: "사용자 또는 근로자는 직장 내 괴롭힘을 하여서는 아니 된다.",
      reason: "직장 내 괴롭힘에 대해 사용자와 근로자에게 적용되는 금지 의무를 직접 규정한다.",
    }]));
    const result = await runLegalResearch({ task: "full_research", query: "직장 내 괴롭힘" }, ctx);
    expect(queries("legal_research")).toEqual(["직장 내 괴롭힘"]);
    expect(queries("search_decisions")).toEqual([]);
    expect(result).toMatchObject({ found: true, evidence: { status: "matched", issues: [{ status: "found" }] } });
    expect(result).not.toHaveProperty("interpretation");
  });

  it("retries a spoken question's absence once with its own subject terms, and verifies what returns the same way", async () => {
    vi.mocked(interpretResearchQuery).mockRejectedValueOnce(new Error("unavailable"));
    const insult = `═══ 종합 리서치 ═══\n▶ AI 법령검색 결과\n지능형 법령검색 결과 (법령조문, 1건):\n\n형법\n   제0311조 (모욕)\n공연히 사람을 모욕한 자는 1년 이하의 징역이나 금고 또는 200만원 이하의 벌금에 처한다.\n   시행: 2025.01.01 | 법무부`;
    let first = true;
    const queries = upstream({ legal_research: () => (first ? (first = false, "[NOT_FOUND] 없음") : insult) });
    const spoken = "회사에서 업무 관련해서 모욕을 당했어";
    vi.mocked(verifyResearchAdoption).mockImplementationOnce(adoptionResponse([{
      issueIndex: 0, source: { law: "형법", jo: "제311조" },
      quote: "공연히 사람을 모욕한 자는 1년 이하의 징역이나 금고 또는 200만원 이하의 벌금에 처한다.",
      reason: "업무 중 당한 사람에 대한 모욕 쟁점에 적용되는 일반 모욕죄 처벌 규정이다.",
    }]));
    const result = await runLegalResearch({ task: "full_research", query: spoken }, ctx);
    // The sentence as written, then only the words the user actually used — no legal term is invented.
    expect(queries("legal_research")).toEqual([spoken, "모욕"]);
    expect(result).toMatchObject({ found: true, evidence: { status: "matched",
      articles: [{ law: "형법", jo: "제311조" }], issues: [{ status: "found", articles: [{ law: "형법", jo: "제311조" }] }] } });
  });

  it("does not search at all when the reading found no issue to look into", async () => {
    // A vague grievance once adopted an unrelated statute (금융지주회사법 제45조의4) because the raw
    // sentence was searched and a shared word counted as a match. No issue means the follow-up is the answer.
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({ ...interpretation, issues: [],
      followUp: "어떤 부당한 일을 겪었는지 구체적으로 알려주시면 관련 법령을 찾을 수 있습니다." });
    const queries = upstream({ legal_research: () => harassment });
    const result = await runLegalResearch({ task: "full_research", query: "회사에서 부당한 일을 당했어." }, ctx);
    expect(queries("legal_research")).toEqual([]);
    expect(result).toMatchObject({ found: false, marker: "NOT_FOUND",
      interpretation: { issues: [], followUp: expect.stringContaining("구체적으로") } });
    expect(result).not.toHaveProperty("evidence");
  });

  it("names an interpretation timeout apart from other failures", async () => {
    vi.mocked(interpretResearchQuery).mockRejectedValueOnce(new ApiError("AI_TIMEOUT", "AI 응답 시간이 초과되었습니다.", 504));
    upstream({ legal_research: () => "[NOT_FOUND] 없음" });
    const result = await runLegalResearch({ task: "full_research", query: "직장 내 괴롭힘 판단 기준" }, ctx);
    expect(result).toMatchObject({ found: false, interpretationFailure: "timeout" });
  });

  it("never adopts a source the MCP did not return, however the issues are phrased", async () => {
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({ ...interpretation,
      issues: [{ label: "존재하지 않는 법령", query: "우주개발법 모욕" }] });
    upstream({ legal_research: () => "[NOT_FOUND] 없음" });
    const result = await runLegalResearch({ task: "full_research", query: longQuery }, ctx);
    expect(result).toMatchObject({ found: false, marker: "NOT_FOUND" });
    expect(result).not.toHaveProperty("evidence");
  });
});

describe("original-party adoption and issue status", () => {
  it("rejects actual loan/retirement-tax false positives without changing the wage issue", async () => {
    const query = "직원이 갑자기 무단퇴사해서 연락이 안 됨";
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({ original: query, situation: "직원 무단퇴사", facts: [query],
      issues: [
        { label: "근로계약 위반", query: "계약 위반" },
        { label: "퇴직금 지급 여부", query: "퇴직금 지급" },
        { label: "임금 지급", query: "임금 지급" },
      ], confidence: "high" });
    const loan = "계약 또는 목적물의 성질에 위반한 사용, 수익으로 인하여 생긴 손해배상의 청구와 차주가 지출한 비용의 상환청구는 대주가 물건의 반환을 받은 날로부터 6월내에 하여야 한다.";
    const executive = "(1심과 같음) 이 사건 퇴직금이 대표이사에게 실제로 지급된 것이라 보기 어려울뿐만 아니라 임원의 현실적 퇴직으로 인해 지급된 것으로 볼 수 없음";
    const text = `═══ 종합 리서치 ═══\n▶ AI 법령검색 결과\n지능형 법령검색 결과 (법령조문, 2건):\n\n민법\n   제0617조 (손해배상, 비용상환청구의 기간)\n${loan}\n   시행: 2026.03.17 | 법무부\n\n${article("0043조", "임금 지급", "임금은 통화로 직접 근로자에게 그 전액을 지급하여야 한다.")}`;
    upstream({
      legal_research: () => text,
      search_decisions: ({ query: issue }) => issue === "퇴직금 지급" ? caseList("351400", "임원의 현실적인 퇴직과 퇴직금 지급") : "[NOT_FOUND] 없음",
      get_decision_text: () => caseText("임원의 현실적인 퇴직과 퇴직금 지급", executive),
    });
    vi.mocked(verifyResearchAdoption).mockImplementationOnce(adoptionResponse([{
      issueIndex: 2, source: { law: "근로기준법", jo: "제43조" },
      quote: "임금은 통화로 직접 근로자에게 그 전액을 지급하여야 한다.",
      reason: "무단퇴사한 직원도 근로자이므로 임금 지급 의무에 직접 적용되며 대차와 임원 과세는 해당하지 않는다.",
    }]));
    const result = await runLegalResearch({ task: "full_research", query }, ctx);
    expect(result).toMatchObject({ found: true, text,
      evidence: { status: "partial", articles: [{ law: "근로기준법", jo: "제43조" }], precedents: [],
        issues: [
          { label: "근로계약 위반", status: "none", articles: [], precedents: [] },
          { label: "퇴직금 지급 여부", status: "none", articles: [], precedents: [] },
          { label: "임금 지급", status: "found", articles: [{ law: "근로기준법", jo: "제43조" }], precedents: [] },
        ] } });
    expect(verifyResearchAdoption).toHaveBeenCalledTimes(1);
    const candidates = vi.mocked(verifyResearchAdoption).mock.calls[0][2];
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "article", law: "민법", jo: "제617조" }),
      expect.objectContaining({ kind: "article", law: "근로기준법", jo: "제43조" }),
      expect.objectContaining({ kind: "precedent", precedentId: "351400" }),
    ]));
  });

  it("does not confirm a title match or a mere judgment opening as a holding", async () => {
    const query = "근로자 퇴직금 지급";
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({ original: query, situation: query, facts: [query],
      issues: [{ label: "퇴직금 지급", query: "퇴직금 지급" }], confidence: "high" });
    upstream({
      legal_research: () => "═══ 종합 리서치 ═══\n▶ 관련 판례\n" + caseList("91", "퇴직금 지급"),
      search_decisions: () => caseList("91", "퇴직금 지급"),
      get_decision_text: () => "=== 퇴직금 지급 ===\n전문:\n근로자의 퇴직금 지급을 청구한 사건이다.",
    });
    vi.mocked(verifyResearchAdoption).mockResolvedValueOnce([]);
    const result = await runLegalResearch({ task: "full_research", query }, ctx);
    expect(result).toMatchObject({ evidence: { articles: [], precedents: [], issues: [{ status: "none" }] } });
  });
  it("fails closed on final verification failure without calling it a source lookup failure", async () => {
    upstream({ legal_research: () => dismissal });
    vi.mocked(verifyResearchAdoption).mockRejectedValueOnce(new ApiError("AI_PROVIDER_UNAVAILABLE", "unavailable", 503));
    const result = await runLegalResearch({ task: "full_research", query: longQuery }, ctx);
    expect(result).toMatchObject({ found: true, text: dismissal,
      evidence: { status: "unverified", articles: [], precedents: [], issues: [
        { status: "none" }, { status: "none" }, { status: "none" },
      ] }, enrichment: { adoptionReviews: expect.arrayContaining([
        expect.objectContaining({ issueIndex: 0, verification: "unavailable", articles: expect.arrayContaining([
          expect.objectContaining({ law: "근로기준법", jo: "제28조", adopted: false }),
        ]) }),
      ]) } });
    expect(result.found && result.evidence?.searchFailed).toBeUndefined();
  });

  it.each(["민법 제617조 손해배상 기간", "민법제617조 손해배상 기간"])(
    "preserves the user's exact fetched article identity: %s", async (query) => {
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({ original: query, situation: query, facts: [],
      issues: [{ label: "손해배상 기간", query: "손해배상 기간" }], confidence: "high" });
    const body = "계약 또는 목적물의 성질에 위반한 사용, 수익으로 인하여 생긴 손해배상의 청구와 차주가 지출한 비용의 상환청구는 대주가 물건의 반환을 받은 날로부터 6월내에 하여야 한다.";
    const text = `═══ 종합 리서치 ═══\n▶ AI 법령검색 결과\n지능형 법령검색 결과 (법령조문, 1건):\n\n민법\n   제0617조 (손해배상, 비용상환청구의 기간)\n${body}\n   시행: 2026.03.17 | 법무부`;
    upstream({ legal_research: () => text });
    vi.mocked(verifyResearchAdoption).mockRejectedValueOnce(new Error("unconfigured"));
    const result = await runLegalResearch({ task: "full_research", query }, ctx);
    expect(result).toMatchObject({ evidence: { articles: [{ law: "민법", jo: "제617조" }],
      issues: [{ status: "found", articles: [{ law: "민법", jo: "제617조" }] }] },
      enrichment: { adoptionReviews: [expect.objectContaining({ issueIndex: 0, articles: expect.arrayContaining([
        expect.objectContaining({ law: "민법", jo: "제617조", role: "identity", adopted: true, excerpt: body }),
      ]) })] } });
  });

  it.each([
    "민법 제390조와 근로기준법 제617조",
    "민법 제617조의2 손해배상 기간",
    "민법 제6170조 손해배상 기간",
    "농민법 제617조 손해배상 기간",
  ])("does not grant an explicit-identity exception to a different law or article: %s", async (query) => {
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({ original: query, situation: query, facts: [],
      issues: [{ label: "손해배상 기간", query: "손해배상 기간" }], confidence: "high" });
    const body = "계약 또는 목적물의 성질에 위반한 사용, 수익으로 인하여 생긴 손해배상의 청구와 차주가 지출한 비용의 상환청구는 대주가 물건의 반환을 받은 날로부터 6월내에 하여야 한다.";
    const text = `═══ 종합 리서치 ═══\n▶ AI 법령검색 결과\n지능형 법령검색 결과 (법령조문, 1건):\n\n민법\n   제0617조 (손해배상, 비용상환청구의 기간)\n${body}\n   시행: 2026.03.17 | 법무부`;
    upstream({ legal_research: () => text });
    vi.mocked(verifyResearchAdoption).mockRejectedValueOnce(new Error("unconfigured"));
    const result = await runLegalResearch({ task: "full_research", query }, ctx);
    expect(result).toMatchObject({ evidence: { status: "unverified", articles: [], issues: [{ status: "none", articles: [] }] },
      enrichment: { adoptionReviews: [expect.objectContaining({ articles: expect.arrayContaining([
        expect.objectContaining({ law: "민법", jo: "제617조", excerpt: body, adopted: false }),
      ]) })] } });
  });

  it("uses the selected body's version rather than an unselected rendition with the same law/article", async () => {
    const query = "퇴사자 임금 지급";
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({ original: query, situation: query, facts: [],
      issues: [{ label: "임금 지급", query: "임금 지급" }], confidence: "high" });
    const current = "임금은 통화로 직접 근로자에게 그 전액을 지급하여야 하며 매월 정기적으로 지급한다.";
    const old = "임금은 통화로 직접 근로자에게 그 전액을 지급하여야 한다.";
    const text = `═══ 종합 리서치 ═══\n▶ AI 법령검색 결과\n지능형 법령검색 결과 (법령조문, 2건):\n\n${article("0043조", "임금 지급", current)}\n\n${article("0043조", "임금 지급", old).replace("2026.08.20", "2025.01.01")}`;
    upstream({ legal_research: () => text, search_law: () => "검색 결과 (총 1건):\n\n📍 정확매칭 (1건):\n1. 근로기준법 [현행]\n   - 법령ID: 001872\n   - MST: 283457\n   - 공포일: 20260219 / 시행일: 20260820\n   - 구분: 법률" });
    vi.mocked(verifyResearchAdoption).mockImplementationOnce(adoptionResponse([{
      issueIndex: 0, source: { law: "근로기준법", jo: "제43조" }, quote: current,
      reason: "퇴사자 임금 지급에 관한 사용자의 전액 지급 및 정기 지급 의무를 직접 정하는 확보 원문입니다.",
    }]));
    const result = await runLegalResearch({ task: "full_research", query }, ctx);
    expect(result).toMatchObject({ evidence: { articles: [{ law: "근로기준법", jo: "제43조", currency: "current" }] },
      enrichment: { adoptionReviews: [expect.objectContaining({ articles: expect.arrayContaining([
        expect.objectContaining({ excerpt: current, adopted: true, role: "direct", effectiveDate: "2026.08.20" }),
        expect.objectContaining({ excerpt: old, adopted: false, effectiveDate: "2025.01.01" }),
      ]) })] } });
  });
});

describe("currency of cited articles", () => {
  const lawList = (status: string, lawDate: string | null = "20260820") => `검색 결과 (총 1건):\n\n📍 정확매칭 (1건):\n1. 근로기준법 [${status}]\n   - 법령ID: 001872\n   - MST: 283457\n   - 공포일: 20260219${lawDate ? ` / 시행일: ${lawDate}` : ""}\n   - 구분: 법률`;

  const run = async (status: string | null, effective: string, lawDate?: string | null) => {
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({ ...interpretation, issues: [{ label: "직장 내 괴롭힘", query: "직장 내 괴롭힘" }] });
    upstream({
      legal_research: () => harassment.replace("2026.08.20", effective),
      search_law: () => status !== null ? lawList(status, lawDate) : "[NOT_FOUND] 없음",
    });
    vi.mocked(verifyResearchAdoption).mockImplementationOnce(adoptionResponse([{
      issueIndex: 0, source: { law: "근로기준법", jo: "제76조의2" },
      quote: "사용자 또는 근로자는 직장 내 괴롭힘을 하여서는 아니 된다.",
      reason: "직장 내 괴롭힘 쟁점에 적용되는 사용자와 근로자의 금지 의무를 직접 규정한다.",
    }]));
    return runLegalResearch({ task: "full_research", query: "직장 내 괴롭힘" }, ctx);
  };

  it.each([
    // The retrieved text is the law's current version: its 시행일 is the version's 시행일.
    ["현행", "2026.08.20", "current"],
    // A 현행 law name over a past version's body is not current: the index dates the
    // current version 2026.08.20, the retrieved text is the 2020 version.
    ["현행", "2020.01.01", "not_current"],
    ["현행", "2999.01.01", "upcoming"],
    ["폐지", "2020.01.01", "not_current"],
    [null, "2020.01.01", "unconfirmed"],
  ] as const)("law listed %s with 시행 %s is %s", async (status, effective, currency) => {
    const result = await run(status, effective);
    expect(result).toMatchObject({ evidence: { articles: [{ law: "근로기준법", jo: "제76조의2", currency }] } });
  });

  it("confirms nothing when the index states no current-version 시행일", async () => {
    const result = await run("현행", "2020.01.01", null);
    expect(result).toMatchObject({ evidence: { articles: [{ law: "근로기준법", jo: "제76조의2", currency: "unconfirmed" }] } });
  });

  it("confirms nothing when the retrieved version is newer than the indexed current version", async () => {
    // Both dates are past, so this is not 시행 예정 either: the metadata disagree.
    const result = await run("현행", "2026.09.01", "20260820");
    expect(result).toMatchObject({ evidence: { articles: [{ law: "근로기준법", jo: "제76조의2", currency: "unconfirmed" }] } });
  });

  it("treats the 시행일 day itself as in force, and the day before as upcoming", async () => {
    const kstDay = (offset: number) => new Date(Date.now() + 9 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);
    const dotted = (iso: string) => iso.replaceAll("-", ".");
    const digits = (iso: string) => iso.replaceAll("-", "");
    const today = kstDay(0);
    expect(await run("현행", dotted(today), digits(today)))
      .toMatchObject({ evidence: { articles: [{ currency: "current" }] } });
    const tomorrow = kstDay(1);
    expect(await run("현행", dotted(tomorrow), digits(tomorrow)))
      .toMatchObject({ evidence: { articles: [{ currency: "upcoming" }] } });
  });
});

describe("model selections are re-checked against the user's own words", () => {
  const lawText = (law: string, jo: string, title: string, body: string) => `${law}\n   제${jo} (${title})\n${body}\n   시행: 2026.03.17 | 법무부`;
  const chain = (...articles: string[]) => `═══ 종합 리서치 ═══\n▶ AI 법령검색 결과\n지능형 법령검색 결과 (법령조문, ${articles.length}건):\n\n${articles.join("\n\n")}`;

  it("rejects rules confined to an unmentioned special party while keeping the general rule", async () => {
    const query = "거래처 계약 불이행";
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({ original: query, situation: query, facts: [],
      issues: [{ label: "계약 불이행", query: "계약 불이행" }], confidence: "high" });
    const commission = "위탁매매인은 위탁자를 위한 매매에 관하여 상대방이 채무를 이행하지 아니하는 경우에는 위탁자에 대하여 이를 이행할 책임이 있다.";
    const offset = "계약담당자는 상대방의 계약불이행으로 인한 손해배상금ㆍ지체상금 또는 계약보증금 등을 지출액과 상계하여야 할 때에는 그 관계 서류를 관계 지출관 또는 출납공무원에게 제출하여야 한다.";
    const general = "채무자가 채무의 내용에 좇은 이행을 하지 아니한 때에는 채권자는 손해배상을 청구할 수 있다.";
    upstream({ legal_research: () => chain(
      lawText("상법", "0105조", "위탁매매인의 이행담보책임", commission),
      lawText("교도작업의 운영 및 특별회계에 관한 법률 시행규칙", "0010조", "상계", offset),
      lawText("민법", "0390조", "채무불이행과 손해배상", general)) });
    vi.mocked(verifyResearchAdoption).mockImplementationOnce(adoptionResponse([
      { issueIndex: 0, source: { law: "상법", jo: "제105조" }, quote: commission, reason: "거래 상대방이 채무를 이행하지 않을 때의 이행 책임을 직접 규정한다." },
      { issueIndex: 0, source: { law: "교도작업의 운영 및 특별회계에 관한 법률 시행규칙", jo: "제10조" }, quote: offset, role: "supporting", reason: "계약불이행으로 생긴 손해배상금과 지체상금의 처리 절차를 보충한다." },
      { issueIndex: 0, source: { law: "민법", jo: "제390조" }, quote: general, reason: "채무불이행 시 채권자의 손해배상 청구권을 정한 일반 규정이다." },
    ]));
    const result = await runLegalResearch({ task: "full_research", query }, ctx);
    expect(result).toMatchObject({ evidence: { articles: [{ law: "민법", jo: "제390조" }],
      issues: [{ status: "found", articles: [{ law: "민법", jo: "제390조" }] }] } });
    const reviewed = result.found ? result.enrichment?.adoptionReviews?.[0].articles ?? [] : [];
    expect(reviewed.filter((entry) => entry.law !== "민법").map((entry) => entry.adopted)).toEqual([false, false]);
  });

  it.each([
    ["직원이 갑자기 무단퇴사해서 연락이 안 됨", [
      ["상법", "0217조", "사원의 퇴사권", "②사원이 부득이한 사유가 있을 때에는 언제든지 퇴사할 수 있다."],
      ["일제강점하 반민족행위 진상규명에 관한 특별법", "0013조", "신분보장", "위원회 소속 직원은 형의 확정·징계처분 또는 위원회의 규정이 정하는 사유에 의하지 아니하고는 그 의사에 반하여 퇴직·휴직·강임 또는 면직을 당하지 아니한다."],
    ]],
    ["조달청 제3자를 위한 단가계약", [
      ["지방자치단체를 당사자로 하는 계약에 관한 법률", "0026조", "제3자를 위한 단가계약", "② 제3자를 위한 단가계약의 절차ㆍ기준, 그 밖에 필요한 사항은 대통령령으로 정한다."],
    ]],
    ["행정처분 취소 사유", [
      ["민사집행법", "0050조", "집행처분의 취소·일시유지", "① 제49조제1호 및 제3호의 경우에는 이미 실시한 집행처분을 취소하여야 하며, 같은 조 제2호의 경우에는 이미 실시한 집행처분을 일시적으로 유지하게 하여야 한다."],
    ]],
  ] as const)("rejects live-observed party mismatches for %s", async (query, rows) => {
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({ original: query, situation: query, facts: [],
      issues: [{ label: "쟁점", query: "쟁점 검색" }], confidence: "high" });
    upstream({ legal_research: () => chain(...rows.map(([law, jo, title, body]) => lawText(law, jo, title, body))) });
    vi.mocked(verifyResearchAdoption).mockImplementationOnce(adoptionResponse(rows.map(([law, jo, , body]) => ({
      issueIndex: 0, source: { law, jo: `제${Number(jo.replace(/\D/gu, ""))}조` }, quote: body,
      reason: "질문의 퇴사·계약 쟁점을 직접 규정하는 조문으로 판단했다는 모델 응답입니다." }))));
    const result = await runLegalResearch({ task: "full_research", query }, ctx);
    expect(result).toMatchObject({ evidence: { articles: [], issues: [{ status: "none", articles: [] }] } });
  });

  it("keeps a special-party rule when the user names that relationship", async () => {
    const query = "위탁매매 거래처 계약 불이행";
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({ original: query, situation: query, facts: [],
      issues: [{ label: "계약 불이행", query: "계약 불이행" }], confidence: "high" });
    const commission = "위탁매매인은 위탁자를 위한 매매에 관하여 상대방이 채무를 이행하지 아니하는 경우에는 위탁자에 대하여 이를 이행할 책임이 있다.";
    upstream({ legal_research: () => chain(lawText("상법", "0105조", "위탁매매인의 이행담보책임", commission)) });
    vi.mocked(verifyResearchAdoption).mockImplementationOnce(adoptionResponse([
      { issueIndex: 0, source: { law: "상법", jo: "제105조" }, quote: commission, reason: "위탁매매 상대방의 불이행 책임을 직접 규정한다." },
    ]));
    const result = await runLegalResearch({ task: "full_research", query }, ctx);
    expect(result).toMatchObject({ evidence: { articles: [{ law: "상법", jo: "제105조" }] } });
  });

  it("does not adopt a purpose clause for a question about a specific delegation", async () => {
    const query = "개인정보 보호법 시행령의 대리인 범위";
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({ original: query, situation: query, facts: [],
      issues: [{ label: "대리인 범위", query: "대리인 범위" }], confidence: "high" });
    const purpose = "이 영은 「개인정보 보호법」에서 위임된 사항과 그 시행에 필요한 사항을 규정함을 목적으로 한다.";
    const agent = "① 법 제38조에 따라 정보주체를 대리할 수 있는 자는 다음 각 호와 같다.";
    upstream({ legal_research: () => chain(
      lawText("개인정보 보호법 시행령", "0001조", "목적", purpose),
      lawText("개인정보 보호법 시행령", "0045조", "대리인의 범위 등", agent)) });
    vi.mocked(verifyResearchAdoption).mockImplementationOnce(adoptionResponse([
      { issueIndex: 0, source: { law: "개인정보 보호법 시행령", jo: "제1조" }, quote: purpose, reason: "법률이 위임한 사항을 시행령이 규정한다는 관계를 보여준다." },
      { issueIndex: 0, source: { law: "개인정보 보호법 시행령", jo: "제45조" }, quote: agent, reason: "법 제38조에 따라 정보주체를 대리할 수 있는 자의 범위를 직접 규정한다." },
    ]));
    const result = await runLegalResearch({ task: "full_research", query }, ctx);
    expect(result).toMatchObject({ evidence: { articles: [{ law: "개인정보 보호법 시행령", jo: "제45조" }] } });
  });
});
