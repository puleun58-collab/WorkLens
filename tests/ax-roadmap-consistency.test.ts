import { describe, expect, test } from "vitest";
import { executionProfile, gatePrerequisites } from "../src/lib/ax/policy";
import {
  buildAgentInstructionModel,
  buildAllInOnePrompt,
  filterRoadmapItems,
  hitlDispositionForStep,
  hitlDispositionForStepLine,
  hitlDispositionForText,
  planSummary,
  stepDetailEntries,
  type AgentInstructionModel,
} from "../src/lib/ax/guide";
import { extractPlanReviewableItems, extractReviewableItems } from "../src/lib/ax/hitl";
import type { AxDiagnosis, AxPlan, HitlReview } from "../src/lib/ax/types";

// 주간 판매자 정산 집계와 동등한 구조: conditional gate, 8단계, 기술확인 6건.
// 단계명·기술확인 문구는 라이브에서 확인된 형태(한국어 패러프레이즈 포함)를 쓴다.
const STEPS = [
  "판매 데이터 수집",
  "데이터 정규화",
  "매출 합산",
  "수수료 계산",
  "최소 금액 적용",
  "명세서 생성",
  "명세서 이메일 전송",
  "구글 시트에 집계 입력",
];
const CHECKS = [
  { topic: "SMTP 발송 설정", note: "정산 명세서 자동 발송에 필요", status: "확인 필요" },
  { topic: "SMTP server for email dispatch", note: "", status: "확인 필요" },
  { topic: "이메일 서버 접근 권한", note: "자동 다운로드 단계에서 IMAP/SMTP 인증 필요", status: "확인 필요" },
  { topic: "Google Sheets API 사용 권한", note: "구글 시트 자동 입력 단계에 필요", status: "확인 필요" },
  { topic: "판매내역 파일 접근 권한", note: "판매내역.csv 읽기 필요", status: "확인 필요" },
  { topic: "SMTP 발송", note: "명세서 자동 전송 금지", status: "불가" },
] as const;

function diagnosis(): AxDiagnosis {
  return {
    sourceNote: "테스트 픽스처",
    factors: [
      { key: "repetition", aiValue: 5, rationale: "매주 반복" },
      { key: "regularity", aiValue: 5, rationale: "규칙 명확" },
      { key: "dataStructure", aiValue: 4, rationale: "CSV 구조화" },
      { key: "systemAccess", aiValue: 3, rationale: "파일 접근 가능" },
      { key: "humanJudgment", aiValue: 2, rationale: "판단 적음" },
      { key: "operationalRisk", aiValue: 2, rationale: "위험 낮음" },
    ],
    stepAssessments: STEPS.map((step, i) => ({
      step,
      verdict: "자동화" as const,
      treatment: i < 6 ? "규칙 기반 처리" : "확인 후 구현",
      scope: "current" as const,
      owner: "시스템" as const,
      note: "",
    })),
    technicalChecks: CHECKS.map(c => ({ ...c, status: c.status as "확인 필요" | "불가" })),
    followUpQuestions: [],
    decisionGate: { verdict: "conditional", reasons: ["선행 확인 필요"] },
    informationSufficiency: "sufficient",
    asIs: { purpose: "주간 정산", trigger: "매주", inputs: ["판매내역.csv"], outputs: ["정산표"], steps: STEPS, exceptions: [], humanDecisions: [], systems: ["CSV"] },
    toBe: [],
    poc: {
      inScope: [
        "판매 데이터 수집 규칙 기반 처리",
        "데이터 정규화 규칙 기반 처리",
        "매출 합산 규칙 기반 처리",
        "수수료 계산 규칙 기반 처리",
        "최소 금액 적용 규칙 기반 처리",
        "명세서 생성 규칙 기반 처리",
        "명세서 이메일 전송 규칙 기반 처리",
        "구글 시트에 집계 입력 규칙 기반 처리",
      ],
      outOfScope: [],
      success: ["집계 결과가 Google Sheets에 업데이트됨", "명세서가 이메일로 자동 전송됨"],
      tests: [],
      evaluation: [],
    },
  } as unknown as AxDiagnosis;
}

function plan(tool: "codex" | "claude"): AxPlan {
  return {
    implementation: [
      "판매 데이터 수집",
      "데이터 정규화",
      "매출 합산",
      "수수료 계산",
      "최소 금액 적용",
      "명세서 생성",
      "SMTP 연동으로 명세서 자동 이메일 전송",
      "계산 결과를 Google Sheets API로 업데이트",
    ],
    integrations: ["SMTP 서버 연동", "Google Sheets API 연동"],
    dataFlow: ["판매내역.csv → 집계 → 정산표"],
    acceptance: ["수수료 3%·최소 1만원 적용", "구글 시트에 집계된 정산표"],
    tests: ["합계 검증"],
    prerequisites: tool === "claude" ? ["SMTP 발송 설정", "SMTP 발송 서비스", "판매내역 파일 접근 권한"] : ["판매내역 파일 접근 권한"],
  } as unknown as AxPlan;
}

// 검토는 반드시 hitl.ts의 실제 검토 대상 키로 만든다 (해시 기반 키 — 임의 문자열 키는 매칭되지 않는다).
let seq = 0;
function diagReview(d: AxDiagnosis, kind: "step" | "risk", index: number, action: "exclude" | "defer" | "keep", extra: Partial<HitlReview> = {}): HitlReview {
  const item = extractReviewableItems(d).filter(i => i.type === kind)[index];
  if (!item) throw new Error(`no ${kind} reviewable at ${index}`);
  return {
    id: `roadmap-${kind}-${index}-${action}-${++seq}`,
    target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash },
    action, status: "confirmed",
    reason: extra.reason ?? (action === "exclude" ? "제외 결정" : action === "defer" ? "보류 결정" : "유지 결정"),
    resumeCondition: extra.resumeCondition,
    reviewedAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z",
  } as HitlReview;
}
function planReview(p: AxPlan, tool: "codex" | "claude", text: string, action: "exclude" | "defer" | "keep", extra: Partial<HitlReview> = {}): HitlReview {
  const item = extractPlanReviewableItems(p, tool).find(i => i.type === "planItem" && i.text === text);
  if (!item) throw new Error(`no plan item ${text}`);
  return {
    id: `roadmap-plan-${tool}-${action}-${++seq}`,
    target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash },
    action, status: "confirmed",
    reason: extra.reason ?? (action === "exclude" ? "제외 결정" : action === "defer" ? "보류 결정" : "유지 결정"),
    resumeCondition: extra.resumeCondition,
    reviewedAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z",
  } as HitlReview;
}
function codexReviews(): HitlReview[] {
  const p = plan("codex");
  return [
    planReview(p, "codex", "SMTP 연동으로 명세서 자동 이메일 전송", "exclude", { reason: "이메일 발송 제외" }),
    planReview(p, "codex", "계산 결과를 Google Sheets API로 업데이트", "defer", { reason: "시트 입력 보류", resumeCondition: "담당자 승인 후 재개" }),
    planReview(p, "codex", "수수료 계산", "keep", { reason: "수수료 3% 유지" }),
    planReview(p, "codex", "최소 금액 적용", "keep", { reason: "최소 1만원 유지" }),
  ];
}
function claudeReviews(): HitlReview[] {
  const p = plan("claude");
  return [
    planReview(p, "claude", "SMTP 연동으로 명세서 자동 이메일 전송", "exclude", { reason: "이메일 발송 제외" }),
    planReview(p, "claude", "계산 결과를 Google Sheets API로 업데이트", "defer", { reason: "시트 입력 보류", resumeCondition: "담당자 승인 후 재개" }),
    planReview(p, "claude", "수수료 계산", "keep", { reason: "수수료 3% 유지" }),
    planReview(p, "claude", "최소 금액 적용", "keep", { reason: "최소 1만원 유지" }),
  ];
}
function model(tool: "codex" | "claude", reviews: HitlReview[]): AgentInstructionModel {
  return buildAgentInstructionModel(plan(tool), { diagnosis: diagnosis(), hitlReviews: reviews, hitlTool: tool });
}
function roadmapPhase1(d: AxDiagnosis): string[] {
  return executionProfile(d).roadmap[0]?.items ?? [];
}

describe("AX 로드맵·01~04 HITL 정합성", () => {
  test("T1 HITL 미적용 시 기존 로드맵 유지", () => {
    const d = diagnosis();
    expect(roadmapPhase1(d)).toContain("SMTP 발송 설정 — 정산 명세서 자동 발송에 필요");
    const summary = planSummary(d, plan("codex"));
    expect(summary.include.join(" ")).toContain("명세서 이메일 전송");
    expect(summary.checks.find(c => c.topic === "SMTP 발송 설정")?.tone).toBe("required");
  });

  test("T2 선택 기술 확인 항목 제외", () => {
    const d = diagnosis();
    const reviews = [diagReview(d, "risk", 0, "exclude", { reason: "SMTP 제외" })];
    const m = buildAgentInstructionModel(undefined, { diagnosis: d, hitlReviews: reviews });
    expect(hitlDispositionForText(m, "SMTP 발송 설정 — 정산 명세서 자동 발송에 필요")?.action).toBe("exclude");
    const summary = planSummary(d, undefined, "", { hitlReviews: reviews });
    expect(summary.checks.find(c => c.topic === "SMTP 발송 설정")).toBeUndefined();
    expect(filterRoadmapItems(m, roadmapPhase1(d)).current).not.toContain("SMTP 발송 설정 — 정산 명세서 자동 발송에 필요");
  });

  test("T3 필수 기술 확인 항목 제외와 안전 제약 보존", () => {
    // 거부(불가) 검사는 HITL 제외와 무관하게 보존된다.
    const d = diagnosis();
    const reviews = [diagReview(d, "risk", 5, "exclude", { reason: "SMTP 제외" })];
    const m = buildAgentInstructionModel(undefined, { diagnosis: d, hitlReviews: reviews });
    const summary = planSummary(d, undefined, "", { hitlReviews: reviews });
    const denied = summary.checks.find(c => c.topic === "SMTP 발송");
    expect(denied?.tone).toBe("blocked");
    expect(hitlDispositionForText(m, "SMTP 발송 — 명세서 자동 전송 금지")).toBeUndefined();
    expect(buildAllInOnePrompt(undefined, "codex", { diagnosis: d, hitlReviews: reviews })).toContain("명세서 자동 전송 금지");
  });

  test("T4 특정 업무 단계 보류", () => {
    const m = model("codex", codexReviews());
    expect(hitlDispositionForStep(m, "구글 시트에 집계 입력")?.action).toBe("defer");
    expect(hitlDispositionForStep(m, "구글 시트에 집계 입력")?.resumeCondition).toBe("담당자 승인 후 재개");
    const filtered = filterRoadmapItems(m, ["구글 시트에 집계 입력 규칙 기반 처리", "판매 데이터 수집 규칙 기반 처리"]);
    expect(filtered.current).toEqual(["판매 데이터 수집 규칙 기반 처리"]);
    expect(filtered.held[0]?.text).toBe("구글 시트에 집계 입력 규칙 기반 처리");
    expect(filtered.held[0]?.resumeCondition).toBe("담당자 승인 후 재개");
    const summary = planSummary(diagnosis(), plan("codex"), "", { hitlReviews: codexReviews(), hitlTool: "codex" });
    expect(summary.include.join(" ")).not.toContain("구글 시트에 집계 입력");
  });

  test("T5 계획 항목 제외", () => {
    const m = model("codex", codexReviews());
    expect(hitlDispositionForStep(m, "명세서 이메일 전송")?.action).toBe("exclude");
    const summary = planSummary(diagnosis(), plan("codex"), "", { hitlReviews: codexReviews(), hitlTool: "codex" });
    expect(summary.include.join(" ")).not.toContain("명세서 이메일 전송");
    expect(summary.excluded.join(" ")).toContain("SMTP 연동으로 명세서 자동 이메일 전송");
  });

  test("T6 제외·보류·유지 혼합", () => {
    const m = model("codex", codexReviews());
    const summary = planSummary(diagnosis(), plan("codex"), "", { hitlReviews: codexReviews(), hitlTool: "codex" });
    expect(summary.include.join(" ")).toContain("수수료 계산");
    expect(summary.include.join(" ")).toContain("최소 금액 적용");
    expect(summary.include.join(" ")).not.toContain("명세서 이메일 전송");
    expect(summary.include.join(" ")).not.toContain("구글 시트에 집계 입력");
    // 04: 제외 결정문은 사람 검토 구간에 명시되고, 범위·기능·완료 기준에는 없다.
    const prompt = buildAllInOnePrompt(plan("codex"), "codex", { diagnosis: diagnosis(), hitlReviews: codexReviews(), hitlTool: "codex" });
    expect(prompt).toContain("SMTP 연동으로 명세서 자동 이메일 전송");
    const beforeReview = prompt.slice(0, prompt.indexOf("사람 검토"));
    expect(beforeReview).not.toContain("SMTP 연동으로 명세서 자동 이메일 전송");
    expect(beforeReview).not.toContain("구글 시트에 집계된 정산표");
    expect(m.hitlDetails?.removedSteps?.length).toBeGreaterThan(0);
  });

  test("T7 동일 기능의 여러 출처·표현 (외래어)", () => {
    // 계획 결정 "Google Sheets API로 업데이트"가 진단 기술확인 "Google Sheets API 사용 권한"과
    // 단계명 "구글 시트에 집계 입력"에 전파된다 (외래어 표준화).
    const m = model("codex", codexReviews());
    expect(hitlDispositionForText(m, "Google Sheets API 사용 권한 — 구글 시트 자동 입력 단계에 필요")?.action).toBe("defer");
    const filtered = filterRoadmapItems(m, roadmapPhase1(diagnosis()));
    expect(filtered.current).not.toContain("Google Sheets API 사용 권한 — 구글 시트 자동 입력 단계에 필요");
    const summary = planSummary(diagnosis(), plan("codex"), "", { hitlReviews: codexReviews(), hitlTool: "codex" });
    expect(summary.checks.find(c => c.topic === "Google Sheets API 사용 권한")?.tone).toBe("held");
  });

  test("T8 서로 다른 기능의 유사 문구 (과도 제거 금지)", () => {
    const m = model("codex", codexReviews());
    const summary = planSummary(diagnosis(), plan("codex"), "", { hitlReviews: codexReviews(), hitlTool: "codex" });
    // 유지 기능의 파일 접근 권한은 제외·보류 결정과 무관하게 남는다.
    expect(summary.checks.find(c => c.topic === "판매내역 파일 접근 권한")?.tone).toBe("required");
    // Phase 1은 최대 4개로 잘리므로 유지 조건은 필터 입력에 직접 넣어 과도 제거 없음을 확인한다.
    expect(filterRoadmapItems(m, [...roadmapPhase1(diagnosis()), "판매내역 파일 접근 권한 — 판매내역.csv 읽기 필요"]).current)
      .toContain("판매내역 파일 접근 권한 — 판매내역.csv 읽기 필요");
    // "이메일 서버 접근 권한"은 #295에서 인증된 전파 규칙으로 제거된다: 결정문과
    // 이메일·SMTP·자동 토큰이 겹치고, 모델에 다운로드 단계를 독립 단계로 연결하는
    // 단계 귀속이 없어(검사 메모의 언급만으로는 단계 연결이 생기지 않음) 현재
    // 조건에서 빠진다. 이는 #295 라이브 §4 "4건 전부 소멸" PASS 판정과 동일하다.
    // 다운로드 기능이 독립 유지 단계로 확인되면 그 단계의 keep 결정이 별도로 필요하다.
    expect(summary.checks.find(c => c.topic === "이메일 서버 접근 권한")).toBeUndefined();
  });

  test("T9 Level 0 및 Gate blocked", () => {
    const blocked = { ...diagnosis(), decisionGate: { verdict: "no-go", reasons: ["차단 사유"] } } as unknown as AxDiagnosis;
    expect(executionProfile(blocked).gate).toBe("blocked");
    const reviews = [diagReview(blocked, "step", 6, "exclude", { reason: "이메일 제외" })];
    const summary = planSummary(blocked, undefined, "", { hitlReviews: reviews });
    expect(summary.include.join(" ")).not.toContain("명세서 이메일 전송");
    const m = buildAgentInstructionModel(undefined, { diagnosis: blocked, hitlReviews: reviews });
    expect(hitlDispositionForStep(m, "명세서 이메일 전송")?.action).toBe("exclude");
  });

  test("T10 확정 후 새로고침·재조회 (결정론성)", () => {
    const a = model("codex", codexReviews());
    const b = model("codex", codexReviews());
    expect(JSON.stringify(a.hitlDetails?.removed)).toBe(JSON.stringify(b.hitlDetails?.removed));
    expect(JSON.stringify(a.hitlDetails?.removedSteps)).toBe(JSON.stringify(b.hitlDetails?.removedSteps));
    expect(filterRoadmapItems(a, roadmapPhase1(diagnosis()))).toEqual(filterRoadmapItems(b, roadmapPhase1(diagnosis())));
  });

  test("T11 원본 변경으로 HITL 재확인 필요 (stale 리뷰 미적용)", () => {
    // 원본 단계명이 바뀌면 진단 단계 검토는 현재 원본과 연결되지 않는다.
    // 계획 항목 자체는 동일하므로 계획 검토는 여전히 적용된다 — 모델이 stale
    // 진단을 임의로 제외하지 않고, 유효성 판정은 hitl.ts가 담당함을 확인한다.
    const changed = diagnosis();
    (changed.stepAssessments as Array<{ step: string }>)[6].step = "명세서 이메일 발송";
    const d = diagnosis();
    const staleStepReview = diagReview(d, "step", 6, "exclude", { reason: "이메일 제외" });
    const m = buildAgentInstructionModel(undefined, { diagnosis: changed, hitlReviews: [staleStepReview] });
    expect(hitlDispositionForStep(m, "명세서 이메일 발송")).toBeUndefined();
    expect(hitlDispositionForStep(m, "명세서 이메일 전송")).toBeUndefined();
  });

  test("T12 Codex·Claude 검토 결과 분리", () => {
    const codexPrompt = buildAllInOnePrompt(plan("codex"), "codex", { diagnosis: diagnosis(), hitlReviews: [...codexReviews(), ...claudeReviews()], hitlTool: "codex" });
    const claudePrompt = buildAllInOnePrompt(plan("claude"), "claude", { diagnosis: diagnosis(), hitlReviews: [...codexReviews(), ...claudeReviews()], hitlTool: "claude" });
    expect(codexPrompt).not.toContain("구글 시트에 집계된 정산표");
    expect(claudePrompt).not.toContain("구글 시트에 집계된 정산표");
    // 상대 도구 계획 항목 키는 자기 모델에 매칭되지 않는다.
    const codexModel = model("codex", [...codexReviews(), ...claudeReviews()]);
    const claudeModel = model("claude", [...codexReviews(), ...claudeReviews()]);
    expect(codexModel.hitlDetails?.removedSteps?.length).toBeGreaterThan(0);
    expect(claudeModel.hitlDetails?.removedSteps?.length).toBeGreaterThan(0);
  });

  test("01 include·excluded, 02 checks·prerequisites, 03 criteria, 로드맵 산출물", () => {
    const d = diagnosis();
    const m = model("codex", codexReviews());
    const summary = planSummary(d, plan("codex"), "", { hitlReviews: codexReviews(), hitlTool: "codex" });
    // 02 prerequisites: 제외·보류 전용 조건이 빠지고, 유지 조건이 남는다.
    expect(summary.prerequisites.join(" ")).not.toContain("SMTP 발송 설정");
    expect(summary.prerequisites.join(" ")).toContain("판매내역 파일 접근 권한");
    // 02 checks: 보류는 held 톤 + 사유·재개 조건, 제외는 제거.
    const held = summary.checks.find(c => c.topic === "Google Sheets API 사용 권한");
    expect(held?.tone).toBe("held");
    expect(held?.note).toContain("담당자 승인 후 재개");
    // 03 criteria: 계획 완료 기준(acceptance)에서 제외·보류 기능이 남지 않는다.
    // 진단 원본 PoC 성공 기준은 별도 경계로 남는다(04의 criterionRelatesOnlyToExcluded도
    // 활성 단계와 단어를 공유하면 보수적으로 유지하므로, 이 작업에서 토큰 유사성으로
    // 임의 제거하지 않는다 — REPORT.md 잔존 관찰 항목 참조).
    expect(summary.success.join(" ")).not.toContain("구글 시트에 집계된 정산표");
    expect(summary.success.join(" ")).toContain("수수료 3%·최소 1만원 적용");
    // 로드맵 최종 산출물: HITL 필터링된 outputs에 제외·보류 산출물이 없다.
    expect(m.scoped.outputs.map(o => o.text).join(" ")).not.toContain("구글 시트에 집계된 정산표");
    // 단계 상세 매핑: 제거 단계는 disposition과 함께, 유지 단계는 올바른 모델 인덱스와 함께.
    const profile = executionProfile(d);
    const entries = stepDetailEntries(m, profile);
    expect(entries.length).toBe(profile.stepScope.length);
    const email = entries.find(e => e.step.step === "명세서 이메일 전송");
    expect(email?.modelIndex).toBeNull();
    expect(email?.disposition?.action).toBe("exclude");
    const fee = entries.find(e => e.step.step === "수수료 계산");
    expect(fee?.modelIndex).not.toBeNull();
    expect(fee?.disposition).toBeUndefined();
  });

  test("로드맵 Phase 1 라이브 문구 4건 전부", () => {
    const d = diagnosis();
    const m = model("codex", codexReviews());
    const filtered = filterRoadmapItems(m, roadmapPhase1(d));
    const joined = filtered.current.join(" ");
    expect(joined).not.toContain("SMTP 발송 설정 — 정산 명세서 자동 발송에 필요");
    expect(joined).not.toContain("SMTP server for email dispatch");
    expect(joined).not.toContain("이메일 서버 접근 권한");
    expect(joined).not.toContain("Google Sheets API 사용 권한");
    expect(roadmapPhase1(d).join(" ")).toContain("SMTP 발송 설정");
  });

  test("§4 Claude 축약 조건: 계획 prerequisites 축약형은 confirm 조건으로 남고 구현 요구가 아님", () => {
    // Claude 계획 prerequisites의 "SMTP 발송 설정"/"SMTP 발송 서비스"는 결정문
    // "SMTP 연동으로 명세서 자동 이메일 전송"과 토큰 겹침이 SMTP 1개뿐이라
    // 전파 규칙(2개 이상 + 특이 토큰)에 걸리지 않는다. 단계 귀속이 없는 확인
    // 조건이므로 confirm 조건으로 남는 것이 맞고, 구현 요구로 승격되지 않는다.
    const prompt = buildAllInOnePrompt(plan("claude"), "claude", { diagnosis: diagnosis(), hitlReviews: claudeReviews(), hitlTool: "claude" });
    const beforeReview = prompt.slice(0, prompt.indexOf("사람 검토"));
    expect(beforeReview).not.toContain("명세서 이메일 전송");
    expect(beforeReview).not.toContain("SMTP 연동으로 명세서 자동 이메일 전송");
    expect(beforeReview).not.toContain("구글 시트에 집계된 정산표");
  });

  test("게이트 선행 조건은 HITL 모델의 conditions에서 자동 일관", () => {
    const m = model("codex", codexReviews());
    expect(gatePrerequisites(diagnosis()).join(" ")).toContain("SMTP 발송 설정");
    expect(m.conditions.current.map(c => c.text).join(" ")).not.toContain("SMTP 발송 설정");
    expect(m.conditions.confirm.map(c => c.text).join(" ")).not.toContain("Google Sheets API 사용 권한");
  });

  test("hitlDispositionForStepLine 접두사 경계 (부분 이름 오매칭 금지)", () => {
    const m = model("codex", codexReviews());
    // "구글 시트"만으로는 단계 "구글 시트에 집계 입력"과 매칭되지 않아야 한다.
    expect(hitlDispositionForStepLine(m, "구글 시트")).toBeUndefined();
    expect(hitlDispositionForStepLine(m, "구글 시트에 집계 입력 규칙 기반 처리")?.action).toBe("defer");
  });
});
