import { describe, expect, it } from "vitest";
import {
  automationLevel, executionGate, gatePrerequisites, matrixPosition,
  planAllowed, priorityDisplayLabel, type ExecutionGate,
} from "@/lib/ax/policy";
import type { AxDiagnosis } from "@/lib/ax/types";
import { diagnosisFixture } from "./fixtures/ax";

type Scenario = {
  id: number;
  name: string;
  factors: [number, number, number, number, number, number];
  verdict: AxDiagnosis["decisionGate"]["verdict"];
  sufficiency: AxDiagnosis["informationSufficiency"];
  level: 0 | 1 | 2 | 3;
  gate: ExecutionGate;
  region: ReturnType<typeof matrixPosition>["region"];
  allowed: boolean;
  checks?: AxDiagnosis["technicalChecks"];
  questions?: string[];
  humanInLoop?: boolean;
  fallback?: boolean;
  displayLabel?: string;
};

const scenarios: Scenario[] = [
  { id: 1, name: "반복 Excel 취합", factors: [5, 5, 5, 4, 1, 1], verdict: "go", sufficiency: "sufficient", level: 3, region: "quick", gate: "ready", allowed: true },
  { id: 2, name: "월간 정산", factors: [5, 4, 4, 4, 2, 3], verdict: "go", sufficiency: "sufficient", level: 2, region: "quick", gate: "ready", allowed: true },
  {
    id: 3, name: "주간 뉴스 수집", factors: [5, 5, 3, 4, 2, 2], verdict: "conditional", sufficiency: "sufficient",
    level: 3, region: "quick", gate: "conditional", allowed: true,
    checks: [{ topic: "뉴스 수집", status: "확인 필요", note: "수집 조건 확인" }],
  },
  { id: 4, name: "기사 선별", factors: [4, 4, 3, 3, 4, 3], verdict: "conditional", sufficiency: "sufficient", level: 1, region: "strategic", gate: "conditional", allowed: true, humanInLoop: true },
  { id: 5, name: "PPT 보고서 생성", factors: [4, 5, 4, 3, 3, 2], verdict: "go", sufficiency: "sufficient", level: 2, region: "quick", gate: "ready", allowed: true },
  { id: 6, name: "이메일 분류", factors: [5, 5, 4, 4, 2, 2], verdict: "go", sufficiency: "sufficient", level: 3, region: "quick", gate: "ready", allowed: true },
  { id: 7, name: "데이터 형식 변환", factors: [5, 5, 5, 5, 1, 1], verdict: "go", sufficiency: "sufficient", level: 3, region: "quick", gate: "ready", allowed: true },
  {
    id: 8, name: "ERP 입력", factors: [4, 5, 4, 3, 2, 3], verdict: "conditional", sufficiency: "sufficient",
    level: 2, region: "quick", gate: "conditional", allowed: true,
    checks: [{ topic: "ERP 권한", status: "확인 필요", note: "입력 권한 확인" }],
  },
  {
    id: 9, name: "API 확인된 시스템", factors: [4, 4, 4, 5, 2, 2], verdict: "go", sufficiency: "sufficient",
    level: 3, region: "quick", gate: "ready", allowed: true,
    checks: [{ topic: "API", status: "확인됨", note: "연동 확인 완료" }],
  },
  {
    id: 10, name: "API 미확인 시스템", factors: [4, 4, 4, 2, 2, 2], verdict: "go", sufficiency: "sufficient",
    level: 2, region: "strategic", gate: "conditional", allowed: true,
    checks: [{ topic: "API", status: "확인 필요", note: "연동 가능 여부 확인" }],
  },
  { id: 11, name: "브라우저 자동화", factors: [4, 3, 3, 3, 3, 3], verdict: "conditional", sufficiency: "sufficient", level: 2, region: "hold", gate: "conditional", allowed: true, fallback: true },
  {
    id: 12, name: "MFA 필수", factors: [4, 4, 3, 3, 3, 3], verdict: "conditional", sufficiency: "sufficient",
    level: 2, region: "strategic", gate: "conditional", allowed: true, humanInLoop: true, fallback: true,
    checks: [{ topic: "MFA", status: "확인 필요", note: "담당자 인증 단계 확인" }],
  },
  { id: 13, name: "CAPTCHA 사이트", factors: [3, 3, 2, 2, 4, 4], verdict: "no-go", sufficiency: "sufficient", level: 0, region: "hold", gate: "blocked", allowed: false, fallback: true },
  {
    id: 14, name: "개인정보 처리", factors: [4, 4, 4, 3, 3, 4], verdict: "conditional", sufficiency: "sufficient",
    level: 2, region: "hold", gate: "conditional", allowed: true, humanInLoop: true, fallback: true,
    checks: [{ topic: "개인정보 기준", status: "확인 필요", note: "처리 기준과 승인 확인" }],
  },
  { id: 15, name: "HR 평가", factors: [3, 3, 2, 2, 5, 4], verdict: "no-go", sufficiency: "sufficient", level: 0, region: "hold", gate: "blocked", allowed: false, humanInLoop: true, fallback: true },
  { id: 16, name: "안전 최종판단", factors: [2, 3, 2, 2, 5, 5], verdict: "no-go", sufficiency: "sufficient", level: 0, region: "hold", gate: "blocked", allowed: false, humanInLoop: true, fallback: true },
  { id: 17, name: "법률 최종판단", factors: [3, 2, 2, 2, 5, 5], verdict: "no-go", sufficiency: "sufficient", level: 0, region: "hold", gate: "blocked", allowed: false, humanInLoop: true, fallback: true },
  { id: 18, name: "승인자 필수", factors: [4, 4, 4, 4, 3, 2], verdict: "conditional", sufficiency: "sufficient", level: 2, region: "quick", gate: "conditional", allowed: true, humanInLoop: true },
  {
    id: 19, name: "비정형 PDF", factors: [4, 3, 2, 3, 3, 3], verdict: "go", sufficiency: "needs-check",
    level: 2, region: "hold", gate: "conditional", allowed: true, fallback: true,
    questions: ["PDF 입력 구조와 예외 형식은 무엇인가요?"],
  },
  { id: 20, name: "예외 많은 업무", factors: [4, 2, 2, 3, 4, 3], verdict: "conditional", sufficiency: "partial", level: 1, region: "hold", gate: "conditional", allowed: true, humanInLoop: true, fallback: true },
  { id: 21, name: "단순 복사/이동", factors: [5, 5, 5, 5, 1, 1], verdict: "go", sufficiency: "sufficient", level: 3, region: "quick", gate: "ready", allowed: true },
  { id: 22, name: "낮은 빈도 업무", factors: [2, 4, 4, 3, 2, 2], verdict: "go", sufficiency: "sufficient", level: 2, region: "maybe", gate: "ready", allowed: true },
  { id: 23, name: "매우 높은 반복", factors: [5, 5, 4, 4, 1, 2], verdict: "go", sufficiency: "sufficient", level: 3, region: "quick", gate: "ready", allowed: true },
  {
    id: 24, name: "구조화되지 않은 입력", factors: [4, 2, 1, 3, 3, 3], verdict: "go", sufficiency: "needs-check",
    level: 0, region: "hold", gate: "conditional", allowed: true, fallback: true,
    questions: ["입력 형식과 구조화 가능한 항목은 무엇인가요?"],
  },
  {
    id: 25, name: "시스템 접근 불가(확인 항목만)", factors: [5, 5, 4, 1, 2, 3], verdict: "conditional", sufficiency: "sufficient",
    level: 2, region: "strategic", gate: "conditional", allowed: true, fallback: true,
    checks: [{ topic: "시스템 접근", status: "불가", note: "접근 권한 없음" }],
  },
  {
    id: 26, name: "시스템 접근 불가(no-go)", factors: [5, 5, 4, 1, 2, 3], verdict: "no-go", sufficiency: "sufficient",
    level: 2, region: "strategic", gate: "blocked", allowed: false, fallback: true,
    checks: [{ topic: "시스템 접근", status: "불가", note: "접근 권한 없음" }],
  },
  { id: 27, name: "수동 유지 적합", factors: [1, 2, 2, 2, 4, 3], verdict: "go", sufficiency: "sufficient", level: 0, region: "hold", gate: "ready", allowed: true, humanInLoop: true, fallback: true },
  { id: 28, name: "AI 보조 적합", factors: [4, 4, 3, 3, 4, 2], verdict: "go", sufficiency: "sufficient", level: 1, region: "strategic", gate: "ready", allowed: true, humanInLoop: true },
  { id: 29, name: "부분 자동화 적합", factors: [4, 4, 4, 4, 3, 2], verdict: "go", sufficiency: "sufficient", level: 2, region: "quick", gate: "ready", allowed: true },
  {
    id: 30, name: "고도 자동화 후보이나 진행 보류", factors: [5, 5, 5, 5, 1, 1], verdict: "no-go", sufficiency: "sufficient",
    level: 3, region: "quick", gate: "blocked", allowed: false, displayLabel: "진행 보류", fallback: true,
  },
];

function scenarioDiagnosis(scenario: Scenario): AxDiagnosis {
  const d = structuredClone(diagnosisFixture);
  d.factors.forEach((f, i) => { f.aiValue = scenario.factors[i]; });
  d.informationSufficiency = scenario.sufficiency;
  d.decisionGate = {
    verdict: scenario.verdict,
    reasons: scenario.verdict === "go" ? [] : [`${scenario.name}: 선행 조건과 실행 승인 확인`],
  };
  const checks: AxDiagnosis["technicalChecks"] = scenario.checks
    ?? [{ topic: "시스템 접근", status: "확인됨", note: "접근 확인 완료" }];
  d.technicalChecks = structuredClone(checks);
  d.followUpQuestions = [...(scenario.questions ?? [])];
  return d;
}

describe("AX Tier 2 business scenarios", () => {
  it.each(scenarios)("$id. $name", scenario => {
    const d = scenarioDiagnosis(scenario);
    const before = structuredClone(d);
    expect(automationLevel(d).level).toBe(scenario.level);
    expect(executionGate(d)).toBe(scenario.gate);
    expect(matrixPosition(d).region).toBe(scenario.region);
    expect(planAllowed(d)).toBe(scenario.allowed);
    const prerequisites = gatePrerequisites(d);
    if (scenario.gate !== "ready") expect(prerequisites.length).toBeGreaterThan(0);
    else expect(prerequisites).toEqual([]);
    if (scenario.questions) {
      for (const question of scenario.questions) expect(prerequisites).toContain(question);
    }
    if (scenario.humanInLoop) expect(d.humanInLoop.some(step => step.trim().length > 0)).toBe(true);
    if (scenario.fallback) expect(d.operation.fallback.trim().length).toBeGreaterThan(0);
    if (scenario.displayLabel) expect(priorityDisplayLabel(d)).toBe(scenario.displayLabel);
    expect(d).toEqual(before);
  });
});
