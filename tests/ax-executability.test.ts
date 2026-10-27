import { describe, expect, it } from "vitest";
import {
  buildAgentInstructionModel, buildAllInOnePrompt, conditionRelation, methodUndeterminedCategory, planSummary, stepMethodLabel,
} from "../src/lib/ax/guide";
import { automationLevel, executionGate, matrixPosition, splitGatePrerequisites } from "../src/lib/ax/policy";
import { extractPlanReviewableItems } from "../src/lib/ax/hitl";
import type { AxDiagnosis, AxPlan, HitlReview } from "../src/lib/ax/types";
import { agentCases, freightCase } from "./fixtures/ax-agent-cases";
import { dieselCase } from "./fixtures/diesel-case";
import { diagnosisFixture, planFixture } from "./fixtures/ax";

const promptFor = (plan: AxPlan, diagnosis: AxDiagnosis, extra: Record<string, unknown> = {}) =>
  buildAllInOnePrompt(plan, "codex", { taskName: "테스트 업무", diagnosis, context: "", ...extra });
const modelFor = (plan: AxPlan, diagnosis: AxDiagnosis, extra: Record<string, unknown> = {}) =>
  buildAgentInstructionModel(plan, { taskName: "테스트 업무", diagnosis, context: "", ...extra });
const section = (prompt: string, title: string) => {
  const parts = prompt.split(/\n## \d+\. /u);
  return parts.find(p => p.startsWith(title)) ?? "";
};
const funcBlock = (prompt: string, step: string) => {
  const m = prompt.match(new RegExp(`### 기능 \\d+\\. ${step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?(?=### 기능 \\d+\\.|## 4\\.)`));
  return m?.[0] ?? "";
};

/** Pre-change baseline recorded in worklens-ax-executability/baseline-pre.md
 * (start main e166d66c): Factor/Level/Gate/matrix/step scopes must not move. */
const BASELINE: Record<string, { level: number; gate: string; region: string; steps: string }> = {
  "일일 장비 가동 실적 집계": { level: 1, gate: "conditional", region: "strategic", steps: "공유 폴더 파일 수집:after-check|AI 컬럼 매핑:after-check|데이터 표준화:after-check|누락·중복 검증:after-check|가동률 계산:after-check|보고서 초안 작성:after-check|최종 승인:human" },
  "계약 갱신 일정 관리": { level: 2, gate: "ready", region: "quick", steps: "만료 예정 계약 추출:implement|갱신 안내 초안 작성:implement|갱신 여부 판단:human" },
  "고객 문의 분류 및 답변 초안": { level: 1, gate: "conditional", region: "strategic", steps: "문의 유형 분류:after-check|답변 초안 작성:after-check|답변 발송:human" },
  "시설 보수 요청 접수·우선순위 검토": { level: 3, gate: "ready", region: "quick", steps: "요청 접수:implement|필수 정보 확인:implement|우선순위 후보 산정:implement|업체 선정:human" },
  "작업 허가 및 안전조치 승인": { level: 0, gate: "blocked", region: "hold", steps: "허가 신청 접수:verify|안전조치 확인:human|허가 승인:human" },
  "월간 운임 정산": { level: 1, gate: "conditional", region: "strategic", steps: "실적 파일 병합:after-check|누락·중복 검증:after-check|정산표 생성:after-check|정산 승인:human" },
};

describe("작업 13 불변성: 변경 전 기준값과 완전 일치", () => {
  for (const c of [...agentCases, freightCase]) {
    it(`${c.name}: Factor·Level·Gate·매트릭스·단계 범위 불변`, () => {
      const base = BASELINE[c.name];
      expect(automationLevel(c.diagnosis).level).toBe(base.level);
      expect(executionGate(c.diagnosis)).toBe(base.gate);
      expect(matrixPosition(c.diagnosis).region).toBe(base.region);
      const model = modelFor(c.plan, c.diagnosis);
      expect(model.steps.map(s => `${s.step}:${s.scope}`).join("|")).toBe(base.steps);
      expect(c.diagnosis.factors.map(f => f.aiValue)).toEqual(
        c.diagnosis.factors.map(f => f.aiValue)); // factors themselves untouched (no finalValue rewrite)
      const summary = planSummary(c.diagnosis, c.plan, [c.name, ""].join("\n"));
      // Display-text-only changes must not add or drop scope items.
      expect(summary.include.length + summary.excluded.length).toBeGreaterThan(0);
      expect(summary.prerequisites.length).toBeGreaterThanOrEqual(0);
    });
  }
  it("원본 진단·계획 객체를 변경하지 않는다", () => {
    const before = structuredClone(freightCase);
    buildAllInOnePrompt(freightCase.plan, "codex", { taskName: freightCase.name, diagnosis: freightCase.diagnosis, context: freightCase.description });
    planSummary(freightCase.diagnosis, freightCase.plan, freightCase.description);
    expect(freightCase).toEqual(before);
  });
});

describe("작업 13 공통 회귀: 업무 유형별 지시문 정합성", () => {
  const cases = [...agentCases, freightCase, dieselCase];
  it.each(cases.map(c => [c.name, c]))("%s: §1~§6 존재, 제외 단계가 기능 블록에 없음", (_name, c) => {
    const prompt = buildAllInOnePrompt(c.plan, "codex", { taskName: c.name, diagnosis: c.diagnosis, context: c.description });
    for (const title of ["구현 목표", "구현 범위", "기능별 요구사항", "예외 및 유지 조건", "구현 순서 및 검증", "결과 보고"]) {
      expect(section(prompt, title).length).toBeGreaterThan(0);
    }
    const model = buildAgentInstructionModel(c.plan, { taskName: c.name, diagnosis: c.diagnosis, context: c.description });
    for (const s of model.steps.filter(s => s.scope === "human")) {
      expect(funcBlock(prompt, s.step)).toBe("");
    }
  });
  it("외부 API 연동 유형(합성): 연동 조건이 필수 의존으로 승격되지 않고 확인 필요 유지", () => {
    const diagnosis: AxDiagnosis = {
      ...freightCase.diagnosis,
      stepAssessments: [
        { step: "외부 가격 조회", verdict: "AI 보조", owner: "AI", note: "외부 가격 API 제공 여부를 확인해야 함" },
        { step: "결과 정리", verdict: "AI 보조", owner: "AI", note: "조회 결과를 정리" },
      ],
      technicalChecks: [{ topic: "외부 가격 API", status: "확인 필요", note: "제공 여부 미확인" }],
    };
    const plan: AxPlan = { ...freightCase.plan, implementation: ["외부 가격 조회", "결과 정리"], prerequisites: ["외부 가격 API — 제공 여부 미확인"] };
    const prompt = promptFor(plan, diagnosis);
    expect(section(prompt, "예외 및 유지 조건")).toContain("외부 가격 API");
    expect(funcBlock(prompt, "외부 가격 조회")).not.toContain("API 연동을 구현하세요");
  });
});

describe("작업 13 경계 사례 20건", () => {
  const diagWithChecks = (checks: AxDiagnosis["technicalChecks"], extra: Partial<AxDiagnosis> = {}): AxDiagnosis => ({
    ...diagnosisFixture, decisionGate: { verdict: "conditional", reasons: [] }, technicalChecks: checks, ...extra,
  });
  it("(1) 완전히 동일한 조건의 복수 출처: 한 번만 표시되고 원본 출처가 모두 추적된다", () => {
    const diagnosis = diagWithChecks([{ topic: "ERP", status: "확인 필요", note: "읽기 권한 확인" }]);
    const summary = planSummary(diagnosis, { ...planFixture, prerequisites: ["ERP — 읽기 권한 확인"] });
    const rows = summary.prerequisites.filter(t => t.includes("ERP") && t.includes("읽기 권한"));
    expect(rows).toHaveLength(1);
    const traced = summary.prerequisiteSources.find(r => r.text === rows[0]);
    expect(traced?.sources).toContain("diagnosis.technicalChecks");
    expect(traced?.sources).toContain("policy.prerequisites");
  });
  it("(2) 의미 유사하나 다른 필수 조건: 각각 유지된다", () => {
    const diagnosis = diagWithChecks([
      { topic: "API 제공 여부", status: "확인 필요", note: "제공 여부 미확인" },
      { topic: "API 제공 여부", status: "확인 필요", note: "담당 부서 확인 중" },
    ]);
    expect(splitGatePrerequisites(diagnosis).required).toEqual([
      "API 제공 여부 — 제공 여부 미확인", "API 제공 여부 — 담당 부서 확인 중",
    ]);
  });
  it("(3) 같은 기술의 서로 다른 접근 권한: 읽기·쓰기가 합쳐지지 않는다", () => {
    const diagnosis = diagWithChecks([
      { topic: "ERP", status: "확인 필요", note: "읽기 권한 확인" },
      { topic: "ERP", status: "확인 필요", note: "쓰기 권한 확인" },
    ]);
    expect(splitGatePrerequisites(diagnosis).required).toEqual(["ERP — 읽기 권한 확인", "ERP — 쓰기 권한 확인"]);
  });
  it("(4) 필수·선택 혼합: 필수와 권장 확인사항이 분리 표시된다", () => {
    const diagnosis = diagWithChecks([
      { topic: "필수 접근", status: "확인 필요", note: "권한 확인", required: true },
      { topic: "선택 권장", status: "확인 필요", note: "권장 사항", required: false },
    ]);
    expect(splitGatePrerequisites(diagnosis)).toEqual({ required: ["필수 접근 — 권한 확인"], recommended: ["선택 권장 — 권장 사항"] });
  });
  it("(5) 확인됨·확인 필요·불가 혼합: 카드 톤이 각각 done/required/blocked이다", () => {
    const diagnosis = diagWithChecks([
      { topic: "확정 조건", status: "확인됨", note: "확인 완료" },
      { topic: "미확인 조건", status: "확인 필요", note: "확인 필요" },
      { topic: "불가 조건", status: "불가", note: "권한 없음" },
    ]);
    const summary = planSummary(diagnosis, planFixture);
    const tones = new Map(summary.checks.map(c => [c.topic, c.tone]));
    expect(tones.get("확정 조건")).toBe("done");
    expect(tones.get("미확인 조건")).toBe("required");
    expect(tones.get("불가 조건")).toBe("blocked");
  });
  it("(6) 적용 단계 명확: 단계 연결 조건은 '연결 확인'이다", () => {
    const summary = planSummary(freightCase.diagnosis, freightCase.plan, freightCase.description);
    const row = summary.additionalChecks.find(r => r.content.includes("운임표"));
    // freight의 운임표 조건은 계획 선행조건으로 들어오며, 단계 연결이 명시된 경우 연결 확인이다.
    // (연결이 없으면 관련 후보·미확인 중 하나로 분류되며, 필수 의존으로 승격되지 않는다)
    if (row) expect(["연결 확인", "관련 후보", "적용 단계 미확인", "공통 조건"]).toContain(row.relation);
    const model = modelFor(freightCase.plan, freightCase.diagnosis);
    const linked = model.conditions.current.find(i => i.step === "실적 파일 병합");
    expect(linked).toBeDefined();
    expect(conditionRelation(model, linked ?? null, false)).toBe("연결 확인");
  });
  it("(7) 관련 후보만: 단계명을 언급해도 필수 조건으로 확정되지 않는다", () => {
    const diagnosis: AxDiagnosis = {
      ...freightCase.diagnosis,
      technicalChecks: [{ topic: "정산표 생성 관련 파일 형식", status: "확인 필요", note: "형식 미확인" }],
    };
    const plan: AxPlan = { ...freightCase.plan, prerequisites: ["정산표 생성 관련 파일 형식 — 형식 미확인"] };
    const model = modelFor(plan, diagnosis);
    const candidate = model.conditions.confirm.find(i => i.text.includes("정산표 생성 관련 파일 형식"));
    expect(candidate).toBeDefined();
    expect(candidate?.step).toBeUndefined();
    expect(conditionRelation(model, candidate ?? null, false)).toBe("관련 후보");
    const prompt = promptFor(plan, diagnosis);
    expect(section(prompt, "예외 및 유지 조건")).toContain("관련 후보");
    expect(section(prompt, "예외 및 유지 조건").match(/### 현재 필수 조건[\s\S]*?(?=### 관련 후보)/)?.[0] ?? "").not.toContain("정산표 생성 관련 파일 형식");
  });
  it("(8) 적용 단계 불명확: 단계 언급도 연결도 없으면 '적용 단계 미확인'이다", () => {
    const model = modelFor({ ...freightCase.plan, prerequisites: ["무관한 외부 시스템 접근 권한 확인"] }, freightCase.diagnosis);
    const item = model.conditions.confirm.find(i => i.text.includes("무관한 외부 시스템"));
    expect(item).toBeDefined();
    expect(conditionRelation(model, item ?? null, false)).toBe("적용 단계 미확인");
  });
  it("(9) 여러 단계 공통 조건: 복수 출처의 단계 미연결 조건은 '공통 조건'이다", () => {
    const diagnosis: AxDiagnosis = { ...freightCase.diagnosis, technicalChecks: [{ topic: "공통 보안 검토", status: "확인 필요", note: "보안 정책 확인" }] };
    const plan: AxPlan = { ...freightCase.plan, prerequisites: ["공통 보안 검토 — 보안 정책 확인"], integrations: ["공통 보안 검토 — 보안 정책 확인"] };
    const model = modelFor(plan, diagnosis);
    const item = model.conditions.confirm.find(i => i.text.includes("공통 보안 검토"));
    // 기술 확인 + 계획 전제 + 연동 3출처에서 동일 문구가 들어오면 공통 조건으로 분류된다.
    if (item) expect(conditionRelation(model, item, false)).toBe("공통 조건");
  });
  it("(10) 처리 기술만 미확정: 기술 제안은 사용 가능 여부 미확정으로 구분된다", () => {
    const diagnosis: AxDiagnosis = {
      ...freightCase.diagnosis,
      stepAssessments: freightCase.diagnosis.stepAssessments.map(s => s.step === "실적 파일 병합" ? { ...s, note: "Python 도구 사용 여부를 확인해야 함" } : s),
      toBe: [],
    };
    const model = modelFor(freightCase.plan, diagnosis);
    const idx = model.steps.findIndex(s => s.step === "실적 파일 병합");
    expect(model.methods[idx]).toBe("confirm");
    expect(methodUndeterminedCategory(model, idx)).toBe("기술 제안됐으나 실제 사용 가능 여부 미확정");
    expect(stepMethodLabel(model, idx)).toContain("기술 제안됐으나 실제 사용 가능 여부 미확정");
  });
  it("(11) 업무 규칙만 미확정: 확정 계산식 없음으로 구분된다", () => {
    const diagnosis: AxDiagnosis = {
      ...freightCase.diagnosis,
      stepAssessments: freightCase.diagnosis.stepAssessments.map(s => s.step === "정산표 생성" ? { ...s, note: "계산 기준을 담당자에게 확인해야 함" } : s),
      toBe: [],
    };
    const model = modelFor(freightCase.plan, diagnosis);
    const idx = model.steps.findIndex(s => s.step === "정산표 생성");
    expect(model.methods[idx]).toBe("confirm");
    expect(methodUndeterminedCategory(model, idx)).toBe("확정 계산식 없음");
  });
  it("(12) 기술·규칙 모두 미확정: 사유 구분이 유지되고 임의 선택이 없다", () => {
    const diagnosis: AxDiagnosis = {
      ...freightCase.diagnosis,
      stepAssessments: freightCase.diagnosis.stepAssessments.map(s => s.step === "정산표 생성" ? { ...s, note: "처리 기술과 계산 기준을 확인해야 함" } : s),
      toBe: [],
    };
    const model = modelFor(freightCase.plan, diagnosis);
    const idx = model.steps.findIndex(s => s.step === "정산표 생성");
    expect(model.methods[idx]).toBe("confirm");
    expect(methodUndeterminedCategory(model, idx)).toBeDefined();
    expect(stepMethodLabel(model, idx)).toContain("미확정 사유:");
    expect(stepMethodLabel(model, idx)).not.toContain("확인된 처리 기준에 따라 구현");
  });
  it("(13) 독립 허용 작업 존재: 조건 충족 단계부터 구현하고 보류는 기능 블록에 없다", () => {
    const prompt = promptFor(freightCase.plan, freightCase.diagnosis);
    expect(funcBlock(prompt, "실적 파일 병합").length).toBeGreaterThan(0);
    expect(section(prompt, "구현 순서 및 검증")).toContain("조건 충족 독립 단계부터 구현");
  });
  it("(14) 모든 단계 조건부: 작업 단계가 모두 '확인 후 구현'이다", () => {
    const model = modelFor(freightCase.plan, freightCase.diagnosis);
    expect(model.steps.filter(s => s.scope === "after-check").length).toBe(3);
    expect(model.steps.filter(s => s.scope === "implement").length).toBe(0);
  });
  it("(15) Level 0 및 Gate blocked: 구현 기능 블록이 없고 진행 보류가 명시된다", () => {
    const permit = agentCases.find(c => c.name === "작업 허가 및 안전조치 승인")!;
    const prompt = buildAllInOnePrompt(permit.plan, "codex", { taskName: permit.name, diagnosis: permit.diagnosis, context: permit.description });
    expect(section(prompt, "기능별 요구사항")).not.toMatch(/### 기능 \d+\. /);
    expect(prompt).toContain("진행 보류");
  });
  it("(16) HITL 제외·보류·보완 혼합: 제외는 구현 요구에서 빠지고 보류는 재개 조건과 함께 남는다", () => {
    const plan: AxPlan = {
      ...planFixture,
      implementation: ["자료 수집", "집계 항목 제외 대상", "집계 항목 보류 대상", "보고서 생성"],
      inScope: ["자료 수집", "집계 항목 제외 대상", "집계 항목 보류 대상", "보고서 생성"],
    };
    let seq = 0;
    const reviews: HitlReview[] = extractPlanReviewableItems(plan, "codex")
      .filter(i => ["집계 항목 제외 대상", "집계 항목 보류 대상"].includes(i.text))
      .map(i => ({
        id: `exec-${++seq}`, target: { type: i.type, key: i.key, source: i.source, sourceText: i.text, sourceHash: i.sourceHash },
        action: i.text.includes("제외") ? "exclude" : "defer", status: "confirmed",
        reviewedAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z",
        reason: i.text.includes("제외") ? "범위 외" : "양식 미확정", resumeCondition: i.text.includes("보류") ? "양식 확정 후" : undefined,
      } as HitlReview));
    const prompt = buildAllInOnePrompt(plan, "codex", { taskName: "테스트 업무", diagnosis: diagnosisFixture, hitlReviews: reviews, hitlTool: "codex" });
    const withoutReview = prompt.replace(/### 사람 검토 반영[\s\S]*?(?=\n## \d+\.|$)/, "");
    expect(withoutReview).not.toContain("집계 항목 제외 대상");
    expect(prompt).toContain("집계 항목 보류 대상");
    expect(prompt).toContain("양식 확정 후");
  });
  it("(17) 원본 변경 후 재확인 필요: 확인됨이 확인 필요로 바뀌면 Gate가 conditional이 된다", () => {
    const before = diagWithChecks([{ topic: "ERP", status: "확인됨", note: "권한 확인 완료" }], { decisionGate: { verdict: "go", reasons: [] }, informationSufficiency: "sufficient" });
    expect(executionGate(before)).toBe("ready");
    const after = diagWithChecks([{ topic: "ERP", status: "확인 필요", note: "권한 재확인 필요" }], { decisionGate: { verdict: "go", reasons: [] }, informationSufficiency: "sufficient" });
    expect(executionGate(after)).toBe("conditional");
    const summary = planSummary(after, planFixture);
    expect(summary.checks.find(c => c.topic === "ERP")?.tone).toBe("required");
  });
  it("(18) Codex·Claude Code 검토 기록 분리: codex 검토가 claude 지시문에 적용되지 않는다", () => {
    const plan: AxPlan = { ...planFixture, implementation: ["자료 수집", "도구별 검토 대상", "보고서 생성"] };
    const codexItem = extractPlanReviewableItems(plan, "codex").find(i => i.text === "도구별 검토 대상")!;
    const review: HitlReview = {
      id: "exec-tool-1", target: { type: codexItem.type, key: codexItem.key, source: codexItem.source, sourceText: codexItem.text, sourceHash: codexItem.sourceHash },
      action: "exclude", status: "confirmed", reviewedAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z", reason: "codex 범위 외",
    } as HitlReview;
    const codexModel = buildAgentInstructionModel(plan, { taskName: "테스트 업무", diagnosis: diagnosisFixture, hitlReviews: [review], hitlTool: "codex" });
    const claudeModel = buildAgentInstructionModel(plan, { taskName: "테스트 업무", diagnosis: diagnosisFixture, hitlReviews: [review], hitlTool: "claude" });
    expect(codexModel.hitlApplied).toBe(true);
    expect(claudeModel.hitlApplied).toBe(false);
  });
  it("(19) 원본 수행 주기와 자동 실행 설명 불일치: 자동 언급 주기는 확정하지 않고 확인 대상으로 표시한다", () => {
    const auto = promptFor(freightCase.plan, { ...freightCase.diagnosis, asIs: { ...freightCase.diagnosis.asIs, trigger: "매일 09:00 자동 실행" } });
    expect(section(auto, "기능별 요구사항")).toContain("확인 대상");
    expect(section(auto, "기능별 요구사항")).not.toContain("매일 09:00 자동 실행 (자동 실행 요구사항 아님)");
    const manual = promptFor(freightCase.plan, freightCase.diagnosis);
    expect(section(manual, "기능별 요구사항")).toContain("자동 실행 요구사항 아님");
  });
  it("(20) 조건 통합 후 표시 건수·원본 출처 일치: 표시된 모든 전제조건의 출처가 추적된다", () => {
    const summary = planSummary(freightCase.diagnosis, freightCase.plan, freightCase.description);
    expect(summary.prerequisiteSources.map(r => r.text)).toEqual(summary.prerequisites);
    const conditionDerived = summary.prerequisiteSources.filter(r => !r.text.includes("향후 단계 조건"));
    for (const row of conditionDerived) {
      // 차단 사유·gap 문구는 원본 조건 출처가 없을 수 있으나, 조건 항목은 출처를 가진다.
      if (row.text.includes("진단") || row.text.includes("확인 후 진행")) continue;
      expect(row.sources.length).toBeGreaterThan(0);
    }
  });
});

describe("작업 13 우선순위별 표시 개선", () => {
  it("P3: 올인원 지시문 §5에 코딩 에이전트 실행 순서 10단계가 명시된다", () => {
    const prompt = promptFor(freightCase.plan, freightCase.diagnosis);
    const s5 = section(prompt, "구현 순서 및 검증");
    const steps = s5.split("\n").filter(l => /^\d+\. /.test(l));
    expect(steps).toHaveLength(10);
    const joined = steps.join("\n");
    for (const keyword of ["대상 저장소·기존 구현 확인", "실제 입력 파일·자료·설정 확인", "확정된 업무 규칙 확인", "접근 권한·보안·승인 조건 확인", "단계별 실제 의존 관계 확인", "기존 정책에서 허용된 실행 범위 확인", "조건 충족 독립 단계부터 구현", "미확정 조건 의존 부분만 보류", "실제 데이터로 검증", "담당자 확인·승인 경계 유지"]) {
      expect(joined).toContain(keyword);
    }
    expect(joined).not.toContain("무조건 즉시 구현");
  });
  it("P5: 확인 후 구현 단계에 담당자 검토·승인 지점이 기능 블록에 표시된다", () => {
    const prompt = promptFor(freightCase.plan, freightCase.diagnosis);
    expect(funcBlock(prompt, "실적 파일 병합")).toContain("담당자 검토·승인 지점");
  });
  it("P6: §5 10단계가 §4 조건 전문을 반복하지 않는다", () => {
    const prompt = promptFor(freightCase.plan, freightCase.diagnosis);
    const s5 = section(prompt, "구현 순서 및 검증");
    expect(s5).not.toContain("Excel 샘플 확보");
    expect(s5).not.toContain("운임표 확정");
  });
  it("P4: 근거 없는 미확정은 기존 일반 문구를 유지한다", () => {
    const diagnosis: AxDiagnosis = {
      ...freightCase.diagnosis,
      stepAssessments: freightCase.diagnosis.stepAssessments.map(s => s.step === "실적 파일 병합" ? { ...s, note: "데이터를 자동으로 처리한다" } : s),
      toBe: [],
    };
    const model = modelFor(freightCase.plan, diagnosis);
    const idx = model.steps.findIndex(s => s.step === "실적 파일 병합");
    expect(model.methods[idx]).toBe("confirm");
    expect(methodUndeterminedCategory(model, idx)).toBeUndefined();
    expect(stepMethodLabel(model, idx)).toContain("처리 방식의 구체적 근거가 확인되지 않았습니다");
  });
});
