import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decisionPanelLabel } from "@/lib/ax/rule-questions";
import { buildAllInOnePrompt } from "@/lib/ax/guide";
import { diagnosisFixture, planFixture } from "./fixtures/ax";
import type { AxDiagnosis, GenericRule } from "@/lib/ax/types";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
// 통합 섹션: 기존 D 섹션과 범용 섹션이 AxUnifiedRules.tsx 하나로 합쳐졌다.
const component = () => read("../src/components/ax/AxUnifiedRules.tsx");
const css = () => read("../src/components/ax/ax.css");

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

describe("AX 레퍼런스 동일화 — 업무 규칙 확인 표시", () => {
  it("진행률은 표시된 모든 카드 기준이며 0건은 충분한 진단과 정보 부족을 구분한다", () => {
    expect(component()).toContain("unifiedRuleProgress(drafts)");
    // 0건은 분수가 아니라 완료 아님으로 표시한다 (0건 ≠ 전부 확정).
    expect(component()).toContain("확인할 규칙 없음");
    expect(component()).toContain('"진단 정보 부족"');
    expect(component()).toContain("규칙 필요 여부를 판단하지 못했습니다");
    expect(component()).toContain("규칙 검토 여부와 구현 가능 여부는 별도로 확인하세요");
    expect(component()).not.toContain("/7 확인 완료");
  });

  it("자동 후보만 제안으로 표시하고 직접 추가의 신규 표시와 안정 후보 키를 유지한다", () => {
    expect(component()).toContain('item.origin === "candidate" ? "제안" : "신규"');
    expect(component()).toContain('ax-decision-no ax-decision-no-new">신규</span>');
    expect(component()).toContain("rule.candidateKey ?? rule.provenance ?? rule.name");
    expect(component()).toContain("item.displayTitle ?? display.title");
    expect(component()).toContain("item.displayQuestion ?? display.question");
  });

  it("저장 버튼은 통합 영역 우측 하단 단일 '저장'이다", () => {
    expect(component()).not.toContain("변경사항 저장");
    expect(component()).not.toContain("업무 처리 예시 저장");
    expect(component().match(/>저장<\/Button>/g)).toHaveLength(1);
    expect(component()).toContain("업무 규칙을 저장했습니다");
    expect(component()).not.toContain("결정 지점을 저장했습니다.");
    expect(component()).not.toContain("범용 업무 규칙을 저장했습니다.");
  });

  it("업무 규칙 카드의 좌측 굵은 파란 강조선이 없고 그림자가 없다", () => {
    expect(css()).not.toContain("border-left: 4px solid var(--primary)");
    expect(css()).toContain(".ax-decision { border-left: 1.5px solid var(--border); box-shadow: none; }");
  });

  it("아코디언은 기본 모두 접힘이고 한 번에 한 항목만 펼치며 펼친 행은 레퍼런스 톤(중립 테두리)으로 표시된다", () => {
    expect(component()).toContain("const [openKey, setOpenKey] = useState<string | null>(null);");
    expect(component()).toContain("setOpenKey(isOpen ? null :");
    expect(component()).toContain('className={`ax-decision-row${isOpen ? " is-open" : ""}`}');
    expect(css()).toContain(".ax-decision-row.is-open { background: var(--card); border-color: var(--border); }");
  });

  it("업무 규칙 저장 영역은 버튼을 우측으로 보내고 펼침 상세 입력창은 레퍼런스 톤 높이·패딩·카운터를 쓴다", () => {
    expect(css()).toContain(".ax-decision-save { display: flex; align-items: center; justify-content: flex-end;");
    expect(css()).toContain(".ax-decision-panel textarea { min-height: 96px; padding: 10px 12px; }");
    expect(component()).toContain("DECISION_DETAIL_MAX_LENGTH = 2000");
    expect(component()).toContain("maxLength={DECISION_DETAIL_MAX_LENGTH}");
    expect(component()).toContain("ax-decision-counter");
    expect(css()).toContain(".ax-decision-counter { margin-left: auto;");
  });

  it("범용 규칙 편집 UI에 예시 UI 잔재가 없다 (별도 범용 섹션은 통합 섹션으로 대체됨)", () => {
    expect(component()).not.toContain("ax-example-");
    expect(css()).not.toContain(".ax-example-");
    expect(component()).not.toContain("+ 예시 추가");
  });

  it("패널 라벨은 D번호 없는 카드별 기준이며 예시 필드 문구는 남지 않는다", () => {
    expect(decisionPanelLabel("D1", "상태")).toBe("상태");
    expect((["D1", "D2", "D3", "D4", "D5", "D6", "D7"] as const).map(id => decisionPanelLabel(id, "상세"))).toEqual([
      "대조 기준", "중복 처리 기준", "예외 처리 기준", "상태 구분 기준", "판단 불가 처리 기준", "빈 입력 처리 기준", "계산 기준",
    ]);
    expect(component()).not.toContain("업무 규칙 확인 필요");
    expect(component()).not.toContain("예상 결과 상태");
  });

  it("화면 표시 변경 후에도 확정 규칙과 검토 대상 분리가 실제 지시문에서 유지된다", () => {
    const diagnosis = confirmedDiagnosis();
    const rules = genericRules();
    const snapshot = structuredClone({ diagnosis, rules });
    const options = { diagnosis, taskName: "테스트 업무", context: "", genericRules: rules };
    const full = buildAllInOnePrompt(planFixture, "codex", options);
    expect(full).toBe(buildAllInOnePrompt(planFixture, "claude", options));
    for (const point of diagnosis.decisionPoints!.filter(point => point.status === "확정" && point.id !== "D4")) {
      expect(full).toContain(point.detail);
    }
    expect(full).toContain("D4 결과 상태 — 확정: 정상 · 오류(확정) · 확인 필요");
    expect(full).toContain("R1 월말 마감 이후 주문 이월 (처리·판단 기준) — 확정");
    expect(full).toContain("[관련 단계: 월말 집계] [근거: 매뉴얼 3장]");
    expect(full).not.toContain(rules[1].detail);
    const bareOptions = { diagnosis: diagnosisFixture, taskName: "테스트 업무", context: "", genericRules: [] };
    const bare = buildAllInOnePrompt(planFixture, "codex", bareOptions);
    expect(bare).toBe(buildAllInOnePrompt(planFixture, "claude", bareOptions));
    for (const id of ["D3", "D4", "D5", "D6"]) expect(bare).toMatch(new RegExp(`${id} [^\\n]+ — 미확정`, "u"));
    for (const id of ["D1", "D2", "D7"]) expect(bare).not.toMatch(new RegExp(`${id} [^\\n]+ — 미확정`, "u"));
    expect({ diagnosis, rules }).toEqual(snapshot);
  });
});
