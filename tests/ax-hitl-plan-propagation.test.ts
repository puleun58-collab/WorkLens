import { describe, expect, it } from "vitest";
import { buildAgentInstructionModel, buildAllInOnePrompt } from "../src/lib/ax/guide";
import { extractPlanReviewableItems } from "../src/lib/ax/hitl";
import { diagnosisFixture, planFixture } from "./fixtures/ax";
import type { AxDiagnosis, AxPlan, HitlReview } from "../src/lib/ax/types";

/**
 * AX 계획 항목 제외·보류 전파 (§8 결함 수정) 회귀 테스트.
 * 라이브 재현 ([테스트] 주간 판매자 정산 집계 20261025) 기준:
 * - 확정 3건: 제외 "SMTP 연동으로 명세서 자동 이메일 전송",
 *   유지 "정규화 데이터로 매출 합산·수수료·최소 금액 적용",
 *   보류 "계산 결과를 Google Sheets API로 업데이트"
 *   (사유: Google Sheets API 권한 미확보, 재개 조건: 권한 확보 + 샘플 시트 입력 검증 완료 후에만 재개).
 * 결함: (1) 사람 검토 구간이 보류만 나열하고 제외를 누락했고,
 * (2) 제외·보류 기능이 다른 계획 필드·진단 단계 경유로 범위 표·기능 목록·
 * 완료 기준·전제 조건에 구현 대상으로 잔존했다.
 * 기대값은 HITL 결정과 사용자 지시 기준에서 도출한다 (생성 결과 역산 금지).
 * "구현 요구 0건"의 계수 규칙: 제외·보류 항목의 명시적 제외·보류 표기
 * (사람 검토 반영 구간)와 기존 시스템 맥락 언급("사용 시스템: …")은
 * 구현 요구가 아니므로 계수에서 제외한다. 단계 행·기능 블록·완료 기준·
 * 전제 조건·기능 검증 목록에 구현 대상으로 등장하면 FAIL이다.
 */

const STEPS = ["판매 데이터 수집", "데이터 정규화", "매출 합산", "수수료 계산", "최소 금액 적용", "명세서 생성", "명세서 이메일 전송", "Google Sheets 업데이트"] as const;
const EXCLUDED = "SMTP 연동으로 명세서 자동 이메일 전송";
const KEPT = "정규화 데이터로 매출 합산·수수료·최소 금액 적용";
const DEFERRED = "계산 결과를 Google Sheets API로 업데이트";
const DEFER_REASON = "Google Sheets API 권한 미확보";
const DEFER_RESUME = "권한 확보 + 샘플 시트 입력 검증 완료 후에만 재개";
const EMAIL_STEP = "명세서 이메일 전송";
const SHEETS_STEP = "Google Sheets 업데이트";
const TASK = "[테스트] 주간 판매자 정산 집계 20261025";

const diag: AxDiagnosis = {
  ...diagnosisFixture,
  decisionGate: { verdict: "conditional", reasons: ["기술 확인 후 진행"] },
  stepAssessments: STEPS.map(step => ({ step, verdict: "자동화", owner: "시스템", note: "확정된 규칙으로 처리" })),
  asIs: { ...diagnosisFixture.asIs, purpose: "주간 판매자 정산을 집계하고 명세서를 전달", inputs: ["판매내역.csv"], steps: [...STEPS], outputs: ["정산 명세서", "집계 표"], systems: ["메일", "Google Sheets"] },
  poc: { ...diagnosisFixture.poc, inScope: [...STEPS], inputs: ["판매내역.csv"], outputs: ["정산 명세서", "집계 표"], success: ["집계 결과가 기대값과 일치"], failure: ["집계 불일치가 일치로 표시"] },
};
const plan: AxPlan = {
  ...planFixture,
  goal: ["주간 판매자 정산 집계 자동화"],
  inScope: ["판매 데이터 수집", KEPT, "명세서 생성", EXCLUDED, DEFERRED, "정산 결과 집계 표 생성"],
  implementation: ["판매 데이터 수집", KEPT, EXCLUDED, DEFERRED, "정산 결과 집계 표 생성"],
  dataFlow: ["판매 데이터 수집 → 정규화 → 매출 합산 → 명세서 이메일 전송 → Google Sheets 업데이트"],
  integrations: ["SMTP 서버 연동", "Google Sheets API 연동"],
  acceptance: ["명세서가 이메일로 자동 전송됨", "집계 결과가 Google Sheets에 업데이트됨", "집계 결과가 기대값과 일치"],
  tests: ["이메일 전송 결과 확인", "Google Sheets 업데이트 결과 확인"],
};

let seq = 0;
function decisions(tool: "codex" | "claude"): HitlReview[] {
  return extractPlanReviewableItems(plan, tool)
    .filter(item => item.type === "planItem" && (item.text === EXCLUDED || item.text === KEPT || item.text === DEFERRED))
    .map(item => {
      const action: HitlReview["action"] = item.text === EXCLUDED ? "exclude" : item.text === DEFERRED ? "defer" : "keep";
      return {
        id: `plan-prop-${tool}-${++seq}`, target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash },
        action, status: "confirmed", reviewedAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z",
        ...(action === "defer" ? { reason: DEFER_REASON, resumeCondition: DEFER_RESUME } : {}),
      } as HitlReview;
    });
}
function promptFor(tool: "codex" | "claude", reviews: HitlReview[], d: AxDiagnosis = diag, p: AxPlan = plan): string {
  return buildAllInOnePrompt(p, tool, { taskName: TASK, diagnosis: d, hitlReviews: reviews, hitlTool: tool });
}
function modelFor(tool: "codex" | "claude", reviews: HitlReview[], d: AxDiagnosis = diag, p: AxPlan = plan) {
  return buildAgentInstructionModel(p, { taskName: TASK, diagnosis: d, hitlReviews: reviews, hitlTool: tool });
}
/** 지시문 전문을 "## N. 제목" 단위로 나눈 뒤 해당 제목 섹션 본문만 반환한다. */
function section(prompt: string, title: string): string {
  const parts = prompt.split(/\n## \d+\. /u);
  const hit = parts.find(p => p.startsWith(title));
  return hit ?? "";
}
/** 사람 검토 반영 블록을 제거한 지시문: 제외·보류의 명시적 표기만 남기고 구현 요구 여부를 본다. */
function withoutReviewBlock(prompt: string): string {
  const start = prompt.indexOf("### 사람 검토 반영");
  if (start < 0) return prompt;
  const rest = prompt.slice(start);
  const next = rest.search(/\n## \d+\. /u);
  return next < 0 ? prompt.slice(0, start) : prompt.slice(0, start) + rest.slice(next);
}

describe("AX 계획 항목 제외·보류 전파", () => {
  it("제외 항목은 범위 표·기능 목록·완료 기준·전제 조건에 구현 요구로 0건이다", () => {
    for (const tool of ["codex", "claude"] as const) {
      const prompt = promptFor(tool, decisions(tool));
      const model = modelFor(tool, decisions(tool));
      expect(model.steps.map(s => s.step)).not.toContain(EMAIL_STEP);
      expect(section(prompt, "구현 범위")).not.toContain(`| ${EMAIL_STEP} |`);
      expect(section(prompt, "기능별 요구사항")).not.toContain(EMAIL_STEP);
      expect(section(prompt, "기능별 요구사항")).not.toContain("명세서 이메일 전송");
      expect(section(prompt, "구현 순서 및 검증")).not.toContain("명세서가 이메일로 자동 전송됨");
      expect(section(prompt, "예외 및 유지 조건")).not.toContain("SMTP 서버 연동");
      expect(model.classified.map(i => i.text)).not.toContain(EXCLUDED);
      expect(model.scoped.features.map(i => i.text)).not.toContain(EXCLUDED);
      expect(withoutReviewBlock(prompt)).not.toContain(EXCLUDED);
      expect(withoutReviewBlock(prompt)).not.toContain(EMAIL_STEP);
    }
  });

  it("보류 항목은 모든 등장 위치에서 상태·사유·재개 조건을 동반하고 현재 범위 대상이 아니다", () => {
    for (const tool of ["codex", "claude"] as const) {
      const prompt = promptFor(tool, decisions(tool));
      const model = modelFor(tool, decisions(tool));
      expect(model.steps.map(s => s.step)).not.toContain(SHEETS_STEP);
      expect(section(prompt, "구현 범위")).not.toContain(`| ${SHEETS_STEP} |`);
      expect(section(prompt, "기능별 요구사항")).not.toContain(SHEETS_STEP);
      expect(section(prompt, "구현 순서 및 검증")).not.toContain("집계 결과가 Google Sheets에 업데이트됨");
      expect(section(prompt, "예외 및 유지 조건")).not.toContain("Google Sheets API 연동");
      expect(withoutReviewBlock(prompt)).not.toContain(DEFERRED);
      expect(withoutReviewBlock(prompt)).not.toContain(SHEETS_STEP);
      const review = section(prompt, "구현 범위");
      expect(review).toContain(`- ${DEFERRED} — 보류: ${DEFER_REASON}`);
      expect(review).toContain(`재개 조건: ${DEFER_RESUME}`);
      expect(review).toContain("자동으로 재개하지 말고");
    }
  });

  it("사람 검토 구간에 제외·보류가 모두 명시된다", () => {
    for (const tool of ["codex", "claude"] as const) {
      const prompt = promptFor(tool, decisions(tool));
      const model = modelFor(tool, decisions(tool));
      expect(model.hitlDetails?.excluded.map(e => e.name)).toContain(EXCLUDED);
      expect(model.hitlDetails?.deferred.map(e => e.name)).toContain(DEFERRED);
      const review = section(prompt, "구현 범위");
      expect(review).toContain("사람 검토 반영");
      expect(review).toContain(`- ${EXCLUDED} — 현재 구현 범위에서 제외. 관련 기능을 구현하지 않습니다.`);
      expect(review).toContain(`- ${DEFERRED} — 보류: ${DEFER_REASON}`);
    }
  });

  it("유지 항목 규칙이 보존된다", () => {
    for (const tool of ["codex", "claude"] as const) {
      const prompt = promptFor(tool, decisions(tool));
      const model = modelFor(tool, decisions(tool));
      expect(model.classified.map(i => i.text)).toContain(KEPT);
      expect(prompt).toContain(KEPT);
      for (const step of ["판매 데이터 수집", "데이터 정규화", "매출 합산", "수수료 계산", "최소 금액 적용", "명세서 생성"]) {
        expect(section(prompt, "구현 범위")).toContain(`| ${step} |`);
      }
      expect(model.hitlDetails?.excluded.map(e => e.name)).not.toContain(KEPT);
      expect(model.hitlDetails?.deferred.map(e => e.name)).not.toContain(KEPT);
    }
  });

  it("Codex·Claude 각자 표의 결정만 각자 지시문에 반영된다 (교차 전파 없음)", () => {
    const codexPrompt = promptFor("codex", decisions("codex"));
    const claudeWithout = promptFor("claude", decisions("codex"));
    expect(section(codexPrompt, "구현 범위")).not.toContain(`| ${EMAIL_STEP} |`);
    expect(section(claudeWithout, "구현 범위")).toContain(`| ${EMAIL_STEP} |`);
    expect(section(claudeWithout, "구현 범위")).toContain(`| ${SHEETS_STEP} |`);
    expect(section(claudeWithout, "구현 범위")).not.toContain("사람 검토 반영");
    const claudePrompt = promptFor("claude", decisions("claude"));
    expect(section(claudePrompt, "구현 범위")).not.toContain(`| ${EMAIL_STEP} |`);
    expect(section(claudePrompt, "구현 범위")).not.toContain(`| ${SHEETS_STEP} |`);
    // 동일 결정·동일 계획이면 렌더링 규칙은 양쪽에 동일하게 적용된다.
    expect(claudePrompt).toBe(codexPrompt);
  });

  it("확인 후 구현·처리 방식 미확정 단서가 제외·보류를 대신하지 못한다", () => {
    for (const tool of ["codex", "claude"] as const) {
      const prompt = promptFor(tool, decisions(tool));
      const scope = section(prompt, "구현 범위");
      expect(scope).not.toContain(`| ${EMAIL_STEP} | 확인 후 구현 |`);
      expect(scope).not.toContain(`| ${SHEETS_STEP} | 확인 후 구현 |`);
      expect(withoutReviewBlock(prompt)).not.toContain(EMAIL_STEP);
      expect(withoutReviewBlock(prompt)).not.toContain(SHEETS_STEP);
    }
  });

  it("유사 명칭은 합치지 않는다: 유지 항목이 덮는 단계는 남고, 제외 단계만 제거된다", () => {
    const similarDiag: AxDiagnosis = {
      ...diag,
      stepAssessments: ["데이터 검증", "데이터 검증 후처리", "금액 계산"].map(step => ({ step, verdict: "자동화", owner: "시스템", note: "" })),
      asIs: { ...diag.asIs, steps: ["데이터 검증", "데이터 검증 후처리", "금액 계산"] },
      poc: { ...diag.poc, inScope: ["데이터 검증", "데이터 검증 후처리", "금액 계산"] },
    };
    const similarPlan: AxPlan = { ...plan, inScope: ["데이터 검증", "데이터 검증 후처리", "금액 계산"], implementation: ["데이터 검증", "데이터 검증 후처리", "금액 계산"] };
    const reviews: HitlReview[] = extractPlanReviewableItems(similarPlan, "codex")
      .filter(item => item.type === "planItem")
      .map(item => ({
        id: `similar-${++seq}`, target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash },
        action: item.text === "데이터 검증" ? "exclude" : "keep", status: "confirmed",
        reviewedAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z",
      } as HitlReview));
    const prompt = promptFor("codex", reviews, similarDiag, similarPlan);
    expect(section(prompt, "구현 범위")).not.toContain("| 데이터 검증 |");
    expect(section(prompt, "구현 범위")).toContain("| 데이터 검증 후처리 |");
    expect(section(prompt, "기능별 요구사항")).toContain("데이터 검증 후처리");
  });

  it("2자 일반어 쌍만으로는 전파하지 않는다", () => {
    const genericPlan: AxPlan = { ...plan, inScope: ["매출 결과 확인", "집계 결과 확인"], implementation: ["매출 결과 확인", "집계 결과 확인"] };
    const reviews: HitlReview[] = extractPlanReviewableItems(genericPlan, "codex")
      .filter(item => item.type === "planItem" && item.text === "매출 결과 확인")
      .map(item => ({
        id: `generic-${++seq}`, target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash },
        action: "exclude", status: "confirmed", reviewedAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z",
      } as HitlReview));
    const model = modelFor("codex", reviews, diag, genericPlan);
    expect(model.classified.map(i => i.text)).not.toContain("매출 결과 확인");
    expect(model.classified.map(i => i.text)).toContain("집계 결과 확인");
  });
});
