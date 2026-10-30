"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DECISION_POINT_DEFS, confirmedStateNames, resolveDecisionPoints, type ResolvedDecisionPoint } from "@/lib/ax/decision-points";
import { resolveGenericRules, ruleProgress } from "@/lib/ax/generic-rules";
import type { AxDiagnosis, DecisionPoint, GenericRule } from "@/lib/ax/types";

/**
 * 업무 규칙 확인 편집 화면 (D1~D7 + 범용 규칙 진행 현황).
 * 초안은 컴포넌트 상태에만 두고, 저장 버튼을 눌러 사용자가 확정한 값만 저장한다.
 * AI가 채운 값은 저장 경로에 들어가지 않는다 (진단 수신 시 제거됨).
 */

/** 표시 전용 D1~D7 제목·설명. 지시문 생성은 기존 DEFS 제목을 쓰므로 여기를 바꿔도 지시문은 바뀌지 않는다. */
export const DECISION_DISPLAY: Record<string, { title: string; question: string }> = {
  D1: { title: "대조 기준", question: "어떤 자료와 항목을 기준으로 비교하나요?" },
  D2: { title: "중복 처리", question: "동일한 항목이 여러 번 나타나면 어떻게 처리하나요?" },
  D3: { title: "예외값 처리", question: "빈칸·음수·0 등은 어떻게 처리하나요?" },
  D4: { title: "결과 상태", question: "처리 결과를 어떤 상태로 구분하나요?" },
  D5: { title: "판단 불가 처리", question: "판정할 수 없는 데이터는 어떻게 표시하나요?" },
  D6: { title: "빈 파일 처리", question: "데이터가 없을 때 어떻게 처리하나요?" },
  D7: { title: "계산 기준", question: "합계·반올림·단위의 기준은 무엇인가요?" },
};

/** 표시 전용 패널 라벨: 지시문 §10.5에 따라 D번호 없이 간결한 라벨을 쓴다 (지시문 생성과 무관).
 * #365 레퍼런스 교정 문구("D1 상태"/"D1 상세")를 의도적으로 대체한다. */
export function decisionPanelLabel(_id: string, kind: "상태" | "상세"): string {
  return kind === "상세" ? "대조 기준" : kind;
}

/** 결정 지점 상세 입력 제한. 카운터 표시 기준이며 저장 의미를 바꾸지 않는다. */
const DECISION_DETAIL_MAX_LENGTH = 2000;

const DECISION_BADGE: Record<ResolvedDecisionPoint["status"], string> = {
  "확정": "확정됨",
  "미확정": "미확정",
  "해당 없음": "해당 없음",
};

export function DecisionPointsSection({ diagnosis, genericRules, disabled, onSave }: {
  diagnosis: AxDiagnosis;
  /** 범용 규칙 (저장된 값 기준). 진행 현황 분모·적용 여부 건수 계산에만 쓴다. */
  genericRules?: GenericRule[];
  disabled?: boolean;
  onSave: (points: DecisionPoint[]) => void;
}) {
  // 저장 후 부모가 새 진단을 내려주면 초안을 동기화한다 (effect가 아닌 렌더 중 조정 패턴).
  const pointsKey = JSON.stringify(diagnosis.decisionPoints ?? []);
  const [drafts, setDrafts] = useState<ResolvedDecisionPoint[]>(() => resolveDecisionPoints(diagnosis));
  const [prevPointsKey, setPrevPointsKey] = useState(pointsKey);
  if (prevPointsKey !== pointsKey) {
    setPrevPointsKey(pointsKey);
    setDrafts(resolveDecisionPoints(diagnosis));
  }
  const [saved, setSaved] = useState(false);
  // 펼침 상태는 초안과 별개로 유지한다: 접었다 펴도 미저장 입력값이 사라지지 않는다.
  // 기본값은 모두 접힘(한 번에 한 항목만 펼침).
  const [openId, setOpenId] = useState<string | null>(null);
  // 진행 현황: D 초안(편집 중 값) + 저장된 범용 규칙 기준. 분모는 실제로 적용되는
  // 확인 대상 규칙 수이며, 해당 없음은 분모에서 빠진다. 적용 여부 미확정은 별도 건수다.
  const progress = ruleProgress(drafts, resolveGenericRules(genericRules));
  const update = (id: string, patch: Partial<ResolvedDecisionPoint>) =>
    setDrafts(current => current.map(point => point.id === id ? { ...point, ...patch } : point));
  const save = () => {
    // 미확정 항목은 저장하지 않는다 (없으면 미확정으로 표시되는 기존 관례).
    const points: DecisionPoint[] = drafts
      .filter(point => point.status !== "미확정")
      .map(point => ({ id: point.id, status: point.status, ...(point.detail?.trim() ? { detail: point.detail.trim() } : {}) }));
    onSave(points);
    setSaved(true);
  };
  // D5 선택형 UI용 D4 확정 상태 목록. D4 미확정 시에는 기존 자유 입력 유지한다.
  const d4States = confirmedStateNames(drafts);
  return <section className="ax-surface ax-decision" id="ax-decision-points" aria-label="업무 규칙 확인">
    <div className="ax-decision-head">
      <div>
        <h3>업무 규칙 확인</h3>
        <p className="ax-muted">자동화에 필요한 업무 규칙을 확인합니다. 확정된 내용은 올인원 지시문에 반영됩니다.</p>
      </div>
      <div className="ax-decision-progress">
        <strong>{progress.done}/{progress.total} 확인 완료{progress.applicabilityPending ? ` · 적용 여부 확인 ${progress.applicabilityPending}건` : ""}</strong>
        <span className="ax-decision-bar" aria-hidden="true"><span style={{ width: `${progress.total ? progress.done / progress.total * 100 : 0}%` }} /></span>
      </div>
    </div>
    {drafts.map(point => {
      const def = DECISION_POINT_DEFS.find(item => item.id === point.id)!;
      const display = DECISION_DISPLAY[point.id];
      const isOpen = openId === point.id;
      // D5: D4 확정 목록이 있으면 선택형으로 표시한다. 목록 외 기존값은
      // 그대로 보여주고 불일치를 안내하며, 저장 시까지 기존값을 유지한다.
      const d5Mismatch = point.id === "D5" && d4States && point.detail?.trim() ? !d4States.includes(point.detail.trim()) : false;
      return <div className={`ax-decision-row${isOpen ? " is-open" : ""}`} id={`ax-decision-${point.id}`} key={point.id} data-status={point.status}>
        <button type="button" className="ax-decision-row-head" aria-expanded={isOpen} disabled={disabled}
          onClick={() => setOpenId(isOpen ? null : point.id)}>
          <span className="ax-decision-no">{point.id}</span>
          <span className="ax-decision-title"><strong>{display.title}</strong><small>{display.question}</small></span>
          <span className="ax-decision-badge" data-status={point.status}>{DECISION_BADGE[point.status]}</span>
          <ChevronDown size={18} aria-hidden="true" className={isOpen ? "is-open" : ""} />
        </button>
        {isOpen ? <div className="ax-decision-panel">
          <label className="ax-field">{decisionPanelLabel(point.id, "상태")}
            <select aria-label={decisionPanelLabel(point.id, "상태")} value={point.status} disabled={disabled}
              onChange={e => { update(point.id, { status: e.target.value as ResolvedDecisionPoint["status"] }); setSaved(false); }}>
              <option value="미확정">미확정</option>
              <option value="확정">확정</option>
              <option value="해당 없음">해당 없음</option>
            </select>
          </label>
          {point.status === "해당 없음" ? null : point.id === "D5" && d4States ? <>
            <label className="ax-field">{decisionPanelLabel(point.id, "상세")}
              <select aria-label={decisionPanelLabel(point.id, "상세")} value={point.detail ?? ""} disabled={disabled}
                onChange={e => { update(point.id, { detail: e.target.value }); setSaved(false); }}>
                <option value="">선택하세요</option>
                {d5Mismatch ? <option value={point.detail}>{point.detail} (결과 상태 (D4) 목록 외 값)</option> : null}
                {d4States.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            {d5Mismatch ? <p className="ax-muted" role="status">현재 값이 결과 상태 (D4) 목록에 없습니다. 결과 상태 (D4) 중 하나로 수정하세요. 수정 전까지 기존값이 유지됩니다.</p> : null}
          </> : <label className="ax-field">{decisionPanelLabel(point.id, "상세")}
            <Textarea rows={4} maxLength={DECISION_DETAIL_MAX_LENGTH} aria-label={decisionPanelLabel(point.id, "상세")} placeholder={def.detailHint} disabled={disabled}
              value={point.detail ?? ""} onChange={e => { update(point.id, { detail: e.target.value }); setSaved(false); }} />
            <span className="ax-decision-counter">{(point.detail ?? "").length} / {DECISION_DETAIL_MAX_LENGTH}</span>
          </label>}
        </div> : null}
      </div>;
    })}
    <div className="ax-decision-save">
      <Button type="button" disabled={disabled} onClick={save}>저장</Button>
      {saved ? <p className="ax-muted">결정 지점을 저장했습니다.</p> : null}
    </div>
  </section>;
}
