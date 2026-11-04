import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validatedSearchDirections } from "@/lib/research-search-plan";
import { researchCandidateWindows } from "@/lib/research-candidate-window";
import { planResearchSearches, verifyResearchAdoption } from "@/server/groq";
import type { ResearchAdoptionCandidate } from "@/lib/research-relevance";

beforeEach(() => { process.env.GROQ_API_KEY = "private-key"; vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete process.env.GROQ_API_KEY; });
const issue = { label: "임금 지급", query: "임금 체불" };
const direction = { issueIndex: 0, direction: "obligation", query: "임금 지급 의무", reason: "위반 명칭이 아니라 사용자의 지급 의무를 탐색" };
const completion = (payload: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(payload) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });

describe("bounded legal discovery directions", () => {
  it("keeps separate issues linked to one deduplicated search and never invents statute identities", () => {
    const directions = validatedSearchDirections("월급이 지급되지 않음", [issue, { query: "지급 요구" }], { searches: [direction,
      { ...direction, issueIndex: 1, query: "임금  지급 의무" }, { ...direction, query: "근로기준법 제43조" }] });
    expect(directions).toEqual([direction]);
    expect(validatedSearchDirections("근로기준법 제43조 지급 원칙", [issue], { searches: [{ ...direction, query: "근로기준법 제43조" }] })).toEqual([{ ...direction, query: "근로기준법 제43조" }]);
  });
  it("never adds a search for an invented issue or more than three directions", () => {
    expect(validatedSearchDirections("임금", [issue], { searches: [{ ...direction, issueIndex: 5 }] })).toEqual([]);
    expect(() => validatedSearchDirections("임금", [issue], { searches: Array(4).fill(direction) })).toThrow();
  });
  it("preserves a planner failure as a failure, rather than fabricated directions or retries", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(planResearchSearches("월급 미지급", [issue], { requestId: "search-failure" })).rejects.toMatchObject({ code: "AI_NOT_CONFIGURED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("accepts valid discovery queries but never logs their text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({ searches: [direction] })));
    await expect(planResearchSearches("PRIVATE 월급 미지급", [issue], { requestId: "search-plan" })).resolves.toEqual([direction]);
    const logs = JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(logs).not.toContain("PRIVATE");
    expect(logs).not.toContain(direction.query);
    expect(logs).not.toContain("private-key");
  });
});

describe("official candidate evidence budget", () => {
  const original: ResearchAdoptionCandidate[] = Array.from({ length: 8 }, (_, index) => ({ id: `c${index}`, kind: "article", stage: "issue", law: "근로기준법", jo: `제${index + 1}조`,
    text: `${"부수적인 긴 공식 문단입니다.\n".repeat(80)}사용자는 근로자에게 임금을 매월 정해진 날짜에 직접 지급하여야 한다.\n${"후속 문단입니다.\n".repeat(80)}` }));
  it("does not let the first two long originals hide every later candidate", () => {
    const views = researchCandidateWindows("월급이 지급되지 않음", [issue], original, 10000, 5000);
    expect(views.map(view => view.id)).toEqual(original.map(candidate => candidate.id));
    expect(views.reduce((n, view) => n + view.text.length, 0)).toBeLessThanOrEqual(10000);
    for (const view of views) {
      expect(view.text).toContain("임금을 매월 정해진 날짜에 직접 지급");
      expect(view.window).toBeDefined();
      expect(view.text).toBe(original.find(candidate => candidate.id === view.id)!.text.slice(view.window!.start, view.window!.end));
    }
  });
  it("only accepts verbatim legal content actually inside the visible window, and records coverage", async () => {
    const views = researchCandidateWindows("월급이 지급되지 않음", [issue], original, 10000, 5000);
    const last = views.at(-1)!;
    const quote = "사용자는 근로자에게 임금을 매월 정해진 날짜에 직접 지급하여야 한다.";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({ selections: [{ issueIndex: 0, candidateId: last.id, role: "direct", quote, reason: "사용자의 근로자에 대한 임금 지급 의무가 원문의 미지급 쟁점에 직접 대응한다." }] })));
    const coverage = vi.fn();
    const result = await verifyResearchAdoption("월급이 지급되지 않음", [issue], original, { requestId: "late-evidence", onAdoptionCoverage: coverage });
    expect(result).toMatchObject([{ candidateId: last.id, quote, window: last.window }]);
    expect(coverage).toHaveBeenCalledWith(original.map(candidate => candidate.id));
  });
  it("never promotes a partial original even if a model supplies a plausible quotation", () => {
    expect(researchCandidateWindows("임금", [issue], [{ ...original[0], partial: true }], 10000, 5000)).toEqual([]);
  });
});
