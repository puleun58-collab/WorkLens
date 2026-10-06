import { describe, expect, it } from "vitest";
import { automationLevel, executionGate, executionProfile, matrixPosition, nextAction, priority, priorityHeading } from "@/lib/ax/policy";
import { axMessages } from "@/lib/ax/prompt";
import { confirmedAxDiagnosis } from "@/lib/ax/schema";
import type { AxDiagnosis } from "@/lib/ax/types";
import { diagnosisFixture, taskFixture } from "./fixtures/ax";

type Gate = "ready" | "conditional" | "blocked";
const LEVELS: Record<0 | 1 | 2 | 3, number[]> = { 0: [2, 2, 2, 5, 1, 1], 1: [3, 3, 3, 1, 2, 2], 2: [3, 3, 3, 3, 2, 2], 3: [4, 4, 4, 4, 2, 2] };
/** The AI narrative deliberately overreaches so every assertion proves the policy, not the fixture, decides scope. */
const OVERREACH: Pick<AxDiagnosis, "roadmap" | "nextAction"> = {
  roadmap: [{ phase: "1", title: "정식 자동화 도입", items: ["production rollout", "담당자 승인 자동 처리"] }],
  nextAction: { label: "즉시 운영 자동화 착수", detail: "전체 업무 자동 실행" },
};
function build(level: 0 | 1 | 2 | 3, gate: Gate): AxDiagnosis {
  const d = structuredClone(diagnosisFixture);
  d.factors = d.factors.map((factor, i) => ({ ...factor, aiValue: LEVELS[level][i] }));
  d.decisionGate = gate === "ready" ? { verdict: "go", reasons: [] } : gate === "conditional" ? { verdict: "conditional", reasons: ["권한 확인 후 진행"] } : { verdict: "no-go", reasons: ["필수 시스템 접근 불가"] };
  d.technicalChecks = gate === "ready" ? [{ topic: "시스템 접근", status: "확인됨", note: "권한 확인 완료" }] : [{ topic: "시스템 접근", status: "확인 필요", note: "API와 권한 실제 확인" }];
  Object.assign(d, structuredClone(OVERREACH));
  expect(automationLevel(d).level).toBe(level);
  expect(executionGate(d)).toBe(gate);
  return d;
}
const titles = (d: AxDiagnosis) => executionProfile(d).roadmap.map(phase => phase.title);
/** Scope-bearing output only: outOfScope legitimately names the excluded manual automation. */
const text = (d: AxDiagnosis) => { const profile = executionProfile(d); return JSON.stringify([profile.roadmap, profile.poc.inScope]); };

describe("AX execution profile (Level ∩ Gate)", () => {
  it.each([[0, "ready"], [0, "conditional"], [1, "ready"], [2, "ready"], [2, "blocked"], [3, "ready"], [3, "conditional"]] as const)("never surfaces the raw AI roadmap or automates manual steps (L%i %s)", (level, gate) => {
    const d = build(level, gate), profile = executionProfile(d);
    expect(text(d)).not.toMatch(/정식 자동화 도입|production rollout|즉시 운영 자동화|담당자 승인 (자동|규칙|AI)/u);
    expect(profile.roadmap.length).toBeGreaterThanOrEqual(2);
    expect(profile.roadmap.map(phase => phase.phase)).toEqual(profile.roadmap.map((_, i) => String(i + 1)));
    expect(profile.poc.outOfScope).toContain("담당자 승인 자동화 (담당자 수행)");
  });

  it("Level 0 + conditional: prerequisites first, preparation roadmap, validation PoC, no rollout", () => {
    const profile = executionProfile(build(0, "conditional"));
    expect(profile).toMatchObject({ roadmapTitle: "자동화 준비 로드맵", executionCandidate: false, planAllowed: true, nextAction: { label: "선행 확인사항 확인" } });
    expect(profile.roadmap.map(phase => phase.title)).toEqual(["선행 확인", "제한 PoC", "결과 확인·다음 단계 판단"]);
    expect(profile.roadmap[0].items).toEqual(["시스템 접근 — API와 권한 실제 확인", "권한 확인 후 진행"]);
    expect(profile.poc.inScope).toContain("자동화 가능성 판단");
    expect(profile.poc.outOfScope).toContain("운영 자동화 적용");
  });

  it("Level 0 + ready: data/rule preparation and re-diagnosis, not automation", () => {
    const d = build(0, "ready");
    expect(titles(d)).toEqual(["데이터 형식 확인", "업무 규칙 정리", "사전 검증", "재진단"]);
    expect(executionProfile(d)).toMatchObject({ roadmapTitle: "자동화 준비 로드맵", executionCandidate: false, nextAction: { label: "데이터·업무 규칙 확인" } });
  });

  it("Level 1 + ready: AI assist with the 담당자 review kept", () => {
    const d = build(1, "ready"), profile = executionProfile(d);
    expect(titles(d)).toEqual(["입력·규칙 확인", "AI 보조 기능 검증", "담당자 검토", "제한 적용·결과 평가"]);
    expect(profile.roadmap[2].items).toContain("담당자 승인 담당자 수행 유지");
    expect(profile.poc.inScope).toEqual(["형식 검증 AI 보조 결과(후보·초안) 생성", "담당자 검토 흐름 확인"]);
    expect(profile).toMatchObject({ roadmapTitle: "AI 보조 도입 로드맵", executionCandidate: true, nextAction: { label: "AI 보조 사전 검증" } });
  });

  it("Level 2 + ready: rule steps automate, pilot and operation allowed, approvals stay", () => {
    const d = build(2, "ready"), profile = executionProfile(d);
    expect(profile).toMatchObject({ executionCandidate: true, readyExecutionCandidate: true });
    expect(titles(d)).toEqual(["입력·규칙 검증", "부분 자동화 구현", "예외·실패 검증", "파일럿", "운영 적용"]);
    expect(profile.roadmap[1].items).toEqual(["자료 수집 규칙 기반 처리", "형식 검증 AI 보조"]);
    expect(profile.roadmap[3].items).toContain("담당자 승인 담당자 수행 유지");
    expect(profile.poc.outOfScope).not.toContain("운영 자동화 적용");
    // Only a ready Level 2~3 diagnosis may keep the AI's own next action.
    expect(profile.nextAction).toEqual(OVERREACH.nextAction);
  });

  it("Level 3 + ready: staged rollout with fallback and kept boundaries", () => {
    const profile = executionProfile(build(3, "ready"));
    expect(profile.roadmap.map(phase => phase.title)).toEqual(["자동화 흐름 구현", "실패 복구·Fallback", "단계적 도입", "운영·모니터링"]);
    expect(profile.roadmap[1].items).toContain("실패 시 수동 취합으로 복귀");
    expect(profile.roadmap[2].items).toContain("담당자 승인 담당자 수행 유지");
    expect(profile.roadmapTitle).toBe("자동화 도입 로드맵");
  });

  it("Level 2 + blocked: blocker resolution only, Level 0 PoC, plans stay closed", () => {
    const d = build(2, "blocked"), profile = executionProfile(d);
    expect(titles(d)).toEqual(["차단 사유 확인", "조건 해결", "검증", "재진단"]);
    expect(profile).toMatchObject({ roadmapTitle: "선행 조치", executionCandidate: false, planAllowed: false, nextAction: { label: "차단 사유 해결", detail: "필수 시스템 접근 불가" } });
    expect(profile.poc.inScope).toContain("자동화 가능성 판단");
    expect(profile.poc.outOfScope).toContain("운영 자동화 적용");
  });

  it("Level 3 + conditional: confirm, limited PoC, decide — no implementation or operation phase", () => {
    const profile = executionProfile(build(3, "conditional"));
    expect(profile.roadmap.map(phase => phase.title)).toEqual(["선행 확인", "제한 PoC", "결과 확인·다음 단계 판단"]);
    expect(profile.roadmap[1].items.every(item => item.startsWith("샘플 범위: "))).toBe(true);
    expect(profile.poc.inScope[0]).toBe("선행 확인사항 해결 후 샘플 범위에서 진행");
  });

  it("Level 2 + conditional: prerequisites stay open but immediate execution stays closed", () => {
    const profile = executionProfile(build(2, "conditional"));
    expect(profile).toMatchObject({ executionCandidate: false, readyExecutionCandidate: false, planAllowed: true });
    expect(profile.roadmap.map(phase => phase.title)).toEqual(["선행 확인", "제한 PoC", "결과 확인·다음 단계 판단"]);
  });

  it("keeps Matrix and priority as comparison only and does not mutate the stored diagnosis", () => {
    const quickBlocked = build(3, "blocked"), before = structuredClone(quickBlocked);
    expect(matrixPosition(quickBlocked).region).toBe("quick");
    expect(executionProfile(quickBlocked).executionCandidate).toBe(false);
    expect(quickBlocked).toEqual(before);
    expect(nextAction(quickBlocked).label).toBe("차단 사유 해결");
  });

  it("names the ranked list by what can actually run", () => {
    const profiles = (...ds: AxDiagnosis[]) => priority(ds.map((d, i) => taskFixture(`t${i}`, d))).map(r => executionProfile(r.task.diagnosis));
    expect(priorityHeading(profiles(build(0, "ready")))).toBe("업무 진단 결과");
    expect(priorityHeading(profiles(build(0, "ready"), build(2, "blocked")))).toBe("현재 검토 업무");
    expect(priorityHeading(profiles(build(2, "ready"), build(0, "ready")))).toBe("자동화 우선순위 TOP 1");
    expect(priorityHeading(profiles(build(2, "ready"), build(3, "ready"), build(2, "conditional")))).toBe("자동화 우선순위 TOP 2");
    expect(priorityHeading(profiles(build(2, "conditional"), build(3, "conditional")))).toBe("확인 후 진행 업무");
    expect(priorityHeading(profiles(build(1, "ready"), build(2, "ready"), build(3, "ready"), build(2, "ready")))).toBe("자동화 우선순위 TOP 3");
  });

  it("sends the plan model the aligned roadmap, PoC and next action instead of the raw narrative", () => {
    const d = build(0, "conditional");
    const [, user] = axMessages({ kind: "ax-plan", target: "codex", task: { name: "취합", description: "매월 취합", details: {} }, diagnosis: confirmedAxDiagnosis(d) });
    const sent = JSON.parse(user.content);
    expect(user.content).not.toMatch(/정식 자동화 도입|production rollout|즉시 운영 자동화/u);
    expect(sent.diagnosis.roadmap).toEqual(executionProfile(d).roadmap);
    expect(sent.diagnosis.poc).toEqual(executionProfile(d).poc);
    expect(sent.diagnosis.factors).toEqual(d.factors);
  });
});
