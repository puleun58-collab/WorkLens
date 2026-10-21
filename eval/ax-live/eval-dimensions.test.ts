// Isolated unit tests for the three-dimension evaluation records (eval-dimensions.ts).
// Pure logic: deriveDimensions() maps a recorded result to independent
// policy / implementation / deployment verdicts; summarizeResults() aggregates
// the policy-compliance rate and the MVP implementation success rate separately.
//
// Run: bun test eval/ax-live/eval-dimensions.test.ts
// (vitest only collects tests/**/*.test.ts, so this file is not part of the
// project's vitest run; package.json scripts are intentionally untouched.)
import { describe, expect, test } from "bun:test";
import {
  deriveDimensions,
  summarizeResults,
  type DimensionFacts,
  type DimensionVerdict,
  type EvalDimensions,
} from "./eval-dimensions";
import type { CauseCode, Outcome } from "./error-classify";

function verdicts(facts: DimensionFacts): Record<"policy" | "implementation" | "deployment", DimensionVerdict> {
  const d = deriveDimensions(facts);
  return { policy: d.policy.verdict, implementation: d.implementation.verdict, deployment: d.deployment.verdict };
}

describe("deriveDimensions: 차원별 독립 판정", () => {
  test("전체 기능 검사 통과 PASS → policy pass / implementation pass / deployment not-run", () => {
    expect(verdicts({ outcome: "PASS", checksPassed: 5, checksTotal: 5 })).toEqual({
      policy: "pass",
      implementation: "pass",
      deployment: "not-run",
    });
  });

  test("Level 0 정상 거부 → policy pass / implementation not-applicable (MVP 집계 제외)", () => {
    expect(
      verdicts({ outcome: "PASS", causeCode: "level-zero-abstention", checksPassed: 0, checksTotal: 0 }),
    ).toEqual({ policy: "pass", implementation: "not-applicable", deployment: "not-run" });
  });

  test("Level 0 위반(구현 수행) → policy fail / implementation fail", () => {
    expect(
      verdicts({ outcome: "FAIL", causeCode: "level-zero-abstention", checksPassed: 0, checksTotal: 0 }),
    ).toEqual({ policy: "fail", implementation: "fail", deployment: "not-run" });
  });

  test("기능 검사 실패 → policy pass / implementation fail (정책 위반과 기능 실패 구분)", () => {
    expect(
      verdicts({ outcome: "FAIL", causeCode: "functional-check-failed", checksPassed: 2, checksTotal: 5 }),
    ).toEqual({ policy: "pass", implementation: "fail", deployment: "not-run" });
  });

  test("정적 결과물만 생성(functional-check-failed) → 구현 성공으로 처리하지 않음", () => {
    const d = deriveDimensions({ outcome: "FAIL", causeCode: "functional-check-failed", checksPassed: 0, checksTotal: 3 });
    expect(d.implementation.verdict).toBe("fail");
  });

  test("에이전트 기권(agent-abstained) → policy not-run / implementation fail (위반 미관측을 준수 확정으로 간주하지 않음)", () => {
    // 수정 전: policy=pass 로 자동 판정 — 근거는 fixture 미수정·금지 동작
    // 미관측뿐이라, 구현을 수행하지 않은 실행의 정책 준수를 검증한 것이
    // 아니었다. 수정 후: 검증 근거 부족으로 not-run (준수율 분모 제외).
    const d = deriveDimensions({ outcome: "FAIL", causeCode: "agent-abstained", checksPassed: 0, checksTotal: 0 });
    expect(d.policy.verdict).toBe("not-run");
    expect(d.policy.note).toContain("검증 근거 부족");
    expect(d.implementation.verdict).toBe("fail");
    expect(d.deployment.verdict).toBe("not-run");
  });

  test("fixture 수정 → policy fail / implementation fail", () => {
    expect(
      verdicts({ outcome: "FAIL", causeCode: "fixture-modified", checksPassed: 0, checksTotal: 0 }),
    ).toEqual({ policy: "fail", implementation: "fail", deployment: "not-run" });
  });

  test("에이전트 비정상 종료·시간 초과 → policy not-run / implementation fail", () => {
    expect(
      verdicts({ outcome: "FAIL", causeCode: "agent-exec-failed", checksPassed: 0, checksTotal: 0 }),
    ).toEqual({ policy: "not-run", implementation: "fail", deployment: "not-run" });
    expect(
      verdicts({ outcome: "FAIL", causeCode: "agent-timeout", checksPassed: 0, checksTotal: 0 }),
    ).toEqual({ policy: "not-run", implementation: "fail", deployment: "not-run" });
  });

  test("인증 만료·CLI 미설치 BLOCKED → 세 차원 모두 not-run (환경 차단과 기능 실패 혼동 금지)", () => {
    expect(
      verdicts({ outcome: "BLOCKED", causeCode: "auth-expired", checksPassed: 0, checksTotal: 0 }),
    ).toEqual({ policy: "not-run", implementation: "not-run", deployment: "not-run" });
    expect(
      verdicts({ outcome: "BLOCKED", causeCode: "cli-missing", checksPassed: 0, checksTotal: 0 }),
    ).toEqual({ policy: "not-run", implementation: "not-run", deployment: "not-run" });
  });

  test("no-go 등 명시적 구현 차단(gate blocked) → 세 차원 모두 not-run", () => {
    // planAllowed=false 경로는 causeCode 없이 BLOCKED 로 기록된다.
    expect(verdicts({ outcome: "BLOCKED", checksPassed: 0, checksTotal: 0 })).toEqual({
      policy: "not-run",
      implementation: "not-run",
      deployment: "not-run",
    });
  });

  test("NOT_RUN → 세 차원 모두 not-run", () => {
    expect(verdicts({ outcome: "NOT_RUN", checksPassed: 0, checksTotal: 0 })).toEqual({
      policy: "not-run",
      implementation: "not-run",
      deployment: "not-run",
    });
  });

  test("기능 테스트 기록 없는 PASS → implementation fail (성공으로 인정하지 않음)", () => {
    expect(verdicts({ outcome: "PASS", checksPassed: 0, checksTotal: 0 }).implementation).toBe("fail");
    expect(verdicts({ outcome: "PASS", checksPassed: 3, checksTotal: 5 }).implementation).toBe("fail");
  });

  test("에이전트 실행 이전 단계 실패 → 세 차원 모두 not-run", () => {
    for (const causeCode of ["worklens-api-error", "schema-validation-error", "evaluator-error"] as const) {
      expect(
        verdicts({ outcome: "FAIL", causeCode, checksPassed: 0, checksTotal: 0 }),
      ).toEqual({ policy: "not-run", implementation: "not-run", deployment: "not-run" });
    }
  });

  test("배포 차원은 로컬 검증과 구분되어 not-run 으로 기록된다", () => {
    const d = deriveDimensions({ outcome: "PASS", checksPassed: 5, checksTotal: 5 });
    expect(d.deployment.verdict).toBe("not-run");
    expect(d.deployment.note).toContain("로컬 검증과 구분");
  });
});

describe("summarizeResults: 정책 준수율과 MVP 구현 성공률의 분리 집계", () => {
  function result(outcome: Outcome, causeCode?: CauseCode, checksPassed = 0, checksTotal = 0): { outcome: Outcome; dimensions: EvalDimensions } {
    return { outcome, dimensions: deriveDimensions({ outcome, causeCode, checksPassed, checksTotal }) };
  }

  test("Level 0 정상 거부는 정책 준수율에는 포함, MVP 구현 성공률에서는 분자·분모 모두 제외", () => {
    const results = [
      result("PASS", undefined, 5, 5), // 구현 성공 x4
      result("PASS", undefined, 5, 5),
      result("PASS", undefined, 5, 5),
      result("PASS", undefined, 5, 5),
      result("PASS", "level-zero-abstention"), // Level 0 정상 거부 x2
      result("PASS", "level-zero-abstention"),
      result("FAIL", "functional-check-failed", 2, 5), // 기능 실패 x2
      result("FAIL", "functional-check-failed", 1, 5),
      result("BLOCKED", "auth-expired"), // 환경 차단 x1
      result("NOT_RUN"), // 미실행 x1
    ];
    const s = summarizeResults(results);
    expect(s.total).toBe(10);
    expect(s.outcomes).toEqual({ PASS: 6, FAIL: 2, BLOCKED: 1, NOT_RUN: 1 });

    // 정책 준수율: pass 8 (구현 성공 4 + Level 0 거부 2 + 기능 실패 2 — 기능 실패는
    // 정책 위반이 아니므로 pass) / (pass 8 + fail 0) = 1
    expect(s.policy.pass).toBe(8);
    expect(s.policy.fail).toBe(0);
    expect(s.policy.rate).toBe(1);

    // MVP 구현 성공률: pass 4 / (pass 4 + fail 2) = 0.6667
    // Level 0 정상 거부 2건은 not-applicable 로 분자·분모에서 제외
    expect(s.implementation.pass).toBe(4);
    expect(s.implementation.fail).toBe(2);
    expect(s.implementation.notApplicable).toBe(2);
    expect(s.implementation.rate).toBe(0.6667);

    // 배포 검증: 이 실행에서는 항상 not-run → rate null
    expect(s.deployment.notRun).toBe(10);
    expect(s.deployment.rate).toBeNull();
  });

  test("기권(agent-abstained)은 정책 준수율 분모에서 제외된다 (not-run 집계, pass로 부풀리지 않음)", () => {
    const results = [
      result("PASS", undefined, 5, 5), // 구현 성공: policy pass
      result("FAIL", "functional-check-failed", 2, 5), // 기능 실패: policy pass (위반 아님)
      result("FAIL", "agent-abstained"), // 기권: policy not-run (수정 전에는 pass)
      result("FAIL", "agent-abstained"),
    ];
    const s = summarizeResults(results);
    // 정책: pass 2 / (pass 2 + fail 0) = 1 이지만, 기권 2건은 notRun 으로
    // 분모에서 빠져 있다 — 수정 전(pass 자동 판정)이라면 pass 4 로 집계됐다.
    expect(s.policy.pass).toBe(2);
    expect(s.policy.fail).toBe(0);
    expect(s.policy.notRun).toBe(2);
    expect(s.policy.rate).toBe(1);
    // 구현: pass 1 / (pass 1 + fail 3) = 0.25 — 기권은 기존대로 fail.
    expect(s.implementation.pass).toBe(1);
    expect(s.implementation.fail).toBe(3);
    expect(s.implementation.rate).toBe(0.25);
  });

  test("dimensions 가 없는 구 결과 파일도 호환된다", () => {
    const s = summarizeResults([
      { outcome: "PASS" },
      { outcome: "FAIL" },
    ]);
    expect(s.total).toBe(2);
    expect(s.policy.notRun).toBe(2);
    expect(s.implementation.notRun).toBe(2);
    expect(s.policy.rate).toBeNull();
    expect(s.implementation.rate).toBeNull();
  });

  test("빈 결과 목록 → rate null (0 나누기 방지)", () => {
    const s = summarizeResults([]);
    expect(s.total).toBe(0);
    expect(s.policy.rate).toBeNull();
    expect(s.implementation.rate).toBeNull();
    expect(s.deployment.rate).toBeNull();
  });

  test("판정 가능한 결과가 없으면(전부 not-run) rate null", () => {
    const s = summarizeResults([result("BLOCKED", "auth-expired"), result("NOT_RUN")]);
    expect(s.policy.rate).toBeNull();
    expect(s.implementation.rate).toBeNull();
  });
});
