"use client";

import { useRef, useState } from "react";
import { ChevronDown, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DECISION_POINT_DEFS } from "@/lib/ax/decision-points";
import { GENERIC_RULE_CATEGORIES, GENERIC_RULE_STATUSES } from "@/lib/ax/schema";
import { resolveGenericRules } from "@/lib/ax/generic-rules";
import {
  DECISION_DISPLAY,
  decisionPanelLabel,
  deriveUnifiedRules,
  draftStateNames,
  hasDerivationSignals,
  unifiedRuleProgress,
  unifiedSavePayloads,
  type UnifiedDecisionDraft,
  type UnifiedGenericDraft,
  type UnifiedRuleDraft,
} from "@/lib/ax/rule-questions";
import type { AxDiagnosis, DecisionPoint, DecisionPointId, DecisionPointStatus, GenericRule, GenericRuleApplicability, GenericRuleCategory, GenericRuleStatus } from "@/lib/ax/types";

/**
 * 업무 규칙 확인 통합 편집 화면 (고정 D1~D7 + 별도 범용 카드의 대체).
 * - 하나의 "업무 규칙 확인" 영역만 유지한다. 저장된 행 + 진단에서 도출된 후보를
 *   하나의 카드 아코디언 목록으로 표시한다.
 * - 초안은 컴포넌트 상태에 두고, 저장 버튼으로 사용자 입력과 기존 미확정 메모도 보존한다.
 *   AI가 채운 값·도출된 후보는 저장 경로에 들어가지 않는다 (후보를 건드려 저장한 경우 제외).
 * - 범용 규칙은 규칙명·분류·업무 적용 여부(적용/미적용, 미선택은 "선택하세요"로 보존)·처리 기준·확정 상태를
 *   보여 주고, 기존 결정 항목 연결·근거 자료·적용 단계는 "추가 정보 (선택)"(기본 접힘)에 둔다.
 * - "+ 규칙 추가"는 목록 맨 아래에 신규 항목을 인라인으로 열고, "추가"는 초안에만
 *   반영한다. 최종 영속 저장은 통합 저장 버튼으로 수행한다.
 */

/** 표시 전용 상태 배지: D·범용 모두 미확정 / 확정 / 미적용으로 통일한다 (내부 상태값은 유지). */
const STATUS_BADGE: Record<DecisionPointStatus, string> = {
  "확정": "확정",
  "미확정": "미확정",
  "해당 없음": "미적용",
};
/** D규칙 상태 선택지: 확정 → 미확정 순서 (기본값 미확정). 과거에 "해당 없음"으로 저장된 D규칙만
 * 현재 값을 그대로 보여 주고 다른 값으로 바꿀 수 있도록 그 행에 한해 "미적용" 선택지를 덧붙인다(자동 변환 없음). */
const DECISION_STATUS_OPTIONS = [
  { value: "확정" as const, label: "확정" },
  { value: "미확정" as const, label: "미확정" },
];
const LEGACY_NOT_APPLICABLE_OPTION = { value: "해당 없음" as const, label: "미적용" };
/** 업무 적용 여부: 적용 / 미적용 두 가지. 미선택(적용 여부 미확정)은 선택지가 아니라 "선택하세요" 빈 선택 상태로 보인다. */
const APPLICABILITY_OPTIONS = [
  { value: "적용" as const, label: "적용" },
  { value: "해당 없음" as const, label: "미적용" },
];

/** 결정 지점 상세 입력 제한. 카운터 표시 기준이며 저장 의미를 바꾸지 않는다. */
const DECISION_DETAIL_MAX_LENGTH = 2000;
/** 범용 규칙 입력 상한: 저장 스키마(genericRuleSchema)와 같은 값이다. */
const RULE_NAME_MAX_LENGTH = 120;
const RULE_DETAIL_MAX_LENGTH = 2000;
const RULE_SOURCE_MAX_LENGTH = 500;
const RULE_STEP_MAX_LENGTH = 500;

/** 기본 입력 문구. */
const APPLICABILITY_LABEL = "업무 적용 여부";
const DETAIL_LABEL = "처리 기준";
const STATUS_LABEL = "확정 상태";
const DETAIL_HINT = "적용 조건, 처리 방법, 예외 및 결과 처리 기준을 작성하세요.";

const NEW_RULE_KEY = "new-rule";

/** 범용 규칙 배지 상태: 적용 여부 선택 전과 적용+미확정은 모두 "미확정"으로 보이지만
 * 내부 상태(applicability·status)는 그대로 구분된다. */
const genericBadgeStatus = (rule: UnifiedGenericDraft): DecisionPointStatus =>
  rule.applicability === "해당 없음" ? "해당 없음"
  : rule.applicability === "적용" && rule.status === "확정" ? "확정"
  : "미확정";

/** 범용 행의 안정 키. 저장·사용자 행은 id, 후보는 도출 근거(개명해도 유지된다). */
const genericKey = (rule: UnifiedGenericDraft): string =>
  rule.id ?? `candidate:${rule.provenance ?? rule.name}`;

/** 범용 규칙 입력값. 신규 항목은 분류·적용 여부·확정 상태를 사용자가 고르기 전까지 빈 값이다. */
interface GenericRuleFieldValues {
  name: string;
  category: GenericRuleCategory | "";
  applicability: GenericRuleApplicability | "";
  status: GenericRuleStatus | "";
  linkedDecisionId?: DecisionPointId;
  detail: string;
  source: string;
  step: string;
}

interface NewRuleErrors {
  name?: string;
  category?: string;
  applicability?: string;
  duplicate?: string;
}

/** 신규 규칙: 확정 상태는 기본 미확정, 분류·업무 적용 여부는 사용자가 고르기 전까지 빈 값("선택하세요"). */
const emptyNewRule: GenericRuleFieldValues = { name: "", category: "", applicability: "", status: "미확정", detail: "", source: "", step: "" };

/** 규칙 선택창: D규칙·범용 규칙의 모든 선택 항목이 같은 COSS 흰색 Select를 쓴다. */
function RuleSelect<T extends string>({ label, value, options, placeholder = "선택하세요", disabled, error, onChange }: {
  label: string;
  value: T | "";
  options: readonly { value: T | ""; label: string }[];
  placeholder?: string;
  disabled?: boolean;
  error?: string;
  onChange: (value: T | "") => void;
}) {
  const hasEmptyOption = options.some(option => option.value === "");
  return <label className="ax-field ax-rule-field">
    <span>{label}</span>
    <Select<string | null> value={value === "" && !hasEmptyOption ? null : value} disabled={disabled} onValueChange={next => onChange((next ?? "") as T | "")}>
      <SelectTrigger className="ax-rule-select" aria-label={label} aria-invalid={error ? true : undefined}>
        <SelectValue placeholder={placeholder}>{(current: string | null) => options.find(option => option.value === (current ?? ""))?.label ?? placeholder}</SelectValue>
      </SelectTrigger>
      {/* 목록은 항상 선택창 아래, 선택창과 같은 너비로 연다 (선택값 위치로 목록이 위로 이동하지 않는다). */}
      <SelectContent alignItemWithTrigger={false} style={{ width: "var(--anchor-width)" }}>
        {options.map(option => <SelectItem key={option.value || "empty"} value={option.value}>{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
    {error ? <span className="ax-rule-error" role="alert">{error}</span> : null}
  </label>;
}

const plainOptions = <T extends string>(values: readonly T[]) => values.map(value => ({ value, label: value }));
const LINKED_DECISION_OPTIONS = [
  { value: "" as const, label: "연계 없음" },
  ...(Object.entries(DECISION_DISPLAY) as [DecisionPointId, { title: string }][]).map(([id, entry]) => ({ value: id, label: `${id} ${entry.title}` })),
];

/** 범용 규칙 입력: 규칙명·분류·업무 적용 여부·처리 기준·확정 상태 + 추가 정보(선택, 기본 접힘).
 * 저장 행·후보·신규 항목이 같은 UI를 쓴다. 미적용이면 처리 기준·확정 상태 입력을 숨기되 값은
 * 지우지 않는다(다시 적용으로 바꾸면 그대로 복구된다). 후보 도출 근거는 내부 데이터로만 유지한다.
 * derived: 진단에서 도출된 규칙(후보, 또는 후보에서 저장된 규칙)은 규칙명·분류가 카드 제목·보조
 * 문구에 이미 보이므로 입력창을 기본 숨기고 "규칙명·분류 수정"으로만 연다. 값은 그대로 유지된다
 * (분류가 비어 있으면 숨기지 않는다). */
function GenericRuleFields({ value, onChange, disabled, errors, detailsOpen, onDetailsOpenChange, derived = false }: {
  value: GenericRuleFieldValues;
  onChange: (patch: Partial<GenericRuleFieldValues>) => void;
  disabled?: boolean;
  errors?: NewRuleErrors;
  detailsOpen: boolean;
  onDetailsOpenChange: (open: boolean) => void;
  derived?: boolean;
}) {
  const notApplicable = value.applicability === "해당 없음";
  const [editIdentity, setEditIdentity] = useState(false);
  const showName = !derived || editIdentity || !value.name.trim();
  const showCategory = !derived || editIdentity || !value.category;
  return <>
    {derived && !editIdentity ? <div className="ax-rule-identity-edit">
      <Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={() => setEditIdentity(true)}>규칙명·분류 수정</Button>
    </div> : null}
    {showName ? <label className="ax-field ax-rule-field">
      <span>규칙명</span>
      <Input value={value.name} maxLength={RULE_NAME_MAX_LENGTH} disabled={disabled} aria-invalid={errors?.name || errors?.duplicate ? true : undefined}
        onChange={event => onChange({ name: event.target.value })} placeholder="예: 월말 마감이 지난 주문은 다음 달 집계에 포함하지 않는다" />
      {errors?.name ? <span className="ax-rule-error" role="alert">{errors.name}</span> : null}
      {errors?.duplicate ? <span className="ax-rule-error" role="alert">{errors.duplicate}</span> : null}
    </label> : null}
    {showCategory ? <RuleSelect label="분류" value={value.category} options={plainOptions(GENERIC_RULE_CATEGORIES)} disabled={disabled} error={errors?.category}
      onChange={category => onChange({ category })} /> : null}
    <RuleSelect label={APPLICABILITY_LABEL} value={value.applicability === "적용 여부 미확정" ? "" : value.applicability} options={APPLICABILITY_OPTIONS}
      disabled={disabled} onChange={applicability => { if (applicability) onChange({ applicability }); }} />
    {notApplicable ? null : <>
      <label className="ax-field ax-rule-field">
        <span>{DETAIL_LABEL}</span>
        <Textarea value={value.detail} maxLength={RULE_DETAIL_MAX_LENGTH} disabled={disabled} rows={3} placeholder={DETAIL_HINT}
          onChange={event => onChange({ detail: event.target.value })} />
      </label>
      <RuleSelect label={STATUS_LABEL} value={value.status} options={plainOptions(GENERIC_RULE_STATUSES)} disabled={disabled}
        onChange={status => onChange({ status })} />
    </>}
    <Collapsible className="ax-rule-details" open={detailsOpen} onOpenChange={onDetailsOpenChange}>
      <CollapsibleTrigger className="ax-rule-details-trigger">
        추가 정보 (선택)
        <ChevronDown size={16} aria-hidden="true" className={detailsOpen ? "is-open" : ""} />
      </CollapsibleTrigger>
      <CollapsiblePanel className="ax-rule-details-panel">
        <div className="ax-rule-details-grid">
          <RuleSelect label="기존 결정 항목 연결 (선택)" value={value.linkedDecisionId ?? ""} options={LINKED_DECISION_OPTIONS} disabled={disabled}
            onChange={linked => onChange({ linkedDecisionId: linked || undefined })} />
          <label className="ax-field ax-rule-field">
            <span>근거 자료 (선택)</span>
            <Input value={value.source} maxLength={RULE_SOURCE_MAX_LENGTH} disabled={disabled} onChange={event => onChange({ source: event.target.value })} placeholder="예: 매뉴얼 3장, 담당 확인 메일" />
          </label>
          <label className="ax-field ax-rule-field">
            <span>적용 단계 (선택)</span>
            <Input value={value.step} maxLength={RULE_STEP_MAX_LENGTH} disabled={disabled} onChange={event => onChange({ step: event.target.value })} placeholder="예: 월말 집계" />
          </label>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  </>;
}

export function UnifiedRulesSection({ diagnosis, genericRules, disabled: externallyDisabled, saveStatus, onSave }: {
  diagnosis: AxDiagnosis;
  /** 범용 규칙 (저장된 값 기준). */
  genericRules?: GenericRule[];
  disabled?: boolean;
  saveStatus: string;
  onSave: (points: DecisionPoint[], rules: GenericRule[]) => Promise<boolean>;
}) {
  // 저장 후 부모가 새 값을 내려주면 초안을 동기화한다 (effect가 아닌 렌더 중 조정 패턴).
  const draftsKey = JSON.stringify({ d: diagnosis.decisionPoints ?? [], g: resolveGenericRules(genericRules) });
  const [drafts, setDrafts] = useState<UnifiedRuleDraft[]>(() => deriveUnifiedRules(diagnosis, genericRules));
  const [prevDraftsKey, setPrevDraftsKey] = useState(draftsKey);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [submittedDraftsKey, setSubmittedDraftsKey] = useState<string | null>(null);
  // Parent state updates precede persistence. Keep the exact draft until saving succeeds.
  if (prevDraftsKey !== draftsKey && saveState !== "saving") {
    setPrevDraftsKey(draftsKey);
    if (saveState !== "failed" || draftsKey !== submittedDraftsKey) {
      setDrafts(deriveUnifiedRules(diagnosis, genericRules));
    }
  }
  const disabled = externallyDisabled || saveState === "saving";
  // 펼침 상태는 초안과 별개로 유지한다: 접었다 펴도 미저장 입력값이 사라지지 않는다.
  // 기본값은 모두 접힘(한 번에 한 항목만 펼침).
  const [openKey, setOpenKey] = useState<string | null>(null);
  // 항목별 추가 정보 펼침 (기본 접힘).
  const [detailsOpen, setDetailsOpen] = useState<ReadonlySet<string>>(() => new Set());
  // 인라인 신규 항목: "추가" 전까지 초안 목록과 분리된 작성 중 상태다.
  const [newRule, setNewRule] = useState<GenericRuleFieldValues | null>(null);
  const [newRuleErrors, setNewRuleErrors] = useState<NewRuleErrors>({});
  const savingRef = useRef(false);

  // 업무 규칙 검토 완료율: 화면의 모든 검토 항목이 분모, 확정·미적용 결정이 완료.
  const progress = unifiedRuleProgress(drafts);
  const progressText = progress.total
    ? `${progress.done}/${progress.total} 완료`
    : "확인할 규칙 없음";

  const setDetailsOpenFor = (key: string, open: boolean) =>
    setDetailsOpen(current => {
      const next = new Set(current);
      if (open) next.add(key); else next.delete(key);
      return next;
    });
  const updateDecision = (id: string, patch: Partial<UnifiedDecisionDraft>) =>
    setDrafts(current => current.map(item => item.kind === "decision" && item.id === id ? { ...item, ...patch } : item));
  const updateGeneric = (key: string, patch: Partial<GenericRuleFieldValues>) => {
    setSaveState("idle");
    // 저장 행·후보의 분류·적용 여부·확정 상태 선택창에는 빈 선택지가 없어 항상 저장 계약 값이 온다.
    setDrafts(current => current.map(item =>
      item.kind === "generic" && genericKey(item) === key ? { ...item, ...(patch as Partial<UnifiedGenericDraft>), touched: true } : item));
  };

  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaveState("saving");
    try {
      // 저장된 미확정 D와 작성한 메모는 보존하고, 미터치 빈 후보는 저장하지 않는다.
      const { points, rules } = unifiedSavePayloads(drafts, resolveGenericRules(genericRules));
      setSubmittedDraftsKey(JSON.stringify({ d: points, g: resolveGenericRules(rules) }));
      setSaveState(await onSave(points, rules) ? "saved" : "failed");
    } catch {
      setSaveState("failed");
    } finally {
      savingRef.current = false;
    }
  };

  const startNewRule = () => {
    setNewRule(emptyNewRule);
    setNewRuleErrors({});
    setDetailsOpenFor(NEW_RULE_KEY, false);
    setOpenKey(NEW_RULE_KEY);
  };

  const cancelNewRule = () => {
    setNewRule(null);
    setNewRuleErrors({});
    setDetailsOpenFor(NEW_RULE_KEY, false);
    if (openKey === NEW_RULE_KEY) setOpenKey(null);
  };

  const addNewRule = () => {
    if (!newRule) return;
    const errors: NewRuleErrors = {};
    const name = newRule.name.trim();
    if (!name) errors.name = "규칙명을 입력하세요.";
    // 업무 적용 여부는 미선택(적용 여부 미확정)으로 둘 수 있다. 확정 상태는 기본 미확정이다.
    if (!newRule.category) errors.category = "분류를 선택하세요.";
    if (name) {
      const key = name.replace(/\s+/gu, " ").trim();
      const clash = drafts.some(item =>
        item.kind === "generic" && item.name.replace(/\s+/gu, " ").trim() === key);
      if (clash) errors.duplicate = "이미 같은 이름의 규칙이 있습니다. 기존 규칙을 편집하세요.";
    }
    setNewRuleErrors(errors);
    if (Object.keys(errors).length) return;
    // 저장+초안 합산 기준 다음 id. 후보는 id를 소비하지 않는다.
    let max = 0;
    for (const item of drafts) {
      if (item.kind !== "generic" || !item.id) continue;
      const match = /^R(\d+)$/u.exec(item.id);
      if (match) max = Math.max(max, Number(match[1]));
    }
    const id = `R${max + 1}`;
    const rule: UnifiedGenericDraft = {
      kind: "generic",
      id,
      name,
      category: newRule.category as GenericRuleCategory,
      applicability: (newRule.applicability || "적용 여부 미확정") as GenericRuleApplicability,
      status: (newRule.status || "미확정") as GenericRuleStatus,
      detail: newRule.detail,
      source: newRule.source,
      step: newRule.step,
      ...(newRule.linkedDecisionId ? { linkedDecisionId: newRule.linkedDecisionId } : {}),
      origin: "user",
      touched: true,
    };
    // 작성한 위치(목록 맨 아래)에 그대로 추가한다.
    setDrafts(current => [...current, rule]);
    setDetailsOpenFor(id, detailsOpen.has(NEW_RULE_KEY));
    setDetailsOpenFor(NEW_RULE_KEY, false);
    setNewRule(null);
    setNewRuleErrors({});
    setOpenKey(id);
    setSaveState("idle");
  };

  // D5 선택형 UI용 D4 확정 상태 목록 (초안 기준). D4 미확정 시에는 기존 자유 입력 유지한다.
  const d4States = draftStateNames(drafts);
  const emptyText = hasDerivationSignals(diagnosis)
    ? "확인 대상 규칙이 없습니다."
    : "진단 정보가 부족해 규칙을 도출하지 못했습니다. 업무에 실제로 필요한 규칙이 있으면 '+ 규칙 추가'로 근거와 함께 추가하세요.";
  const newRuleOpen = openKey === NEW_RULE_KEY;

  return <section className="ax-surface ax-decision" id="ax-decision-points" aria-label="업무 규칙 확인">
    <div className="ax-decision-head">
      <div>
        <h3>업무 규칙 확인</h3>
        <p className="ax-muted">자동화에 필요한 업무 규칙을 확인합니다. 확정된 내용은 올인원 지시문에 반영됩니다.</p>
      </div>
      <div className="ax-decision-progress">
        <strong>{progressText}</strong>
        <span className="ax-decision-bar" aria-hidden="true"><span style={{ width: `${progress.total ? progress.done / progress.total * 100 : 0}%` }} /></span>
        <Button type="button" variant="outline" size="sm" className="ax-decision-add" disabled={disabled || newRule !== null} onClick={startNewRule}>+ 규칙 추가</Button>
      </div>
    </div>
    {drafts.length || newRule ? <div className="ax-decision-list">
      {drafts.map(item => {
        if (item.kind === "decision") {
          const def = DECISION_POINT_DEFS.find(entry => entry.id === item.id)!;
          const display = DECISION_DISPLAY[item.id];
          const isOpen = openKey === item.id;
          // D5: D4 확정 목록이 있으면 선택형으로 표시한다. 목록 외 기존값은
          // 그대로 보여주고 불일치를 안내하며, 저장 시까지 기존값을 유지한다.
          const d5Mismatch = item.id === "D5" && d4States && item.detail?.trim() ? !d4States.includes(item.detail.trim()) : false;
          return <div className={`ax-decision-row${isOpen ? " is-open" : ""}`} id={`ax-decision-${item.id}`} key={item.id} data-status={item.status}>
            <button type="button" className="ax-decision-row-head" aria-expanded={isOpen} disabled={disabled}
              onClick={() => setOpenKey(isOpen ? null : item.id)}>
              <span className="ax-decision-no">{item.id}</span>
              <span className="ax-decision-title"><strong>{display.title}</strong><small>{display.question}</small></span>
              <span className="ax-decision-badge" data-status={item.status}>{STATUS_BADGE[item.status]}</span>
              <ChevronDown size={18} aria-hidden="true" className={isOpen ? "is-open" : ""} />
            </button>
            {isOpen ? <div className="ax-decision-panel">
              <RuleSelect label={decisionPanelLabel(item.id, "상태")} value={item.status} options={item.status === "해당 없음" ? [...DECISION_STATUS_OPTIONS, LEGACY_NOT_APPLICABLE_OPTION] : DECISION_STATUS_OPTIONS} disabled={disabled}
                onChange={status => { if (status) { updateDecision(item.id, { status }); setSaveState("idle"); } }} />
              {item.status === "해당 없음" ? null : item.id === "D5" && d4States ? <>
                <RuleSelect label={decisionPanelLabel(item.id, "상세")} value={item.detail ?? ""} disabled={disabled}
                  options={[
                    { value: "", label: "선택하세요" },
                    ...(d5Mismatch ? [{ value: item.detail, label: `${item.detail} (결과 상태 (D4) 목록 외 값)` }] : []),
                    ...d4States.map(name => ({ value: name, label: name })),
                  ]}
                  onChange={detail => { updateDecision(item.id, { detail }); setSaveState("idle"); }} />
                {d5Mismatch ? <p className="ax-muted" role="status">현재 값이 결과 상태 (D4) 목록에 없습니다. 결과 상태 (D4) 중 하나로 수정하세요. 수정 전까지 기존값이 유지됩니다.</p> : null}
              </> : <label className="ax-field">{decisionPanelLabel(item.id, "상세")}
                <Textarea rows={4} maxLength={DECISION_DETAIL_MAX_LENGTH} aria-label={decisionPanelLabel(item.id, "상세")} placeholder={def.detailHint} disabled={disabled}
                  value={item.detail ?? ""} onChange={e => { updateDecision(item.id, { detail: e.target.value }); setSaveState("idle"); }} />
                <span className="ax-decision-counter">{(item.detail ?? "").length} / {DECISION_DETAIL_MAX_LENGTH}</span>
              </label>}
            </div> : null}
          </div>;
        }
        const key = genericKey(item);
        const isOpen = openKey === key;
        return <div className={`ax-decision-row${isOpen ? " is-open" : ""}`} id={item.id ? `ax-rule-${item.id}` : undefined} key={key} data-status={item.status}>
          <button type="button" className="ax-decision-row-head" aria-expanded={isOpen} disabled={disabled}
            onClick={() => setOpenKey(isOpen ? null : key)}>
            {item.id
              ? <span className="ax-decision-no">{item.id}</span>
              : <span className="ax-decision-no ax-decision-no-new">신규</span>}
            <span className="ax-decision-title"><strong>{item.name.trim() || "새 규칙"}</strong><small>{item.category}</small></span>
            <span className="ax-decision-badge" data-status={genericBadgeStatus(item)}>{STATUS_BADGE[genericBadgeStatus(item)]}</span>
            <ChevronDown size={18} aria-hidden="true" className={isOpen ? "is-open" : ""} />
          </button>
          {isOpen ? <div className="ax-generic-panel">
            <GenericRuleFields value={item} disabled={disabled} onChange={patch => updateGeneric(key, patch)}
              derived={item.origin === "candidate" || (item.origin === "stored" && Boolean(item.provenance))}
              detailsOpen={detailsOpen.has(key)} onDetailsOpenChange={open => setDetailsOpenFor(key, open)} />
            {item.origin === "candidate" ? null : <div className="ax-rule-actions">
              <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => { setSaveState("idle"); setDrafts(current => current.filter(entry => !(entry.kind === "generic" && genericKey(entry) === key))); }}>
                <Trash2 size={16} /> 이 규칙 삭제
              </Button>
            </div>}
          </div> : null}
        </div>;
      })}
      {newRule ? <div className={`ax-decision-row ax-rule-new${newRuleOpen ? " is-open" : ""}`} id="ax-rule-new" data-status="신규">
        <button type="button" className="ax-decision-row-head" aria-expanded={newRuleOpen} disabled={disabled}
          onClick={() => setOpenKey(newRuleOpen ? null : NEW_RULE_KEY)}>
          <span className="ax-decision-no ax-decision-no-new">신규</span>
          <span className="ax-decision-title"><strong>{newRule.name.trim() || "새 규칙"}</strong>{newRule.category ? <small>{newRule.category}</small> : null}</span>
          <ChevronDown size={18} aria-hidden="true" className={newRuleOpen ? "is-open" : ""} />
        </button>
        {newRuleOpen ? <div className="ax-generic-panel">
          <GenericRuleFields value={newRule} disabled={disabled} errors={newRuleErrors}
            onChange={patch => setNewRule(current => current ? { ...current, ...patch } : current)}
            detailsOpen={detailsOpen.has(NEW_RULE_KEY)} onDetailsOpenChange={open => setDetailsOpenFor(NEW_RULE_KEY, open)} />
          <div className="ax-rule-actions">
            <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={cancelNewRule}>취소</Button>
            <Button type="button" size="sm" disabled={disabled} onClick={addNewRule}>추가</Button>
          </div>
        </div> : null}
      </div> : null}
    </div> : <p className="ax-muted">{emptyText}</p>}
    <div className="ax-decision-save">
      <Button type="button" disabled={disabled} onClick={save}>저장</Button>
      {saveState === "saved" && saveStatus === "이 브라우저에 저장됨" ? <p className="ax-muted" role="status">업무 규칙을 저장했습니다.</p> : null}
      {saveState === "failed" ? <p className="ax-muted" role="alert">업무 규칙을 저장하지 못했습니다. 입력 내용은 유지됩니다. 저장 상태를 확인하고 다시 시도하세요.</p> : null}
    </div>
  </section>;
}
