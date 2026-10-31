import { describe, expect, it } from "vitest";
import { DECISION_DISPLAY, decisionPanelLabel, deriveUnifiedRules, draftStateNames, hasDerivationSignals, isConfirmationQuestion, unifiedRuleProgress, unifiedSavePayloads, type UnifiedDecisionDraft, type UnifiedGenericDraft, type UnifiedRuleDraft } from "@/lib/ax/rule-questions";
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

  it("픽스처 진단의 검토 완료율 분모는 표시된 모든 규칙(D 4건 + 범용 후보 2건)이다", () => {
    expect(unifiedRuleProgress(deriveUnifiedRules(diagnosis()))).toEqual({ done: 0, total: 6, applicabilityPending: 2 });
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

  it("추가 질문은 답변할 질문 영역에서 다루고 범용 규칙 후보가 되지 않는다", () => {
    const questions = [
      "답변 초안을 생성할 때 활용되는 템플릿이나 내부 문서는 어디에 보관되어 있나요?",
      "입력 파일 형식을 알려 주세요",
      "승인자는 누구인가요",
    ];
    const items = deriveUnifiedRules(diagnosis({
      followUpQuestions: questions,
      technicalChecks: [],
      asIs: { ...diagnosisFixture.asIs, humanDecisions: [] },
    }));
    const names = gNames(items);
    for (const question of questions) expect(names).not.toContain(question);
    expect(items.some(item => item.kind === "generic" && item.sourceLabel === "AI 추천")).toBe(false);
    // 질문만 있는 진단은 도출 신호가 아니다 (질문이 규칙 후보를 만들지 않으므로).
    expect(hasDerivationSignals(diagnosis({
      asIs: { purpose: "", trigger: "", inputs: [], steps: [], outputs: [], exceptions: [], humanDecisions: [], systems: [] },
      poc: { ...diagnosisFixture.poc, inputs: [], success: [], failure: [] },
      technicalChecks: [],
      followUpQuestions: questions,
    }))).toBe(false);
  });

  it("출력은 있으나 성공 기준이 없으면 완료 기준 정리 후보 1건이 도출된다", () => {
    const items = deriveUnifiedRules(diagnosis({
      poc: { ...diagnosisFixture.poc, success: [] },
    }));
    expect(gNames(items)).toContain("완료 기준 정리");
    expect(gNames(deriveUnifiedRules(diagnosis()))).not.toContain("완료 기준 정리");
  });

  it("사람 판단·기술 확인 항목이 확인 질문이면 후보로 승격하지 않고, 처리 기준 진술은 후보로 유지한다", () => {
    const items = deriveUnifiedRules(diagnosis({
      asIs: { ...diagnosisFixture.asIs, humanDecisions: ["최종 결재자가 누구인지 확인 필요", "담당자가 최종 수치를 승인한다"] },
      technicalChecks: [
        { topic: "외부 API 제공 여부", status: "확인 필요", note: "" },
        { topic: "현장 접근 권한", status: "확인 필요", note: "" },
      ],
    }));
    const names = gNames(items);
    expect(names).not.toContain("최종 결재자가 누구인지 확인 필요");
    expect(names).not.toContain("외부 API 제공 여부");
    expect(names).toEqual(expect.arrayContaining(["담당자가 최종 수치를 승인한다", "현장 접근 권한"]));
    // 후보는 자동 확정·자동 적용되지 않는다.
    for (const item of items) if (item.kind === "generic") {
      expect(item.applicability).toBe("적용 여부 미확정");
      expect(item.status).toBe("미확정");
    }
  });

  it("이미 저장된 질문형 규칙은 삭제·상태 변경 없이 그대로 보존한다", () => {
    const stored: GenericRule[] = [
      { id: "R1", name: "템플릿은 어디에 보관되어 있나요?", category: "처리·판단 기준", applicability: "적용 여부 미확정", status: "미확정" },
      { id: "R2", name: "승인권자는 누구인가요?", category: "권한·검토 기준", applicability: "적용", status: "확정", detail: "팀장이 승인한다" },
    ];
    const generic = deriveUnifiedRules(diagnosis({ followUpQuestions: ["템플릿은 어디에 보관되어 있나요?"] }), stored)
      .filter((item): item is UnifiedGenericDraft => item.kind === "generic" && item.origin === "stored");
    expect(generic.map(({ id, name, applicability, status, detail }) => ({ id, name, applicability, status, detail }))).toEqual([
      { id: "R1", name: "템플릿은 어디에 보관되어 있나요?", applicability: "적용 여부 미확정", status: "미확정", detail: "" },
      { id: "R2", name: "승인권자는 누구인가요?", applicability: "적용", status: "확정", detail: "팀장이 승인한다" },
    ]);
    expect(unifiedSavePayloads(generic, stored).rules).toEqual(stored);
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
  const d = (id: UnifiedDecisionDraft["id"], status: UnifiedDecisionDraft["status"]): UnifiedDecisionDraft => ({ kind: "decision", id, status, detail: "", origin: "stored" });
  const g = (id: string, applicability: UnifiedGenericDraft["applicability"], status: UnifiedGenericDraft["status"]): UnifiedGenericDraft =>
    ({ ...linkedRule, id, linkedDecisionId: undefined, applicability, status });
  it.each([
    ["모두 미확정", [d("D1", "미확정"), d("D2", "미확정"), g("R1", "적용 여부 미확정", "미확정"), g("R2", "적용", "미확정")], 0, 4],
    ["확정·미적용 결정은 완료", [d("D1", "확정"), d("D2", "해당 없음"), g("R1", "적용", "확정"), g("R2", "해당 없음", "미확정")], 4, 4],
    ["적용 여부 선택 전·적용+미확정은 미완료", [d("D1", "확정"), g("R1", "적용 여부 미확정", "확정"), g("R2", "적용", "미확정")], 1, 3],
  ] as const)("검토 완료율: %s", (_case, items, done, total) => {
    expect(unifiedRuleProgress(items)).toMatchObject({ done, total });
  });
  it("11건 중 5건 확정 + 3건 미적용 → 8/11, 신규 1건 추가 → 8/12, 미적용을 적용으로 되돌리면 확정 여부에 따라 재계산", () => {
    const items: UnifiedRuleDraft[] = [
      ...(["D1", "D2", "D3", "D4", "D5"] as const).map(id => d(id, "확정")),
      ...["R1", "R2", "R3"].map(id => g(id, "해당 없음", "미확정")),
      ...["R4", "R5", "R6"].map(id => g(id, "적용 여부 미확정", "미확정")),
    ];
    expect(unifiedRuleProgress(items)).toMatchObject({ done: 8, total: 11 });
    expect(unifiedRuleProgress([...items, g("R7", "적용 여부 미확정", "미확정")])).toMatchObject({ done: 8, total: 12 });
    const reapplied = items.map(item => item.kind === "generic" && item.id === "R1" ? { ...item, applicability: "적용" as const } : item);
    expect(unifiedRuleProgress(reapplied)).toMatchObject({ done: 7, total: 11 });
    const done = items.map(item => item.kind === "generic" ? { ...item, applicability: "적용" as const, status: "확정" as const } : item);
    expect(unifiedRuleProgress(done)).toMatchObject({ done: 11, total: 11 });
  });
  it("연결된 D와 범용 규칙은 별도 카드이므로 각각 집계한다", () => {
    expect(unifiedRuleProgress([d("D3", "확정"), linkedRule])).toMatchObject({ done: 2, total: 2 });
    expect(unifiedRuleProgress([d("D3", "미확정"), { ...linkedRule, applicability: "적용 여부 미확정" }])).toMatchObject({ done: 0, total: 2 });
  });
  it("저장 후 다시 도출해도 같은 완료율이다 (미터치 후보는 재도출되어 한 번만 집계)", () => {
    const derived = deriveUnifiedRules(diagnosis({ decisionPoints: [{ id: "D3", status: "확정", detail: "빈칸은 확인 필요" }, { id: "D4", status: "해당 없음" }] }),
      [{ id: "R1", name: "확정 규칙", category: "처리·판단 기준", applicability: "적용", status: "확정" }]);
    const { points, rules } = unifiedSavePayloads(derived, []);
    const restored = deriveUnifiedRules(diagnosis({ decisionPoints: points }), rules);
    expect(unifiedRuleProgress(restored)).toEqual(unifiedRuleProgress(derived));
    expect(unifiedRuleProgress(derived)).toMatchObject({ done: 3, total: derived.length });
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

describe("AX 확인 질문 ↔ 처리 규칙 구분 (업무 유형 10종)", () => {
  // [유형, 확인 질문(규칙 후보 아님), 처리 기준 진술(규칙 후보 가능)]
  const cases: [string, string, string][] = [
    ["데이터 집계", "중복 거래는 어떻게 처리하나요", "중복 거래ID는 합산에서 제외한다"],
    ["문서 작성", "답변 초안을 생성할 때 활용되는 템플릿이나 내부 문서는 어디에 보관되어 있나요?", "답변 초안은 승인된 템플릿을 기준으로 작성한다"],
    ["고객 문의 응대", "고객 등급별 응대 기준이 있는지 확인 필요", "환불 문의는 결제 내역 확인 후 담당자에게 배정"],
    ["일정 관리", "회의 마감 기한은 언제까지입니까", "마감 3일 전까지 일정을 확정한다"],
    ["시설 유지보수", "긴급 보수 승인권자가 누구인가요", "긴급 보수는 시설 팀장 승인 후 진행"],
    ["안전 관리", "작업 전 안전 점검표를 매번 작성해야 할까요", "고소 작업은 안전 점검표 작성 후에만 시작한다"],
    ["계약 검토", "책임자 승인 필요 여부", "1억 원 이상 계약은 법무 검토 후 책임자가 승인한다"],
    ["파일 분류", "파일 형식이 PDF인지 확인 요청", "PDF 외 형식은 분류 보류 폴더로 이동"],
    ["업무 요청 접수", "요청서에 필수 항목이 있나", "필수 정보가 누락된 요청은 반려 대상으로 분리"],
    ["외부 시스템 연동", "외부 API 제공 여부", "주문 API 응답이 실패하면 3회 재시도 후 담당자 알림"],
  ];
  it.each(cases)("%s: 확인 질문은 질문으로, 처리 기준은 규칙으로 구분한다", (_type, question, rule) => {
    expect(isConfirmationQuestion(question)).toBe(true);
    expect(isConfirmationQuestion(rule)).toBe(false);
  });

  it.each(cases)("%s: 사람 판단 항목의 질문은 후보에서 빠지고 처리 기준은 후보로 남는다", (_type, question, rule) => {
    const names = gNames(deriveUnifiedRules(diagnosis({
      asIs: { ...diagnosisFixture.asIs, humanDecisions: [question, rule] },
      technicalChecks: [],
      followUpQuestions: [question],
    })));
    expect(names).not.toContain(question);
    expect(names).toContain(rule);
  });

  it("물음표가 없어도 의문 어미면 질문이고, 물음표만으로 판정하지 않는다", () => {
    expect(isConfirmationQuestion("승인권자는 누구입니까")).toBe(true);
    expect(isConfirmationQuestion("최종 승인")).toBe(false);
    expect(isConfirmationQuestion("시스템 접근")).toBe(false);
    expect(isConfirmationQuestion("")).toBe(false);
  });
});

describe("AX 도출 규칙 출처 보존", () => {
  it("도출 후보에서 저장된 규칙은 도출 근거를 표시용으로 받고, 사용자 규칙은 받지 않으며 저장 값은 바뀌지 않는다", () => {
    const stored: GenericRule[] = [
      { id: "R1", name: "시스템 접근", category: "예외·확인 기준", applicability: "해당 없음", status: "미확정" },
      { id: "R2", name: "월말 이월", category: "처리·판단 기준", applicability: "적용", status: "확정" },
    ];
    const generic = deriveUnifiedRules(diagnosis(), stored).filter((item): item is UnifiedGenericDraft => item.kind === "generic");
    const r1 = generic.find(item => item.id === "R1")!;
    expect(r1.provenance).toContain("시스템 접근");
    expect(generic.find(item => item.id === "R2")!.provenance).toBeUndefined();
    expect(generic.filter(item => item.name === "시스템 접근")).toHaveLength(1);
    expect(unifiedSavePayloads(generic, stored).rules).toEqual(stored);
  });
});
