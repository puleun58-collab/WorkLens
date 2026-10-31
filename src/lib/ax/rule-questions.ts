/**
 * 업무 규칙 확인 — 통합 목록 도출 (고정 D1~D7 표시의 대체).
 *
 * 원칙 (지시문 §4):
 * - 고정 목록을 모든 업무에 무조건 표시하지 않는다. 질문은 진단 데이터의 구조적
 *   필드(등록·목적·입출력·AS-IS 단계·진단·단계별 판단·구현/제외 범위·기존 확정·
 *   HITL·미확정)에서만 도출하고, 업무명·자유 텍스트 키워드만으로 유형을 확정하지 않는다.
 * - AI 제안 ≠ 자동 확정. 도출된 행은 후보(미확정 / 적용 여부 미확정)로만 표시하고,
 *   근거 없는 자동 확정·자동 해당 없음은 하지 않는다.
 * - 기존 D1~D7 ID·의미·확정 상태·상세를 보존한다. 저장된 행이 있는 측면은 후보를
 *   만들지 않으며, 의미가 일부만 겹치는 규칙은 자동 병합하지 않는다.
 * - 완료 현황은 실제 확인 대상 기준이다. 고정 7을 분모로 쓰지 않고, 숨김으로
 *   완료율을 높이지 않으며, 적용 여부 미확정 규칙은 분모 외 별도 건수로 표시한다.
 */
import { DECISION_POINT_IDS } from "./schema";
import type { AxDiagnosis, DecisionPoint, DecisionPointId, DecisionPointStatus, GenericRule, GenericRuleApplicability, GenericRuleCategory, GenericRuleStatus } from "./types";
import { resolveGenericRules, type RuleProgress } from "./generic-rules";
import { parseStateNames } from "./decision-points";

/** 표시 전용 D1~D7 제목·설명. 지시문 생성은 기존 DEFS 제목을 쓰므로 여기를 바꿔도 지시문은 바뀌지 않는다. */
export const DECISION_DISPLAY: Record<DecisionPointId, { title: string; question: string }> = {
  D1: { title: "대조 기준", question: "어떤 자료와 항목을 기준으로 비교하나요?" },
  D2: { title: "중복 처리", question: "동일한 항목이 여러 번 나타나면 어떻게 처리하나요?" },
  D3: { title: "예외값 처리", question: "빈칸·음수·0 등은 어떻게 처리하나요?" },
  D4: { title: "결과 상태", question: "처리 결과를 어떤 상태로 구분하나요?" },
  D5: { title: "판단 불가 처리", question: "판정할 수 없는 데이터는 어떻게 표시하나요?" },
  D6: { title: "빈 파일 처리", question: "데이터가 없을 때 어떻게 처리하나요?" },
  D7: { title: "계산 기준", question: "합계·반올림·단위의 기준은 무엇인가요?" },
};

/** 표시 전용 패널 라벨: D번호 없이 간결한 라벨을 쓴다 (지시문 생성과 무관).
 * #365 레퍼런스 교정 문구("D1 상태"/"D1 상세")를 의도적으로 대체한다. */
export function decisionPanelLabel(_id: string, kind: "상태" | "상세"): string {
  return kind === "상세" ? "대조 기준" : kind;
}

export type UnifiedRuleOrigin = "stored" | "candidate" | "user";

export interface UnifiedDecisionDraft {
  kind: "decision";
  id: DecisionPointId;
  status: DecisionPointStatus;
  /** 화면 표시용 상세. 미확정 행의 detail은 표시만 하고 생성 경로에서는 버려진다. */
  detail: string;
  origin: UnifiedRuleOrigin;
  /** 후보일 때만 있다. */
  sourceLabel?: string;
  /** 후보일 때만 있다. 도출 근거 문장. */
  provenance?: string;
}

export interface UnifiedGenericDraft {
  kind: "generic";
  /** 후보는 아직 id가 없다. 저장 시 nextGenericRuleId로 부여한다. */
  id: string | null;
  name: string;
  category: GenericRuleCategory;
  applicability: GenericRuleApplicability;
  status: GenericRuleStatus;
  detail: string;
  source: string;
  step: string;
  linkedDecisionId?: DecisionPointId;
  origin: UnifiedRuleOrigin;
  sourceLabel?: string;
  provenance?: string;
  /**
   * 컴포넌트 로컬 플래그. 저장 페이로드 판정용이다 (저장되지 않음):
   * - stored 행은 항상 페이로드에 포함한다 (제외하면 저장된 규칙이 삭제되기 때문).
   * - user 행(모달 추가)은 사용자가 직접 추가했으므로 페이로드에 포함한다.
   * - candidate 행은 사용자가 건드린 경우에만 페이로드에 포함한다. 건드리지 않은
   *   후보를 저장하면 사용자의 저장 의도와 무관하게 도출물이 저장 기록으로 바뀌므로,
   *   미터치 후보는 저장에서 빼고 다음 렌더링에서 다시 도출되게 한다.
   */
  touched?: boolean;
}

export type UnifiedRuleDraft = UnifiedDecisionDraft | UnifiedGenericDraft;

const normalize = (value: string): string => value.replace(/\s+/gu, " ").trim();
const cleanList = (list?: readonly string[] | null): string[] =>
  (list ?? []).map(item => (typeof item === "string" ? item.trim() : "")).filter(Boolean);

/** 직접 의문 어미(…나요?·…까요·…습니까·…인가 등). 끝의 마침표·물음표는 별도로 허용한다. */
const DIRECT_QUESTION_ENDING = /(?:나요|까요|가요|습니까|읍니까|입니까|ㅂ니까|합니까|됩니까|있나|없나|인가|는가|은가|을까|일까|할까|될까|는지요|인지요|은지요|을지요)$/u;
/** 간접 의문·확인 요청(…인지 확인 필요·…할지 문의·…여부 확인 등): 처리 기준이 아니라 답을 요구한다. */
const INDIRECT_QUESTION_ENDING = /(?:인지|는지|은지|을지|할지|될지|일지|여부)\s*(?:를|을)?\s*(?:확인|문의|질문|결정|파악)?\s*(?:이|가)?\s*(?:필요|요청|필요함|필요합니다|해\s*주세요|하세요|바랍니다)?$/u;

/**
 * 확인 질문(정보 요청) 판정. 물음표 유무만으로 판단하지 않고 문장의 목적(직접 의문 어미,
 * "…인지·…할지·…여부 확인" 같은 간접 의문·확인 요청)으로 구분한다. 조건·처리·결과를
 * 진술하는 문장(…한다·…함·명사형 기준)은 질문이 아니다. 질문은 답변할 질문 영역에서
 * 다루며, 처리 기준이 없는 질문은 업무 규칙 후보로 승격하지 않는다.
 */
export function isConfirmationQuestion(text: string): boolean {
  const value = normalize(text);
  if (!value) return false;
  if (/[?？]$/u.test(value)) return true;
  const body = value.replace(/[.。!]+$/u, "").trim();
  return DIRECT_QUESTION_ENDING.test(body) || INDIRECT_QUESTION_ENDING.test(body);
}

/** 저장된 D 행. id·상태가 유효한 것만 남기고, 중복 id는 첫 항목만 유지한다. */
function storedDecisionRows(diagnosis: AxDiagnosis): UnifiedDecisionDraft[] {
  const seen = new Set<string>();
  const out: UnifiedDecisionDraft[] = [];
  for (const point of diagnosis.decisionPoints ?? []) {
    if (!point || !(DECISION_POINT_IDS as readonly string[]).includes(point.id)) continue;
    if (seen.has(point.id)) continue;
    if (point.status !== "확정" && point.status !== "미확정" && point.status !== "해당 없음") continue;
    seen.add(point.id);
    out.push({
      kind: "decision",
      id: point.id,
      status: point.status,
      detail: typeof point.detail === "string" ? point.detail : "",
      origin: "stored",
    });
  }
  return out;
}

/** 기술적 확인 항목이 지목하는 D 측면. D 측면 자체의 표시 제목과의 부분 일치로만 판정한다
 * (업무 키워드 타이핑이 아니다). 지목하지 않으면 null이다. */
function decisionAspectOfCheck(topic: string): DecisionPointId | null {
  for (const id of DECISION_POINT_IDS) {
    if (topic.includes(DECISION_DISPLAY[id].title)) return id;
  }
  return null;
}

/**
 * 진단에서 통합 목록 초안을 도출한다.
 * - 저장된 D 행(상태 무관) + 저장된 범용 규칙은 그대로 두고, 없는 측면만 후보로 채운다.
 * - 후보는 미확정 / 적용 여부 미확정 상태로만 만든다 (자동 확정·자동 해당 없음 없음).
 */
export function deriveUnifiedRules(diagnosis: AxDiagnosis, storedGeneric?: readonly GenericRule[] | null): UnifiedRuleDraft[] {
  const asIs = diagnosis.asIs ?? {};
  const poc = diagnosis.poc ?? {};
  const inputs = cleanList(asIs.inputs);
  const systems = cleanList(asIs.systems);
  const exceptions = cleanList(asIs.exceptions);
  const outputs = cleanList(asIs.outputs);
  const humanDecisions = cleanList(asIs.humanDecisions);
  const pocInputs = cleanList(poc.inputs);
  const success = cleanList(poc.success);
  const failure = cleanList(poc.failure);
  const checks = (diagnosis.technicalChecks ?? []).filter(
    item => item && typeof item.topic === "string" && item.topic.trim()
      && (item.status === "확인 필요" || item.status === "불가"),
  );
  // 진단 추가 질문(followUpQuestions)은 사용자의 답이 필요한 확인 질문이므로 규칙 후보를
  // 만들지 않는다 (답변할 질문 영역에서 처리). 질문 문구가 규칙명이 되거나 답변 없이
  // 처리 기준이 생성되는 것을 막는다.

  const storedD = storedDecisionRows(diagnosis);
  const storedDIds = new Set(storedD.map(row => row.id));
  const storedDMap = new Map(storedD.map(row => [row.id, row]));

  // D 측면 신호 (구조적 필드만 사용).
  const d1Signal = inputs.length >= 2 || systems.length >= 2;
  const seenInputs = new Set<string>();
  let d2Signal = false;
  for (const item of [...inputs, ...pocInputs]) {
    const key = normalize(item);
    if (!key) continue;
    if (seenInputs.has(key)) { d2Signal = true; break; }
    seenInputs.add(key);
  }
  const d3Signal = exceptions.length >= 1;
  const d4Signal = success.length >= 1 || failure.length >= 1;
  const d6Signal = inputs.length >= 1;
  // 기술적 확인 항목이 지목하는 측면은 해당 D의 신호가 된다 (흡수 — 별도 범용 후보를 만들지 않는다).
  const checkAspect = new Map<string, DecisionPointId>();
  for (const check of checks) {
    const aspect = decisionAspectOfCheck(check.topic);
    if (aspect) checkAspect.set(check.topic, aspect);
  }
  const d7Signal = [...checkAspect.values()].includes("D7");
  const storedConfirmedD4 = storedDMap.get("D4")?.status === "확정";
  const d5Signal = (d4Signal || storedConfirmedD4)
    && (diagnosis.decisionGate?.verdict !== "go"
      || diagnosis.informationSufficiency !== "sufficient"
      || checks.length >= 1);
  const signals: Partial<Record<DecisionPointId, { sourceLabel: string; provenance: string }>> = {
    ...(d1Signal ? { D1: { sourceLabel: "진단에서 도출", provenance: `다중 입력·시스템(${inputs.length}건 입력, ${systems.length}건 시스템)에서 도출` } } : {}),
    ...(d2Signal ? { D2: { sourceLabel: "진단에서 도출", provenance: "입력 항목에 중복된 값이 있어 도출" } } : {}),
    ...(d3Signal ? { D3: { sourceLabel: "진단에서 도출", provenance: `AS-IS 예외 항목 ${exceptions.length}건에서 도출` } } : {}),
    ...(d4Signal ? { D4: { sourceLabel: "진단에서 도출", provenance: "예상 성공·실패 기준이 있어 도출" } } : {}),
    ...(d5Signal ? { D5: { sourceLabel: "진단에서 도출", provenance: "결과 상태(D4) 확정 후 판단 불가 처리가 필요해 도출" } } : {}),
    ...(d6Signal ? { D6: { sourceLabel: "진단에서 도출", provenance: "입력 항목이 있어 빈 입력 처리가 필요해 도출" } } : {}),
    ...(d7Signal ? { D7: { sourceLabel: "진단에서 도출", provenance: "기술적 확인 항목에서 계산 기준이 지목되어 도출" } } : {}),
  };
  for (const [topic, aspect] of checkAspect) {
    if (!signals[aspect]) {
      signals[aspect] = {
        sourceLabel: "진단에서 도출",
        provenance: `기술적 확인 항목 "${topic}"에서 도출`,
      };
    }
  }

  // D 행: D1~D7 순서. 저장 행이 있으면 저장 행, 없으면 신호가 있는 측면만 후보로.
  const dRows: UnifiedDecisionDraft[] = [];
  for (const id of DECISION_POINT_IDS) {
    const stored = storedDMap.get(id);
    if (stored) { dRows.push(stored); continue; }
    const signal = signals[id];
    if (!signal) continue;
    dRows.push({ kind: "decision", id, status: "미확정", detail: "", origin: "candidate", sourceLabel: signal.sourceLabel, provenance: signal.provenance });
  }

  // 범용 행: 저장 행(저장 순서) + 후보.
  const resolvedStored = resolveGenericRules(storedGeneric);
  const storedNames = new Set(resolvedStored.map(rule => normalize(rule.name)));
  const genericRows: UnifiedGenericDraft[] = resolvedStored.map(rule => ({
    kind: "generic" as const,
    id: rule.id,
    name: rule.name,
    category: rule.category,
    applicability: rule.applicability,
    status: rule.status,
    detail: rule.detail ?? "",
    source: rule.source ?? "",
    step: rule.step ?? "",
    ...(rule.linkedDecisionId ? { linkedDecisionId: rule.linkedDecisionId } : {}),
    origin: "stored" as const,
  }));
  const candidateNames = new Set<string>();
  const pushGenericCandidate = (candidate: UnifiedGenericDraft): void => {
    const key = normalize(candidate.name);
    if (!key || candidateNames.has(key)) return;
    if (storedNames.has(key)) {
      // 저장된 규칙이 진단 도출 후보와 같은 이름이면 그 후보에서 저장된 것이다: 화면 표시용
      // 도출 근거만 붙이고(저장 계약에는 없음) 후보를 다시 만들지 않는다.
      const stored = genericRows.find(row => row.origin === "stored" && normalize(row.name) === key);
      if (stored && !stored.provenance) stored.provenance = candidate.provenance;
      return;
    }
    // 확인 질문(정보 요청)은 처리 기준이 아니므로 어떤 출처에서 오든 후보로 만들지 않는다.
    if (isConfirmationQuestion(candidate.name)) return;
    candidateNames.add(key);
    genericRows.push(candidate);
  };
  // 측면을 지목하지 않은 기술적 확인 항목 → 범용 후보.
  for (const check of checks) {
    if (checkAspect.has(check.topic)) continue;
    pushGenericCandidate({
      kind: "generic",
      id: null,
      name: check.topic.trim(),
      category: "예외·확인 기준",
      applicability: "적용 여부 미확정",
      status: "미확정",
      detail: "",
      source: "",
      step: "",
      origin: "candidate",
      sourceLabel: "진단에서 도출",
      provenance: `기술적 확인 항목 "${check.topic.trim()}"(${check.status})에서 도출`,
    });
  }
  // AS-IS 사람 판단 항목 → 범용 후보.
  for (const item of humanDecisions) {
    pushGenericCandidate({
      kind: "generic",
      id: null,
      name: item,
      category: "권한·검토 기준",
      applicability: "적용 여부 미확정",
      status: "미확정",
      detail: "",
      source: "",
      step: "",
      origin: "candidate",
      sourceLabel: "진단에서 도출",
      provenance: `AS-IS 사람 판단 항목 "${item}"에서 도출`,
    });
  }
  // 출력은 있으나 완료 기준이 정리되지 않은 경우 → 범용 후보 1개.
  if (outputs.length >= 1 && success.length === 0) {
    pushGenericCandidate({
      kind: "generic",
      id: null,
      name: "완료 기준 정리",
      category: "출력·완료 기준",
      applicability: "적용 여부 미확정",
      status: "미확정",
      detail: "",
      source: "",
      step: "",
      origin: "candidate",
      sourceLabel: "진단에서 도출",
      provenance: "출력 항목은 있으나 완료 기준이 정리되지 않아 도출",
    });
  }

  return [...dRows, ...genericRows];
}

/** 도출 신호 출처가 하나라도 있는지. 빈 목록의 성격을 구분하는 데 쓴다.
 * 추가 질문은 규칙 후보를 만들지 않으므로 도출 신호가 아니다. */
export function hasDerivationSignals(diagnosis: AxDiagnosis): boolean {
  const asIs = diagnosis.asIs ?? {};
  const poc = diagnosis.poc ?? {};
  return cleanList(asIs.inputs).length >= 1
    || cleanList(asIs.systems).length >= 1
    || cleanList(asIs.outputs).length >= 1
    || cleanList(asIs.exceptions).length >= 1
    || cleanList(asIs.humanDecisions).length >= 1
    || cleanList(poc.inputs).length >= 1
    || cleanList(poc.success).length >= 1
    || cleanList(poc.failure).length >= 1
    || (diagnosis.technicalChecks ?? []).some(item => item && (item.status === "확인 필요" || item.status === "불가"));
}

/**
 * 업무 규칙 검토 완료율. 화면에 표시된 모든 검토 항목(카드 1장 = 1건)이 분모다.
 * 검토가 끝난 항목만 완료로 센다:
 * - D: 확정 또는 해당 없음(미적용) 결정 → 완료, 미확정 → 미완료.
 * - 범용: 해당 없음(미적용) 결정 또는 적용+확정 → 완료, 적용+미확정·적용 여부 미확정(선택 전) → 미완료.
 * 연계 D가 있어도 별도 카드로 각각 검토하므로 분모에서 빼지 않는다. 이 값은 검토 완료율이며
 * 구현 가능 여부(Gate·필수 조건)와는 별개다. applicabilityPending은 내부 참고용 건수다.
 */
export function unifiedRuleProgress(items: readonly UnifiedRuleDraft[]): RuleProgress {
  let done = 0;
  let applicabilityPending = 0;
  for (const item of items) {
    if (item.kind === "decision") {
      if (item.status !== "미확정") done += 1;
    } else if (item.applicability === "해당 없음" || (item.applicability === "적용" && item.status === "확정")) done += 1;
    else if (item.applicability === "적용 여부 미확정") applicabilityPending += 1;
  }
  return { done, total: items.length, applicabilityPending };
}

/** 통합 초안을 저장 페이로드로 변환한다. 기존 저장 계약을 유지한다. */
export function unifiedSavePayloads(
  drafts: readonly UnifiedRuleDraft[],
  storedGeneric: readonly GenericRule[],
): { points: DecisionPoint[]; rules: GenericRule[] } {
  // D: 저장된 미확정 상태·메모와 작성한 후보 메모도 보존한다 (§5.4).
  // 손대지 않은 빈 미확정 후보만 제외한다. 생성 경로의 확정 규칙 판정은 그대로 유지한다.
  const points: DecisionPoint[] = drafts
    .filter((item): item is UnifiedDecisionDraft => item.kind === "decision"
      && (item.status !== "미확정" || item.origin === "stored" || Boolean(item.detail.trim())))
    .map(item => ({
      id: item.id,
      status: item.status,
      ...(item.detail.trim() ? { detail: item.detail.trim() } : {}),
    }));
  // 범용: 이름 있는 행만 저장한다. 저장 행은 항상, 사용자 추가 행은 항상,
  // 후보 행은 사용자가 건드린 경우에만 저장한다 (미 터치 후보는 다음 렌더링에서 다시 도출된다).
  // id 부여는 저장된 id와 이미 부여된 초안 id 전체를 예약한 뒤 최대값+1부터 순차 부여한다.
  // (후보를 먼저 처리해도 모달에서 부여된 id와 충돌하지 않는다.)
  const reservedIds = new Set<string>([
    ...storedGeneric.map(rule => rule.id),
    ...drafts.filter((item): item is UnifiedGenericDraft => item.kind === "generic" && Boolean(item.id)).map(item => item.id as string),
  ]);
  let maxId = 0;
  for (const id of reservedIds) {
    const match = /^R(\d+)$/u.exec(id);
    if (match) maxId = Math.max(maxId, Number(match[1]));
  }
  const pushedIds = new Set<string>();
  const rules: GenericRule[] = [];
  for (const item of drafts) {
    if (item.kind !== "generic") continue;
    if (!item.name.trim()) continue;
    if (item.origin === "candidate" && !item.touched) continue;
    let id = item.id;
    if (!id) {
      maxId += 1;
      id = `R${maxId}`;
    }
    if (pushedIds.has(id)) continue;
    pushedIds.add(id);
    rules.push({
      id,
      name: item.name.trim(),
      category: item.category,
      ...(item.detail.trim() ? { detail: item.detail.trim() } : {}),
      ...(item.source.trim() ? { source: item.source.trim() } : {}),
      ...(item.step.trim() ? { step: item.step.trim() } : {}),
      applicability: item.applicability,
      status: item.status,
      ...(item.linkedDecisionId ? { linkedDecisionId: item.linkedDecisionId } : {}),
    });
  }
  return { points, rules };
}

/** D4 확정 상태 목록 (초안 기준). D5 선택형 UI용. confirmedStateNames와 동일한 의미다. */
export function draftStateNames(drafts: readonly UnifiedRuleDraft[]): string[] | null {
  const d4 = drafts.find((item): item is UnifiedDecisionDraft => item.kind === "decision" && item.id === "D4");
  if (!d4 || d4.status !== "확정" || !d4.detail.trim()) return null;
  const names = parseStateNames(d4.detail);
  return names.length ? names : null;
}
