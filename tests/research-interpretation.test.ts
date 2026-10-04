import { afterEach, describe, expect, it, vi } from "vitest";
import { interpretResearchQuery } from "@/server/groq";

const query = "전세금을 아직 받지 못했습니다";
const proposal = {
  situation: "전세 보증금을 돌려받지 못한 상황으로 이해했습니다.", facts: ["전세금 미반환"],
  issues: [{ label: "보증금 반환", query: "임대차보증금 반환" }], confidence: "low",
  uncertainty: "계약 종료 여부가 불명확함", followUp: "계약이 종료되었나요?",
};
const completion = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
const context = { requestId: "interpretation-test" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.GROQ_API_KEY;
});

describe("research query interpretation", () => {
  it("uses the existing strict Groq transport and preserves the exact user text independently of the model", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    const fetcher = vi.fn().mockResolvedValue(completion(proposal));
    vi.stubGlobal("fetch", fetcher);
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const answer = await interpretResearchQuery(query, context);
    // A specific follow-up question replaces the generic uncertainty.
    expect(answer).toEqual({ original: query, ...proposal, uncertainty: undefined });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.groq.com/openai/v1/chat/completions");
    const request = JSON.parse(String(init.body));
    expect(request.response_format.json_schema.strict).toBe(true);
    expect(request).toMatchObject({ reasoning_effort: "medium", max_completion_tokens: 1_000, temperature: 0 });
    expect(request.messages[1].content).toContain(query);
    expect(log).toHaveBeenCalledExactlyOnceWith("[AI][Groq]", {
      kind: "research-interpretation",
      operation: "research-interpretation",
      reasoningEffort: "medium",
      model: "openai/gpt-oss-120b",
      durationMs: expect.any(Number),
      requestId: context.requestId,
      attempt: 1,
      maxAttempts: 4,
      promptTokens: undefined,
      completionTokens: undefined,
      totalTokens: undefined,
      cumulativePromptTokens: undefined,
      cumulativeCompletionTokens: undefined,
      cumulativeTotalTokens: undefined,
    });
  });

  it("merges an issue repeated under the same label or search phrase and keeps distinct ones", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({ ...proposal, issues: [
      { label: "부당해고 여부", query: "부당해고" },
      { label: "해고의 정당성", query: "부당 해고" },
      { label: "부당해고 여부", query: "해고 사유" },
      { label: "임금체불", query: "임금 체불" },
    ] })));
    const answer = await interpretResearchQuery("해고됐는데 부당해고인지, 정당한지 궁금하고 월급도 밀렸어", context);
    expect(answer.issues).toEqual([{ label: "부당해고 여부", query: "부당해고" }, { label: "임금체불", query: "임금 체불" }]);
  });

  it("keeps dismissal and severance pay as two issues for a short two-issue question", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({ ...proposal, facts: ["해고됨", "퇴직금 미지급"], issues: [
      { label: "부당해고 여부", query: "부당해고" },
      { label: "퇴직금", query: "퇴직금 지급" },
    ] })));
    const answer = await interpretResearchQuery("회사에서 잘렸는데 퇴직금도 못받았어", context);
    expect(answer.issues.map((issue) => issue.label)).toEqual(["부당해고 여부", "퇴직금"]);
  });

  it("surfaces a daily quota 429 as a rate-limit error instead of an empty reading", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: {
      message: "Rate limit reached for model on tokens per day (TPD): Limit 200000, Used 199673, Requested 1804.", type: "tokens", code: "rate_limit_exceeded",
    } }), { status: 429, headers: { "retry-after": "639" } })));
    await expect(interpretResearchQuery("회사에서 잘렸어", context)).rejects.toMatchObject({ code: "AI_RATE_LIMITED", status: 429 });
  });

  it("keeps an interpretation with no identifiable issue so its follow-up can ask what happened", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    const vague = { ...proposal, situation: "회사에서 문제가 생긴 상황으로 이해했습니다.", facts: [], issues: [], uncertainty: null,
      followUp: "해고, 임금, 근무 조건 등 회사와 어떤 문제가 생겼는지 알려주면 관련 법령을 찾을 수 있습니다." };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion(vague)));
    const answer = await interpretResearchQuery("회사에서 문제가 생겼는데 어떻게 해야 해?", context);
    expect(answer).toMatchObject({ issues: [], followUp: vague.followUp });
  });

  it("keeps stated facts and drops the user's own questions the model filed as facts", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({ ...proposal, facts: [
      "해고가 정당한지 궁금해", "부당해고인지도 알고 싶고", "회사가 이렇게 자른 게 문제가 없는지도 알려줘",
      "퇴직금은 받을 수 있을까", "석 달치 월급을 아직 못 받았다", "문자로 해고 통보를 받음",
    ] })));
    const answer = await interpretResearchQuery("해고가 정당한지 궁금해. 석 달치 월급을 아직 못 받았어. 문자로 해고 통보를 받았어. 퇴직금은 받을 수 있을까", context);
    expect(answer.facts).toEqual(["석 달치 월급을 아직 못 받았다", "문자로 해고 통보를 받음"]);
  });

  it("drops an invented number or over-long item instead of the whole reading, and keeps every issue", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    const many = Array.from({ length: 6 }, (_, index) => ({ label: `쟁점${index}`, query: `검색어${index}` }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({ ...proposal,
      situation: "2026년 9월에 전세금을 받지 못한 상황으로 이해했습니다.",
      facts: ["보증금 5천만 원", "전세금 미반환", ...Array.from({ length: 10 }, (_, index) => `사실${"가".repeat(index + 1)}`)],
      issues: [...many, { label: "x", query: "y" }],
    })));
    const answer = await interpretResearchQuery(query, context);
    expect(answer.situation).toBe("");
    expect(answer.facts[0]).toBe("전세금 미반환");
    expect(answer.facts).toHaveLength(8);
    expect(answer.issues).toEqual(many);
  });

  it("asks once more after a malformed answer and gives up after a second", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    const recovered = vi.fn().mockResolvedValueOnce(completion({ ...proposal, issues: ["임대차 보증금 반환"] }))
      .mockResolvedValueOnce(completion(proposal));
    vi.stubGlobal("fetch", recovered);
    await expect(interpretResearchQuery(query, context)).resolves.toMatchObject({ issues: proposal.issues });
    expect(recovered).toHaveBeenCalledTimes(2);
    for (const [, init] of recovered.mock.calls as Array<[string, RequestInit]>) {
      expect(JSON.parse(String(init.body))).toMatchObject({ reasoning_effort: "medium", max_completion_tokens: 1_000 });
    }
    for (const invalid of [{ ...proposal, confidence: "certain" }, { ...proposal, citation: "법령을 확인했음" }]) {
      const failing = vi.fn().mockImplementation(async () => completion(invalid));
      vi.stubGlobal("fetch", failing);
      await expect(interpretResearchQuery(query, context)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
      expect(failing).toHaveBeenCalledTimes(2);
    }
  });

  it("waits out one short rate limit, but not a long one or a server failure", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    const limited = (retryAfter: string) => new Response(JSON.stringify({ error: { message: "rate" } }), { status: 429, headers: { "retry-after": retryAfter } });
    const recovered = vi.fn().mockResolvedValueOnce(limited("0")).mockResolvedValueOnce(completion(proposal));
    vi.stubGlobal("fetch", recovered);
    await expect(interpretResearchQuery(query, context)).resolves.toMatchObject({ issues: proposal.issues });
    expect(recovered).toHaveBeenCalledTimes(2);
    const long = vi.fn().mockImplementation(async () => limited("30"));
    vi.stubGlobal("fetch", long);
    await expect(interpretResearchQuery(query, context)).rejects.toMatchObject({ code: "AI_RATE_LIMITED" });
    expect(long).toHaveBeenCalledTimes(1);
    const down = vi.fn().mockImplementation(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", down);
    await expect(interpretResearchQuery(query, context)).rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE" });
    expect(down).toHaveBeenCalledTimes(1);
  });

  it("aborts the provider request when the client cancels instead of starting a search", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    const controller = new AbortController();
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetcher);
    const pending = interpretResearchQuery(query, { ...context, signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "LAW_REQUEST_ABORTED" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
