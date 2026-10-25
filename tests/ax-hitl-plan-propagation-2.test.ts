import { describe, expect, it } from "vitest";
import { buildAgentInstructionModel, buildAllInOnePrompt } from "../src/lib/ax/guide";
import { extractPlanReviewableItems } from "../src/lib/ax/hitl";
import { diagnosisFixture, planFixture } from "./fixtures/ax";
import type { AxDiagnosis, AxPlan, HitlReview } from "../src/lib/ax/types";

/**
 * AX §8 2차 수정: #293 잔존 결함 회귀 테스트.
 * 라이브 재검증 (2026-10-25 18:18 KST, [테스트] 주간 판매자 정산 집계 20261025)과
 * 동등한 구조로 재현한다. #293 픽스처와의 결정적 차이 2가지:
 * (1) 진단 단계명이 계획 결정문의 영어 표기가 아니라 한국어 패러프레이즈이다
 *     (단계 "구글 시트에 집계 입력" vs 결정 "계산 결과를 Google Sheets API로 업데이트",
 *     Claude 결정 "Google Sheets API 호출로 집계 행 삽입").
 *     토큰 직접 비교만으로는 연결되지 않아 단계 층위가 그대로 남았다.
 * (2) 선행 조건이 계획 필드가 아니라 진단 기술확인(technicalChecks)에서 온다
 *     (§4에 "SMTP 발송 설정 — 정산 명세서 자동 발송에 필요",
 *     "SMTP server for email dispatch",
 *     "이메일 서버 접근 권한 — 자동 다운로드 단계에서 IMAP/SMTP 인증 필요",
 *     "Google Sheets API 사용 권한 — 구글 시트 자동 입력 단계에 필요").
 *     #293 전파는 plan.* 출처에만 닿아 진단·정책 출처 선행 조건을 비껴갔다.
 * 기대값은 HITL 결정과 사용자 지시 기준에서 도출한다 (생성 결과 역산 금지).
 * "구현 요구 0건"의 계수 규칙은 #293 테스트와 동일하다: 사람 검토 반영 구간의
 * 명시적 제외·보류 표기와 기존 시스템 맥락 언급("사용 시스템: …")은 계수에서 제외한다.
 * §1·§2·§5의 "명세서 발송"·"최종 발송 승인" 문구는 업무 설명·담당자 단계 문구로
 * 구현 요구가 아니므로 제거 대상이 아니며, 보존됨을 별도로 단언한다.
 */

const STEPS = ["판매 데이터 수집", "데이터 정규화", "매출 합산", "수수료 계산", "최소 금액 적용", "명세서 생성", "명세서 이메일 전송", "구글 시트에 집계 입력"] as const;
const KEPT = "정규화 데이터로 매출 합산·수수료·최소 금액 적용";
const DEFER_REASON = "Google Sheets API 권한 미확보";
const DEFER_RESUME = "권한 확보 + 샘플 시트 입력 검증 완료 후에만 재개";
const EMAIL_STEP = "명세서 이메일 전송";
const SHEETS_STEP = "구글 시트에 집계 입력";
const SHEETS_OUTPUT = "구글 시트에 집계된 정산표";
const TASK = "[테스트] 주간 판매자 정산 집계 20261025";
const CONTEXT = "주간 판매자 정산 집계 후 명세서 발송 업무";

/** 도구별 라이브 결정문 (Codex 표·Claude 표가 다르다 — 도구별 독립 유지). */
const DECISIONS = {
  codex: { excluded: "SMTP 연동으로 명세서 자동 이메일 전송", deferred: "계산 결과를 Google Sheets API로 업데이트" },
  claude: { excluded: "SMTP로 명세서 첨부 이메일 자동 전송", deferred: "Google Sheets API 호출로 집계 행 삽입" },
} as const;

/** 라이브 선행 조건 4건 (진단 기술확인 출처) + 보존 대조군 2건. */
const LIVE_PREREQS = [
  "SMTP 발송 설정 — 정산 명세서 자동 발송에 필요",
  "SMTP server for email dispatch",
  "이메일 서버 접근 권한 — 자동 다운로드 단계에서 IMAP/SMTP 인증 필요",
  "Google Sheets API 사용 권한 — 구글 시트 자동 입력 단계에 필요",
] as const;
const KEPT_PREREQ = "판매내역 파일 접근 권한 — 판매내역.csv 읽기 필요";
const DENIED_PREREQ = "SMTP 발송 — 명세서 자동 전송 금지";

const diag: AxDiagnosis = {
  ...diagnosisFixture,
  decisionGate: { verdict: "conditional", reasons: ["기술 확인 후 진행"] },
  stepAssessments: STEPS.map(step => ({ step, verdict: "자동화", owner: "시스템", note: "확정된 규칙으로 처리" })),
  asIs: { ...diagnosisFixture.asIs, purpose: "주간 판매자 정산을 집계하고 명세서를 전달", inputs: ["판매내역.csv"], steps: [...STEPS], outputs: ["정산 명세서", SHEETS_OUTPUT], systems: ["메일", "Google Sheets"] },
  humanInLoop: ["담당자 최종 승인", "명세서 최종 발송 승인"],
  technicalChecks: [
    { topic: "SMTP 발송 설정", status: "확인 필요", note: "정산 명세서 자동 발송에 필요" },
    { topic: "SMTP server for email dispatch", status: "확인 필요", note: "" },
    { topic: "이메일 서버 접근 권한", status: "확인 필요", note: "자동 다운로드 단계에서 IMAP/SMTP 인증 필요" },
    { topic: "Google Sheets API 사용 권한", status: "확인 필요", note: "구글 시트 자동 입력 단계에 필요" },
    { topic: "판매내역 파일 접근 권한", status: "확인 필요", note: "판매내역.csv 읽기 필요" },
    { topic: "SMTP 발송", status: "불가", note: "명세서 자동 전송 금지" },
  ],
  poc: { ...diagnosisFixture.poc, inScope: [...STEPS], inputs: ["판매내역.csv"], outputs: ["정산 명세서", SHEETS_OUTPUT], success: ["집계 결과가 기대값과 일치", "집계 결과가 Google Sheets에 업데이트됨"], failure: ["집계 불일치가 일치로 표시"] },
};

function planFor(tool: "codex" | "claude"): AxPlan {
  const d = DECISIONS[tool];
  return {
    ...planFixture,
    goal: ["주간 판매자 정산 집계 자동화"],
    inScope: ["판매 데이터 수집", KEPT, "명세서 생성", d.excluded, d.deferred, "정산 결과 집계 표 생성"],
    implementation: ["판매 데이터 수집", KEPT, d.excluded, d.deferred, "정산 결과 집계 표 생성"],
    dataFlow: ["판매 데이터 수집 → 정규화 → 매출 합산 → 명세서 이메일 전송 → 구글 시트에 집계 입력"],
    integrations: ["SMTP 서버 연동", "Google Sheets API 연동"],
    acceptance: ["명세서가 이메일로 자동 전송됨", "집계 결과가 Google Sheets에 업데이트됨", "집계 결과가 기대값과 일치"],
    tests: ["이메일 전송 결과 확인", "Google Sheets 업데이트 결과 확인"],
  };
}

let seq = 0;
function decisions(tool: "codex" | "claude"): HitlReview[] {
  const plan = planFor(tool);
  const d = DECISIONS[tool];
  return extractPlanReviewableItems(plan, tool)
    .filter(item => item.type === "planItem" && (item.text === d.excluded || item.text === KEPT || item.text === d.deferred))
    .map(item => {
      const action: HitlReview["action"] = item.text === d.excluded ? "exclude" : item.text === d.deferred ? "defer" : "keep";
      return {
        id: `plan-prop-2-${tool}-${++seq}`, target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash },
        action, status: "confirmed", reviewedAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z",
        ...(action === "defer" ? { reason: DEFER_REASON, resumeCondition: DEFER_RESUME } : {}),
      } as HitlReview;
    });
}
function promptFor(tool: "codex" | "claude", reviews: HitlReview[]): string {
  return buildAllInOnePrompt(planFor(tool), tool, { taskName: TASK, context: CONTEXT, diagnosis: diag, hitlReviews: reviews, hitlTool: tool });
}
function modelFor(tool: "codex" | "claude", reviews: HitlReview[]) {
  return buildAgentInstructionModel(planFor(tool), { taskName: TASK, context: CONTEXT, diagnosis: diag, hitlReviews: reviews, hitlTool: tool });
}
/** 지시문 전문을 "## N. 제목" 단위로 나눈 뒤 해당 제목 섹션 본문만 반환한다. */
function section(prompt: string, title: string): string {
  const parts = prompt.split(/\n## \d+\. /u);
  const hit = parts.find(p => p.startsWith(title));
  return hit ?? "";
}
/** 섹션 내 "### 소제목" 블록 본문만 반환한다 (없으면 빈 문자열). */
function subsection(prompt: string, title: string, sub: string): string {
  const sec = section(prompt, title);
  const start = sec.indexOf(`### ${sub}`);
  if (start < 0) return "";
  const rest = sec.slice(start);
  const next = rest.indexOf("\n### ", 1);
  return next < 0 ? rest : rest.slice(0, next);
}
/** 사람 검토 반영 블록을 제거한 지시문: 제외·보류의 명시적 표기만 남기고 구현 요구 여부를 본다. */
function withoutReviewBlock(prompt: string): string {
  const start = prompt.indexOf("### 사람 검토 반영");
  if (start < 0) return prompt;
  const rest = prompt.slice(start);
  const next = rest.search(/\n## \d+\. /u);
  return next < 0 ? prompt.slice(0, start) : prompt.slice(0, start) + rest.slice(next);
}

describe("AX 계획 항목 제외·보류 전파 2차 (라이브 동등 구조)", () => {
  it("보류 단계가 범위 표·기능 목록·최종 산출물·구현 순서·완료 기준에서 보류 표기 없이 일반 대상으로 등장하지 않는다", () => {
    for (const tool of ["codex", "claude"] as const) {
      const prompt = promptFor(tool, decisions(tool));
      const model = modelFor(tool, decisions(tool));
      const d = DECISIONS[tool];
      // 단계 층위: 패러프레이즈 단계명도 제거된다.
      expect(model.steps.map(s => s.step)).not.toContain(SHEETS_STEP);
      expect(model.steps.map(s => s.step)).not.toContain(EMAIL_STEP);
      // 범위 표 (§2): 단계 행 없음, "확인 후 구현" 단서와 함께도 없음.
      expect(section(prompt, "구현 범위")).not.toContain(`| ${SHEETS_STEP} |`);
      expect(section(prompt, "구현 범위")).not.toContain(`| ${SHEETS_STEP} | 확인 후 구현 |`);
      // 기능 목록 (§3): 기능 블록 제목 없음.
      expect(section(prompt, "기능별 요구사항")).not.toContain(`### 기능 ` + SHEETS_STEP);
      expect(section(prompt, "기능별 요구사항")).not.toContain(SHEETS_STEP);
      // 최종 산출물 (§1 목표 + §3 공통 출력): 보류 단계의 산출물 없음.
      expect(section(prompt, "구현 목표")).not.toContain(SHEETS_OUTPUT);
      expect(section(prompt, "기능별 요구사항")).not.toContain(SHEETS_OUTPUT);
      // 구현 순서 및 검증 (§5): 단계별 완료 기준·판정 기준에 보류 단계 없음.
      expect(section(prompt, "구현 순서 및 검증")).not.toContain(SHEETS_STEP);
      // PoC 성공 기준의 시트 문구는 업무 전체 완료 기준으로 승격되지 않고
      // 참고 판정(필수 완료 조건 아님)으로 격하된다.
      expect(subsection(prompt, "구현 순서 및 검증", "업무 전체 완료 기준")).not.toContain("집계 결과가 Google Sheets에 업데이트됨");
      expect(prompt).toContain("집계 결과가 Google Sheets에 업데이트됨 — 현재 필수 완료 조건 아님 (관련 단계 제외됨)");
      // 사람 검토 반영 블록 외에는 보류 결정문 자체도 등장하지 않는다.
      expect(withoutReviewBlock(prompt)).not.toContain(d.deferred);
      expect(withoutReviewBlock(prompt)).not.toContain(SHEETS_STEP);
      expect(withoutReviewBlock(prompt)).not.toContain(SHEETS_OUTPUT);
      // 보류 표기는 사람 검토 구간에 상태·사유·재개 조건·자동 재개 금지와 함께 있다.
      const review = section(prompt, "구현 범위");
      expect(review).toContain(`- ${d.deferred} — 보류: ${DEFER_REASON}`);
      expect(review).toContain(`재개 조건: ${DEFER_RESUME}`);
      expect(review).toContain("자동으로 재개하지 말고");
    }
  });

  it("제외·보류 기능에 연결된 진단·정책 출처 선행 조건이 §4 현재 범위 전제 조건에서 제거된다", () => {
    for (const tool of ["codex", "claude"] as const) {
      const prompt = promptFor(tool, decisions(tool));
      const model = modelFor(tool, decisions(tool));
      const prereqSection = section(prompt, "예외 및 유지 조건");
      for (const prereq of LIVE_PREREQS) {
        expect(prereqSection).not.toContain(prereq);
        expect(model.classified.filter(i => i.role === "conditions").map(i => i.text)).not.toContain(prereq);
      }
      // "어느 업무 단계에 적용되는지 확인되지 않았습니다" 식 미확인 선행 조건이
      // 제외·보류 기능을 위한 준비 항목으로 읽히지 않는다.
      expect(withoutReviewBlock(prompt)).not.toContain("SMTP 발송 설정");
      expect(withoutReviewBlock(prompt)).not.toContain("Google Sheets API 사용 권한");
      expect(withoutReviewBlock(prompt)).not.toContain("SMTP server for email dispatch");
      expect(withoutReviewBlock(prompt)).not.toContain("이메일 서버 접근 권한");
    }
  });

  it("무관한 선행 조건·거부 증거·유지 규칙은 보존된다", () => {
    for (const tool of ["codex", "claude"] as const) {
      const prompt = promptFor(tool, decisions(tool));
      const model = modelFor(tool, decisions(tool));
      // 무관한 선행 조건은 §4에 남는다 (미연결이면 적용 단계 확인 필요로).
      expect(section(prompt, "예외 및 유지 조건")).toContain(KEPT_PREREQ);
      // 거부(불가) 증거는 제외 결정으로도 허용으로 바뀌지 않고 남는다.
      expect(prompt).toContain(DENIED_PREREQ);
      // 유지 항목·유지 단계 보존.
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
    const claudeWithout = promptFor("claude", decisions("codex"));
    expect(section(claudeWithout, "구현 범위")).toContain(`| ${SHEETS_STEP} |`);
    expect(section(claudeWithout, "구현 범위")).toContain(`| ${EMAIL_STEP} |`);
    expect(section(claudeWithout, "구현 범위")).not.toContain("사람 검토 반영");
    const claudePrompt = promptFor("claude", decisions("claude"));
    expect(section(claudePrompt, "구현 범위")).not.toContain(`| ${SHEETS_STEP} |`);
    expect(section(claudePrompt, "구현 범위")).not.toContain(`| ${EMAIL_STEP} |`);
  });

  it("업무 설명·담당자 단계 문구는 구현 요구가 아니므로 제거하지 않는다", () => {
    for (const tool of ["codex", "claude"] as const) {
      const prompt = promptFor(tool, decisions(tool));
      // §1 업무 설명 (등록 내용)의 "명세서 발송"은 업무 설명이지 구현 요구가 아니다.
      expect(section(prompt, "구현 목표")).toContain("명세서 발송 업무");
      // §2 담당자 수행의 "명세서 최종 발송 승인"은 담당자 단계 문구이다.
      expect(section(prompt, "구현 범위")).toContain("명세서 최종 발송 승인");
      // 단, 이 문구들이 기능 목록·완료 기준의 구현 요구로 승격되지는 않는다.
      expect(section(prompt, "기능별 요구사항")).not.toContain("명세서 최종 발송 승인");
    }
  });
});
