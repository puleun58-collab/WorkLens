import { describe, expect, it } from "vitest";
import { deriveUnifiedRules, hasDerivationSignals, unifiedRuleProgress, unifiedSavePayloads } from "@/lib/ax/rule-questions";
import type { UnifiedDecisionDraft, UnifiedGenericDraft, UnifiedRuleDraft } from "@/lib/ax/rule-questions";
import type { DecisionPoint, GenericRule } from "@/lib/ax/types";
import { approvalConditionDiagnosis as approvalChecks, axRuleDerivationBoundaryFixtures, axRuleDerivationFixtures, compositeWorkFixture, equipmentAggregationFixture, excelComparisonFixture, facilitySafetyFixture, filelessWorkFixture, insufficientDerivationDiagnoses, ruleDerivationDiagnosis, scheduleNotificationFixture, workPermitFixture } from "./fixtures/ax-rule-derivation";

const decisionRows = (rows: readonly UnifiedRuleDraft[]): UnifiedDecisionDraft[] =>
  rows.filter((row): row is UnifiedDecisionDraft => row.kind === "decision");
const genericRows = (rows: readonly UnifiedRuleDraft[]): UnifiedGenericDraft[] =>
  rows.filter((row): row is UnifiedGenericDraft => row.kind === "generic");
const candidates = (rows: readonly UnifiedRuleDraft[]): UnifiedGenericDraft[] =>
  genericRows(rows).filter(row => row.origin === "candidate");
const processContent = (row: UnifiedGenericDraft): string => `${row.name} ${row.detail}`;
const matchingConditions = (rows: readonly UnifiedRuleDraft[], fragments: readonly string[]): UnifiedGenericDraft[] =>
  genericRows(rows).filter(row => fragments.every(fragment => processContent(row).includes(fragment)));

const riskApproval = "위험 작업은 안전관리자가 검토한 후 승인한다";
const nightApproval = "야간 작업은 현장책임자가 검토한 후 승인한다";

// The fixture expectations are hand-authored before deriving any actual candidate list.
describe.each(axRuleDerivationFixtures)("구조화 진단 fixture: $label", fixture => {
  it("실제 처리 조건의 D 후보만 도출하고 명시한 무관 D 후보는 제외한다", () => {
    const rows = deriveUnifiedRules(fixture.diagnosis);
    const ids = decisionRows(rows).map(row => row.id);
    expect(ids).toEqual(fixture.expectedDecisionIds);
    for (const id of fixture.excludedDecisionIds) expect(ids).not.toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("필수 승인·검토·실패 처리 조건을 보존하고 무관하거나 기술 선행 확인뿐인 규칙을 만들지 않는다", () => {
    const rows = deriveUnifiedRules(fixture.diagnosis);
    for (const fragments of fixture.requiredGenericRules) {
      expect(matchingConditions(rows, fragments), `${fixture.id}: ${fragments.join(" / ")}`).toHaveLength(1);
    }
    for (const excluded of fixture.excludedGenericRules) {
      expect(genericRows(rows).some(row => processContent(row).includes(excluded)), `${fixture.id}: excluded ${excluded}`).toBe(false);
    }
  });

  it("자동 후보는 근거가 있는 미확정 제안이며 검토 대상 분모에 남고 미터치 상태로 저장되지 않는다", () => {
    const rows = deriveUnifiedRules(fixture.diagnosis);
    for (const row of rows) {
      expect(row.origin).toBe("candidate");
      expect(row.status).toBe("미확정");
      expect(row.provenance?.trim()).toBeTruthy();
      expect(row.sourceLabel?.trim()).toBeTruthy();
      if (row.kind === "generic") {
        expect(row.id).toBeNull();
        expect(row.applicability).toBe("적용 여부 미확정");
        expect(row.touched).not.toBe(true);
        expect(row.candidateKey?.trim()).toBeTruthy();
      } else {
        expect(row.detail).toBe("");
      }
    }
    expect(unifiedRuleProgress(rows)).toEqual({ done: 0, total: rows.length, applicabilityPending: genericRows(rows).length });
    expect(unifiedSavePayloads(rows, [])).toEqual({ points: [], rules: [] });
    const keys = candidates(rows).map(row => row.candidateKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("공유 증거 fixture의 명시적 경계 계약", () => {
  it("업무 유형 아홉 가지와 경계 A–J를 모두 공개한다", () => {
    expect(axRuleDerivationFixtures.map(fixture => fixture.id)).toEqual([
      "excel-comparison-aggregation", "equipment-run-aggregation", "facility-safety", "customer-requests",
      "contract-review", "work-permit-approval", "schedule-notification", "fileless-reference-viewing", "composite",
    ]);
    expect([...new Set(axRuleDerivationBoundaryFixtures.flatMap(fixture => fixture.boundaries))].sort()).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
  });

  it.each(axRuleDerivationBoundaryFixtures)("$label: 공유된 기대·제외 목록으로 실제 도출 결과를 비교한다", fixture => {
    const rows = deriveUnifiedRules(fixture.diagnosis, fixture.storedGenericRules);
    const ids = decisionRows(rows).map(row => row.id);
    expect(ids).toEqual(fixture.expectedDecisionIds);
    for (const id of fixture.excludedDecisionIds) expect(ids).not.toContain(id);
    for (const fragments of fixture.requiredGenericRules) expect(matchingConditions(rows, fragments)).toHaveLength(1);
    for (const excluded of fixture.excludedGenericRules) expect(genericRows(rows).some(row => processContent(row).includes(excluded))).toBe(false);
    if (fixture.storedGenericRules) {
      expect(unifiedSavePayloads(rows, fixture.storedGenericRules)).toEqual({ points: fixture.diagnosis.decisionPoints, rules: fixture.storedGenericRules });
    }
  });
});

describe("D 도출 경계 A–C 및 숫자·이름 오판 방지", () => {
  it("A: 서로 대조하지 않는 두 시스템은 D1 근거가 아니다", () => {
    expect(equipmentAggregationFixture.diagnosis.asIs.systems).toHaveLength(2);
    expect(decisionRows(deriveUnifiedRules(equipmentAggregationFixture.diagnosis)).map(row => row.id)).not.toContain("D1");
    expect(decisionRows(deriveUnifiedRules(scheduleNotificationFixture.diagnosis)).map(row => row.id)).not.toContain("D1");
  });

  it("B: 파일 없는 안전점검은 D6 없이 위험 판정과 조치가 남는다", () => {
    const rows = deriveUnifiedRules(facilitySafetyFixture.diagnosis);
    expect(decisionRows(rows).map(row => row.id)).toEqual(["D3", "D4", "D5"]);
    expect(matchingConditions(rows, ["위험 징후", "안전관리자", "작업을 중지"])).toHaveLength(1);
  });

  it("C: 실제 파일 수신·집계는 빈 입력과 계산 기준을 도출한다", () => {
    const rows = deriveUnifiedRules(excelComparisonFixture.diagnosis);
    expect(decisionRows(rows).map(row => row.id)).toEqual(expect.arrayContaining(["D3", "D6", "D7"]));
    const emptyInput = decisionRows(rows).find(row => row.id === "D6")!;
    expect(emptyInput.displayTitle ?? emptyInput.provenance).toMatch(/파일/u);
    const dataRows = deriveUnifiedRules(equipmentAggregationFixture.diagnosis);
    const dataInput = decisionRows(dataRows).find(row => row.id === "D6")!;
    expect(dataInput.displayTitle).toMatch(/데이터/u);
    expect(dataInput.displayTitle).not.toMatch(/파일/u);
    expect(dataInput.displayQuestion).toMatch(/데이터/u);
  });

  it("숫자·확장자·중복 입력 명칭만으로 계산·파일 수신·중복 위험을 확정하지 않는다", () => {
    const diagnosis = ruleDerivationDiagnosis({
      asIs: { purpose: "문서 화면의 제목을 읽는다", trigger: "안내 열람", inputs: ["매뉴얼.xlsx 2026", "매뉴얼.xlsx 2026"], steps: ["공개 안내 제목을 화면에서 읽는다"], outputs: [], exceptions: [], humanDecisions: [], systems: ["열람 화면"] },
    });
    const ids = decisionRows(deriveUnifiedRules(diagnosis)).map(row => row.id);
    expect(ids).not.toContain("D1");
    expect(ids).not.toContain("D2");
    expect(ids).not.toContain("D6");
    expect(ids).not.toContain("D7");
  });

  it("D3는 수치 예외뿐 아니라 조건 불충족·조항 누락 같은 비수치 예외도 포함한다", () => {
    expect(decisionRows(deriveUnifiedRules(workPermitFixture.diagnosis)).map(row => row.id)).toContain("D3");
    expect(decisionRows(deriveUnifiedRules(facilitySafetyFixture.diagnosis)).map(row => row.id)).toContain("D3");
  });
});

describe("중복 경계 D–E: 이름보다 명시한 처리 조건", () => {
  it("D: 같은 제목이더라도 승인 조건과 담당자가 다르면 독립 후보로 남긴다", () => {
    const rows = deriveUnifiedRules(approvalChecks([{ topic: "담당자 검토", note: riskApproval }, { topic: "담당자 검토", note: nightApproval }]));
    const risk = matchingConditions(rows, ["위험 작업", "안전관리자", "승인"]);
    const night = matchingConditions(rows, ["야간 작업", "현장책임자", "승인"]);
    expect(risk).toHaveLength(1);
    expect(night).toHaveLength(1);
    expect(risk[0]).not.toBe(night[0]);
    expect(risk[0].candidateKey).not.toBe(night[0].candidateKey);
  });

  it("E: 다른 제목의 동일한 명시 조건은 자동 후보 한 건만 만든다", () => {
    const rows = deriveUnifiedRules(approvalChecks([{ topic: "담당자 검토", note: riskApproval }, { topic: "최종 확인", note: riskApproval }]));
    expect(matchingConditions(rows, ["위험 작업", "안전관리자", "승인"])).toHaveLength(1);
    expect(candidates(rows)).toHaveLength(1);
  });

  it("이름과 조건이 모두 동일한 후보도 중복 노출하지 않는다", () => {
    const rows = deriveUnifiedRules(approvalChecks([{ topic: "담당자 검토", note: riskApproval }, { topic: "담당자 검토", note: riskApproval }]));
    expect(candidates(rows)).toHaveLength(1);
  });

  it("일부만 겹치는 조건은 전체 조건이 같다는 근거 없이 합치지 않는다", () => {
    const rows = deriveUnifiedRules(approvalChecks([{ topic: "작업 검토", note: riskApproval }, { topic: "작업 검토", note: "위험 작업은 안전관리자가 검토한 후 작업을 중지한다" }]));
    const approved = matchingConditions(rows, ["위험 작업", "승인"]);
    const stopped = matchingConditions(rows, ["위험 작업", "작업을 중지"]);
    expect(approved).toHaveLength(1);
    expect(stopped).toHaveLength(1);
    expect(approved[0]).not.toBe(stopped[0]);
  });

  it("후보 키는 표시 제목이 변경되어도 유지되고 저장 ID와 충돌하지 않는다", () => {
    const before = candidates(deriveUnifiedRules(approvalChecks([{ topic: "담당자 검토", note: riskApproval }])));
    const renamed = candidates(deriveUnifiedRules(approvalChecks([{ topic: "최종 확인", note: riskApproval }])));
    expect(before).toHaveLength(1);
    expect(renamed).toHaveLength(1);
    expect(before[0].candidateKey).toBeTruthy();
    expect(renamed[0].candidateKey).toBe(before[0].candidateKey);
    expect(before[0].candidateKey).not.toMatch(/^(?:R\d+|D[1-7])$/u);
  });

  it("E: 사용자가 저장한 다른 이름의 동일 조건 규칙 두 건은 자동 정리하지 않는다", () => {
    const stored: GenericRule[] = [
      { id: "R5", name: "위험 작업 승인", detail: riskApproval, category: "권한·검토 기준", applicability: "적용", status: "확정", source: "안전지침", step: "작업 승인" },
      { id: "R9", name: "현장 최종 검토", detail: riskApproval, category: "권한·검토 기준", applicability: "적용", status: "확정", source: "현장 기준", step: "작업 승인" },
    ];
    const rows = deriveUnifiedRules(approvalChecks([{ topic: "담당자 검토", note: riskApproval }]), stored);
    expect(genericRows(rows).filter(row => row.origin === "stored").map(row => row.id)).toEqual(["R5", "R9"]);
    expect(candidates(rows)).toHaveLength(0);
    expect(unifiedSavePayloads(rows, stored).rules).toEqual(stored);
  });

  it("D: 저장 규칙과 후보의 이름이 같아도 다른 조건의 후보를 숨기지 않는다", () => {
    const stored: GenericRule[] = [{ id: "R2", name: "담당자 검토", detail: riskApproval, category: "권한·검토 기준", applicability: "적용", status: "확정" }];
    const rows = deriveUnifiedRules(approvalChecks([{ topic: "담당자 검토", note: nightApproval }]), stored);
    expect(genericRows(rows).some(row => row.origin === "stored" && row.id === "R2" && row.detail === riskApproval)).toBe(true);
    expect(matchingConditions(rows, ["야간 작업", "현장책임자", "승인"])).toHaveLength(1);
    expect(unifiedSavePayloads(rows, stored).rules).toEqual(stored);
  });
});

describe("F: 재도출·저장에서 사용자 저장 데이터 보존", () => {
  const savedPoints: DecisionPoint[] = [
    { id: "D1", status: "확정", detail: "사용자 지정 주문번호와 기준 자료" },
    { id: "D2", status: "해당 없음", detail: "단일 실행으로 운영하기로 결정" },
    { id: "D3", status: "미확정", detail: "예외 처리 검토 중 메모" },
    { id: "D4", status: "확정", detail: "정상, 오류, 보류" },
    { id: "D5", status: "확정", detail: "보류" },
    { id: "D6", status: "해당 없음", detail: "현장 직접 확인" },
    { id: "D7", status: "확정", detail: "분 단위 합산, 소수 둘째 자리 반올림" },
  ];
  const savedRules: GenericRule[] = [
    { id: "R3", name: "사용자 확정 검토", category: "권한·검토 기준", applicability: "적용", status: "확정", detail: "팀장 승인 후 보고", source: "운영지침 4조", step: "최종 보고", linkedDecisionId: "D4" },
    { id: "R8", name: "적용 제외 규칙", category: "처리·판단 기준", applicability: "해당 없음", status: "미확정", detail: "대상 업무에서 제외하기로 결정", source: "담당자 결정", step: "검토" },
    { id: "R17", name: "작성 중 사용자 규칙", category: "예외·확인 기준", applicability: "적용 여부 미확정", status: "미확정", detail: "작성 중 메모", source: "현장 확인", step: "예외 처리", linkedDecisionId: "D3" },
  ];

  it.each([excelComparisonFixture, filelessWorkFixture, compositeWorkFixture])("새 진단 $label 에서 필요 여부와 무관하게 기존 ID·상태·상세·분류·연결을 보존한다", fixture => {
    const diagnosis = { ...structuredClone(fixture.diagnosis), decisionPoints: structuredClone(savedPoints) };
    const rows = deriveUnifiedRules(diagnosis, savedRules);
    expect(decisionRows(rows).map(({ id, status, detail, origin }) => ({ id, status, detail, origin }))).toEqual(savedPoints.map(point => ({ ...point, origin: "stored" })));
    expect(unifiedSavePayloads(rows, savedRules)).toEqual({ points: savedPoints, rules: savedRules });
    expect(diagnosis.decisionPoints).toEqual(savedPoints);
  });

  it("저장된 미확정 행은 완료율 분모에서 숨기지 않고 미터치 신규 후보도 분모에서 빼지 않는다", () => {
    const rows = deriveUnifiedRules({ ...structuredClone(compositeWorkFixture.diagnosis), decisionPoints: structuredClone(savedPoints) }, savedRules);
    const progress = unifiedRuleProgress(rows);
    expect(progress.total).toBe(rows.length);
    expect(progress.done).toBe(8);
    expect(progress.applicabilityPending).toBe(1 + candidates(rows).length);
    expect(progress.done).toBeLessThan(progress.total);
  });

  it("후보를 명시적으로 수정한 경우에만 저장하며 기존 규칙과 사용자 신규 ID를 예약한다", () => {
    const rows = deriveUnifiedRules(compositeWorkFixture.diagnosis, savedRules);
    const candidate = candidates(rows)[0]!;
    const userRule: UnifiedGenericDraft = { kind: "generic", id: "R18", name: "사용자가 직접 추가한 규칙", category: "처리·판단 기준", applicability: "적용", status: "확정", detail: "등록한 단계만 처리한다", source: "사용자", step: "처리", origin: "user" };
    const editedRows = rows.map(row => row === candidate ? { ...candidate, name: "사용자가 수정한 제안", applicability: "적용" as const, status: "확정" as const, detail: "담당자가 확인한 처리 기준", touched: true } : row);
    const payload = unifiedSavePayloads([...editedRows, userRule], savedRules);
    expect(payload.rules.slice(0, savedRules.length)).toEqual(savedRules);
    expect(payload.rules.find(rule => rule.name === "사용자가 수정한 제안")).toMatchObject({ id: "R19", applicability: "적용", status: "확정", detail: "담당자가 확인한 처리 기준" });
    expect(payload.rules.find(rule => rule.id === "R18")?.name).toBe(userRule.name);
    expect(payload.rules).toHaveLength(savedRules.length + 2);
    expect(new Set(payload.rules.map(rule => rule.id)).size).toBe(payload.rules.length);
    expect(payload.rules.some(rule => "candidateKey" in rule || "origin" in rule || "provenance" in rule)).toBe(false);
  });
});

describe("G–J: 근거 부족·빈 목록·동일 업무명·기술 확인 분리", () => {
  it.each(insufficientDerivationDiagnoses)("G/H: 처리 맥락이 부족한 진단은 후보를 자동 확정·제외하거나 규칙 불필요로 판정하지 않는다", diagnosis => {
    const rows = deriveUnifiedRules(diagnosis);
    expect(hasDerivationSignals(diagnosis)).toBe(false);
    for (const row of rows) {
      expect(row.status).toBe("미확정");
      if (row.kind === "generic") expect(row.applicability).toBe("적용 여부 미확정");
    }
    expect(unifiedSavePayloads(rows, [])).toEqual({ points: [], rules: [] });
  });

  it("H: 충분한 단순 열람의 후보 0개와 빈 진단의 정보 부족을 구분한다", () => {
    expect(deriveUnifiedRules(filelessWorkFixture.diagnosis)).toEqual([]);
    expect(hasDerivationSignals(filelessWorkFixture.diagnosis)).toBe(true);
    expect(deriveUnifiedRules(insufficientDerivationDiagnoses[0])).toEqual([]);
    expect(hasDerivationSignals(insufficientDerivationDiagnoses[0])).toBe(false);
  });

  it("I: 업무명이 같아도 실제 단계와 처리 조건이 다르면 후보 조합이 다르다", () => {
    expect(facilitySafetyFixture.taskName).toBe(workPermitFixture.taskName);
    const safety = decisionRows(deriveUnifiedRules(facilitySafetyFixture.diagnosis)).map(row => row.id);
    const permit = decisionRows(deriveUnifiedRules(workPermitFixture.diagnosis)).map(row => row.id);
    expect(safety).toEqual(["D3", "D4", "D5"]);
    expect(permit).toEqual(["D2", "D3", "D4", "D5"]);
    expect(safety).not.toEqual(permit);
  });

  it("J: 같은 기술 확인 항목에 섞인 API 선행 확인과 발송 실패 처리 조건을 분리한다", () => {
    const diagnosis = structuredClone(scheduleNotificationFixture.diagnosis);
    diagnosis.asIs.exceptions = [];
    diagnosis.toBe = [];
    const rows = deriveUnifiedRules(diagnosis);
    expect(matchingConditions(rows, ["이메일 발송 실패", "재시도", "오류 기록"])).toHaveLength(1);
    expect(genericRows(rows).some(row => processContent(row).includes("이메일 API 제공 여부 확인"))).toBe(false);
    expect(diagnosis.technicalChecks[0].topic).toBe("이메일 API 제공 여부 확인");
    expect(diagnosis.technicalChecks[0].note).toContain("이메일 발송 실패 시 재시도 후 오류 기록");
  });

  it("J: 기술 제공 여부와 확인 질문만으로 업무 처리 규칙을 새로 만들지 않는다", () => {
    const diagnosis = ruleDerivationDiagnosis({
      technicalChecks: [{ topic: "이메일 API 제공 여부 확인", status: "확인 필요", note: "권한과 API 제공 여부를 확인해야 한다" }],
      followUpQuestions: ["승인권자는 누구인가요?", "필요한 입력은 무엇인가요?"],
    });
    expect(deriveUnifiedRules(diagnosis)).toEqual([]);
    expect(hasDerivationSignals(diagnosis)).toBe(false);
  });
});

describe("후보 개명·저장 후 식별 보존", () => {
  it.each(["AS-IS 사람 판단", "사람 개입(HITL)", '기술적 확인 항목 "담당자 검토"'])("%s 근거는 편집 상세보다 우선하고 다른 조건은 별도 후보로 남긴다", source => {
    const stored: GenericRule[] = [{ id: "R2", name: "담당자 검토", detail: nightApproval, source: `${source}: ${riskApproval}`, category: "권한·검토 기준", applicability: "적용", status: "확정" }];
    const context = approvalChecks([{ topic: "담당자 검토", note: riskApproval }, { topic: "담당자 검토", note: nightApproval }]);
    const rows = deriveUnifiedRules(context, JSON.parse(JSON.stringify(stored)));
    expect(genericRows(rows)).toHaveLength(2);
    expect(candidates(rows)).toEqual([expect.objectContaining({ name: nightApproval })]);
    expect(genericRows(rows).find(row => row.id === "R2"))
      .toMatchObject({ origin: "stored", detail: nightApproval, source: stored[0].source, status: "확정" });
    expect(unifiedSavePayloads(rows, stored).rules).toEqual(stored);
  });

  it("도출 근거가 같아도 저장 행과 후보의 업무 단계가 다르면 별도로 남긴다", () => {
    const context = approvalChecks([]);
    context.asIs.steps = [riskApproval];
    const stored: GenericRule[] = [{ id: "R2", name: riskApproval, detail: "사용자 검토 조건", source: `AS-IS 업무 단계: ${riskApproval}`, step: "별도 승인 단계", category: "권한·검토 기준", applicability: "적용", status: "확정" }];
    const rows = deriveUnifiedRules(context, stored);
    expect(genericRows(rows)).toHaveLength(2);
    expect(candidates(rows)).toEqual([expect.objectContaining({ name: riskApproval, step: riskApproval })]);
    expect(unifiedSavePayloads(rows, stored).rules).toEqual(stored);
  });

  it("규칙명을 바꿔 저장해도 원래 처리 조건이 같은 후보를 다시 노출하지 않는다", () => {
    const diagnosis = approvalChecks([{ topic: "담당자 검토", note: riskApproval }]);
    const rows = deriveUnifiedRules(diagnosis);
    const renamed = rows.map(row => row.kind === "generic"
      ? { ...row, name: "사용자가 바꾼 검토명", touched: true }
      : row);
    const saved = unifiedSavePayloads(renamed, []);
    const restored = deriveUnifiedRules({ ...diagnosis, decisionPoints: saved.points }, saved.rules);
    expect(genericRows(restored).map(row => row.id)).toEqual(["R1"]);
    expect(genericRows(restored)[0].name).toBe("사용자가 바꾼 검토명");
    expect(candidates(restored)).toEqual([]);
    expect(unifiedSavePayloads(restored, saved.rules)).toEqual(saved);
  });
});

describe("무관 예외와 혼합 기술 확인의 경계", () => {
  it("예외 없음이라는 부정 진술은 예외 규칙 후보가 아니다", () => {
    const diagnosis = structuredClone(filelessWorkFixture.diagnosis);
    diagnosis.asIs.exceptions = ["예외 없음", "특이사항 없음"];
    expect(deriveUnifiedRules(diagnosis)).toEqual([]);
  });

  it("API 확인과 처리 조건이 접속사로 연결되어도 실행 처리 절만 보존한다", () => {
    const diagnosis = ruleDerivationDiagnosis({
      technicalChecks: [{ topic: "이메일 연동", status: "확인 필요", note: "이메일 API 제공 여부를 확인하고 이메일 발송 실패 시 재시도 후 오류 기록" }],
    });
    const rows = deriveUnifiedRules(diagnosis);
    expect(matchingConditions(rows, ["이메일 발송 실패", "재시도", "오류 기록"])).toHaveLength(1);
    expect(genericRows(rows).some(row => processContent(row).includes("API 제공 여부"))).toBe(false);
    expect(diagnosis.technicalChecks[0].note).toContain("API 제공 여부");
  });
});
