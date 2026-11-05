import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAiApiRequest } from "@/server/ai-request";
import { runGroqAi } from "@/server/groq";
import { axDiagnosisOutputSchema, axPlanSchema, confirmedAxDiagnosis } from "@/lib/ax/schema";
import { buildAllInOnePrompt } from "@/lib/ax/guide";
import { diagnosisFixture, planFixture, outputFixture } from "./fixtures/ax";

const request = { kind: "ax-diagnosis" as const, name: "취합", description: "입력 표를 취합하여 담당자 승인을 받습니다.", details: {} };
const facts = { facts: [{ field: "inputs", source: "description", quote: "입력 표" }, { field: "humanDecisions", source: "description", quote: "담당자 승인을 받습니다" }, { field: "steps", source: "description", quote: "입력 표를 취합하여" }], conflicts: [] };
const withoutSteps = { facts: facts.facts.filter(fact => fact.field !== "steps"), conflicts: [] };
beforeEach(() => { process.env.GROQ_API_KEY = "test-ax-secret"; vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { delete process.env.GROQ_API_KEY; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function provider(payload: unknown) { return Response.json({ choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 500, total_tokens: 600 } }); }
function respond(...payloads: unknown[]) {
  const fetcher = vi.fn();
  for (const payload of payloads) fetcher.mockResolvedValueOnce(provider(payload));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const planRequest = { kind: "ax-plan" as const, target: "codex" as const, task: { name: "취합", description: "설명", details: {} }, diagnosis: confirmedAxDiagnosis(diagnosisFixture) };

describe("AX AI source boundaries", () => {
  it("does not accept AI decisions or invented current systems, and keeps evidence for the actual source", async () => {
    const raw = outputFixture();
    raw.asIs.systems = ["ERP"];
    respond(facts, { ...raw, decisionPoints: [{ id: "D4", status: "확정" }] });
    const result = await runGroqAi(request);
    expect(result).toMatchObject({ kind: "ax-diagnosis", diagnosis: { asIs: { inputs: ["입력 표"], systems: [], humanDecisions: ["담당자 승인을 받습니다"] }, informationSufficiency: "partial" } });
    if (result.kind !== "ax-diagnosis") throw new Error("unexpected result");
    expect(result.diagnosis).not.toHaveProperty("decisionPoints");
    expect(result.diagnosis.grounding?.facts).toContainEqual({ field: "inputs", source: "description", quote: "입력 표" });
  });
  it("drops a cited fact absent from the input without failing the diagnosis, and fails closed on a malformed extraction", async () => {
    const raw = outputFixture();
    raw.asIs.systems = ["ERP"];
    respond({ facts: [{ field: "systems", source: "description", quote: "ERP" }, ...facts.facts], conflicts: [] }, raw);
    const result = await runGroqAi(request);
    expect(result).toMatchObject({ kind: "ax-diagnosis", diagnosis: { asIs: { systems: [], inputs: ["입력 표"] } } });
    const fetcher = respond({ facts: "invalid" }, { facts: "invalid" });
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const recovering = respond({ facts: [], conflicts: [] }, facts, outputFixture());
    await expect(runGroqAi(request)).resolves.toMatchObject({ kind: "ax-diagnosis", diagnosis: { asIs: { inputs: ["입력 표"] } } });
    expect(recovering).toHaveBeenCalledTimes(3);
  });
  it("rejects overlong, unknown, invalid and raw attachment fields", () => {
    for (const invalid of [
      { ...request, name: "a".repeat(121) }, { ...request, description: "a".repeat(3001) }, { ...request, attachmentSummary: "a".repeat(2001) },
      { ...request, attachmentBytes: [1] }, { ...request, details: { systems: "a".repeat(501) } }, { ...request, details: { minutesPerRun: -1 } },
      { ...request, details: { people: 1.5 } }, { ...request, provider: "secret" }, { ...planRequest, target: "other" },
    ]) expect(() => parseAiApiRequest(invalid)).toThrow();
  });
  it("enforces aggregate UTF-8 bytes within the route limit", () => {
    const confirmed = confirmedAxDiagnosis(diagnosisFixture);
    const enormous = { ...confirmed, asIs: { ...confirmed.asIs, inputs: Array(10).fill("가".repeat(500)), outputs: Array(10).fill("나".repeat(500)), steps: Array(10).fill("다".repeat(500)), exceptions: Array(10).fill("라".repeat(500)), humanDecisions: Array(10).fill("마".repeat(500)) } };
    expect(() => parseAiApiRequest({ ...planRequest, diagnosis: enormous })).toThrow();
  });
  it("rejects duplicate factors, computed extras, malformed plans and long attachment copies", async () => {
    const raw = outputFixture();
    expect(axDiagnosisOutputSchema.safeParse({ ...raw, factors: Array(6).fill(raw.factors[0]) }).success).toBe(false);
    expect(axDiagnosisOutputSchema.safeParse({ ...raw, level: 3 }).success).toBe(false);
    expect(axPlanSchema.safeParse({ ...planFixture, repositoryFirst: "guess paths" }).success).toBe(false);
    const summary = "첨부의 개인 자료 내용으로 이루어진 긴 원문 문장입니다.".repeat(6);
    respond(facts, { ...raw, asIs: { ...raw.asIs, purpose: summary } });
    await expect(runGroqAi({ ...request, attachmentSummary: summary })).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
  });
  it("never returns truncated or schema-invalid plans and keeps the bounded provider retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: JSON.stringify(planFixture).slice(0, 200) } }] })));
    await expect(runGroqAi(planRequest)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    respond({ ...planFixture, tests: undefined });
    await expect(runGroqAi(planRequest)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    const recovering = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 503, headers: { "retry-after": "0" } })).mockResolvedValueOnce(provider(planFixture));
    vi.stubGlobal("fetch", recovering);
    await expect(runGroqAi(planRequest)).resolves.toMatchObject({ kind: "ax-plan" });
    expect(recovering).toHaveBeenCalledTimes(2);
  });
});

describe("AX invalid numerical requirements", () => {
  function metric(text = "작업 시간 50% 절감") { const raw = outputFixture(); raw.poc.hypothesis = text; return raw; }
  it.each(["처리시간 5분 이내", "월 비용 1만원 이하", "초당 처리량 100건 이상", "초안 내용 90% 이상 일치", "오류 발생률 5% 미만"])("asks once to remove an unsupported plan target and never makes it a completion criterion: %s", async target => {
    const fetcher = respond({ ...planFixture, acceptance: [target] }, { ...planFixture, acceptance: ["수동 결과와 대조해 불일치 사유를 기록한다"] });
    await expect(runGroqAi(planRequest)).resolves.toMatchObject({ kind: "ax-plan", plan: { acceptance: ["수동 결과와 대조해 불일치 사유를 기록한다"] } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    // A model that keeps the value still yields a usable plan; the instruction model holds it for user confirmation.
    respond({ ...planFixture, acceptance: [target] }, { ...planFixture, acceptance: [target] });
    const kept = await runGroqAi(planRequest);
    if (kept.kind !== "ax-plan") throw new Error("unexpected result");
    const prompt = buildAllInOnePrompt(kept.plan, "codex", { diagnosis: diagnosisFixture });
    expect(prompt.split("### 수치 목표 (사용자 확인 전 구현 완료 기준 아님)")[1]?.split("###")[0]).toContain(target);
    expect(prompt.split("### 업무 전체 완료 기준")[1]?.split("###")[0] ?? "").not.toContain(target);
  });
  it("preserves an explicitly supplied user performance target", async () => {
    const acceptance = ["사용자 목표: 처리시간 5분 이내"];
    respond({ ...planFixture, acceptance });
    await expect(runGroqAi({ ...planRequest, task: { ...planRequest.task, description: "사용자 목표: 처리시간 5분 이내" } })).resolves.toMatchObject({ kind: "ax-plan", plan: { acceptance } });
  });
  it("rejects invented thresholds unless regeneration removes them", async () => {
    const fetcher = respond(facts, metric(), outputFixture());
    const result = await runGroqAi(request);
    expect(result.kind === "ax-diagnosis" && result.diagnosis.poc.hypothesis).toBe(outputFixture().poc.hypothesis);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("does not return a still-invalid corrected diagnosis", async () => {
    const fetcher = respond(facts, metric(), metric("오류 발생률 5% 미만"));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("shares a bounded budget across extraction, provider errors and correction", async () => {
    const unavailable = () => new Response("{}", { status: 503, headers: { "retry-after": "0" } });
    const fetcher = vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(provider(facts)).mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(provider(metric()));
    vi.stubGlobal("fetch", fetcher);
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("keeps all three provider usages but never logs original tasks or evidence", async () => {
    respond({ facts: [{ field: "steps", source: "description", quote: "PRIVATE_TASK_CONTENT" }], conflicts: [] }, metric(), outputFixture());
    await runGroqAi({ ...request, description: "PRIVATE_TASK_CONTENT", attachmentSummary: "PRIVATE_ATTACHMENT_CONTENT" });
    expect(console.info).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.info).mock.calls[0][1]).toMatchObject({ cumulativePromptTokens: 300, cumulativeCompletionTokens: 1500, cumulativeTotalTokens: 1800, semanticCorrected: true });
    for (const secret of ["PRIVATE_TASK_CONTENT", "PRIVATE_ATTACHMENT_CONTENT", "test-ax-secret", "작업 시간 50% 절감"]) expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(secret);
  });
  it("keeps schema rejection when a correction returns an invalid object", async () => {
    respond(facts, metric(), { invalid: true });
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
  });
  it("asks once for empty step judgements, target flow and risks of a grounded procedure, but keeps a valid answer if that fails", async () => {
    const withSteps = facts;
    const empty = { ...outputFixture(), toBe: [], risks: [], technicalChecks: [] };
    const fetcher = respond(withSteps, empty, outputFixture());
    await expect(runGroqAi(request)).resolves.toMatchObject({ diagnosis: { toBe: outputFixture().toBe, risks: outputFixture().risks } });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetcher.mock.calls[2][1].body).messages.at(-1).content).toContain("toBe, risks");
    respond(withSteps, empty, { invalid: true });
    await expect(runGroqAi(request)).resolves.toMatchObject({ diagnosis: { toBe: [], risks: [] } });
    // An extraction without a stated procedure is asked once more; the wider answer is kept, and a
    // grounded set without a procedure does not demand a target flow.
    const noSteps = respond(withoutSteps, withoutSteps, empty);
    await expect(runGroqAi(request)).resolves.toMatchObject({ diagnosis: { toBe: [] } });
    expect(noSteps).toHaveBeenCalledTimes(3);
    const recovered = respond(withoutSteps, facts, outputFixture());
    await expect(runGroqAi(request)).resolves.toMatchObject({ diagnosis: { asIs: { steps: ["입력 표를 취합하여"] } } });
    expect(recovered).toHaveBeenCalledTimes(3);
  });
  it("fills a target flow and risks that two whole answers left empty with one focused pass, never with unvalidated content", async () => {
    const empty = { ...outputFixture(), toBe: [], risks: [] };
    const gaps = { toBe: outputFixture().toBe, risks: ["입력 표 형식이 확인되지 않아 취합 결과가 누락될 수 있음"] };
    const fetcher = respond(facts, empty, empty, gaps);
    await expect(runGroqAi(request)).resolves.toMatchObject({ diagnosis: { toBe: gaps.toBe, risks: gaps.risks, asIs: { steps: ["입력 표를 취합하여"] } } });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(console.info).toHaveBeenLastCalledWith("[AI][Groq]", expect.objectContaining({
      attempt: 4, maxAttempts: 4, cumulativePromptTokens: 400, cumulativeCompletionTokens: 2000, cumulativeTotalTokens: 2400,
    }));
    const focused = JSON.parse(JSON.parse(fetcher.mock.calls[3][1].body).messages[1].content);
    expect(focused).toMatchObject({ missing: ["toBe", "risks"], asIs: { steps: ["입력 표를 취합하여"] } });
    // A focused answer that invents a performance figure is discarded: the gap stays visible.
    respond(facts, empty, empty, { ...gaps, risks: ["작업 시간 50% 절감 실패 위험"] });
    await expect(runGroqAi(request)).resolves.toMatchObject({ diagnosis: { toBe: [], risks: [] } });
    // Without a confirmed procedure there is nothing to build a target flow from.
    const noSteps = respond(withoutSteps, withoutSteps, empty);
    await expect(runGroqAi(request)).resolves.toMatchObject({ diagnosis: { toBe: [], risks: [] } });
    expect(noSteps).toHaveBeenCalledTimes(3);
  });
  it("skips focused repair when extraction and whole-answer correction have consumed the request budget", async () => {
    const empty = { ...outputFixture(), toBe: [], risks: [] };
    const fetcher = respond(withoutSteps, facts, empty, empty);
    const result = await runGroqAi(request);
    expect(result).toMatchObject({ diagnosis: { toBe: [], risks: [], asIs: { steps: ["입력 표를 취합하여"] } } });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(console.info).toHaveBeenLastCalledWith("[AI][Groq]", expect.objectContaining({
      attempt: 4, maxAttempts: 4, cumulativeTotalTokens: 2400,
    }));
    expect(JSON.parse(fetcher.mock.calls[3][1].body).response_format.json_schema.name).not.toBe("worklens_ax_diagnosis_gaps");
  });
  it("counts a failed focused call without retrying beyond four calls, preserving the valid diagnosis", async () => {
    const empty = { ...outputFixture(), risks: [] };
    const fetcher = respond(facts, empty, empty);
    fetcher.mockResolvedValueOnce(new Response("{}", { status: 503, headers: { "retry-after": "0" } }));
    const result = await runGroqAi(request);
    expect(result).toMatchObject({ diagnosis: {
      toBe: empty.toBe, risks: [], stepAssessments: empty.stepAssessments, poc: empty.poc,
      decisionGate: empty.decisionGate, operation: empty.operation, nextAction: empty.nextAction,
      asIs: { steps: ["입력 표를 취합하여"] },
    } });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(console.info).toHaveBeenLastCalledWith("[AI][Groq]", expect.objectContaining({
      attempt: 4, maxAttempts: 4, cumulativeTotalTokens: 1800,
    }));
    expect(console.error).not.toHaveBeenCalled();
  });
  it("fills only missing fields and rejects attachment copies without changing AS-IS or other diagnosis fields", async () => {
    const empty = { ...outputFixture(), risks: [] };
    const gaps = { toBe: [{ ...outputFixture().toBe[0], step: "기존 목표 대체 금지" }], risks: ["입력 표 대조가 필요함"] };
    respond(facts, empty, empty, gaps);
    const result = await runGroqAi(request);
    expect(result).toMatchObject({ diagnosis: { toBe: empty.toBe, risks: gaps.risks, asIs: { steps: ["입력 표를 취합하여"] }, decisionGate: empty.decisionGate } });
    const attachmentSummary = "첨부의 개인 자료 내용으로 이루어진 긴 원문 문장입니다.".repeat(6);
    respond(facts, empty, empty, { ...gaps, risks: [attachmentSummary] });
    await expect(runGroqAi({ ...request, attachmentSummary })).resolves.toMatchObject({ diagnosis: { toBe: empty.toBe, risks: [] } });
  });
});
