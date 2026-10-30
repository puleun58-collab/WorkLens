import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt, detectGenericRuleExceptionConflicts } from "@/lib/ax/guide";
import { resolveDecisionPoints } from "@/lib/ax/decision-points";
import { applicabilityPendingGenericRules, confirmedGenericRules, duplicateGenericRuleConflicts, missingConfirmedGenericRules, nextGenericRuleId, pendingGenericRules, resolveGenericRules, ruleProgress } from "@/lib/ax/generic-rules";
import { axTaskV2Schema, genericRuleSchema } from "@/lib/ax/schema";
import { diagnosisFixture, planFixture, taskFixture } from "./fixtures/ax";
import type { AxDiagnosis, GenericRule } from "@/lib/ax/types";

const rule = (overrides: Partial<GenericRule> = {}): GenericRule => ({
  id: "R1",
  name: "월말 마감 이후 주문 이월",
  category: "처리·판단 기준",
  detail: "마감일 이후 접수 주문은 다음 달 집계 대상에 포함하지 않는다.",
  applicability: "적용",
  status: "확정",
  ...overrides,
});

const confirmedDiagnosis = (): AxDiagnosis => ({
  ...structuredClone(diagnosisFixture),
  decisionPoints: [
    { id: "D1", status: "확정", detail: "판매내역.xlsx / Sheet1, 주문번호, 누락·초과 판단" },
    { id: "D2", status: "확정", detail: "같은 주문번호가 여러 번 나오면 첫 행만 사용" },
    { id: "D3", status: "확정", detail: "빈칸은 확인 필요, 음수는 오류(확정)" },
    { id: "D4", status: "확정", detail: "정상, 오류(확정), 확인 필요" },
    { id: "D5", status: "확정", detail: "확인 필요" },
    { id: "D6", status: "해당 없음" },
    { id: "D7", status: "확정", detail: "합계는 소수 둘째 자리 반올림, 단위 원" },
  ],
});

describe("AX 범용 규칙 — 스키마", () => {
  it("유효한 규칙이 파싱되고 무효 값은 거부된다", () => {
    expect(genericRuleSchema.safeParse(rule()).success).toBe(true);
    expect(genericRuleSchema.safeParse(rule({ category: "기타" as never })).success).toBe(false);
    expect(genericRuleSchema.safeParse(rule({ applicability: "자동" as never })).success).toBe(false);
    expect(genericRuleSchema.safeParse(rule({ status: "확정됨" as never })).success).toBe(false);
    expect(genericRuleSchema.safeParse(rule({ name: "  " })).success).toBe(false);
    expect(genericRuleSchema.safeParse(rule({ linkedDecisionId: "D9" as never })).success).toBe(false);
    expect(genericRuleSchema.safeParse(rule({ linkedDecisionId: "D3" })).success).toBe(true);
  });

  it("genericRules는 선택 필드라 없는 기존 레코드도 그대로 검증된다", () => {
    const parsed = axTaskV2Schema.safeParse(taskFixture("task-1", diagnosisFixture));
    expect(parsed.success).toBe(true);
    const withRules = axTaskV2Schema.safeParse({ ...taskFixture("task-1", diagnosisFixture), genericRules: [rule()] });
    expect(withRules.success).toBe(true);
  });
});

describe("AX 범용 규칙 — resolve·식별 체계", () => {
  it("D ID·빈 ID·무효값은 제외하고 id 기준 선착순으로 중복을 제거한다 (자동 생성·자동 확정 없음)", () => {
    const resolved = resolveGenericRules([
      rule({ id: "D1", name: "D ID 충돌" }),
      rule({ id: "", name: "빈 ID" }),
      rule({ id: "R2", category: "기타" as never }),
      rule({ id: "R1", name: "첫 번째" }),
      rule({ id: "R1", name: "두 번째(무시)" }),
      rule({ id: "R2", name: "두 번째 규칙" }),
    ] as unknown as GenericRule[]);
    expect(resolved.map(item => `${item.id}:${item.name}`)).toEqual(["R1:첫 번째", "R2:두 번째 규칙"]);
  });

  it("다음 ID는 기존 R 숫자 최대값 + 1이며 D ID·비R ID를 무시한다", () => {
    expect(nextGenericRuleId([])).toBe("R1");
    expect(nextGenericRuleId([rule({ id: "R1" }), rule({ id: "R3" }), rule({ id: "D1" })])).toBe("R4");
    expect(nextGenericRuleId([rule({ id: "메모" })])).toBe("R1");
  });
});

describe("AX 범용 규칙 — 적용·확정 분리 및 진행 계산", () => {
  it("확정 = 적용 + 확정이며 적용 여부 미확정은 분모 외 별도 건수다", () => {
    const rules = [rule(), rule({ id: "R2", status: "미확정" }), rule({ id: "R3", applicability: "적용 여부 미확정", status: "미확정" }), rule({ id: "R4", applicability: "해당 없음", status: "미확정" })];
    expect(confirmedGenericRules(rules).map(item => item.id)).toEqual(["R1"]);
    expect(pendingGenericRules(rules).map(item => item.id)).toEqual(["R2"]);
    expect(applicabilityPendingGenericRules(rules).map(item => item.id)).toEqual(["R3"]);
  });

  it("진행 계산: 신규 0/7, D 해당 없음 분모 제외, 혼합 케이스", () => {
    expect(ruleProgress(resolveDecisionPoints(diagnosisFixture), [])).toEqual({ done: 0, total: 7, applicabilityPending: 0 });
    const mixed = resolveDecisionPoints({
      ...structuredClone(diagnosisFixture),
      decisionPoints: [
        { id: "D1", status: "확정", detail: "기준 A" },
        { id: "D2", status: "확정", detail: "중복 기준" },
        { id: "D3", status: "해당 없음" },
        { id: "D4", status: "미확정" },
        { id: "D5", status: "미확정" },
        { id: "D6", status: "미확정" },
        { id: "D7", status: "미확정" },
      ],
    });
    const rules = [rule(), rule({ id: "R2", status: "미확정" }), rule({ id: "R3", applicability: "적용 여부 미확정", status: "미확정" }), rule({ id: "R4", applicability: "해당 없음", status: "미확정" })];
    expect(ruleProgress(mixed, rules)).toEqual({ done: 3, total: 8, applicabilityPending: 1 });
  });
});

describe("AX 범용 규칙 — 지시문 전달 및 검증 경로", () => {
  it("확정 규칙은 범용 블록에, 미확정·적용 여부 미확정은 구분 표시와 확인 목록에 들어간다", () => {
    const rules = [
      rule(),
      rule({ id: "R2", name: "환불 건 별도 집계", category: "출력·완료 기준", detail: "환불 건은 정상 집계에서 제외하고 별도 목록으로 보고한다.", status: "미확정" }),
      rule({ id: "R3", name: "적용 여부 확인 필요 규칙", category: "예외·확인 기준", applicability: "적용 여부 미확정", status: "미확정" }),
    ];
    const prompt = buildAllInOnePrompt(planFixture, "codex", { diagnosis: confirmedDiagnosis(), taskName: "테스트 업무", context: "", genericRules: rules });
    expect(prompt).toContain("### 업무 규칙 (범용)");
    expect(prompt).toContain("R1 월말 마감 이후 주문 이월 (처리·판단 기준) — 확정: 마감일 이후 접수 주문은 다음 달 집계 대상에 포함하지 않는다.");
    expect(prompt).toContain("R2 환불 건 별도 집계 (출력·완료 기준) — 미확정");
    expect(prompt).toContain("R3 적용 여부 확인 필요 규칙 (예외·확인 기준) — 적용 여부 확인 필요");
    expect(prompt).toContain("미확정 범용 규칙: R2 환불 건 별도 집계");
    expect(prompt).toContain("적용 여부 확인 필요 범용 규칙: R3 적용 여부 확인 필요 규칙");
    expect(prompt).not.toContain("### 확정 예시");
  });

  it("확정 규칙이 지시문 본문에 없으면 전달 누락으로 검출된다", () => {
    expect(missingConfirmedGenericRules("R1 월말 마감 이후 주문 이월: 마감일 이후 접수 주문은 다음 달 집계 대상에 포함하지 않는다.", [rule()])).toEqual([]);
    expect(missingConfirmedGenericRules("전혀 다른 내용", [rule()]).map(item => item.id)).toEqual(["R1"]);
    expect(missingConfirmedGenericRules("아무 내용", [rule({ id: "R2", status: "미확정" })])).toEqual([]);
  });

  it("동일 정규화 규칙명에 상이한 상세를 가진 확정 규칙만 중복·충돌로 검출한다", () => {
    const conflicts = duplicateGenericRuleConflicts([
      rule({ name: "월말 마감 이후 주문 이월", detail: "다음 달 집계에 포함하지 않는다." }),
      rule({ id: "R2", name: "월말 마감 이후 주문 이월", detail: "당월 집계에 포함한다." }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain("R1");
    expect(conflicts[0]).toContain("R2");
    expect(duplicateGenericRuleConflicts([
      rule(),
      rule({ id: "R2", detail: "마감일 이후 접수 주문은 다음 달 집계 대상에 포함하지 않는다." }),
    ])).toEqual([]);
    expect(duplicateGenericRuleConflicts([rule(), rule({ id: "R2", name: "전혀 다른 규칙" })])).toEqual([]);
  });

  it("범용 확정 규칙과 §4 예외가 같은 대상에 서로 다른 결과 상태를 지정하면 충돌로 검출한다", () => {
    const conflicts = detectGenericRuleExceptionConflicts(
      [rule({ detail: "주문은 정상 처리한다." })],
      ["주문은 오류 처리한다."],
      ["정상", "오류"],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].line).toContain("R1");
    expect(detectGenericRuleExceptionConflicts(
      [rule({ detail: "주문은 정상 처리한다." })],
      ["주문은 정상 처리한다."],
      ["정상", "오류"],
    )).toEqual([]);
    expect(detectGenericRuleExceptionConflicts(
      [rule({ detail: "배송 정상" })],
      ["주문 오류"],
      ["정상", "오류"],
    )).toEqual([]);
  });
});
