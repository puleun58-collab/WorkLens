import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as search } from "@/app/api/law/decisions/search/route";
import { POST as detail } from "@/app/api/law/decisions/text/route";

const KEY = "test-law-key-1234";
const SEARCH = "판례 검색 결과 (총 25건, 1페이지):\n\n[0609561] 임금 지급 청구\n  사건번호: 2023두12345\n  법원: 대법원\n  선고일: 20240614\n\n💡 다음: get_precedent_text(id=\"0609561\")";
const COMPACT = "=== 임금 지급 청구 ===\n\n기본 정보:\n  사건번호: 2023두12345\n\n판결요지:\n사용자는 임금을 지급하여야 한다.\n\n전문:\n처음 부분.\n\n⋯ 중략 1,932자 (full=true로 전문 조회) ⋯\n\n마지막 부분.\n";
const FULL = "=== 임금 지급 청구 ===\n\n판결요지:\n사용자는 임금을 지급하여야 한다.\n\n전문:\n처음 부분.\n상세 논증과 이유.\n마지막 부분.\n";

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

function request(kind: "search" | "text", body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://worklens.test/api/law/decisions/${kind}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://worklens.test", ...headers },
    body: JSON.stringify(body),
  });
}
function rpc(result: object, init: ResponseInit = {}) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...result }), { headers: { "Content-Type": "application/json" }, ...init });
}
function toolText(text: string, isError = false) {
  return rpc({ result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } });
}
async function call(kind: "search" | "text", body: unknown, headers?: Record<string, string>) {
  const response = await (kind === "search" ? search : detail)(request(kind, body, headers));
  const raw = await response.text();
  return { status: response.status, raw, json: JSON.parse(raw) as {
    data?: { found: boolean; entries?: Array<{ domain: string; id: string; title?: string }>; text: string; page?: number; totalCount?: number; hasNext?: boolean; marker?: string; expandable?: boolean; sections?: Array<{ heading: string; text: string }> };
    error?: { code: string; message: string }; requestId: string;
  } };
}

function toolCall(fetcher: { mock: { calls: unknown[][] } }, index = 0) {
  const [url, init] = fetcher.mock.calls[index] as [URL, RequestInit];
  return { url, headers: new Headers(init.headers), params: JSON.parse(String(init.body)).params };
}

describe("fixed decision MCP routes", () => {
  it("uses only search_decisions with display 20 and preserves IDs, original text and authoritative pagination", async () => {
    const fetcher = vi.fn().mockResolvedValue(toolText(SEARCH));
    vi.stubGlobal("fetch", fetcher);
    const result = await call("search", { domain: "precedent", query: " 임금 지급 " });
    expect(result.status).toBe(200);
    expect(result.json.data).toEqual({ found: true,
      entries: [{ domain: "precedent", id: "0609561", title: "임금 지급 청구", caseNumber: "2023두12345", court: "대법원", date: "20240614" }],
      text: SEARCH, page: 1, totalCount: 25, hasNext: true });
    const upstream = toolCall(fetcher);
    expect(String(upstream.url)).toBe("https://mcp.example.test/law");
    expect(upstream.headers.get("apikey")).toBe(KEY);
    expect(upstream.params).toEqual({ name: "search_decisions", arguments: { domain: "precedent", query: "임금 지급", display: 20, page: 1 } });
    expect(result.raw).not.toContain(KEY);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(KEY);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("임금 지급");
  });

  it("accepts only supported domains and a bounded fixed payload, before contacting the MCP", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const body of [
      {}, { domain: "school", query: "임금" }, { domain: "treaty", query: "임금" }, { domain: "english_law", query: "임금" },
      { domain: "precedent", query: " " }, { domain: "precedent", query: "가".repeat(201) },
      { domain: "precedent", query: "가", page: 0 }, { domain: "precedent", query: "가", page: 1.5 }, { domain: "precedent", query: "가", page: 1001 },
      { domain: "precedent", query: "가", options: { includeText: true } }, { domain: "precedent", query: "가", display: 100 },
      { domain: "precedent", query: "가", apiKey: KEY }, { domain: "precedent", query: "가", url: "https://evil.test" },
    ]) {
      const result = await call("search", body);
      expect([result.status, result.json.error?.code]).toEqual([400, "LAW_INVALID_REQUEST"]);
    }
    for (const body of [
      {}, { domain: "public_inst", id: "0609561" }, { domain: "precedent", id: "" }, { domain: "precedent", id: " 0609561" },
      { domain: "precedent", id: "123;DROP" }, { domain: "precedent", id: "1".repeat(33) },
      { domain: "precedent", id: 609561 }, { domain: "precedent", id: "0609561", full: false },
      { domain: "precedent", id: "0609561", options: {} }, { domain: "precedent", id: "0609561", apiKey: KEY },
    ]) {
      const result = await call("text", body);
      expect([result.status, result.json.error?.code]).toEqual([400, "LAW_INVALID_REQUEST"]);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces origin, JSON-only and bounded request bodies for both routes", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const [kind, body] of [["search", { domain: "precedent", query: "가" }], ["text", { domain: "precedent", id: "1" }]] as const) {
      expect([ (await call(kind, body, { Origin: "https://evil.test" })).status,
        (await call(kind, body, { "Content-Type": "text/plain" })).status,
        (await call(kind, { ...body, excess: "x".repeat(2048) })).status ]).toEqual([403, 415, 413]);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects cross-site, origin-less, empty and malformed JSON calls before contacting the MCP", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const raw = (kind: "search" | "text", body: string | null, headers: Record<string, string>) => (kind === "search" ? search : detail)(
      new Request(`https://worklens.test/api/law/decisions/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body }));
    for (const kind of ["search", "text"] as const) {
      const crossSite = await raw(kind, "{}", { Origin: "https://worklens.test", "Sec-Fetch-Site": "cross-site" });
      expect([crossSite.status, (await crossSite.json()).error.code]).toEqual([403, "CROSS_SITE_REQUEST"]);
      const originless = await raw(kind, "{}", {});
      expect([originless.status, (await originless.json()).error.code]).toEqual([403, "ORIGIN_REQUIRED"]);
      for (const body of [null, "", "{\"domain\":", "\uFFFE"]) {
        const invalid = await raw(kind, body, { Origin: "https://worklens.test" });
        expect([invalid.status, (await invalid.json()).error.code]).toEqual([400, "LAW_INVALID_REQUEST"]);
      }
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retrieves compact detail by default and requests full only after an explicit full=true", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(toolText(COMPACT)).mockResolvedValueOnce(toolText(FULL));
    vi.stubGlobal("fetch", fetcher);
    const compact = await call("text", { domain: "precedent", id: "0609561" });
    expect(compact.status).toBe(200);
    expect(compact.json.data).toMatchObject({ found: true, title: "임금 지급 청구", text: COMPACT, expandable: true });
    expect(compact.json.data?.sections?.find(({ heading }) => heading === "전문")?.text).toContain("중략 1,932자");
    const full = await call("text", { domain: "precedent", id: "0609561", full: true });
    expect(full.json.data).toMatchObject({ found: true, text: FULL, expandable: false });
    expect(toolCall(fetcher, 0).params).toEqual({ name: "get_decision_text", arguments: { domain: "precedent", id: "0609561" } });
    expect(toolCall(fetcher, 1).params).toEqual({ name: "get_decision_text", arguments: { domain: "precedent", id: "0609561", full: true } });
  });

  it("keeps explicit NOT_FOUND separate from tool failures and does not classify an incidental mention as missing", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolText("[NOT_FOUND] 판례 검색 결과가 없습니다.\n\n다른 키워드로 재시도하세요.", true))
      .mockResolvedValueOnce(toolText("[NOT_FOUND] 본문 없음", true))
      .mockResolvedValueOnce(toolText("=== 판례 ===\n[NOT_FOUND] 인용문", true))
      .mockResolvedValueOnce(toolText("[UPSTREAM_NO_DATA] 실제 부존재가 확인되지 않았습니다.", true));
    vi.stubGlobal("fetch", fetcher);
    const missingSearch = await call("search", { domain: "precedent", query: "없는 사건" });
    expect(missingSearch.json.data).toEqual({ found: false, marker: "NOT_FOUND", text: "[NOT_FOUND] 판례 검색 결과가 없습니다.\n\n다른 키워드로 재시도하세요." });
    const missingDetail = await call("text", { domain: "precedent", id: "0609561" });
    expect(missingDetail.json.data).toEqual({ found: false, marker: "NOT_FOUND", text: "[NOT_FOUND] 본문 없음" });
    for (let i = 0; i < 2; i++) {
      const failure = await call("text", { domain: "precedent", id: "0609561" });
      expect([failure.status, failure.json.error?.code]).toEqual([502, "LAW_MCP_ERROR"]);
    }
  });

  it("does not claim NTS detail exists when the upstream only provides a search list", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await call("text", { domain: "nts", id: "12345" });
    expect([response.status, response.json.error?.code]).toEqual([422, "LAW_DETAIL_NOT_SUPPORTED"]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses unconfigured or non-HTTPS MCP destinations without sending a credential", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    delete process.env.LAW_OC;
    const absentKey = await call("search", { domain: "precedent", query: "사건" });
    expect([absentKey.status, absentKey.json.error?.code]).toEqual([503, "LAW_NOT_CONFIGURED"]);
    process.env.LAW_OC = KEY;
    process.env.LAW_MCP_URL = "http://mcp.example.test/law";
    const unsafeUrl = await call("text", { domain: "precedent", id: "0609561" });
    expect([unsafeUrl.status, unsafeUrl.json.error?.code]).toEqual([503, "LAW_NOT_CONFIGURED"]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps 401, 403, 429, malformed JSON and MCP isError without leaking upstream contents", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(KEY, { status: 401 }))
      .mockResolvedValueOnce(new Response(KEY, { status: 403 }))
      .mockResolvedValueOnce(new Response(KEY, { status: 429 }))
      .mockResolvedValueOnce(new Response("<html>" + KEY + "</html>"))
      .mockResolvedValueOnce(rpc({ error: { code: -32602, message: KEY } }))
      .mockResolvedValueOnce(toolText("[ERROR] " + KEY, true));
    vi.stubGlobal("fetch", fetcher);
    for (const [status, code] of [[502, "LAW_AUTH_FAILED"], [502, "LAW_AUTH_FAILED"], [429, "LAW_RATE_LIMITED"],
      [502, "LAW_MCP_ERROR"], [502, "LAW_MCP_ERROR"], [502, "LAW_MCP_ERROR"]] as const) {
      const failure = await call("search", { domain: "precedent", query: "사건" });
      expect([failure.status, failure.json.error?.code]).toEqual([status, code]);
      expect(failure.raw).not.toContain(KEY);
    }
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(KEY);
  });

  it("redacts credentials in both response types while preserving all other source text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(toolText(SEARCH.replace("대법원", KEY)))
      .mockResolvedValueOnce(toolText(COMPACT.replace("처음 부분.", KEY))));
    const first = await call("search", { domain: "precedent", query: "사건" });
    expect(first.json.data?.text).toContain("법원: [REDACTED]");
    const second = await call("text", { domain: "precedent", id: "0609561" });
    expect(second.json.data?.text).toContain("전문:\n[REDACTED]");
    expect(first.raw + second.raw).not.toContain(KEY);
  });

  it("caps streamed MCP replies, rejects empty content and maps stream/network failures", async () => {
    const broken = new Response(new ReadableStream({ start(controller) { controller.error(new Error(KEY)); } }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(toolText("x".repeat(512 * 1024 + 1)))
      .mockResolvedValueOnce(new Response("small", { headers: { "Content-Length": String(512 * 1024 + 1) } }))
      .mockResolvedValueOnce(rpc({ result: { content: [{ type: "image", data: KEY }] } }))
      .mockResolvedValueOnce(broken)
      .mockRejectedValueOnce(new TypeError(KEY)));
    for (const [status, code] of [[502, "LAW_MCP_ERROR"], [502, "LAW_MCP_ERROR"], [502, "LAW_MCP_ERROR"],
      [503, "LAW_UPSTREAM_UNAVAILABLE"], [503, "LAW_UPSTREAM_UNAVAILABLE"]] as const) {
      const failure = await call("text", { domain: "precedent", id: "0609561" });
      expect([failure.status, failure.json.error?.code]).toEqual([status, code]);
      expect(failure.raw).not.toContain(KEY);
    }
  });
  it("rejects an MCP text item with no text rather than presenting an empty decision", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rpc({ result: { content: [{ type: "text" }] } })));
    const result = await call("search", { domain: "precedent", query: "판결" });
    expect([result.status, result.json.error?.code]).toEqual([502, "LAW_MCP_ERROR"]);
  });

  it("maps an aborted upstream to timeout, never to empty results", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    const pending = call("search", { domain: "precedent", query: "사건" });
    await vi.advanceTimersByTimeAsync(20_000);
    const failure = await pending;
    expect([failure.status, failure.json.error?.code]).toEqual([504, "LAW_UPSTREAM_TIMEOUT"]);
  });

  it("accepts an SSE message and does not mistake an unstructured success for an empty search", async () => {
    const message = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: SEARCH }] } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(`event: message\ndata: ${message}\n\n`, { headers: { "Content-Type": "text/event-stream" } }))
      .mockResolvedValueOnce(toolText("검색 결과가 일시적으로 비었습니다.")));
    expect((await call("search", { domain: "precedent", query: "사건" })).json.data?.entries?.[0].id).toBe("0609561");
    const failure = await call("search", { domain: "precedent", query: "사건" });
    expect([failure.status, failure.json.error?.code]).toEqual([502, "LAW_MCP_ERROR"]);
  });
  it("uses the requested page and only exposes a next page when the returned count supports it", async () => {
    const pageTwo = "헌재결정례 검색 결과 (총 21건, 2페이지):\n\n[34561] 위헌확인\n  사건번호: 2023헌마31\n  종국일: 20240516\n";
    const fetcher = vi.fn().mockResolvedValue(toolText(pageTwo));
    vi.stubGlobal("fetch", fetcher);
    const response = await call("search", { domain: "constitutional", query: "위헌", page: 2 });
    expect(response.json.data).toEqual({ found: true, entries: [{ domain: "constitutional", id: "34561", title: "위헌확인", caseNumber: "2023헌마31", date: "20240516" }],
      text: pageTwo, page: 2, totalCount: 21, hasNext: false });
    expect(toolCall(fetcher).params.arguments).toEqual({ domain: "constitutional", query: "위헌", display: 20, page: 2 });
  });
  it("refuses inconsistent pagination or omitted records instead of claiming a successful empty page", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(toolText("판례 검색 결과 (총 21건, 2페이지):\n\n[1] 판결"))
      .mockResolvedValueOnce(toolText("판례 검색 결과 (총 21건, 1페이지):\n\n💡 다음 페이지"))
      .mockResolvedValueOnce(toolText("판례 검색 결과 (총 21건, 2페이지):\n\n💡 다음 페이지"))
      .mockResolvedValueOnce(toolText("판례 검색 결과 (총 21건, 3페이지):\n\n💡 검색 종료")));
    for (const page of [1, 1, 2]) {
      const result = await call("search", { domain: "precedent", query: "판결", page });
      expect([result.status, result.json.error?.code]).toEqual([502, "LAW_MCP_ERROR"]);
    }
    const beyondEnd = await call("search", { domain: "precedent", query: "판결", page: 3 });
    expect(beyondEnd.json.data).toEqual({
      found: true, entries: [], text: "판례 검색 결과 (총 21건, 3페이지):\n\n💡 검색 종료",
      page: 3, totalCount: 21, hasNext: false,
    });
  });

  it("does not offer an interpretation expansion when full does not change upstream output", async () => {
    const text = "=== 통상임금 해당 여부 ===\n\n이유:\n법제처 회신 그대로.\n";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolText(text)));
    const result = await call("text", { domain: "interpretation", id: "338575" });
    expect(result.json.data).toMatchObject({ found: true, text, expandable: false });
  });

});
