/**
 * Gate 10사례 검증: 다양한 조건 조합에서 executionGate 판정이 기대와 일치하는지 확인.
 * 기존 정책 계산을 변경하지 않으며, 판정 정합성만 검증한다.
 */
import { describe, test, expect } from "vitest";
import { executionGate, gatePrerequisites, gateRecommendedChecks } from "@/lib/ax/policy";
import type { AxDiagnosis } from "@/lib/ax/types";

function baseDiagnosis(overrides: Partial<AxDiagnosis> = {}): AxDiagnosis {
  return {
    informationSufficiency: "sufficient",
    decisionGate: { verdict: "go", reasons: [] },
    technicalChecks: [],
    followUpQuestions: [],
    factors: [],
    stepAssessments: [],
    ...overrides,
  } as AxDiagnosis;
}

function check(topic: string, status: "확인됨" | "확인 필요" | "불가", required?: boolean, note?: string) {
  return { topic, status, required, note: note ?? `${topic} 확인` };
}

describe("Gate 10사례", () => {
  test("1. 필수 조건 모두 충족 → ready", () => {
    const d = baseDiagnosis({
      technicalChecks: [check("입력 형식", "확인됨"), check("API 권한", "확인됨")],
    });
    expect(executionGate(d)).toBe("ready");
    expect(gatePrerequisites(d)).toEqual([]);
  });

  test("2. 선택적 조건만 미확정 → ready (선택 항목은 Gate에 영향 없음)", () => {
    const d = baseDiagnosis({
      technicalChecks: [
        check("입력 형식", "확인됨"),
        check("향후 확장 API", "확인 필요", false),
      ],
    });
    expect(executionGate(d)).toBe("ready");
    // 권장 확인사항에는 표시되지만 판정 근거에는 포함되지 않음
    expect(gateRecommendedChecks(d)).toHaveLength(1);
    expect(gatePrerequisites(d)).toEqual([]);
  });

  test("3. 필수 기술 조건 미확정 → conditional", () => {
    const d = baseDiagnosis({
      technicalChecks: [
        check("입력 형식", "확인됨"),
        check("API 권한", "확인 필요"), // required 없음 = 필수
      ],
    });
    expect(executionGate(d)).toBe("conditional");
    const prereqs = gatePrerequisites(d);
    expect(prereqs.some(p => p.includes("API 권한"))).toBe(true);
    // 필수 미확정이므로 권장 확인사항에는 없음
    expect(gateRecommendedChecks(d)).toHaveLength(0);
  });

  test("4. 핵심 입력 정보 부족 → conditional", () => {
    const d = baseDiagnosis({
      informationSufficiency: "needs-check",
      followUpQuestions: ["입력 파일 형식을 확인해주세요"],
      technicalChecks: [check("입력 형식", "확인됨")],
    });
    expect(executionGate(d)).toBe("conditional");
  });

  test("5. 일부 조건만 미확정 → conditional (미확정 필수 항목만 집계)", () => {
    const d = baseDiagnosis({
      technicalChecks: [
        check("입력 형식", "확인됨"),
        check("계산 규칙", "확인 필요"), // 필수
        check("향후 대시보드", "확인 필요", false), // 선택
      ],
    });
    expect(executionGate(d)).toBe("conditional");
    const prereqs = gatePrerequisites(d);
    // 필수 미확정 1건만 판정 근거에 집계
    expect(prereqs.filter(p => p.includes("계산 규칙")).length).toBeGreaterThan(0);
    // 선택 항목은 권장 확인사항으로 분리
    expect(gateRecommendedChecks(d).some(p => p.includes("향후 대시보드"))).toBe(true);
  });

  test("6. 명시적 no-go → blocked", () => {
    const d = baseDiagnosis({
      decisionGate: { verdict: "no-go", reasons: ["법적 검토 필요"] },
      technicalChecks: [check("입력 형식", "확인됨")],
    });
    expect(executionGate(d)).toBe("blocked");
  });

  test("7. 허용 단계와 보류 단계 혼재 → conditional (보류는 해당 단계만)", () => {
    const d = baseDiagnosis({
      decisionGate: { verdict: "conditional", reasons: ["외부 API 연동 확인 후 진행"] },
      technicalChecks: [
        check("입력 형식", "확인됨"),
        check("외부 API", "확인 필요"), // 필수
      ],
    });
    expect(executionGate(d)).toBe("conditional");
    // 판정 근거에는 실제 영향 조건만
    const prereqs = gatePrerequisites(d);
    expect(prereqs.some(p => p.includes("외부 API"))).toBe(true);
  });

  test("8. Level 0 검토 전용 → 정책상 차단 아님 (구현은 검토 범위로 제한)", () => {
    // Level 0은 automationLevel에서 판정되며, Gate는 go일 수 있음
    // Gate 자체는 차단하지 않지만 지시문에서 검토 범위로 제한됨
    const d = baseDiagnosis({
      decisionGate: { verdict: "go", reasons: [] },
      technicalChecks: [check("입력 형식", "확인됨")],
    });
    expect(executionGate(d)).toBe("ready");
  });

  test("9. HITL 제외·보류 반영 → Gate 판정은 유지 (HITL은 지시문 범위에서 처리)", () => {
    // HITL 보류·제외는 지시문의 구현 범위에서 처리되며, Gate 계산에는 직접 영향을 주지 않음
    const d = baseDiagnosis({
      decisionGate: { verdict: "conditional", reasons: ["승인 프로세스 확인"] },
      technicalChecks: [check("승인 프로세스", "확인 필요")],
    });
    expect(executionGate(d)).toBe("conditional");
  });

  test("10. 저장·재진단 이후 판정 정합성 → 동일 입력은 동일 판정", () => {
    const make = () => baseDiagnosis({
      technicalChecks: [
        check("입력 형식", "확인됨"),
        check("API 권한", "확인 필요", false),
      ],
    });
    // 직렬화·역직렬화 후에도 동일 판정 (저장 데이터 호환성)
    const restored = JSON.parse(JSON.stringify(make())) as AxDiagnosis;
    expect(executionGate(restored)).toBe(executionGate(make()));
    expect(executionGate(restored)).toBe("ready");
  });

  test("required 없는 기존 데이터는 필수로 취급 (PR #217 규칙)", () => {
    const d = baseDiagnosis({
      technicalChecks: [
        { topic: "구 데이터 항목", status: "확인 필요", note: "required 필드 없음" } as AxDiagnosis["technicalChecks"][number],
      ],
    });
    expect(executionGate(d)).toBe("conditional");
  });
});
