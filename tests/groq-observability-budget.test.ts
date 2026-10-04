import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interpretResearchQuery, reasoningEffortFor, runGroqAi, type GroqOperation } from "@/server/groq";
import { runLegalResearch } from "@/server/law-research-mcp";

const secret = "secret-key-sentinel";
const query = "user-input-sentinel";
const document = "document-body-sentinel";
const raw = "raw-response-sentinel";
const context = { requestId: "observability-test" };
const request = { kind: "claims" as const, request: { operation: "ask" as const, question: query }, items: [{ handle: "E1", text: document }] };
const usage = { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 };
const proposal = { situation: "상황", facts: [], issues: [], confidence: "low", uncertainty: null, followUp: null };
const completion = (content: string) => Response.json({ choices: [{ message: { content } }], usage });
const limited = (wait = "0") => Response.json({ error: { message: `${query} ${document} ${raw} ${secret}`, code: "rate_limit_exceeded", type: "tokens" } }, { status: 429, headers: { "Retry-After": wait } });

beforeEach(() => {
  process.env.GROQ_API_KEY = secret;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.GROQ_API_KEY;
  delete process.env.LAW_OC;
  delete process.env.LAW_MCP_URL;
});

function expectFailure(code: string, operation = "ask", attempt = 1, withUsage = false) {
  expect(console.error).toHaveBeenCalledOnce();
  expect(console.info).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
  expect(vi.mocked(console.error).mock.calls[0][1]).toMatchObject({
    operation, reasoningEffort: operation === "research-interpretation" ? "medium" : "low",
    model: "openai/gpt-oss-120b", durationMs: expect.any(Number), attempt,
    failureCode: code, requestId: context.requestId,
    ...(withUsage ? { promptTokens: 11, completionTokens: 22, totalTokens: 33 } : {}),
  });
  const logs = JSON.stringify([...vi.mocked(console.error).mock.calls, ...vi.mocked(console.info).mock.calls, ...vi.mocked(console.warn).mock.calls]);
  for (const privateText of [secret, query, document, raw, "한국 법률 리서치 입력을 해석합니다", "messages", "revisedText"]) {
    expect(logs).not.toContain(privateText);
  }
}

describe("Groq final failure observability", () => {
  it("restricts internal operations at compile time while the policy accepts unknown strings", () => {
    const knownOperation = (operation: GroqOperation) => operation;
    expect(knownOperation("research-interpretation")).toBe("research-interpretation");
    // @ts-expect-error An internal typo must fail typecheck.
    knownOperation("research-interpetation");
    // @ts-expect-error Claims is an API kind, not a provider operation.
    knownOperation("claims");
    expect(reasoningEffortFor("research-interpetation")).toBe("low");
  });

  it.each([raw, JSON.stringify({ claims: raw })])("logs invalid structured content once with usage", async (content) => {
    const fetcher = vi.fn().mockResolvedValue(completion(content));
    vi.stubGlobal("fetch", fetcher);
    await expect(runGroqAi(request, context)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    expect(fetcher).toHaveBeenCalledOnce();
    expectFailure("INVALID_PROVIDER_OUTPUT", "ask", 1, true);
  });

  it.each([
    { body: raw, withUsage: false },
    { body: JSON.stringify({ choices: [], usage }), withUsage: true },
    { body: JSON.stringify({ choices: [{ message: {} }], usage }), withUsage: true },
  ])("logs invalid provider envelopes as invalid output without network retries ($withUsage usage)", async ({ body, withUsage }) => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(body));
    vi.stubGlobal("fetch", fetcher);
    await expect(runGroqAi(request, context)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    expect(fetcher).toHaveBeenCalledOnce();
    expectFailure("INVALID_PROVIDER_OUTPUT", "ask", 1, withUsage);
  });

  it("keeps provider rejection diagnostics in a single final log", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: {
      message: `Unsupported parameter ${query} ${document} ${raw} ${secret}`, code: "invalid_request", type: "invalid_request_error",
    } }, { status: 400, headers: { "x-request-id": "provider-test" } })));
    await expect(runGroqAi(request, context)).rejects.toMatchObject({ code: "AI_PROVIDER_REJECTED" });
    expectFailure("AI_PROVIDER_REJECTED");
    expect(console.error).toHaveBeenCalledWith("[AI][Groq] provider rejected request", expect.objectContaining({
      status: 400, providerRequestId: "provider-test", providerReason: "unsupported_parameter",
    }));
  });

  it.each(["ask", "research-interpretation"])("logs the unchanged 30s timeout for %s once", async (operation) => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException(raw, "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetcher);
    const pending = operation === "ask" ? runGroqAi(request, context) : interpretResearchQuery(query, context);
    const check = expect(pending).rejects.toMatchObject({ code: "AI_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(console.error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await check;
    expect(fetcher).toHaveBeenCalledOnce();
    expectFailure("AI_TIMEOUT", operation);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs only the final network failure after the existing general-operation retry", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockRejectedValue(new Error(`${secret} ${raw}`));
    vi.stubGlobal("fetch", fetcher);
    const check = expect(runGroqAi(request, context)).rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE" });
    await vi.runAllTimersAsync();
    await check;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expectFailure("AI_PROVIDER_UNAVAILABLE", "ask", 2);
  });

  it("does not duplicate an interpretation failure at the research fallback layer", async () => {
    process.env.LAW_OC = "law-test-key";
    process.env.LAW_MCP_URL = "https://mcp.example.test/law";
    const fetcher = vi.fn(async (url: string | URL) => String(url).includes("api.groq.com")
      ? Response.json({ error: { message: raw } }, { status: 400 })
      : Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "[NOT_FOUND] 없음" }] } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(runLegalResearch({ task: "full_research", query }, context)).resolves.toMatchObject({
      found: false, interpretationFailure: "unavailable",
    });
    expect(console.error).toHaveBeenCalledOnce();
    expect(console.warn).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls[0][1]).toMatchObject({
      requestId: context.requestId, operation: "research-interpretation", failureCode: "AI_PROVIDER_REJECTED", attempt: 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const logs = JSON.stringify([...vi.mocked(console.error).mock.calls, ...vi.mocked(console.info).mock.calls]);
    for (const text of [secret, query, document, raw, "law-test-key"]) expect(logs).not.toContain(text);
  });
});

describe("research interpretation shared provider attempt budget", () => {
  it.each([
    { steps: ["ok"], calls: 1 },
    { steps: ["malformed", "ok"], calls: 2 },
    { steps: ["limited", "ok"], calls: 2 },
    { steps: ["limited", "malformed", "limited", "ok"], calls: 4 },
  ])("succeeds with $steps in $calls calls without intermediate failure logs", async ({ steps, calls }) => {
    vi.useFakeTimers();
    const fetcher = vi.fn();
    for (const step of steps) fetcher.mockResolvedValueOnce(step === "limited" ? limited() : completion(step === "ok" ? JSON.stringify(proposal) : raw));
    vi.stubGlobal("fetch", fetcher);
    const pending = interpretResearchQuery(query, context);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ original: query });
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledExactlyOnceWith("[AI][Groq]", expect.objectContaining({
      operation: "research-interpretation", reasoningEffort: "medium", requestId: context.requestId,
      attempt: calls, promptTokens: 11, completionTokens: 22, totalTokens: 33,
    }));
    for (const [, init] of fetcher.mock.calls as Array<[string, RequestInit]>) {
      expect(JSON.parse(String(init.body))).toMatchObject({ reasoning_effort: "medium", max_completion_tokens: 1_000 });
    }
    const logs = JSON.stringify(vi.mocked(console.info).mock.calls);
    for (const text of [secret, query, document, raw]) expect(logs).not.toContain(text);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["malformed", "limited"])("retains the final %s failure code at the four-call ceiling", async (last) => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(limited()).mockResolvedValueOnce(completion(raw))
      .mockResolvedValueOnce(limited()).mockResolvedValueOnce(last === "limited" ? limited() : completion(JSON.stringify({ ...proposal, confidence: raw })));
    vi.stubGlobal("fetch", fetcher);
    const code = last === "limited" ? "AI_RATE_LIMITED" : "INVALID_PROVIDER_OUTPUT";
    const check = expect(interpretResearchQuery(query, context)).rejects.toMatchObject({ code });
    await vi.runAllTimersAsync();
    await check;
    expect(fetcher).toHaveBeenCalledTimes(4);
    expectFailure(code, "research-interpretation", 4, last === "malformed");
  });

  it.each([raw, JSON.stringify({ ...proposal, confidence: raw })])("logs only once after two malformed interpretations", async (content) => {
    const fetcher = vi.fn().mockImplementation(async () => completion(content));
    vi.stubGlobal("fetch", fetcher);
    await expect(interpretResearchQuery(query, context)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expectFailure("INVALID_PROVIDER_OUTPUT", "research-interpretation", 2, true);
  });

  it("sends no provider request when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn().mockResolvedValue(completion(JSON.stringify(proposal)));
    vi.stubGlobal("fetch", fetcher);
    await expect(interpretResearchQuery(query, { ...context, signal: controller.signal })).rejects.toMatchObject({ code: "LAW_REQUEST_ABORTED" });
    expect(fetcher).not.toHaveBeenCalled();
    expectFailure("LAW_REQUEST_ABORTED", "research-interpretation", 0);
  });

  it("cancels a short Retry-After wait immediately and sends no later request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValueOnce(limited("6")).mockResolvedValueOnce(completion(JSON.stringify(proposal)));
    vi.stubGlobal("fetch", fetcher);
    const check = expect(interpretResearchQuery(query, { ...context, signal: controller.signal })).rejects.toMatchObject({ code: "LAW_REQUEST_ABORTED" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
    controller.abort();
    // No clock advance: cancellation must settle during the delay itself.
    await check;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledOnce();
    expectFailure("LAW_REQUEST_ABORTED", "research-interpretation");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a malformed-answer retry after cancellation during body consumption", async () => {
    const controller = new AbortController();
    const response = completion(raw);
    const read = response.json.bind(response);
    vi.spyOn(response, "json").mockImplementation(async () => { const value = await read(); controller.abort(); return value; });
    const fetcher = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(completion(JSON.stringify(proposal)));
    vi.stubGlobal("fetch", fetcher);
    await expect(interpretResearchQuery(query, { ...context, signal: controller.signal })).rejects.toMatchObject({ code: "LAW_REQUEST_ABORTED" });
    expect(fetcher).toHaveBeenCalledOnce();
    expectFailure("LAW_REQUEST_ABORTED", "research-interpretation");
  });
});
