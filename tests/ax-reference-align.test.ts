import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt } from "@/lib/ax/guide";
import { diagnosisFixture, planFixture } from "./fixtures/ax";
import type { AxDiagnosis, GenericRule } from "@/lib/ax/types";


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
