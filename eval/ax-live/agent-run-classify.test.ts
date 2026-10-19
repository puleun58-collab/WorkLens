// Isolated unit tests for the agent-run error classification (error-classify.ts).
// No real agent is executed: every case feeds a synthetic error or a set of run
// observations into classifyError() and asserts outcome/causeCode/failureStage.
//
// Run: bun test eval/ax-live/agent-run-classify.test.ts
// (vitest only collects tests/**/*.test.ts, so this file is not part of the
// project's vitest run; package.json scripts are intentionally untouched.)
import { describe, expect, test } from "bun:test";
import {
  AUTH_BLOCKED_RE,
  NETWORK_BLOCKED_RE,
  classifyError,
  redactSecrets,
  type CauseCode,
  type ClassifyInput,
  type FailureStage,
  type Outcome,
} from "./error-classify";

function expectCase(input: ClassifyInput, outcome: Outcome, causeCode: CauseCode | undefined, failureStage: FailureStage) {
  const c = classifyError(input);
  expect(c.outcome).toBe(outcome);
  expect(c.causeCode).toBe(causeCode);
  expect(c.failureStage).toBe(failureStage);
}

describe("classifyError: the 10 required isolation cases", () => {
  test("1. CLI 미설치 → BLOCKED + cli-missing", () => {
    expectCase({ stage: "agent-env-prep", cliMissing: true }, "BLOCKED", "cli-missing", "agent-env-prep");
  });

  test("2. 인증 만료 (authBlocked 패턴 로그) → BLOCKED + auth-expired", () => {
    const log = "codex exec failed: token_expired — refresh token was already used";
    expect(AUTH_BLOCKED_RE.test(log)).toBe(true); // the detection pattern really matches
    expectCase(
      { stage: "agent-auth-network", authBlockedLog: true, exitCode: 1 },
      "BLOCKED",
      "auth-expired",
      "agent-auth-network",
    );
  });

  test("3. 네트워크 차단 (networkBlocked 패턴 로그) → BLOCKED + network-blocked", () => {
    const log = "error sending request for url (https://api.example.com/v1): connection closed";
    expect(NETWORK_BLOCKED_RE.test(log)).toBe(true);
    expectCase(
      { stage: "agent-auth-network", networkBlockedLog: true, exitCode: 1 },
      "BLOCKED",
      "network-blocked",
      "agent-auth-network",
    );
  });

  test("3b. API 연결 실패 (EPROTO) → BLOCKED + network-blocked", () => {
    const log = "API Error: Unable to connect to API (EPROTO)";
    expect(NETWORK_BLOCKED_RE.test(log)).toBe(true);
    expectCase(
      { stage: "agent-auth-network", networkBlockedLog: true, exitCode: 1 },
      "BLOCKED",
      "network-blocked",
      "agent-auth-network",
    );
  });

  test("4. WorkLens API 오류 (HTTP 500 응답) → FAIL + worklens-api-error", () => {
    const err = new Error("WorkLens API HTTP 500 AX_PLAN_FAILED: model call failed");
    expectCase({ stage: "plan-generation", error: err }, "FAIL", "worklens-api-error", "plan-generation");
    // Same for the diagnosis-request stage.
    expectCase(
      { stage: "diagnosis-request", error: new Error("WorkLens API HTTP 503 UNAVAILABLE: overloaded") },
      "FAIL",
      "worklens-api-error",
      "diagnosis-request",
    );
  });

  test("5. 잘못된 지시문 생성 결과 (buildAllInOnePrompt 예외) → FAIL + evaluator-error", () => {
    const err = new Error("buildAllInOnePrompt: missing required plan section");
    expectCase({ stage: "prompt-generation", error: err }, "FAIL", "evaluator-error", "prompt-generation");
  });

  test("6. 에이전트 비정상 종료 (exit code ≠ 0, 근거 없음) → FAIL + agent-exec-failed", () => {
    expectCase(
      { stage: "agent-exec", exitCode: 1, authBlockedLog: false, networkBlockedLog: false },
      "FAIL",
      "agent-exec-failed",
      "agent-exec",
    );
    // A bare non-zero exit must never become BLOCKED.
    const c = classifyError({ stage: "agent-exec", exitCode: 2 });
    expect(c.outcome).toBe("FAIL");
  });

  test("7. 시간 초과 → FAIL + agent-timeout", () => {
    expectCase(
      { stage: "agent-exec", agentTimedOut: true, exitCode: null },
      "FAIL",
      "agent-timeout",
      "agent-exec",
    );
  });

  test("8. 정적 결과물만 생성 (functional checks 실패) → FAIL + functional-check-failed", () => {
    expectCase(
      { stage: "functional-test", exitCode: 0, functionalFailed: true },
      "FAIL",
      "functional-check-failed",
      "functional-test",
    );
  });

  test("9. 실제 기능 테스트 실패 → FAIL + functional-check-failed", () => {
    // Agent exited 0 but assertions did not all pass: still a FAIL, never PASS.
    expectCase(
      { stage: "functional-test", exitCode: 0, functionalFailed: true, fixtureModified: false },
      "FAIL",
      "functional-check-failed",
      "functional-test",
    );
  });

  test("10. 평가기 내부 예외 → FAIL + evaluator-error / schema-validation-error", () => {
    // zod-shaped parse failure (e.g. axDiagnosisOutputSchema.parse)
    const zodLike = { name: "ZodError", message: "invalid_type at diagnosis.level", issues: [{ code: "invalid_type" }] };
    expectCase({ stage: "diagnosis-request", error: zodLike }, "FAIL", "schema-validation-error", "diagnosis-request");
    // Generic evaluator bug (e.g. HITL throw, writeJson failure, import failure)
    expectCase(
      { stage: "functional-test", error: new TypeError("Cannot read properties of undefined (reading 'startFixture')") },
      "FAIL",
      "evaluator-error",
      "functional-test",
    );
  });
});

describe("classifyError: boundary rules", () => {
  test("fetch 자체 실패(연결 거부·DNS)는 BLOCKED + network-blocked", () => {
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = new Error("connect ECONNREFUSED 127.0.0.1:3000");
    expectCase({ stage: "diagnosis-request", error: err }, "BLOCKED", "network-blocked", "diagnosis-request");
  });

  test("요청 타임아웃(AbortSignal)은 FAIL + worklens-api-error", () => {
    const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expectCase({ stage: "plan-generation", error: err }, "FAIL", "worklens-api-error", "plan-generation");
  });

  test("WorkLens API HTTP 오류가 스키마 오류보다 우선한다", () => {
    const err = new Error("WorkLens API HTTP 500 X: bad payload");
    (err as { name?: unknown }).name = "ZodError"; // contrived: API error wins
    expectCase({ stage: "plan-generation", error: err }, "FAIL", "worklens-api-error", "plan-generation");
  });

  test("fixture 수정은 auth/network 근거보다 우선한다", () => {
    expectCase(
      { stage: "agent-exec", fixtureModified: true, authBlockedLog: true, exitCode: 1 },
      "FAIL",
      "fixture-modified",
      "agent-exec",
    );
  });

  test("실패 신호가 없으면 NOT_RUN (PASS는 호출자가 판정)", () => {
    expectCase({ stage: "functional-test", exitCode: 0 }, "NOT_RUN", undefined, "functional-test");
  });
});

describe("redactSecrets", () => {
  test("API 키 패턴을 [REDACTED]로 마스킹한다", () => {
    const log = [
      "using key sk-abc123XYZ456def789ghi012jkl",
      "token=ghp_abcdefghijklmnop123456",
      "export OPENAI_API_KEY=sk-ant-aaaabbbbccccddddeeeeffff",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
      "api_key: AKIAIOSFODNN7EXAMPLE",
    ].join("\n");
    const out = redactSecrets(log);
    expect(out).not.toContain("sk-abc123XYZ456def789ghi012jkl");
    expect(out).not.toContain("ghp_abcdefghijklmnop123456");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("[REDACTED]");
    // Key names stay readable; only values are masked.
    expect(out).toContain("api_key:");
    expect(out).toContain("Bearer [REDACTED]");
  });

  test("분류용 감지 패턴은 마스킹되지 않는다", () => {
    // Classification must run on raw logs; even if it ran after redaction,
    // these evidence phrases carry no key=value shape and must survive.
    const log = "token_expired\nrefresh token was already used\nfailed to refresh available models\nReconnecting...";
    expect(AUTH_BLOCKED_RE.test(redactSecrets(log))).toBe(true);
    expect(NETWORK_BLOCKED_RE.test(redactSecrets(log))).toBe(true);
  });

  test("일반 로그 텍스트는 그대로 둔다", () => {
    const log = "exit=1 stdout=build failed stderr=command not found";
    expect(redactSecrets(log)).toBe(log);
  });
});
