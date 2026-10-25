import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt } from "../src/lib/ax/guide";
import { extractReviewableItems, type ReviewableItem } from "../src/lib/ax/hitl";
import { gatePrerequisites } from "../src/lib/ax/policy";
import { diagnosisFixture, planFixture } from "./fixtures/ax";
import type { AxDiagnosis, AxPlan, HitlReview } from "../src/lib/ax/types";

/**
 * AX 잔여 검증 (HITL 제외 항목의 지시문 재유입) — 조합별 재현 검증.
 * 기준: main 3e255dc, PR #285/#286 머지 이후. #286의 append() 단일 지점 수정이
 * 모든 선행조건 경로를 덮는지, 다른 경로로 새어 들어가는지를 픽스처 기반으로 확인한다.
 * 지시문 전문에서 제외 항목의 토픽이 "구현·조건 요구사항"으로 남으면 FAIL이다.
 * 단, 보류 섹션의 보류 명시·불가(거부) 증거 보존·별개 검토 항목(위험 문구)은 재유입이 아니다.
 */

const STEPS = ["원본 파일 읽기", "금액 계산", "납품표 대조", "Excel 보고서 생성"] as const;

const base: AxDiagnosis = {
  ...diagnosisFixture,
  decisionGate: { verdict: "conditional", reasons: ["기술 확인 후 진행"] },
  stepAssessments: STEPS.map(step => ({ step, verdict: "자동화", owner: "시스템", note: "확정된 규칙으로 처리" })),
  asIs: {
    ...diagnosisFixture.asIs,
    purpose: "거래 금액을 계산하고 결과를 보고",
    inputs: ["거래내역.xlsx"],
    steps: [...STEPS],
    outputs: ["Excel 보고서"],
    exceptions: ["납품표 번호 불일치", "금액 형식 오류", "Excel 파일 손상"],
    systems: ["Excel"],
  },
  poc: {
    ...diagnosisFixture.poc,
    inScope: [...STEPS],
    inputs: ["거래내역.xlsx"],
    outputs: ["Excel 보고서"],
    success: ["계산 결과가 기대값과 일치"],
    failure: ["금액 불일치가 일치로 표시"],
  },
  risks: ["금액 형식 오류"],
};

const basePlan: AxPlan = {
  ...planFixture,
  goal: ["금액 계산 결과를 Excel 보고서로 생성"],
  inScope: [...STEPS],
  implementation: [...STEPS],
  dataFlow: ["원본 파일 읽기 → 금액 계산 → 납품표 대조 → Excel 보고서 생성"],
  exceptions: ["납품표 번호 불일치 건은 별도 판정", "금액 형식 오류는 오류로 분리", "Excel 파일 손상 시 생성 중단"],
  tests: ["금액 계산 결과가 기대값과 일치하는지 확인", "형식 오류가 구분되는지 확인"],
  acceptance: ["계산 결과가 기대값과 일치", "Excel 보고서가 생성됨"],
};

let seq = 0;
function makeReview(item: ReviewableItem, action: HitlReview["action"], overrides: Partial<HitlReview> = {}): HitlReview {
  return {
    id: `residual-review-${++seq}`,
    target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash },
    action,
    status: "confirmed",
    reviewedAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
    ...overrides,
  } as HitlReview;
}

/** diag의 risk(기술 확인) 항목들에 대해, 토픽별 액션을 적용한 confirmed 검토 목록을 만든다. */
function checkReviews(diag: AxDiagnosis, actions: Record<string, HitlReview["action"]>, overrides: Partial<HitlReview> = {}): HitlReview[] {
  return extractReviewableItems(diag)
    .filter(item => item.type === "risk")
    .map(item => {
      const topic = item.text.split(":")[0];
      const action = actions[topic] ?? "keep";
      return makeReview(item, action, action === "defer" ? overrides : {});
    });
}

function promptFor(tool: "codex" | "claude", diag: AxDiagnosis, plan: AxPlan, reviews: HitlReview[], prerequisites?: string[]): string {
  return buildAllInOnePrompt(plan, tool, {
    taskName: "거래 검증", diagnosis: diag, hitlReviews: reviews, hitlTool: tool,
    ...(prerequisites ? { prerequisites } : {}),
  });
}

function bothTools(diag: AxDiagnosis, plan: AxPlan, reviews: HitlReview[], prerequisites?: string[]): [string, string] {
  return [promptFor("codex", diag, plan, reviews, prerequisites), promptFor("claude", diag, plan, reviews, prerequisites)];
}

/** 지시문의 조건 요구사항 섹션(현재 필수 조건 / 적용 단계 확인 필요)만 추출한다. */
function conditionSections(prompt: string): string {
  const out: string[] = [];
  for (const title of ["현재 필수 조건", "적용 단계 확인 필요"]) {
    const start = prompt.indexOf(`### ${title}`);
    if (start < 0) continue;
    const rest = prompt.slice(start);
    const next = rest.slice(4).search(/\n### /u);
    out.push(next < 0 ? rest : rest.slice(0, next + 4));
  }
  return out.join("\n");
}

const KEPT = { topic: "파일 파싱 가능 여부", status: "확인 필요", note: "엑셀 구조 파악 필요", required: true } as const;
const OPT = { topic: "이상값 알림 메커니즘", status: "확인 필요", note: "결측 표시와 알림은 선택 기능", required: false } as const;

function diagWithChecks(checks: AxDiagnosis["technicalChecks"], extra: Partial<AxDiagnosis> = {}): AxDiagnosis {
  return { ...base, technicalChecks: checks, ...extra };
}

describe("AX 잔여 검증: HITL 제외 항목 재유입 조합", () => {
  it("R1 선택 항목 제외 (UI 경로: gatePrerequisites 전달) — 양 도구 모두 전수 부재, 필수 유지", () => {
    const diag = diagWithChecks([KEPT, OPT]);
    const reviews = checkReviews(diag, { [OPT.topic]: "exclude" });
    const [cx, cl] = bothTools(diag, basePlan, reviews, gatePrerequisites(diag));
    for (const p of [cx, cl]) {
      expect(p).not.toContain(OPT.topic);
      expect(p).toContain(KEPT.topic);
      expect(conditionSections(p)).toContain(KEPT.topic);
    }
  });

  it("R2 필수 항목 제외 — 양 도구 모두 전수 부재, 선택 유지", () => {
    const diag = diagWithChecks([KEPT, OPT]);
    const reviews = checkReviews(diag, { [KEPT.topic]: "exclude" });
    const [cx, cl] = bothTools(diag, basePlan, reviews, gatePrerequisites(diag));
    for (const p of [cx, cl]) {
      expect(p).not.toContain(KEPT.topic);
      expect(p).toContain(OPT.topic);
    }
  });

  it("R3 선택 항목 보류 — 조건에서 사라지고 보류 섹션에 사유·재개 조건과 함께 표시", () => {
    const diag = diagWithChecks([KEPT, OPT]);
    const reviews = checkReviews(diag, { [OPT.topic]: "defer" }, { reason: "알림 연동 미확정", resumeCondition: "연동 방식 확정 후 재개" });
    const [cx, cl] = bothTools(diag, basePlan, reviews, gatePrerequisites(diag));
    for (const p of [cx, cl]) {
      expect(conditionSections(p)).not.toContain(OPT.topic);
      expect(p).toContain("알림 연동 미확정");
      expect(p).toContain("연동 방식 확정 후 재개");
      expect(p).toContain(KEPT.topic);
    }
  });

  it("R4 필수 항목 보류 — 조건에서 사라지고 보류 섹션에 표시", () => {
    const diag = diagWithChecks([KEPT, OPT]);
    const reviews = checkReviews(diag, { [KEPT.topic]: "defer" }, { reason: "엑셀 구조 미확정", resumeCondition: "샘플 확보 후 재개" });
    const [cx, cl] = bothTools(diag, basePlan, reviews, gatePrerequisites(diag));
    for (const p of [cx, cl]) {
      expect(conditionSections(p)).not.toContain(KEPT.topic);
      expect(p).toContain("엑셀 구조 미확정");
      expect(p).toContain("샘플 확보 후 재개");
      expect(p).toContain(OPT.topic);
    }
  });

  it("R5 선택·필수 혼합 (선택 제외 + 필수 보류) — 선택은 전수 부재, 필수는 조건에서만 부재", () => {
    const diag = diagWithChecks([KEPT, OPT]);
    const reviews = checkReviews(diag, { [OPT.topic]: "exclude", [KEPT.topic]: "defer" }, { reason: "엑셀 구조 미확정", resumeCondition: "샘플 확보 후 재개" });
    const [cx, cl] = bothTools(diag, basePlan, reviews, gatePrerequisites(diag));
    for (const p of [cx, cl]) {
      expect(p).not.toContain(OPT.topic);
      expect(conditionSections(p)).not.toContain(KEPT.topic);
      expect(p).toContain("엑셀 구조 미확정");
    }
  });

  it("R6 동일 주제 중복 선행조건 (필수+선택, 동일 토픽·비고) — 양쪽 모두 제외하면 라벨 사본까지 전수 부재", () => {
    const dup = { topic: "이상값 알림 메커니즘", status: "확인 필요", note: "결측 표시와 알림은 선택 기능" } as const;
    const diag = diagWithChecks([KEPT, { ...dup, required: true }, { ...dup, required: false }]);
    const reviews = checkReviews(diag, { [dup.topic]: "exclude" });
    const [cx, cl] = bothTools(diag, basePlan, reviews, gatePrerequisites(diag));
    for (const p of [cx, cl]) {
      expect(p).not.toContain(dup.topic);
      expect(p).not.toContain("(선택)");
      expect(p).toContain(KEPT.topic);
    }
  });

  it("R7 (선택)·(필수) 표기 항목이 계획 경로로 전달 — 제외 시 전수 부재, 유지 시 단일 표준 문구로 병합", () => {
    const req2 = { topic: "외부 저장소 접근 권한", status: "확인 필요", note: "폴더 권한 실제 확인", required: true } as const;
    const diag = diagWithChecks([KEPT, OPT, req2]);
    const plan: AxPlan = {
      ...basePlan,
      prerequisites: ["이상값 알림 메커니즘 (선택) — 결측 표시와 알림은 선택 기능", "외부 저장소 접근 권한 (필수) — 폴더 권한 실제 확인"],
      integrations: ["이상값 알림 메커니즘 (선택) — 결측 표시와 알림은 선택 기능", "외부 저장소 접근 권한 (필수) — 폴더 권한 실제 확인"],
    };
    const excluded = checkReviews(diag, { [OPT.topic]: "exclude", [req2.topic]: "exclude" });
    const [cx, cl] = bothTools(diag, plan, excluded, gatePrerequisites(diag));
    for (const p of [cx, cl]) {
      expect(p).not.toContain(OPT.topic);
      expect(p).not.toContain(req2.topic);
      expect(p).toContain(KEPT.topic);
    }
    const kept = checkReviews(diag, {});
    const [kx] = bothTools(diag, plan, kept, gatePrerequisites(diag));
    expect(kx).toContain("이상값 알림 메커니즘 — 결측 표시와 알림은 선택 기능");
    expect(kx).toContain("외부 저장소 접근 권한 — 폴더 권한 실제 확인");
    expect(kx).not.toContain("(선택)");
    expect(kx).not.toContain("(필수)");
  });

  it("R8 여러 출처 동일 항목 (options + profile + plan) — 제외 시 전수 부재", () => {
    const diag = diagWithChecks([KEPT, OPT]);
    const plan: AxPlan = { ...basePlan, prerequisites: ["이상값 알림 메커니즘 (선택) — 결측 표시와 알림은 선택 기능"], integrations: ["이상값 알림 메커니즘 (선택) — 결측 표시와 알림은 선택 기능"] };
    const reviews = checkReviews(diag, { [OPT.topic]: "exclude" });
    // options=gatePrerequisites(UI 경로) + profile(executionProfile 내부) + plan 경로가 모두 유입된다.
    const [cx, cl] = bothTools(diag, plan, reviews, gatePrerequisites(diag));
    for (const p of [cx, cl]) {
      expect(p).not.toContain(OPT.topic);
      expect(p).toContain(KEPT.topic);
    }
  });

  it("R9 Level 0 연동 확인 항목 제외 — 범위(미래/확인 필요) 불일치에도 불구하고 전수 부재", () => {
    const l0Factors = diagnosisFixture.factors.map(f => ({
      ...f,
      aiValue: f.key === "repetition" || f.key === "regularity" || f.key === "dataStructure" ? 2 : 2,
    }));
    const api = { topic: "외부 API 연동 가능 여부", status: "확인 필요", note: "접근 권한 실제 확인", required: false } as const;
    const diag = diagWithChecks([KEPT, api], { factors: l0Factors });
    const reviews = checkReviews(diag, { [api.topic]: "exclude" });
    const [cx, cl] = bothTools(diag, basePlan, reviews, gatePrerequisites(diag));
    for (const p of [cx, cl]) {
      expect(p).not.toContain(api.topic);
      expect(p).toContain(KEPT.topic);
    }
  });

  it("R10 필수 안전조건 보존 — '불가' 확인 항목을 제외해도 거부 증거는 지시문에 남는다", () => {
    const denied = { topic: "외부 시스템 접근 권한", status: "불가", note: "보안 정책상 외부 접근 거부됨", required: true } as const;
    const diag = diagWithChecks([KEPT, OPT, denied]);
    const plan: AxPlan = { ...basePlan, prerequisites: ["외부 시스템 접근 권한 — 보안 정책상 외부 접근 거부됨"] };
    const reviews = checkReviews(diag, { [denied.topic]: "exclude" });
    const [cx, cl] = bothTools(diag, plan, reviews, gatePrerequisites(diag));
    for (const p of [cx, cl]) {
      expect(p).toContain(denied.topic);
      expect(p).toContain(KEPT.topic);
    }
  });

  it("R11 추가 질문 동일 주제 — 확인 항목 제외 시 같은 주제를 묻는 추가 질문이 조건으로 재유입되지 않는다", () => {
    const diag = diagWithChecks([KEPT, OPT], {
      informationSufficiency: "needs-check",
      followUpQuestions: ["이상값 알림 메커니즘을 알려주세요."],
    });
    const reviews = checkReviews(diag, { [OPT.topic]: "exclude" });
    const [cx, cl] = bothTools(diag, basePlan, reviews, gatePrerequisites(diag));
    for (const p of [cx, cl]) {
      expect(p).not.toContain(OPT.topic);
      expect(conditionSections(p)).not.toContain("알림 메커니즘");
      expect(p).toContain(KEPT.topic);
    }
  });

  it("R12 별개 검토 항목 — 위험 문구와 동일한 토픽은 확인 항목 제외만으로 제거되지 않는다 (관찰: 별도 제외 필요)", () => {
    const diag = diagWithChecks([KEPT, OPT], { risks: ["이상값 알림 메커니즘"] });
    const reviews = checkReviews(diag, { [OPT.topic]: "exclude" });
    const [cx] = bothTools(diag, basePlan, reviews, gatePrerequisites(diag));
    // 위험 항목은 별개의 검토 대상이므로, 확인 항목 제외만으로는 예외 섹션에서 사라지지 않는다.
    expect(cx).toContain("이상값 알림 메커니즘");
    expect(conditionSections(cx)).not.toContain(OPT.topic);
  });
});
