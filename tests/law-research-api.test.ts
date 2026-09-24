import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/law/research/route";
import { LAW_RESEARCH_BODY_MAX_BYTES, LAW_RESEARCH_DOCUMENT_MAX_CHARS } from "@/lib/law-research";

const KEY = "test-law-key-1234";
const ENDPOINT = "https://mcp.example.test/law";
const query = "직장 내 괴롭힘 판단 기준";
const documentText = "이 계약의 기한은 2026년까지이며 위약금은 당사자 합의에 따른다.";
// Representative excerpts from live legal_research responses; the fixture is intentionally kept inline.
const samples = {
  full: "═══ 종합 리서치: 직장 내 괴롭힘 판단 기준 ═══\n\n▶ AI 법령검색 결과\n근로기준법\n제76조의2(직장 내 괴롭힘의 금지)",
  system: "═══ 법체계 확인: 개인정보 보호법 ═══\n법령ID: 011357 | MST: 283839 | 구분: 법률\n▶ 3단 비교 (법률·시행령·시행규칙)",
  basis: "═══ 처분 근거 확인: 개인정보 보호법 ═══\n▶ 법령 체계 (법률·시행령·시행규칙)\n법령명: 개인정보 보호법",
  dispute: "═══ 쟁송 대비: 부당해고 구제 ═══\n▶ 대법원 판례\n판례 검색 결과 (총 397건, 1페이지):",
  amend: "═══ 개정 추적: 근로기준법 ═══\n▶ 신구대조표 (최근 개정)\n법령명: 근로기준법",
  ord: "═══ 조례 비교 연구: 주차장법 관련 조례 ═══\n▶ 상위 법령\n주차장법 (법률) | MST: 283743",
  proc: "═══ 절차/비용 안내: 행정심판 청구 절차와 제출서류 ═══\n법령: 행정심판법 (법률) | MST: 249041\n\n▶ 법령 체계 (절차 근거)",
  doc: "═══ 문서 종합 검토 ═══\n\n▶ 문서 리스크 분석\n=== 문서 리스크 분석 ===\n문서 유형: 일반 계약\n추출 조항: 3개",
};

beforeEach(() => {
  process.env.LAW_OC = KEY;
  process.env.LAW_MCP_URL = ENDPOINT;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.LAW_OC;
  delete process.env.LAW_MCP_URL;
});

function request(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request("https://worklens.test/api/law/research", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://worklens.test", ...headers },
    body: JSON.stringify(body), signal,
  });
}
function rpc(result: object, init: ResponseInit = {}) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...result }), { headers: { "Content-Type": "application/json" }, ...init });
}
function toolText(text: string, isError = false) {
  return rpc({ result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } });
}
async function call(body: unknown, headers?: Record<string, string>, signal?: AbortSignal) {
  const response = await POST(request(body, headers, signal));
  const raw = await response.text();
  return { status: response.status, raw, json: JSON.parse(raw) as {
    data?: { found: boolean; task: string; text: string; markers?: string[]; marker?: string };
    error?: { code: string; message: string }; requestId: string;
  } };
}
function toolCall(fetcher: { mock: { calls: unknown[][] } }, index = 0) {
  const [url, init] = fetcher.mock.calls[index] as [URL, RequestInit];
  return { url, headers: new Headers(init.headers), envelope: JSON.parse(String(init.body)) };
}

const base = { task: "full_research", query };

describe("fixed legal_research API", () => {
  it("forwards only each task's allowlisted fields to legal_research and returns complete upstream text and distinct markers", async () => {
    const cases = [
      { input: base, args: base, text: samples.full },
      { input: { task: "law_system", query, articles: ["제2조", "제3조"] }, args: { task: "law_system", query, articles: ["제2조", "제3조"] }, text: samples.system },
      { input: { task: "action_basis", query }, args: { task: "action_basis", query }, text: samples.basis },
      { input: { task: "dispute_prep", query, domain: "labor" }, args: { task: "dispute_prep", query, domain: "labor" }, text: samples.dispute },
      { input: { task: "amendment_track", query }, args: { task: "amendment_track", query, includeHistory: false }, text: samples.amend },
      { input: { task: "ordinance_compare", query, parentLaw: " 주차장법 " }, args: { task: "ordinance_compare", query, parentLaw: "주차장법" }, text: samples.ord },
      { input: { task: "procedure_detail", query }, args: { task: "procedure_detail", query }, text: samples.proc },
      { input: { task: "document_review", text: `  ${documentText}  ` }, args: { task: "document_review", text: documentText, maxClauses: 15 }, text: samples.doc },
    ];
    const fetcher = vi.fn().mockImplementation(async () => toolText(`${cases[fetcher.mock.calls.length - 1].text}\n[NOT_FOUND] 일부 결과\n[NOT_FOUND] 다른 항목`));
    vi.stubGlobal("fetch", fetcher);
    for (let i = 0; i < cases.length; i++) {
      const { input, args, text } = cases[i];
      const result = await call(input);
      expect(result.status).toBe(200);
      expect(result.json.data).toEqual({ found: true, task: input.task, text: `${text}\n[NOT_FOUND] 일부 결과\n[NOT_FOUND] 다른 항목`, markers: ["NOT_FOUND"] });
      const upstream = toolCall(fetcher, i);
      expect(String(upstream.url)).toBe(ENDPOINT);
      expect(upstream.headers.get("apikey")).toBe(KEY);
      expect(upstream.envelope).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "legal_research", arguments: args } });
      expect(result.raw).not.toContain(KEY);
    }
    const logs = vi.mocked(console.info).mock.calls;
    expect(logs).toHaveLength(cases.length);
    for (let i = 0; i < logs.length; i++) {
      expect(logs[i]).toEqual(["[LAW][MCP]", { requestId: expect.any(String), operation: "legal_research", task: cases[i].input.task,
        upstreamStatus: 200, latencyMs: expect.any(Number) }]);
    }
    expect(JSON.stringify(logs)).not.toContain(KEY);
    expect(JSON.stringify(logs)).not.toContain(query);
    expect(JSON.stringify(logs)).not.toContain(documentText);
  });
  it("normalizes amendment dates, forwards options and includes default or explicit history", async () => {
    const fetcher = vi.fn().mockImplementation(async () => toolText(samples.amend));
    vi.stubGlobal("fetch", fetcher);
    const cases = [
      { input: { task: "amendment_track", query, scenario: "timeline" }, args: { task: "amendment_track", query, scenario: "timeline", includeHistory: false } },
      { input: { task: "amendment_track", query, scenario: "time_travel", fromDate: "2022-01-01", toDate: "20260101", mst: "284415", lawId: "011357", includeHistory: true },
        args: { task: "amendment_track", query, scenario: "time_travel", fromDate: "20220101", toDate: "20260101", mst: "284415", lawId: "011357", includeHistory: true } },
    ];
    for (let i = 0; i < cases.length; i++) {
      expect((await call(cases[i].input)).json.data).toEqual({ found: true, task: "amendment_track", text: samples.amend, markers: [] });
      expect(toolCall(fetcher, i).envelope.params).toEqual({ name: "legal_research", arguments: cases[i].args });
    }
  });

  it("forwards optional arrays/domains/counts when present and omits absent options", async () => {
    const fetcher = vi.fn().mockImplementation(async () => toolText(samples.doc));
    vi.stubGlobal("fetch", fetcher);
    const cases = [
      [{ task: "law_system", query }, { task: "law_system", query }],
      [{ task: "dispute_prep", query }, { task: "dispute_prep", query }],
      [{ task: "document_review", text: documentText, maxClauses: 30 }, { task: "document_review", text: documentText, maxClauses: 30 }],
    ];
    for (let i = 0; i < cases.length; i++) {
      expect((await call(cases[i][0])).status).toBe(200);
      expect(toolCall(fetcher, i).envelope.params).toEqual({ name: "legal_research", arguments: cases[i][1] });
    }
  });

  it("keeps section-level failures and deadline notices as found, but leading absence as NOT_FOUND", async () => {
    const partial = `${samples.full}\n▶ 조문 조회 [NOT_FOUND / FAILED]\n⏱ 45초 내 일부 자료만 확인했습니다.\n[REQUEST_TIMEOUT] 하위 단계 실패`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(toolText(partial))
      .mockResolvedValueOnce(toolText(" \n[NOT_FOUND] 법령이 없습니다.", true))
      .mockResolvedValueOnce(toolText("[LAW_NOT_FOUND] 법령이 없습니다.", true)));
    expect((await call(base)).json.data).toEqual({ found: true, task: "full_research", text: partial,
      markers: ["REQUEST_TIMEOUT"] });
    expect((await call(base)).json.data).toEqual({ found: false, task: "full_research", marker: "NOT_FOUND", text: " \n[NOT_FOUND] 법령이 없습니다." });
    expect((await call(base)).json.data).toEqual({ found: false, task: "full_research", marker: "NOT_FOUND", text: "[LAW_NOT_FOUND] 법령이 없습니다." });
  });

  it("rejects unknown tasks, missing/bad fields, cross-task fields and caller-selected transport without leaking input", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const invalid = [
      {}, { task: "search_law", query }, { task: "full_research" }, { ...base, query: "  " }, { ...base, query: "z".repeat(2001) },
      { ...base, extra: "private extra" }, { ...base, text: documentText },
      { task: "document_review", text: documentText, query }, { task: "procedure_detail", query, domain: "tax" },
      { task: "law_system", query, fromDate: "2022-01-01" },
      ...["apiKey", "tool", "url", "method", "jsonrpc", "headers"].map((field) => ({ ...base, [field]: "injected-secret" })),
      { task: "dispute_prep", query, domain: "unknown" },
      ...[[], ["제0조"], ["제1조", "bad"], Array.from({ length: 11 }, () => "제1조")].map((articles) => ({ task: "law_system", query, articles })),
      { task: "ordinance_compare", query, parentLaw: "  " }, { task: "ordinance_compare", query, parentLaw: "법\u0000명" },
      { task: "ordinance_compare", query, parentLaw: "가".repeat(101) },
      ...["time_travel", "timeline"].flatMap((scenario) => [
        { task: "amendment_track", query, scenario, fromDate: "2022-01-01" },
        { task: "amendment_track", query, scenario, toDate: "2026-01-01" },
      ]),
      { task: "amendment_track", query, scenario: "time_travel" },
      { task: "amendment_track", query, scenario: "time_travel", fromDate: "2026-01-01", toDate: "2022-01-01" },
      { task: "amendment_track", query, scenario: "time_travel", fromDate: "2023-02-30", toDate: "2026-01-01" },
      { task: "amendment_track", query, fromDate: "2022-01-01", toDate: "2026-01-01" },
      { task: "amendment_track", query, scenario: "timeline", fromDate: "2022-01-01", toDate: "2026-01-01" },
      { task: "amendment_track", query, mst: "abc" }, { task: "amendment_track", query, lawId: "1234567890123" },
      { task: "amendment_track", query, includeHistory: "true" },
      { task: "document_review" }, { task: "document_review", text: "" }, { task: "document_review", text: " \t " },
      { task: "document_review", text: "x".repeat(19) }, { task: "document_review", text: "x".repeat(LAW_RESEARCH_DOCUMENT_MAX_CHARS + 1) },
      ...[0, 31, 1.5, "5"].map((maxClauses) => ({ task: "document_review", text: documentText, maxClauses })),
    ];
    for (const body of invalid) {
      const response = await call(body);
      expect([response.status, response.json.error?.code]).toEqual([400, "LAW_INVALID_REQUEST"]);
      expect(response.raw).not.toContain(query);
      expect(response.raw).not.toContain(documentText);
      expect(response.raw).not.toContain("injected-secret");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces same-site, JSON content type, and body byte ceiling before MCP", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const [body, headers, status] of [
      [base, { Origin: "https://evil.test" }, 403],
      [base, { "Content-Type": "text/plain" }, 415],
      [{ ...base, extra: "x".repeat(LAW_RESEARCH_BODY_MAX_BYTES) }, {}, 413],
    ] as const) {
      expect((await call(body, headers)).status).toBe(status);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps upstream auth/rate/network/RPC/malformed/oversized failures to safe errors", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(KEY, { status: 401 }))
      .mockResolvedValueOnce(new Response(KEY, { status: 429 }))
      .mockRejectedValueOnce(new TypeError(KEY))
      .mockResolvedValueOnce(rpc({ error: { code: -32602, message: KEY } }))
      .mockResolvedValueOnce(new Response(`<html>${KEY}</html>`))
      .mockResolvedValueOnce(toolText("x".repeat(512 * 1024 + 1)));
    vi.stubGlobal("fetch", fetcher);
    for (const [status, code] of [[502, "LAW_AUTH_FAILED"], [429, "LAW_RATE_LIMITED"], [503, "LAW_UPSTREAM_UNAVAILABLE"],
      [502, "LAW_MCP_ERROR"], [502, "LAW_MCP_ERROR"], [502, "LAW_MCP_ERROR"]] as const) {
      const result = await call(base);
      expect([result.status, result.json.error?.code]).toEqual([status, code]);
      expect(result.raw).not.toContain(KEY);
      expect(result.json.data).toBeUndefined();
    }
  });

  it("distinguishes leading upstream errors and invalid argument from absence", async () => {
    const cases = [
      [" ", false, 502, "LAW_MCP_ERROR"], ["[INVALID_ARGUMENT] missing text", true, 502, "LAW_MCP_ERROR"],
      ["[RATE_LIMITED] secret", true, 429, "LAW_RATE_LIMITED"],
      ["[REQUEST_TIMEOUT] secret", true, 504, "LAW_UPSTREAM_TIMEOUT"],
      ["[UPSTREAM_NO_DATA] secret", true, 502, "LAW_UPSTREAM_NO_DATA"],
      ["[EXTERNAL_API_ERROR] secret", false, 502, "LAW_MCP_ERROR"],
      ["[PARSE_ERROR] secret", false, 502, "LAW_MCP_ERROR"],
      ["[INVALID_PARAMETER] secret", false, 502, "LAW_MCP_ERROR"],
      ["[ANNEX_BODY_UNAVAILABLE] secret", false, 502, "LAW_MCP_ERROR"],
      ["[ERROR] secret", false, 502, "LAW_MCP_ERROR"],
      ["upstream secret", true, 502, "LAW_MCP_ERROR"],
    ] as const;
    const fetcher = vi.fn().mockImplementation(async () => {
      const [text, isError] = cases[fetcher.mock.calls.length - 1];
      return toolText(text, isError);
    });
    vi.stubGlobal("fetch", fetcher);
    for (const [, , status, code] of cases) {
      const result = await call(base);
      expect([result.status, result.json.error?.code]).toEqual([status, code]);
      expect(result.raw).not.toContain("secret");
      expect(result.json.data).toBeUndefined();
    }
  });

  it("waits for 60 seconds rather than timing out at the chain's 45-second deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    let settled = false;
    const pending = call(base).then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect([result.status, result.json.error?.code]).toEqual([504, "LAW_UPSTREAM_TIMEOUT"]);
  });

  it("maps client cancellation to 499 instead of an upstream timeout", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_url: URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetcher);
    const pending = call(base, undefined, controller.signal);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort();
    const result = await pending;
    expect([result.status, result.json.error?.code]).toEqual([499, "LAW_REQUEST_ABORTED"]);
  });
});
