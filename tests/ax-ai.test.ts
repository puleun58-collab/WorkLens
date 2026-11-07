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
  it("rejects invented thresholds unless the field repair removes them", async () => {
    const fetcher = respond(facts, metric(), { poc: outputFixture().poc });
    const result = await runGroqAi(request);
    expect(result.kind === "ax-diagnosis" && result.diagnosis.poc.hypothesis).toBe(outputFixture().poc.hypothesis);
    expect(fetcher).toHaveBeenCalledTimes(3);
    // The third call repairs only the violating key, not the whole answer.
    const repair = JSON.parse(fetcher.mock.calls[2][1].body);
    expect(repair.response_format.json_schema.name).toBe("worklens_ax_diagnosis_repair");
    expect(Object.keys(repair.response_format.json_schema.schema.properties)).toEqual(["poc"]);
  });
  it("does not return a still-invalid repaired diagnosis", async () => {
    const fetcher = respond(facts, metric(), { poc: metric("오류 발생률 5% 미만").poc });
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
  it("repairs only missing target flow and risks without regenerating a valid diagnosis", async () => {
    // Keep the fixture's open required check: an empty list would (correctly) receive the
    // server-derived system-access check, which is not what this case exercises.
    const empty = { ...outputFixture(), toBe: [], risks: [] };
    const gaps = { toBe: outputFixture().toBe, risks: ["입력 표 대조가 필요함"] };
    const fetcher = respond(facts, empty, gaps);
    await expect(runGroqAi(request)).resolves.toMatchObject({ diagnosis: { asIs: { inputs: ["입력 표"] }, toBe: gaps.toBe, risks: gaps.risks, technicalChecks: empty.technicalChecks, decisionGate: empty.decisionGate } });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetcher.mock.calls[2][1].body).response_format.json_schema.name).toBe("worklens_ax_diagnosis_gaps");
    expect(console.info).toHaveBeenLastCalledWith("[AI][Groq]", expect.objectContaining({
      attempt: 3, maxAttempts: 4, cumulativeTotalTokens: 1800,
      axStages: expect.arrayContaining([expect.objectContaining({ stage: "focused-start", reason: "toBe,risks" })]),
    }));
    respond(facts, empty, { invalid: true });
    await expect(runGroqAi(request)).resolves.toMatchObject({ diagnosis: { toBe: [], risks: [] } });
  });
  it("preserves a valid focused field when another focused field fails semantic validation", async () => {
    const empty = { ...outputFixture(), toBe: [], risks: [] };
    respond(facts, empty, { toBe: outputFixture().toBe, risks: ["작업 시간 50% 절감 실패 위험"] });
    await expect(runGroqAi(request)).resolves.toMatchObject({ diagnosis: { toBe: outputFixture().toBe, risks: [] } });
  });
  it("does not request a target flow without grounded current steps", async () => {
    const empty = { ...outputFixture(), toBe: [], risks: [] };
    const fetcher = respond(withoutSteps, withoutSteps, empty);
    await expect(runGroqAi(request)).resolves.toMatchObject({ diagnosis: { toBe: [], risks: [] } });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("uses the last shared attempt for focused repair after a repeated fact extraction", async () => {
    const empty = { ...outputFixture(), toBe: [], risks: [] };
    const gaps = { toBe: outputFixture().toBe, risks: ["입력 표 대조가 필요함"] };
    const fetcher = respond(withoutSteps, facts, empty, gaps);
    await expect(runGroqAi(request)).resolves.toMatchObject({ diagnosis: { toBe: gaps.toBe, risks: gaps.risks } });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetcher.mock.calls[3][1].body).response_format.json_schema.name).toBe("worklens_ax_diagnosis_gaps");
  });
  it("skips focused repair when provider retries exhaust the shared budget", async () => {
    const empty = { ...outputFixture(), toBe: [], risks: [] };
    const fetcher = respond(withoutSteps, facts);
    fetcher.mockResolvedValueOnce(new Response("{}", { status: 503, headers: { "retry-after": "0" } }));
    fetcher.mockResolvedValueOnce(provider(empty));
    await expect(runGroqAi(request)).resolves.toMatchObject({ diagnosis: { toBe: [], risks: [] } });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(console.info).toHaveBeenLastCalledWith("[AI][Groq]", expect.objectContaining({
      axStages: expect.arrayContaining([expect.objectContaining({ stage: "focused-skipped", reason: "budget-exhausted" })]),
    }));
  });
  it("retains the valid diagnosis when focused calls fail within the four-call ceiling", async () => {
    const empty = { ...outputFixture(), risks: [] };
    const fetcher = respond(facts, empty);
    fetcher.mockResolvedValue(new Response("{}", { status: 503, headers: { "retry-after": "0" } }));
    await expect(runGroqAi(request)).resolves.toMatchObject({ diagnosis: {
      toBe: empty.toBe, risks: [], stepAssessments: empty.stepAssessments, poc: empty.poc,
      decisionGate: empty.decisionGate, operation: empty.operation, nextAction: empty.nextAction,
      asIs: { steps: ["입력 표를 취합하여"] },
    } });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(console.error).not.toHaveBeenCalled();
  });
  it("fills only missing fields and rejects attachment copies without changing AS-IS or other diagnosis fields", async () => {
    const empty = { ...outputFixture(), risks: [] };
    const gaps = { toBe: [{ ...outputFixture().toBe[0], step: "기존 목표 대체 금지" }], risks: ["입력 표 대조가 필요함"] };
    respond(facts, empty, gaps);
    await expect(runGroqAi(request)).resolves.toMatchObject({ diagnosis: { toBe: empty.toBe, risks: gaps.risks, decisionGate: empty.decisionGate } });
    const attachmentSummary = "첨부의 개인 자료 내용으로 이루어진 긴 원문 문장입니다.".repeat(6);
    respond(facts, empty, { ...gaps, risks: [attachmentSummary] });
    await expect(runGroqAi({ ...request, attachmentSummary })).resolves.toMatchObject({ diagnosis: { toBe: empty.toBe, risks: [] } });
  });
});

// DESIGN §6 scenarios: field-level repair, json_validate_failed handling, 502 sources and log masking.
describe("AX diagnosis repair, malformed answers and provider failures", () => {
  const JVF_MESSAGE = "Failed to validate JSON. Please adjust your prompt.";
  const jvf = () => new Response(JSON.stringify({ error: { message: JVF_MESSAGE, type: "invalid_request_error", code: "json_validate_failed" } }), { status: 400 });
  const content = (text: string) => Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 500, total_tokens: 600 } });
  const status = (code: number) => new Response("{}", { status: code, headers: { "retry-after": "0" } });
  function sequence(...responses: unknown[]) {
    const fetcher = vi.fn();
    for (const response of responses) fetcher.mockResolvedValueOnce(response instanceof Response ? response : provider(response));
    // Any call beyond the scripted ones would still succeed, so an exact count proves no extra request.
    fetcher.mockImplementation(async () => provider(outputFixture()));
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }
  function withPoc(success: string[]) { const raw = outputFixture(); raw.poc = { ...raw.poc, success }; return raw; }
  function metric(text: string) { const raw = outputFixture(); raw.poc.hypothesis = text; return raw; }
  const logs = () => JSON.stringify([...vi.mocked(console.info).mock.calls, ...vi.mocked(console.error).mock.calls]);
  /** (b) No task text, quoted evidence, model output, provider error message or key in any info/error log. */
  function expectMaskedLogs(...modelOutput: string[]) {
    const text = logs();
    for (const secret of ["test-ax-secret", request.description, "입력 표를 취합하여", "담당자 승인을 받습니다", JVF_MESSAGE, ...modelOutput]) expect(text).not.toContain(secret);
  }
  const stages = () => [...vi.mocked(console.info).mock.calls, ...vi.mocked(console.error).mock.calls]
    .flatMap(call => (call[1] as { axStages?: Array<Record<string, unknown>> }).axStages ?? []);
  const lastLog = (kind: "info" | "error") => vi.mocked(console[kind]).mock.calls.at(-1)?.[1] as Record<string, unknown>;
  const body = (fetcher: ReturnType<typeof vi.fn>, index: number) => JSON.parse(fetcher.mock.calls[index][1].body);

  it("S1 completes a valid first answer without repair", async () => {
    const fetcher = sequence(facts, outputFixture());
    await expect(runGroqAi(request)).resolves.toMatchObject({ kind: "ax-diagnosis" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(stages()).toContainEqual(expect.objectContaining({ stage: "completed" }));
    expect(lastLog("info")).not.toHaveProperty("semanticCorrected");
    expect(stages()).toContainEqual(expect.objectContaining({ stage: "worklens_ax_diagnosis", finishLength: false }));
    expectMaskedLogs("규칙 기반 변환");
  });

  it("S2 repairs only the violating PoC and keeps every other first-answer field", async () => {
    const raw = withPoc(["정확도 90% 이상"]);
    const repaired = { poc: { ...raw.poc, success: ["수동 결과와 전수 대조해 불일치 사유를 기록한다"] } };
    const baseline = sequence(facts, outputFixture());
    const valid = await runGroqAi(request);
    expect(baseline).toHaveBeenCalledTimes(2);
    vi.mocked(console.info).mockClear();
    const fetcher = sequence(facts, raw, repaired);
    const result = await runGroqAi(request);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const repair = body(fetcher, 2);
    expect(repair.response_format.json_schema.name).toBe("worklens_ax_diagnosis_repair");
    expect(Object.keys(repair.response_format.json_schema.schema.properties)).toEqual(["poc"]);
    expect(repair.max_completion_tokens).toBe(1_500);
    if (result.kind !== "ax-diagnosis" || valid.kind !== "ax-diagnosis") throw new Error("unexpected result");
    expect(result.diagnosis.poc.success).toEqual(repaired.poc.success);
    for (const key of ["stepAssessments", "technicalChecks", "decisionGate", "factors", "toBe", "risks", "roadmap", "asIs"] as const) expect(result.diagnosis[key]).toEqual(valid.diagnosis[key]);
    expect(lastLog("info")).toMatchObject({ semanticCorrected: true, semanticInitialFields: ["poc.success"] });
    expect(stages()).toContainEqual(expect.objectContaining({ stage: "initial-parsed", violationFields: ["poc.success"], violationCategories: ["invented_accuracy_claim"] }));
    expect(stages()).toContainEqual(expect.objectContaining({ stage: "repair-applied", reason: "poc", userNumbersDropped: 0 }));
    expectMaskedLogs("정확도 90% 이상", "수동 결과와 전수 대조해 불일치 사유를 기록한다");
  });

  it("S3 fails a malformed whole first answer with nothing to repair from", async () => {
    const fetcher = sequence(facts, content("{"));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(lastLog("error")).toMatchObject({ failureCode: "INVALID_PROVIDER_OUTPUT" });
    expectMaskedLogs();
  });

  it("S3b re-requests the same first diagnosis once after json_validate_failed", async () => {
    const fetcher = sequence(facts, jvf(), outputFixture());
    await expect(runGroqAi(request)).resolves.toMatchObject({ kind: "ax-diagnosis" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2][1].body).toBe(fetcher.mock.calls[1][1].body);
    expect(stages()).toContainEqual(expect.objectContaining({ stage: "worklens_ax_diagnosis", status: "http-400", providerCode: "json_validate_failed" }));
    expect(console.error).not.toHaveBeenCalled();
    expectMaskedLogs();
  });

  it("S3c classifies a repeated json_validate_failed as invalid output, not a rejected request", async () => {
    const fetcher = sequence(facts, jvf(), jvf());
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(lastLog("error")).toMatchObject({ providerCode: "json_validate_failed", failureCode: "INVALID_PROVIDER_OUTPUT" });
    expectMaskedLogs();
  });

  it.each([
    ["a non-string risk", (raw: ReturnType<typeof outputFixture>) => ({ ...raw, risks: [123] })],
    ["an unknown TO-BE owner", (raw: ReturnType<typeof outputFixture>) => ({ ...raw, toBe: [{ ...raw.toBe[0], owner: "로봇" }] })],
  ])("S4 keeps whole-response validation: %s fails the diagnosis", async (_label, broken) => {
    const fetcher = sequence(facts, broken(outputFixture()));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expectMaskedLogs();
  });

  it("S5 merges a violating roadmap and missing TO-BE/risks in one repair call", async () => {
    const raw = { ...outputFixture(), toBe: [], risks: [] };
    raw.roadmap = [{ ...raw.roadmap[0], items: ["처리 시간 50% 단축"] }];
    const filled = { roadmap: outputFixture().roadmap, toBe: outputFixture().toBe, risks: ["입력 표 대조가 필요함"] };
    const fetcher = sequence(facts, raw, filled);
    const result = await runGroqAi(request);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const repair = body(fetcher, 2);
    expect(new Set(Object.keys(repair.response_format.json_schema.schema.properties))).toEqual(new Set(["roadmap", "toBe", "risks"]));
    expect(repair.max_completion_tokens).toBe(3_000);
    if (result.kind !== "ax-diagnosis") throw new Error("unexpected result");
    expect(result.diagnosis).toMatchObject(filled);
    for (const key of ["poc", "stepAssessments", "decisionGate", "factors", "nextAction", "operation"] as const) expect(result.diagnosis[key]).toEqual(raw[key]);
    expect(lastLog("info")).toMatchObject({ semanticCorrected: true });
    expectMaskedLogs("처리 시간 50% 단축", "입력 표 대조가 필요함");
  });

  it.each([
    ["malformed JSON", () => content("{")],
    ["json_validate_failed", jvf],
  ])("S6 fails when the PoC repair returns %s, without re-requesting or publishing the first answer", async (_label, failure) => {
    const fetcher = sequence(facts, withPoc(["정확도 90% 이상"]), failure());
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(lastLog("error")).toMatchObject({ failureCode: "INVALID_PROVIDER_OUTPUT", semanticCorrected: false });
    expectMaskedLogs("정확도 90% 이상");
  });

  it("S6c empties risks when only risks still violate after a malformed repair", async () => {
    const raw = { ...outputFixture(), risks: ["작업 시간 50% 절감 실패 위험"] };
    const fetcher = sequence(facts, raw, content("{"));
    const result = await runGroqAi(request);
    expect(fetcher).toHaveBeenCalledTimes(3);
    if (result.kind !== "ax-diagnosis") throw new Error("unexpected result");
    expect(result.diagnosis.risks).toEqual([]);
    for (const key of ["poc", "toBe", "stepAssessments", "decisionGate", "factors", "roadmap", "nextAction"] as const) expect(result.diagnosis[key]).toEqual(raw[key]);
    expect(JSON.stringify(result)).not.toContain("50% 절감");
    expect(stages()).toContainEqual(expect.objectContaining({ stage: "repair-rejected", reason: "risks" }));
    expect(stages()).toContainEqual(expect.objectContaining({ stage: "repair-emptied", reason: "risks" }));
    expectMaskedLogs("작업 시간 50% 절감 실패 위험");
  });

  it("S7 never makes a fifth call: a violation left after the budget is spent fails", async () => {
    const fetcher = sequence(withoutSteps, facts, status(503), withPoc(["정확도 90% 이상"]));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(stages()).toContainEqual(expect.objectContaining({ stage: "repair-skipped", reason: "budget-exhausted" }));
    expectMaskedLogs("정확도 90% 이상");
  });

  it("S8 maps a Groq 502 to an app 503 after one retry, and recovers when the retry succeeds", async () => {
    const failing = sequence(facts, status(502), status(502));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE", status: 503 });
    expect(failing).toHaveBeenCalledTimes(3);
    expectMaskedLogs();
    const recovering = sequence(facts, status(502), outputFixture());
    await expect(runGroqAi(request)).resolves.toMatchObject({ kind: "ax-diagnosis" });
    expect(recovering).toHaveBeenCalledTimes(3);
  });

  it("S9 keeps other provider rejections unretried and never logs the provider message", async () => {
    const message = "The model `openai/gpt-oss-120b` does not exist or you do not have access to it.";
    const fetcher = sequence(facts, new Response(JSON.stringify({ error: { message, type: "invalid_request_error", code: "model_not_found" } }), { status: 400 }));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "AI_PROVIDER_REJECTED", status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(lastLog("error")).toMatchObject({ providerCode: "model_not_found", failureCode: "AI_PROVIDER_REJECTED" });
    expect(lastLog("error").providerReason).toEqual(expect.any(String));
    expectMaskedLogs(message);
  });

  it("logs no task text, evidence or model output on a failed diagnosis either", async () => {
    sequence({ facts: [{ field: "steps", source: "description", quote: "PRIVATE_TASK_CONTENT" }], conflicts: [] }, metric("작업 시간 50% 절감"), { poc: metric("PRIVATE_MODEL_OUTPUT 오류 발생률 5% 미만").poc });
    await expect(runGroqAi({ ...request, description: "PRIVATE_TASK_CONTENT", attachmentSummary: "PRIVATE_ATTACHMENT_CONTENT" })).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    expect(console.error).toHaveBeenCalledTimes(1);
    for (const secret of ["PRIVATE_TASK_CONTENT", "PRIVATE_ATTACHMENT_CONTENT", "PRIVATE_MODEL_OUTPUT", "test-ax-secret", "작업 시간 50% 절감"]) expect(logs()).not.toContain(secret);
  });

  it("keeps a user-stated target as a fact without repair", async () => {
    const description = `${request.description} 사용자 목표: 처리시간 5분 이내`;
    const fetcher = sequence(facts, withPoc(["사용자 목표: 처리시간 5분 이내"]));
    await expect(runGroqAi({ ...request, description })).resolves.toMatchObject({ diagnosis: { poc: { success: ["사용자 목표: 처리시간 5분 이내"] } } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(lastLog("info")).not.toHaveProperty("semanticViolationCategories");
  });

  it("keeps a statutory rate from the input as a fact without repair", async () => {
    const description = `${request.description} 부가세 10% 적용`;
    const raw = outputFixture();
    raw.poc = { ...raw.poc, inputs: ["부가세 10%"] };
    const fetcher = sequence({ facts: [...facts.facts, { field: "inputs", source: "description", quote: "부가세 10%" }], conflicts: [] }, raw);
    const result = await runGroqAi({ ...request, description });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ diagnosis: { asIs: { inputs: expect.arrayContaining(["부가세 10%"]) }, poc: { inputs: ["부가세 10%"] } } });
    expect(lastLog("info")).not.toHaveProperty("semanticViolationCategories");
  });

  it("keeps factor scores and the gate verdict when a repair rewrites their narrative", async () => {
    const raw = outputFixture();
    raw.factors = raw.factors.map((factor, index) => index ? factor : { ...factor, rationale: "자동화하면 작업 시간 50% 절감" });
    raw.decisionGate = { verdict: "conditional", reasons: ["정확도 90% 이상 확인 후 진행"] };
    const repaired = {
      factors: raw.factors.map(factor => ({ ...factor, aiValue: 1, rationale: "등록된 반복 업무 근거" })),
      decisionGate: { verdict: "go", reasons: ["권한 확인 후 진행"] },
    };
    sequence(facts, raw, repaired);
    const result = await runGroqAi(request);
    if (result.kind !== "ax-diagnosis") throw new Error("unexpected result");
    expect(result.diagnosis.factors.map(factor => factor.aiValue)).toEqual(raw.factors.map(factor => factor.aiValue));
    expect(result.diagnosis.factors[0].rationale).toBe("등록된 반복 업무 근거");
    expect(result.diagnosis.decisionGate).toEqual({ verdict: "conditional", reasons: ["권한 확인 후 진행"] });
  });
});
