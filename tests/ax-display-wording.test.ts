import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DECISION_DISPLAY, decisionPanelLabel } from "@/components/ax/AxDecisionExamples";
import { DECISION_POINT_DEFS, confirmedStateNames, resolveDecisionPoints } from "@/lib/ax/decision-points";
import { buildAllInOnePrompt } from "@/lib/ax/guide";
import { diagnosisFixture, planFixture } from "./fixtures/ax";
import type { AxDiagnosis, GenericRule } from "@/lib/ax/types";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** 범용 규칙 체계 전환 후 기준 해시 (의도된 변경으로 재계산됨 — §05 제목·§05 확정 규칙 검증·
 * §06 문구·범용 블록 추가가 반영된 값이다. 해시가 바뀌면 01~04 의미 비교 단언과 함께 원인을 확인한다.) */
const BASELINE = {
  codex: { full: "4111e3324acaf694d61a9348511d58d4a665a13b11e29760f4aeae3855d9bd0d", bare: "ea713c7dcc1d5927124fb3843faae780ba345974f7436e90e60e9e2150ca292a" },
  claude: { full: "4111e3324acaf694d61a9348511d58d4a665a13b11e29760f4aeae3855d9bd0d", bare: "ea713c7dcc1d5927124fb3843faae780ba345974f7436e90e60e9e2150ca292a" },
};

const confirmedDiagnosis = (): AxDiagnosis => ({
  ...structuredClone(diagnosisFixture),
  decisionPoints: [
    { id: "D1", status: "확정", detail: "판매내역.xlsx / Sheet1, 주문번호, 누락·초과 판단" },
    { id: "D2", status: "확정", detail: "같은 주문번호가 여러 번 나오면 첫 행만 사용" },
    { id: "D3", status: "확정", detail: "빈칸은 확인 필요, 음수는 오류(확정)" },
    { id: "D4", status: "확정", detail: "정상, 오류(확정), 확인 필요" },
    { id: "D5", status: "확정", detail: "확인 필요" },
    { id: "D6", status: "해당 없음" },
    { id: "D7", status: "확정", detail: "합계는 소수 둘째 자리 반올림, 단위 원" },
  ],
});

const genericRules = (): GenericRule[] => [
  { id: "R1", name: "월말 마감 이후 주문 이월", category: "처리·판단 기준", detail: "마감일 이후 접수 주문은 다음 달 집계 대상에 포함하지 않는다. 마감일은 매월 말일이다.", source: "매뉴얼 3장", step: "월말 집계", applicability: "적용", status: "확정" },
  { id: "R2", name: "환불 건 별도 집계", category: "출력·완료 기준", detail: "환불 건은 정상 집계에서 제외하고 별도 목록으로 보고한다.", applicability: "적용", status: "미확정" },
  { id: "R3", name: "적용 여부 확인 필요 규칙", category: "예외·확인 기준", applicability: "적용 여부 미확정", status: "미확정" },
];

describe("AX 표시 문구 개선 — 표시 전용 라벨", () => {
  it("결정 지점 표시 제목은 항목명 + (D번호) 기준을 따른다", () => {
    expect(Object.entries(DECISION_DISPLAY).map(([id, item]) => `${item.title} (${id})`)).toEqual([
      "대조 기준 (D1)", "중복 처리 (D2)", "예외값 처리 (D3)", "결과 상태 (D4)",
      "판단 불가 처리 (D5)", "빈 파일 처리 (D6)", "계산 기준 (D7)",
    ]);
  });

  it("패널 라벨은 지시문 §10.5에 따라 D번호 없이 상태/대조 기준으로 쓴다 (#365 문구의 의도적 대체)", () => {
    expect(decisionPanelLabel("D1", "상태")).toBe("상태");
    expect(decisionPanelLabel("D1", "상세")).toBe("대조 기준");
    expect(decisionPanelLabel("D4", "상세")).toBe("대조 기준");
    expect(decisionPanelLabel("D5", "상세")).toBe("대조 기준");
  });

  it("지시문 생성용 DEFS 제목은 표시 변경과 무관하게 기존 값을 유지한다", () => {
    expect(DECISION_POINT_DEFS.map(def => `${def.id} ${def.title}`)).toEqual([
      "D1 기준과 매칭", "D2 중복", "D3 특이값", "D4 결과 상태", "D5 판단 불가", "D6 빈 입력", "D7 계산 기준",
    ]);
    expect(DECISION_POINT_DEFS.find(def => def.id === "D5")?.detailHint).toContain("결과 상태 (D4) 중 하나");
  });
});

describe("AX 범용 규칙 체계 — 01~04 지시문 의미 비교", () => {
  it("D1~D7 확정 + 범용 규칙 픽스처의 지시문이 전환 후 기준 해시와 일치한다 (Codex·Claude)", () => {
    for (const agent of ["codex", "claude"] as const) {
      const full = buildAllInOnePrompt(planFixture, agent, { diagnosis: confirmedDiagnosis(), taskName: "테스트 업무", context: "", genericRules: genericRules() });
      const bare = buildAllInOnePrompt(planFixture, agent, { diagnosis: diagnosisFixture, taskName: "테스트 업무", context: "", genericRules: [] });
      expect(sha(full)).toBe(BASELINE[agent].full);
      expect(sha(bare)).toBe(BASELINE[agent].bare);
    }
  });

  it("확정 D규칙 의미는 유지되고 확정 범용 규칙이 별도 블록으로 전달된다", () => {
    const prompt = buildAllInOnePrompt(planFixture, "codex", { diagnosis: confirmedDiagnosis(), taskName: "테스트 업무", context: "", genericRules: genericRules() });
    expect(prompt).toContain("D1 기준과 매칭 — 확정");
    expect(prompt).toContain("D4 결과 상태 — 확정: 정상 · 오류(확정) · 확인 필요");
    expect(prompt).toContain("D5 판단 불가 — 확정: 확인 필요");
    expect(prompt).toContain("### 업무 규칙 (범용)");
    expect(prompt).toContain("R1 월말 마감 이후 주문 이월");
    expect(prompt).toContain("마감일 이후 접수 주문은 다음 달 집계 대상에 포함하지 않는다");
    // 미확정·적용 여부 미확정 규칙은 확정 표시 없이 범용 블록에 구분 표시되고, 확인 목록에도 나타난다.
    expect(prompt).toContain("R1 월말 마감 이후 주문 이월 (처리·판단 기준) — 확정");
    expect(prompt).toContain("R2 환불 건 별도 집계 (출력·완료 기준) — 미확정");
    expect(prompt).toContain("R3 적용 여부 확인 필요 규칙 (예외·확인 기준) — 적용 여부 확인 필요");
    expect(prompt).toContain("미확정 범용 규칙: R2 환불 건 별도 집계");
    expect(prompt).toContain("적용 여부 확인 필요 범용 규칙: R3 적용 여부 확인 필요 규칙");
    // 예시 체계 문구는 남지 않는다.
    for (const leaked of ["결정 지점·예시 기반 구현 순서", "### 확정 예시", "업무 처리 예시 미확정", "업무 처리 예시 확인 필요", "예시별 기대 결과", "HITL 확정 예시", "대조 기준 (D1)", "D1 상태", "D1 상세"]) {
      expect(prompt).not.toContain(leaked);
    }
    // 새 체계 문구가 들어간다.
    expect(prompt).toContain("### 결정 지점·업무 규칙 기반 구현 순서");
    expect(prompt).toContain("### 업무 규칙 검증");
    expect(prompt).toContain("확정 규칙별 처리 결과");
  });

  it("D4 확정 상태명은 범용 규칙 충돌 검출의 기준이 된다", () => {
    const stateNames = confirmedStateNames(resolveDecisionPoints(confirmedDiagnosis()));
    expect(stateNames).toEqual(["정상", "오류(확정)", "확인 필요"]);
  });
});
