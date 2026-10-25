import { describe, expect, test } from "vitest";
import {
  buildAllInOnePrompt,
  buildAgentInstructionModel,
  isExcludedPocCriterion,
  isExcludedStepCriterion,
  planSummary,
} from "../src/lib/ax/guide";
import { extractPlanReviewableItems } from "../src/lib/ax/hitl";
import type { AxDiagnosis, AxPlan, HitlReview } from "../src/lib/ax/types";

// PR #300 이후 라이브 간극 (2026-10-26 07:53~07:55 KST 확인):
// Codex 03 통과 조건에 "이메일 발송 성공 로그 기록"이 표시 없이 남아 있었다.
// 원인: #300의 03 필터(isExcludedPocCriterion)는 진단 PoC 출처 기준에만 적용됐고,
// 03 통과 조건은 계획 acceptance 기준까지 합쳐 표시하는데, 라이브 Codex 계획의
// acceptance 목록에 동일 문구의 사본이 있었다. 04는 그 사본을 이미 참고 판정으로
// 구분하고 있었으므로, 03이 사본을 통과 조건으로 남기는 것은 03·04 불일치였다.
// 수정: 03 criteria()는 출처와 무관하게 제외 단계와만 관련되는 완료 기준을
// 걸러낸다 (isExcludedStepCriterion). 04 출력·검토표·유지 항목은 변하지 않는다.
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
const EMAIL = "이메일 발송 성공 로그 기록";
const ITEM1 = "불일치 항목이 없거나 사소한 오류만 발견될 경우 자동화 단계 진행";

function diagnosis(): AxDiagnosis {
  return {
    sourceNote: "03 라이브 간극 픽스처",
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
    poc: { inScope: STEPS.map(s => `${s} 확인 후 구현`), outOfScope: [], success: [ITEM1, EMAIL], tests: [], evaluation: [] },
  } as unknown as AxDiagnosis;
}

function plan(acceptance: string[] = [
  "자동 파싱 결과가 수동 결과와 100% 일치",
  "정산 계산 로직 오류 없음",
  "명세서 파일 형식·내용이 템플릿 기준 충족",
  EMAIL,
  "수수료 3%·최소 1만원 적용",
]): AxPlan {
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
    acceptance,
    tests: ["합계 검증"],
    prerequisites: ["판매내역 파일 접근 권한"],
  } as unknown as AxPlan;
}

let seq = 0;
function planReview(p: AxPlan, text: string, action: "exclude" | "defer" | "keep"): HitlReview {
  const item = extractPlanReviewableItems(p, "codex").find(i => i.type === "planItem" && i.text === text);
  if (!item) throw new Error(`no plan item ${text}`);
  return {
    id: `livegap-${action}-${++seq}`,
    target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash },
    action, status: "confirmed", reason: action,
    reviewedAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z",
  } as HitlReview;
}

function reviews(p: AxPlan): HitlReview[] {
  return [
    planReview(p, "SMTP 연동으로 명세서 자동 이메일 전송", "exclude"),
    planReview(p, "계산 결과를 Google Sheets API로 업데이트", "defer"),
    planReview(p, "수수료 차감 및 최소 금액 적용", "keep"),
  ];
}

function overallSection(prompt: string): string {
  const start = prompt.indexOf("### 업무 전체 완료 기준");
  if (start < 0) return "";
  const end = prompt.indexOf("### ", start + 10);
  return end < 0 ? prompt.slice(start) : prompt.slice(start, end);
}
function refSection(prompt: string): string {
  const start = prompt.indexOf("### 참고 판정 (필수 완료 조건 아님)");
  if (start < 0) return "";
  const end = prompt.indexOf("### ", start + 10);
  return end < 0 ? prompt.slice(start) : prompt.slice(start, end);
}

describe("AX 03 라이브 간극: 계획 acceptance 사본까지 03·04 일치", () => {
  test("라이브 동등 입력: 제외 기능 문구가 어느 출처에서 와도 03 통과 조건에 남지 않는다", () => {
    const d = diagnosis();
    const p = plan();
    const r = reviews(p);
    const summary = planSummary(d, p, "", { hitlReviews: r, hitlTool: "codex" });
    expect(summary.success.join(" ")).not.toContain(EMAIL);
    // 라이브 정상 기준 4개 + 유지 acceptance는 그대로 남는다.
    expect(summary.success.join(" ")).toContain(ITEM1);
    expect(summary.success.join(" ")).toContain("자동 파싱 결과가 수동 결과와 100% 일치");
    expect(summary.success.join(" ")).toContain("정산 계산 로직 오류 없음");
    expect(summary.success.join(" ")).toContain("명세서 파일 형식·내용이 템플릿 기준 충족");
    expect(summary.success.join(" ")).toContain("수수료 3%·최소 1만원 적용");
    // 04는 변경 없음: 전체 완료 기준은 불일치 문구 1개, 참고 판정에 강등 표시 유지.
    const prompt = buildAllInOnePrompt(p, "codex", { diagnosis: d, hitlReviews: r, hitlTool: "codex" });
    expect(overallSection(prompt)).toContain(ITEM1);
    expect(overallSection(prompt)).not.toContain(EMAIL);
    expect(refSection(prompt)).toContain(`${EMAIL} — 현재 필수 완료 조건 아님 (관련 단계 제외됨)`);
    expect(refSection(prompt)).toContain(`${EMAIL} — 생성·검증 대상 단계의 연결 근거 확인 필요: 업무 전체 산출물·PoC 문구만으로 현재 필수 항목으로 승격하지 않음 — 현재 필수 완료 조건 아님`);
  });

  test("경계: 활성 단계와 단어를 공유하는 acceptance 사본은 보수적으로 유지된다", () => {
    const d = diagnosis();
    const p = plan(["명세서 발송 생성 확인", "수수료 3%·최소 1만원 적용"]);
    const r = reviews(p);
    const summary = planSummary(d, p, "", { hitlReviews: r, hitlTool: "codex" });
    expect(summary.success.join(" ")).toContain("명세서 발송 생성 확인");
    expect(summary.success.join(" ")).toContain("수수료 3%·최소 1만원 적용");
  });

  test("isExcludedStepCriterion: PoC 래퍼와 출처 무관 판정의 구분", () => {
    const d = diagnosis();
    const p = plan();
    const r = reviews(p);
    const m = buildAgentInstructionModel(p, { diagnosis: d, hitlReviews: r, hitlTool: "codex" });
    const pocEmail = m.classified.find(i => i.text === EMAIL && i.sources.includes("diagnosis.poc.success"))!;
    const acceptanceEmail = m.classified.find(i => i.text === EMAIL && i.sources.includes("plan.acceptance"))!;
    expect(pocEmail).toBeDefined();
    expect(acceptanceEmail).toBeDefined();
    // PoC 항목은 양쪽 판정 모두 true, acceptance 사본은 일반 판정만 true.
    expect(isExcludedPocCriterion(m, pocEmail)).toBe(true);
    expect(isExcludedStepCriterion(m, pocEmail)).toBe(true);
    expect(isExcludedPocCriterion(m, acceptanceEmail)).toBe(false);
    expect(isExcludedStepCriterion(m, acceptanceEmail)).toBe(true);
    // 유지 acceptance는 어느 판정에도 걸리지 않는다.
    const fee = m.classified.find(i => i.text === "수수료 3%·최소 1만원 적용")!;
    expect(isExcludedStepCriterion(m, fee)).toBe(false);
    expect(isExcludedPocCriterion(m, fee)).toBe(false);
  });

  test("HITL 미적용 시 03 동작 불변 (사본도 그대로 표시)", () => {
    const d = diagnosis();
    const p = plan();
    const summary = planSummary(d, p);
    expect(summary.success.join(" ")).toContain(EMAIL);
  });
});
