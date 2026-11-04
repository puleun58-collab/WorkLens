import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchEnrichment } from "@/lib/research-relevance";
import { runLegalResearch } from "@/server/law-research-mcp";
import { interpretResearchQuery, verifyResearchAdoption } from "@/server/groq";
import { callLawTool } from "@/server/law-mcp";
import { enrichResearch, type EnrichmentSources } from "@/server/research-enrichment";
import type * as EnrichmentModule from "@/server/research-enrichment";

vi.mock("@/server/groq", () => ({ interpretResearchQuery: vi.fn(), planResearchSearches: vi.fn().mockResolvedValue([]), verifyResearchAdoption: vi.fn() }));
vi.mock("@/server/law-mcp", () => ({ callLawTool: vi.fn(), searchLaw: vi.fn() }));
vi.mock("@/server/research-enrichment", async (importOriginal) => {
  const actual = await importOriginal<typeof EnrichmentModule>();
  return { ...actual, enrichResearch: vi.fn(), lookupIssue: vi.fn(async () => ({ status: "none", articles: [], precedents: [] })),
    rereadShownArticles: vi.fn(async () => []), mcpEnrichmentSources: vi.fn(() => ({
      summary: vi.fn(async () => ({ text: precedentBody, excerpt: false })),
      laws: vi.fn(async () => []), toc: vi.fn(async () => []), article: vi.fn(async () => undefined),
      interpretations: vi.fn(async () => []), precedents: vi.fn(async () => []),
    })) };
});

const precedentBody = "근로자의 채무불이행에 따른 손해배상책임은 실제 손해의 발생과 인과관계가 인정되는 경우에 성립한다.";
const interpretationBody = "개인정보처리자는 정보주체의 열람 요구에 대하여 정당한 사유 없이 그 열람을 제한하여서는 아니 됩니다.";
const tribunalBody = "처분청은 영업정지 처분의 구체적인 사유와 근거를 당사자에게 제시하여야 한다.";
const constitutionalBody = "기본권을 제한하는 입법은 목적의 정당성과 수단의 적합성 및 침해의 최소성을 갖추어야 한다.";
const chain = "═══ 종합 리서치 ═══\n▶ 관련 판례\n판례 검색 결과 (총 1건, 1페이지):\n\n[1] 손해배상\n  사건번호: 2025다1\n  법원: 대법원\n\n▶ 법령 해석례\n해석례 검색 결과 (총 1건, 1페이지):\n\n[1] 개인정보 열람 요구\n  해석례번호: 25-0001\n  해석기관: 법제처\n\n▶ 행정심판례\n행정심판례 검색 결과 (총 1건, 1페이지):\n\n[1] 영업정지 취소\n  사건번호: 2025-00001\n  재결청: 중앙행정심판위원회\n\n▶ 헌재 결정례\n결정례 검색 결과 (총 1건, 1페이지):\n\n[1] 기본권 제한\n  사건번호: 2025헌마1\n";
const original = "직원에 대한 손해배상, 개인정보 열람, 영업정지 취소와 기본권 제한의 요건을 알고 싶어";
const issues = [
  { label: "근로자 손해배상", query: "근로계약 손해배상" },
  { label: "개인정보 열람", query: "개인정보 열람" },
  { label: "영업정지 취소", query: "영업정지 취소" },
  { label: "기본권 제한", query: "기본권 제한" },
];
const originals: NonNullable<ResearchEnrichment["decisionOriginals"]> = {
  "precedent:1": { domain: "precedent", id: "1", title: "손해배상", body: "대법원", text: precedentBody, partial: false },
  "interpretation:1": { domain: "interpretation", id: "1", title: "개인정보 열람 요구", body: "법제처", text: interpretationBody, partial: false },
  "tribunal:1": { domain: "tribunal", id: "1", title: "영업정지 취소", body: "중앙행정심판위원회", text: tribunalBody, partial: false },
  "constitutional:1": { domain: "constitutional", id: "1", title: "기본권 제한", body: "헌법재판소", text: constitutionalBody, partial: false },
};
const context = { requestId: "domain-adoption-test" };

beforeEach(() => {
  vi.mocked(interpretResearchQuery).mockResolvedValue({ original, situation: "여러 법률 쟁점을 확인하는 상황으로 이해했습니다.", facts: [], issues, confidence: "medium" });
  vi.mocked(callLawTool).mockResolvedValue({ text: chain, isError: false });
  vi.mocked(enrichResearch).mockResolvedValue({ decisionOriginals: originals,
    decisions: Object.fromEntries(Object.keys(originals).map((key) => [key, { rank: "low", matched: [] }])) });
  vi.mocked(verifyResearchAdoption).mockResolvedValue([]);
});
afterEach(() => { vi.clearAllMocks(); });

function select(keys: ReadonlyArray<{ key: string; issueIndex: number; role: "direct" | "supporting" }>) {
  vi.mocked(verifyResearchAdoption).mockImplementationOnce(async (_query, _issues, candidates) => keys.map((selection) => {
    const candidate = candidates.find((candidate) => candidate.decisionKey === selection.key)!;
    expect(candidate).toBeDefined();
    return { issueIndex: selection.issueIndex, candidateId: candidate.id, role: selection.role, quote: candidate.text,
      reason: selection.role === "supporting"
        ? "원질문에 필요한 관련 절차이나 이 자료만으로 핵심 규율의 충족 여부가 확인되는 것은 아니므로 보충자료로 보존합니다."
        : "원질문의 해당 쟁점과 의무 주체 및 규율 대상이 일치하는 실제 확보 판결·결정의 본문이므로 직접근거입니다." };
  }));
}

describe("domain-scoped decision evidence and status", () => {
  it("keeps identical numeric IDs separate across four domains and counts only direct issues", async () => {
    select([{ key: "precedent:1", issueIndex: 0, role: "direct" },
      { key: "interpretation:1", issueIndex: 1, role: "supporting" },
      { key: "admin_appeal:1", issueIndex: 2, role: "direct" }]);
    const result = await runLegalResearch({ task: "full_research", query: original }, context);
    expect(result).toMatchObject({ evidence: { status: "partial", precedents: ["1"],
      decisions: ["interpretation:1", "admin_appeal:1"], issues: [
        { status: "found", precedents: ["1"] },
        { status: "none", precedents: [], decisions: ["interpretation:1"] },
        { status: "found", precedents: [], decisions: ["admin_appeal:1"] },
        { status: "none", precedents: [] },
      ] } });
    const candidates = vi.mocked(verifyResearchAdoption).mock.calls[0][2];
    expect(new Set(candidates.map((candidate) => candidate.decisionKey))).toEqual(new Set([
      "precedent:1", "interpretation:1", "admin_appeal:1", "constitutional:1",
    ]));
    expect(new Set(candidates.map((candidate) => candidate.id)).size).toBe(4);
    expect(result.found && result.enrichment?.adoptionReviews?.[3].decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "constitutional:1", domain: "constitutional", excerpt: constitutionalBody, adopted: false }),
    ]));
  });

  it("allows a direct non-precedent decision to confirm an unnamed-law issue without polluting precedents", async () => {
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({ original: "행정청 취소 사유", situation: "행정청의 취소 사유를 검토하는 상황으로 이해했습니다.", facts: [], issues: [issues[2]], confidence: "high" });
    select([{ key: "admin_appeal:1", issueIndex: 0, role: "direct" }]);
    const result = await runLegalResearch({ task: "full_research", query: "행정청 취소 사유" }, context);
    expect(result).toMatchObject({ evidence: { status: "matched", precedents: [], decisions: ["admin_appeal:1"],
      issues: [{ status: "found", precedents: [], decisions: ["admin_appeal:1"] }] } });
  });

  it("keeps an interpretation as supporting material without confirming the issue", async () => {
    vi.mocked(interpretResearchQuery).mockResolvedValueOnce({ original, situation: original, facts: [], issues: [issues[1]], confidence: "high" });
    select([{ key: "interpretation:1", issueIndex: 0, role: "supporting" }]);
    expect(await runLegalResearch({ task: "full_research", query: original }, context)).toMatchObject({
      evidence: { status: "unverified", precedents: [], decisions: ["interpretation:1"], issues: [{ status: "none" }] },
    });
  });

  it("does not reuse old direct ranks after verification fails", async () => {
    vi.mocked(verifyResearchAdoption).mockRejectedValueOnce(new Error("unavailable"));
    const result = await runLegalResearch({ task: "full_research", query: original }, context);
    expect(result).toMatchObject({ evidence: { status: "unverified", precedents: [], issues: issues.map(() => ({ status: "none" })) },
      enrichment: { adoptionReviews: issues.map((issue, issueIndex) => expect.objectContaining({ query: issue.query, issueIndex, verification: "unavailable" })) } });
    expect(result.found && result.evidence?.decisions).toBeUndefined();
  });
});

describe("already-supplied decision originals", () => {
  it("reads constitutional reasons without making a new summary request", async () => {
    const actual = await vi.importActual<typeof EnrichmentModule>("@/server/research-enrichment");
    const sources: EnrichmentSources = { summary: vi.fn(async () => undefined), decisionSummary: vi.fn(async () => undefined),
      laws: vi.fn(async () => []), toc: vi.fn(async () => []), article: vi.fn(async () => undefined),
      interpretations: vi.fn(async () => []), precedents: vi.fn(async () => []) };
    const text = `═══ 종합 리서치 ═══\n▶ 헌재 결정례 상세\n[99] 기본권 제한\n=== 기본권 제한 ===\n결정요지:\n[1] ${constitutionalBody}\n[2] 기본권 제한의 비례성을 판단하여야 한다.`;
    const result = await actual.enrichResearch("full_research", "기본권 제한", text, sources, undefined,
      { skipPrecedentSummaries: true, skipInterpretationRetry: true });
    expect(result.decisionOriginals?.["constitutional:99"]).toMatchObject({ domain: "constitutional", id: "99", text: expect.stringContaining(constitutionalBody), partial: false });
    expect(result.decisionOriginals?.["constitutional:1"]).toBeUndefined();
    expect(sources.summary).not.toHaveBeenCalled();
    expect(sources.decisionSummary).not.toHaveBeenCalled();
  });
});
