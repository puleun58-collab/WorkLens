import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLegalResearch } from "@/server/law-research-mcp";
import { interpretResearchQuery } from "@/server/groq";

vi.mock("@/server/groq", () => ({ interpretResearchQuery: vi.fn() }));
vi.mock("@/server/research-enrichment", () => ({
  mcpEnrichmentSources: () => ({}),
  enrichResearch: async () => ({}),
}));

const query = "회사에서 자꾸 저를 힘들게 하는데 어떻게 해야 하나요?";
const issue = "직장 내 괴롭힘에 대한 법적 판단 기준은 무엇인가?";
const interpretation = {
  original: query, situation: "회사에서 계속 힘든 일을 겪고 있다고 말함", issues: [issue],
  searchTerms: ["직장 내 괴롭힘", "근로기준법 제76조의2"], confidence: "medium" as const,
};
const unrelated = "═══ 종합 리서치 ═══\n▶ 관련 판례\n판례 검색 결과 (총 2건, 1페이지):\n\n[1] 손해배상\n  사건번호: 2025다1";
const relevant = "═══ 종합 리서치 ═══\n▶ AI 법령검색 결과\n지능형 법령검색 결과 (법령조문, 1건):\n\n근로기준법\n   제0076조의2 (직장 내 괴롭힘의 금지)\n직장 내 괴롭힘이란 사용자 또는 근로자가 지위 또는 관계 등의 우위를 이용하여 …\n   시행: 2026.08.20 | 고용노동부\n\n[NOT_FOUND] 해석례 없음";
const ctx = { requestId: "semantic-test" };
const mcpResponse = (text: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }));
function mcpQuery(call: unknown[]) {
  return JSON.parse(String((call[1] as RequestInit).body)).params.arguments.query as string;
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

describe("full_research semantic retrieval", () => {
  it("keeps unrelated search hits as candidates, retries once, and returns the matching raw official response", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(mcpResponse(unrelated)).mockResolvedValueOnce(mcpResponse(relevant));
    vi.stubGlobal("fetch", fetcher);
    const result = await runLegalResearch({ task: "full_research", query }, ctx);
    expect(fetcher.mock.calls.map(mcpQuery)).toEqual([issue, "직장 내 괴롭힘 근로기준법 제76조의2"]);
    expect(result).toMatchObject({ found: true, text: relevant, markers: ["NOT_FOUND"], interpretation,
      evidence: { status: "matched" } });
    expect(result.text).not.toContain(unrelated);
  });

  it("preserves multiple tentative issues and marks one-source coverage partial", async () => {
    const multiple = { ...interpretation, issues: [issue, "해고와 관련된 법적 쟁점은 무엇인가?"], confidence: "low" as const,
      uncertainty: "해고 여부가 명확하지 않음", followUp: "해고 통보를 받았나요?" };
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce(multiple);
    const fetcher = vi.fn().mockResolvedValue(mcpResponse(relevant));
    vi.stubGlobal("fetch", fetcher);
    const result = await runLegalResearch({ task: "full_research", query }, ctx);
    expect(fetcher.mock.calls.map(mcpQuery)).toEqual([multiple.issues.join(" / "), "직장 내 괴롭힘 근로기준법 제76조의2"]);
    expect(result).toMatchObject({ found: true, interpretation: multiple, evidence: { status: "partial" } });
  });

  it("retries a genuine absence, retaining the second result's original markers and text", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(mcpResponse("[NOT_FOUND] 없음")).mockResolvedValueOnce(mcpResponse(relevant));
    vi.stubGlobal("fetch", fetcher);
    const result = await runLegalResearch({ task: "full_research", query }, ctx);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ found: true, text: relevant, markers: ["NOT_FOUND"] });
  });

  it("does not replace an official candidate response with an irrelevant or failed retry", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(mcpResponse(unrelated)).mockResolvedValueOnce(mcpResponse("[NOT_FOUND] 없음"));
    vi.stubGlobal("fetch", fetcher);
    const result = await runLegalResearch({ task: "full_research", query }, ctx);
    expect(result).toMatchObject({ found: true, text: unrelated, evidence: { status: "unverified" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("falls back to the unchanged question when interpretation is unavailable", async () => {
    vi.mocked(interpretResearchQuery).mockRejectedValueOnce(new Error("unavailable"));
    const fetcher = vi.fn().mockResolvedValue(mcpResponse(unrelated));
    vi.stubGlobal("fetch", fetcher);
    const result = await runLegalResearch({ task: "full_research", query }, ctx);
    expect(fetcher.mock.calls.map(mcpQuery)).toEqual([query]);
    expect(result).toMatchObject({ found: true, text: unrelated, evidence: { status: "unverified" } });
    expect(result).not.toHaveProperty("interpretation");
  });
});
