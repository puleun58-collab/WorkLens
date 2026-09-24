import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/law/text/route";

const KEY = "test-law-key-1234";
const HEADER = "법령명: 근로기준법\n공포일: 20260219\n시행일: 20260820\n";
const TOC = `${HEADER}\n목차 (총 132개 조문)\n\n제1조 목적\n제10조의2 국가의 책무\n제35조\n제74조 임산부의 보호\n`;
const ARTICLE = `${HEADER}\n제74조 임산부의 보호\n제74조(임산부의 보호)\n① 사용자는 임신 중의 여성에게 출산 전과 출산 후를 통하여 출산전후휴가를 주어야 한다.\n`;

beforeEach(() => {
  process.env.LAW_OC = KEY;
  process.env.LAW_MCP_URL = "https://mcp.example.test/law";
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.LAW_OC;
  delete process.env.LAW_MCP_URL;
});

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://worklens.test/api/law/text", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://worklens.test", ...headers },
    body: JSON.stringify(body),
  });
}

function rpc(result: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...result as object }), {
    headers: { "Content-Type": "application/json" }, ...init,
  });
}

function toolText(text: string, isError = false) {
  return rpc({ result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } });
}

async function call(body: unknown, headers?: Record<string, string>) {
  const response = await POST(request(body, headers));
  const raw = await response.text();
  return { status: response.status, raw, json: JSON.parse(raw) as {
    data?: { found: boolean; mode?: string; marker?: string; text: string; name?: string; promulgationDate?: string; effectiveDate?: string; articles?: { jo: string; title: string }[] };
    error?: { code: string; message: string };
    requestId: string;
  } };
}

describe("POST /api/law/text", () => {
  it("returns a real-shaped TOC with navigable article labels and keeps the complete source text", async () => {
    const fetcher = vi.fn().mockResolvedValue(toolText(TOC));
    vi.stubGlobal("fetch", fetcher);
    const response = await call({ mst: "283457" });
    expect(response.status).toBe(200);
    expect(response.json.data).toEqual({
      found: true, mode: "toc", text: TOC, name: "근로기준법", promulgationDate: "20260219", effectiveDate: "20260820",
      articles: [{ jo: "제1조", title: "목적" }, { jo: "제10조의2", title: "국가의 책무" }, { jo: "제35조", title: "" }, { jo: "제74조", title: "임산부의 보호" }],
    });
    const [url, init] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(url)).toBe("https://mcp.example.test/law");
    expect(String(url)).not.toContain(KEY);
    expect(new Headers(init.headers).get("apikey")).toBe(KEY);
    expect(JSON.parse(String(init.body))).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_law_text", arguments: { mst: "283457" } } });
    expect(response.raw).not.toContain(KEY);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(KEY);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("283457");
  });
  it("does not invent effective dates from malformed metadata and stops the TOC at a footer", async () => {
    const raw = "법령명: 근로기준법\n개정일: 20260505\n공포일: 미확정\n시행일: 2026-04-01\n\n목차 (총 1개 조문)\n제74조 임산부의 보호\n부칙\n제1조 경과조치";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolText(raw)));
    const response = await call({ mst: "283457" });
    expect(response.json.data).toEqual({ found: true, mode: "toc", text: raw, name: "근로기준법",
      articles: [{ jo: "제74조", title: "임산부의 보호" }] });
  });

  it("fetches a direct article by lawId and distinguishes it from an entire short law", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(toolText(ARTICLE))
      .mockResolvedValueOnce(toolText(`${HEADER}\n제1조(목적)\n이 법은 근로조건의 기준을 정한다.\n`))
      .mockResolvedValueOnce(toolText(`${HEADER}\n제10조의2(국가의 책무)\n국가는 근로조건 향상을 위하여 노력한다.\n`));
    vi.stubGlobal("fetch", fetcher);
    const article = await call({ lawId: "001872", jo: "제74조" });
    expect(article.json.data).toEqual({ found: true, mode: "article", text: ARTICLE, name: "근로기준법", promulgationDate: "20260219", effectiveDate: "20260820" });
    expect(JSON.parse(String((fetcher.mock.calls[0] as [URL, RequestInit])[1].body)).params).toEqual({ name: "get_law_text", arguments: { lawId: "001872", jo: "제74조" } });
    const full = await call({ mst: "283457" });
    expect(full.json.data).toMatchObject({ found: true, mode: "full", name: "근로기준법" });
    expect(full.json.data).not.toHaveProperty("articles");
    const numbered = await call({ mst: "283457", jo: "제10조의2" });
    expect(numbered.json.data).toMatchObject({ found: true, mode: "article" });
    expect(JSON.parse(String((fetcher.mock.calls[2] as [URL, RequestInit])[1].body)).params.arguments).toEqual({ mst: "283457", jo: "제10조의2" });
  });

  it("preserves explicit NOT_FOUND after metadata even when the MCP marks the result as an error", async () => {
    const text = `${HEADER}\n[NOT_FOUND] 조문 내용을 찾을 수 없습니다.`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolText(text, true)));
    const missing = await call({ mst: "283457", jo: "제9999조" });
    expect(missing.status).toBe(200);
    expect(missing.json.data).toEqual({ found: false, marker: "NOT_FOUND", text });
  });

  it("does not treat a mention of NOT_FOUND inside content or an unrelated MCP error as absence", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(toolText(`${HEADER}\n본문 [NOT_FOUND] 참고`, true))
      .mockResolvedValueOnce(toolText(`${HEADER}\n조문을 읽는 중 오류가 발생했습니다.`, true))
      .mockResolvedValueOnce(rpc({ error: { code: -32602, message: `invalid ${KEY}` } }));
    vi.stubGlobal("fetch", fetcher);
    for (let i = 0; i < 3; i++) {
      const failure = await call({ mst: "283457" });
      expect([failure.status, failure.json.error?.code]).toEqual([502, "LAW_MCP_ERROR"]);
      expect(failure.raw).not.toContain(KEY);
    }
  });

  it("rejects malformed identifiers, jo and proxy-shaped requests before calling upstream", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const body of [
      {}, { mst: "28345" }, { mst: "2834570" }, { mst: 283457 }, { mst: " 283457" },
      { lawId: "1a1872" }, { mst: "283457", lawId: "001872" },
      { mst: "283457", jo: "74" }, { mst: "283457", jo: "제0조" }, { mst: "283457", jo: "제10조의0" }, { mst: "283457", jo: "제74조; delete" }, { mst: "283457", jo: "제12345조" },
      { mst: "283457", tool: "search_law" }, { mst: "283457", url: "https://evil.test" }, { mst: "283457", apikey: KEY },
    ]) {
      const failure = await call(body);
      expect([failure.status, failure.json.error?.code]).toEqual([400, "LAW_INVALID_REQUEST"]);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces same-site, JSON-only and bounded request bodies", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const crossSite = await call({ mst: "283457" }, { Origin: "https://evil.test" });
    expect([crossSite.status, crossSite.json.error?.code]).toEqual([403, "ORIGIN_MISMATCH"]);
    const nonJson = await call({ mst: "283457" }, { "Content-Type": "text/plain" });
    expect([nonJson.status, nonJson.json.error?.code]).toEqual([415, "CONTENT_TYPE_REQUIRED"]);
    const oversized = await call({ mst: "283457", excess: "a".repeat(2048) });
    expect([oversized.status, oversized.json.error?.code]).toEqual([413, "REQUEST_BODY_TOO_LARGE"]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps HTTP failure, malformed responses and network failures without exposing upstream secrets", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(KEY, { status: 401 }))
      .mockResolvedValueOnce(new Response(KEY, { status: 429 }))
      .mockResolvedValueOnce(new Response("<html>" + KEY + "</html>", { status: 200 }))
      .mockResolvedValueOnce(rpc({ result: { content: "invalid" } }))
      .mockRejectedValueOnce(new TypeError("network " + KEY));
    vi.stubGlobal("fetch", fetcher);
    for (const [status, code] of [[502, "LAW_AUTH_FAILED"], [429, "LAW_RATE_LIMITED"], [502, "LAW_MCP_ERROR"], [502, "LAW_MCP_ERROR"], [503, "LAW_UPSTREAM_UNAVAILABLE"]] as const) {
      const failure = await call({ lawId: "001872" });
      expect([failure.status, failure.json.error?.code]).toEqual([status, code]);
      expect(failure.raw).not.toContain(KEY);
    }
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(KEY);
  });

  it("redacts a credential echoed by MCP without altering other text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolText(`${HEADER}\n제1조(목적) ${KEY}\n`)));
    const result = await call({ mst: "283457", jo: "제1조" });
    expect(result.status).toBe(200);
    expect(result.json.data?.text).toBe(`${HEADER}\n제1조(목적) [REDACTED]\n`);
    expect(result.raw).not.toContain(KEY);
  });

  it("enforces the upstream response cap and safely maps a failed response stream", async () => {
    const broken = new Response(new ReadableStream({
      start(controller) { controller.error(new Error(`stream failed ${KEY}`)); },
    }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(toolText("x".repeat(512 * 1024 + 1))).mockResolvedValueOnce(broken));
    const oversized = await call({ mst: "283457" });
    expect([oversized.status, oversized.json.error?.code]).toEqual([502, "LAW_MCP_ERROR"]);
    const failed = await call({ mst: "283457" });
    expect([failed.status, failed.json.error?.code]).toEqual([503, "LAW_UPSTREAM_UNAVAILABLE"]);
    expect(failed.raw).not.toContain(KEY);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(KEY);
  });

  it("redacts even short configured credentials echoed in law text", async () => {
    process.env.LAW_OC = "Q7!";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolText(`${HEADER}\n제1조(목적) Q7!\n`)));
    const result = await call({ mst: "283457", jo: "제1조" });
    expect(result.json.data?.text).toContain("[REDACTED]");
    expect(result.raw).not.toContain("Q7!");
  });
});

describe("law text transport boundaries", () => {
  it("does not contact an upstream without a key or with a non-HTTPS endpoint", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    delete process.env.LAW_OC;
    const missingKey = await call({ mst: "283457" });
    expect([missingKey.status, missingKey.json.error?.code]).toEqual([503, "LAW_NOT_CONFIGURED"]);
    process.env.LAW_OC = KEY;
    for (const endpoint of ["not a URL", "http://mcp.example.test/law"]) {
      process.env.LAW_MCP_URL = endpoint;
      const result = await call({ mst: "283457" });
      expect([result.status, result.json.error?.code]).toEqual([503, "LAW_NOT_CONFIGURED"]);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts a Streamable HTTP SSE message without treating it as missing", async () => {
    const event = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: ARTICLE }] } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`event: message\ndata: ${event}\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    })));
    const result = await call({ mst: "283457", jo: "제74조" });
    expect(result.json.data).toMatchObject({ found: true, mode: "article", text: ARTICLE });
  });

  it("distinguishes a client cancellation from a timed-out upstream", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url: URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      if (init?.signal?.aborted) reject(new DOMException("aborted", "AbortError"));
    })));
    const requestWithSignal = new Request("https://worklens.test/api/law/text", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://worklens.test" },
      body: JSON.stringify({ mst: "283457" }),
      signal: controller.signal,
    });
    const cancelled = POST(requestWithSignal);
    controller.abort();
    const aborted = await cancelled;
    expect([aborted.status, (await aborted.json()).error.code]).toEqual([499, "LAW_REQUEST_ABORTED"]);

    vi.useFakeTimers();
    const pending = call({ mst: "283457" });
    await vi.advanceTimersByTimeAsync(20_000);
    const timeout = await pending;
    expect([timeout.status, timeout.json.error?.code]).toEqual([504, "LAW_UPSTREAM_TIMEOUT"]);
  });
});

describe("law text response integrity", () => {
  it("rejects empty SSE, non-text tool content, bodyless responses and declared oversize bodies", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("event: ping\n\n", { headers: { "Content-Type": "text/event-stream" } }))
      .mockResolvedValueOnce(rpc({ result: { content: [{ type: "image", data: "not law text" }] } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response("short", { headers: { "Content-Length": String(512 * 1024 + 1) } }));
    vi.stubGlobal("fetch", fetcher);
    for (let index = 0; index < 4; index++) {
      const result = await call({ mst: "283457" });
      expect([result.status, result.json.error?.code]).toEqual([502, "LAW_MCP_ERROR"]);
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("keeps valid text while omitting unverified metadata dates", async () => {
    const text = "법령명: 짧은 법\n공포일: N/A\n시행일: 20260820\n\n제1조(목적)\n이 법은 사실만 전한다.\n";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolText(text)));
    const result = await call({ lawId: "001872" });
    expect(result.json.data).toEqual({ found: true, mode: "full", text, name: "짧은 법", effectiveDate: "20260820" });
  });
});

describe("law text streaming cancellation", () => {
  const stalledStream = (signal?: AbortSignal) => new Response(new ReadableStream({
    start(stream) {
      signal?.addEventListener("abort", () => stream.error(new Error("stream closed on abort")), { once: true });
    },
  }), { headers: { "Content-Type": "application/json" } });

  it("maps an upstream timeout while reading a response stream to 504", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: URL, init?: RequestInit) => Promise.resolve(stalledStream(init?.signal ?? undefined))));
    const pending = call({ mst: "283457" });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;
    expect([result.status, result.json.error?.code]).toEqual([504, "LAW_UPSTREAM_TIMEOUT"]);
  });

  it("maps a client abort while reading a response stream to cancellation", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url: URL, init?: RequestInit) => {
      const response = stalledStream(init?.signal ?? undefined);
      queueMicrotask(() => controller.abort());
      return Promise.resolve(response);
    }));
    const response = await POST(new Request("https://worklens.test/api/law/text", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://worklens.test" },
      body: JSON.stringify({ mst: "283457" }),
      signal: controller.signal,
    }));
    expect([response.status, (await response.json()).error.code]).toEqual([499, "LAW_REQUEST_ABORTED"]);
  });
});
