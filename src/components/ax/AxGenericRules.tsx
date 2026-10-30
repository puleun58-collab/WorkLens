"use client";

import { useState } from "react";
import { ChevronDown, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GENERIC_RULE_APPLICABILITY, GENERIC_RULE_CATEGORIES, GENERIC_RULE_STATUSES } from "@/lib/ax/schema";
import { nextGenericRuleId, resolveGenericRules } from "@/lib/ax/generic-rules";
import type { GenericRule, GenericRuleApplicability, GenericRuleCategory, GenericRuleStatus } from "@/lib/ax/types";
import { DECISION_DISPLAY } from "./AxDecisionExamples";

type GenericRuleDraft = GenericRule;

/**
 * 범용 업무 규칙 편집 화면 (지시문 §6~§7).
 * - 사용자는 근거 자료(출처·관련 단계)와 함께 규칙을 직접 추가·확정한다.
 * - 기본값은 적용 여부 미확정·미확정이며, 자동 적용·자동 확정·자동 해당 없음은 없다.
 * - 초안은 컴포넌트 상태에만 두고, 저장 버튼을 눌러 규칙명이 있는 행만 저장한다.
 * - AI가 채운 값은 저장 경로에 들어가지 않는다.
 */
export function GenericRulesSection({ rules, disabled, onSave }: {
  rules?: GenericRule[];
  disabled?: boolean;
  onSave: (rules: GenericRule[]) => void;
}) {
  const [drafts, setDrafts] = useState<GenericRuleDraft[]>(() => resolveGenericRules(rules));
  const [rulesKey, setRulesKey] = useState(() => JSON.stringify(resolveGenericRules(rules)));
  const [saved, setSaved] = useState(false);
  // 펼침 상태는 초안과 별개로 유지한다: 접었다 펴도 미저장 입력값이 사라지지 않는다.
  const [openId, setOpenId] = useState<string | null>(null);
  const currentKey = JSON.stringify(resolveGenericRules(rules));
  if (currentKey !== rulesKey) {
    setRulesKey(currentKey);
    setDrafts(resolveGenericRules(rules));
  }
  const update = (id: string, patch: Partial<GenericRuleDraft>) =>
    setDrafts(current => current.map(rule => rule.id === id ? { ...rule, ...patch } : rule));
  const addRule = () => {
    const id = nextGenericRuleId(drafts);
    setDrafts(current => [...current, {
      id,
      name: "",
      category: "처리·판단 기준",
      applicability: "적용 여부 미확정",
      status: "미확정",
    }]);
    setOpenId(id);
    setSaved(false);
  };
  const save = () => {
    const cleaned = drafts
      .filter(rule => rule.name.trim())
      .map(rule => ({
        ...rule,
        name: rule.name.trim(),
        detail: rule.detail?.trim() || undefined,
        source: rule.source?.trim() || undefined,
        step: rule.step?.trim() || undefined,
      }));
    onSave(cleaned);
    setSaved(true);
  };
  const badge = (rule: GenericRuleDraft): string =>
    rule.applicability === "해당 없음" ? "해당 없음"
    : rule.applicability === "적용 여부 미확정" ? "적용 여부 확인 필요"
    : rule.status;
  return <section className="ax-surface ax-decision" id="ax-generic-rules" aria-label="범용 업무 규칙">
    <div className="ax-decision-head">
      <div>
        <h3>범용 업무 규칙</h3>
        <p className="ax-muted">업무에 실제로 필요한 규칙만 근거와 함께 추가·확정합니다. 확정된 규칙은 올인원 지시문에 반영됩니다.</p>
      </div>
      <div className="ax-decision-progress">
        <strong>규칙 {drafts.length}건</strong>
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={addRule}>+ 규칙 추가</Button>
      </div>
    </div>
    {drafts.length ? <div className="ax-decision-list">
      {drafts.map(rule => <div className="ax-decision-row" key={rule.id}>
        <button type="button" className="ax-decision-row-head" disabled={disabled} onClick={() => setOpenId(openId === rule.id ? null : rule.id)} aria-expanded={openId === rule.id}>
          <span className="ax-decision-no">{rule.id}</span>
          <span className="ax-decision-title">{rule.name.trim() || "새 규칙"}</span>
          <span className="ax-muted">{rule.category}</span>
          <span className="ax-decision-badge" data-status={badge(rule)}>{badge(rule)}</span>
          <ChevronDown className={openId === rule.id ? "is-open" : ""} size={18} />
        </button>
        {openId === rule.id ? <div className="ax-generic-panel">
          <label className="ax-field ax-field-wide">
            <span>규칙명</span>
            <Input value={rule.name} disabled={disabled} onChange={event => update(rule.id, { name: event.target.value })} placeholder="예: 월말 마감이 지난 주문은 다음 달 집계에 포함하지 않는다" />
          </label>
          <label className="ax-field">
            <span>분류</span>
            <Select value={rule.category} disabled={disabled} onValueChange={value => update(rule.id, { category: value as GenericRuleCategory })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {GENERIC_RULE_CATEGORIES.map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          <label className="ax-field">
            <span>적용 여부</span>
            <Select value={rule.applicability} disabled={disabled} onValueChange={value => update(rule.id, { applicability: value as GenericRuleApplicability })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {GENERIC_RULE_APPLICABILITY.map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          <label className="ax-field">
            <span>확정 상태</span>
            <Select value={rule.status} disabled={disabled} onValueChange={value => update(rule.id, { status: value as GenericRuleStatus })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {GENERIC_RULE_STATUSES.map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          <label className="ax-field">
            <span>연계 D규칙 (선택)</span>
            <Select value={rule.linkedDecisionId ?? ""} disabled={disabled} onValueChange={value => update(rule.id, { linkedDecisionId: value ? value as GenericRule["linkedDecisionId"] : undefined })}>
              <SelectTrigger><SelectValue placeholder="연계 없음" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">연계 없음</SelectItem>
                {Object.entries(DECISION_DISPLAY).map(([id, item]) => <SelectItem key={id} value={id}>{id} {item.title}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          <label className="ax-field ax-field-wide">
            <span>상세 내용</span>
            <Textarea value={rule.detail ?? ""} disabled={disabled} onChange={event => update(rule.id, { detail: event.target.value })} rows={3} placeholder="적용 조건·예외·출력·제한을 구체적으로 적습니다. 불확실한 내용은 확정으로 표시하지 않습니다." />
          </label>
          <label className="ax-field">
            <span>근거 출처</span>
            <Input value={rule.source ?? ""} disabled={disabled} onChange={event => update(rule.id, { source: event.target.value })} placeholder="예: 매뉴얼 3장, 담당 확인 메일" />
          </label>
          <label className="ax-field">
            <span>관련 단계</span>
            <Input value={rule.step ?? ""} disabled={disabled} onChange={event => update(rule.id, { step: event.target.value })} placeholder="예: 월말 집계" />
          </label>
          <div className="ax-field-wide ax-generic-delete">
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setDrafts(current => current.filter(item => item.id !== rule.id))}>
              <Trash2 size={16} /> 이 규칙 삭제
            </Button>
          </div>
        </div> : null}
      </div>)}
    </div> : <p className="ax-muted">등록된 범용 규칙이 없습니다. 업무에 실제로 필요한 규칙이 있으면 “+ 규칙 추가”로 근거와 함께 추가하세요.</p>}
    <div className="ax-decision-save">
      <Button type="button" disabled={disabled} onClick={save}>저장</Button>
      {saved ? <p className="ax-muted">범용 업무 규칙을 저장했습니다.</p> : null}
    </div>
  </section>;
}
