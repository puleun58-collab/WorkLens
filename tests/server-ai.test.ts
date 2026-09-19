import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAiApiRequest } from "@/server/ai-request";
import { runGroqAi } from "@/server/groq";
import { POST } from "@/app/api/ai/route";
import { interruptServerAi, polishServerAi } from "@/client/server-ai-client";

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
    }), { status: 503, headers: { "Content-Type": "application/json" } })));

    await expect(polishServerAi("원문입니다.", "default")).rejects.toMatchObject({
      code: "CONFIGURATION",
      message: "AI 서비스가 구성되지 않았습니다.",
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
});
