import { describe, expect, test } from "vitest";
import {
  buildAgentInstructionModel,
  buildAllInOnePrompt,
  isDemotedPocCriterion,
  isExcludedPocCriterion,
  planSummary,
} from "../src/lib/ax/guide";
import { extractPlanReviewableItems } from "../src/lib/ax/hitl";
import type { AxDiagnosis, AxPlan, HitlReview } from "../src/lib/ax/types";

// #296 라이브 잔존 1건과 동등한 구조: 실제 단계명 8개, PoC 성공 기준에
// "이메일 발송 성공 로그 기록" 포함. 03은 표시 없이 통과 조건으로 남겼고,
// 04는 "현재 필수 완료 조건 아님 (관련 단계 제외됨)"으로 강등했다.
const STEPS = [
  "이메일에서 엑셀 파일 다운로드",
  "파일 형식별 수동 정리",
  "판매자별 매출 합산",
  "수수료 차감 및 최소 금액 적용",
  "구글 시트에 집계 입력",
  "이상 금액 확인 및 담당자 승인",
  "정산 명세서 생성",
  "이메일로 정산 명세서 발송",
];

function diagnosis(pocSuccess: string[] = ["이메일 발송 성공 로그 기록", "정산 계산 오류가 없으며 최소 금액 규칙 적용 확인"]): AxDiagnosis {
  return {
    sourceNote: "03 PoC 기준 픽스처",
    factors: [
      { key: "repetition", aiValue: 4, rationale: "" },
      { key: "regularity", aiValue: 4, rationale: "" },
      { key: "dataStructure", aiValue: 2, rationale: "" },
      { key: "systemAccess", aiValue: 3, rationale: "" },
      { key: "humanJudgment", aiValue: 3, rationale: "" },
      { key: "operationalRisk", aiValue: 2, rationale: "" },
    ],
    stepAssessments: STEPS.map((step, i) => ({
      step,
      verdict: "자동화" as const,
      treatment: i === 1 || i === 5 ? "담당자 수행" : "확인 후 구현",
      scope: "current" as const,
      owner: "시스템" as const,
      note: "",
    })),
    technicalChecks: [],
    followUpQuestions: [],
    decisionGate: { verdict: "conditional", reasons: ["선행 확인 필요"] },
    informationSufficiency: "sufficient",
    asIs: { purpose: "주간 판매자 정산 집계 및 명세서 발송", trigger: "매주", inputs: ["판매자별 주간 판매 엑셀 파일"], outputs: ["판매자별 정산 명세서"], steps: STEPS, exceptions: [], humanDecisions: [], systems: ["이메일", "Excel", "구글 시트"] },
    toBe: [],
    poc: {
      inScope: STEPS.map(s => `${s} 확인 후 구현`),
      outOfScope: [],
      success: pocSuccess,
      tests: [],
      evaluation: [],
    },
  } as unknown as AxDiagnosis;
}

function plan(): AxPlan {
  return {
    implementation: [
      "이메일에서 엑셀 파일 다운로드",
      "판매자별 매출 합산",
      "수수료 차감 및 최소 금액 적용",
      "정산 명세서 생성",
      "SMTP 연동으로 명세서 자동 이메일 전송",
      "계산 결과를 Google Sheets API로 업데이트",
    ],
    integrations: ["SMTP 서버 연동", "Google Sheets API 연동"],
    dataFlow: ["엑셀 → 집계 → 정산표"],
    acceptance: ["수수료 3%·최소 1만원 적용"],
    tests: ["합계 검증"],
    prerequisites: ["판매내역 파일 접근 권한"],
  } as unknown as AxPlan;
}

let seq = 0;
function planReview(p: AxPlan, tool: "codex" | "claude", text: string, action: "exclude" | "defer" | "keep", extra: Partial<HitlReview> = {}): HitlReview {
  const item = extractPlanReviewableItems(p, tool).find(i => i.type === "planItem" && i.text === text);
  if (!item) throw new Error(`no plan item ${text} for ${tool}`);
  return {
    id: `poc03-${tool}-${action}-${++seq}`,
    target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash },
    action, status: "confirmed",
    reason: extra.reason ?? action,
    resumeCondition: extra.resumeCondition,
    reviewedAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z",
  } as HitlReview;
}

function reviews(tool: "codex" | "claude"): HitlReview[] {
  const p = plan();
  return [
    planReview(p, tool, "SMTP 연동으로 명세서 자동 이메일 전송", "exclude", { reason: "테스트 범위 축소: 이번 검증에서는 자동 이메일 발송을 구현하지 않고 명세서는 담당자가 수동으로 발송한다." }),
    planReview(p, tool, "계산 결과를 Google Sheets API로 업데이트", "defer", { reason: "Google Sheets API 권한이 아직 확보되지 않아 지금은 자동 업데이트를 진행하지 않는다.", resumeCondition: "Google Sheets API 권한이 확보되고 샘플 시트에서 입력 검증이 완료된 뒤에만 재개한다. 그 전에는 구글 시트 자동 업데이트를 구현하지 않는다." }),
    planReview(p, tool, "수수료 차감 및 최소 금액 적용", "keep", { reason: "유지" }),
  ];
}

function overallCriteriaSection(prompt: string): string {
  const start = prompt.indexOf("### 업무 전체 완료 기준");
  if (start < 0) return "";
  const end = prompt.indexOf("### ", start + 10);
  return end < 0 ? prompt.slice(start) : prompt.slice(start, end);
}

describe("AX 03·04 PoC 기준 표시 일치", () => {
  test("Codex: 제외 단계 관련 PoC 기준은 03 통과 조건에 표시 없이 남지 않는다", () => {
    const d = diagnosis();
    const p = plan();
    const r = reviews("codex");
    const summary = planSummary(d, p, "", { hitlReviews: r, hitlTool: "codex" });
    expect(summary.success.join(" ")).not.toContain("이메일 발송 성공 로그 기록");
    // 정상 기준은 03·04 모두에 남는다.
    expect(summary.success.join(" ")).toContain("정산 계산 오류가 없으며 최소 금액 규칙 적용 확인");
    expect(summary.success.join(" ")).toContain("수수료 3%·최소 1만원 적용");
    const prompt = buildAllInOnePrompt(p, "codex", { diagnosis: d, hitlReviews: r, hitlTool: "codex" });
    expect(overallCriteriaSection(prompt)).not.toContain("이메일 발송 성공 로그 기록");
    expect(overallCriteriaSection(prompt)).toContain("정산 계산 오류가 없으며 최소 금액 규칙 적용 확인");
    // 04 참고 판정에는 강등 표시로 남는다 (정보 소실 아님).
    expect(prompt).toContain("이메일 발송 성공 로그 기록 — 현재 필수 완료 조건 아님 (관련 단계 제외됨)");
  });

  test("Claude: 동일 규칙이 진단 PoC 기준에 도구 무관하게 적용된다", () => {
    const d = diagnosis();
    const p = plan();
    const r = reviews("claude");
    const summary = planSummary(d, p, "", { hitlReviews: r, hitlTool: "claude" });
    expect(summary.success.join(" ")).not.toContain("이메일 발송 성공 로그 기록");
    expect(summary.success.join(" ")).toContain("정산 계산 오류가 없으며 최소 금액 규칙 적용 확인");
  });

  test("경계: 제외 단계와 활성 단계 단어를 모두 공유하는 기준은 보수적으로 유지된다", () => {
    // "명세서 발송 생성 확인"은 제외 단계(이메일로 정산 명세서 발송)와
    // 활성 단계(정산 명세서 생성) 양쪽과 단어를 공유하므로, 04 강등 규칙이
    // 발동하지 않는다. 03도 같은 판정으로 유지해야 한다.
    const d = diagnosis(["명세서 발송 생성 확인"]);
    const p = plan();
    const r = reviews("codex");
    const summary = planSummary(d, p, "", { hitlReviews: r, hitlTool: "codex" });
    const prompt = buildAllInOnePrompt(p, "codex", { diagnosis: d, hitlReviews: r, hitlTool: "codex" });
    expect(summary.success.join(" ")).toContain("명세서 발송 생성 확인");
    expect(overallCriteriaSection(prompt)).toContain("명세서 발송 생성 확인");
  });

  test("차단 상태: 제외 관계가 없는 PoC 기준은 03에 유지된다 (기존 E2E 동작)", () => {
    // 03 "완료 기준"은 진단 자체의 기준 기록이고, 실행 불가 여부는 게이트 배지가
    // 표시한다 (E2E ax.spec.ts:1356이 전 Level×Gate에서 기준 표시를 고정).
    // 04만 실행 지시문으로서 차단 시 강등한다 — 차단 분기는 03·04가 공유하지 않는
    // 의도된 구분이며, 결함인 제외 관계는 차단 상태에서도 03·04 모두에서 걸러진다
    // (다음 테스트).
    const blocked = { ...diagnosis(), decisionGate: { verdict: "no-go", reasons: ["차단 사유"] } } as unknown as AxDiagnosis;
    const p = plan();
    const r = reviews("codex");
    const summary = planSummary(blocked, p, "", { hitlReviews: r, hitlTool: "codex" });
    expect(summary.success.join(" ")).toContain("정산 계산 오류가 없으며 최소 금액 규칙 적용 확인");
    expect(summary.success.join(" ")).toContain("수수료 3%·최소 1만원 적용");
    const prompt = buildAllInOnePrompt(p, "codex", { diagnosis: blocked, hitlReviews: r, hitlTool: "codex" });
    expect(overallCriteriaSection(prompt)).not.toContain("정산 계산 오류가 없으며 최소 금액 규칙 적용 확인");
    expect(prompt).toContain("정산 계산 오류가 없으며 최소 금액 규칙 적용 확인 — 현재 필수 완료 조건 아님 (실행 차단 상태)");
  });

  test("차단 상태에서도 제외 관계 PoC 기준은 03·04 모두에서 걸러진다", () => {
    const blocked = { ...diagnosis(), decisionGate: { verdict: "no-go", reasons: ["차단 사유"] } } as unknown as AxDiagnosis;
    const p = plan();
    const r = reviews("codex");
    const summary = planSummary(blocked, p, "", { hitlReviews: r, hitlTool: "codex" });
    expect(summary.success.join(" ")).not.toContain("이메일 발송 성공 로그 기록");
    expect(summary.success.join(" ")).toContain("정산 계산 오류가 없으며 최소 금액 규칙 적용 확인");
    const prompt = buildAllInOnePrompt(p, "codex", { diagnosis: blocked, hitlReviews: r, hitlTool: "codex" });
    expect(overallCriteriaSection(prompt)).not.toContain("이메일 발송 성공 로그 기록");
    expect(prompt).toContain("이메일 발송 성공 로그 기록 — 현재 필수 완료 조건 아님 (실행 차단 상태)");
  });

  test("HITL 미적용 시 03·04 동작 불변 (강등 판정 없음)", () => {
    const d = diagnosis();
    const p = plan();
    const summary = planSummary(d, p);
    expect(summary.success.join(" ")).toContain("이메일 발송 성공 로그 기록");
    expect(summary.success.join(" ")).toContain("정산 계산 오류가 없으며 최소 금액 규칙 적용 확인");
  });

  test("isDemotedPocCriterion / isExcludedPocCriterion: 범위·출처 조건과 차단 분기 구분", () => {
    const d = diagnosis();
    const p = plan();
    const r = reviews("codex");
    const m = buildAgentInstructionModel(p, { diagnosis: d, hitlReviews: r, hitlTool: "codex" });
    const emailItem = m.classified.find(i => i.text === "이메일 발송 성공 로그 기록")!;
    const controlItem = m.classified.find(i => i.text === "정산 계산 오류가 없으며 최소 금액 규칙 적용 확인")!;
    expect(isExcludedPocCriterion(m, emailItem)).toBe(true);
    expect(isExcludedPocCriterion(m, controlItem)).toBe(false);
    expect(isDemotedPocCriterion(m, emailItem)).toBe(true);
    expect(isDemotedPocCriterion(m, controlItem)).toBe(false);
    // acceptance 항목은 PoC 기준이 아니므로 어느 쪽도 강등 대상이 아니다.
    const feeItem = m.classified.find(i => i.text === "수수료 3%·최소 1만원 적용")!;
    expect(isExcludedPocCriterion(m, feeItem)).toBe(false);
    expect(isDemotedPocCriterion(m, feeItem)).toBe(false);
    // 차단 상태에서는 04만 강등하고, 03용 제외 관계 판정은 그대로 false이다.
    const blocked = { ...d, decisionGate: { verdict: "no-go", reasons: ["차단 사유"] } } as unknown as AxDiagnosis;
    const mb = buildAgentInstructionModel(p, { diagnosis: blocked, hitlReviews: r, hitlTool: "codex" });
    const controlBlocked = mb.classified.find(i => i.text === "정산 계산 오류가 없으며 최소 금액 규칙 적용 확인")!;
    expect(isDemotedPocCriterion(mb, controlBlocked)).toBe(true);
    expect(isExcludedPocCriterion(mb, controlBlocked)).toBe(false);
  });
});
