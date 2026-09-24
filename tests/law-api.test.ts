import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/law/route";
import { parseLawEntries } from "@/server/law-mcp";

const KEY = "test-law-key-1234";
const SEARCH_TEXT = [
  "검색 결과 (총 2건):", "", "📍 정확매칭 (1건):",
  "1. 근로기준법 [현행]", "   - 법령ID: 001872", "   - MST: 283457", "   - 공포일: 20260219 / 시행일: 20260820", "   - 구분: 법률", "",
  "2. 근로기준법 시행령 [현행]", "   - 법령ID: 003058", "   - MST: 270551", "   - 공포일: 20250408 / 시행일: 20251023", "   - 구분: 대통령령", "",
  "🔜 「근로기준법」 개정 시행예정 (시행 2026-10-08)",
].join("\n");

beforeEach(() => {
  process.env.LAW_OC = KEY;
  process.env.LAW_MCP_URL = "https://mcp.example.test/law";
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.LAW_OC;
  delete process.env.LAW_MCP_URL;
});

const lawRequest = (body: unknown) => new Request("https://worklens.test/api/law", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "https://worklens.test" },
  body: JSON.stringify(body),
});
const rpc = (result: unknown, init: ResponseInit = { status: 200 }) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...result as object }), { headers: { "Content-Type": "application/json" }, ...init });
const toolText = (text: string, isError = false) => rpc({ result: { content: [{ type: "text", text }], ...(isError ? { isError } : {}) } });

async function call(body: unknown) {
  const response = await POST(lawRequest(body));
  const text = await response.text();
  type Body = { requestId: string; data: { found: boolean; text: string; laws?: unknown[] }; error: { code: string } };
  return { status: response.status, text, json: JSON.parse(text) as Body };
}

describe("POST /api/law", () => {
  it("calls only search_law with the key in the apikey header and returns parsed laws plus the original text", async () => {
    const fetcher = vi.fn().mockResolvedValue(toolText(SEARCH_TEXT));
    vi.stubGlobal("fetch", fetcher);
    const result = await call({ query: " 근로기준법 " });
    expect(result.status).toBe(200);
    expect(result.json.data).toMatchObject({ found: true, laws: [
      { name: "근로기준법", status: "현행", lawId: "001872", mst: "283457", promulgationDate: "20260219", effectiveDate: "20260820", kind: "법률" },
      { name: "근로기준법 시행령", lawId: "003058", mst: "270551" },
    ] });
    expect(result.json.data.text).toContain("개정 시행예정");
    const [url, init] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("https://mcp.example.test/law");
    expect(String(url)).not.toContain(KEY);
    expect(new Headers(init.headers).get("apikey")).toBe(KEY);
    expect(JSON.parse(String(init.body))).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_law", arguments: { query: "근로기준법" } } });
    expect(result.text).not.toContain(KEY);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(KEY);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("근로기준법");
  });

  it("rejects empty, non-string, oversized and proxy-shaped requests before any upstream call", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const body of [{ query: "" }, { query: "   " }, { query: 42 }, { query: "가".repeat(201) }, {},
      { query: "근로기준법", tool: "legal_research" }, { query: "근로기준법", url: "https://evil.test" }, { query: "근로기준법", apiKey: "x" }]) {
      const result = await call(body);
      expect(result.status).toBe(400);
      expect(result.json.error.code).toBe("LAW_INVALID_REQUEST");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses to call out when the key or URL is not configured", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    delete process.env.LAW_OC;
    expect((await call({ query: "근로기준법" })).json.error.code).toBe("LAW_NOT_CONFIGURED");
    process.env.LAW_OC = KEY;
    delete process.env.LAW_MCP_URL;
    const missingUrl = await call({ query: "근로기준법" });
    expect([missingUrl.status, missingUrl.json.error.code]).toEqual([503, "LAW_NOT_CONFIGURED"]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps an explicit MCP NOT_FOUND distinct from success and from an outage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolText("[NOT_FOUND] 법령 '없는법' 검색 결과가 없습니다.", true)));
    const result = await call({ query: "없는법" });
    expect(result.status).toBe(200);
    expect(result.json.data).toEqual({ found: false, marker: "NOT_FOUND", text: "[NOT_FOUND] 법령 '없는법' 검색 결과가 없습니다." });
  });

  it.each([
    [new Response("denied " + KEY, { status: 401 }), 502, "LAW_AUTH_FAILED"],
    [new Response("slow down", { status: 429 }), 429, "LAW_RATE_LIMITED"],
    [new Response("oops " + KEY, { status: 503 }), 503, "LAW_UPSTREAM_UNAVAILABLE"],
    [rpc({ error: { code: -32602, message: "bad params " + KEY } }), 502, "LAW_MCP_ERROR"],
    [new Response("<html>not json</html>", { status: 200 }), 502, "LAW_MCP_ERROR"],
    [toolText("tool crashed " + KEY, true), 502, "LAW_MCP_ERROR"],
  ] as const)("maps upstream failures to safe WorkLens errors without leaking the key (%#)", async (upstream, status, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(upstream));
    const result = await call({ query: "근로기준법" });
    expect([result.status, result.json.error.code]).toEqual([status, code]);
    expect(result.text).not.toContain(KEY);
    expect(result.json.requestId).toEqual(expect.any(String));
  });

  it("distinguishes a network failure from a timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed " + KEY)));
    const network = await call({ query: "근로기준법" });
    expect([network.status, network.json.error.code]).toEqual([503, "LAW_UPSTREAM_UNAVAILABLE"]);
    expect(network.text).not.toContain(KEY);

    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn((_url: URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })));
      const pending = call({ query: "근로기준법" });
      await vi.advanceTimersByTimeAsync(20_000);
      const timeout = await pending;
      expect([timeout.status, timeout.json.error.code]).toEqual([504, "LAW_UPSTREAM_TIMEOUT"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("redacts the key if the MCP ever echoes it in successful text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolText(`${SEARCH_TEXT}\nhttps://law.go.kr/x?OC=${KEY}`)));
    const result = await call({ query: "근로기준법" });
    expect(result.text).not.toContain(KEY);
    expect(result.json.data.text).toContain("[REDACTED]");
  });
});

describe("law search text parsing", () => {
  it("keeps entries without status labels and ignores trailing notes", () => {
    expect(parseLawEntries("1. 민법\n   - 법령ID: 001706\n\n참고: 끝")).toEqual([{ name: "민법", lawId: "001706" }]);
  });
  it("keeps law IDs, MST and effective dates attached to the right numbered result", () => {
    const text = "1. 근로기준법 [현행]\n   - 법령ID: 001872\n   - MST: 283457\n   - 구분: 법률\n   - 공포일: 20260102 / 시행일: 20260401\n\n2. 근로기준법 시행령\n   - 법령ID: 003058\n   - 시행일: 20260501\n\n참고: 다음 페이지";
    expect(parseLawEntries(text)).toEqual([
      { name: "근로기준법", status: "현행", lawId: "001872", mst: "283457", kind: "법률", promulgationDate: "20260102", effectiveDate: "20260401" },
      { name: "근로기준법 시행령", lawId: "003058", effectiveDate: "20260501" },
    ]);
  });
  it("ignores unknown metadata without promoting it to a law identifier or date", () => {
    const text = "1. 첫 법령 [현행]\n   - 공포일별: 발행 기록\n   - 참고: 연결 문서\n\n2. 둘째 법령\n   - 법령ID: 002222\n   - 공포일: 20250101\n";
    expect(parseLawEntries(text)).toEqual([
      { name: "첫 법령", status: "현행" },
      { name: "둘째 법령", lawId: "002222", promulgationDate: "20250101" },
    ]);
  });
  it("ignores unnumbered follow-up notes after a valid result", () => {
    expect(parseLawEntries("1. 근로기준법 [현행]\n   - 법령ID: 001872\n💡 실제 적용 시점을 확인하세요.\n"))
      .toEqual([{ name: "근로기준법", status: "현행", lawId: "001872" }]);
  });
});
