import { describe, expect, it } from "vitest";
import { buildAgentInstructionModel, buildAllInOnePrompt } from "../src/lib/ax/guide";
import { extractPlanReviewableItems, extractReviewableItems, type ReviewableItem } from "../src/lib/ax/hitl";
import type { AxDiagnosis, AxPlan, HitlReview } from "../src/lib/ax/types";
import { diagnosisFixture, planFixture } from "./fixtures/ax";

function fixture(steps = ["점검 기록 저장", "보고 자료 작성"], outputs = ["점검 기록", "보고 자료"]) {
  const diagnosis: AxDiagnosis = {
    ...diagnosisFixture,
    technicalChecks: [], risks: [], toBe: [],
    decisionGate: { verdict: "go", reasons: [] },
    asIs: { ...diagnosisFixture.asIs, steps, outputs },
    stepAssessments: steps.map(step => ({ step, verdict: "자동화", owner: "시스템", note: "확정된 규칙 기반 처리" })),
    poc: { ...diagnosisFixture.poc, inScope: steps, outputs, success: [], failure: [] },
    decisionPoints: [
      { id: "D4", status: "확정", detail: "정상, 오류, 확인 필요" },
      { id: "D5", status: "확정", detail: "확인 필요" },
    ],
  };
  const plan: AxPlan = {
    ...planFixture, goal: [], toBe: [], inScope: steps, implementation: steps,
    prerequisites: [], integrations: [], acceptance: [], tests: [], dataFlow: [],
  };
  return { diagnosis, plan };
}
function review(item: ReviewableItem, action: HitlReview["action"]): HitlReview {
  return {
    id: item.key, target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash },
    action, status: "confirmed", reason: "담당자 결정", resumeCondition: "담당자 재확인",
    reviewedAt: "2026-11-13T00:00:00Z", updatedAt: "2026-11-13T00:00:00Z",
  };
}
const section = (prompt: string, name: string) => prompt.split(/\n## \d+\. /u).find(part => part.startsWith(name)) ?? "";

for (const tool of ["codex", "claude"] as const) {
  describe(`P1 prompt contracts: ${tool}`, () => {
    const render = (f: ReturnType<typeof fixture>, reviews: HitlReview[] = [], context = "") =>
      buildAllInOnePrompt(f.plan, tool, { diagnosis: f.diagnosis, hitlTool: tool, hitlReviews: reviews, context });
    const reviewsFor = (f: ReturnType<typeof fixture>, names: string[], action: HitlReview["action"] = "exclude") =>
      [...extractReviewableItems(f.diagnosis), ...extractPlanReviewableItems(f.plan, tool)]
        .filter(item => (item.type === "step" || item.type === "planItem") && names.some(name => item.text === name || item.text.startsWith(`${name}:`)))
        .map(item => review(item, action));

    it.each([0, 1, 2])("F-D2 keeps confirmed work and isolated drafts with %i unknown decisions", count => {
      const f = fixture();
      for (const point of f.diagnosis.decisionPoints!.slice(0, count)) { point.status = "미확정"; point.detail = ""; }
      f.diagnosis.stepAssessments[1].note = "정책 미확정 시 보고 자료를 작성하지 마세요";
      const before = structuredClone(f);
      const prompt = render(f);
      expect(section(prompt, "기능별 요구사항")).toContain("점검 기록 저장");
      const sequence = section(prompt, "구현 순서 및 검증");
      expect(sequence).toContain("격리된 초안으로 작성");
      expect(sequence).toContain("'승인 전 임시 자료'");
      expect(sequence).toContain("이 초안 작성 원칙이 우선");
      expect(sequence).toContain("검증용 초안 파일·내부 산출물 생성을 금지하지 않으며");
      expect(sequence).toContain("미확정 값·정책을 임의로 확정하지 말고");
      expect(sequence).toContain("테스트·빌드·격리 검증은 진행");
      expect(sequence).toContain("운영에 반영·배포하지 마세요");
      expect(buildAgentInstructionModel(f.plan, { diagnosis: f.diagnosis }).steps).toHaveLength(2);
      expect(render(f)).toBe(prompt);
      expect(f).toEqual(before);
    });

    it("F-D2 adds no new approval barrier to a fully confirmed calculation", () => {
      const f = fixture(["금액 계산"], ["계산 결과"]);
      f.diagnosis.decisionPoints = (["D1", "D2", "D3", "D4", "D5", "D6", "D7"] as const)
        .map(id => ({ id, status: "해당 없음" }));
      f.diagnosis.humanInLoop = [];
      f.diagnosis.asIs.humanDecisions = [];
      f.plan.humanInLoop = [];
      const prompt = render(f);
      expect(prompt).not.toContain("### 초안 작성과 승인 경계");
      expect(section(prompt, "기능별 요구사항")).toContain("금액 계산");
    });

    it("F-D3 makes persistence an executable requirement without deciding the operating store or permissions", () => {
      const f = fixture();
      f.diagnosis.stepAssessments[0].note = "저장 시스템·권한 정책 미확정";
      const prompt = render(f, [], "저장한 점검 기록은 새로고침 후에도 다시 조회 가능");
      const requirements = section(prompt, "기능별 요구사항");
      for (const contract of ["기존 프로젝트의 저장소를 우선 재사용", "확정된 저장 방식·데이터 계약", "SQLite 또는 파일 기반 저장", "수정 후 저장", "재실행 후 데이터 유지", "잘못된 입력·저장 실패", "기존 데이터와의 호환성", "메모리 저장·하드코딩", "운영 적합성을 PASS로 보고하지", "새로운 외부 DB·클라우드 서비스·계정을 자동 생성하지"]) expect(requirements).toContain(contract);
      expect(section(prompt, "구현 순서 및 검증")).toContain("저장 기술 선택만 미확정이면 격리된 영속 저장 구현·검증을 진행");
      expect(requirements).toContain("저장 시스템·권한 정책은 확인·승인 대기");
    });

    it("F-D3 preserves a specified store and never forces storage on calculation-only work", () => {
      const f = fixture(["금액 계산"], ["계산 결과"]);
      expect(render(f)).not.toContain("SQLite");
      expect(render(f)).not.toContain("저장·재조회 구현 원칙");
      f.diagnosis.stepAssessments[0].note = "확정된 PostgreSQL 저장소에서 조회 후 규칙 기반 계산";
      const prompt = render(f);
      expect(prompt).toContain("확정된 PostgreSQL 저장소");
      expect(prompt).toContain("확정된 저장 방식·데이터 계약이 있으면 그 계약을 따르세요");
    });

    it("F-D1 detects an excluded plan producer even when it has no diagnosed step", () => {
      const f = fixture(["금액 계산"], ["월간 운임 정산표(거래처별 합계, 총합계)", "예외 건 목록"]);
      f.plan.implementation.push("정산표와 예외 건 목록 파일 생성");
      const reviews = reviewsFor(f, ["정산표와 예외 건 목록 파일 생성"]);
      const before = structuredClone({ f, reviews });
      const prompt = render(f, reviews);
      const scope = section(prompt, "구현 범위");
      expect(scope).toContain("등록된 출력과 충돌 (확인·승인 대기)");
      expect(scope).toContain("등록 필수 출력 '월간 운임 정산표(거래처별 합계, 총합계)'");
      expect(scope).toContain("등록 필수 출력 '예외 건 목록'");
      expect(scope).not.toContain("위 작업은 업무 배경 설명에 언급되더라도 구현 목표");
      expect(scope).toContain("필수 산출물 삭제 중 어느 쪽도 임의로 확정하지 말고");
      expect({ f, reviews }).toEqual(before);
    });

    it.each([
      ["금액 계산", ["보고 자료"], "exclude"],
      ["보고 자료 검토", ["보고 자료"], "exclude"],
      ["보고 자료 생성", ["보고 자료 요약본"], "defer"],
      ["점검 기록표 생성", ["점검 기록"], "exclude"],
      ["보고 자료 생성", ["보고 자료 요약본"], "exclude"],
    ] as const)("F-D1 does not infer a conflict from unrelated or deferred work: %s", (step, outputs, action) => {
      const f = fixture(["금액 계산", step], [...outputs]);
      const prompt = render(f, reviewsFor(f, [step], action));
      expect(prompt).not.toContain("등록된 출력과 충돌");
    });

    it("F-D1 allows an alternate retained producer and warns separately for multiple excluded artifacts", () => {
      const f = fixture(["금액 계산", "보고 자료 생성", "보고 자료 작성", "예외 목록 생성"], ["보고 자료", "예외 목록"]);
      const prompt = render(f, reviewsFor(f, ["보고 자료 생성", "예외 목록 생성"]));
      const scope = section(prompt, "구현 범위");
      expect(scope).not.toContain("등록 필수 출력 '보고 자료'");
      expect(scope).toContain("등록 필수 출력 '예외 목록'");
      const all = render(f, reviewsFor(f, ["보고 자료 생성", "보고 자료 작성", "예외 목록 생성"]));
      expect(all).toContain("등록 필수 출력 '보고 자료'");
      expect(all).toContain("등록 필수 출력 '예외 목록'");
    });

    it("all three fixes coexist without reviving excluded work or changing the model", () => {
      const f = fixture();
      f.diagnosis.decisionPoints![0].status = "미확정";
      f.diagnosis.stepAssessments[0].note = "저장 방식과 권한 정책 미확정";
      const reviews = reviewsFor(f, ["보고 자료 작성"]);
      const options = { diagnosis: f.diagnosis, hitlTool: tool, hitlReviews: reviews };
      const before = buildAgentInstructionModel(f.plan, options);
      const prompt = render(f, reviews, "점검 기록 저장 후 재조회 가능");
      expect(prompt).toContain("등록된 출력과 충돌");
      expect(prompt).toContain("격리된 초안으로 작성");
      expect(prompt).toContain("SQLite 또는 파일 기반 저장");
      expect(section(prompt, "기능별 요구사항")).not.toMatch(/### 기능 \d+\. 보고 자료 작성/u);
      expect(buildAgentInstructionModel(f.plan, options)).toEqual(before);
    });

    it("blocked scopes keep existing execution gates and do not acquire draft or storage permission", () => {
      const f = fixture();
      f.diagnosis.technicalChecks = [{ topic: "보안", required: true, status: "불가", note: "접근 권한 거부" }];
      f.diagnosis.decisionGate = { verdict: "no-go", reasons: ["접근 권한 거부"] };
      const prompt = render(f);
      expect(buildAgentInstructionModel(f.plan, { diagnosis: f.diagnosis }).gate).toBe("blocked");
      expect(prompt).not.toContain("격리된 초안으로 작성");
      expect(prompt).not.toContain("SQLite");
      expect(prompt).toContain("거부된 접근 권한");
    });
  });
}
