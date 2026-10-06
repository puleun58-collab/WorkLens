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
  it("binds the plan prompt to the diagnosed level, gate and human steps with an internal self-check", () => {
    const confirmed = confirmedAxDiagnosis(diagnosisFixture);
    const planPrompt = (factors: number[], patch: Partial<typeof confirmed> = {}) => axMessages({ kind: "ax-plan", target: "codex", task: { name: "취합", description: "설명", details: {} },
      diagnosis: { ...confirmed, ...patch, factors: confirmed.factors.map((factor, i) => ({ ...factor, aiValue: factors[i] })) } })[0].content;
    const go = { decisionGate: { verdict: "go" as const, reasons: [] }, technicalChecks: [] };
    expect(planPrompt([3, 2, 2, 2, 5, 4])).toContain("Level 0: 업무 정리·보조만 다루고 시스템 자동 실행을 넣지 마세요.");
    expect(planPrompt([4, 4, 3, 2, 4, 3])).toContain("Level 1: AI·도구가 결과를 만들어 제안하고 예외 검토·최종 승인은 담당자가 합니다. 완전 자동 실행을 넣지 마세요.");
    expect(planPrompt([4, 4, 4, 3, 3, 3], go)).toContain("Level 2: 반복·규칙 단계만 부분 자동화");
    expect(planPrompt([5, 5, 5, 5, 1, 1], go)).toContain("Level 3: 넓게 자동화할 수 있지만 안전·법률·권한·최종 책임 단계는 진단대로 담당자에게 둡니다.");
    expect(planPrompt([5, 5, 5, 5, 1, 1], go)).toContain("실행 상태 진행 가능: 구현을 진행할 수 있습니다.");
    expect(planPrompt([4, 4, 3, 2, 4, 3])).toContain("실행 상태 확인 후 진행: prerequisites가 확인되기 전 관련 기능을 확정 구현하도록 쓰지 마세요.");
    expect(planPrompt([5, 5, 5, 5, 1, 1], { decisionGate: { verdict: "no-go", reasons: ["권한 없음"] } })).toContain("실행 상태 진행 보류: 분석·PoC·준비 작업까지만");
    const prompt = planPrompt([4, 4, 3, 2, 4, 3]);
    for (const rule of ["정보 우선순위: 사용자 입력·업무 등록 > 확정 진단 > 합리적 추론", "담당자 수행 단계(담당자 승인)는 implementation에 넣지 말고",
      "자동 삭제·수정·승인·등록·전송·결재", "API·SDK·DB·인증·자동 로그인", "입력에 없는 조직명과 근거 없는 수치", "outOfScope 항목을 implementation",
      "정상·경계·실패 케이스", "내부적으로 점검해 고친 뒤 최종 JSON만 출력하세요. 점검 과정은 출력하지 마세요."]) expect(prompt).toContain(rule);
    expect(prompt.split("자동 삭제").length - 1).toBe(2);
  });
  it("never returns truncated or schema-invalid plans and keeps the provider retry policy", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {});
    const planRequest = { kind: "ax-plan" as const, target: "codex" as const, task: { name: "취합", description: "설명", details: {} }, diagnosis: confirmedAxDiagnosis(diagnosisFixture) };
    const raw = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 3000, total_tokens: 3001 } }), { status: 200 });
    const truncated = JSON.stringify(planFixture).slice(0, 200);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(raw(truncated)));
    await expect(runGroqAi(planRequest)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(provider({ ...planFixture, tests: undefined })));
    await expect(runGroqAi(planRequest)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    const recovering = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 503, headers: { "retry-after": "0" } })).mockResolvedValueOnce(provider(planFixture));
    vi.stubGlobal("fetch", recovering);
    await expect(runGroqAi(planRequest)).resolves.toEqual({ kind: "ax-plan", plan: planFixture });
    expect(recovering).toHaveBeenCalledTimes(2);
    const failing = vi.fn().mockImplementation(async () => new Response("{}", { status: 503, headers: { "retry-after": "0" } }));
    vi.stubGlobal("fetch", failing);
    await expect(runGroqAi(planRequest)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe("AX semantic correction within the shared provider budget", () => {
  function semanticInvalid(text = "작업 시간 50% 절감") {
    const diagnosis = outputFixture();
    diagnosis.poc.hypothesis = text;
    return diagnosis;
  }

  it("regenerates once with the correction instruction after a schema-valid unsupported metric", async () => {
    const fetcher = vi.fn<(url: string | URL | Request, options?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(provider(semanticInvalid())).mockResolvedValueOnce(provider(outputFixture()));
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(console, "info").mockImplementation(() => {});
    await expect(runGroqAi(request)).resolves.toEqual({ kind: "ax-diagnosis", diagnosis: outputFixture() });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetcher.mock.calls[0][1]?.body as string);
    const second = JSON.parse(fetcher.mock.calls[1][1]?.body as string);
    expect(second.messages).toEqual([...first.messages, {
      role: "user",
      content: "이전 응답에 사용자가 제공하지 않은 정량 성과 주장(절감률·정확도·자동화율·ROI·효율 등의 수치)이 포함되어 있었습니다. 성과 수치를 생성하지 말고, 필요한 경우 수치 대신 측정 방법·대조 기준·검증 기준을 작성하세요. 동일한 JSON 스키마로 전체 응답을 다시 작성하세요. 특히 PoC 가설·평가·성공·실패 기준에도 백분율·비율·절감 수치를 쓰지 말고 '수동 결과와 전수 대조', '불일치 건수 기록' 같은 측정·대조 방법으로만 작성하세요. 예: 성공 기준은 '수동 결과와 전수 대조해 불일치 항목과 사유를 기록한다', 실패 기준은 '누락·중요 불일치가 확인되면 중단하고 원인을 기록한다'처럼 수치 없이 쓰세요. 정확도·일치율·절감률을 퍼센트나 비율로 표현하지 마세요. 입력에 실제로 있는 현재 상태 수치(횟수·소요 시간·인원)만 사실로 다시 쓸 수 있습니다. 사용자가 목표로 제시한 수치는 '사용자 목표'라고 밝혀 그대로 쓸 수 있지만, 자동화로 달성·단축된다고 예측하지 마세요. 입력에 있는 현재 상태 수치와 사용자 목표는 삭제하지 말고 위 규칙에 맞게 다시 쓰세요. 검출된 위반 범주: invented_time_saving. 검출 위치: poc.hypothesis.",
    }]);
    expect(second.reasoning_effort).toBe("low");
    expect(second.max_completion_tokens).toBe(3000);
  });

  it("rejects two semantic-invalid responses after exactly two calls", async () => {
    const fetcher = vi.fn().mockImplementation(async () => provider(semanticInvalid()));
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT", status: 502, message: "AI 진단 결과를 검증하지 못했습니다. 다시 시도하세요." });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not correct after a provider retry has consumed the shared budget", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }), { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(provider(semanticInvalid()));
    vi.stubGlobal("fetch", fetcher);
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(logger.mock.calls[0][1]).toMatchObject({ attempt: 2, maxAttempts: 2, semanticCorrected: false });
  });

  it("accumulates both completions' token usage and logs only semantic categories", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(provider(semanticInvalid())).mockResolvedValueOnce(provider(outputFixture()));
    vi.stubGlobal("fetch", fetcher);
    const logger = vi.spyOn(console, "info").mockImplementation(() => {});
    await runGroqAi({ ...request, description: "PRIVATE_TASK_CONTENT" });
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger.mock.calls[0][1]).toMatchObject({
      cumulativePromptTokens: 200, cumulativeCompletionTokens: 1000, cumulativeTotalTokens: 1200,
      attempt: 2, maxAttempts: 2, semanticViolationCategories: ["invented_time_saving"], semanticCorrected: true,
    });
    for (const text of ["PRIVATE_TASK_CONTENT", "작업 시간 50% 절감", "test-ax-secret", "poc.hypothesis"]) expect(JSON.stringify(logger.mock.calls)).not.toContain(text);
  });

  it("logs the latest deduplicated categories when the correction still fails", async () => {
    const diagnosis = semanticInvalid("정확도 95% 또는 정확도 96%");
    diagnosis.risks = ["ROI 150%"];
    const fetcher = vi.fn().mockResolvedValueOnce(provider(semanticInvalid())).mockResolvedValueOnce(provider(diagnosis));
    vi.stubGlobal("fetch", fetcher);
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    expect(logger.mock.calls[0][1]).toMatchObject({ semanticViolationCategories: ["invented_roi", "invented_accuracy_claim"], semanticCorrected: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("omits semantic metadata for a valid first response", async () => {
    const fetcher = vi.fn().mockResolvedValue(provider(outputFixture()));
    vi.stubGlobal("fetch", fetcher);
    const logger = vi.spyOn(console, "info").mockImplementation(() => {});
    await runGroqAi(request);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(logger.mock.calls[0][1]).not.toHaveProperty("semanticViolationCategories");
    expect(logger.mock.calls[0][1]).not.toHaveProperty("semanticCorrected");
  });

  it("preserves schema rejection on the correction without a third call", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(provider(semanticInvalid())).mockResolvedValueOnce(provider({ invalid: true }));
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runGroqAi(request)).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
