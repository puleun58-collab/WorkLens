import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGroqAi } from "@/server/groq";
import { axDiagnosisOutputSchema } from "@/lib/ax/schema";
import { classifyJsonValidateFailure, providerErrorBodySignals, userNumberRetention, userNumbers, userNumberTokens, zodIssueSummary } from "@/lib/ax/observation";
import { outputFixture } from "./fixtures/ax";

// Evidence grade: UNIT_MOCK. fetch is mocked; nothing here shows how the live provider behaves.
const request = { kind: "ax-diagnosis" as const, name: "취합", description: "입력 표를 취합하여 담당자 승인을 받습니다.", details: {} };
const facts = { facts: [{ field: "inputs", source: "description", quote: "입력 표" }, { field: "humanDecisions", source: "description", quote: "담당자 승인을 받습니다" }, { field: "steps", source: "description", quote: "입력 표를 취합하여" }], conflicts: [] };
beforeEach(() => { process.env.GROQ_API_KEY = "test-ax-secret"; vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { delete process.env.GROQ_API_KEY; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const provider = (payload: unknown) => Response.json({ choices: [{ message: { content: typeof payload === "string" ? payload : JSON.stringify(payload) } }], usage: { prompt_tokens: 100, completion_tokens: 500, total_tokens: 600 } });
const jvf = (body: Record<string, unknown> = {}, error: Record<string, unknown> = {}) => Response.json({ error: { message: "Failed to validate JSON", type: "invalid_request_error", code: "json_validate_failed", ...error }, ...body }, { status: 400 });
function respond(...responses: Response[]) {
  const fetcher = vi.fn();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
type Stage = Record<string, string | number | boolean | undefined>;
const stages = (channel: "info" | "error" = "error"): Stage[] => (vi.mocked(console[channel]).mock.calls.at(-1)![1] as { axStages: Stage[] }).axStages;
const stage = (name: string, channel: "info" | "error" = "error") => stages(channel).filter(entry => entry.stage === name);

describe("A-0 json_validate_failed classification", () => {
  it("classifies by the share of the completion budget and never guesses without a token count", () => {
    expect(classifyJsonValidateFailure(3000, 3000)).toEqual({ jvf: "truncated", completionRatio: 1 });
    expect(classifyJsonValidateFailure(2850, 3000)).toEqual({ jvf: "truncated", completionRatio: 0.95 });
    expect(classifyJsonValidateFailure(2849, 3000)).toEqual({ jvf: "format", completionRatio: 0.95 });
    expect(classifyJsonValidateFailure(900, 3000)).toEqual({ jvf: "format", completionRatio: 0.3 });
    expect(classifyJsonValidateFailure(undefined, 3000)).toEqual({ jvf: "unclassified" });
    expect(classifyJsonValidateFailure(Number.NaN, 3000)).toEqual({ jvf: "unclassified" });
  });
  it("keeps only size signals of an error body", () => {
    expect(providerErrorBodySignals({ usage: { completion_tokens: 3000 }, error: { failed_generation: "{\"asIs\":{\"purpose\":\"PRIVATE" } }))
      .toEqual({ completionTokens: 3000, failedGenerationChars: 27,failedGenerationParses: false });
    expect(providerErrorBodySignals({ error: { failed_generation: "{\"a\":1}" } })).toEqual({ failedGenerationChars: 7, failedGenerationParses: true });
    expect(providerErrorBodySignals({ error: { failed_generation: 5 }, usage: { completion_tokens: "many" } })).toEqual({});
    expect(providerErrorBodySignals(null)).toEqual({});
  });
  it("records a truncated rejection of the initial diagnosis and still fails exactly as before", async () => {
    const fetcher = respond(provider(facts), jvf({ usage: { completion_tokens: 3000 } }, { failed_generation: "{\"asIs\":{\"purpose\":\"PRIVATE_GENERATION" }));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "AI_PROVIDER_REJECTED", status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(stage("worklens_ax_diagnosis")).toEqual([expect.objectContaining({
      attempt: 2, status: "http-400", providerCode: "json_validate_failed", jvf: "truncated", completionTokens: 3000,
      maxCompletionTokens: 3000, completionRatio: 1, failedGenerationParses: false })]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("PRIVATE_GENERATION");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("Failed to validate JSON");
  });
  it("records a complete but schema-refused generation as format, and an error without usage as unclassified", async () => {
    respond(provider(facts), jvf({ usage: { completion_tokens: 1200 } }, { failed_generation: "{\"a\":1}" }));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "AI_PROVIDER_REJECTED" });
    expect(stage("worklens_ax_diagnosis")[0]).toMatchObject({ jvf: "format", completionRatio: 0.4, failedGenerationParses: true });
    respond(provider(facts), jvf());
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "AI_PROVIDER_REJECTED" });
    expect(stage("worklens_ax_diagnosis")[0]).toMatchObject({ jvf: "unclassified", maxCompletionTokens: 3000 });
    expect(stage("worklens_ax_diagnosis")[0]).not.toHaveProperty("completionRatio");
  });
  it("records a rejection inside the current-fact loop, which still ends the diagnosis", async () => {
    const fetcher = respond(jvf({ usage: { completion_tokens: 4000 } }));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "AI_PROVIDER_REJECTED", status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(stage("worklens_ax_current_facts")).toEqual([expect.objectContaining({ jvf: "truncated", maxCompletionTokens: 4000, completionRatio: 1 })]);
  });
  it("adds the completion budget to successful calls and leaves other provider errors unclassified", async () => {
    respond(provider(facts), provider(outputFixture()));
    await runGroqAi(request);
    expect(stage("worklens_ax_diagnosis", "info")[0]).toMatchObject({ status: "http-200", completionTokens: 500, maxCompletionTokens: 3000 });
    expect(stage("worklens_ax_diagnosis", "info")[0]).not.toHaveProperty("jvf");
    respond(provider(facts), Response.json({ error: { message: "bad", code: "invalid_request" } }, { status: 400 }));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "AI_PROVIDER_REJECTED" });
    expect(stage("worklens_ax_diagnosis")[0]).not.toHaveProperty("jvf");
  });
  it("does not record AX observations for other operations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jvf({ usage: { completion_tokens: 900 } })));
    await expect(runGroqAi({ kind: "polish", text: "문장입니다.", mode: "concise" } as never)).rejects.toMatchObject({ code: "AI_PROVIDER_REJECTED" });
    expect(vi.mocked(console.error).mock.calls.at(-1)![1]).not.toHaveProperty("axStages");
  });
});

describe("B-4 schema issue paths", () => {
  it("summarises issues as path:code without messages, values or unknown key names", () => {
    const raw = outputFixture();
    const invalid = { ...raw, risks: ["가".repeat(501)], decisionGate: { ...raw.decisionGate, verdict: "maybe" }, PRIVATE_KEY: 1,
      stepAssessments: [{ ...raw.stepAssessments[0], owner: "담당자" }] };
    const summary = zodIssueSummary(axDiagnosisOutputSchema.safeParse(invalid).error)!;
    expect(summary.zodIssueCount).toBe(4);
    expect(summary.zodIssues.split(",").sort()).toEqual(["(root):unrecognized_keys", "decisionGate.verdict:invalid_value", "risks.0:too_big", "stepAssessments.0.owner:invalid_value"]);
    expect(JSON.stringify(summary)).not.toMatch(/PRIVATE_KEY|담당자|maybe|가가/);
    expect(zodIssueSummary(new Error("x"))).toBeUndefined();
    expect(zodIssueSummary({ issues: [{ path: ["한글 키", 3], code: "Bad Code" }] })).toEqual({ zodIssues: "?.3:unknown", zodIssueCount: 1 });
    expect(zodIssueSummary({ issues: Array.from({ length: 25 }, () => ({ path: ["risks", 0], code: "too_big" })) })).toMatchObject({ zodIssueCount: 25, zodIssues: expect.stringMatching(/^(?:risks\.0:too_big,){19}risks\.0:too_big$/) });
  });
  it("records the failing paths of the initial diagnosis and keeps the 502", async () => {
    const raw = outputFixture();
    const fetcher = respond(provider(facts), provider({ ...raw, stepAssessments: [{ ...raw.stepAssessments[0], owner: "담당자" }] }));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(stage("initial-parse-failed")).toEqual([{ stage: "initial-parse-failed", attempt: 2, reason: "schema", zodIssues: "stepAssessments.0.owner:invalid_value", zodIssueCount: 1 }]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("담당자");
  });
  it("separates unparseable JSON and attachment copies from schema failures", async () => {
    respond(provider(facts), provider("{\"asIs\":"));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    expect(stage("initial-parse-failed")).toEqual([{ stage: "initial-parse-failed", attempt: 2, reason: "json-parse" }]);
    const summary = "첨부의 개인 자료 내용으로 이루어진 긴 원문 문장입니다.".repeat(6);
    const raw = outputFixture();
    respond(provider(facts), provider({ ...raw, asIs: { ...raw.asIs, purpose: summary } }));
    await expect(runGroqAi({ ...request, attachmentSummary: summary })).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    expect(stage("initial-parse-failed")).toEqual([{ stage: "initial-parse-failed", attempt: 2, reason: "attachment-copy" }]);
  });
  it("records current-fact extraction failures per attempt without changing the loop", async () => {
    const fetcher = respond(provider({ facts: "invalid" }), provider("not json"));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(stage("current-facts-parse-failed")).toEqual([
      expect.objectContaining({ attempt: 1, reason: "schema", zodIssues: expect.stringContaining("facts:invalid_type") }),
      { stage: "current-facts-parse-failed", attempt: 2, reason: "json-parse" },
    ]);
    const recovering = respond(provider({ facts: "invalid" }), provider(facts), provider(outputFixture()));
    await expect(runGroqAi(request)).resolves.toMatchObject({ kind: "ax-diagnosis" });
    expect(recovering).toHaveBeenCalledTimes(3);
    expect(stage("current-facts-parse-failed", "info")).toHaveLength(1);
  });
  it("records the paths of a refused correction and of a refused gap answer", async () => {
    const violating = outputFixture();
    violating.poc.hypothesis = "작업 시간 50% 절감";
    respond(provider(facts), provider(violating), provider({ invalid: true }));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    expect(stage("whole-correction-parse-failed")[0]).toMatchObject({ attempt: 3, reason: "schema", zodIssues: expect.stringContaining(":") });
    respond(provider(facts), provider({ ...outputFixture(), toBe: [], risks: [] }), provider({ invalid: true }));
    await expect(runGroqAi(request)).resolves.toMatchObject({ diagnosis: { toBe: [], risks: [] } });
    expect(stage("focused-failed", "info")[0]).toMatchObject({ reason: "format-error", zodIssues: expect.stringContaining(":") });
  });
});

describe("C-0 user number retention", () => {
  const numbered = { ...request, description: "매월 20건의 입력 표를 취합하여 담당자 3명이 승인합니다.",
    details: { minutesPerRun: 30, runsPerMonth: 20, people: 3, cycle: "주 2회", goal: "목표: 처리 시간 10분 이내", painPoints: "현재 오류율 5%" } };
  function answer(edit: (raw: ReturnType<typeof outputFixture>) => void = () => {}) { const raw = outputFixture(); edit(raw); return raw; }
  const repetition = (raw: ReturnType<typeof outputFixture>) => raw.factors.find(factor => factor.key === "repetition")!;

  it("tokenises numbers with units, including thousands separators and unit aliases", () => {
    expect([...userNumberTokens("월 1,000건, 2.5시간, 30 분, 5퍼센트, 3번, 6개월, 12만원, 3분기")].sort()).toEqual(["1000|건", "12|만원", "2.5|시간", "30|분", "3|회", "5|%", "6|개월"]);
    expect(userNumberTokens("번호 없음")).toEqual(new Set());
  });
  it("builds U once per distinct value, owned by the most specific group", () => {
    expect(userNumbers(numbered).map(number => number.group)).toEqual(["runs", "minutes", "cycle", "goal", "other", "other"]);
    expect(userNumbers(request)).toEqual([]);
    expect(userNumbers({ ...request, details: { minutesPerRun: 90 } })[0].accepted).toEqual(["90|분", "1.5|시간"]);
    expect(userNumbers({ ...request, details: { minutesPerRun: 45 } })[0].accepted).toEqual(["45|분"]);
    expect(userNumbers({ ...request, details: { minutesPerRun: 0, runsPerMonth: 100000 } }).map(number => number.accepted[0])).toEqual(["100000|회", "0|분"]);
  });
  it("reports only the total when the user supplied no numbers", () => {
    expect(userNumberRetention(answer(), userNumbers(request))).toEqual({ uTotal: 0 });
  });
  it("counts nothing as retained when the answer repeats no user number", () => {
    expect(userNumberRetention(answer(), userNumbers(numbered))).toEqual({ uTotal: 6, uPositioned: 4, uRetainedPositioned: 0, uRetainedAnywhere: 0, uGroups: "runs:0/1,cycle:0/1,minutes:0/1,goal:0/1,other:0/2" });
  });
  it("counts a number at its designated position only", () => {
    const placed = answer(raw => {
      repetition(raw).rationale = "월 20회, 주 2회 반복됩니다.";
      raw.poc.evaluation = ["회당 30분 소요 현황을 기준으로 수동 결과와 대조한다"];
      raw.poc.success = ["사용자 목표 처리 시간 10분 이내 충족 여부를 확인한다"];
      raw.risks = ["담당자 3명의 승인 지연"];
    });
    expect(userNumberRetention(placed, userNumbers(numbered))).toEqual({ uTotal: 6, uPositioned: 4, uRetainedPositioned: 4, uRetainedAnywhere: 5, uGroups: "runs:1/1,cycle:1/1,minutes:1/1,goal:1/1,other:1/2" });
    const misplaced = answer(raw => {
      raw.risks = ["월 20건, 주 2회, 회당 30분"];
      raw.poc.success = ["처리 시간 10분 이내 충족 여부를 확인한다"];
    });
    expect(userNumberRetention(misplaced, userNumbers(numbered))).toMatchObject({ uRetainedPositioned: 0, uRetainedAnywhere: 4, uGroups: "runs:0/1,cycle:0/1,minutes:0/1,goal:0/1,other:0/2" });
  });
  it("does not count the server-quoted AS-IS as the model retaining a number", () => {
    const quoted = answer(raw => { raw.asIs.steps = ["매월 20건의 입력 표를 취합하여 담당자 3명이 승인"]; raw.asIs.trigger = "주 2회"; });
    expect(userNumberRetention(quoted, userNumbers(numbered))).toMatchObject({ uRetainedPositioned: 0, uRetainedAnywhere: 0 });
  });
  it("does not match a different number that merely contains the digits", () => {
    const near = answer(raw => { repetition(raw).rationale = "월 120회, 연 2,020건"; raw.poc.evaluation = ["회당 130분"]; });
    expect(userNumberRetention(near, userNumbers(numbered))).toMatchObject({ uRetainedPositioned: 0, uRetainedAnywhere: 0 });
  });
  it("logs retention counts per stage without the values, and leaves the returned diagnosis untouched", async () => {
    const first = answer(raw => { repetition(raw).rationale = "월 20회 반복됩니다."; });
    respond(provider(facts), provider(first));
    const result = await runGroqAi(numbered);
    if (result.kind !== "ax-diagnosis") throw new Error("unexpected result");
    expect(repetition(result.diagnosis as never).rationale).toBe("월 20회 반복됩니다.");
    expect(result.diagnosis).not.toHaveProperty("uTotal");
    for (const name of ["initial-parsed", "current-facts-applied", "completed"]) {
      expect(stage(name, "info")[0]).toMatchObject({ uTotal: 6, uPositioned: 4, uRetainedPositioned: 1, uRetainedAnywhere: 1, uGroups: "runs:1/1,cycle:0/1,minutes:0/1,goal:0/1,other:0/2" });
    }
    const logged = JSON.stringify(vi.mocked(console.info).mock.calls);
    for (const secret of ["20회", "입력 표", "오류율", "10분"]) expect(logged).not.toContain(secret);
  });
  it("shows a number lost by whole regeneration and the violating field paths of both answers", async () => {
    const violating = answer(raw => { repetition(raw).rationale = "월 20회 반복됩니다."; raw.poc.hypothesis = "작업 시간 50% 절감"; raw.poc.success = ["정확도 95% 이상"]; });
    const fetcher = respond(provider(facts), provider(violating), provider(answer()));
    await expect(runGroqAi(numbered)).resolves.toMatchObject({ kind: "ax-diagnosis" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(stage("current-facts-applied", "info")[0]).toMatchObject({ uRetainedPositioned: 1 });
    expect(stage("whole-correction-accepted", "info")[0]).toMatchObject({ uRetainedPositioned: 0 });
    expect(stage("semantic-violations", "info")).toHaveLength(1);
    expect(String(stage("semantic-violations", "info")[0].reason).split(",").sort()).toEqual(["poc.hypothesis:invented_time_saving", "poc.success:invented_accuracy_claim"]);
    respond(provider(facts), provider(violating), provider(answer(raw => { raw.risks = ["오류 발생률 5% 미만"]; })));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
    expect(stage("whole-correction-violations")[0]).toMatchObject({ attempt: 3, reason: expect.stringMatching(/^risks:/) });
  });
});
