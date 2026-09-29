import { afterEach, describe, expect, it, vi } from "vitest";
import { interpretResearchQuery } from "@/server/groq";

const query = "전세금을 아직 받지 못했습니다";
const proposal = {
  situation: "전세금을 아직 받지 못했다고 말함", issues: ["임대차 보증금 반환"],
  searchTerms: ["임대차보증금 반환"], confidence: "low", uncertainty: "계약 종료 여부가 불명확함",
  followUp: "계약이 종료되었나요?",
};
const completion = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
const context = { requestId: "interpretation-test" };

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GROQ_API_KEY;
});

describe("research query interpretation", () => {
  it("uses the existing strict Groq transport and preserves the exact user text independently of the model", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    const fetcher = vi.fn().mockResolvedValue(completion(proposal));
    vi.stubGlobal("fetch", fetcher);
    const answer = await interpretResearchQuery(query, context);
    expect(answer).toEqual({ original: query, ...proposal });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.groq.com/openai/v1/chat/completions");
    const request = JSON.parse(String(init.body));
    expect(request.response_format.json_schema.strict).toBe(true);
    expect(request.messages[1].content).toContain(query);
    expect(request.max_completion_tokens).toBe(700);
  });

  it("rejects unsupported facts in the restatement and malformed or overlong suggestions", async () => {
    process.env.GROQ_API_KEY = "test-provider-key";
    for (const invalid of [
      { ...proposal, situation: "2026년 9월에 전세금을 받지 못함" },
      { ...proposal, searchTerms: Array.from({ length: 10 }, () => "보증금") },
      { ...proposal, confidence: "certain" },
      { ...proposal, citation: "법령을 확인했음" },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion(invalid)));
      await expect(interpretResearchQuery(query, context)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    }
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
