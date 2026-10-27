import { describe, expect, test } from "vitest";
import { planSummary } from "../src/lib/ax/guide";
import { extractPlanReviewableItems, extractReviewableItems } from "../src/lib/ax/hitl";
import type { AxDiagnosis, AxPlan, HitlReview } from "../src/lib/ax/types";

// 작업 17 (조사 15 간극): 03 완료 기준은 보류·제외 기능과 연결된 기준을
// 조용히 삭제하거나(단계명 판정) 아예 걸러내지 못했다(전파 결과·예외 목록).
// 수정: 삭제 대신 04와 같은 "현재 필수 완료 조건 아님" 강등 표기로 분리 표시한다.
// 전파 규칙(2개 이상 내용 토큰 겹침 + 특이 토큰)은 완화하지 않는다 — 아래 문구는
// 그 규칙에 닿도록 3자 이상 공유 토큰(재시도·판매자별·인증서)을 포함한다.
// 단순 부재 검사가 아니라, 보류·제외 연결 근거(removed 항목)와 강등 표기의 대응을 단언한다.

let seq = 0;
function planReview(p: AxPlan, text: string, action: "exclude" | "defer"): HitlReview {
  const item = extractPlanReviewableItems(p, "codex").find(i => i.type === "planItem" && i.text === text);
  if (!item) throw new Error(`no plan item ${text}`);
  return { id: `demotion-${action}-${++seq}`, target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash }, action, status: "confirmed", reason: action, reviewedAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z" } as HitlReview;
}
function stepReview(d: AxDiagnosis, stepName: string, action: "exclude" | "defer"): HitlReview {
  const item = extractReviewableItems(d).find(i => i.type === "step" && i.text.startsWith(stepName));
  if (!item) throw new Error(`no step ${stepName}`);
  return { id: `demotion-step-${action}-${++seq}`, target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash }, action, status: "confirmed", reason: action, reviewedAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z" } as HitlReview;
}
function factors() {
  return [
    { key: "repetition", aiValue: 4, rationale: "" }, { key: "regularity", aiValue: 4, rationale: "" },
    { key: "dataStructure", aiValue: 2, rationale: "" }, { key: "systemAccess", aiValue: 3, rationale: "" },
    { key: "humanJudgment", aiValue: 3, rationale: "" }, { key: "operationalRisk", aiValue: 2, rationale: "" },
  ];
}
function diagnosis(over: Partial<AxDiagnosis> = {}): AxDiagnosis {
  return {
    sourceNote: "03 강등 표기 픽스처", factors: factors(),
    stepAssessments: ["사용자 요청 접수", "데이터 검증", "결과 통보"].map(step => ({ step, verdict: "자동화" as const, treatment: "확인 후 구현", scope: "current" as const, owner: "시스템" as const, note: "" })),
    technicalChecks: [], followUpQuestions: [], decisionGate: { verdict: "conditional", reasons: ["선행 확인 필요"] },
    informationSufficiency: "sufficient",
    asIs: { purpose: "인증 연동 업무", trigger: "요청 시", inputs: ["사용자 요청"], outputs: ["처리 결과"], steps: ["사용자 요청 접수", "데이터 검증", "결과 통보"], exceptions: ["인증서 만료 시 알림 및 수동 전환", "데이터 누락 시 담당자 확인"], humanDecisions: [], systems: ["인증 서버"] },
    toBe: [],
    poc: { inScope: [], outOfScope: [], success: ["데이터 검증 결과 일치"], failure: ["인증 실패 시 재시도 로직 적용", "인증 실패 재시도 결과 통보 확인", "판매자별 매출 합산 오류 시 재계산"], tests: [], evaluation: [] },
    ...over,
  } as unknown as AxDiagnosis;
}
function plan(): AxPlan {
  return {
    implementation: ["사용자 요청 접수", "인증 실패 재시도 연동", "인증서 만료 알림 전송", "판매자별 매출 합산 자동화", "데이터 검증", "결과 통보"],
    integrations: ["인증 서버 연동"], dataFlow: ["요청 → 검증 → 통보"],
    acceptance: ["데이터 검증 결과 일치"], tests: ["검증 테스트"], prerequisites: [],
  } as unknown as AxPlan;
}

describe("AX 03 강등 표기: 보류·제외 기능 연결 기준·예외", () => {
  test("전파 결과(removed) 연결 실패 기준은 삭제가 아니라 강등 표기로 분리된다", () => {
    const d = diagnosis();
    const p = plan();
    const r = [planReview(p, "인증 실패 재시도 연동", "exclude"), planReview(p, "인증서 만료 알림 전송", "exclude")];
    const s = planSummary(d, p, "", { hitlReviews: r, hitlTool: "codex" });
    // 제외된 계획 항목 "인증 실패 재시도 연동"과 토큰(인증·실패·재시도)이 겹치는 실패 기준.
    expect(s.failure.join(" ")).not.toContain("인증 실패 시 재시도 로직 적용");
    expect(s.demotedCriteria.join(" ")).toContain("인증 실패 시 재시도 로직 적용 — 현재 필수 완료 조건 아님 (관련 단계 제외됨)");
    // 활성 단계("결과 통보")와도 단어를 공유하는 기준은 보수적으로 일반 실패 기준으로 유지.
    expect(s.failure.join(" ")).toContain("인증 실패 재시도 결과 통보 확인");
    expect(s.demotedCriteria.join(" ")).not.toContain("인증 실패 재시도 결과 통보 확인");
    // 일반 기준·예외는 강등되지 않는다.
    expect(s.success.join(" ")).toContain("데이터 검증 결과 일치");
    expect(s.exceptions.join(" ")).toContain("데이터 누락 시 담당자 확인");
  });

  test("전파 결과 연결 예외 문구도 강등 표기로 분리된다", () => {
    const d = diagnosis();
    const p = plan();
    const r = [planReview(p, "인증서 만료 알림 전송", "exclude")];
    const s = planSummary(d, p, "", { hitlReviews: r, hitlTool: "codex" });
    // 제외된 계획 항목 "인증서 만료 알림 전송"과 토큰(인증서·만료·알림)이 겹치는 예외.
    expect(s.exceptions.join(" ")).not.toContain("인증서 만료 시 알림 및 수동 전환");
    expect(s.demotedExceptions.join(" ")).toContain("인증서 만료 시 알림 및 수동 전환 — 현재 필수 완료 조건 아님 (관련 단계 제외됨)");
    expect(s.exceptions.join(" ")).toContain("데이터 누락 시 담당자 확인");
  });

  test("보류(defer) 연결 기준은 보류 취지 강등 표기가 된다", () => {
    const d = diagnosis();
    const p = plan();
    const r = [planReview(p, "판매자별 매출 합산 자동화", "defer")];
    const s = planSummary(d, p, "", { hitlReviews: r, hitlTool: "codex" });
    expect(s.failure.join(" ")).not.toContain("판매자별 매출 합산 오류 시 재계산");
    expect(s.demotedCriteria.join(" ")).toContain("판매자별 매출 합산 오류 시 재계산 — 현재 필수 완료 조건 아님 (관련 단계 보류됨)");
  });

  test("단계명 판정 경로(기존 삭제 동작)도 강등 표기로 보인다", () => {
    const d = diagnosis({
      stepAssessments: ["이메일에서 엑셀 파일 다운로드", "파일 형식별 수동 정리", "판매자별 매출 합산", "수수료 차감 및 최소 금액 적용", "구글 시트에 집계 입력", "이상 금액 확인 및 담당자 승인", "정산 명세서 생성", "이메일로 정산 명세서 발송"].map((step, i) => ({ step, verdict: "자동화" as const, treatment: i === 1 || i === 5 ? "담당자 수행" : "확인 후 구현", scope: "current" as const, owner: "시스템" as const, note: "" })),
      asIs: { purpose: "주간 판매자 정산 집계 및 명세서 발송", trigger: "매주", inputs: ["판매자별 주간 판매 엑셀 파일"], outputs: ["판매자별 정산 명세서"], steps: ["이메일에서 엑셀 파일 다운로드", "파일 형식별 수동 정리", "판매자별 매출 합산", "수수료 차감 및 최소 금액 적용", "구글 시트에 집계 입력", "이상 금액 확인 및 담당자 승인", "정산 명세서 생성", "이메일로 정산 명세서 발송"], exceptions: ["이메일 발송 실패 시 수동 전환", "데이터 누락 시 담당자 확인"], humanDecisions: [], systems: ["이메일", "Excel", "구글 시트"] },
      poc: { hypothesis: "", inScope: [], outOfScope: [], inputs: [], outputs: [], success: ["이메일 발송 성공 로그 기록", "정산 계산 오류가 없으며 최소 금액 규칙 적용 확인"], failure: [], evaluation: [] },
    });
    const r = [stepReview(d, "이메일로 정산 명세서 발송", "exclude")];
    const s = planSummary(d, undefined, "", { hitlReviews: r });
    expect(s.success.join(" ")).not.toContain("이메일 발송 성공 로그 기록");
    expect(s.demotedCriteria.join(" ")).toContain("이메일 발송 성공 로그 기록 — 현재 필수 완료 조건 아님 (관련 단계 제외됨)");
    expect(s.success.join(" ")).toContain("정산 계산 오류가 없으며 최소 금액 규칙 적용 확인");
    // 같은 단계명 경로의 예외도 강등 표기로 분리된다.
    expect(s.exceptions.join(" ")).not.toContain("이메일 발송 실패 시 수동 전환");
    expect(s.demotedExceptions.join(" ")).toContain("이메일 발송 실패 시 수동 전환 — 현재 필수 완료 조건 아님 (관련 단계 제외됨)");
    expect(s.exceptions.join(" ")).toContain("데이터 누락 시 담당자 확인");
  });

  test("HITL 미적용 시 강등 목록이 비고 기존 표시가 유지된다", () => {
    const s = planSummary(diagnosis(), plan());
    expect(s.demotedCriteria).toEqual([]);
    expect(s.demotedExceptions).toEqual([]);
    expect(s.failure.join(" ")).toContain("인증 실패 시 재시도 로직 적용");
    expect(s.exceptions.join(" ")).toContain("인증서 만료 시 알림 및 수동 전환");
  });
});
