import { afterEach, describe, expect, it, vi } from "vitest";
import { interpretResearchQuery, preserveResearchSearchFacts } from "@/server/groq";

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
  it("uses the existing Groq transport and preserves the exact user text independently of the model", async () => {
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
    expect(request.response_format.json_schema).not.toHaveProperty("strict");
    expect(request).toMatchObject({ reasoning_effort: "medium", max_completion_tokens: 2_000, temperature: 0 });
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

  it("drops a money claim the user never raised while a grounded issue remains", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    const issues = [
      { label: "무단퇴사 효력", query: "무단퇴사" },
      { label: "근로계약 해지", query: "근로계약 해지" },
      { label: "퇴직금 정산", query: "퇴직금 지급" },
      { label: "손해배상 청구", query: "근로자 손해배상" },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({ ...proposal, issues })));
    const answer = await interpretResearchQuery("직원이 갑자기 무단퇴사해서 연락이 안 됨", context);
    expect(answer.issues.map((issue) => issue.label)).toEqual(["무단퇴사 효력", "근로계약 해지"]);
  });

  it("keeps a wage claim the user named without inventing a retirement-benefit claim from it", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({ ...proposal, issues: [
      { label: "퇴직 후 임금 지급", query: "퇴직 금품 지급기한" },
      { label: "퇴직금", query: "퇴직금 지급" },
    ] })));
    const answer = await interpretResearchQuery("퇴사한 지 한 달인데 마지막 달 임금을 못 받았어", context);
    expect(answer.issues.map((issue) => issue.label)).toEqual(["퇴직 후 임금 지급"]);
  });

  it("preserves the observed retirement fact when the model drops it from a wage search", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({ ...proposal, issues: [
      { label: "임금 지급 기한", query: "임금 지급 기한" },
      { label: "임금 청구 절차", query: "임금 청구 절차" },
    ] })));
    const answer = await interpretResearchQuery("회사를 그만둔 지 한 달이 지났는데 마지막 달에 일한 임금을 받지 못했습니다. 퇴직 뒤 임금을 언제까지 지급해야 하는지와 받기 위한 절차를 알고 싶습니다.", context);
    expect(answer.issues.map((issue) => issue.query)).toEqual(["퇴직 임금 지급 기한", "퇴직 임금 청구 절차"]);
  });

  it.each([
    ["매달 임금을 못 받았습니다", "임금 지급", "임금 지급"],
    ["퇴직하지 않았는데 임금을 못 받았습니다", "임금 지급", "임금 지급"],
    ["퇴직금 지급이 궁금합니다", "임금 지급", "임금 지급"],
    ["퇴사 후 월급을 못 받았습니다", "퇴직 임금 지급", "퇴직 임금 지급"],
    ["퇴사와 해고의 차이는?", "해고 효력", "해고 효력"],
    ["국가기관과 계약변경을 협의 중입니다", "계약 변경", "국가기관 계약 변경"],
    ["지방자치단체 입찰제재가 궁금합니다", "부정당 제재", "지방자치단체 부정당 제재"],
    ["국가기관과 지방자치단체 계약 차이는?", "계약 변경", "계약 변경"],
    ["민간 회사와 계약했습니다", "계약 해제", "계약 해제"],
    ["국가기관과 공사계약을 체결했고 설계변경이 있었습니다", "계약금액 변경", "설계변경 국가기관 계약금액 변경"],
    ["물품 공급계약의 납품기한이 지났습니다", "계약 해제", "계약 해제"],
    ["퇴직 전에 임금이 밀렸습니다", "임금 지급", "임금 지급"],
    ["공사계약이 아닌 물품매매입니다", "계약 해제", "계약 해제"],
    ["설계변경이 없었습니다", "계약금액 변경", "계약금액 변경"],
    ["상대방은 국가기관이 아닙니다", "계약 변경", "계약 변경"],
  ])("keeps only explicit applicable search facts: %s", (original, input, expected) => {
    expect(preserveResearchSearchFacts(original, input)).toBe(expected);
  });

  it("rejects an entirely invented claim instead of searching it as the user's issue", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => completion({
      ...proposal, issues: [{ label: "퇴직금", query: "퇴직금 지급" }],
    })));
    await expect(interpretResearchQuery("회사를 그만뒀어", context)).rejects.toMatchObject({
      code: "INVALID_PROVIDER_OUTPUT", status: 502,
    });
  });

  it("accepts a grounded correction without retaining the invented claim", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(completion({ ...proposal, issues: [{ label: "퇴직금", query: "퇴직금 지급" }] }))
      .mockResolvedValueOnce(completion({ ...proposal, issues: [{ label: "근로관계 종료", query: "근로계약 해지" }] }));
    vi.stubGlobal("fetch", fetcher);
    const answer = await interpretResearchQuery("직원이 갑자기 무단퇴사해서 연락이 안 됨", context);
    expect(answer.issues).toEqual([{ label: "근로관계 종료", query: "근로계약 해지" }]);
  });

  it("shadow mode only: returns a span-checked FactFrame from the same single call without changing the reading", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const factFrame = { parties: [{ id: "p1", role: "임차인", span: "전세금" }, { id: "p2", role: "임대인", span: "집주인" }], relation: null,
      acts: [{ id: "a1", actor: "p2", act: "보증금 미반환", polarity: "affirmed", span: "받지 못했습니다" }], conditions: [],
      asks: [{ id: "q1", kind: "권리", span: "받지 못했습니다" }] };
    const fetcher = vi.fn().mockResolvedValue(completion({ ...proposal, factFrame }));
    vi.stubGlobal("fetch", fetcher);
    let received: unknown;
    const answer = await interpretResearchQuery(query, { ...context, onFactFrame: (result) => { received = result; } });
    expect(answer).toEqual({ original: query, ...proposal, uncertainty: undefined });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(received).toMatchObject({ dropped: 1, frame: { parties: [{ id: "p1" }], acts: [{ id: "a1" }], asks: [{ id: "q1" }] } });
    const request = JSON.parse(String((fetcher.mock.calls[0] as [string, RequestInit])[1].body));
    // §9 fix2: ceiling set from the §6 re-run measurement (max 2,794 of 3,000).
    expect(request.max_completion_tokens).toBe(3_600);
    expect(request.response_format.json_schema.schema.required).toContain("factFrame");
  });

  it("keeps the interpretation call unchanged outside shadow mode", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetcher = vi.fn().mockResolvedValue(completion(proposal));
    vi.stubGlobal("fetch", fetcher);
    await interpretResearchQuery(query, context);
    const request = JSON.parse(String((fetcher.mock.calls[0] as [string, RequestInit])[1].body));
    expect(request.max_completion_tokens).toBe(2_000);
    expect(request.response_format.json_schema.schema.required).not.toContain("factFrame");
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
      expect(JSON.parse(String(init.body))).toMatchObject({ reasoning_effort: "medium", max_completion_tokens: 2_000 });
    }
    for (const invalid of [{ ...proposal, confidence: "certain" }, { ...proposal, citation: "법령을 확인했음" }]) {
      const failing = vi.fn().mockImplementation(async () => completion(invalid));
      vi.stubGlobal("fetch", failing);
      await expect(interpretResearchQuery(query, context)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
      expect(failing).toHaveBeenCalledTimes(2);
    }
  });

  it("treats a provider-side truncated JSON answer as malformed and asks once more, but not other rejections", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Actual production rejection when hidden reasoning used the whole completion budget.
    const truncated = () => new Response(JSON.stringify({ error: {
      message: "Failed to validate JSON. Please adjust your prompt.", type: "invalid_request_error", code: "json_validate_failed",
    } }), { status: 400 });
    const recovered = vi.fn().mockResolvedValueOnce(truncated()).mockResolvedValueOnce(completion(proposal));
    vi.stubGlobal("fetch", recovered);
    await expect(interpretResearchQuery(query, context)).resolves.toMatchObject({ issues: proposal.issues });
    expect(recovered).toHaveBeenCalledTimes(2);
    const twice = vi.fn().mockImplementation(async () => truncated());
    vi.stubGlobal("fetch", twice);
    await expect(interpretResearchQuery(query, context)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    expect(twice).toHaveBeenCalledTimes(2);
    const otherRejection = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: {
      message: "model_not_found", type: "invalid_request_error", code: "model_not_found",
    } }), { status: 400 }));
    vi.stubGlobal("fetch", otherRejection);
    await expect(interpretResearchQuery(query, context)).rejects.toMatchObject({ code: "AI_PROVIDER_REJECTED" });
    expect(otherRejection).toHaveBeenCalledTimes(1);
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
