import { describe, expect, it } from "vitest";
import { checkPromptRuleDelivery, implementationDemandText, type PromptDeliveryInput } from "@/lib/ax/prompt-delivery";
import { checkAllInOnePromptDelivery } from "@/lib/ax/guide";
import { diagnosisFixture, planFixture } from "./fixtures/ax";
import type { AxDiagnosis, GenericRule } from "@/lib/ax/types";

const confirmed = (overrides: Partial<GenericRule> = {}): GenericRule => ({
  id: "R1", name: "월말 마감 이후 주문 이월", category: "처리·판단 기준",
  detail: "마감일 이후 접수 주문은 다음 달 집계 대상에 포함하지 않는다.",
  step: "월말 집계", source: "매뉴얼 3장", applicability: "적용", status: "확정", ...overrides,
});
const pending = (overrides: Partial<GenericRule> = {}): GenericRule => ({
  id: "R2", name: "환불 건 별도 집계", category: "출력·완료 기준",
  detail: "환불 건은 정상 집계에서 제외하고 별도 목록으로 보고한다.",
  applicability: "적용", status: "미확정", ...overrides,
});
const input = (overrides: Partial<PromptDeliveryInput> = {}): PromptDeliveryInput => ({
  confirmed: [], pending: [], applicabilityPending: [], notApplicable: [],
  hitlDeferredNames: [], hitlExcludedNames: [], ...overrides,
});
const kinds = (report: ReturnType<typeof checkPromptRuleDelivery>) => report.findings.map(f => f.kind);

/** 구현 요구 섹션(구현 목표·구현 범위·기능별 요구사항)만으로 만든 본문. */
const demandPrompt = (body: string) =>
  `## 1. 구현 목표\n\n${body}\n\n## 2. 구현 범위\n\n| 업무 단계 | 처리 구분 | 확인 사항 |\n| --- | --- | --- |\n| 월말 집계 | 구현 | 확인된 처리 기준 |\n\n## 3. 기능별 요구사항\n\n### 기능 1. 월말 집계\n\n- 입력: 월말 집계 자료\n\n## 4. 결과 보고\n\n- 완료 보고`;

describe("P1 전달 완전성 검사 — 7종", () => {
  it("① 확정 누락: id·이름이 없으면 finding, 있으면 없음", () => {
    expect(kinds(checkPromptRuleDelivery(demandPrompt("핵심 기능: 월말 집계"), input({ confirmed: [confirmed()] })))).toContain("confirmed-missing");
    const ok = demandPrompt("- R1 월말 마감 이후 주문 이월 (처리·판단 기준) — 확정: 마감일 이후 접수 주문은 다음 달 집계 대상에 포함하지 않는다. [관련 단계: 월말 집계] [근거: 매뉴얼 3장]");
    const report = checkPromptRuleDelivery(ok, input({ confirmed: [confirmed()] }));
    expect(report.findings).toEqual([]);
    expect(report.confirmedTotal).toBe(1);
    expect(report.deliveredCount).toBe(1);
  });

  it("② 상세 누락·변형: verbatim 부재는 finding, 공백 차이만 있으면 통과", () => {
    const varied = demandPrompt("- R1 월말 마감 이후 주문 이월 (처리·판단 기준) — 확정: 마감일  이후\n접수 주문은 다음 달 집계 대상에 포함하지 않는다. [관련 단계: 월말 집계] [근거: 매뉴얼 3장]");
    expect(kinds(checkPromptRuleDelivery(varied, input({ confirmed: [confirmed()] })))).not.toContain("confirmed-detail");
    const altered = demandPrompt("- R1 월말 마감 이후 주문 이월 (처리·판단 기준) — 확정: 마감일 이후 접수 주문은 당월 집계에 포함한다. [관련 단계: 월말 집계] [근거: 매뉴얼 3장]");
    expect(kinds(checkPromptRuleDelivery(altered, input({ confirmed: [confirmed()] })))).toContain("confirmed-detail");
    const noDetail = demandPrompt("- R9 상세 없는 규칙 (처리·판단 기준) — 확정");
    expect(kinds(checkPromptRuleDelivery(noDetail, input({ confirmed: [confirmed({ id: "R9", name: "상세 없는 규칙", detail: undefined, step: undefined, source: undefined })] })))).toEqual([]);
  });

  it("③ 적용 범위 불일치: 원본에 있는 표기만 검사한다", () => {
    const missingSource = demandPrompt("- R1 월말 마감 이후 주문 이월 (처리·판단 기준) — 확정: 마감일 이후 접수 주문은 다음 달 집계 대상에 포함하지 않는다. [관련 단계: 월말 집계]");
    const report = checkPromptRuleDelivery(missingSource, input({ confirmed: [confirmed()] }));
    expect(kinds(report)).toContain("confirmed-scope");
    expect(report.findings.find(f => f.kind === "confirmed-scope")?.message).toContain("[근거: 매뉴얼 3장]");
    expect(report.deliveredCount).toBe(0);
    // linkedDecisionId가 있는 규칙은 연계 표기도 요구한다.
    const linked = confirmed({ linkedDecisionId: "D7" });
    const missingLink = demandPrompt("- R1 월말 마감 이후 주문 이월 (처리·판단 기준) — 확정: 마감일 이후 접수 주문은 다음 달 집계 대상에 포함하지 않는다. [관련 단계: 월말 집계] [근거: 매뉴얼 3장]");
    expect(kinds(checkPromptRuleDelivery(missingLink, input({ confirmed: [linked] })))).toContain("confirmed-scope");
    // 원본에 없는 표기는 요구하지 않는다 (step·source 없는 규칙).
    const bare = demandPrompt("- R1 월말 마감 이후 주문 이월 (처리·판단 기준) — 확정: 마감일 이후 접수 주문은 다음 달 집계 대상에 포함하지 않는다.");
    expect(kinds(checkPromptRuleDelivery(bare, input({ confirmed: [confirmed({ step: undefined, source: undefined })] })))).toEqual([]);
  });

  it("④ 확정 충돌: 동일 정규화명 + 상이 상세만 finding (자동 병합 없음)", () => {
    const clash = [confirmed(), confirmed({ id: "R7", detail: "마감일 이후 접수 주문은 당월 집계에 포함한다." })];
    const report = checkPromptRuleDelivery(demandPrompt(""), input({ confirmed: clash }));
    expect(kinds(report)).toContain("confirmed-conflict");
    expect(report.findings.find(f => f.kind === "confirmed-conflict")?.message).toContain("확인");
    const sameDetail = [confirmed(), confirmed({ id: "R7" })];
    expect(kinds(checkPromptRuleDelivery(demandPrompt(""), input({ confirmed: sameDetail })))).not.toContain("confirmed-conflict");
  });

  it("⑤ 미확정 확정 처리: 미확정·적용 여부 미확정 규칙의 `— 확정` 행만 finding", () => {
    const asConfirmed = demandPrompt("- R2 환불 건 별도 집계 (출력·완료 기준) — 확정: 환불 건은 정상 집계에서 제외하고 별도 목록으로 보고한다.");
    expect(kinds(checkPromptRuleDelivery(asConfirmed, input({ pending: [pending()] })))).toContain("pending-as-confirmed");
    const asPending = demandPrompt("- R2 환불 건 별도 집계 (출력·완료 기준) — 미확정 (임의로 정하지 않음)");
    expect(kinds(checkPromptRuleDelivery(asPending, input({ pending: [pending()] })))).toEqual([]);
    const appPending = pending({ id: "R3", name: "적용 여부 확인 필요 규칙", applicability: "적용 여부 미확정" });
    const appAsConfirmed = demandPrompt("- R3 적용 여부 확인 필요 규칙 (예외·확인 기준) — 확정: 확인이 필요합니다.");
    expect(kinds(checkPromptRuleDelivery(appAsConfirmed, input({ applicabilityPending: [appPending] })))).toContain("pending-as-confirmed");
    const appAsPending = demandPrompt("- R3 적용 여부 확인 필요 규칙 (예외·확인 기준) — 적용 여부 확인 필요 (임의로 적용·해당 없음 처리하지 않음)");
    expect(kinds(checkPromptRuleDelivery(appAsPending, input({ applicabilityPending: [appPending] })))).toEqual([]);
  });

  it("⑥ 해당 없음 구현 요구: 구현 요구 섹션 등장은 finding, 합법적 귀속처는 아님", () => {
    const na = confirmed({ id: "R8", name: "구버전 수기 대장 규칙", applicability: "해당 없음", status: "미확정" });
    const demanded = `## 1. 구현 목표\n\n핵심 기능: 월말 집계\n\n## 3. 기능별 요구사항\n\n### 기능 1. 월말 집계\n\n- 처리: 구버전 수기 대장 규칙을 적용한다.\n\n## 4. 결과 보고\n\n- 보고`;
    expect(kinds(checkPromptRuleDelivery(demanded, input({ notApplicable: [na] })))).toContain("not-applicable-demanded");
    const legitimate = `## 2. 구현 범위\n\n### 현재 자동화 제외\n\n- 구버전 수기 대장 규칙\n\n## 3. 기능별 요구사항\n\n### 기능 1. 월말 집계\n\n- 입력: 월말 집계 자료`;
    expect(kinds(checkPromptRuleDelivery(legitimate, input({ notApplicable: [na] })))).toEqual([]);
    expect(kinds(checkPromptRuleDelivery(demandPrompt("핵심 기능: 월말 집계"), input({ notApplicable: [na] })))).toEqual([]);
  });

  it("⑦ HITL 보류·제외 재등장: 구현 요구 섹션 등장은 finding, 합법적 귀속처는 아님", () => {
    const demanded = `## 2. 구현 범위\n\n| 업무 단계 | 처리 구분 | 확인 사항 |\n| --- | --- | --- |\n| 보류된 외부 연동 | 구현 | 확인된 처리 기준 |`;
    expect(kinds(checkPromptRuleDelivery(demanded, input({ hitlDeferredNames: ["보류된 외부 연동"] })))).toContain("hitl-reappeared");
    const excludedDemanded = `## 3. 기능별 요구사항\n\n### 기능 1. 제외된 구버전 이관\n\n- 처리: 제외된 구버전 이관을 구현한다.`;
    expect(kinds(checkPromptRuleDelivery(excludedDemanded, input({ hitlExcludedNames: ["제외된 구버전 이관"] })))).toContain("hitl-reappeared");
    const legitimate = `## 1. 구현 목표\n\n### 사람 검토 반영\n\n보류된 작업 (현재 구현하지 않음):\n- 보류된 외부 연동 — 보류\n\n### 현재 자동화 제외\n\n- 제외된 구버전 이관`;
    expect(kinds(checkPromptRuleDelivery(legitimate, input({ hitlDeferredNames: ["보류된 외부 연동"], hitlExcludedNames: ["제외된 구버전 이관"] })))).toEqual([]);
  });

  it("구현 요구 텍스트는 합법적 귀속처를 제외하고 서두·기능 블록은 유지한다", () => {
    const text = implementationDemandText(`## 1. 구현 목표\n\n핵심 기능: 월말 집계\n\n### 업무 규칙 (범용)\n\n- R1 규칙\n\n### 사람 검토 반영\n\n- 보류 항목\n\n## 2. 구현 범위\n\n### 현재 자동화 제외\n\n- 제외 항목\n\n## 3. 기능별 요구사항\n\n### 기능 1. 월말 집계\n\n- 처리: 실제 처리`);
    expect(text).toContain("핵심 기능: 월말 집계");
    expect(text).toContain("실제 처리");
    expect(text).not.toContain("R1 규칙");
    expect(text).not.toContain("보류 항목");
    expect(text).not.toContain("제외 항목");
  });

  it("의미적 모순 (동일명 이외)은 검출 범위가 아니다", () => {
    const rules = [confirmed(), confirmed({ id: "R5", name: "반대 의미 규칙", detail: "마감일 이후 접수 주문은 당월 집계에 포함한다." })];
    const report = checkPromptRuleDelivery(demandPrompt(""), input({ confirmed: rules }));
    expect(kinds(report)).not.toContain("confirmed-conflict");
  });
});

describe("P1 래퍼 — 실제 생성 경로", () => {
  it("표준 픽스처의 지시문은 전달 finding이 없고 본문은 buildAllInOnePrompt와 동일하다", async () => {
    const { buildAllInOnePrompt } = await import("@/lib/ax/guide");
    const diagnosis: AxDiagnosis = {
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
    };
    const rules: GenericRule[] = [
      { id: "R1", name: "월말 마감 이후 주문 이월", category: "처리·판단 기준", detail: "마감일 이후 접수 주문은 다음 달 집계 대상에 포함하지 않는다. 마감일은 매월 말일이다.", source: "매뉴얼 3장", step: "월말 집계", applicability: "적용", status: "확정" },
      { id: "R2", name: "환불 건 별도 집계", category: "출력·완료 기준", detail: "환불 건은 정상 집계에서 제외하고 별도 목록으로 보고한다.", applicability: "적용", status: "미확정" },
      { id: "R3", name: "적용 여부 확인 필요 규칙", category: "예외·확인 기준", applicability: "적용 여부 미확정", status: "미확정" },
    ];
    const options = { diagnosis, taskName: "테스트 업무", context: "", genericRules: rules };
    const { prompt, delivery } = checkAllInOnePromptDelivery(planFixture, "codex", options);
    expect(prompt).toBe(buildAllInOnePrompt(planFixture, "codex", options));
    expect(delivery.confirmedTotal).toBe(1);
    expect(delivery.deliveredCount).toBe(1);
    expect(delivery.findings).toEqual([]);
  });
});
