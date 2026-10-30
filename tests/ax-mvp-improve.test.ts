import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt, planSummary } from "@/lib/ax/guide";
import { executionGate, gateBlockReasons, gatePrerequisites } from "@/lib/ax/policy";
import { confirmedStateNames, parseStateNames, resolveDecisionPoints } from "@/lib/ax/decision-points";
import { ruleProgress } from "@/lib/ax/generic-rules";
import { AX_DIAGNOSIS_RESPONSE_SCHEMA } from "@/lib/ax/prompt";
import { axDiagnosisOutputSchema, confirmedAxDiagnosis } from "@/lib/ax/schema";
import { validateAxStateV2 } from "@/lib/ax/transfer";
import type { AxDiagnosis, DecisionPoint, GenericRule } from "@/lib/ax/types";
import { diagnosisFixture, planFixture, taskFixture } from "./fixtures/ax";

const readyDiagnosis = (overrides: Partial<AxDiagnosis> = {}): AxDiagnosis => ({
  ...structuredClone(diagnosisFixture),
  decisionGate: { verdict: "go", reasons: [] },
  technicalChecks: [{ topic: "시스템 접근", status: "확인됨", note: "API 확인 완료" }],
  ...overrides,
});

const rules = (count: number): GenericRule[] => {
  const all: GenericRule[] = [
    { id: "R1", name: "월말 마감 이후 주문 이월", category: "처리·판단 기준", detail: "마감일 이후 접수 주문은 다음 달 집계 대상에 포함하지 않는다.", applicability: "적용", status: "확정" },
    { id: "R2", name: "환불 건 별도 집계", category: "출력·완료 기준", detail: "환불 건은 정상 집계에서 제외하고 별도 목록으로 보고한다.", applicability: "적용", status: "미확정" },
    { id: "R3", name: "적용 여부 확인 필요 규칙", category: "예외·확인 기준", applicability: "적용 여부 미확정", status: "미확정" },
  ];
  return all.slice(0, count);
};

const promptFor = (diagnosis: AxDiagnosis, opts: { genericRules?: GenericRule[]; context?: string } = {}) =>
  buildAllInOnePrompt(planFixture, "codex", { diagnosis, taskName: "테스트 업무", context: opts.context ?? "", genericRules: opts.genericRules });

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

  it("D4 또는 D5가 미확정이면 지시문에서 범위별 보류로 다룬다 (일괄 보류 문구 아님)", () => {
    // 02 checks는 기술 점검 카드 전용이므로 D4/D5를 넣지 않는다 (ax-prereq 계약 유지).
    // 대신 지시문 §1 결정 지점 블록과 §5 미확정 항목 처리에서 범위별 보류로 다룬다.
    const summary = planSummary(diagnosisFixture, planFixture, "");
    expect(summary.checks.every(check => !check.topic.includes("결정 지점"))).toBe(true);
    const prompt = promptFor(diagnosisFixture);
    expect(prompt).toContain("D4 결과 상태 — 미확정");
    expect(prompt).toContain("D5 판단 불가 — 미확정");
    expect(prompt).toContain("D4가 미확정이므로 결과 상태 정의가 필요한 범위");
    expect(prompt).toContain("D4 미확정을 이유로 전체를 일괄 보류하지 않는다");
    expect(prompt).not.toContain("D4 또는 D5가 미확정이므로 기존 조건부 보류 체계로 처리한다");
  });
});

describe("AX 범용 규칙 체계 — 적용·확정 분리 및 Gate 무영향", () => {
  it("확정·미확정·적용 여부 미확정 규칙이 04 범용 블록에 구분 표시된다", () => {
    const prompt = promptFor(readyDiagnosis(), { genericRules: rules(3) });
    expect(prompt).toContain("### 업무 규칙 (범용)");
    expect(prompt).toContain("R1 월말 마감 이후 주문 이월 (처리·판단 기준) — 확정");
    expect(prompt).toContain("R2 환불 건 별도 집계 (출력·완료 기준) — 미확정");
    expect(prompt).toContain("R3 적용 여부 확인 필요 규칙 (예외·확인 기준) — 적용 여부 확인 필요");
    expect(prompt).not.toContain("### 확정 예시");
    expect(prompt).not.toContain("업무 처리 예시 미확정");
    expect(prompt).not.toContain("업무 처리 예시 확인 필요");
  });

  it("범용 규칙의 확정 여부는 Gate 판정에 영향을 주지 않는다 (예시 보류 사유 제거)", () => {
    const ready = readyDiagnosis();
    expect(executionGate(ready)).toBe("ready");
    const blocked = readyDiagnosis({ decisionGate: { verdict: "no-go", reasons: ["실행 승인 불가"] } });
    expect(executionGate(blocked)).toBe("blocked");
    expect(gateBlockReasons(blocked)).toContain("실행 승인 불가");
    const conditional = diagnosisFixture;
    expect(executionGate(conditional)).toBe("conditional");
    expect(gatePrerequisites(conditional)).toContain("권한 확인 후 진행");
    // 범용 규칙이 있어도 기존 판정 함수의 결과는 그대로이다.
    expect(gatePrerequisites(conditional)).not.toContain("업무 처리 예시 미확정");
    expect(gatePrerequisites(conditional)).not.toContain("업무 처리 예시 확인 필요");
  });

  it("범용 규칙과 결정 지점이 기존 IndexedDB 레코드 검증(선택 필드)을 통과한다", () => {
    const diagnosis = readyDiagnosis({
      decisionPoints: [
        { id: "D4", status: "확정", detail: "정상, 오류(확정), 확인 필요" },
        { id: "D5", status: "확정", detail: "확인 필요" },
      ],
    });
    const state = validateAxStateV2({
      schemaVersion: 2,
      tasks: [{ ...taskFixture("task-1", diagnosis), genericRules: rules(3) }],
      selectedTaskId: "task-1",
      step: 4,
    });
    expect(state.tasks[0].genericRules).toHaveLength(3);
    expect(state.tasks[0].diagnosis?.decisionPoints).toHaveLength(2);
    // 필드가 없는 기존 데이터도 그대로 통과한다.
    const legacy = validateAxStateV2({ schemaVersion: 2, tasks: [taskFixture("task-1", diagnosisFixture)], selectedTaskId: "task-1", step: 2 });
    expect(legacy.tasks[0].diagnosis?.decisionPoints).toBeUndefined();
    expect((legacy.tasks[0] as { genericRules?: unknown }).genericRules).toBeUndefined();
    // 레거시 예시 필드가 있어도 파싱·조회는 유지된다 (마이그레이션 삭제 없음).
    const withLegacyExamples = validateAxStateV2({ schemaVersion: 2, tasks: [{ ...taskFixture("task-1", diagnosis), exampleResults: [{ input: "구 예시 행", expectedState: "정상" }] }], selectedTaskId: "task-1", step: 4 });
    expect(withLegacyExamples.tasks[0].exampleResults).toHaveLength(1);
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

  it("Codex·Claude 지시문 모두에 구현 순서, 미확정 항목 처리, 완료 보고, 업무 규칙 검증 블록이 포함된다", () => {
    const diagnosis = confirmed();
    const opts = { diagnosis, taskName: "테스트 업무", context: "", genericRules: rules(3) };
    for (const tool of ["codex", "claude"] as const) {
      const prompt = buildAllInOnePrompt(planFixture, tool, opts);
      expect(prompt).toContain("### 결정 지점·업무 규칙 기반 구현 순서");
      expect(prompt).toContain("핵심 처리 로직을 화면과 분리된 함수로 먼저 구현한다");
      expect(prompt).toContain("하나의 항목은 결과 목록 하나에만 들어간다");
      expect(prompt).toContain("### 미확정 항목 처리");
      expect(prompt).toContain("확정 규칙별 처리 결과, 실제 결과, 일치 여부");
      expect(prompt).toContain("### 업무 규칙 검증");
      expect(prompt).not.toContain("### 확정 예시");
      expect(prompt).not.toContain("| 입력 값 | 기대 결과 | 메모 |");
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
    const prompt = promptFor(diagnosis, { genericRules: rules(3), context: "운송장 데이터를 정상과 오류로 분류한다." });
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
    const prompt = promptFor(diagnosis, { genericRules: rules(3) });
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
    const prompt = promptFor(diagnosis, { genericRules: rules(3) });
    expect(prompt).toContain("D4 결과 상태 — 확정: 정상 · 오류 · 확인 필요\n");
    expect(prompt).toContain("결과 상태 목록: 정상 · 오류 · 확인 필요 —");
    expect(prompt).not.toContain("확인 필요·확인 필요");
    expect(prompt).not.toContain("확인 필요 · 확인 필요");
  });

  it("D-3: 범용 규칙이 없는 업무도 02 요약에 예시 카드가 붙지 않는다", () => {
    // readyDiagnosis()에는 결정 지점이 없어 확인 필요 대상이지만, 예시 체계가 제거돼
    // 02 요약에 예시 관련 카드·문구가 붙지 않는다.
    const summary = planSummary(readyDiagnosis(), planFixture, "");
    expect(summary.checks.some(check => check.topic.includes("예시"))).toBe(false);
    expect(promptFor(readyDiagnosis())).not.toContain("확정된 예시가 없습니다");
    expect(promptFor(readyDiagnosis())).not.toContain("업무 처리 예시");
    // Gate 판정 자체는 바뀌지 않는다 (후속 범위).
    expect(executionGate(readyDiagnosis())).toBe("ready");
  });

  it("D-4: 확정 예시 표가 제거되고 범용 규칙 블록이 D4 정의와 함께 들어간다", () => {
    const d4Confirmed = readyDiagnosis({ decisionPoints: [
      { id: "D1", status: "확정", detail: "기준 파일 A, 키 주문번호" },
      { id: "D4", status: "확정", detail: "정상, 오류" },
    ] });
    const prompt = promptFor(d4Confirmed, { genericRules: rules(3) });
    expect(prompt).toContain("D4 결과 상태 — 확정: 정상 · 오류\n");
    expect(prompt).toContain("### 업무 규칙 (범용)");
    expect(prompt).toContain("R1 월말 마감 이후 주문 이월 (처리·판단 기준) — 확정");
    expect(prompt).not.toContain("### 확정 예시");
    expect(prompt).not.toContain("| 입력 값 | 기대 결과 | 메모 |");
    const summary = planSummary(d4Confirmed, planFixture, "");
    expect(summary.checks.some(check => check.topic.includes("예시"))).toBe(false);
    expect(executionGate(d4Confirmed)).toBe("ready");
  });

  it("D-6: 범용 규칙명의 특수 문자('|', 줄바꿈)가 지시문 블록을 깨지 않는다", () => {
    const rule: GenericRule = { id: "R9", name: "A|B 둘째 줄 규칙", category: "처리·판단 기준", detail: "첫째 줄\n둘째 줄", applicability: "적용", status: "확정" };
    const prompt = promptFor(readyDiagnosis(), { genericRules: [rule] });
    expect(prompt).toContain("R9 A|B 둘째 줄 규칙");
    expect(prompt).toContain("첫째 줄");
    expect(prompt).not.toContain("### 확정 예시");
  });

  it("D-7: AI 응답 스키마에 decisionPoints가 없고, 저장·계획 요청 경계에서는 사용자 값이 유지된다", () => {
    expect((AX_DIAGNOSIS_RESPONSE_SCHEMA.properties as Record<string, unknown>)).not.toHaveProperty("decisionPoints");
    const points: DecisionPoint[] = [{ id: "D4", status: "확정", detail: "정상, 오류" }];
    expect(confirmedAxDiagnosis({ ...diagnosisFixture, decisionPoints: points }).decisionPoints).toEqual(points);
    expect(confirmedAxDiagnosis(diagnosisFixture)).not.toHaveProperty("decisionPoints");
    expect(axDiagnosisOutputSchema.safeParse(confirmedAxDiagnosis(diagnosisFixture)).success).toBe(true);
  });
});

describe("AX 1차 MVP 개선 — 보완 6항 (2026-10-28 추가 보완)", () => {
  const unconfirmedSection = (prompt: string) => prompt.split("### 미확정 항목 처리")[1].split("### ")[0];

  it("1. 범용 규칙 진행 계산은 적용·확정 분리 기준을 따른다 (기존 진단 정보만 사용)", () => {
    // 신규 업무: D 7건 전부 미확정이면 분모 7, 완료 0.
    expect(ruleProgress(resolveDecisionPoints(diagnosisFixture), [])).toEqual({ done: 0, total: 7, applicabilityPending: 0 });
    // D1·D2·D3·D7이 해당 없음이면 분모에서 빠지고, 남은 D4·D5·D6 미확정만 분모가 된다.
    expect(ruleProgress(resolveDecisionPoints(readyDiagnosis({
      decisionPoints: (["D1", "D2", "D3", "D7"] as const).map(id => ({ id, status: "해당 없음" as const })),
    })), [])).toEqual({ done: 0, total: 3, applicabilityPending: 0 });
    // 범용 확정 규칙은 완료에 더해지고, 적용 여부 미확정은 분모 외 별도 건수다.
    const progress = ruleProgress(resolveDecisionPoints(readyDiagnosis({
      decisionPoints: [{ id: "D1", status: "확정", detail: "기준 파일 A" }],
    })), rules(3));
    expect(progress).toEqual({ done: 2, total: 9, applicabilityPending: 1 });
  });

  it("2. 범용 규칙 미확정이 Gate를 일괄 보류로 만들지 않는다", () => {
    const required = readyDiagnosis({ decisionPoints: [{ id: "D1", status: "확정", detail: "기준 파일 A" }] });
    expect(executionGate(required)).toBe("ready");
    const prompt = promptFor(required, { genericRules: rules(3) });
    expect(prompt).toContain("미확정 범용 규칙: R2 환불 건 별도 집계");
    expect(prompt).toContain("적용 여부 확인 필요 범용 규칙: R3 적용 여부 확인 필요 규칙");
  });

  it("3. D4·D5 미확정 시 임의 결과 상태가 만들어지지 않는다", () => {
    const withoutD5 = promptFor(readyDiagnosis({ decisionPoints: [{ id: "D5", status: "미확정" }] }));
    const section = unconfirmedSection(withoutD5);
    expect(section).toContain("D5가 미확정이므로");
    expect(section).toContain("임의로 만들지 않는다");
    expect(section).not.toContain("미확정 규칙에 해당하는 행만 '");
    const d4Undecided = promptFor(readyDiagnosis({
      decisionPoints: [
        { id: "D4", status: "미확정" },
        { id: "D5", status: "확정", detail: "확인 필요" },
      ],
    }));
    const d4Section = unconfirmedSection(d4Undecided);
    expect(d4Section).toContain("D4가 미확정이므로 결과 상태 정의가 필요한 범위");
    expect(d4Section).toContain("미확정 규칙에 해당하는 행만 '확인 필요'로 보내고");
    expect(d4Section).not.toContain("D4 또는 D5가 미확정이므로 기존 조건부 보류 체계로 처리한다");
  });

  it("4. 확정 규칙으로 처리 가능한 데이터까지 일괄 보류하지 않는다", () => {
    const diagnosis = readyDiagnosis({
      decisionPoints: [
        { id: "D1", status: "미확정" },
        { id: "D4", status: "확정", detail: "정상, 오류" },
        { id: "D5", status: "확정", detail: "오류" },
      ],
    });
    const section = unconfirmedSection(promptFor(diagnosis));
    expect(section).toContain("확정 규칙으로 판단 가능한 데이터는 정상 처리");
    expect(section).toContain("확정 가능 데이터까지 일괄 보류하지 않는다");
    expect(section).not.toContain("D4 또는 D5가 미확정이므로 기존 조건부 보류 체계로 처리한다");
    // 다른 지점 미확정이 Gate를 일괄 보류로 만들지 않는다 (범용 규칙 미확정 포함).
    const required = readyDiagnosis({
      decisionPoints: [
        { id: "D1", status: "확정", detail: "기준 파일 A" },
        { id: "D2", status: "미확정" },
      ],
    });
    expect(executionGate(required)).toBe("ready");
  });

  it("5. 범용 규칙 수정·삭제·재확정이 지시문 재생성에 정확히 반영된다", () => {
    const kept: GenericRule = { id: "R1", name: "유지 규칙", category: "처리·판단 기준", detail: "유지 상세", applicability: "적용", status: "확정" };
    const removed: GenericRule = { id: "R2", name: "삭제 규칙 XYZ", category: "처리·판단 기준", applicability: "적용", status: "확정" };
    const before = promptFor(readyDiagnosis(), { genericRules: [kept, removed] });
    expect(before).toContain("삭제 규칙 XYZ");
    const afterDelete = promptFor(readyDiagnosis(), { genericRules: [kept] });
    expect(afterDelete).not.toContain("삭제 규칙 XYZ");
    expect(afterDelete).toContain("유지 규칙");
    const edited: GenericRule = { id: "R1", name: "유지 규칙", category: "처리·판단 기준", detail: "수정된 상세 999", applicability: "적용", status: "확정" };
    const afterEdit = promptFor(readyDiagnosis(), { genericRules: [edited] });
    expect(afterEdit).toContain("수정된 상세 999");
    // 미확정 처리된 결정 지점 detail은 재생성 시 확정 규칙으로 남지 않는다.
    const withRule = promptFor(readyDiagnosis({
      decisionPoints: [{ id: "D1", status: "확정", detail: "RULE-KEEP-123" }],
    }));
    expect(withRule).toContain("RULE-KEEP-123");
    const afterUnconfirm = promptFor(readyDiagnosis({
      decisionPoints: [{ id: "D1", status: "미확정", detail: "RULE-KEEP-123" }],
    }));
    expect(afterUnconfirm).not.toContain("RULE-KEEP-123");
    expect(afterUnconfirm).toContain("D1 기준과 매칭 — 미확정");
  });

  it("6. Codex·Claude 지시문에서 상태 정의와 범용 규칙이 일치한다", () => {
    const diagnosis = readyDiagnosis({
      decisionPoints: [
        { id: "D1", status: "확정", detail: "기준 파일 A, 키 주문번호" },
        { id: "D4", status: "확정", detail: "정상, 오류(확정), 확인 필요" },
        { id: "D5", status: "확정", detail: "확인 필요" },
      ],
    });
    const opts = { diagnosis, taskName: "테스트 업무", context: "", genericRules: rules(3) };
    const codex = buildAllInOnePrompt(planFixture, "codex", opts);
    const claude = buildAllInOnePrompt(planFixture, "claude", opts);
    const decisionOf = (prompt: string) => prompt.split("### 결정 지점 (D1~D7)")[1].split("\n## ")[0];
    const rulesOf = (prompt: string) => prompt.split("### 업무 규칙 (범용)")[1].split("\n### ")[0];
    expect(decisionOf(codex)).toBe(decisionOf(claude));
    expect(rulesOf(codex)).toBe(rulesOf(claude));
    expect(decisionOf(codex)).toContain("D4 결과 상태 — 확정: 정상 · 오류(확정) · 확인 필요");
    expect(rulesOf(codex)).toContain("R1 월말 마감 이후 주문 이월 (처리·판단 기준) — 확정");
  });

  it("7. 범용 규칙 검증과 독립 정확성 검증이 구분된다", () => {
    const prompt = promptFor(readyDiagnosis(), { genericRules: rules(3) });
    expect(prompt).toContain("확정 규칙별 처리 결과, 실제 결과, 일치 여부를 실제 실행 결과로 보고한다");
    expect(prompt).toContain("확정 규칙 통과만으로 구현 완료·정확성 PASS를 판단하지 않는다");
    expect(prompt).toContain("실제 정확성 검증은 별도 독립 평가 데이터로 수행하고, 수행하지 못한 검증은 NOT_VERIFIED로 보고한다");
    expect(prompt).toContain("독립 평가 데이터는 이 지시문에 포함하지 않으며, 구현 에이전트에 정답을 사전 노출하지 않는다");
  });

  it("8. 배포 후 기능 검증은 실제 URL·입력·결과·정답 대조 증거를 요구한다", () => {
    const prompt = promptFor(readyDiagnosis(), { genericRules: rules(3) });
    expect(prompt).toContain("배포 후 검증 보고에는 실제 배포 주소(URL), 입력, 실제 결과, 독립 정답 대조 결과를 포함한다");
  });

  it("9. 실행하지 않은 배포·기능 검증은 PASS로 선언하지 않는다", () => {
    const prompt = promptFor(readyDiagnosis(), { genericRules: rules(3) });
    expect(prompt).toContain("실행하지 않은 검증은 완료로 보고하지 말고 미실행으로 명시");
    expect(prompt).not.toContain("예시 3건 통과 시 구현 완료");
    expect(prompt).not.toContain("3건 통과하면 정확성 PASS");
  });
});
