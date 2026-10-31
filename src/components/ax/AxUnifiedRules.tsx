"use client";

import { useRef, useState } from "react";
import { ChevronDown, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogPopup } from "@/components/ui/dialog";
import { DECISION_POINT_DEFS } from "@/lib/ax/decision-points";
import { GENERIC_RULE_APPLICABILITY, GENERIC_RULE_CATEGORIES, GENERIC_RULE_STATUSES } from "@/lib/ax/schema";
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
import type { AxDiagnosis, DecisionPoint, DecisionPointId, GenericRule, GenericRuleApplicability, GenericRuleCategory, GenericRuleStatus } from "@/lib/ax/types";

/**
 * 업무 규칙 확인 통합 편집 화면 (고정 D1~D7 + 별도 범용 카드의 대체).
 * - 하나의 "업무 규칙 확인" 영역만 유지한다. 저장된 행 + 진단에서 도출된 후보를
 *   하나의 카드 아코디언 목록으로 표시한다.
 * - 초안은 컴포넌트 상태에 두고, 저장 버튼으로 사용자 입력과 기존 미확정 메모도 보존한다.
 *   AI가 채운 값·도출된 후보는 저장 경로에 들어가지 않는다 (후보를 건드려 저장한 경우 제외).
 * - 모달 추가는 통합 목록 초안 추가이며, 최종 영속 저장은 통합 저장 버튼으로 수행한다.
 */

/** 표시 전용 D 상태 배지 문구 (기존 DecisionPointsSection과 동일). */
const DECISION_BADGE: Record<UnifiedDecisionDraft["status"], string> = {
  "확정": "확정됨",
  "미확정": "미확정",
  "해당 없음": "해당 없음",
};

/** 결정 지점 상세 입력 제한. 카운터 표시 기준이며 저장 의미를 바꾸지 않는다. */
const DECISION_DETAIL_MAX_LENGTH = 2000;

/** 규칙 추가 모달 입력 상한 (레퍼런스 2 카운터 기준. 저장 정리 상한과는 별개다). */
const MODAL_NAME_MAX_LENGTH = 200;
const MODAL_DETAIL_MAX_LENGTH = 1000;
const MODAL_SOURCE_MAX_LENGTH = 200;
const MODAL_STEP_MAX_LENGTH = 200;

const genericBadge = (rule: UnifiedGenericDraft): string =>
  rule.applicability === "해당 없음" ? "해당 없음"
  : rule.applicability === "적용 여부 미확정" ? "적용 여부 확인 필요"
  : rule.status;

/** 범용 행의 안정 키. 저장·사용자 행은 id, 후보는 도출 근거(개명해도 유지된다). */
const genericKey = (rule: UnifiedGenericDraft): string =>
  rule.id ?? `candidate:${rule.provenance ?? rule.name}`;

interface ModalForm {
  name: string;
  category: string;
  applicability: string;
  status: string;
  linkedDecisionId: string;
  detail: string;
  source: string;
  step: string;
}

const emptyModalForm: ModalForm = {
  name: "",
  category: "",
  applicability: "",
  status: "",
  linkedDecisionId: "",
  detail: "",
  source: "",
  step: "",
};

interface ModalErrors {
  name?: string;
  category?: string;
  applicability?: string;
  status?: string;
  duplicate?: string;
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
  const submittedDraftsKey = useRef<string | null>(null);
  // Parent state updates precede persistence. Keep the exact draft until saving succeeds.
  if (prevDraftsKey !== draftsKey && saveState !== "saving") {
    setPrevDraftsKey(draftsKey);
    if (saveState !== "failed" || draftsKey !== submittedDraftsKey.current) {
      setDrafts(deriveUnifiedRules(diagnosis, genericRules));
    }
  }
  const disabled = externallyDisabled || saveState === "saving";
  // 펼침 상태는 초안과 별개로 유지한다: 접었다 펴도 미저장 입력값이 사라지지 않는다.
  // 기본값은 모두 접힘(한 번에 한 항목만 펼침).
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalForm, setModalForm] = useState<ModalForm>(emptyModalForm);
  const [modalErrors, setModalErrors] = useState<ModalErrors>({});
  const savingRef = useRef(false);

  // 진행 현황: 통합 초안 기준. 분모는 실제로 적용되는 확인 대상 규칙 수이며,
  // 해당 없음은 분모에서 빠진다. 적용 여부 미확정은 별도 건수다.
  const progress = unifiedRuleProgress(drafts);
  const progressText = progress.total
    ? `${progress.done}/${progress.total} 확인 완료`
    : "확인할 규칙 없음";
  const progressSuffix = progress.applicabilityPending
    ? ` · 적용 여부 확인 ${progress.applicabilityPending}건`
    : "";

  const updateDecision = (id: string, patch: Partial<UnifiedDecisionDraft>) =>
    setDrafts(current => current.map(item => item.kind === "decision" && item.id === id ? { ...item, ...patch } : item));
  const updateGeneric = (key: string, patch: Partial<UnifiedGenericDraft>) => {
    setSaveState("idle");
    setDrafts(current => current.map(item =>
      item.kind === "generic" && genericKey(item) === key ? { ...item, ...patch, touched: true } : item));
  };

  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaveState("saving");
    try {
      // 저장된 미확정 D와 작성한 메모는 보존하고, 미터치 빈 후보는 저장하지 않는다.
      const { points, rules } = unifiedSavePayloads(drafts, resolveGenericRules(genericRules));
      submittedDraftsKey.current = JSON.stringify({ d: points, g: resolveGenericRules(rules) });
      setSaveState(await onSave(points, rules) ? "saved" : "failed");
    } catch {
      setSaveState("failed");
    } finally {
      savingRef.current = false;
    }
  };

  const openModal = () => {
    setModalForm(emptyModalForm);
    setModalErrors({});
    setModalOpen(true);
  };

  const submitModal = () => {
    const errors: ModalErrors = {};
    const name = modalForm.name.trim();
    if (!name) errors.name = "규칙명을 입력하세요.";
    if (!modalForm.category) errors.category = "분류를 선택하세요.";
    if (!modalForm.applicability) errors.applicability = "적용 여부를 선택하세요.";
    if (!modalForm.status) errors.status = "확정 상태를 선택하세요.";
    if (name) {
      const key = name.replace(/\s+/gu, " ").trim();
      const clash = drafts.some(item =>
        item.kind === "generic" && item.name.replace(/\s+/gu, " ").trim() === key);
      if (clash) errors.duplicate = "이미 같은 이름의 규칙이 있습니다. 기존 규칙을 편집하세요.";
    }
    setModalErrors(errors);
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
      category: modalForm.category as GenericRuleCategory,
      applicability: modalForm.applicability as GenericRuleApplicability,
      status: modalForm.status as GenericRuleStatus,
      detail: modalForm.detail,
      source: modalForm.source,
      step: modalForm.step,
      ...(modalForm.linkedDecisionId ? { linkedDecisionId: modalForm.linkedDecisionId as DecisionPointId } : {}),
      origin: "user",
      touched: true,
    };
    // 사용자 추가 규칙은 저장·사용자 행 뒤, 후보 앞에 둔다 (사용자 규칙이 후보 아래에 묻히지 않게).
    setDrafts(current => {
      let idx = current.length;
      for (let i = current.length - 1; i >= 0; i--) {
        const item = current[i];
        if (item.kind === "generic" && item.origin !== "candidate") { idx = i + 1; break; }
      }
      return [...current.slice(0, idx), rule, ...current.slice(idx)];
    });
    setOpenKey(id);
    setSaveState("idle");
    setModalOpen(false);
  };

  // D5 선택형 UI용 D4 확정 상태 목록 (초안 기준). D4 미확정 시에는 기존 자유 입력 유지한다.
  const d4States = draftStateNames(drafts);
  const emptyText = hasDerivationSignals(diagnosis)
    ? "확인 대상 규칙이 없습니다."
    : "진단 정보가 부족해 규칙을 도출하지 못했습니다. 업무에 실제로 필요한 규칙이 있으면 '+ 규칙 추가'로 근거와 함께 추가하세요.";

  return <section className="ax-surface ax-decision" id="ax-decision-points" aria-label="업무 규칙 확인">
    <div className="ax-decision-head">
      <div>
        <h3>업무 규칙 확인</h3>
        <p className="ax-muted">자동화에 필요한 업무 규칙을 확인합니다. 확정된 내용은 올인원 지시문에 반영됩니다.</p>
      </div>
      <div className="ax-decision-progress">
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={openModal}>+ 규칙 추가</Button>
        <strong>{progressText}{progressSuffix}</strong>
        <span className="ax-decision-bar" aria-hidden="true"><span style={{ width: `${progress.total ? progress.done / progress.total * 100 : 0}%` }} /></span>
      </div>
    </div>
    {drafts.length ? <div className="ax-decision-list">
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
              {item.origin === "candidate" && item.sourceLabel ? <span className="ax-decision-source">{item.sourceLabel}</span> : null}
              <span className="ax-decision-badge" data-status={item.status}>{DECISION_BADGE[item.status]}</span>
              <ChevronDown size={18} aria-hidden="true" className={isOpen ? "is-open" : ""} />
            </button>
            {isOpen ? <div className="ax-decision-panel">
              {item.origin === "candidate" && item.provenance ? <p className="ax-muted">근거: {item.provenance}</p> : null}
              <label className="ax-field">{decisionPanelLabel(item.id, "상태")}
                <select aria-label={decisionPanelLabel(item.id, "상태")} value={item.status} disabled={disabled}
                  onChange={e => { updateDecision(item.id, { status: e.target.value as UnifiedDecisionDraft["status"] }); setSaveState("idle"); }}>
                  <option value="미확정">미확정</option>
                  <option value="확정">확정</option>
                  <option value="해당 없음">해당 없음</option>
                </select>
              </label>
              {item.status === "해당 없음" ? null : item.id === "D5" && d4States ? <>
                <label className="ax-field">{decisionPanelLabel(item.id, "상세")}
                  <select aria-label={decisionPanelLabel(item.id, "상세")} value={item.detail ?? ""} disabled={disabled}
                    onChange={e => { updateDecision(item.id, { detail: e.target.value }); setSaveState("idle"); }}>
                    <option value="">선택하세요</option>
                    {d5Mismatch ? <option value={item.detail}>{item.detail} (결과 상태 (D4) 목록 외 값)</option> : null}
                    {d4States.map(name => <option key={name} value={name}>{name}</option>)}
                  </select>
                </label>
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
            {item.origin === "candidate" && item.sourceLabel ? <span className="ax-decision-source">{item.sourceLabel}</span> : null}
            <span className="ax-decision-badge" data-status={genericBadge(item)}>{genericBadge(item)}</span>
            <ChevronDown size={18} aria-hidden="true" className={isOpen ? "is-open" : ""} />
          </button>
          {isOpen ? <div className="ax-generic-panel">
            {item.origin === "candidate" && item.provenance ? <p className="ax-muted ax-field-wide">근거: {item.provenance}</p> : null}
            <label className="ax-field ax-field-wide">
              <span>규칙명</span>
              <Input value={item.name} disabled={disabled} onChange={event => updateGeneric(key, { name: event.target.value })} placeholder="예: 월말 마감이 지난 주문은 다음 달 집계에 포함하지 않는다" />
            </label>
            <label className="ax-field">
              <span>분류</span>
              <Select value={item.category} disabled={disabled} onValueChange={value => updateGeneric(key, { category: value as GenericRuleCategory })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {GENERIC_RULE_CATEGORIES.map(entry => <SelectItem key={entry} value={entry}>{entry}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="ax-field">
              <span>적용 여부</span>
              <Select value={item.applicability} disabled={disabled} onValueChange={value => updateGeneric(key, { applicability: value as GenericRuleApplicability })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {GENERIC_RULE_APPLICABILITY.map(entry => <SelectItem key={entry} value={entry}>{entry}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="ax-field">
              <span>확정 상태</span>
              <Select value={item.status} disabled={disabled} onValueChange={value => updateGeneric(key, { status: value as GenericRuleStatus })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {GENERIC_RULE_STATUSES.map(entry => <SelectItem key={entry} value={entry}>{entry}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="ax-field">
              <span>연계 D규칙 (선택)</span>
              <Select value={item.linkedDecisionId ?? ""} disabled={disabled} onValueChange={value => updateGeneric(key, { linkedDecisionId: value ? value as DecisionPointId : undefined })}>
                <SelectTrigger><SelectValue placeholder="연계 없음" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">연계 없음</SelectItem>
                  {(Object.entries(DECISION_DISPLAY) as [DecisionPointId, { title: string }][]).map(([id, entry]) => <SelectItem key={id} value={id}>{id} {entry.title}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="ax-field ax-field-wide">
              <span>상세 내용</span>
              <Textarea value={item.detail ?? ""} disabled={disabled} onChange={event => updateGeneric(key, { detail: event.target.value })} rows={3} placeholder="적용 조건·예외·출력·제한을 구체적으로 적습니다. 불확실한 내용은 확정으로 표시하지 않습니다." />
            </label>
            <label className="ax-field">
              <span>근거 출처</span>
              <Input value={item.source ?? ""} disabled={disabled} onChange={event => updateGeneric(key, { source: event.target.value })} placeholder="예: 매뉴얼 3장, 담당 확인 메일" />
            </label>
            <label className="ax-field">
              <span>관련 단계</span>
              <Input value={item.step ?? ""} disabled={disabled} onChange={event => updateGeneric(key, { step: event.target.value })} placeholder="예: 월말 집계" />
            </label>
            {item.origin === "candidate" ? null : <div className="ax-field-wide ax-generic-delete">
              <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => { setSaveState("idle"); setDrafts(current => current.filter(entry => !(entry.kind === "generic" && genericKey(entry) === key))); }}>
                <Trash2 size={16} /> 이 규칙 삭제
              </Button>
            </div>}
          </div> : null}
        </div>;
      })}
    </div> : <p className="ax-muted">{emptyText}</p>}
    <div className="ax-decision-save">
      <Button type="button" disabled={disabled} onClick={save}>저장</Button>
      {saveState === "saved" && saveStatus === "이 브라우저에 저장됨" ? <p className="ax-muted" role="status">업무 규칙을 저장했습니다.</p> : null}
      {saveState === "failed" ? <p className="ax-muted" role="alert">업무 규칙을 저장하지 못했습니다. 입력 내용은 유지됩니다. 저장 상태를 확인하고 다시 시도하세요.</p> : null}
    </div>
    <Dialog open={modalOpen} onOpenChange={setModalOpen}>
      <DialogPopup className="sm:max-w-[600px]" bottomStickOnMobile={false}>
        <div className="ax-rule-modal-head">
          <h3>규칙 추가</h3>
          <p className="ax-muted">업무에 실제로 필요한 규칙을 추가합니다. 확정된 규칙은 올인원 지시문에 반영됩니다.</p>
        </div>
        <div className="ax-rule-modal-body">
          <div className="ax-rule-modal-grid">
            <label className="ax-field ax-field-wide">
              <span>규칙명 *</span>
              <Input value={modalForm.name} maxLength={MODAL_NAME_MAX_LENGTH} onChange={event => setModalForm(current => ({ ...current, name: event.target.value }))}
                placeholder="예: 월말 마감이 지난 주문은 다음 달 집계에 포함하지 않는다" />
              <span className="ax-decision-counter">{modalForm.name.length} / {MODAL_NAME_MAX_LENGTH}</span>
              {modalErrors.name ? <span className="ax-rule-modal-error" role="alert">{modalErrors.name}</span> : null}
            </label>
            <label className="ax-field">
              <span>분류 *</span>
              <select aria-label="분류 *" value={modalForm.category} onChange={event => setModalForm(current => ({ ...current, category: event.target.value }))}>
                <option value="">선택하세요</option>
                {GENERIC_RULE_CATEGORIES.map(entry => <option key={entry} value={entry}>{entry}</option>)}
              </select>
              {modalErrors.category ? <span className="ax-rule-modal-error" role="alert">{modalErrors.category}</span> : null}
            </label>
            <label className="ax-field">
              <span>적용 여부 *</span>
              <select aria-label="적용 여부 *" value={modalForm.applicability} onChange={event => setModalForm(current => ({ ...current, applicability: event.target.value }))}>
                <option value="">선택하세요</option>
                {GENERIC_RULE_APPLICABILITY.map(entry => <option key={entry} value={entry}>{entry}</option>)}
              </select>
              {modalErrors.applicability ? <span className="ax-rule-modal-error" role="alert">{modalErrors.applicability}</span> : null}
            </label>
            <label className="ax-field">
              <span>확정 상태 *</span>
              <select aria-label="확정 상태 *" value={modalForm.status} onChange={event => setModalForm(current => ({ ...current, status: event.target.value }))}>
                <option value="">선택하세요</option>
                {GENERIC_RULE_STATUSES.map(entry => <option key={entry} value={entry}>{entry}</option>)}
              </select>
              {modalErrors.status ? <span className="ax-rule-modal-error" role="alert">{modalErrors.status}</span> : null}
            </label>
            <label className="ax-field">
              <span>연계 D규칙 (선택)</span>
              <select aria-label="연계 D규칙 (선택)" value={modalForm.linkedDecisionId} onChange={event => setModalForm(current => ({ ...current, linkedDecisionId: event.target.value }))}>
                <option value="">연계 없음</option>
                {(Object.entries(DECISION_DISPLAY) as [DecisionPointId, { title: string }][]).map(([id, entry]) => <option key={id} value={id}>{id} {entry.title}</option>)}
              </select>
            </label>
            <label className="ax-field ax-field-wide">
              <span>상세 내용</span>
              <Textarea rows={3} maxLength={MODAL_DETAIL_MAX_LENGTH} value={modalForm.detail}
                onChange={event => setModalForm(current => ({ ...current, detail: event.target.value }))}
                placeholder="적용 조건·예외·출력·제한을 구체적으로 적습니다. 불확실한 내용은 확정으로 표시하지 않습니다." />
              <span className="ax-decision-counter">{modalForm.detail.length} / {MODAL_DETAIL_MAX_LENGTH}</span>
            </label>
            <label className="ax-field">
              <span>근거 출처 (선택)</span>
              <Input value={modalForm.source} maxLength={MODAL_SOURCE_MAX_LENGTH} onChange={event => setModalForm(current => ({ ...current, source: event.target.value }))}
                placeholder="예: 매뉴얼 3장, 담당 확인 메일" />
              <span className="ax-decision-counter">{modalForm.source.length} / {MODAL_SOURCE_MAX_LENGTH}</span>
            </label>
            <label className="ax-field">
              <span>관련 단계 (선택)</span>
              <Input value={modalForm.step} maxLength={MODAL_STEP_MAX_LENGTH} onChange={event => setModalForm(current => ({ ...current, step: event.target.value }))}
                placeholder="예: 월말 집계" />
              <span className="ax-decision-counter">{modalForm.step.length} / {MODAL_STEP_MAX_LENGTH}</span>
            </label>
          </div>
          {modalErrors.duplicate ? <p className="ax-rule-modal-error" role="alert">{modalErrors.duplicate}</p> : null}
        </div>
        <div className="ax-rule-modal-foot">
          <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>취소</Button>
          <Button type="button" onClick={submitModal}>추가</Button>
        </div>
      </DialogPopup>
    </Dialog>
  </section>;
}
