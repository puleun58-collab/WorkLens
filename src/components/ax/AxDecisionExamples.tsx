"use client";

import { useState } from "react";
import { ChevronDown, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DECISION_POINT_DEFS, confirmedStateNames, resolveDecisionPoints, type ResolvedDecisionPoint } from "@/lib/ax/decision-points";
import { EXAMPLE_CONFIRMED_MINIMUM, exampleRequirement, partitionExamples } from "@/lib/ax/example-results";
import type { AxDiagnosis, DecisionPoint, ExampleResult } from "@/lib/ax/types";

/**
 * 1차 MVP 개선 — 결정 지점 확인 + 예시 결과 확인 편집 화면.
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

/** 표시 전용 패널 라벨: 항목명 + (D번호) 형태. 지시문 생성과 무관하다. */
export function decisionPanelLabel(id: string, kind: "상태" | "상세", d4Note = false): string {
  const display = DECISION_DISPLAY[id];
  const base = display ? `${display.title} (${id})` : id;
  return kind === "상세" && d4Note ? `${base} 상세 (결과 상태 (D4) 중 하나)` : `${base} ${kind}`;
}

const DECISION_BADGE: Record<ResolvedDecisionPoint["status"], string> = {
  "확정": "확정됨",
  "미확정": "미확정",
  "해당 없음": "해당 없음",
};

export function DecisionPointsSection({ diagnosis, disabled, onSave }: {
  diagnosis: AxDiagnosis;
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
  // 기본값은 첫 미확정 항목(확인할 것이 없을 때는 모두 접힘).
  const [openId, setOpenId] = useState<string | null>(() => resolveDecisionPoints(diagnosis).find(point => point.status === "미확정")?.id ?? null);
  const confirmedCount = drafts.filter(point => point.status === "확정" || point.status === "해당 없음").length;
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
  return <section className="ax-surface ax-decision" aria-label="결정 지점 확인">
    <div className="ax-decision-head">
      <div>
        <h3>결정 지점 확인 (D1~D7)</h3>
        <p className="ax-muted">자동화에 필요한 업무 규칙을 확인합니다. 확정된 내용은 올인원 지시문에 반영됩니다.</p>
      </div>
      <div className="ax-decision-progress">
        <strong>{confirmedCount} / 7 확인 완료</strong>
        <span className="ax-decision-bar" aria-hidden="true"><span style={{ width: `${confirmedCount / 7 * 100}%` }} /></span>
      </div>
    </div>
    {drafts.map(point => {
      const def = DECISION_POINT_DEFS.find(item => item.id === point.id)!;
      const display = DECISION_DISPLAY[point.id];
      const isOpen = openId === point.id;
      // D5: D4 확정 목록이 있으면 선택형으로 표시한다. 목록 외 기존값은
      // 그대로 보여주고 불일치를 안내하며, 저장 시까지 기존값을 유지한다.
      const d5Mismatch = point.id === "D5" && d4States && point.detail?.trim() ? !d4States.includes(point.detail.trim()) : false;
      return <div className="ax-decision-row" key={point.id} data-status={point.status}>
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
            <label className="ax-field">{decisionPanelLabel(point.id, "상세", true)}
              <select aria-label={decisionPanelLabel(point.id, "상세")} value={point.detail ?? ""} disabled={disabled}
                onChange={e => { update(point.id, { detail: e.target.value }); setSaved(false); }}>
                <option value="">선택하세요</option>
                {d5Mismatch ? <option value={point.detail}>{point.detail} (결과 상태 (D4) 목록 외 값)</option> : null}
                {d4States.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            {d5Mismatch ? <p className="ax-muted" role="status">현재 값이 결과 상태 (D4) 목록에 없습니다. 결과 상태 (D4) 중 하나로 수정하세요. 수정 전까지 기존값이 유지됩니다.</p> : null}
          </> : <label className="ax-field">{decisionPanelLabel(point.id, "상세")}
            <Textarea rows={2} maxLength={2000} aria-label={decisionPanelLabel(point.id, "상세")} placeholder={def.detailHint} disabled={disabled}
              value={point.detail ?? ""} onChange={e => { update(point.id, { detail: e.target.value }); setSaved(false); }} />
          </label>}
        </div> : null}
      </div>;
    })}
    <div className="ax-decision-save">
      <Button type="button" disabled={disabled} onClick={save}>변경사항 저장</Button>
      {saved ? <p className="ax-muted">결정 지점을 저장했습니다.</p> : null}
    </div>
  </section>;
}

interface ExampleDraft { input: string; expectedState: string; expectedValue: string; memo: string }

export function ExampleResultsSection({ examples, diagnosis, disabled, onSave }: {
  examples?: ExampleResult[];
  /** D4 결과 상태 확인용. D4가 확정된 경우에만 기대 결과를 D4 목록과 대조한다. */
  diagnosis?: Pick<AxDiagnosis, "decisionPoints">;
  disabled?: boolean;
  onSave: (examples: ExampleResult[]) => void;
}) {
  const toDrafts = (values?: ExampleResult[]): ExampleDraft[] => (values ?? []).map(item => ({
    input: item.input, expectedState: item.expectedState, expectedValue: item.expectedValue ?? "", memo: item.memo ?? "",
  }));
  // 저장 후 부모가 새 목록을 내려주면 초안을 동기화한다 (effect가 아닌 렌더 중 조정 패턴).
  const examplesKey = JSON.stringify(examples ?? []);
  const [drafts, setDrafts] = useState<ExampleDraft[]>(() => toDrafts(examples));
  const [prevExamplesKey, setPrevExamplesKey] = useState(examplesKey);
  if (prevExamplesKey !== examplesKey) {
    setPrevExamplesKey(examplesKey);
    setDrafts(toDrafts(examples));
  }
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  // 탭 선택은 초안과 별개로 유지한다: 탭을 바꿔도 작성 중인 입력값이 사라지지 않는다.
  const [selectedIndex, setSelectedIndex] = useState(0);
  const safeIndex = drafts.length ? Math.min(selectedIndex, drafts.length - 1) : 0;
  const selected = drafts[safeIndex];
  // D4가 미확정이면 검증하지 않는다. 확정 후에는 D4 목록에 없는 기대 결과의 저장을 막는다.
  const stateNames = confirmedStateNames(resolveDecisionPoints(diagnosis));
  // 보완 6항 1·5번: 최소 3건 안내·확정 건수는 필수 대상에만 표시한다.
  // 진단 정보가 없으면 필수 여부를 확인할 수 없으므로 확인 필요로 처리한다 (자동 면제 없음).
  const requirement = diagnosis ? exampleRequirement(resolveDecisionPoints(diagnosis)) : "needs-confirmation";
  const { valid: countedExamples, invalid: invalidExamples } = partitionExamples(examples, stateNames);
  const update = (index: number, patch: Partial<ExampleDraft>) =>
    setDrafts(current => current.map((row, i) => i === index ? { ...row, ...patch } : row));
  const addExample = () => {
    setDrafts(current => [...current, { input: "", expectedState: "", expectedValue: "", memo: "" }]);
    setSelectedIndex(drafts.length);
    setSaved(false);
  };
  const removeSelected = () => {
    setDrafts(current => current.filter((_, j) => j !== safeIndex));
    setSelectedIndex(current => Math.max(0, Math.min(current, drafts.length - 2)));
    setSaved(false);
  };
  const save = () => {
    if (stateNames) {
      const invalidRows = drafts
        .map((row, i) => ({ row, i }))
        .filter(({ row }) => row.input.trim() && row.expectedState.trim() && !stateNames.includes(row.expectedState.trim()));
      if (invalidRows.length) {
        setError(`${invalidRows.map(({ i }) => `예시 ${i + 1}`).join(", ")}의 예상 결과가 결과 상태 (D4) 목록(${stateNames.join(" · ")})에 없습니다. 결과 상태 (D4) 중 하나로 입력한 뒤 저장하세요.`);
        setSaved(false);
        return;
      }
    }
    setError("");
    // 입력 값과 기대 결과가 모두 있는 행만 확정 예시로 저장한다 (빈 행은 버린다).
    const confirmed: ExampleResult[] = drafts
      .filter(row => row.input.trim() && row.expectedState.trim())
      .map(row => ({
        input: row.input.trim(), expectedState: row.expectedState.trim(),
        ...(row.expectedValue.trim() ? { expectedValue: row.expectedValue.trim() } : {}),
        ...(row.memo.trim() ? { memo: row.memo.trim() } : {}),
      }));
    onSave(confirmed.slice(0, 20));
    setSaved(true);
  };
  const savedCount = examples?.length ?? 0;
  return <section className="ax-surface ax-examples" aria-label="업무 처리 예시">
    <div className="ax-examples-head">
      <div>
        <h3>업무 처리 예시</h3>
        <p className="ax-muted">입력과 예상 결과를 작성해 처리 규칙을 검증합니다.</p>
      </div>
      <div className="ax-examples-meta">
        <span>{requirement === "required" ? `예시 ${savedCount} / ${EXAMPLE_CONFIRMED_MINIMUM}건` : `예시 ${savedCount}건`}</span>
        <span>{requirement === "required" ? "필수" : requirement === "recommended" ? "권장" : "업무 규칙 확인 필요"}</span>
        <Button type="button" variant="outline" disabled={disabled} onClick={addExample}>+ 예시 추가</Button>
      </div>
    </div>
    {requirement === "required"
      ? <p className="ax-muted">정상 사례와 예외 사례를 각각 1건 이상 넣어 주세요. (안내이며, 필수 조건은 확정 {EXAMPLE_CONFIRMED_MINIMUM}건입니다.) 확정 예시가 {EXAMPLE_CONFIRMED_MINIMUM}건 미만이면 &lsquo;업무 처리 예시 미확정&rsquo; 보류 사유가 붙습니다.</p>
      : requirement === "recommended"
        ? <p className="ax-muted">예시는 권장 사항입니다. 정상 사례와 예외 사례를 각각 1건 이상 넣어 주면 구현 확인에 도움이 됩니다. 필수 조건이 아니므로 예시가 없어도 보류 사유가 붙지 않습니다.</p>
        : <p className="ax-muted">업무 처리 예시 필수 여부가 확인되지 않았습니다. 대조 기준 (D1)·중복 처리 (D2)·예외값 처리 (D3)·계산 기준 (D7)을 확정하거나 해당 없음으로 확인하면 필수 여부가 정해집니다. 필수 대상인 경우에만 확정 {EXAMPLE_CONFIRMED_MINIMUM}건이 필요합니다.</p>}
    {requirement === "required" ? <p className="ax-muted">확정 예시 {countedExamples.length}건</p> : null}
    {invalidExamples.length ? <p className="ax-muted" role="status">저장된 예시 중 {invalidExamples.length}건은 예상 결과가 결과 상태 (D4) 목록에 없어 확정 예시로 세지 않습니다. 예상 결과를 결과 상태 (D4) 중 하나로 고쳐 다시 저장하세요.</p> : null}
    <div className="ax-example-tabs" role="tablist" aria-label="업무 처리 예시 목록">
      {drafts.map((_, i) => <button type="button" key={i} role="tab" aria-selected={i === safeIndex} disabled={disabled}
        className={i === safeIndex ? "is-selected" : ""} onClick={() => setSelectedIndex(i)}>예시 {i + 1}</button>)}
      <button type="button" disabled={disabled} onClick={addExample}>+ 새 예시</button>
    </div>
    {selected ? <div className="ax-example-detail">
      <div className="ax-example-cols">
        <div className="ax-example-col">
          <h4>입력 데이터</h4>
          <label className="ax-field">예시 {safeIndex + 1} 입력값
            <Textarea rows={4} maxLength={2000} aria-label={`예시 ${safeIndex + 1} 입력값`} disabled={disabled}
              value={selected.input} onChange={e => { update(safeIndex, { input: e.target.value }); setSaved(false); }} />
          </label>
          <p className="ax-muted">실제 개인정보·거래처 정보 대신 가명이나 예시 값을 입력하세요.</p>
        </div>
        <div className="ax-example-col">
          <h4>예상 처리 결과</h4>
          {stateNames ? <>
            <label className="ax-field">예시 {safeIndex + 1} 예상 결과 상태
              <select aria-label={`예시 ${safeIndex + 1} 예상 결과 상태`} value={selected.expectedState} disabled={disabled}
                onChange={e => { update(safeIndex, { expectedState: e.target.value }); setSaved(false); }}>
                <option value="">선택하세요</option>
                {selected.expectedState.trim() && !stateNames.includes(selected.expectedState.trim())
                  ? <option value={selected.expectedState}>{selected.expectedState} (결과 상태 (D4) 목록 외 값)</option> : null}
                {stateNames.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <p className="ax-muted">예상 결과는 결과 상태 (D4) 중 하나로 입력하세요: {stateNames.join(" · ")}</p>
          </> : <>
            <label className="ax-field">예시 {safeIndex + 1} 예상 결과 상태
              <Input type="text" maxLength={100} aria-label={`예시 ${safeIndex + 1} 예상 결과 상태`} disabled={disabled}
                value={selected.expectedState} onChange={e => { update(safeIndex, { expectedState: e.target.value }); setSaved(false); }} />
            </label>
            <p className="ax-muted">결과 상태 (D4)가 아직 확정되지 않아 예상 결과를 검증하지 않습니다. 결과 상태 (D4)를 확정하면 예상 결과가 결과 상태 목록에 있는지 확인합니다.</p>
          </>}
          <label className="ax-field">예시 {safeIndex + 1} 기대 값 (금액·수량 등, 선택)
            <Input type="text" maxLength={500} aria-label={`예시 ${safeIndex + 1} 기대 값`} disabled={disabled}
              value={selected.expectedValue} onChange={e => { update(safeIndex, { expectedValue: e.target.value }); setSaved(false); }} />
          </label>
        </div>
      </div>
      <label className="ax-field">예시 {safeIndex + 1} 메모 (선택)
        <Textarea rows={2} maxLength={1000} aria-label={`예시 ${safeIndex + 1} 메모`} disabled={disabled}
          value={selected.memo} onChange={e => { update(safeIndex, { memo: e.target.value }); setSaved(false); }} />
      </label>
    </div> : <p className="ax-muted">예시가 없습니다. 새 예시를 추가하세요.</p>}
    <div className="ax-example-actions">
      <Button type="button" variant="ghost" disabled={disabled || !selected} aria-label={`예시 ${safeIndex + 1} 삭제`} onClick={removeSelected}><Trash2 size={15} aria-hidden="true" />예시 삭제</Button>
      <Button type="button" disabled={disabled} onClick={save}>업무 처리 예시 저장</Button>
    </div>
    {error ? <p className="ax-muted" role="alert">{error}</p> : null}
    {saved ? <p className="ax-muted">업무 처리 예시를 저장했습니다.</p> : null}
  </section>;
}
