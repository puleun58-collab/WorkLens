import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchInterpretation } from "@/lib/law-research";
import { runLegalResearch } from "@/server/law-research-mcp";
import { interpretResearchQuery } from "@/server/groq";

vi.mock("@/server/groq", () => ({ interpretResearchQuery: vi.fn() }));

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
  "직장 내 괴롭힘이란 사용자 또는 근로자가 지위 또는 관계 등의 우위를 이용하여 …")}\n\n[NOT_FOUND] 해석례 없음`;
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
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  delete process.env.LAW_OC;
  delete process.env.LAW_MCP_URL;
});

describe("full_research issue-by-issue retrieval", () => {
  it("searches each uncovered issue with its own short phrase and reports coverage per issue", async () => {
    const queries = upstream({
      legal_research: () => dismissal,
      search_decisions: ({ query }) => query === "임금 체불" ? caseList("501", "임금") : "[NOT_FOUND] 없음",
      get_decision_text: ({ id }) => id === "501" ? caseText("임금", "사용자가 임금을 체불한 경우 체불 임금의 지급 의무") : "[NOT_FOUND] 없음",
    });
    const result = await runLegalResearch({ task: "full_research", query: longQuery }, ctx);
    // The combined search runs once, with the first issue's phrase; the user's sentence is never a search query.
    expect(queries("legal_research")).toEqual(["부당해고"]);
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
      get_decision_text: () => caseText("부당해고구제재심판정취소", "부당해고 구제신청의 요건"),
    });
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
    const result = await runLegalResearch({ task: "full_research", query: "직장 내 괴롭힘" }, ctx);
    expect(queries("legal_research")).toEqual(["직장 내 괴롭힘"]);
    expect(queries("search_decisions")).toEqual([]);
    expect(result).toMatchObject({ found: true, evidence: { status: "matched", issues: [{ status: "found" }] } });
    expect(result).not.toHaveProperty("interpretation");
  });
});

describe("currency of cited articles", () => {
  const lawList = (status: string) => `검색 결과 (총 1건):\n\n📍 정확매칭 (1건):\n1. 근로기준법 [${status}]\n   - 법령ID: 001872\n   - MST: 283457\n   - 공포일: 20260219 / 시행일: 20260820\n   - 구분: 법률`;

  it.each([
    ["현행", "2020.01.01", "current"],
    ["현행", "2999.01.01", "upcoming"],
    ["폐지", "2020.01.01", "not_current"],
    [null, "2020.01.01", "unconfirmed"],
  ] as const)("law listed %s with 시행 %s is %s", async (status, effective, currency) => {
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({ ...interpretation, issues: [{ label: "직장 내 괴롭힘", query: "직장 내 괴롭힘" }] });
    upstream({
      legal_research: () => harassment.replace("2026.08.20", effective),
      search_law: () => status !== null ? lawList(status) : "[NOT_FOUND] 없음",
    });
    const result = await runLegalResearch({ task: "full_research", query: "직장 내 괴롭힘" }, ctx);
    expect(result).toMatchObject({ evidence: { articles: [{ law: "근로기준법", jo: "제76조의2", currency }] } });
  });
});
