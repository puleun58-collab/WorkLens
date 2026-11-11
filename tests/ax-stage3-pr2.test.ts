import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGroqAi } from "@/server/groq";
import { axMessages } from "@/lib/ax/prompt";
import { AX_DIAGNOSIS_RESPONSE_SCHEMA } from "@/lib/ax/prompt";
import { applyCurrentFacts, currentFactAssessment, RequiredChecksOverflowError, resolveCurrentFacts } from "@/lib/ax/current-facts";
import { narrativeFields, validateAxSemantics } from "@/lib/ax/semantic";
import { userNumberMetric, userNumberRates, userNumberRetention, userNumbers, userNumberTargets } from "@/lib/ax/observation";
import { ApiError } from "@/server/http";
import { outputFixture } from "./fixtures/ax";

// Evidence grade: UNIT_MOCK. fetch is mocked; nothing here shows how the live provider behaves.
const request = { kind: "ax-diagnosis" as const, name: "취합", description: "입력 표를 취합하여 담당자 승인을 받습니다.", details: {} };
const stepFact = { field: "steps", source: "description", quote: "입력 표를 취합하여" };
const partialFacts = { facts: [{ field: "inputs", source: "description", quote: "입력 표" }, { field: "humanDecisions", source: "description", quote: "담당자 승인을 받습니다" }], conflicts: [] };
const facts = { facts: [...partialFacts.facts, stepFact], conflicts: [] };
const conflict = { field: "cycle", left: { source: "description", quote: "입력 표" }, right: { source: "description", quote: "담당자 승인" } };
beforeEach(() => { process.env.GROQ_API_KEY = "test-ax-secret"; vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { delete process.env.GROQ_API_KEY; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const provider = (payload: unknown) => Response.json({ choices: [{ message: { content: typeof payload === "string" ? payload : JSON.stringify(payload) } }], usage: { prompt_tokens: 100, completion_tokens: 500, total_tokens: 600 } });
const jvf = () => Response.json({ error: { message: "Failed to validate JSON", type: "invalid_request_error", code: "json_validate_failed" } }, { status: 400 });
function respond(...responses: Response[]) {
  const fetcher = vi.fn();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
type Stage = Record<string, string | number | boolean | undefined>;
const stages = (channel: "info" | "error" = "info"): Stage[] => (vi.mocked(console[channel]).mock.calls.at(-1)![1] as { axStages: Stage[] }).axStages;
const stage = (name: string, channel: "info" | "error" = "info") => stages(channel).filter(entry => entry.stage === name);
type Output = ReturnType<typeof outputFixture>;
function answer(edit: (raw: Output) => void = () => {}) { const raw = outputFixture(); edit(raw); return raw; }
const diagnosisOf = async (pending: ReturnType<typeof runGroqAi>) => { const result = await pending; if (result.kind !== "ax-diagnosis") throw new Error("unexpected result"); return result.diagnosis; };
const confirmedChecks = (count: number) => Array.from({ length: count }, (_, index) => ({ topic: `확인 항목 ${index + 1}`, status: "확인됨" as const, note: "담당자가 확인함" }));

describe("PR-2 A: a failed repeat extraction keeps the facts already verified", () => {
  it("continues with the first answer's grounding when the repeat call is refused as malformed JSON", async () => {
    const fetcher = respond(provider(partialFacts), jvf(), provider(answer()));
    const diagnosis = await diagnosisOf(runGroqAi(request));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(diagnosis.asIs.inputs).toEqual(["입력 표"]);
    expect(diagnosis.asIs.steps).toEqual([]);
    expect(diagnosis.grounding?.facts.map(fact => fact.field).sort()).toEqual(["humanDecisions", "inputs", "purpose"]);
    expect(stage("current-facts-call-failed")).toEqual([expect.objectContaining({ attempt: 2, reason: "json-validate-failed" })]);
    // The call order is extraction, extraction, diagnosis: no call was added for the failure.
    expect(stages().filter(entry => entry.status).map(entry => entry.stage)).toEqual(["worklens_ax_current_facts", "worklens_ax_current_facts", "worklens_ax_diagnosis"]);
  });
  it("continues when the repeat call returns a body that is not a completion", async () => {
    const fetcher = respond(provider(partialFacts), Response.json({ unexpected: true }), provider(answer()));
    await expect(runGroqAi(request)).resolves.toMatchObject({ kind: "ax-diagnosis" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(stage("current-facts-call-failed")[0]).toMatchObject({ reason: "invalid-output" });
  });
  it("never accepts an unverified fact from the failed repeat: only quotes found in the input remain", async () => {
    respond(provider({ facts: [...partialFacts.facts, { field: "systems", source: "description", quote: "입력에 없는 ERP" }], conflicts: [] }), jvf(), provider(answer()));
    const diagnosis = await diagnosisOf(runGroqAi(request));
    expect(diagnosis.asIs.systems).toEqual([]);
    expect(JSON.stringify(diagnosis.grounding)).not.toContain("ERP");
  });
  it("still ends on provider failures of the repeat call: rate limit, auth, outage and other rejections", async () => {
    const cases: [Response[], string, number][] = [
      [[new Response("{}", { status: 429, headers: { "retry-after": "2" } })], "AI_RATE_LIMITED", 2],
      [[new Response("{}", { status: 401 })], "AI_NOT_CONFIGURED", 2],
      [[new Response("{}", { status: 503, headers: { "retry-after": "0" } }), new Response("{}", { status: 503, headers: { "retry-after": "0" } })], "AI_PROVIDER_UNAVAILABLE", 3],
      [[new Response("{}", { status: 504, headers: { "retry-after": "0" } }), new Response("{}", { status: 504, headers: { "retry-after": "0" } })], "AI_TIMEOUT", 3],
      [[Response.json({ error: { message: "bad", code: "invalid_request" } }, { status: 400 })], "AI_PROVIDER_REJECTED", 2],
    ];
    for (const [responses, code, calls] of cases) {
      const fetcher = respond(provider(partialFacts), ...responses, provider(answer()));
      await expect(runGroqAi(request)).rejects.toMatchObject({ code });
      expect(fetcher).toHaveBeenCalledTimes(calls);
    }
  });
  it("still ends when the first call fails or when no extraction is ever verified", async () => {
    const first = respond(jvf(), provider(facts), provider(answer()));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "AI_PROVIDER_REJECTED", status: 502 });
    expect(first).toHaveBeenCalledTimes(1);
    const both = respond(provider("not json"), provider({ facts: "broken" }), provider(answer()));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502, message: expect.stringContaining("기존 진단은 유지됩니다") });
    expect(both).toHaveBeenCalledTimes(2);
    const repeatRefused = respond(provider("not json"), jvf(), provider(answer()));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "AI_PROVIDER_REJECTED" });
    expect(repeatRefused).toHaveBeenCalledTimes(2);
  });
  it("keeps the four-call ceiling after an absorbed failure", async () => {
    const violating = answer(raw => { raw.poc.hypothesis = "작업 시간 50% 절감"; });
    const fetcher = respond(provider(partialFacts), jvf(), provider(violating), provider(violating), provider(answer()));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe("PR-2 B: more required checks than the ten-item contract", () => {
  const conflicted = { facts: facts.facts, conflicts: [conflict] };
  it("raises a typed error instead of dropping a required check, and still fits exactly ten", () => {
    const grounding = resolveCurrentFacts(request, conflicted);
    expect(grounding.conflicts).toHaveLength(1);
    expect(applyCurrentFacts(answer(raw => { raw.technicalChecks = confirmedChecks(8); }), grounding).technicalChecks).toHaveLength(10);
    expect(() => applyCurrentFacts(answer(raw => { raw.technicalChecks = confirmedChecks(9); }), grounding)).toThrow(RequiredChecksOverflowError);
  });
  it("answers the eleven-item case as a refused diagnosis (502), not as an internal error", async () => {
    const fetcher = respond(provider(conflicted), provider(answer(raw => { raw.technicalChecks = confirmedChecks(9); })));
    const failure = await runGroqAi(request).catch(error => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(stage("required-checks-overflow", "error")).toHaveLength(1);
  });
  it("returns the ten-item boundary with both server checks first and every model check kept", async () => {
    respond(provider(conflicted), provider(answer(raw => { raw.technicalChecks = confirmedChecks(8); })));
    const diagnosis = await diagnosisOf(runGroqAi(request));
    expect(diagnosis.technicalChecks.map(check => check.topic)).toEqual(["업무 정보 상충", "현재 사용 시스템·자료 접근 방식", ...confirmedChecks(8).map(check => check.topic)]);
  });
  it("keeps the existing refusal of ten model checks beside a conflict", async () => {
    respond(provider(conflicted), provider(answer(raw => { raw.technicalChecks = confirmedChecks(10); })));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
  });
  it("answers an overflow inside the correction as 502 as well", async () => {
    const violating = answer(raw => { raw.poc.hypothesis = "작업 시간 50% 절감"; });
    respond(provider(conflicted), provider(violating), provider(answer(raw => { raw.technicalChecks = confirmedChecks(9); })));
    const failure = await runGroqAi(request).catch(error => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
  });
});

describe("PR-2 C: the prompt names the owner values the schema accepts", () => {
  const system = axMessages(request)[0].content;
  it("tells the model which owner values are valid and keeps 담당자 for narrative text", () => {
    expect(system).toContain("승인과 검토 주체는 \"담당자\"로 표현하세요.");
    expect(system).toMatch(/owner 값은 "시스템", "AI", "사용자" 중 하나만[^\n]*"담당자"는 owner 값으로 쓰지/);
  });
  it("leaves the owner enum of the response schema unchanged", () => {
    const schema = JSON.stringify(AX_DIAGNOSIS_RESPONSE_SCHEMA);
    expect(schema.match(/"enum":\["시스템","AI","사용자"\]/g)).toHaveLength(2);
    expect(schema).not.toContain("담당자");
  });
  it("accepts each valid owner and still refuses 담당자 without mapping it", async () => {
    respond(provider(facts), provider(answer(raw => { raw.stepAssessments[0].owner = "사용자"; raw.toBe[0].owner = "AI"; })));
    const diagnosis = await diagnosisOf(runGroqAi(request));
    expect([diagnosis.stepAssessments[0].owner, diagnosis.toBe[0].owner]).toEqual(["사용자", "AI"]);
    for (const edit of [(raw: Output) => { (raw.stepAssessments[0] as { owner: string }).owner = "담당자"; }, (raw: Output) => { (raw.toBe[1] as { owner: string }).owner = "담당자"; }]) {
      const fetcher = respond(provider(facts), provider(answer(edit)));
      await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(String(stage("initial-parse-failed", "error")[0].zodIssues)).toMatch(/^(stepAssessments\.0|toBe\.1)\.owner:invalid_value$/);
    }
  });
});

describe("PR-2 D: server-confirmed fields are set before the answer is validated", () => {
  const long = "가".repeat(501);
  const server = currentFactAssessment(resolveCurrentFacts(request, facts));
  it("does not refuse an answer for a malformed value the server replaces anyway", async () => {
    const edits: [(raw: Record<string, unknown>) => void, string][] = [
      [raw => { (raw.asIs as { inputs: string[] }).inputs = [long]; }, "asIs"],
      [raw => { raw.informationSufficiency = "unknown"; }, "informationSufficiency"],
      [raw => { delete raw.asIs; }, "asIs"],
      [raw => { (raw.asIs as Record<string, unknown>).extra = "x"; raw.informationSufficiency = 3; }, "asIs,informationSufficiency"],
    ];
    for (const [edit, replaced] of edits) {
      const raw = answer() as unknown as Record<string, unknown>;
      edit(raw);
      const fetcher = respond(provider(facts), provider(raw));
      const diagnosis = await diagnosisOf(runGroqAi(request));
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(diagnosis.asIs).toEqual(server.asIs);
      expect(diagnosis.informationSufficiency).toBe(server.informationSufficiency);
      expect(stage("initial-server-fields-replaced")).toEqual([expect.objectContaining({ reason: replaced })]);
    }
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(long);
  });
  it("records nothing when the model's own values were valid, and returns the same server values", async () => {
    respond(provider(facts), provider(answer()));
    const diagnosis = await diagnosisOf(runGroqAi(request));
    expect(diagnosis.asIs).toEqual(server.asIs);
    expect(stage("initial-server-fields-replaced")).toEqual([]);
  });
  it("still requires every field the model owns to be valid", async () => {
    const edits: [(raw: Record<string, unknown>) => void, RegExp][] = [
      [raw => { raw.risks = [long]; }, /^risks\.0:too_big$/],
      [raw => { (raw.factors as unknown[]).pop(); }, /factors/],
      [raw => { (raw.decisionGate as { verdict: string }).verdict = "maybe"; }, /^decisionGate\.verdict:invalid_value$/],
      [raw => { (raw.nextAction as { label: string }).label = ""; }, /^nextAction\.label:too_small$/],
      [raw => { (raw.technicalChecks as { status: string }[])[0].status = "모름"; }, /^technicalChecks\.0\.status:invalid_value$/],
      [raw => { raw.followUpQuestions = [""]; }, /^followUpQuestions\.0:too_small$/],
      [raw => { raw.extra = true; }, /unrecognized_keys/],
    ];
    for (const [edit, issue] of edits) {
      const raw = answer() as unknown as Record<string, unknown>;
      edit(raw);
      (raw.asIs as { inputs: string[] }).inputs = [long];
      const fetcher = respond(provider(facts), provider(raw));
      await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(stage("initial-parse-failed", "error")[0]).toMatchObject({ reason: "schema", zodIssues: expect.stringMatching(issue) });
    }
  });
  it("still refuses unparseable JSON and non-object answers before anything is replaced", async () => {
    for (const [content, reason] of [["{\"asIs\":", "json-parse"], ["[]", "schema"], ["null", "schema"]] as const) {
      respond(provider(facts), provider(content));
      await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
      expect(stage("initial-parse-failed", "error")[0]).toMatchObject({ reason });
      expect(stage("initial-server-fields-replaced", "error")).toEqual([]);
    }
  });
  it("runs the Semantic Guard after the replacement: a violation is corrected, and blocks when it stays", async () => {
    const violating = () => { const raw = answer(value => { value.poc.hypothesis = "작업 시간 50% 절감"; }); raw.asIs.inputs = [long]; return raw; };
    const corrected = respond(provider(facts), provider(violating()), provider(answer()));
    await expect(runGroqAi(request)).resolves.toMatchObject({ kind: "ax-diagnosis" });
    expect(corrected).toHaveBeenCalledTimes(3);
    const order = stages().map(entry => entry.stage);
    expect(order.indexOf("initial-server-fields-replaced")).toBeLessThan(order.indexOf("initial-parsed"));
    expect(order.indexOf("initial-parsed")).toBeLessThan(order.indexOf("current-facts-applied"));
    expect(order.indexOf("current-facts-applied")).toBeLessThan(order.indexOf("semantic-violations"));
    respond(provider(facts), provider(violating()), provider(violating()));
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
    expect(stage("whole-correction-server-fields-replaced", "error")).toHaveLength(1);
  });
  it("still refuses an attachment copy anywhere in what the model wrote, replaced fields included", async () => {
    const attachmentSummary = "첨부에서 읽은 내부 절차 설명 문장으로 스무 글자를 넘는 원문";
    for (const edit of [(raw: Output) => { raw.risks = [attachmentSummary]; }, (raw: Output) => { raw.asIs.purpose = attachmentSummary; }, (raw: Output) => { raw.asIs.inputs = [attachmentSummary, long]; }]) {
      respond(provider(facts), provider(answer(edit)));
      await expect(runGroqAi({ ...request, attachmentSummary })).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502 });
      expect(stage("initial-parse-failed", "error")[0]).toMatchObject({ reason: "attachment-copy" });
    }
  });
});

describe("PR-2 official user number metrics", () => {
  const numbered = { ...request, description: "매월 20건의 입력 표를 취합하여 담당자 3명이 승인합니다.",
    details: { minutesPerRun: 30, runsPerMonth: 20, people: 3, cycle: "주 2회", goal: "목표: 처리 시간 10분 이내", painPoints: "현재 오류율 5%" } };
  const repetition = (raw: Output) => raw.factors.find(factor => factor.key === "repetition")!;
  const measure = (raw: Output, source: typeof request = numbered) =>
    userNumberMetric(raw, userNumbers(source), narrativeFields(raw), new Set(validateAxSemantics(raw, source).map(violation => violation.field)));
  const placeAll = (raw: Output) => {
    repetition(raw).rationale = "월 20회, 주 2회 반복됩니다.";
    raw.poc.evaluation = ["회당 30분 소요 현황을 기준으로 수동 결과와 대조한다"];
    raw.poc.success = ["사용자 목표 처리 시간 10분 이내 충족 여부를 확인한다"];
  };
  const rates = (raw: Output, source: typeof request = numbered) => {
    const targets = userNumberTargets(userNumbers(source));
    return userNumberRates([{ uTotal: targets.uTotal!, uPositioned: targets.uPositioned!, ...measure(raw, source) }]);
  };

  it("1·2: a zero denominator is N/A, not 0% or 100%", () => {
    const onlyOther = { ...request, details: { people: 3, painPoints: "현재 오류율 5%" } };
    expect(userNumberTargets(userNumbers(onlyOther))).toEqual({ uTotal: 2, uPositioned: 0, uNa: "no-positioned-numbers" });
    expect(rates(answer(raw => { raw.risks = ["담당자 3명의 승인 지연"]; }), onlyOther)).toMatchObject({ positionedReflectionRate: null, preservationRate: 50, evaluatedShare: 0 });
    expect(userNumberTargets(userNumbers(request))).toEqual({ uTotal: 0, uPositioned: 0, uNa: "no-user-numbers" });
    expect(rates(answer(), request)).toMatchObject({ positionedReflectionRate: null, preservationRate: null, evaluatedShare: null });
    expect(userNumberTargets(undefined)).toEqual({ uNa: "measurement-error" });
    expect(userNumberRates([])).toMatchObject({ positionedReflectionRate: null, preservationRate: null, evaluatedShare: null });
  });
  it("3: every positioned number at its position is 100%", () => {
    expect(measure(answer(placeAll))).toEqual({ uPositionedOk: 4, uPreserved: 4 });
    expect(rates(answer(placeAll))).toMatchObject({ uTotal: 6, uPositioned: 4, positionedReflectionRate: 100, preservationRate: 66.7, evaluatedShare: 66.7 });
  });
  it("4·10: a missing number lowers the rate and never shrinks the denominator", () => {
    const partial = answer(raw => { placeAll(raw); raw.poc.evaluation = ["수동 결과와 대조한다"]; raw.poc.success = ["대조 통과"]; });
    expect(measure(partial)).toEqual({ uPositionedOk: 2, uPreserved: 2, uFailures: "absent:2" });
    expect(rates(partial)).toMatchObject({ uPositioned: 4, positionedReflectionRate: 50 });
    expect(measure(answer())).toEqual({ uPositionedOk: 0, uPreserved: 0, uFailures: "absent:4" });
    expect(rates(answer())).toMatchObject({ uTotal: 6, uPositioned: 4, positionedReflectionRate: 0, preservationRate: 0 });
    // The targets depend on the request only: any answer, or none, leaves them as they were.
    expect(userNumberTargets(userNumbers(numbered))).toEqual({ uTotal: 6, uPositioned: 4 });
  });
  it("5: a number that appears only elsewhere is not a success of the primary metric", () => {
    const misplaced = answer(raw => { raw.risks = ["월 20건, 주 2회, 회당 30분 소요"]; raw.humanInLoop = ["사용자 목표 처리 시간 10분 이내 여부를 담당자가 확인"]; });
    expect(measure(misplaced)).toEqual({ uPositionedOk: 0, uPreserved: 4, uFailures: "elsewhere:4" });
    expect(rates(misplaced)).toMatchObject({ positionedReflectionRate: 0, preservationRate: 66.7 });
  });
  it("6: people, painPoints and description numbers stay out of the primary denominator and in the auxiliary one", () => {
    const withOther = answer(raw => { placeAll(raw); raw.risks = ["담당자 3명의 승인 지연", "현재 오류율 5% 수준의 입력 품질"]; });
    expect(userNumbers(numbered).filter(number => number.group === "other")).toHaveLength(2);
    expect(measure(withOther)).toEqual({ uPositionedOk: 4, uPreserved: 6 });
    expect(rates(withOther)).toMatchObject({ uPositioned: 4, uTotal: 6, positionedReflectionRate: 100, preservationRate: 100 });
  });
  it("7: a changed unit or meaning is neither reflected nor preserved", () => {
    const unit = answer(raw => { placeAll(raw); raw.poc.evaluation = ["회당 30시간 소요 현황과 대조한다"]; repetition(raw).rationale = "월 20명, 주 2회 반복됩니다."; });
    expect(measure(unit)).toEqual({ uPositionedOk: 2, uPreserved: 2, uFailures: "unit:2" });
    // The user's current duration restated as a predicted saving is refused by the Semantic Guard.
    const prediction = answer(raw => { placeAll(raw); raw.poc.evaluation = ["회당 30분 단축을 확인한다"]; });
    expect(validateAxSemantics(prediction, numbered).map(violation => violation.field)).toEqual(["poc.evaluation[0]"]);
    expect(measure(prediction)).toEqual({ uPositionedOk: 3, uPreserved: 3, uFailures: "context:1" });
    // A goal figure without the "사용자 목표" label is kept as a number but is not the user's goal at its position.
    const unlabelled = answer(raw => { placeAll(raw); raw.poc.success = ["처리 시간 10분 이내 충족 여부를 확인한다"]; });
    expect(measure(unlabelled)).toEqual({ uPositionedOk: 3, uPreserved: 4, uFailures: "context:1" });
    expect(measure(answer(raw => { placeAll(raw); raw.poc.evaluation = ["회당 130분 소요"]; }))).toMatchObject({ uPositionedOk: 3, uFailures: "absent:1" });
  });
  it("8: a value repeated across fields is one target, owned by the first group, and identifiers without a unit are not numbers", () => {
    const repeated = { ...request, description: "월 20회 취합합니다. 문서번호 20261103, 담당 3팀.", details: { runsPerMonth: 20, cycle: "월 20회", goal: "목표: 월 20회 유지", painPoints: "월 20회 반복" } };
    expect(userNumbers(repeated).map(number => number.group)).toEqual(["runs"]);
    expect(userNumberTargets(userNumbers(repeated))).toEqual({ uTotal: 1, uPositioned: 1 });
    const twice = answer(raw => { repetition(raw).rationale = "월 20회 반복됩니다."; raw.risks = ["월 20회 반복", "월 20회 누락"]; });
    expect(measure(twice, repeated)).toEqual({ uPositionedOk: 1, uPreserved: 1 });
  });
  it("9: the PR-1 counters and the official counters are computed together and logged without values", async () => {
    const first = answer(raw => { repetition(raw).rationale = "월 20회 반복됩니다."; raw.risks = ["회당 30분 소요"]; });
    expect(userNumberRetention(first, userNumbers(numbered))).toEqual({ uTotal: 6, uPositioned: 4, uRetainedPositioned: 1, uRetainedAnywhere: 2, uGroups: "runs:1/1,cycle:0/1,minutes:0/1,goal:0/1,other:0/2" });
    respond(provider(facts), provider(first));
    await runGroqAi(numbered);
    expect(stages()[0]).toEqual({ stage: "user-number-targets", attempt: 0, uTotal: 6, uPositioned: 4 });
    for (const name of ["initial-parsed", "current-facts-applied", "completed"]) {
      expect(stage(name)[0]).toMatchObject({ uTotal: 6, uPositioned: 4, uRetainedPositioned: 1, uRetainedAnywhere: 2, uGroups: "runs:1/1,cycle:0/1,minutes:0/1,goal:0/1,other:0/2",
        uPositionedOk: 1, uPreserved: 2, uFailures: "elsewhere:1,absent:2" });
    }
    const logged = JSON.stringify(vi.mocked(console.info).mock.calls);
    for (const secret of ["20회", "30분", "입력 표", "오류율", "10분"]) expect(logged).not.toContain(secret);
  });
  it("10: the targets are logged before the first call and survive a failed diagnosis", async () => {
    respond(jvf());
    await expect(runGroqAi(numbered)).rejects.toMatchObject({ code: "AI_PROVIDER_REJECTED" });
    expect(stages("error")[0]).toEqual({ stage: "user-number-targets", attempt: 0, uTotal: 6, uPositioned: 4 });
    expect(stages("error").some(entry => "uPositionedOk" in entry)).toBe(false);
    respond(provider(facts), provider(answer()));
    await runGroqAi(request);
    expect(stages()[0]).toEqual({ stage: "user-number-targets", attempt: 0, uTotal: 0, uPositioned: 0, uNa: "no-user-numbers" });
    // A failed request keeps its denominators; a returned answer adds its numerators.
    expect(userNumberRates([{ uTotal: 6, uPositioned: 4 }, { uTotal: 6, uPositioned: 4, uPositionedOk: 4, uPreserved: 6 }, { uTotal: 0, uPositioned: 0 }]))
      .toEqual({ uTotal: 12, uPositioned: 8, uPositionedOk: 4, uPreserved: 6, positionedReflectionRate: 50, preservationRate: 50, evaluatedShare: 66.7 });
  });
  it("judges the corrected answer on the same targets when a whole regeneration drops a number", async () => {
    const violating = answer(raw => { placeAll(raw); raw.poc.hypothesis = "작업 시간 50% 절감"; });
    respond(provider(facts), provider(violating), provider(answer()));
    await runGroqAi(numbered);
    expect(stage("current-facts-applied")[0]).toMatchObject({ uPositioned: 4, uPositionedOk: 4 });
    expect(stage("whole-correction-accepted")[0]).toMatchObject({ uPositioned: 4, uPositionedOk: 0, uFailures: "absent:4" });
  });
});
