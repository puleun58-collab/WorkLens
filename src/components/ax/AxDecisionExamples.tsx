"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DECISION_POINT_DEFS, confirmedStateNames, resolveDecisionPoints, type ResolvedDecisionPoint } from "@/lib/ax/decision-points";
import { EXAMPLE_CONFIRMED_MINIMUM, partitionExamples } from "@/lib/ax/example-results";
import type { AxDiagnosis, DecisionPoint, ExampleResult } from "@/lib/ax/types";

/**
 * 1차 MVP 개선 — 결정 지점 확인 + 예시 결과 확인 편집 화면.
 * 초안은 컴포넌트 상태에만 두고, 저장 버튼을 눌러 사용자가 확정한 값만 저장한다.
 * AI가 채운 값은 저장 경로에 들어가지 않는다 (진단 수신 시 제거됨).
 */
export function DecisionPointsSection({ diagnosis, taskDescription, disabled, onSave }: {
  diagnosis: AxDiagnosis;
  taskDescription: string;
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
  return <section className="ax-surface" aria-label="결정 지점 확인">
    <h3>결정 지점 확인 (D1~D7)</h3>
    <p className="ax-muted">AI가 자유롭게 만드는 질문이 아니라 고정된 확인 항목입니다. 확정·해당 없음은 사용자가 직접 선택·입력해야 하며, AI가 근거 없이 미리 채우지 않습니다. 기본값은 미확정입니다.</p>
    <p className="ax-muted">업무 설명 원문: {taskDescription}</p>
    {drafts.map(point => {
      const def = DECISION_POINT_DEFS.find(item => item.id === point.id)!;
      return <div className="ax-field" key={point.id}>
        <label className="ax-field">{point.id} {point.title} — {point.question}
          <select aria-label={`${point.id} 상태`} value={point.status} disabled={disabled}
            onChange={e => { update(point.id, { status: e.target.value as ResolvedDecisionPoint["status"] }); setSaved(false); }}>
            <option value="미확정">미확정</option>
            <option value="확정">확정</option>
            <option value="해당 없음">해당 없음</option>
          </select>
        </label>
        <label className="ax-field">{point.id} 상세
          <Textarea rows={2} maxLength={2000} aria-label={`${point.id} 상세`} placeholder={def.detailHint} disabled={disabled}
            value={point.detail ?? ""} onChange={e => { update(point.id, { detail: e.target.value }); setSaved(false); }} />
        </label>
      </div>;
    })}
    <Button type="button" disabled={disabled} onClick={save}>결정 지점 저장</Button>
    {saved ? <p className="ax-muted">결정 지점을 저장했습니다.</p> : null}
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
  // D4가 미확정이면 검증하지 않는다. 확정 후에는 D4 목록에 없는 기대 결과의 저장을 막는다.
  const stateNames = confirmedStateNames(resolveDecisionPoints(diagnosis));
  const { valid: countedExamples, invalid: invalidExamples } = partitionExamples(examples, stateNames);
  const update = (index: number, patch: Partial<ExampleDraft>) =>
    setDrafts(current => current.map((row, i) => i === index ? { ...row, ...patch } : row));
  const save = () => {
    if (stateNames) {
      const invalidRows = drafts
        .map((row, i) => ({ row, i }))
        .filter(({ row }) => row.input.trim() && row.expectedState.trim() && !stateNames.includes(row.expectedState.trim()));
      if (invalidRows.length) {
        setError(`${invalidRows.map(({ i }) => `예시 ${i + 1}`).join(", ")}의 기대 결과가 D4 결과 상태 목록(${stateNames.join(" · ")})에 없습니다. D4 상태 중 하나로 입력한 뒤 저장하세요.`);
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
  return <section className="ax-surface" aria-label="예시 결과 확인">
    <h3>예시 결과 확인 (HITL)</h3>
    <p className="ax-muted">정상 사례와 예외 사례를 각각 1건 이상 넣어 주세요. (안내이며, 강제 조건은 확정 {EXAMPLE_CONFIRMED_MINIMUM}건입니다.) 확정 예시가 {EXAMPLE_CONFIRMED_MINIMUM}건 미만이면 &lsquo;예시 결과 미확정&rsquo; 보류 사유가 붙습니다.</p>
    <p className="ax-muted">실제 개인정보·거래처 정보 대신 가명이나 예시 값을 입력하세요.</p>
    <p className="ax-muted">{stateNames
      ? <>기대 결과는 D4 결과 상태 중 하나로 입력하세요: {stateNames.join(" · ")}</>
      : "D4 결과 상태가 아직 확정되지 않아 기대 결과를 검증하지 않습니다. D4를 확정하면 기대 결과가 D4 상태 목록에 있는지 확인합니다."}</p>
    <p className="ax-muted">확정 예시 {countedExamples.length}건</p>
    {invalidExamples.length ? <p className="ax-muted" role="status">저장된 예시 중 {invalidExamples.length}건은 기대 결과가 D4 결과 상태 목록에 없어 확정 예시로 세지 않습니다. 기대 결과를 D4 상태 중 하나로 고쳐 다시 저장하세요.</p> : null}
    {drafts.map((row, i) => <div className="ax-field" key={i}>
      <label className="ax-field">예시 {i + 1} 입력 값
        <Textarea rows={2} maxLength={2000} aria-label={`예시 ${i + 1} 입력 값`} disabled={disabled}
          value={row.input} onChange={e => { update(i, { input: e.target.value }); setSaved(false); }} />
      </label>
      <label className="ax-field">예시 {i + 1} 기대 결과 (D4 상태 중 하나)
        <Input type="text" maxLength={100} aria-label={`예시 ${i + 1} 기대 결과 상태`} disabled={disabled}
          value={row.expectedState} onChange={e => { update(i, { expectedState: e.target.value }); setSaved(false); }} />
      </label>
      <label className="ax-field">예시 {i + 1} 기대 값 (금액·수량 등, 선택)
        <Input type="text" maxLength={500} aria-label={`예시 ${i + 1} 기대 값`} disabled={disabled}
          value={row.expectedValue} onChange={e => { update(i, { expectedValue: e.target.value }); setSaved(false); }} />
      </label>
      <label className="ax-field">예시 {i + 1} 메모 (선택)
        <Textarea rows={2} maxLength={1000} aria-label={`예시 ${i + 1} 메모`} disabled={disabled}
          value={row.memo} onChange={e => { update(i, { memo: e.target.value }); setSaved(false); }} />
      </label>
      <Button type="button" variant="ghost" disabled={disabled} aria-label={`예시 ${i + 1} 삭제`}
        onClick={() => { setDrafts(current => current.filter((_, j) => j !== i)); setSaved(false); }}>예시 삭제</Button>
    </div>)}
    <div style={{ display: "flex", gap: 8 }}>
      <Button type="button" variant="outline" disabled={disabled}
        onClick={() => { setDrafts(current => [...current, { input: "", expectedState: "", expectedValue: "", memo: "" }]); setSaved(false); }}>예시 추가</Button>
      <Button type="button" disabled={disabled} onClick={save}>예시 결과 저장</Button>
    </div>
    {error ? <p className="ax-muted" role="alert">{error}</p> : null}
    {saved ? <p className="ax-muted">예시 결과를 저장했습니다.</p> : null}
  </section>;
}
