import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractServerAi, generateServerAi, interruptServerAi, polishServerAi, SERVER_AI_MESSAGES } from "@/client/server-ai-client";
import { runGroqAi } from "@/server/groq";

const items = [{ handle: "E1", text: "매출은 10억원입니다." }];
const extractRequest = { kind: "extract" as const, field: "매출", items };
const claimRequest = { kind: "claims" as const, request: { operation: "ask" as const, question: "매출은?" }, items };
const analyzeRequest = { kind: "claims" as const, request: { operation: "analyze" as const }, items };
const polishRequest = { kind: "polish" as const, text: "원문입니다.", mode: "default" as const };
const completion = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }), { status: 200 });
const rejected = (status: number, message: string, headers: Record<string, string> = {}) => new Response(JSON.stringify({ error: { message } }), { status, headers });
const apiError = (status: number, code: string, requestId = "req-1") => new Response(JSON.stringify({ error: { code, message: "untrusted provider text" }, requestId }), { status });
const apiSuccess = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

beforeEach(() => {
  process.env.GROQ_API_KEY = "test-secret";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.GROQ_API_KEY;
});

describe("Groq provider failure boundaries", () => {
  it("rejects unconfigured inference without contacting the provider", async () => {
    delete process.env.GROQ_API_KEY;
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(runGroqAi(extractRequest)).rejects.toMatchObject({ code: "AI_NOT_CONFIGURED", status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retries a rate limit with a short Retry-After and returns the recovered result", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(rejected(429, "quota", { "retry-after": "0" }))
      .mockResolvedValueOnce(completion({ field: "매출", value: "10억원", sources: ["E1"], confidence: "high" }));
    vi.stubGlobal("fetch", fetcher);
    await expect(runGroqAi(extractRequest)).resolves.toMatchObject({ kind: "extract", proposal: { value: "10억원", handles: ["E1"] } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not retry an excessive Retry-After even when the status is retryable", async () => {
    const fetcher = vi.fn().mockResolvedValue(rejected(429, "quota", { "retry-after": "2" }));
    vi.stubGlobal("fetch", fetcher);
    await expect(runGroqAi(extractRequest)).rejects.toMatchObject({ code: "AI_RATE_LIMITED", status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])("maps provider authentication status %i to configuration failure without retry", async status => {
    const fetcher = vi.fn().mockResolvedValue(rejected(status, "invalid credentials"));
    vi.stubGlobal("fetch", fetcher);
    await expect(runGroqAi(extractRequest)).rejects.toMatchObject({ code: "AI_NOT_CONFIGURED", status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports persistent 5xx failure after the allowed retry", async () => {
    const fetcher = vi.fn().mockResolvedValue(rejected(503, "maintenance", { "retry-after": "0" }));
    vi.stubGlobal("fetch", fetcher);
    await expect(runGroqAi(extractRequest)).rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE", status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("maps a 400 rejection without retry and without returning provider text", async () => {
    const fetcher = vi.fn().mockResolvedValue(rejected(400, "private document text"));
    vi.stubGlobal("fetch", fetcher);
    await expect(runGroqAi(extractRequest)).rejects.toMatchObject({ code: "AI_PROVIDER_REJECTED", status: 502, message: "AI 서비스가 요청을 처리하지 못했습니다." });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private document text");
  });

  it("retries transport failures once, then returns a connection failure", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("network disconnected"));
    vi.stubGlobal("fetch", fetcher);
    await expect(runGroqAi(extractRequest)).rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE", status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("maps a provider deadline abort to a timeout without retrying", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetcher);
    const pending = runGroqAi(extractRequest);
    const assertion = expect(pending).rejects.toMatchObject({ code: "AI_TIMEOUT", status: 504 });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["unsupported_response_format", "Unsupported response_format json_schema"],
    ["unsupported_parameter", "Unknown parameter reasoning_effort"],
    ["model_restriction", "model not allowed for account"],
    ["payload_constraint", "maximum context length exceeded"],
    ["invalid_request", "invalid_request: malformed field"],
    ["provider_rejected", "unrelated provider failure"],
  ] as const)("classifies %s rejection diagnostics from %s", async (reason, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rejected(400, message, { "x-groq-request-id": "provider-1" })));
    await expect(runGroqAi(extractRequest, { requestId: "local-1" })).rejects.toMatchObject({ code: "AI_PROVIDER_REJECTED" });
    expect(console.error).toHaveBeenCalledWith("[AI][Groq] provider rejected request", expect.objectContaining({
      status: 400, providerReason: reason, providerRequestId: "provider-1", requestId: "local-1", operation: "extract",
    }));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(message);
  });

  it("logs only request identifiers when an error body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret HTML traceback", { status: 400, headers: { "request-id": "provider-2" } })));
    await expect(runGroqAi(extractRequest, { requestId: "local-2" })).rejects.toMatchObject({ code: "AI_PROVIDER_REJECTED" });
    expect(console.error).toHaveBeenCalledWith("[AI][Groq] provider rejected request", expect.objectContaining({
      providerRequestId: "provider-2", providerReason: undefined, requestId: "local-2",
    }));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret HTML traceback");
  });

  it.each([
    ["claims malformed JSON", claimRequest, "not json"],
    ["claims missing confidence", claimRequest, { claims: [{ text: "매출", sources: ["E1"] }] }],
    ["analyze malformed role", analyzeRequest, { claims: [{ text: "매출", sources: ["E1"], confidence: "high", section: "매출", role: 9 }] }],
    ["polish malformed reasons", polishRequest, { changed: false, revisedText: "원문입니다.", reasons: "invalid" }],
    ["polish empty changed text", polishRequest, { changed: true, revisedText: " \n ", reasons: [] }],
    ["extract missing field", extractRequest, { value: "10억원", sources: ["E1"], confidence: "high" }],
  ] as const)("rejects %s as invalid provider output", async (_name, request, content) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion(content)));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
  });

  it("rejects a completion with no choices", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 })));
    await expect(runGroqAi(extractRequest)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
  });
});

describe("server AI client response boundaries", () => {
  it.each([
    ["AI_RATE_LIMITED", 503, "RATE_LIMITED"],
    ["AI_TIMEOUT", 503, "TIMEOUT"],
    ["INVALID_PROVIDER_OUTPUT", 503, "INVALID_OUTPUT"],
    ["RESULT_TOO_LARGE", 503, "INVALID_OUTPUT"],
    ["INVALID_AI_REQUEST", 503, "INVALID_REQUEST"],
    ["CONTENT_TYPE_REQUIRED", 503, "INVALID_REQUEST"],
    ["REQUEST_BODY_TOO_LARGE", 503, "INVALID_REQUEST"],
    ["AI_PROVIDER_UNAVAILABLE", 400, "PROVIDER_UNAVAILABLE"],
  ] as const)("preserves server code %s ahead of HTTP %i fallback", async (serverCode, status, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiError(status, serverCode)));
    await expect(extractServerAi("매출", items)).rejects.toMatchObject({
      code, message: SERVER_AI_MESSAGES[code], operation: "extract", serverCode, requestId: "req-1", occurredAt: expect.any(String),
    });
  });

  it.each([
    [429, "RATE_LIMITED"],
    [400, "INVALID_REQUEST"],
    [413, "INVALID_REQUEST"],
    [415, "INVALID_REQUEST"],
    [504, "TIMEOUT"],
    [502, "PROVIDER_UNAVAILABLE"],
  ] as const)("classifies HTTP %i when the server has no recognized error envelope", async (status, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status })));
    await expect(polishServerAi("원문입니다.", "default")).rejects.toMatchObject({
      code, message: SERVER_AI_MESSAGES[code], operation: "polish", requestId: undefined, serverCode: undefined,
    });
  });

  it("rejects invalid and non-JSON success envelopes", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(apiSuccess({ kind: "claims", claims: [{ text: "매출", handles: ["E1"], confidence: "unknown" }] }))
      .mockResolvedValueOnce(new Response("<html>broken</html>", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(generateServerAi({ operation: "ask", question: "매출은?" }, items)).rejects.toMatchObject({ code: "INVALID_OUTPUT", operation: "claims" });
    await expect(polishServerAi("원문입니다.", "default")).rejects.toMatchObject({ code: "INVALID_OUTPUT", operation: "polish" });
  });

  it("rejects a valid response of the wrong feature kind", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiSuccess({ kind: "extract", proposal: { field: "매출", value: null, handles: [], confidence: "low" } })));
    await expect(polishServerAi("원문입니다.", "default")).rejects.toMatchObject({ code: "INVALID_OUTPUT", operation: "polish" });
  });

  it("returns validated claims and extract proposals from successful envelopes", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(apiSuccess({ kind: "claims", claims: [{ text: "매출은 10억원입니다.", handles: ["E1"], confidence: "high", presentation: { role: "summary", section: "매출" } }] }))
      .mockResolvedValueOnce(apiSuccess({ kind: "extract", proposal: { field: "매출", value: "10억원", handles: ["E1"], confidence: "medium" } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(generateServerAi({ operation: "ask", question: "매출은?" }, items)).resolves.toEqual([
      { text: "매출은 10억원입니다.", handles: ["E1"], confidence: "high", presentation: { role: "summary", section: "매출" } },
    ]);
    await expect(extractServerAi("매출", items)).resolves.toEqual({ field: "매출", value: "10억원", handles: ["E1"], confidence: "medium" });
  });

  it("converts a network rejection to a retryable provider failure and releases the request slot", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("failed to fetch"))
      .mockResolvedValueOnce(apiSuccess({ kind: "polish", proposal: { changed: false, revisedText: "원문입니다.", reasons: [] } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(polishServerAi("원문입니다.", "default")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", message: SERVER_AI_MESSAGES.PROVIDER_UNAVAILABLE });
    await expect(polishServerAi("원문입니다.", "default")).resolves.toEqual({ changed: false, revisedText: "원문입니다.", reasons: [] });
  });

  it("refuses concurrent inference and allows a new request after interruption", async () => {
    const fetcher = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetcher);
    const pending = generateServerAi({ operation: "ask", question: "매출은?" }, items);
    await expect(extractServerAi("매출", items)).rejects.toMatchObject({ code: "BUSY", operation: "extract" });
    interruptServerAi();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED", operation: "claims" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("distinguishes the deadline abort from a user interruption", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const pending = extractServerAi("매출", items);
    const assertion = expect(pending).rejects.toMatchObject({ code: "TIMEOUT", operation: "extract", message: SERVER_AI_MESSAGES.TIMEOUT });
    await vi.advanceTimersByTimeAsync(35_000);
    await assertion;
  });
});
