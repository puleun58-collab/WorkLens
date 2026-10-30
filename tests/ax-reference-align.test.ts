import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decisionPanelLabel } from "@/components/ax/AxDecisionExamples";
import { buildAllInOnePrompt } from "@/lib/ax/guide";
import { diagnosisFixture, planFixture } from "./fixtures/ax";
import type { AxDiagnosis, ExampleResult } from "@/lib/ax/types";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const component = () => read("../src/components/ax/AxDecisionExamples.tsx");
const css = () => read("../src/components/ax/ax.css");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

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

describe("AX 레퍼런스 동일화 — 결정 지점·예시 표시", () => {
  it("진행률 문구는 공백 없는 'N/7 완료' 형식이다", () => {
    expect(component()).toContain("{confirmedCount}/7 완료");
    expect(component()).not.toContain(" / 7 확인 완료");
    expect(component()).not.toContain("확인 완료</strong>");
  });

  it("저장 버튼은 두 섹션 모두 우측 하단 단일 '저장'이다", () => {
    expect(component()).not.toContain("변경사항 저장");
    expect(component()).not.toContain("업무 처리 예시 저장");
    expect(component().match(/>저장<\/Button>/g)).toHaveLength(2);
  });

  it("결정 지점 카드의 좌측 굵은 파란 강조선이 없고 그림자가 없다", () => {
    expect(css()).not.toContain("border-left: 4px solid var(--primary)");
    expect(css()).toContain(".ax-decision, .ax-examples { border-left: 1.5px solid var(--border); box-shadow: none; }");
  });

  it("아코디언은 기본 모두 접힘이고 한 번에 한 항목만 펼치며 펼친 행이 은은하게 강조된다", () => {
    expect(component()).toContain("const [openId, setOpenId] = useState<string | null>(null);");
    expect(component()).toContain("onClick={() => setOpenId(isOpen ? null : point.id)}");
    expect(component()).toContain('className={`ax-decision-row${isOpen ? " is-open" : ""}`}');
    expect(css()).toContain(".ax-decision-row.is-open");
  });

  it("결정 지점 저장 영역은 버튼을 우측으로 보내고 펼침 상세 입력창은 레퍼런스 톤 높이·패딩을 쓴다", () => {
    expect(css()).toContain(".ax-decision-save { display: flex; align-items: center; justify-content: flex-end;");
    expect(css()).toContain(".ax-decision-panel textarea { min-height: 96px; padding: 10px 12px; }");
    expect(component()).toContain("<Textarea rows={4} maxLength={2000}");
  });

  it("예시 빈 상태는 간결하고 가운데 정렬되며 헤더·추가 버튼 문구는 유지된다", () => {
    expect(component()).toContain("예시가 없습니다. 새 예시를 추가하세요.");
    expect(component()).toContain("ax-example-empty");
    expect(css()).toContain(".ax-example-empty { text-align: center; padding: 28px 16px;");
    expect(component()).toContain("+ 예시 추가");
    expect(component()).toContain("+ 새 예시");
  });

  it("필수 여부 미확정 안내는 3가지 정보를 모두 남긴다", () => {
    const src = component();
    // ① 필수 여부 미확정 ② 결정 지점 확정 결과에 따라 달라짐 ③ 필수 시 3건 필요
    expect(src).toContain("예시 필수 여부가 아직 정해지지 않았습니다.");
    expect(src).toContain("대조 기준 (D1)·중복 처리 (D2)·예외값 처리 (D3)·계산 기준 (D7)을 확정하거나 해당 없음으로 확인하면 정해지며");
    expect(src).toContain("필수 대상인 경우 확정 {EXAMPLE_CONFIRMED_MINIMUM}건이 필요합니다.");
  });

  it("#359 기준선 문구는 되돌려지지 않는다", () => {
    expect(decisionPanelLabel("D1", "상태")).toBe("대조 기준 (D1) 상태");
    expect(decisionPanelLabel("D1", "상세")).toBe("대조 기준 (D1) 상세");
    expect(component()).toContain("업무 규칙 확인 필요");
    expect(component()).toContain("예상 결과 상태");
  });

  it("01~04 지시문은 변경 전 해시와 바이트 동일하다 (Codex·Claude)", () => {
    for (const agent of ["codex", "claude"] as const) {
      const full = buildAllInOnePrompt(planFixture, agent, { diagnosis: confirmedDiagnosis(), taskName: "테스트 업무", context: "", exampleResults: examples() });
      const bare = buildAllInOnePrompt(planFixture, agent, { diagnosis: diagnosisFixture, taskName: "테스트 업무", context: "", exampleResults: [] });
      expect(sha(full)).toBe("84bb2c81a68cf73bde08cbafaabc1a7a911376a2d2e6e921efb2ea8d593e72d9");
      expect(sha(bare)).toBe("5b7a8f3792ed52a62bacfe6606974a03f8b1f8542ff6c0ca2a89d7fccc338f59");
    }
  });
});
