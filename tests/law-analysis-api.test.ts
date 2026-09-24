import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/law/analysis/route";
import { LAW_ANALYSIS_BODY_MAX_BYTES } from "@/lib/law-analysis";

const KEY = "test-law-key-1234";
const ENDPOINT = "https://mcp.example.test/law";
const verify = { mode: "verify_citations", text: "검증할 민법 제750조" };
const cite = { mode: "cite_check", caseNumber: "2013다61381" };
const applicable = { mode: "applicable_law", lawName: "도로교통법", date: "20230510" };
const impact = { mode: "impact_map", lawName: "민법", jo: "제103조" };
// Representative excerpts from live legal_analysis responses (all four modes).
const samples = {
  verify_ok: { text: "[HALLUCINATION_DETECTED] == 인용 검증 결과 ==\n법령 인용 3건 | ✓ 2 실존 | ✗ 1 오류\n▶ 법령 인용\n✗ 형법 제9999조 — [NOT_FOUND] 해당 조문 없음\n⚠️ [HALLUCINATION_DETECTED] 1건 인용이 실존하지 않습니다." },
  verify_none: { text: "[NO_CITATIONS_FOUND] 입력 텍스트에서 조문·판례 인용이 발견되지 않았습니다.\n\n⚠️ 이 결과는 '검증 성공'이 아니라 '검증할 인용이 없음'입니다." },
  cite: { text: "═══ 판례 인용 추적 (Citator): 2013다61381 ═══\n대상: 대법원 2018.10.30 선고 2013다61381 전원합의체 판결\n📊 판정: ✅ 후속 인용 15건, 변경·폐기 신호 미감지" },
  cite_missing: { text: "[NOT_FOUND] 사건번호 '2099다99999' 판례를 법제처 DB에서 찾을 수 없습니다.\n\n⚠️ 이 도구는 요청한 데이터를 찾지 못했습니다." },
  appl: { text: "═══ 행위시법 판단: 도로교통법 @ 2023.05.10 ═══\n▶ 기준일에 시행 중이던 버전\n  도로교통법 [시행 2023.04.04] [제19158호, 2023.01.03, 일부개정]\n▶ 기준일 시점 조문: 제44조" },
  impact: { text: "═══ Impact Map: 민법 제103조 ═══\n법령: 민법 (MST 284415, 법률)\n▶ 대상 조문 본문\n제103조(반사회질서의 법률행위) 선량한 풍속 기타 사회질서에 위반한 사항을 내용으로 하는 법률행위는 무효로 한다.\n▶ 영향 그래프 (이 조문이 인용된 곳)\n├─ 📚 대법원 판례: 1건\n└─ 🏛️ 자치법규: 2건" },
  impact_bad: { text: "═══ Impact Map: 민법 제9999조 ═══\n법령: 민법 (MST 284415, 법률)\n▶ 대상 조문 본문 [NOT_FOUND] 조문 조회 실패 — 법령명·조문번호 확인 필요\n▶ 영향 그래프 (이 조문이 인용된 곳)\n├─ 📚 대법원 판례: 0건\n└─ 🏛️ 자치법규: 2건" },
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
  return new Request("https://worklens.test/api/law/analysis", {
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
    data?: { found: boolean; mode: string; text: string; markers?: string[]; marker?: string };
    error?: { code: string; message: string }; requestId: string;
  } };
}
function toolCall(fetcher: { mock: { calls: unknown[][] } }, index = 0) {
  const [url, init] = fetcher.mock.calls[index] as [URL, RequestInit];
  return { url, headers: new Headers(init.headers), params: JSON.parse(String(init.body)).params };
}

describe("fixed legal_analysis API", () => {
  it("sends fixed per-mode arguments, normalizes both date formats, preserves upstream text and extracts markers", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(toolText(samples.verify_none.text))
      .mockResolvedValueOnce(toolText(samples.cite.text))
      .mockResolvedValueOnce(toolText(samples.appl.text))
      .mockResolvedValueOnce(toolText(samples.appl.text))
      .mockResolvedValueOnce(toolText(samples.impact.text));
    vi.stubGlobal("fetch", fetcher);
    const inputs = [verify, cite, applicable, { ...applicable, date: "2023-05-10", jo: "제44조" }, impact];
    const args = [
      { mode: "verify_citations", text: verify.text, maxCitations: 15 },
      { mode: "cite_check", caseNumber: cite.caseNumber, display: 20, deepScan: true },
      { mode: "applicable_law", lawName: applicable.lawName, date: "2023-05-10" },
      { mode: "applicable_law", lawName: applicable.lawName, date: "2023-05-10", jo: "제44조" },
      { mode: "impact_map", lawName: impact.lawName, jo: impact.jo, includeOrdinances: true, includeMermaid: false },
    ];
    const texts = [samples.verify_none.text, samples.cite.text, samples.appl.text, samples.appl.text, samples.impact.text];
    for (let i = 0; i < inputs.length; i++) {
      const result = await call(inputs[i]);
      expect(result.status).toBe(200);
      expect(result.json.data).toEqual({ found: true, mode: inputs[i].mode, text: texts[i],
        markers: i === 0 ? ["NO_CITATIONS_FOUND"] : [] });
      const upstream = toolCall(fetcher, i);
      expect(String(upstream.url)).toBe(ENDPOINT);
      expect(upstream.headers.get("apikey")).toBe(KEY);
      expect(upstream.params).toEqual({ name: "legal_analysis", arguments: args[i] });
      expect(result.raw).not.toContain(KEY);
    }
    const logs = vi.mocked(console.info).mock.calls;
    expect(logs).toHaveLength(inputs.length);
    for (let i = 0; i < logs.length; i++) {
      expect(logs[i][0]).toBe("[LAW][MCP]");
      expect(logs[i][1]).toEqual({ requestId: expect.any(String), operation: "legal_analysis", mode: inputs[i].mode,
        upstreamStatus: 200, latencyMs: expect.any(Number) });
    }
    expect(JSON.stringify(logs)).not.toContain(KEY);
    expect(JSON.stringify(logs)).not.toContain(verify.text);
    expect(JSON.stringify(logs)).not.toContain(cite.caseNumber);
    expect(JSON.stringify(logs)).not.toContain(applicable.lawName);
  });

  it("reports hallucination detection as a result even with isError and keeps distinct markers in first-occurrence order", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(toolText(samples.verify_ok.text, true))
      .mockResolvedValueOnce(toolText(samples.verify_none.text)));
    const detected = await call(verify);
    expect(detected.json.data).toEqual({ found: true, mode: "verify_citations", text: samples.verify_ok.text,
      markers: ["HALLUCINATION_DETECTED", "NOT_FOUND"] });
    const none = await call(verify);
    expect(none.json.data).toEqual({ found: true, mode: "verify_citations", text: samples.verify_none.text,
      markers: ["NO_CITATIONS_FOUND"] });
  });

  it("distinguishes leading absence markers from inline sections and upstream failure axes", async () => {
    const axis = "조회 실패 (업스트림 오류로 확인 못 함, 0건이 아님)";
    const partial = `${samples.impact_bad.text}\n▶ 행정심판례: ${axis}\n[NOT_FOUND] 일부 조문`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(toolText(samples.cite_missing.text, true))
      .mockResolvedValueOnce(toolText("  [LAW_NOT_FOUND] 법령 없음", true))
      .mockResolvedValueOnce(toolText("[INVALID_ARGUMENT] 조문 오류", true))
      .mockResolvedValueOnce(toolText(partial)));
    const missing = await call(cite);
    expect(missing.json.data).toEqual({ found: false, mode: "cite_check", marker: "NOT_FOUND", text: samples.cite_missing.text });
    const lawMissing = await call(applicable);
    expect(lawMissing.json.data).toEqual({ found: false, mode: "applicable_law", marker: "NOT_FOUND", text: "  [LAW_NOT_FOUND] 법령 없음" });
    const invalid = await call(impact);
    expect(invalid.json.data).toEqual({ found: false, mode: "impact_map", marker: "INVALID_ARGUMENT", text: "[INVALID_ARGUMENT] 조문 오류" });
    const map = await call(impact);
    expect(map.json.data).toEqual({ found: true, mode: "impact_map", text: partial, markers: ["NOT_FOUND"] });
    expect(map.json.data?.text).toContain(axis);
  });

  it("rejects unknown modes, absent inputs, cross-mode/injected fields and invalid bounds without an MCP call", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const invalid = [
      {}, { mode: "search_law", text: verify.text },
      { mode: "verify_citations" }, { mode: "cite_check" }, { mode: "applicable_law", lawName: "민법" },
      { mode: "impact_map", lawName: "민법" },
      { ...verify, text: " " }, { ...verify, text: "가".repeat(5001) },
      { ...cite, caseNumber: "nonsense" }, { ...cite, text: verify.text },
      { ...applicable, text: verify.text }, { ...impact, caseNumber: cite.caseNumber },
      { ...impact, lawName: "민\u0000법" }, { ...impact, jo: "74" }, { ...impact, jo: "제0조" },
      ...["2023-02-30", "1899-12-31", "yesterday"].map((date) => ({ ...applicable, date })),
      ...["apiKey", "tool", "url", "headers", "options", "maxCitations", "display", "deepScan", "includeMermaid", "provider"]
        .map((field) => ({ ...verify, [field]: field === "headers" ? { apikey: KEY } : KEY })),
    ];
    for (const body of invalid) {
      const response = await call(body);
      expect([response.status, response.json.error?.code]).toEqual([400, "LAW_INVALID_REQUEST"]);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces origin, content type and body bytes before contacting MCP", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const [body, headers, status] of [
      [verify, { Origin: "https://evil.test" }, 403],
      [verify, { "Content-Type": "text/plain" }, 415],
      [{ ...verify, excess: "x".repeat(LAW_ANALYSIS_BODY_MAX_BYTES) }, {}, 413],
    ] as const) {
      expect((await call(body, headers)).status).toBe(status);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps HTTP auth/rate, network, malformed and oversized replies and JSON-RPC errors without leaking upstream details", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(KEY, { status: 401 }))
      .mockResolvedValueOnce(new Response(KEY, { status: 403 }))
      .mockResolvedValueOnce(new Response(KEY, { status: 429 }))
      .mockRejectedValueOnce(new TypeError(KEY))
      .mockResolvedValueOnce(rpc({ error: { code: -32602, message: KEY } }))
      .mockResolvedValueOnce(new Response(`<html>${KEY}</html>`))
      .mockResolvedValueOnce(toolText("x".repeat(512 * 1024 + 1)))
      .mockResolvedValueOnce(toolText(`[ERROR] ${KEY}`, true));
    vi.stubGlobal("fetch", fetcher);
    for (const [status, code] of [[502, "LAW_AUTH_FAILED"], [502, "LAW_AUTH_FAILED"], [429, "LAW_RATE_LIMITED"],
      [503, "LAW_UPSTREAM_UNAVAILABLE"], [502, "LAW_MCP_ERROR"], [502, "LAW_MCP_ERROR"],
      [502, "LAW_MCP_ERROR"], [502, "LAW_MCP_ERROR"]] as const) {
      const result = await call(verify);
      expect([result.status, result.json.error?.code]).toEqual([status, code]);
      expect(result.raw).not.toContain(KEY);
      expect(result.raw).not.toContain("[ERROR]");
    }
  });

  it("maps upstream status markers, empty replies and generic isError without presenting an outage as absence", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(toolText(" \n "))
      .mockResolvedValueOnce(toolText("[RATE_LIMITED] upstream secret", true))
      .mockResolvedValueOnce(toolText("[REQUEST_TIMEOUT] upstream secret", true))
      .mockResolvedValueOnce(toolText("[UPSTREAM_NO_DATA] upstream secret", true))
      .mockResolvedValueOnce(toolText("[EXTERNAL_API_ERROR] upstream secret"))
      .mockResolvedValueOnce(toolText("[PARSE_ERROR] upstream secret"))
      .mockResolvedValueOnce(toolText("[INVALID_PARAMETER] upstream secret"))
      .mockResolvedValueOnce(toolText("[ANNEX_BODY_UNAVAILABLE] upstream secret"))
      .mockResolvedValueOnce(toolText("[ERROR] upstream secret"))
      .mockResolvedValueOnce(toolText("upstream secret", true));
    vi.stubGlobal("fetch", fetcher);
    for (const [status, code] of [[502, "LAW_MCP_ERROR"], [429, "LAW_RATE_LIMITED"], [504, "LAW_UPSTREAM_TIMEOUT"],
      [502, "LAW_UPSTREAM_NO_DATA"], ...Array.from({ length: 6 }, () => [502, "LAW_MCP_ERROR"])] as const) {
      const result = await call(impact);
      expect([result.status, result.json.error?.code]).toEqual([status, code]);
      expect(result.json.data).toBeUndefined();
      expect(result.raw).not.toContain("upstream secret");
    }
  });

  it("uses 45 seconds rather than the existing 20-second timeout for legal_analysis", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    let settled = false;
    const pending = call(verify).then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(25_000);
    const result = await pending;
    expect([result.status, result.json.error?.code]).toEqual([504, "LAW_UPSTREAM_TIMEOUT"]);
  });

  it("maps client cancellation to 499 rather than upstream timeout", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_url: URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetcher);
    const pending = call(verify, undefined, controller.signal);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort();
    const result = await pending;
    expect(fetcher).toHaveBeenCalledOnce();
    expect([result.status, result.json.error?.code]).toEqual([499, "LAW_REQUEST_ABORTED"]);
    expect(result.raw).not.toContain(KEY);
  });
});
