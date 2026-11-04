import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AxDiagnosis, AxTaskV2, HitlReview } from "@/lib/ax/types";
import { applyCheckConfirmations, checkConfirmationState, checkSourceHash, upsertCheckConfirmation } from "@/lib/ax/check-confirmations";
import { applyRediagnosis } from "@/lib/ax/diagnosis-preservation";
import { buildAgentInstructionModel, buildAllInOnePrompt, guardPlan, hasUnconfirmedMetric, isConfirmedMetric, unconfirmedPlanMetrics } from "@/lib/ax/guide";
import { extractPlanReviewableItems, extractReviewableItems, getValidConfirmedReviews, reconcileReviews } from "@/lib/ax/hitl";
import { registrationContext } from "@/lib/ax/registration";
import { importAxState } from "@/lib/ax/transfer";
import { diagnosisFixture, planFixture, taskFixture } from "./fixtures/ax";

const NOW = "2026-11-03T00:00:00.000Z";
const thresholds = ["샘플 데이터 기준 초안 내용이 수동 작성과 90% 이상 일치", "AI 초안 검토 시 오류 발생률 <5%"];

function targetScenario() {
  const plan = { ...structuredClone(planFixture), acceptance: [...thresholds] };
  const diagnosis: AxDiagnosis = { ...structuredClone(diagnosisFixture), planCodex: plan,
    informationSufficiency: "sufficient", decisionGate: { verdict: "go", reasons: [] }, technicalChecks: [],
    poc: { ...diagnosisFixture.poc, success: [...thresholds] } };
  return { plan, diagnosis };
}

describe("다운스트림 목표 수치와 담당자 확인 경계", () => {
  it.each(["codex", "claude"] as const)("미확정 PoC·acceptance 수치는 %s 완료 기준이 아니라 사용자 확인 대상으로 전달한다", tool => {
    const { plan, diagnosis } = targetScenario();
    const before = structuredClone({ plan, diagnosis });
    const options = { diagnosis, context: "입력 자료를 검토하고 담당자가 승인한다.", hitlTool: tool };
    const model = buildAgentInstructionModel(plan, options);
    expect(model.scoped.criteria.some(item => thresholds.includes(item.text))).toBe(false);
    for (const text of thresholds) {
      expect(model.classified.filter(item => item.text === text).every(item => item.scope === "confirm" && item.reason?.includes("사용자 확인 전 구현 완료 기준 아님"))).toBe(true);
    }
    const prompt = buildAllInOnePrompt(plan, tool, options);
    const targetSection = prompt.split("### 수치 목표 (사용자 확인 전 구현 완료 기준 아님)")[1]?.split("###")[0];
    expect(targetSection).toContain(thresholds[0]);
    expect(targetSection).toContain(thresholds[1]);
    expect(targetSection).toContain("acceptance·테스트 합격 기준으로 구현하거나 완료를 판정하지 마세요");
    const completion = prompt.split("### 업무 전체 완료 기준")[1]?.split("###")[0] ?? "";
    for (const text of thresholds) expect(completion).not.toContain(text);
    expect({ plan, diagnosis }).toEqual(before);
  });

  it("사용자 등록의 같은 측정 대상·값·비교 방향만 근거로 인정하며 데이터 속 숫자는 삭제하지 않는다", () => {
    const { plan, diagnosis } = targetScenario();
    const context = thresholds.join("\n");
    const model = buildAgentInstructionModel(plan, { diagnosis, context });
    expect(model.classified.filter(item => thresholds.includes(item.text)).every(item => !item.reason?.includes("수치 목표 확인 필요"))).toBe(true);
    expect(isConfirmedMetric("오류 발생률 <5%", "오류 발생률 5% 미만")).toBe(true);
    expect(isConfirmedMetric("오류 발생률 <5%", "오류 발생률 5% 이상")).toBe(false);
    expect(isConfirmedMetric("정확도 90% 이상", "누락률 90% 이상")).toBe(false);
    expect(isConfirmedMetric("정확도 90% 이상", "현재 정확도 90% 이상")).toBe(false);
    expect(isConfirmedMetric("정확도 90% 이상", "현재 정확도 90% 이상, 목표 정확도 95% 이상")).toBe(false);
    expect(isConfirmedMetric("정확도 95% 이상", "현재 정확도 90% 이상, 목표 정확도 95% 이상")).toBe(true);
    const dataFacts = ["부가세 10%를 원본 요율 그대로 읽는다", "입력 파일 5개와 2026년 11월 자료를 읽는다"];
    expect(guardPlan({ ...planFixture, asIs: dataFacts }, "").asIs).toEqual(dataFacts);
  });

  it.each([
    ["처리시간 5분 이내", "현재 처리시간 5분 이내", "처리시간 5분 이하", "처리시간 5분 이상"],
    ["응답시간 200ms 이하", "현재 응답시간 200ms 이하", "응답시간 200ms 이하", "응답시간 200ms 이상"],
    ["월 비용 1만원 이하", "현재 월 비용 1만원 이하", "월 비용 1만원 이하", "월 비용 1만원 이상"],
    ["연간 예산 1,000달러 미만", "현재 연간 예산 1,000달러 미만", "연간 예산 1000달러 미만", "연간 예산 1000달러 초과"],
    ["초당 100건 이상", "현재 초당 100건 이상", "초당 100건 이상", "초당 100건 미만"],
    ["처리량 100건/초 이상", "현재 처리량 100건/초 이상", "처리량 100건/초 이상", "처리량 100건/초 이하"],
  ])("시간·비용·성능 목표 %s를 현재값·반대 방향에서 승인하지 않는다", (target, baseline, approved, opposite) => {
    const plan = { ...structuredClone(planFixture), acceptance: [target] };
    const snapshot = structuredClone(plan);
    expect(unconfirmedPlanMetrics(plan, "")).toEqual(["acceptance[0]"]);
    expect(unconfirmedPlanMetrics(plan, baseline)).toEqual(["acceptance[0]"]);
    expect(unconfirmedPlanMetrics(plan, opposite)).toEqual(["acceptance[0]"]);
    expect(unconfirmedPlanMetrics(plan, approved)).toEqual([]);
    expect(hasUnconfirmedMetric(target, "")).toBe(true);
    expect(hasUnconfirmedMetric(target, approved)).toBe(false);
    expect(hasUnconfirmedMetric(target, baseline)).toBe(true);
    expect(guardPlan(plan, "").acceptance).toEqual([]);
    expect(guardPlan(plan, approved).acceptance).toEqual([target]);
    const model = buildAgentInstructionModel(plan, { diagnosis: diagnosisFixture });
    expect(model.classified.find(item => item.text === target)).toMatchObject({ scope: "confirm" });
    const prompt = buildAllInOnePrompt(plan, "codex", { diagnosis: diagnosisFixture });
    expect(prompt.split("### 수치 목표 (사용자 확인 전 구현 완료 기준 아님)")[1]?.split("###")[0]).toContain(target);
    expect(prompt.split("### 업무 전체 완료 기준")[1]?.split("###")[0] ?? "").not.toContain(target);
    expect(plan).toEqual(snapshot);
  });

  it("일반 주기·현재값·회차·필드 개수는 목표로 차단하지 않고 혼합 문장에서 목표만 검증한다", () => {
    const facts = ["수집 주기 5분", "매월 1회 실행", "현재 월 비용 1만원", "현재 처리시간 5분", "현재 초당 100건 처리", "파일 5개", "필드 10개", "검토 3회차", "부가세 10%", "목표 파일 5개를 읽는다"];
    const plan = { ...structuredClone(planFixture), asIs: facts };
    expect(unconfirmedPlanMetrics(plan, "")).toEqual([]);
    for (const fact of facts) expect(hasUnconfirmedMetric(fact, "")).toBe(false);
    expect(guardPlan(plan, "").asIs).toEqual(facts);
    const mixed = { ...plan, acceptance: ["수집 주기 5분, 응답시간 200ms 이하"] };
    expect(unconfirmedPlanMetrics(mixed, "응답시간 200ms 이하")).toEqual([]);
    expect(unconfirmedPlanMetrics(mixed, "수집 주기 5분")).toEqual(["acceptance[0]"]);
  });

  it("현재 원본과 일치한 해당 기준 HITL keep만 수치 근거가 되고 stale·다른 도구·위험 keep은 근거가 아니다", () => {
    const { plan, diagnosis } = targetScenario();
    const item = extractPlanReviewableItems(plan, "codex").find(entry => entry.text === thresholds[0])!;
    const review: HitlReview = { id: "synthetic-metric", target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash }, action: "keep", status: "confirmed", reviewedAt: NOW, updatedAt: NOW };
    const confirmed = buildAgentInstructionModel(plan, { diagnosis, hitlTool: "codex", hitlReviews: [review] });
    expect(confirmed.classified.filter(entry => entry.text === thresholds[0]).every(entry => !entry.reason?.includes("수치 목표 확인 필요"))).toBe(true);
    expect(confirmed.classified.filter(entry => entry.text === thresholds[1]).every(entry => entry.reason?.includes("수치 목표 확인 필요"))).toBe(true);
    for (const invalid of [{ ...review, target: { ...review.target, sourceHash: "changed" } }, { ...review, status: "stale" as const }, { ...review, target: { ...review.target, type: "risk" as const } }]) {
      const model = buildAgentInstructionModel(plan, { diagnosis, hitlTool: "codex", hitlReviews: [invalid] });
      expect(model.classified.filter(entry => entry.text === thresholds[0]).every(entry => entry.reason?.includes("수치 목표 확인 필요"))).toBe(true);
    }
    const otherTool = buildAgentInstructionModel(plan, { diagnosis, hitlTool: "claude", hitlReviews: [review] });
    expect(otherTool.classified.filter(entry => entry.text === thresholds[0]).every(entry => entry.reason?.includes("수치 목표 확인 필요"))).toBe(true);
    const supplemented = buildAgentInstructionModel(plan, { diagnosis, hitlTool: "codex", hitlReviews: [{ ...review, action: "supplement", supplement: thresholds[0] }] });
    expect(supplemented.classified.filter(entry => entry.text === thresholds[0]).every(entry => !entry.reason?.includes("수치 목표 확인 필요"))).toBe(true);
    const nonApproval = buildAgentInstructionModel(plan, { diagnosis, hitlTool: "codex", hitlReviews: [{ ...review, action: "supplement", supplement: "수치는 담당자와 나중에 협의" }] });
    expect(nonApproval.classified.filter(entry => entry.text === thresholds[0]).every(entry => entry.reason?.includes("수치 목표 확인 필요"))).toBe(true);
  });

  it("'확인' 메모를 저장·적용해도 실제 API·Excel 실행 검증 완료로 승격하지 않는다", () => {
    const diagnosis = { ...structuredClone(diagnosisFixture), technicalChecks: [
      { topic: "사내 API", status: "확인 필요" as const, note: "API 접근 확인 필요" },
      { topic: "Excel 처리", status: "확인 필요" as const, note: "Excel 파싱·저장 형식 확인 필요" },
    ] };
    let confirmations = upsertCheckConfirmation(undefined, diagnosis.technicalChecks[0], { result: "확인 완료", note: "확인" }, NOW);
    confirmations = upsertCheckConfirmation(confirmations, diagnosis.technicalChecks[1], { result: "확인 완료", note: "확인" }, NOW);
    const snapshot = structuredClone({ diagnosis, confirmations });
    const effective = applyCheckConfirmations(diagnosis, confirmations);
    expect(effective.technicalChecks.every(check => check.status === "확인됨")).toBe(true);
    const prompt = buildAllInOnePrompt(planFixture, "codex", { diagnosis: effective });
    expect(prompt).toContain("담당자 확인 완료 조건 (시스템 미검증)");
    expect(prompt).toContain("'확인' 같은 메모는 API 호출·Excel 파싱/저장·권한·업무 결과의 실제 실행 검증 완료를 뜻하지 않습니다");
    expect({ diagnosis, confirmations }).toEqual(snapshot);
  });

  it("같은 키의 원본 hash 변경은 stale, 대상 소멸은 gone으로 보존하고 자동 적용하지 않는다", () => {
    const task: AxTaskV2 = taskFixture("synthetic-source", structuredClone(diagnosisFixture));
    const item = extractReviewableItems(task.diagnosis!)[0];
    const review: HitlReview = { id: "synthetic-source-review", target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash }, action: "keep", status: "confirmed", reviewedAt: NOW, updatedAt: NOW };
    task.reviews = [review];
    expect(getValidConfirmedReviews(task, [item])).toEqual([review]);
    expect(reconcileReviews([review], [{ ...item, sourceHash: "changed" }]).get(review.id)?.status).toBe("changed");
    expect(getValidConfirmedReviews(task, [{ ...item, sourceHash: "changed" }])).toEqual([]);
    expect(reconcileReviews([review], []).get(review.id)?.status).toBe("gone");
    const incoming = structuredClone(task.diagnosis!);
    incoming.stepAssessments[0].note = "다른 실행 방식은 재확인 필요";
    const updated = applyRediagnosis(task, incoming, NOW);
    expect(updated.reviews?.[0]).toMatchObject({ ...review, status: "stale" });
    expect(task.reviews).toEqual([review]);
  });
});

// Operational exports stay external: opt in with AX_REAL_TASKS_PATH; never write to that file.
const realPath = process.env.AX_REAL_TASKS_PATH;
describe.skipIf(!realPath)("실제 원본 5업무 기술확인 6개·HITL 17개 읽기 전용 회귀", () => {
  it("가져오기·보기·재진단 연결에서 모든 저장 기록과 원본 바이트를 보존한다", () => {
    const bytes = readFileSync(realPath!, "utf8");
    const raw = JSON.parse(bytes) as { data: { tasks: AxTaskV2[] } };
    const state = importAxState(bytes);
    expect(state.tasks).toHaveLength(5);
    expect(state.tasks.flatMap(task => task.checkConfirmations ?? [])).toHaveLength(6);
    expect(state.tasks.flatMap(task => task.reviews ?? [])).toHaveLength(17);
    for (const task of state.tasks) {
      const original = raw.data.tasks.find(entry => entry.id === task.id)!;
      expect(task.reviews).toEqual(original.reviews);
      expect(task.checkConfirmations).toEqual(original.checkConfirmations);
      const snapshot = structuredClone(task);
      const diagnosis = task.diagnosis!;
      const items = [...extractReviewableItems(diagnosis), ...(diagnosis.planCodex ? extractPlanReviewableItems(diagnosis.planCodex, "codex") : [])];
      expect(getValidConfirmedReviews(task, items)).toEqual(task.reviews ?? []);
      for (const review of task.reviews ?? []) {
        const changedItems = items.map(item => item.key === review.target.key ? { ...item, sourceHash: "changed-source" } : item);
        expect(reconcileReviews([review], changedItems).get(review.id)?.status).toBe("changed");
        expect(getValidConfirmedReviews({ ...task, reviews: [review] }, changedItems)).toEqual([]);
        expect(reconcileReviews([review], items.filter(item => item.key !== review.target.key)).get(review.id)?.status).toBe("gone");
      }
      const effective = applyCheckConfirmations(diagnosis, task.checkConfirmations);
      for (const confirmation of task.checkConfirmations ?? []) {
        expect(confirmation).toMatchObject({ result: "확인 완료", note: "확인" });
        const check = diagnosis.technicalChecks.find(entry => checkSourceHash(entry) === confirmation.sourceHash)!;
        expect(check).toBeDefined();
        expect(checkConfirmationState(check, task.checkConfirmations).kind).toBe("applied");
        expect(checkConfirmationState({ ...check, note: `${check.note} 변경` }, task.checkConfirmations).kind).toBe("stale");
      }
      const after = applyRediagnosis(task, structuredClone(diagnosis), NOW);
      expect(after.reviews).toEqual(task.reviews);
      expect(after.checkConfirmations).toEqual(task.checkConfirmations);
      const prompt = buildAllInOnePrompt(diagnosis.planCodex, "codex", { diagnosis: effective, taskName: task.name, context: registrationContext(task), hitlReviews: task.reviews, hitlTool: "codex" });
      if (task.checkConfirmations?.length) expect(prompt).toContain("실제 실행 검증 완료를 뜻하지 않습니다");
      expect(task).toEqual(snapshot);
    }
    expect(readFileSync(realPath!, "utf8")).toBe(bytes);
  });
});
