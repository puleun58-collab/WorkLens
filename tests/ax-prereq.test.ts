import { describe, expect, it } from "vitest";
import { buildAgentInstructionModel, buildAllInOnePrompt, planSummary } from "../src/lib/ax/guide";
import { executionProfile } from "../src/lib/ax/policy";
import { diagnosisFixture, planFixture } from "./fixtures/ax";
import type { AxDiagnosis } from "../src/lib/ax/types";

const withChecks = (checks: AxDiagnosis["technicalChecks"]): AxDiagnosis => ({
  ...diagnosisFixture,
  decisionGate: { verdict: "conditional", reasons: [] },
  technicalChecks: checks,
});
const CONTENTS = (diagnosis: AxDiagnosis, plan?: Parameters<typeof planSummary>[1]) =>
  planSummary(diagnosis, plan).additionalChecks;

describe("02 구현 전 확인사항 중복 제거", () => {
  it("기술 점검 카드와 동일한 문구의 조건은 추가 목록에 반복하지 않는다", () => {
    const diagnosis = withChecks([{ topic: "데이터 포맷 정의", status: "확인 필요", note: "컬럼명·형식 미확정" }]);
    const plan = { ...planFixture, integrations: ["데이터 포맷 정의 — 컬럼명·형식 미확정"] };
    const summary = planSummary(diagnosis, plan);
    expect(summary.checks.map(c => c.topic)).toEqual(["데이터 포맷 정의"]);
    expect(summary.additionalChecks.filter(row => row.content.includes("데이터 포맷 정의"))).toEqual([]);
  });

  it("같은 의미의 다른 표현은 카드가 이미 다루면 추가 목록에서 제외한다", () => {
    const diagnosis = withChecks([{ topic: "데이터 포맷 정의", status: "확인 필요", note: "컬럼명·형식 미확정" }]);
    const plan = { ...planFixture, integrations: ["컬럼명·형식 정의 확인 필요"] };
    expect(CONTENTS(diagnosis, plan).some(row => row.content.includes("컬럼명"))).toBe(false);
  });

  it("제목만 같고 세부 조건이 독립적이면 추가 목록에 유지한다", () => {
    const diagnosis = withChecks([{ topic: "데이터 형식", status: "확인 필요", note: "" }]);
    const plan = { ...planFixture, integrations: ["데이터 형식·컬럼명·필수값 정의 확인"] };
    const rows = CONTENTS(diagnosis, plan);
    expect(rows.some(row => row.content.includes("컬럼명·필수값"))).toBe(true);
  });

  it("API 존재 여부·접근 권한·인증 방식을 서로 다른 조건으로 보존한다", () => {
    const diagnosis = withChecks([
      { topic: "사내 시스템 연동 API", status: "확인 필요", note: "API 존재 여부와 인증 방식 미확인" },
    ]);
    const plan = {
      ...planFixture,
      integrations: ["API 존재 여부 확인", "API 접근 권한 확인", "API 인증 방식 확인"],
    };
    const rows = CONTENTS(diagnosis, plan);
    // 존재 여부·인증 방식은 카드가 다루므로 제외, 접근 권한은 독립 조건으로 유지
    expect(rows.some(row => row.content.includes("존재 여부"))).toBe(false);
    expect(rows.some(row => row.content.includes("인증 방식"))).toBe(false);
    expect(rows.some(row => row.content.includes("API 접근 권한"))).toBe(true);
  });

  it("여러 출처의 동일 조건은 한 번만 표시한다", () => {
    const diagnosis = withChecks([]);
    const plan = { ...planFixture, integrations: ["외부 전송 제한 확인"], security: ["외부 전송 제한 확인"] };
    const rows = CONTENTS(diagnosis, plan).filter(row => row.content.includes("외부 전송 제한"));
    expect(rows.length).toBe(1);
  });

  it("기술 점검이 없으면 상단 카드를 만들지 않고 추가 목록만 표시한다", () => {
    const summary = planSummary(withChecks([]));
    expect(summary.checks).toEqual([]);
  });
});

describe("조건 확인 상태와 적용 단계 연결 구분", () => {
  it("연결된 단계가 없으면 적용 단계를 미확정으로 표시하고 임의 지정하지 않는다", () => {
    const diagnosis = withChecks([{ topic: "시스템 접근", status: "확인 필요", note: "API와 권한 실제 확인" }]);
    const plan = { ...planFixture, integrations: ["외부 전송 제한 확인"] };
    const row = CONTENTS(diagnosis, plan).find(r => r.content.includes("외부 전송 제한"));
    expect(row?.stage).toBeNull();
    expect(row?.status).toBe("확인 필요");
  });

  it("연결된 진단 단계가 있으면 적용 단계에 표시한다", () => {
    const diagnosis: AxDiagnosis = {
      ...withChecks([]),
      stepAssessments: [{ step: "자료 수집", verdict: "자동화", owner: "시스템", note: "" }],
      technicalChecks: [],
    };
    const plan = { ...planFixture, integrations: ["자료 수집 — API 접근 권한 확인"] };
    const row = CONTENTS(diagnosis, plan).find(r => r.content.includes("API 접근 권한"));
    expect(row?.stage).toBe("자료 수집");
  });

  it("향후 단계 조건은 향후 검토 상태로 구분한다", () => {
    const diagnosis = withChecks([]);
    const model = buildAgentInstructionModel(undefined, { diagnosis });
    const future = model.conditions.future.map(item => item.text);
    if (!future.length) return;
    const rows = CONTENTS(diagnosis);
    for (const row of rows.filter(r => r.future)) {
      expect(row.status).toBe("향후 검토");
      expect(row.tone).toBe("future");
    }
  });

  it("차단 사유는 별도 카드로 분리하고 추가 목록에 섞지 않는다", () => {
    const diagnosis: AxDiagnosis = {
      ...diagnosisFixture,
      decisionGate: { verdict: "no-go", reasons: ["승인권자 미지정"] },
    };
    const summary = planSummary(diagnosis);
    expect(summary.blockReasons).toContain("승인권자 미지정");
    expect(summary.additionalChecks.some(row => row.content.includes("승인권자 미지정"))).toBe(false);
  });
});

describe("Level × Gate·원본 보존", () => {
  it("화면 구조 변경이 Level·Gate 판정을 바꾸지 않는다", () => {
    const diagnosis = withChecks([
      { topic: "데이터 포맷 정의", status: "확인 필요", note: "컬럼명·형식 미확정" },
      { topic: "사내 시스템 연동 API", status: "확인 필요", note: "API 존재 여부와 인증 방식 미확인" },
    ]);
    const before = executionProfile(diagnosis);
    planSummary(diagnosis, planFixture);
    const after = executionProfile(diagnosis);
    expect(after).toEqual(before);
  });

  it("원본 진단과 기술 점검 데이터를 변경하지 않는다", () => {
    const diagnosis = withChecks([{ topic: "시스템 접근", status: "확인 필요", note: "API와 권한 실제 확인" }]);
    const snapshot = JSON.stringify(diagnosis);
    planSummary(diagnosis, planFixture);
    expect(JSON.stringify(diagnosis)).toBe(snapshot);
  });

  it("모델의 조건 분류는 화면 표시와 무관하게 그대로 유지된다", () => {
    const diagnosis = withChecks([{ topic: "데이터 포맷 정의", status: "확인 필요", note: "컬럼명·형식 미확정" }]);
    const model = buildAgentInstructionModel(planFixture, { diagnosis });
    const texts = [...model.conditions.current, ...model.conditions.confirm, ...model.conditions.future].map(i => i.text);
    expect(texts.some(text => text.includes("데이터 포맷 정의"))).toBe(true);
  });
});

describe("화면·지시문 교차 정합성", () => {
  it("화면의 핵심 조건·추가 확인이 Codex·Claude 지시문의 선행 조건과 일치한다", () => {
    const diagnosis = withChecks([
      { topic: "데이터 포맷 정의", status: "확인 필요", note: "컬럼명·형식 미확정" },
      { topic: "사내 시스템 연동 API", status: "확인 필요", note: "API 존재 여부와 인증 방식 미확인" },
    ]);
    const summary = planSummary(diagnosis, planFixture);
    for (const tool of ["codex", "claude"] as const) {
      const prompt = buildAllInOnePrompt(planFixture, tool, { diagnosis, taskName: "교차 검증 업무" });
      for (const check of summary.checks) {
        expect(prompt).toContain(check.topic);
        if (check.note) expect(prompt).toContain(check.note);
      }
      for (const row of summary.additionalChecks) {
        expect(prompt).toContain(row.item);
      }
      // PART D/E (6개 영역 재구성): 차단·선행 조건 내용은 "예외 및 유지 조건" 섹션으로 통합되어 유지된다
      expect(prompt).toContain("예외 및 유지 조건");
    }
  });

  it("화면에서 중복 제거된 조건도 지시문에서는 제약으로 남는다", () => {
    const diagnosis = withChecks([{ topic: "데이터 포맷 정의", status: "확인 필요", note: "컬럼명·형식 미확정" }]);
    const plan = { ...planFixture, integrations: ["컬럼명·형식 정의 확인 필요"] };
    const summary = planSummary(diagnosis, plan);
    // 화면에서는 중복 제거됨
    expect(summary.additionalChecks.some(row => row.content.includes("컬럼명"))).toBe(false);
    // 지시문에서는 제약이 유지됨
    const prompt = buildAllInOnePrompt(plan, "codex", { diagnosis, taskName: "교차 검증 업무" });
    expect(prompt).toContain("컬럼명");
  });
});
