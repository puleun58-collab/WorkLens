import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAiApiRequest } from "@/server/ai-request";
import { runGroqAi, reasoningEffortFor } from "@/server/groq";
import { axDiagnosisOutputSchema, axPlanSchema, confirmedAxDiagnosis } from "@/lib/ax/schema";
import { axMessages } from "@/lib/ax/prompt";
import { diagnosisFixture, planFixture, outputFixture } from "./fixtures/ax";
const request = { kind: "ax-diagnosis" as const, name: "취합", description: "입력 표를 취합하여 담당자 승인을 받습니다.", details: {} };
beforeEach(() => { process.env.GROQ_API_KEY = "test-ax-secret"; });
afterEach(() => { delete process.env.GROQ_API_KEY; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function provider(payload: unknown) { return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 500, total_tokens: 600 } }), { status: 200 }); }
describe("AX AI boundaries", () => {
  it("accepts both kinds with bounded confirmed data and keeps default low", () => {
    expect(parseAiApiRequest(request)).toEqual(request);
    expect(parseAiApiRequest({ kind: "ax-plan", target: "codex", task: { name: "취합", description: "입력 표 취합", details: {} }, diagnosis: confirmedAxDiagnosis(diagnosisFixture) }).kind).toBe("ax-plan");
    expect(reasoningEffortFor("ax-diagnosis")).toBe("low"); expect(reasoningEffortFor("ax-plan")).toBe("low");
  });
  it("rejects overlong, unknown, invalid, too many and raw attachment fields", () => {
    for (const invalid of [
      { ...request, name: "a".repeat(121) }, { ...request, description: "a".repeat(3001) }, { ...request, attachmentSummary: "a".repeat(2001) },
      { ...request, attachmentBytes: [1] }, { ...request, details: { systems: "a".repeat(501) } }, { ...request, details: { minutesPerRun: -1 } },
      { ...request, details: { people: 1.5 } }, { ...request, provider: "secret" },
      { kind: "ax-plan", target: "other", task: {}, diagnosis: {} },
      { kind: "ax-plan", target: "claude", task: { name: "취합", description: "설명", details: {} }, diagnosis: { ...confirmedAxDiagnosis(diagnosisFixture), followUpQuestions: ["1", "2", "3", "4"] } },
    ]) expect(() => parseAiApiRequest(invalid)).toThrow();
  });
  it("enforces aggregate UTF-8 bytes within the 64KB route limit", () => {
    const confirmed = confirmedAxDiagnosis(diagnosisFixture);
    const enormous = { ...confirmed, asIs: { ...confirmed.asIs, inputs: Array(10).fill("가".repeat(500)), outputs: Array(10).fill("나".repeat(500)), steps: Array(10).fill("다".repeat(500)), exceptions: Array(10).fill("라".repeat(500)), humanDecisions: Array(10).fill("마".repeat(500)) } };
    expect(() => parseAiApiRequest({ kind: "ax-plan", target: "codex", task: { name: "취합", description: "설명", details: {} }, diagnosis: enormous })).toThrow();
  });
  it("runs diagnosis with strict schema, six validated factors and metadata-only observations", async () => {
    const fetcher = vi.fn<(url: string | URL | Request, options?: RequestInit) => Promise<Response>>().mockResolvedValue(provider(outputFixture())); vi.stubGlobal("fetch", fetcher);
    const logger = vi.spyOn(console, "info").mockImplementation(() => {});
    const result = await runGroqAi({ ...request, description: "PRIVATE_TASK_CONTENT", attachmentSummary: "PRIVATE_ATTACHMENT_CONTENT" });
    expect(result.kind).toBe("ax-diagnosis");
    const body = JSON.parse(fetcher.mock.calls[0][1]?.body as string);
    expect(body).toMatchObject({ reasoning_effort: "low", max_completion_tokens: 3000, response_format: { type: "json_schema", json_schema: { strict: true, name: "worklens_ax_diagnosis" } } });
    const schema = body.response_format.json_schema.schema;
    expect(schema.additionalProperties).toBe(false); expect(schema.required).toContain("operation");
    for (const excluded of ["level", "axes", "matrix", "priority"]) expect(schema.properties).not.toHaveProperty(excluded);
    const log = JSON.stringify(logger.mock.calls); for (const privateText of ["PRIVATE_TASK_CONTENT", "PRIVATE_ATTACHMENT_CONTENT", "test-ax-secret"]) expect(log).not.toContain(privateText);
  });
  it("runs each plan target in its own call with confirmed factors", async () => {
    const fetcher = vi.fn<(url: string | URL | Request, options?: RequestInit) => Promise<Response>>().mockImplementation(async () => provider(planFixture)); vi.stubGlobal("fetch", fetcher); vi.spyOn(console, "info").mockImplementation(() => {});
    const confirmed = confirmedAxDiagnosis(diagnosisFixture); confirmed.factors[0].finalValue = 5;
    for (const target of ["codex", "claude"] as const) expect(await runGroqAi({ kind: "ax-plan", target, task: { name: "취합", description: "설명", details: {} }, diagnosis: confirmed })).toEqual({ kind: "ax-plan", plan: planFixture });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string).messages[1].content).toContain('"finalValue":5');
  });
  it("rejects duplicate factors, malformed plans, computed extras and long attachment copies", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const d = outputFixture();
    expect(axDiagnosisOutputSchema.safeParse({ ...d, factors: Array(6).fill(d.factors[0]) }).success).toBe(false);
    expect(axDiagnosisOutputSchema.safeParse({ ...d, level: 3 }).success).toBe(false);
    expect(axPlanSchema.safeParse({ ...planFixture, repositoryFirst: "guess paths" }).success).toBe(false);
    const summary = "첨부의 개인 자료 내용으로 이루어진 긴 원문 문장입니다.".repeat(6);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => provider({ ...d, asIs: { ...d.asIs, purpose: summary } })));
    await expect(runGroqAi({ ...request, attachmentSummary: summary })).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
  });
  it("includes prohibited behavior and repository-first constraints in prompts", () => {
    const prompt = axMessages(request)[0].content;
    for (const constraint of ["CAPTCHA/MFA", "사람 승인 제거", "ROI", "법률·안전", "추측하지", "secret"]) expect(prompt).toContain(constraint);
    expect(axMessages({ kind: "ax-plan", target: "claude", task: { name: "취합", description: "설명", details: {} }, diagnosis: confirmedAxDiagnosis(diagnosisFixture) })[0].content).toContain("Repository-first");
  });
});
