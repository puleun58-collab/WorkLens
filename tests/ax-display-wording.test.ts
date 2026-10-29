import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DECISION_DISPLAY, decisionPanelLabel } from "@/components/ax/AxDecisionExamples";
import { DECISION_POINT_DEFS, confirmedStateNames, resolveDecisionPoints } from "@/lib/ax/decision-points";
import { partitionExamples } from "@/lib/ax/example-results";
import { buildAllInOnePrompt } from "@/lib/ax/guide";
import { diagnosisFixture, planFixture } from "./fixtures/ax";
import type { AxDiagnosis, ExampleResult } from "@/lib/ax/types";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** 표시 문구 변경 전(베이스 9f3995f) 기준 해시. 지시문 생성 경로를 건드리지 않았음을 고정한다. */
const BASELINE = {
  codex: { full: "84bb2c81a68cf73bde08cbafaabc1a7a911376a2d2e6e921efb2ea8d593e72d9", bare: "5b7a8f3792ed52a62bacfe6606974a03f8b1f8542ff6c0ca2a89d7fccc338f59" },
  claude: { full: "84bb2c81a68cf73bde08cbafaabc1a7a911376a2d2e6e921efb2ea8d593e72d9", bare: "5b7a8f3792ed52a62bacfe6606974a03f8b1f8542ff6c0ca2a89d7fccc338f59" },
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

const examples = (): ExampleResult[] => [
  { input: "운송장 WB-001, 중량 10kg", expectedState: "정상" },
  { input: "운송장 WB-002, 운송장번호 중복 2건", expectedState: "오류(확정)" },
  { input: "운송장 WB-003, 도착지 빈칸", expectedState: "확인 필요" },
];

describe("AX 표시 문구 개선 — 표시 전용 라벨", () => {
  it("결정 지점 표시 제목은 항목명 + (D번호) 기준을 따른다", () => {
    expect(Object.entries(DECISION_DISPLAY).map(([id, item]) => `${item.title} (${id})`)).toEqual([
      "대조 기준 (D1)", "중복 처리 (D2)", "예외값 처리 (D3)", "결과 상태 (D4)",
      "판단 불가 처리 (D5)", "빈 파일 처리 (D6)", "계산 기준 (D7)",
    ]);
  });

  it("패널 라벨은 항목명 + (D번호) + 항목명을 쓴다", () => {
    expect(decisionPanelLabel("D1", "상태")).toBe("대조 기준 (D1) 상태");
    expect(decisionPanelLabel("D1", "상세")).toBe("대조 기준 (D1) 상세");
    expect(decisionPanelLabel("D4", "상세")).toBe("결과 상태 (D4) 상세");
    expect(decisionPanelLabel("D5", "상세", true)).toBe("판단 불가 처리 (D5) 상세 (결과 상태 (D4) 중 하나)");
    expect(decisionPanelLabel("D5", "상세")).toBe("판단 불가 처리 (D5) 상세");
  });

  it("지시문 생성용 DEFS 제목은 표시 변경과 무관하게 기존 값을 유지한다", () => {
    expect(DECISION_POINT_DEFS.map(def => `${def.id} ${def.title}`)).toEqual([
      "D1 기준과 매칭", "D2 중복", "D3 특이값", "D4 결과 상태", "D5 판단 불가", "D6 빈 입력", "D7 계산 기준",
    ]);
    expect(DECISION_POINT_DEFS.find(def => def.id === "D5")?.detailHint).toContain("결과 상태 (D4) 중 하나");
  });
});

describe("AX 표시 문구 개선 — 01~04 지시문 불변성", () => {
  it("D1~D7 확정 + 예시 3건 픽스처의 지시문이 변경 전 해시와 바이트 동일하다 (Codex·Claude)", () => {
    for (const agent of ["codex", "claude"] as const) {
      const full = buildAllInOnePrompt(planFixture, agent, { diagnosis: confirmedDiagnosis(), taskName: "테스트 업무", context: "", exampleResults: examples() });
      const bare = buildAllInOnePrompt(planFixture, agent, { diagnosis: diagnosisFixture, taskName: "테스트 업무", context: "", exampleResults: [] });
      expect(sha(full)).toBe(BASELINE[agent].full);
      expect(sha(bare)).toBe(BASELINE[agent].bare);
    }
  });

  it("지시문에는 기존 DEFS 제목이 남고 표시 전용 문구는 들어가지 않는다", () => {
    const prompt = buildAllInOnePrompt(planFixture, "codex", { diagnosis: confirmedDiagnosis(), taskName: "테스트 업무", context: "", exampleResults: examples() });
    expect(prompt).toContain("D1 기준과 매칭 — 확정");
    expect(prompt).toContain("D4 결과 상태 — 확정: 정상 · 오류(확정) · 확인 필요");
    expect(prompt).toContain("D5 판단 불가 — 확정: 확인 필요");
    for (const leaked of ["대조 기준 (D1)", "예상 결과 상태", "업무 규칙 확인 필요", "결과 상태 (D4) 목록에 없습니다"]) {
      expect(prompt).not.toContain(leaked);
    }
  });
});

describe("AX 표시 문구 개선 — 예시 결과 상태 선택지", () => {
  it("선택지 표시·저장값 모두 D4 확정 상태명 그 자체이다 (D번호 인코딩 없음)", () => {
    const stateNames = confirmedStateNames(resolveDecisionPoints(confirmedDiagnosis()));
    expect(stateNames).toEqual(["정상", "오류(확정)", "확인 필요"]);
    const { valid, invalid } = partitionExamples(examples(), stateNames);
    expect(valid.map(item => item.expectedState)).toEqual(["정상", "오류(확정)", "확인 필요"]);
    expect(invalid).toEqual([]);
    // 목록 외 값은 확정 예시에서 제외된다 (저장값 형식 변경 없음).
    const { valid: kept } = partitionExamples([{ input: "x", expectedState: "D4" }], stateNames);
    expect(kept).toEqual([]);
  });
});
