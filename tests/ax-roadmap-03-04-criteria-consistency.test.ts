import { describe, expect, test } from "vitest";
import { buildAllInOnePrompt, planSummary } from "../src/lib/ax/guide";
import type { AxDiagnosis, AxPlan } from "../src/lib/ax/types";

// 결함 A-1·A-2 (작업 19 후속 라이브 관찰 조사 REPORT.md §C):
// 03 통과 조건과 04 지시문이 같은 기준의 필수 여부·한정자를 다르게 말하고,
// 동일 비교 대상의 상충 수치 기준에 조정 규칙이 없었다. 정책 P1·P2에 따라
// 03·04 양쪽이 미연결 기준을 한정자付き 전체 기준(확인 대기)으로 동일하게 말하고,
// 상충 수치 기준은 우선순위 없이 확인 대상 섹션으로 분리한다.

const STEPS = ["자료 수집", "집계", "보고서 생성"];

function diagnosis(poc: Partial<{ success: string[]; failure: string[] }>): AxDiagnosis {
  return {
    sourceNote: "03·04 기준 일치 픽스처",
    factors: [
      { key: "repetition", aiValue: 4, rationale: "" },
      { key: "regularity", aiValue: 4, rationale: "" },
      { key: "dataStructure", aiValue: 2, rationale: "" },
      { key: "systemAccess", aiValue: 3, rationale: "" },
      { key: "humanJudgment", aiValue: 3, rationale: "" },
      { key: "operationalRisk", aiValue: 2, rationale: "" },
    ],
    stepAssessments: STEPS.map(step => ({
      step, verdict: "자동화" as const, treatment: "확인 후 구현",
      scope: "current" as const, owner: "시스템" as const, note: "",
    })),
    technicalChecks: [],
    followUpQuestions: [],
    decisionGate: { verdict: "conditional", reasons: ["선행 확인 필요"] },
    informationSufficiency: "sufficient",
    asIs: { purpose: "자료 집계 및 보고서 생성", trigger: "매주", inputs: ["자료 파일"], outputs: ["보고서"], steps: STEPS, exceptions: [], humanDecisions: [], systems: ["Excel"] },
    toBe: [],
    poc: { inScope: STEPS.map(s => `${s} 확인 후 구현`), outOfScope: [], success: poc.success ?? [], failure: poc.failure ?? [], tests: [], evaluation: [] },
  } as unknown as AxDiagnosis;
}

function plan(acceptance: string[]): AxPlan {
  return {
    implementation: STEPS,
    integrations: [],
    dataFlow: ["자료 → 집계 → 보고서"],
    acceptance,
    tests: [],
    prerequisites: [],
  } as unknown as AxPlan;
}

function section(prompt: string, title: string): string {
  const start = prompt.indexOf(`### ${title}`);
  if (start < 0) return "";
  const end = prompt.indexOf("### ", start + 10);
  return end < 0 ? prompt.slice(start) : prompt.slice(start, end);
}

describe("AX 03·04 기준 일치 (결함 A-1·A-2)", () => {
  test("① 미연결 계획 acceptance: 03 통과 조건과 04 전체 완료 기준이 같은 한정자로 말한다", () => {
    const d = diagnosis({ success: ["처리 결과 누락 없음"] });
    const p = plan(["명세서 파일 형식·내용이 템플릿 기준 충족"]);
    const summary = planSummary(d, p);
    // 03: 통과 조건에 있고, 한정자는 접두어 또는 공통 안내로 표현된다.
    expect(summary.success.join(" ")).toContain("명세서 파일 형식·내용이 템플릿 기준 충족");
    expect(summary.success.join(" ")).toContain("처리 결과 누락 없음");
    expect(summary.success.some(s => s.startsWith("기준 확인 필요:")) || summary.criteriaNotice !== undefined).toBe(true);
    const prompt = buildAllInOnePrompt(p, "codex", { diagnosis: d });
    // 04: 참고 판정이 아니라 한정자付き 전체 완료 기준이다.
    expect(section(prompt, "업무 전체 완료 기준")).toContain("기준 확인 필요: 명세서 파일 형식·내용이 템플릿 기준 충족");
    expect(section(prompt, "업무 전체 완료 기준")).toContain("기준 확인 필요: 처리 결과 누락 없음");
    expect(section(prompt, "참고 판정 (필수 완료 조건 아님)")).not.toContain("명세서 파일 형식·내용이 템플릿 기준 충족");
  });

  test("② 미연결 PoC 기준: 03·04 양쪽에서 성공·실패 모두 한정자가 유지된다", () => {
    const d = diagnosis({ success: ["처리 결과 누락 없음"], failure: ["처리 결과 누락 발생"] });
    const p = plan([]);
    const summary = planSummary(d, p);
    expect(summary.success.join(" ")).toContain("처리 결과 누락 없음");
    expect(summary.failure.join(" ")).toContain("처리 결과 누락 발생");
    const prompt = buildAllInOnePrompt(p, "codex", { diagnosis: d });
    expect(section(prompt, "업무 전체 완료 기준")).toContain("기준 확인 필요: 처리 결과 누락 없음");
    // bare 전체 완료/실패 기준으로는 제시되지 않는다.
    expect(section(prompt, "업무 전체 완료 기준")).not.toMatch(/^- 처리 결과 누락 없음$/m);
    expect(section(prompt, "업무 전체 실패 판정 기준")).toContain("기준 확인 필요: 처리 결과 누락 발생");
    expect(section(prompt, "업무 전체 실패 판정 기준")).not.toMatch(/^- 처리 결과 누락 발생$/m);
  });

  test("③ 성공·실패 양쪽 출처 동일 항목: 03·04 모두 충돌 분리로 일치한다", () => {
    const d = diagnosis({ success: ["대조 결과가 기준표와 일치"], failure: ["대조 결과가 기준표와 일치"] });
    const p = plan([]);
    const summary = planSummary(d, p);
    expect(summary.success.join(" ")).not.toContain("대조 결과가 기준표와 일치");
    expect(summary.failure.join(" ")).not.toContain("대조 결과가 기준표와 일치");
    expect(summary.conflictingCriteria.join(" ")).toContain("대조 결과가 기준표와 일치");
    const prompt = buildAllInOnePrompt(p, "codex", { diagnosis: d });
    expect(section(prompt, "판정 기준 출처 충돌 (확인 필요)")).toContain("대조 결과가 기준표와 일치");
    expect(section(prompt, "업무 전체 완료 기준")).not.toContain("대조 결과가 기준표와 일치");
    expect(section(prompt, "업무 전체 실패 판정 기준")).not.toContain("대조 결과가 기준표와 일치");
  });

  test("③-2 계획 acceptance와 PoC 실패가 같은 문장: 03·04 모두 충돌 분리로 일치한다", () => {
    const d = diagnosis({ failure: ["집계 결과가 기준표와 다름"] });
    const p = plan(["집계 결과가 기준표와 다름"]);
    const summary = planSummary(d, p);
    expect(summary.success.join(" ")).not.toContain("집계 결과가 기준표와 다름");
    expect(summary.failure.join(" ")).not.toContain("집계 결과가 기준표와 다름");
    expect(summary.conflictingCriteria.join(" ")).toContain("집계 결과가 기준표와 다름");
    const prompt = buildAllInOnePrompt(p, "codex", { diagnosis: d });
    expect(section(prompt, "판정 기준 출처 충돌 (확인 필요)")).toContain("집계 결과가 기준표와 다름");
    expect(section(prompt, "업무 전체 완료 기준")).not.toContain("집계 결과가 기준표와 다름");
    expect(section(prompt, "업무 전체 실패 판정 기준")).not.toContain("집계 결과가 기준표와 다름");
  });

  test("④ 상충 수치 기준: 03·04 양쪽에서 분리 표시되고 어느 쪽도 합격 조건이 아니다", () => {
    const d = diagnosis({ success: ["불일치 항목이 없거나 사소한 오류만 발견될 경우 자동화 단계 진행"] });
    const p = plan(["자동 파싱 결과가 수동 결과와 100% 일치"]);
    const summary = planSummary(d, p);
    expect(summary.success.join(" ")).not.toContain("사소한 오류만 발견될 경우");
    expect(summary.success.join(" ")).not.toContain("100% 일치");
    expect(summary.numericConflictCriteria.join(" ")).toContain("사소한 오류만 발견될 경우");
    expect(summary.numericConflictCriteria.join(" ")).toContain("100% 일치");
    const prompt = buildAllInOnePrompt(p, "codex", { diagnosis: d });
    const numeric = section(prompt, "수치 기준 충돌 (확인 필요)");
    expect(numeric).toContain("사소한 오류만 발견될 경우");
    expect(numeric).toContain("100% 일치");
    // 우선순위를 선언하지 않고, 어느 쪽도 합격 조건으로 쓰지 않는다.
    expect(numeric).toContain("우선순위");
    expect(numeric).toContain("어느 쪽도 합격 조건으로 쓰지 말고");
    expect(section(prompt, "업무 전체 완료 기준")).not.toContain("사소한 오류만 발견될 경우");
    expect(section(prompt, "업무 전체 완료 기준")).not.toContain("100% 일치");
  });

  test("④-2 수치만 다른 합의 기준(100% 대 95%)도 분리되고, 판정 불가 합의 기준은 남는다", () => {
    const d = diagnosis({ success: ["자동 처리 결과가 수동 결과와 100% 일치", "수동 대조 결과와 자동 대조 결과가 동일"] });
    const p = plan(["자동 처리 결과가 수동 결과와 95% 이상 일치"]);
    const summary = planSummary(d, p);
    expect(summary.numericConflictCriteria.join(" ")).toContain("100% 일치");
    expect(summary.numericConflictCriteria.join(" ")).toContain("95% 이상 일치");
    expect(summary.success.join(" ")).not.toContain("100% 일치");
    expect(summary.success.join(" ")).not.toContain("95% 이상 일치");
    // 허용 수준을 가늠할 수 없는 합의 기준은 분리 대상이 아니다.
    expect(summary.success.join(" ")).toContain("수동 대조 결과와 자동 대조 결과가 동일");
    const prompt = buildAllInOnePrompt(p, "codex", { diagnosis: d });
    expect(section(prompt, "수치 기준 충돌 (확인 필요)")).toContain("100% 일치");
    expect(section(prompt, "수치 기준 충돌 (확인 필요)")).toContain("95% 이상 일치");
    expect(section(prompt, "업무 전체 완료 기준")).toContain("수동 대조 결과와 자동 대조 결과가 동일");
  });
});
