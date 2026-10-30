import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decisionPanelLabel } from "@/components/ax/AxDecisionExamples";
import { buildAllInOnePrompt } from "@/lib/ax/guide";
import { diagnosisFixture, planFixture } from "./fixtures/ax";
import type { AxDiagnosis, GenericRule } from "@/lib/ax/types";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const component = () => read("../src/components/ax/AxDecisionExamples.tsx");
const genericComponent = () => read("../src/components/ax/AxGenericRules.tsx");
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

const genericRules = (): GenericRule[] => [
  { id: "R1", name: "월말 마감 이후 주문 이월", category: "처리·판단 기준", detail: "마감일 이후 접수 주문은 다음 달 집계 대상에 포함하지 않는다. 마감일은 매월 말일이다.", source: "매뉴얼 3장", step: "월말 집계", applicability: "적용", status: "확정" },
  { id: "R2", name: "환불 건 별도 집계", category: "출력·완료 기준", detail: "환불 건은 정상 집계에서 제외하고 별도 목록으로 보고한다.", applicability: "적용", status: "미확정" },
  { id: "R3", name: "적용 여부 확인 필요 규칙", category: "예외·확인 기준", applicability: "적용 여부 미확정", status: "미확정" },
];

describe("AX 레퍼런스 동일화 — 업무 규칙 확인 표시", () => {
  it("진행률 문구는 적용 대상 분모 기준 'N/M 확인 완료' 형식이고 적용 여부 건수를 별도로 표시한다", () => {
    expect(component()).toContain("{progress.done}/{progress.total} 확인 완료");
    expect(component()).toContain("적용 여부 확인 ${progress.applicabilityPending}건");
    expect(component()).not.toContain("{confirmedCount}/7 확인 완료");
    expect(component()).not.toContain("/7 확인 완료");
  });

  it("저장 버튼은 각 섹션 우측 하단 단일 '저장'이다", () => {
    expect(component()).not.toContain("변경사항 저장");
    expect(component()).not.toContain("업무 처리 예시 저장");
    expect(component().match(/>저장<\/Button>/g)).toHaveLength(1);
    expect(genericComponent().match(/>저장<\/Button>/g)).toHaveLength(1);
  });

  it("업무 규칙 카드의 좌측 굵은 파란 강조선이 없고 그림자가 없다", () => {
    expect(css()).not.toContain("border-left: 4px solid var(--primary)");
    expect(css()).toContain(".ax-decision { border-left: 1.5px solid var(--border); box-shadow: none; }");
  });

  it("아코디언은 기본 모두 접힘이고 한 번에 한 항목만 펼치며 펼친 행은 레퍼런스 톤(중립 테두리)으로 표시된다", () => {
    expect(component()).toContain("const [openId, setOpenId] = useState<string | null>(null);");
    expect(component()).toContain("onClick={() => setOpenId(isOpen ? null : point.id)}");
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

  it("범용 규칙 편집 UI는 2열 그리드·모바일 1열이며 예시 UI 잔재가 없다", () => {
    expect(genericComponent()).toContain("+ 규칙 추가");
    expect(genericComponent()).toContain("등록된 범용 규칙이 없습니다.");
    expect(genericComponent()).toContain("ax-generic-panel");
    expect(css()).toContain(".ax-generic-panel { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);");
    expect(css()).toContain(".ax-generic-panel { grid-template-columns: minmax(0, 1fr); }");
    expect(component()).not.toContain("ax-example-");
    expect(css()).not.toContain(".ax-example-");
    expect(component()).not.toContain("+ 예시 추가");
  });

  it("지시문 §10.5에 따라 패널 라벨은 D번호 없는 상태/대조 기준이며 예시 필드 문구는 남지 않는다", () => {
    expect(decisionPanelLabel("D1", "상태")).toBe("상태");
    expect(decisionPanelLabel("D1", "상세")).toBe("대조 기준");
    expect(component()).not.toContain("업무 규칙 확인 필요");
    expect(component()).not.toContain("예상 결과 상태");
  });

  it("01~04 지시문은 범용 규칙 전환 후 기준 해시와 일치한다 (Codex·Claude, 의도된 변경)", () => {
    // P2 완료 불인정 기준 블록 추가 (2026-10-31, 의도된 변경): display-wording과
    // 동일한 픽스처 쌍이므로 full·bare 해시는 해당 테스트의 BASELINE과 같다.
    for (const agent of ["codex", "claude"] as const) {
      const full = buildAllInOnePrompt(planFixture, agent, { diagnosis: confirmedDiagnosis(), taskName: "테스트 업무", context: "", genericRules: genericRules() });
      const bare = buildAllInOnePrompt(planFixture, agent, { diagnosis: diagnosisFixture, taskName: "테스트 업무", context: "", genericRules: [] });
      expect(sha(full)).toBe("8aaffe77b9bdfca48a9e92cc1ef14d560ed307dd4eb7d431cc0751b86d6fd89e");
      expect(sha(bare)).toBe("c7a8ad3c5513b82e70b17de3bd99f5b7ab81261572d961e409c160a40733d67e");
    }
  });
});
