import { describe, expect, it } from "vitest";
import type { AxDiagnosis, AxTaskV2, GenericRule, HitlReview } from "@/lib/ax/types";
import { applyRediagnosis } from "@/lib/ax/diagnosis-preservation";
import { buildAgentInstructionModel, buildAllInOnePrompt } from "@/lib/ax/guide";
import { extractPlanReviewableItems, extractReviewableItems, getValidConfirmedReviews } from "@/lib/ax/hitl";
import type { ReviewableItem } from "@/lib/ax/hitl";
import { deriveUnifiedRules } from "@/lib/ax/rule-questions";
import { checkKey, checkSourceHash } from "@/lib/ax/check-confirmations";
import { diagnosisFixture, planFixture, taskFixture } from "./fixtures/ax";

const beforeTime = "2026-10-04T00:00:00.000Z";
const afterTime = "2026-11-01T00:00:00.000Z";
const genericRule = (overrides: Partial<GenericRule> = {}): GenericRule => ({
  id: "R17", name: "담당자 재검토", category: "권한·검토 기준", applicability: "적용", status: "확정",
  detail: "검토 식별표 A17에 따라 담당자가 승인한 뒤에만 결과를 배포한다.",
  source: "담당자 확정 회의록", step: "담당자 승인", linkedDecisionId: "D5", ...overrides,
});
const review = (item: ReviewableItem, id: string, overrides: Partial<HitlReview> = {}): HitlReview => ({
  id, target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash },
  status: "confirmed", action: "keep", reviewedAt: beforeTime, updatedAt: beforeTime, ...overrides,
});
function savedTask(): AxTaskV2 {
  return {
    ...taskFixture("preserved", structuredClone(diagnosisFixture)),
    diagnosis: {
      ...structuredClone(diagnosisFixture), decisionPoints: [
        { id: "D1", status: "확정", detail: "사용자 기준표 A의 관리번호로 비교한다." },
        { id: "D2", status: "해당 없음", detail: "중복 제외 메모 B" },
        { id: "D3", status: "미확정", detail: "오류 검토 중 C" },
        { id: "D4", status: "확정", detail: "통과, 검토 대기" },
        { id: "D5", status: "확정", detail: "검토 대기" },
        { id: "D6", status: "해당 없음", detail: "파일 미사용 메모 F" },
        { id: "D7", status: "확정", detail: "사용자 산식 G7에 따라 분 단위를 합산한다." },
      ],
    },
    genericRules: [genericRule(), genericRule({ id: "R18", status: "미확정", detail: "미확정 비공개 처리 지시 P18" }),
      genericRule({ id: "R19", applicability: "해당 없음", detail: "미적용 비공개 처리 지시 N19" }),
      genericRule({ id: "R20", applicability: "적용 여부 미확정", detail: "적용 미정 비공개 처리 지시 A20" })],
    checkConfirmations: [{ key: checkKey("시스템 접근"), topic: "시스템 접근", sourceHash: checkSourceHash(diagnosisFixture.technicalChecks[0]), result: "확인 완료", note: "사용자가 확인한 권한 메모", updatedAt: beforeTime }],
  };
}

describe("재진단의 실제 저장 경계 — 사용자 기록 보존", () => {
  it.each(["missing", "contradictory"] as const)("새 진단이 %s여도 D1~D7과 범용 규칙·기술 확인 기록을 변경하지 않는다", mode => {
    const before = savedTask();
    const snapshot = structuredClone(before);
    const incoming: AxDiagnosis = {
      ...structuredClone(diagnosisFixture),
      asIs: { ...diagnosisFixture.asIs, steps: ["담당자에게 일정 전달"], inputs: [], exceptions: [] },
      stepAssessments: [], toBe: [], humanInLoop: [], technicalChecks: [], risks: [],
      ...(mode === "contradictory" ? { decisionPoints: [{ id: "D1", status: "해당 없음", detail: "AI가 바꾼 기준" }] } : {}),
    };
    const after = applyRediagnosis(before, incoming, afterTime);
    expect(after.diagnosis?.decisionPoints).toEqual(snapshot.diagnosis?.decisionPoints);
    expect(after.genericRules).toEqual(snapshot.genericRules);
    expect(after.checkConfirmations).toEqual(snapshot.checkConfirmations);
    expect(after.diagnosis?.technicalChecks).toEqual([]);
    expect(after.updatedAt).toBe(afterTime);
    expect(before).toEqual(snapshot);
    expect(incoming.decisionPoints?.[0]?.detail).toBe(mode === "contradictory" ? "AI가 바꾼 기준" : undefined);
  });

  it("사용자 저장 기록이 없으면 AI D값을 저장하지 않고 새 필요는 미저장 제안으로만 남긴다", () => {
    const before: AxTaskV2 = taskFixture("new");
    const incoming: AxDiagnosis = { ...structuredClone(diagnosisFixture), decisionPoints: [{ id: "D7", status: "확정", detail: "AI 산식" }] };
    const after = applyRediagnosis(before, incoming, afterTime);
    expect(after.diagnosis?.decisionPoints).toBeUndefined();
    expect(after.genericRules).toBeUndefined();
    const candidates = deriveUnifiedRules(after.diagnosis!);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every(item => item.origin === "candidate" && item.status === "미확정")).toBe(true);
  });

  it("일치 HITL은 유지하고 변경 대상만 stale로 표시하며 소멸·계획 검토의 이력과 판단은 보존한다", () => {
    const before = savedTask();
    const items = extractReviewableItems(before.diagnosis!);
    const steps = items.filter(item => item.type === "step");
    const planItem = extractPlanReviewableItems(planFixture, "codex")[0];
    before.reviews = [
      review(steps[0], "changed", { action: "supplement", supplement: "원본 식별자를 함께 표시", comment: "사용자 보완 의견" }),
      review(steps[1], "matched", { action: "defer", reason: "형식 기준 미정", resumeCondition: "양식 확정" }),
      review(steps[2], "gone", { action: "exclude", reason: "자동 승인 제외" }),
      review(planItem, "plan", { action: "exclude", reason: "계획 단계 제외" }),
    ];
    const snapshot = structuredClone(before);
    const incoming = structuredClone(before.diagnosis!);
    incoming.stepAssessments = incoming.stepAssessments.slice(0, 2).map((step, index) => index === 0 ? { ...step, note: "AI가 변경한 처리 방법" } : step);
    const after = applyRediagnosis(before, incoming, afterTime);
    expect(after.reviews).toEqual(snapshot.reviews!.map(item => item.id === "changed" ? { ...item, status: "stale", updatedAt: afterTime } : item));
    expect(getValidConfirmedReviews(after, extractReviewableItems(after.diagnosis!)).map(item => item.id)).toEqual(["matched"]);
    expect(before).toEqual(snapshot);
  });

  it("요청 스냅샷 대신 응답 반영 시점에 저장된 사용자 기준을 유지한다", () => {
    const requestSnapshot = savedTask();
    const latest = structuredClone(requestSnapshot);
    latest.diagnosis!.decisionPoints![0].detail = "응답 대기 중 사용자가 수정한 기준";
    latest.genericRules![0].name = "응답 대기 중 이름 수정";
    latest.genericRules![0].step = "수정된 사용자 단계";
    const after = applyRediagnosis(latest, structuredClone(diagnosisFixture), afterTime);
    expect(after.diagnosis?.decisionPoints).toEqual(latest.diagnosis?.decisionPoints);
    expect(after.genericRules).toEqual(latest.genericRules);
    expect(after.diagnosis?.decisionPoints).not.toEqual(requestSnapshot.diagnosis?.decisionPoints);
  });
});

describe("재진단 전후 실제 생성 지시문 — 확정·미확정·미적용 분리", () => {
  it.each(["codex", "claude"] as const)("%s 지시문은 확정 기준과 근거·단계·연계만 정확히 구현 대상으로 전달한다", tool => {
    const before = savedTask();
    const after = applyRediagnosis(before, structuredClone(diagnosisFixture), afterTime);
    for (const task of [before, after]) {
      const prompt = buildAllInOnePrompt(planFixture, tool, { diagnosis: task.diagnosis, genericRules: task.genericRules });
      expect(prompt).toContain("사용자 기준표 A의 관리번호로 비교한다.");
      expect(prompt).toContain("사용자 산식 G7에 따라 분 단위를 합산한다.");
      expect(prompt).toContain("R17 담당자 재검토 (권한·검토 기준) — 확정: 검토 식별표 A17에 따라 담당자가 승인한 뒤에만 결과를 배포한다.");
      expect(prompt).toContain("[관련 단계: 담당자 승인] [근거: 담당자 확정 회의록] [연계: D5]");
      expect(prompt).toContain("D3 특이값 — 미확정 (임의로 정하지 않음)");
      expect(prompt).toContain("D2 중복 — 해당 없음 (구현·검증 대상에서 제외)");
      expect(prompt).toContain("R18 담당자 재검토 (권한·검토 기준) — 미확정");
      expect(prompt).toContain("R20 담당자 재검토 (권한·검토 기준) — 적용 여부 확인 필요");
      for (const excluded of ["중복 제외 메모 B", "오류 검토 중 C", "파일 미사용 메모 F", "미확정 비공개 처리 지시 P18", "미적용 비공개 처리 지시 N19", "적용 미정 비공개 처리 지시 A20", "R19 담당자 재검토"]) {
        expect(prompt).not.toContain(excluded);
      }
    }
  });

  it("표시 대상이 아닌 미저장 D는 지시문에 혼입하지 않으며 저장 D는 새 진단과 무관하게 남는다", () => {
    const diagnosis = structuredClone(diagnosisFixture);
    diagnosis.asIs = { purpose: "담당자가 일정을 알림", trigger: "요청 시", inputs: [], steps: ["담당자가 일정 확인", "담당자가 일정 전달"], outputs: ["일정 안내"], exceptions: [], humanDecisions: [], systems: [] };
    diagnosis.stepAssessments = [];
    diagnosis.toBe = [];
    diagnosis.humanInLoop = [];
    diagnosis.technicalChecks = [];
    diagnosis.risks = [];
    diagnosis.poc = { hypothesis: "일정 전달 지원", inScope: ["일정 전달"], outOfScope: [], inputs: [], outputs: ["일정 안내"], evaluation: [], success: [], failure: [] };
    const displayedIds = deriveUnifiedRules(diagnosis).filter(item => item.kind === "decision").map(item => item.id);
    expect(buildAgentInstructionModel(planFixture, { diagnosis }).decisionPoints?.map(item => item.id)).toEqual(displayedIds);
    expect(displayedIds).not.toContain("D1");
    expect(displayedIds).not.toContain("D6");
    diagnosis.decisionPoints = [{ id: "D1", status: "확정", detail: "사용자 기존 비교 기준" }];
    const prompt = buildAllInOnePrompt(planFixture, "codex", { diagnosis });
    expect(prompt).toContain("D1 기준과 매칭 — 확정: 사용자 기존 비교 기준");
    expect(prompt).not.toContain("D6 빈 입력 — 미확정");
  });
});
