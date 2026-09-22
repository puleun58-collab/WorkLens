import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAiApiRequest } from "@/server/ai-request";
import { runGroqAi } from "@/server/groq";
import { POST } from "@/app/api/ai/route";
import { aiFailureDetail, interruptServerAi, logAiFailure, polishServerAi } from "@/client/server-ai-client";

const evidence = [{ handle: "E1", text: "2025년 매출은 10억원입니다." }];

beforeEach(() => {
  process.env.GROQ_API_KEY = "test-secret";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.GROQ_API_KEY;
});

const apiRequest = (
  body: string,
  headers: Record<string, string> = {},
): Request => new Request("https://worklens.test/api/ai", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Origin: "https://worklens.test",
    ...headers,
  },
  body,
});

describe("server AI request boundary", () => {
  it("accepts only feature-shaped requests and rejects provider proxy fields", () => {
    expect(parseAiApiRequest({
      kind: "claims",
      request: { operation: "ask", question: "매출은 얼마인가요?" },
      items: evidence,
    })).toEqual({
      kind: "claims",
      request: { operation: "ask", question: "매출은 얼마인가요?" },
      items: evidence,
    });

    expect(() => parseAiApiRequest({
      kind: "claims",
      request: { operation: "ask", question: "매출은 얼마인가요?" },
      items: evidence,
      model: "attacker/model",
      url: "https://example.invalid",
    })).toThrow("AI 요청 형식이 올바르지 않습니다.");
  });

  it("rejects duplicate handles and evidence beyond the transmitted-data ceiling", () => {
    expect(() => parseAiApiRequest({
      kind: "extract",
      field: "매출",
      items: [...evidence, ...evidence],
    })).toThrow("AI 요청 형식이 올바르지 않습니다.");

    expect(() => parseAiApiRequest({
      kind: "polish",
      mode: "default",
      text: "가".repeat(601),
    })).toThrow("AI 요청 형식이 올바르지 않습니다.");
  });
});

describe("server AI route boundary", () => {
  it("rejects cross-site, non-JSON, oversized and malformed feature requests before inference", async () => {
    const crossSite = await POST(apiRequest("{}", { Origin: "https://attacker.test" }));
    expect(crossSite.status).toBe(403);
    await expect(crossSite.json()).resolves.toMatchObject({ error: { code: "ORIGIN_MISMATCH" } });

    const wrongType = await POST(apiRequest("{}", { "Content-Type": "text/plain" }));
    expect(wrongType.status).toBe(415);
    await expect(wrongType.json()).resolves.toMatchObject({ error: { code: "CONTENT_TYPE_REQUIRED" } });

    const oversized = await POST(apiRequest("{}", { "Content-Length": String(24 * 1024 + 1) }));
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ error: { code: "REQUEST_BODY_TOO_LARGE" } });

    const malformed = await POST(apiRequest(JSON.stringify({ kind: "claims", model: "attacker/model" })));
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: "INVALID_AI_REQUEST" } });
  });
});

describe("server AI browser client", () => {
  it("maps safe configuration errors without exposing provider details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: "AI_NOT_CONFIGURED", message: "provider detail must not be used" },
      requestId: "req-config",
    }), { status: 503, headers: { "Content-Type": "application/json" } })));

    await expect(polishServerAi("원문입니다.", "default")).rejects.toMatchObject({
      code: "CONFIGURATION",
      message: "AI 서비스 설정을 확인할 수 없습니다.",
      operation: "polish",
      requestId: "req-config",
      serverCode: "AI_NOT_CONFIGURED",
      occurredAt: expect.any(String),
    });
  });

  it("keeps concrete capacity and provider-rejection codes ahead of HTTP status fallbacks", async () => {
    const providerFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "OPERATION_CAPACITY" },
        requestId: "req-capacity",
      }), { status: 429, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "AI_PROVIDER_REJECTED" },
        requestId: "req-rejected",
      }), { status: 502, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", providerFetch);

    await expect(polishServerAi("원문입니다.", "default")).rejects.toMatchObject({
      code: "OPERATION_CAPACITY",
      message: "AI 작업이 많습니다. 잠시 후 다시 시도하세요.",
      operation: "polish",
      requestId: "req-capacity",
      serverCode: "OPERATION_CAPACITY",
    });
    await expect(polishServerAi("원문입니다.", "default")).rejects.toMatchObject({
      code: "PROVIDER_REJECTED",
      message: "AI 서비스가 요청을 처리하지 못했습니다.",
      operation: "polish",
      requestId: "req-rejected",
      serverCode: "AI_PROVIDER_REJECTED",
    });
  });

  it("cancels an in-flight request through the shared abort boundary", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));

    const pending = polishServerAi("원문입니다.", "default");
    interruptServerAi();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("classifies every client failure and logs metadata without document content", () => {
    expect([
      ["CONFIGURATION", "AI 설정 오류"],
      ["RATE_LIMITED", "사용 한도"],
      ["OPERATION_CAPACITY", "작업 대기 필요"],
      ["TIMEOUT", "응답 지연"],
      ["PROVIDER_UNAVAILABLE", "AI 서비스 일시 오류"],
      ["PROVIDER_REJECTED", "AI 요청 처리 실패"],
      ["INVALID_OUTPUT", "AI 응답 형식 오류"],
      ["INVALID_REQUEST", "AI 요청 오류"],
      ["GROUNDING_REJECTED", "근거 연결 실패"],
      ["NO_EVIDENCE", "관련 근거 없음"],
      ["BUSY", "다른 AI 작업 진행 중"],
      ["CANCELLED", "작업 중지됨"],
    ].map(([code, detail]) => aiFailureDetail({ code }) === detail)).toEqual(Array(12).fill(true));
    expect(aiFailureDetail({ code: "UNKNOWN" })).toBe("AI 처리 오류");

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logAiFailure({
      code: "TIMEOUT",
      message: "기밀 문서 본문",
      operation: "claims",
      serverCode: "UPSTREAM_TIMEOUT",
      requestId: "req-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    expect(warning).toHaveBeenCalledWith("[worklens] AI failure", {
      operation: "claims",
      code: "TIMEOUT",
      serverCode: "UPSTREAM_TIMEOUT",
      requestId: "req-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("기밀 문서 본문");
  });
});

describe("Groq provider adapter", () => {
  it("pins the model and strict schema without logging prompt content", async () => {
    const providerFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ claims: [{ text: "매출은 10억원입니다.", sources: ["E1"], confidence: "high" }] }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", providerFetch);
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const result = await runGroqAi({
      kind: "claims",
      request: { operation: "ask", question: "매출은 얼마인가요?" },
      items: evidence,
    });

    expect(result).toEqual({ kind: "claims", claims: [{ text: "매출은 10억원입니다.", handles: ["E1"], confidence: "high" }] });
    const [url, init] = providerFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(body.model).toBe("openai/gpt-oss-20b");
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-secret");
    expect(JSON.stringify(body)).not.toContain("test-secret");
    expect(JSON.stringify(log.mock.calls)).not.toContain("test-secret");
    expect(JSON.stringify(log.mock.calls)).not.toContain(evidence[0].text);
  });
  it("rejects schema-invalid JSON content from the provider", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ changed: "yes", revisedText: "변경", reasons: [] }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(runGroqAi({ kind: "polish", text: "원문입니다.", mode: "default" })).rejects.toMatchObject({
      code: "INVALID_PROVIDER_OUTPUT",
      status: 502,
    });
  });

  it("logs sanitized provider rejection metadata tied to the API request ID", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        message: "Unsupported response_format json_schema for secret document body",
        type: "invalid_request_error",
        code: "json_schema_not_supported",
      },
    }), {
      status: 400,
      headers: { "Content-Type": "application/json", "x-request-id": "groq-request-1" },
    })));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(apiRequest(JSON.stringify({
      kind: "polish",
      text: "기밀 문서 본문",
      mode: "default",
    })));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      error: { code: "AI_PROVIDER_REJECTED", message: "AI 서비스가 요청을 처리하지 못했습니다." },
      requestId: expect.any(String),
    });
    expect(log).toHaveBeenCalledWith("[AI][Groq] provider rejected request", {
      status: 400,
      providerCode: "json_schema_not_supported",
      providerType: "invalid_request_error",
      providerRequestId: "groq-request-1",
      providerReason: "unsupported_response_format",
      requestId: body.requestId,
      operation: "polish",
      timestamp: expect.any(String),
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("기밀 문서 본문");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret document body");
    expect(JSON.stringify(body)).not.toContain("json_schema_not_supported");
  });

  it("keeps minimum rejection diagnostics when the provider body is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 422 })));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runGroqAi(
      { kind: "extract", field: "매출", items: evidence },
      { requestId: "worklens-request-2" },
    )).rejects.toMatchObject({ code: "AI_PROVIDER_REJECTED", status: 502 });
    expect(log).toHaveBeenCalledWith("[AI][Groq] provider rejected request", expect.objectContaining({
      status: 422,
      requestId: "worklens-request-2",
      operation: "extract",
    }));
  });


  it("retries a transient provider failure once", async () => {
    const providerFetch = vi.fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ field: "매출", value: "10억원", sources: ["E1"], confidence: "high" }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", providerFetch);

    await expect(runGroqAi({ kind: "extract", field: "매출", items: evidence })).resolves.toMatchObject({
      kind: "extract",
      proposal: { value: "10억원", handles: ["E1"] },
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it("maps provider rate limits to a safe retryable API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": "2" },
    })));

    await expect(runGroqAi({ kind: "extract", field: "매출", items: evidence })).rejects.toMatchObject({
      code: "AI_RATE_LIMITED",
      status: 429,
    });
  });

  it("keeps the brief prompt, provider schema and parser on one contract", async () => {
    const providerFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ claims: [
        { text: "주간 Forecast는 최근 8주 평균 유가를 사용합니다.", sources: ["E1"], confidence: "high", section: "산정 기준", role: "summary" },
        { text: "변경 시 재계산이 필요합니다.", sources: ["E1"], confidence: "medium", section: "", role: "action" },
      ] }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", providerFetch);

    const result = await runGroqAi({ kind: "claims", request: { operation: "brief" }, items: evidence });

    expect(result).toMatchObject({ kind: "claims", claims: [
      { text: "주간 Forecast는 최근 8주 평균 유가를 사용합니다.", handles: ["E1"], presentation: { role: "summary", section: "산정 기준" } },
      { text: "변경 시 재계산이 필요합니다.", handles: ["E1"], presentation: { role: "action" } },
    ] });
    const body = JSON.parse(String((providerFetch.mock.calls[0] as [string, RequestInit])[1].body));
    const schema = body.response_format.json_schema.schema.properties.claims.items;
    expect(schema.required).toEqual(["text", "sources", "confidence", "section", "role"]);
    // The example the model is shown has to carry the same fields the schema
    // enforces, or a compliant model is asked for two different shapes.
    const system = body.messages[0].content as string;
    for (const field of schema.required) expect(system).toContain(field);
  });

  it("treats an empty brief envelope as abstention, not a broken response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ claims: [] }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(runGroqAi({ kind: "claims", request: { operation: "brief" }, items: evidence }))
      .resolves.toEqual({ kind: "claims", claims: [] });
  });

  it("rejects a brief claim that omits the presentation contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ claims: [{ text: "요약", sources: ["E1"], confidence: "high", section: "" }] }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(runGroqAi({ kind: "claims", request: { operation: "brief" }, items: evidence }))
      .rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
  });
});
