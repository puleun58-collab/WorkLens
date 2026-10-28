import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt, planSummary } from "@/lib/ax/guide";
import { executionGate, executionGateWithExamples, gateBlockReasons, gatePrerequisites, gatePrerequisitesWithExamples } from "@/lib/ax/policy";
import { confirmedStateNames, parseStateNames, resolveDecisionPoints } from "@/lib/ax/decision-points";
import { exampleHoldReasons, exampleResultRow, partitionExamples } from "@/lib/ax/example-results";
import { AX_DIAGNOSIS_RESPONSE_SCHEMA } from "@/lib/ax/prompt";
import { axDiagnosisOutputSchema, confirmedAxDiagnosis } from "@/lib/ax/schema";
import { validateAxStateV2 } from "@/lib/ax/transfer";
import type { AxDiagnosis, DecisionPoint, ExampleResult } from "@/lib/ax/types";
import { diagnosisFixture, planFixture, taskFixture } from "./fixtures/ax";

const readyDiagnosis = (overrides: Partial<AxDiagnosis> = {}): AxDiagnosis => ({
  ...structuredClone(diagnosisFixture),
  decisionGate: { verdict: "go", reasons: [] },
  technicalChecks: [{ topic: "시스템 접근", status: "확인됨", note: "API 확인 완료" }],
  ...overrides,
});

const examples = (count: number): ExampleResult[] =>
  Array.from({ length: count }, (_, i) => ({ input: `입력 행 ${i + 1}`, expectedState: "정상", memo: `예시 ${i + 1}` }));

const promptFor = (diagnosis: AxDiagnosis, opts: { exampleResults?: ExampleResult[]; context?: string } = {}) =>
  buildAllInOnePrompt(planFixture, "codex", { diagnosis, taskName: "테스트 업무", context: opts.context ?? "", exampleResults: opts.exampleResults });

describe("AX 1차 MVP 개선 — 고정 결정 지점 D1~D7", () => {
  it("진단 결과에 D1~D7이 항상 포함되고 기본값이 미확정이다", () => {
    const points = resolveDecisionPoints(diagnosisFixture);
    expect(points.map(point => point.id)).toEqual(["D1", "D2", "D3", "D4", "D5", "D6", "D7"]);
    expect(points.every(point => point.status === "미확정")).toBe(true);
    const prompt = promptFor(diagnosisFixture);
    for (const id of ["D1", "D2", "D3", "D4", "D5", "D6", "D7"]) expect(prompt).toContain(id);
  });

  it("사용자가 확정하지 않은 항목의 detail이 지시문에 확정 규칙으로 들어가지 않는다", () => {
    const detail = "UNCONFIRMED-RULE-XYZ";
    const diagnosis = readyDiagnosis({
      decisionPoints: [{ id: "D1", status: "미확정", detail } as DecisionPoint],
    });
    expect(resolveDecisionPoints(diagnosis).find(point => point.id === "D1")?.detail).toBeUndefined();
    expect(promptFor(diagnosis)).not.toContain(detail);
    expect(promptFor(diagnosis)).toContain("D1 기준과 매칭 — 미확정");
  });

  it("D4 또는 D5가 미확정이면 지시문에서 기존 조건부 보류 체계로 처리된다", () => {
    // 02 checks는 기술 점검 카드 전용이므로 D4/D5를 넣지 않는다 (ax-prereq 계약 유지).
    // 대신 지시문 §1 결정 지점 블록과 §5 미확정 항목 처리에서 보류로 다룬다.
    const summary = planSummary(diagnosisFixture, planFixture, "", { exampleResults: [] });
    expect(summary.checks.every(check => !check.topic.includes("결정 지점"))).toBe(true);
    const prompt = promptFor(diagnosisFixture);
    expect(prompt).toContain("D4 결과 상태 — 미확정");
    expect(prompt).toContain("D5 판단 불가 — 미확정");
    expect(prompt).toContain("D4 또는 D5가 미확정이므로 기존 조건부 보류 체계로 처리한다");
  });
});

describe("AX 1차 MVP 개선 — 예시 결과 보류 사유", () => {
  it("확정 예시가 3건 미만이면 '예시 결과 미확정' 보류 사유가 붙는다", () => {
    expect(exampleHoldReasons(examples(2))).toEqual(["예시 결과 미확정"]);
    expect(exampleHoldReasons(examples(0))).toEqual(["예시 결과 미확정"]);
    expect(exampleHoldReasons(examples(3))).toEqual([]);
    const summary = planSummary(readyDiagnosis(), planFixture, "", { exampleResults: examples(2) });
    expect(summary.checks.some(check => check.topic === "예시 결과 미확정")).toBe(true);
    expect(executionGateWithExamples(readyDiagnosis(), examples(2))).toBe("conditional");
    expect(executionGateWithExamples(readyDiagnosis(), examples(3))).toBe("ready");
  });

  it("기존 보류 사유의 판정 결과가 변하지 않는다 (회귀)", () => {
    const blocked = readyDiagnosis({ decisionGate: { verdict: "no-go", reasons: ["실행 승인 불가"] } });
    expect(executionGate(blocked)).toBe("blocked");
    expect(executionGateWithExamples(blocked, examples(0))).toBe("blocked");
    expect(gateBlockReasons(blocked)).toContain("실행 승인 불가");
    const conditional = diagnosisFixture;
    expect(executionGate(conditional)).toBe("conditional");
    expect(gatePrerequisites(conditional)).toContain("권한 확인 후 진행");
    const withExamples = gatePrerequisitesWithExamples(conditional, examples(1));
    expect(withExamples).toContain("권한 확인 후 진행");
    expect(withExamples).toContain("예시 결과 미확정");
    // 예시 목록이 전달되지 않으면 기존 판정 함수의 결과는 그대로이다.
    expect(gatePrerequisites(conditional)).not.toContain("예시 결과 미확정");
  });

  it("예시 결과와 결정 지점이 기존 IndexedDB 레코드 검증(선택 필드)을 통과한다", () => {
    const diagnosis = readyDiagnosis({
      decisionPoints: [
        { id: "D4", status: "확정", detail: "정상, 오류(확정), 확인 필요" },
        { id: "D5", status: "확정", detail: "확인 필요" },
      ],
    });
    const state = validateAxStateV2({
      schemaVersion: 2,
      tasks: [{ ...taskFixture("task-1", diagnosis), exampleResults: examples(3) }],
      selectedTaskId: "task-1",
      step: 4,
    });
    expect(state.tasks[0].exampleResults).toHaveLength(3);
    expect(state.tasks[0].diagnosis?.decisionPoints).toHaveLength(2);
    // 필드가 없는 기존 데이터도 그대로 통과한다.
    const legacy = validateAxStateV2({ schemaVersion: 2, tasks: [taskFixture("task-1", diagnosisFixture)], selectedTaskId: "task-1", step: 2 });
    expect(legacy.tasks[0].diagnosis?.decisionPoints).toBeUndefined();
    expect((legacy.tasks[0] as { exampleResults?: unknown }).exampleResults).toBeUndefined();
  });
});

describe("AX 1차 MVP 개선 — 생성 지시문", () => {
  const confirmed = (overrides: Partial<AxDiagnosis> = {}): AxDiagnosis => readyDiagnosis({
    decisionPoints: [
      { id: "D1", status: "확정", detail: "기준 파일 A, 키 주문번호, 누락·초과는 확인 필요로" },
      { id: "D2", status: "확정", detail: "첫 건만 정상, 이후 건은 오류(확정)" },
      { id: "D3", status: "확정", detail: "음수는 확인 필요, 0은 오류(확정)" },
      { id: "D4", status: "확정", detail: "정상, 오류(확정), 확인 필요" },
      { id: "D5", status: "확정", detail: "확인 필요" },
      { id: "D6", status: "해당 없음" },
      { id: "D7", status: "확정", detail: "합계는 소수 둘째 자리 반올림, 단위 원" },
    ],
    ...overrides,
  });

  it("Codex·Claude 지시문 모두에 구현 순서, 미확정 항목 처리, 완료 보고, 예시 표가 포함된다", () => {
    const diagnosis = confirmed();
    const opts = { diagnosis, taskName: "테스트 업무", context: "", exampleResults: examples(3) };
    for (const tool of ["codex", "claude"] as const) {
      const prompt = buildAllInOnePrompt(planFixture, tool, opts);
      expect(prompt).toContain("### 결정 지점·예시 기반 구현 순서");
      expect(prompt).toContain("핵심 처리 로직을 화면과 분리된 함수로 먼저 구현한다");
      expect(prompt).toContain("하나의 항목은 결과 목록 하나에만 들어간다");
      expect(prompt).toContain("### 미확정 항목 처리");
      expect(prompt).toContain("예시별 기대 결과, 실제 결과, 일치 여부");
      expect(prompt).toContain("| 입력 값 | 기대 결과 | 메모 |");
    }
    expect(buildAllInOnePrompt(planFixture, "codex", opts)).toBe(buildAllInOnePrompt(planFixture, "claude", opts));
  });

  it("미확정 항목의 D번호가 미확정 항목 처리 부분에 표시된다", () => {
    const diagnosis = readyDiagnosis({
      decisionPoints: [
        { id: "D2", status: "미확정" },
        { id: "D4", status: "확정", detail: "정상, 확인 필요" },
        { id: "D6", status: "미확정" },
      ],
    });
    const prompt = promptFor(diagnosis);
    const undecidedSection = prompt.split("### 미확정 항목 처리")[1].split("### ")[0];
    expect(undecidedSection).toContain("D2");
    expect(undecidedSection).toContain("D6");
    expect(undecidedSection).toContain("미확정 항목: D1, D2, D3, D5, D6, D7");
  });

  it("D5가 확정되면 미확정 처리 부분에 D5의 실제 상태명이 치환되고, 미확정이면 임의 생성하지 않는다", () => {
    const withD5 = promptFor(confirmed());
    expect(withD5).toContain("미확정 규칙에 해당하는 행만 '확인 필요'로 보내고");
    expect(withD5).not.toContain("<D5에서 확정된 상태>");
    const withoutD5 = promptFor(readyDiagnosis({ decisionPoints: [{ id: "D5", status: "미확정" }] }));
    const section = withoutD5.split("### 미확정 항목 처리")[1].split("### ")[0];
    expect(section).toContain("D5가 미확정이므로");
    expect(section).toContain("임의로 만들지 않는다");
  });

  it("작업 22 운송장 회귀: 지시문 전체에서 상태 이름과 개수가 D4와 일치한다 (저장 원문은 그대로)", () => {
    const diagnosis = readyDiagnosis({
      asIs: { ...diagnosisFixture.asIs, purpose: "운송장 데이터를 입력받아 필수 항목 누락과 운송장 번호 중복 여부를 검사하는 규칙 기반 알고리즘으로 정상·오류 데이터를 분류하고 검증 결과를 출력한다." },
      stepAssessments: [
        { step: "정상·오류 데이터 분류", verdict: "AI 보조", owner: "AI", note: "검사 결과에 따라 정상 데이터와 오류 데이터를 분리" },
        { step: "담당자 승인", verdict: "사람 유지", owner: "사용자", note: "최종 승인 유지" },
      ],
      decisionPoints: [
        { id: "D4", status: "확정", detail: "정상, 오류(확정), 확인 필요" },
        { id: "D5", status: "확정", detail: "확인 필요" },
      ],
    });
    expect(confirmedStateNames(resolveDecisionPoints(diagnosis))).toEqual(["정상", "오류(확정)", "확인 필요"]);
    const prompt = promptFor(diagnosis, { exampleResults: examples(3), context: "운송장 데이터를 정상과 오류로 분류한다." });
    expect(prompt).not.toContain("정상·오류");
    expect(prompt).toContain("결과 상태 목록: 정상 · 오류(확정) · 확인 필요");
    expect(prompt).toContain("정상 · 오류(확정) · 확인 필요 데이터를 분류");
    // D4에 '정상'이 있어도 D4 목록과 다른 상태 이름을 쓰는 고정 문구가 남지 않는다.
    expect(prompt).not.toMatch(/실패·미매칭·확인 불가/u);
    expect(prompt).not.toContain("정상 결과");
    expect(prompt).not.toMatch(/정상(?:과|와) 오류/u);
    expect(prompt).toContain("결과 상태 목록(정상 · 오류(확정) · 확인 필요) 중 해당 상태로 분리");
    // D4 정의 행은 한 번만, 정리된 목록으로 나온다.
    expect(prompt).toContain("D4 결과 상태 — 확정: 정상 · 오류(확정) · 확인 필요\n");
    // 저장된 진단 원문은 생성 출력에 의해 바뀌지 않는다.
    expect(diagnosis.asIs.purpose).toContain("정상·오류 데이터를 분류");
    expect(diagnosis.stepAssessments[0].step).toBe("정상·오류 데이터 분류");
  });

  it("D4 목록에 '정상'이 없으면 고정 문구 '정상 케이스'가 중립 문구로 바뀐다", () => {
    const diagnosis = readyDiagnosis({
      decisionPoints: [
        { id: "D4", status: "확정", detail: "발송, 검토" },
        { id: "D5", status: "확정", detail: "검토" },
      ],
    });
    const prompt = promptFor(diagnosis, { exampleResults: examples(3) });
    expect(prompt).not.toContain("### 정상 케이스");
    expect(prompt).toContain("### 예시 케이스");
    // 고정 예외 문구도 D4 목록 기반으로 생성된다 (D4에 없는 '정상'·'실패·미매칭·확인 불가'가 남지 않는다).
    expect(prompt).toContain("결과 상태 목록(발송 · 검토) 중 해당 상태로 분리");
    expect(prompt).not.toContain("정상 결과");
    expect(prompt).not.toMatch(/실패·미매칭·확인 불가/u);
  });
});

describe("AX 1차 MVP 개선 — 검증 결함 보완 (D-1~D-7)", () => {
  it("D-2: D4를 가운뎃점·점·쉼표로 입력해도 중복 없이 정리된 목록으로 출력된다", () => {
    expect(parseStateNames("정상·오류·확인 필요")).toEqual(["정상", "오류", "확인 필요"]);
    expect(parseStateNames("정상. 오류. 확인 필요")).toEqual(["정상", "오류", "확인 필요"]);
    expect(parseStateNames("정상, 정상, 오류ㆍ확인 필요")).toEqual(["정상", "오류", "확인 필요"]);
    expect(parseStateNames("1.5 이상, 1.5 미만")).toEqual(["1.5 이상", "1.5 미만"]);
    const diagnosis = readyDiagnosis({
      decisionPoints: [
        { id: "D4", status: "확정", detail: "정상·오류·확인 필요" },
        { id: "D5", status: "확정", detail: "확인 필요" },
      ],
    });
    const prompt = promptFor(diagnosis, { exampleResults: examples(3) });
    expect(prompt).toContain("D4 결과 상태 — 확정: 정상 · 오류 · 확인 필요\n");
    expect(prompt).toContain("결과 상태 목록: 정상 · 오류 · 확인 필요 —");
    expect(prompt).not.toContain("확인 필요·확인 필요");
    expect(prompt).not.toContain("확인 필요 · 확인 필요");
  });

  it("D-3: 예시를 저장한 적 없는 업무(빈 목록)도 02 요약에 '예시 결과 미확정'이 붙는다", () => {
    const summary = planSummary(readyDiagnosis(), planFixture, "", { exampleResults: [] });
    expect(summary.checks.find(check => check.topic === "예시 결과 미확정")?.note).toContain("확정 예시가 0건");
    expect(promptFor(readyDiagnosis())).toContain("확정된 예시가 없습니다. '예시 결과 미확정' 보류 사유로 처리한다.");
    // Gate 판정 자체는 바뀌지 않는다 (후속 범위).
    expect(executionGate(readyDiagnosis())).toBe("ready");
  });

  it("D-4: D4가 확정되면 기대 결과가 D4 목록에 없는 예시는 확정 예시로 세지 않고, 미확정이면 검증하지 않는다", () => {
    const mixed: ExampleResult[] = [...examples(2), { input: "입력 행 X", expectedState: "실패" }];
    expect(partitionExamples(mixed, null).valid).toHaveLength(3);
    const split = partitionExamples(mixed, ["정상", "오류"]);
    expect(split.valid).toHaveLength(2);
    expect(split.invalid.map(example => example.expectedState)).toEqual(["실패"]);
    const d4Confirmed = readyDiagnosis({ decisionPoints: [{ id: "D4", status: "확정", detail: "정상, 오류" }] });
    const prompt = promptFor(d4Confirmed, { exampleResults: mixed });
    const exampleSection = prompt.split("### 확정 예시")[1].split("### ")[0];
    expect(exampleSection).not.toContain("입력 행 X");
    expect(exampleSection).toContain("확정 예시가 2건으로 3건 미만");
    expect(exampleSection).toContain("기대 결과가 결과 상태 목록에 없는 예시 1건은 확정 예시에서 제외했다");
    const summary = planSummary(d4Confirmed, planFixture, "", { exampleResults: mixed });
    expect(summary.checks.find(check => check.topic === "예시 결과 미확정")?.note).toContain("D4 결과 상태 목록에 없는 예시 1건은 제외");
    expect(executionGateWithExamples(d4Confirmed, mixed)).toBe("conditional");
    // D4 미확정이면 과도하게 막지 않는다: 3건 모두 확정 예시로 센다.
    const undecided = promptFor(readyDiagnosis(), { exampleResults: mixed });
    expect(undecided.split("### 확정 예시")[1].split("### ")[0]).toContain("입력 행 X");
    expect(executionGateWithExamples(readyDiagnosis(), mixed)).toBe("ready");
  });

  it("D-6: 예시 표의 '|'와 줄바꿈이 표 열을 깨지 않는다", () => {
    const row = exampleResultRow({ input: "A|B\n둘째 줄", expectedState: "정상", memo: "메모|끝" });
    expect(row).toBe("| A\\|B 둘째 줄 | 정상 | 메모\\|끝 |");
    expect(row.split(/(?<!\\)\|/u)).toHaveLength(5);
  });

  it("D-7: AI 응답 스키마에 decisionPoints가 없고, 저장·계획 요청 경계에서는 사용자 값이 유지된다", () => {
    expect((AX_DIAGNOSIS_RESPONSE_SCHEMA.properties as Record<string, unknown>)).not.toHaveProperty("decisionPoints");
    const points: DecisionPoint[] = [{ id: "D4", status: "확정", detail: "정상, 오류" }];
    expect(confirmedAxDiagnosis({ ...diagnosisFixture, decisionPoints: points }).decisionPoints).toEqual(points);
    expect(confirmedAxDiagnosis(diagnosisFixture)).not.toHaveProperty("decisionPoints");
    expect(axDiagnosisOutputSchema.safeParse(confirmedAxDiagnosis(diagnosisFixture)).success).toBe(true);
  });
});
