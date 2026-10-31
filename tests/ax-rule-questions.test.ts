import { describe, expect, it } from "vitest";
import { DECISION_DISPLAY, decisionPanelLabel, deriveUnifiedRules, draftStateNames, hasDerivationSignals, unifiedRuleProgress, unifiedSavePayloads, type UnifiedDecisionDraft, type UnifiedGenericDraft, type UnifiedRuleDraft } from "@/lib/ax/rule-questions";
import { ruleProgress } from "@/lib/ax/generic-rules";
import { resolveDecisionPoints } from "@/lib/ax/decision-points";
import { diagnosisFixture } from "./fixtures/ax";
import type { AxDiagnosis, GenericRule } from "@/lib/ax/types";

const diagnosis = (patch: Partial<AxDiagnosis> = {}): AxDiagnosis => ({
  ...structuredClone(diagnosisFixture),
  ...patch,
});

const dIds = (items: UnifiedRuleDraft[]): string[] =>
  items.filter(item => item.kind === "decision").map(item => item.id);
const gNames = (items: UnifiedRuleDraft[]): string[] =>
  items.filter(item => item.kind === "generic").map(item => item.name);
const candidateDIds = (items: UnifiedRuleDraft[]): string[] =>
  items.filter((item): item is UnifiedDecisionDraft => item.kind === "decision" && item.origin === "candidate").map(item => item.id);

describe("AX 통합 규칙 도출 — 표시 문구 (기존 파일에서 verbatim 이동)", () => {
  it("D 표시 제목·질문이 기존 값과 동일하다", () => {
    expect(DECISION_DISPLAY).toEqual({
      D1: { title: "대조 기준", question: "어떤 자료와 항목을 기준으로 비교하나요?" },
      D2: { title: "중복 처리", question: "동일한 항목이 여러 번 나타나면 어떻게 처리하나요?" },
      D3: { title: "예외값 처리", question: "빈칸·음수·0 등은 어떻게 처리하나요?" },
      D4: { title: "결과 상태", question: "처리 결과를 어떤 상태로 구분하나요?" },
      D5: { title: "판단 불가 처리", question: "판정할 수 없는 데이터는 어떻게 표시하나요?" },
      D6: { title: "빈 파일 처리", question: "데이터가 없을 때 어떻게 처리하나요?" },
      D7: { title: "계산 기준", question: "합계·반올림·단위의 기준은 무엇인가요?" },
    });
  });

  it("패널 라벨에 D번호를 반복하지 않는다", () => {
    expect(decisionPanelLabel("D1", "상태")).toBe("상태");
    expect(decisionPanelLabel("D1", "상세")).toBe("대조 기준");
    expect(decisionPanelLabel("D5", "상세")).toBe("대조 기준");
  });
});

describe("AX 통합 규칙 도출 — 기본 진단(픽스처)", () => {
  it("픽스처 진단에서는 D3·D4·D5·D6 후보만 도출되고 D1·D2·D7은 강제 생성되지 않는다", () => {
    const items = deriveUnifiedRules(diagnosis());
    expect(dIds(items)).toEqual(["D3", "D4", "D5", "D6"]);
    expect(candidateDIds(items)).toEqual(["D3", "D4", "D5", "D6"]);
    // 후보는 미확정 상태로만 도출된다 (자동 확정 없음).
    expect(items.filter(item => item.kind === "decision").every(item => item.status === "미확정")).toBe(true);
    expect(items.filter(item => item.kind === "decision").every(item => item.detail === "")).toBe(true);
  });

  it("픽스처 진단에서는 기술적 확인 항목과 사람 판단 항목이 범용 후보가 된다", () => {
    const items = deriveUnifiedRules(diagnosis());
    expect(gNames(items)).toEqual(["시스템 접근", "최종 승인"]);
    const [check, human] = items.filter(item => item.kind === "generic");
    expect(check.category).toBe("예외·확인 기준");
    expect(check.applicability).toBe("적용 여부 미확정");
    expect(check.sourceLabel).toBe("진단에서 도출");
    expect(check.provenance).toContain("시스템 접근");
    expect(human.category).toBe("권한·검토 기준");
  });

  it("픽스처 진단의 완료 현황은 0/4 + 적용 여부 확인 2건이다 (고정 7 분모 아님)", () => {
    expect(unifiedRuleProgress(deriveUnifiedRules(diagnosis()))).toEqual({ done: 0, total: 4, applicabilityPending: 2 });
  });
});

describe("AX 통합 규칙 도출 — 구조적 신호", () => {
  it("입력·시스템이 2개 이상일 때만 D1 후보가 도출된다", () => {
    const single = diagnosis();
    expect(dIds(deriveUnifiedRules(single))).not.toContain("D1");
    const multi = diagnosis({ asIs: { ...diagnosisFixture.asIs, inputs: ["주문 표", "배송 표"] } });
    expect(dIds(deriveUnifiedRules(multi))).toContain("D1");
  });

  it("입력에 정규화 후 완전 중복이 있을 때만 D2 후보가 도출된다 (유사 문자열은 아님)", () => {
    const dup = diagnosis({ asIs: { ...diagnosisFixture.asIs, inputs: ["주문 표", "  주문   표 "] } });
    expect(dIds(deriveUnifiedRules(dup))).toContain("D2");
    const similar = diagnosis({ asIs: { ...diagnosisFixture.asIs, inputs: ["주문 표", "주문 표(수정)"] } });
    expect(dIds(deriveUnifiedRules(similar))).not.toContain("D2");
  });

  it("D5는 D4 신호가 있고 게이트가 go가 아닐 때 도출되고, go+충분+확인 항목 없음이면 도출되지 않는다", () => {
    expect(dIds(deriveUnifiedRules(diagnosis()))).toContain("D5");
    const clean = diagnosis({
      decisionGate: { verdict: "go", reasons: [] },
      informationSufficiency: "sufficient",
      technicalChecks: [],
    });
    expect(dIds(deriveUnifiedRules(clean))).not.toContain("D5");
  });

  it("기술적 확인 항목이 결과 상태를 지목하면 D4로 흡수되어 범용 후보가 중복 생성되지 않는다", () => {
    const items = deriveUnifiedRules(diagnosis({
      technicalChecks: [
        { topic: "시스템 접근", status: "확인 필요", note: "" },
        { topic: "D4 결과 상태", status: "확인 필요", note: "" },
      ],
      asIs: { ...diagnosisFixture.asIs, humanDecisions: [] },
    }));
    expect(gNames(items)).toEqual(["시스템 접근"]);
    expect(dIds(items)).toContain("D4");
  });

  it("기술적 확인 항목이 계산 기준을 지목하면 D7 후보가 도출된다 (그 외 D7 자동 신호는 없다)", () => {
    const items = deriveUnifiedRules(diagnosis({
      technicalChecks: [{ topic: "계산 기준 확인", status: "확인 필요", note: "" }],
    }));
    expect(dIds(items)).toContain("D7");
  });

  it("추가 질문은 최대 3건까지 AI 추천 후보가 되고, 4번째는 버려진다", () => {
    const items = deriveUnifiedRules(diagnosis({
      followUpQuestions: ["질문1", "질문2", "질문3", "질문4"],
      technicalChecks: [],
      asIs: { ...diagnosisFixture.asIs, humanDecisions: [] },
    }));
    const ai = items.filter((item): item is UnifiedGenericDraft => item.kind === "generic" && item.sourceLabel === "AI 추천");
    expect(ai.map(item => item.name)).toEqual(["질문1", "질문2", "질문3"]);
  });

  it("출력은 있으나 성공 기준이 없으면 완료 기준 정리 후보 1건이 도출된다", () => {
    const items = deriveUnifiedRules(diagnosis({
      poc: { ...diagnosisFixture.poc, success: [] },
    }));
    expect(gNames(items)).toContain("완료 기준 정리");
    expect(gNames(deriveUnifiedRules(diagnosis()))).not.toContain("완료 기준 정리");
  });

  it("긴 추가 질문은 이름 상한(120자)으로 자르고 전문을 상세에 두어 손실을 막는다", () => {
    const long = `질문${"가".repeat(200)}`;
    const items = deriveUnifiedRules(diagnosis({ followUpQuestions: [long] }));
    const candidate = items.find((item): item is UnifiedGenericDraft => item.kind === "generic" && item.sourceLabel === "AI 추천")!;
    expect(candidate.name.length).toBeLessThanOrEqual(120);
    expect(candidate.detail).toBe(long);
  });
});

describe("AX 통합 규칙 도출 — 저장 행 보존·중복 방지", () => {
  it("저장된 D 행이 있으면 후보를 만들지 않고 저장 상태·상세를 그대로 표시한다", () => {
    const items = deriveUnifiedRules(diagnosis({
      decisionPoints: [
        { id: "D3", status: "확정", detail: "빈칸은 확인 필요" },
        { id: "D4", status: "해당 없음" },
      ],
    }));
    const d3 = items.find(item => item.kind === "decision" && item.id === "D3")!;
    expect(d3.origin).toBe("stored");
    expect(d3.status).toBe("확정");
    expect(d3.detail).toBe("빈칸은 확인 필요");
    expect(candidateDIds(items)).not.toContain("D3");
    expect(candidateDIds(items)).not.toContain("D4");
    const d4 = items.find(item => item.kind === "decision" && item.id === "D4")!;
    expect(d4.status).toBe("해당 없음");
  });

  it("저장된 범용 규칙과 정규화 이름이 완전 일치하는 후보는 생성하지 않는다 (유사 이름은 별개)", () => {
    const stored: GenericRule[] = [{
      id: "R1", name: "시스템 접근", category: "예외·확인 기준",
      applicability: "적용", status: "확정",
    }];
    const items = deriveUnifiedRules(diagnosis(), stored);
    expect(gNames(items)).toEqual(["시스템 접근", "최종 승인"]);
    expect(items.filter(item => item.kind === "generic" && item.name === "시스템 접근").length).toBe(1);
    expect(items.find(item => item.kind === "generic" && item.name === "시스템 접근")!.origin).toBe("stored");
  });

  it("저장된 미확정 D 행도 표시되고, 그 detail은 화면에만 보이고 생성 경로에서는 버려진다", () => {
    const items = deriveUnifiedRules(diagnosis({
      decisionPoints: [{ id: "D3", status: "미확정", detail: "작성 중 메모" }],
    }));
    const d3 = items.find(item => item.kind === "decision" && item.id === "D3")!;
    expect(d3.origin).toBe("stored");
    expect(d3.detail).toBe("작성 중 메모");
    // 생성 경로는 기존 resolve 규칙 그대로 미확정 detail을 버린다.
    expect(resolveDecisionPoints(diagnosis({
      decisionPoints: [{ id: "D3", status: "미확정", detail: "작성 중 메모" }],
    })).find(point => point.id === "D3")!.detail).toBeUndefined();
  });

  it("신호가 전혀 없으면 빈 목록이고, 신호 존재 여부를 구분할 수 있다", () => {
    const empty = diagnosis({
      asIs: { purpose: "", trigger: "", inputs: [], steps: [], outputs: [], exceptions: [], humanDecisions: [], systems: [] },
      poc: { hypothesis: "", inScope: [], outOfScope: [], inputs: [], outputs: [], evaluation: [], success: [], failure: [] },
      technicalChecks: [],
      followUpQuestions: [],
    });
    expect(deriveUnifiedRules(empty)).toEqual([]);
    expect(hasDerivationSignals(empty)).toBe(false);
    expect(hasDerivationSignals(diagnosis())).toBe(true);
  });
});

describe("AX 통합 규칙 도출 — §11 6개 업무 유형 (구조적 필드만으로 도출, 업무명 키워드 미사용)", () => {
  // 도출 함수는 업무명을 입력으로 받지 않는다. 아래 6건은 구조적 필드 조합만 바꾸어
  // 유형별 질문 구성 타당성을 확인한다.
  const base = diagnosis();

  it("운임 정산: 다중 입력·예외·성공/실패·사람 판단 → D1·D3·D4·D5·D6 + 권한 후보", () => {
    const items = deriveUnifiedRules(diagnosis({
      asIs: { ...base.asIs, inputs: ["선적 표", "운임 단가표"], exceptions: ["CBM 누락"], humanDecisions: ["운임 확정"] },
    }));
    expect(dIds(items)).toEqual(expect.arrayContaining(["D1", "D3", "D4", "D5", "D6"]));
    expect(gNames(items)).toContain("운임 확정");
  });

  it("Excel 대조: 중복 입력 → D2 후보 포함", () => {
    const items = deriveUnifiedRules(diagnosis({
      asIs: { ...base.asIs, inputs: ["판매내역.xlsx", "판매내역.xlsx"] },
    }));
    expect(dIds(items)).toContain("D2");
  });

  it("뉴스 수집: 단일 입력·예외 없음 → D3 없음, D4·D6 있음", () => {
    const items = deriveUnifiedRules(diagnosis({
      asIs: { ...base.asIs, inputs: ["뉴스 피드"], exceptions: [], humanDecisions: [] },
      technicalChecks: [],
    }));
    expect(dIds(items)).not.toContain("D3");
    expect(dIds(items)).toEqual(expect.arrayContaining(["D4", "D6"]));
  });

  it("문서 작성: 출력 있으나 성공 기준 없음 → 완료 기준 정리 후보", () => {
    const items = deriveUnifiedRules(diagnosis({
      asIs: { ...base.asIs, humanDecisions: [] },
      technicalChecks: [],
      poc: { ...base.poc, success: [] },
    }));
    expect(gNames(items)).toContain("완료 기준 정리");
  });

  it("시설 보수: 확인 필요 기술 항목·사람 판단 → 확인 후보 + 권한 후보", () => {
    const items = deriveUnifiedRules(diagnosis({
      asIs: { ...base.asIs, humanDecisions: ["보수 승인"] },
      technicalChecks: [{ topic: "현장 접근 권한", status: "확인 필요", note: "" }],
    }));
    expect(gNames(items)).toContain("현장 접근 권한");
    expect(gNames(items)).toContain("보수 승인");
  });

  it("승인 검토: 게이트 conditional + 사람 판단 → D5 후보 + 권한 후보", () => {
    const items = deriveUnifiedRules(diagnosis({
      asIs: { ...base.asIs, humanDecisions: ["최종 결재"] },
      decisionGate: { verdict: "conditional", reasons: ["결재 확인 후 진행"] },
    }));
    expect(dIds(items)).toContain("D5");
    expect(gNames(items)).toContain("최종 결재");
  });
});

describe("AX 통합 완료 현황·저장 페이로드", () => {
  it.each(["미확정", "확정"] as const)("D3 %s 상태와 작성 중 메모를 저장하고 초안으로 복원한다", status => {
    const original = { id: "D3" as const, status, detail: "작성 중 메모" };
    const { points, rules } = unifiedSavePayloads(deriveUnifiedRules(diagnosis({ decisionPoints: [original] })), []);
    expect(points).toContainEqual(original);
    const restored = deriveUnifiedRules(diagnosis({ decisionPoints: JSON.parse(JSON.stringify(points)) }), rules);
    expect(restored.find(item => item.kind === "decision" && item.id === "D3"))
      .toEqual({ kind: "decision", ...original, origin: "stored" });
    expect(resolveDecisionPoints({ decisionPoints: points }).find(point => point.id === "D3")?.detail)
      .toBe(status === "확정" ? original.detail : undefined);
  });

  it("작성한 미확정 D 후보 메모는 저장하고 빈 미터치 후보는 저장하지 않는다", () => {
    const items: UnifiedDecisionDraft[] = [
      { kind: "decision", id: "D3", status: "미확정", detail: "작성 중 메모", origin: "candidate" },
      { kind: "decision", id: "D6", status: "미확정", detail: "", origin: "candidate" },
    ];
    expect(unifiedSavePayloads(items, []).points).toEqual([{ id: "D3", status: "미확정", detail: "작성 중 메모" }]);
  });

  const linkedRule: UnifiedGenericDraft = {
    kind: "generic", id: "R1", name: "예외 규칙", category: "예외·확인 기준",
    applicability: "적용", status: "확정", detail: "빈칸 확인", source: "", step: "",
    linkedDecisionId: "D3", origin: "stored",
  };
  it.each([
    ["확정", 1, 1], ["미확정", 0, 1], ["해당 없음", 0, 0],
  ] as const)("D3 %s + linked R1은 D 상태 기준 한 번만 집계한다", (status, done, total) => {
    const decision: UnifiedDecisionDraft = { kind: "decision", id: "D3", status, detail: "", origin: "stored" };
    expect(unifiedRuleProgress([decision, linkedRule])).toEqual({ done, total, applicabilityPending: 0 });
    expect(unifiedRuleProgress([linkedRule, decision, { ...linkedRule, id: "R2" }]))
      .toEqual({ done, total, applicabilityPending: 0 });
  });
  it.each(["적용", "적용 여부 미확정", "해당 없음"] as const)("연결된 범용 %s 상태가 D의 집계를 중복하거나 덮어쓰지 않는다", applicability => {
    const decision: UnifiedDecisionDraft = { kind: "decision", id: "D3", status: "미확정", detail: "", origin: "stored" };
    expect(unifiedRuleProgress([decision, { ...linkedRule, applicability }]))
      .toEqual({ done: 0, total: 1, applicabilityPending: 0 });
  });
  it.each(["D3", undefined] as const)("고아 연결(%s) 또는 연결 없는 범용 규칙은 기존대로 집계한다", linkedDecisionId => {
    expect(unifiedRuleProgress([
      { ...linkedRule, linkedDecisionId },
      { ...linkedRule, id: "R2", linkedDecisionId, status: "미확정" },
      { ...linkedRule, id: "R3", linkedDecisionId, applicability: "적용 여부 미확정" },
      { ...linkedRule, id: "R4", linkedDecisionId, applicability: "해당 없음" },
    ])).toEqual({ done: 1, total: 2, applicabilityPending: 1 });
  });

  it("완료 현황은 저장 전용 값 기준 ruleProgress와 동일한 규칙을 따른다 (해당 없음 제외, 적용 여부 미확정 별도)", () => {
    const items = deriveUnifiedRules(diagnosis({
      decisionPoints: [
        { id: "D3", status: "확정", detail: "빈칸은 확인 필요" },
        { id: "D4", status: "해당 없음" },
      ],
    }), [{
      id: "R1", name: "확정 규칙", category: "처리·판단 기준", applicability: "적용", status: "확정",
    }]);
    expect(unifiedRuleProgress(items)).toEqual({ done: 2, total: 4, applicabilityPending: 2 });
    // 같은 행 집합을 ruleProgress에 넣으면 같은 결과가 나온다 (고정 7행 resolve와는 다르다 —
    // 고정 7행은 도출되지 않은 D1·D2·D7까지 미확정 분모로 세기 때문이다).
    const points = items.filter(item => item.kind === "decision").map(item => ({
      id: item.id, title: "", question: "", status: item.status,
      ...(item.detail ? { detail: item.detail } : {}),
    }));
    const rules = items.filter(item => item.kind === "generic").map(item => ({
      id: item.id ?? "R?", name: item.name, category: item.category,
      applicability: item.applicability, status: item.status,
    }));
    expect(ruleProgress(points, rules)).toEqual({ done: 2, total: 4, applicabilityPending: 2 });
  });

  it("저장 페이로드: 빈 미확정 D 후보는 빠지고, 미터치 범용 후보는 저장되지 않으며, 터치 후보는 id를 받는다", () => {
    const items = deriveUnifiedRules(diagnosis());
    const touched = items.map(item =>
      item.kind === "generic" && item.name === "시스템 접근" ? { ...item, touched: true } : item);
    const { points, rules } = unifiedSavePayloads(touched, []);
    expect(points).toEqual([]);
    expect(rules.map(rule => rule.name)).toEqual(["시스템 접근"]);
    expect(rules[0].id).toBe("R1");
    expect(rules[0].applicability).toBe("적용 여부 미확정");
    // 미터치 후보(최종 승인)는 저장되지 않아 다음 렌더링에서 다시 도출된다.
    expect(rules.map(rule => rule.name)).not.toContain("최종 승인");
  });

  it("저장 페이로드: 후보보다 뒤에 있는 모달 추가 규칙(R1)과 후보 id가 충돌하지 않는다", () => {
    const items = deriveUnifiedRules(diagnosis());
    const withUser = [
      ...items.map(item => item.kind === "generic" && item.name === "시스템 접근" ? { ...item, touched: true } : item),
      {
        kind: "generic" as const, id: "R1", name: "사용자 추가 규칙", category: "처리·판단 기준" as const,
        applicability: "적용" as const, status: "확정" as const, detail: "", source: "", step: "",
        origin: "user" as const, touched: true,
      },
    ];
    const { rules } = unifiedSavePayloads(withUser, []);
    const byName = new Map(rules.map(rule => [rule.name, rule.id]));
    expect(byName.get("사용자 추가 규칙")).toBe("R1");
    expect(byName.get("시스템 접근")).toBe("R2");
  });

  it("저장 페이로드: 확정 D는 detail을 유지하고, 빈 detail은 생략한다", () => {
    const items = deriveUnifiedRules(diagnosis({
      decisionPoints: [
        { id: "D3", status: "확정", detail: "  빈칸은 확인 필요  " },
        { id: "D6", status: "확정" },
      ],
    }));
    const { points } = unifiedSavePayloads(items, []);
    expect(points).toEqual([
      { id: "D3", status: "확정", detail: "빈칸은 확인 필요" },
      { id: "D6", status: "확정" },
    ]);
  });

  it("초안 D4 확정 목록은 D5 선택형 UI의 기준이 된다", () => {
    const items = deriveUnifiedRules(diagnosis({
      decisionPoints: [{ id: "D4", status: "확정", detail: "정상, 오류(확정), 확인 필요" }],
    }));
    expect(draftStateNames(items)).toEqual(["정상", "오류(확정)", "확인 필요"]);
    expect(draftStateNames(deriveUnifiedRules(diagnosis()))).toBeNull();
  });
});
