"use client";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import type { ReviewPreferences } from "@/client/review-preferences";

export function ReviewPreferenceFields({ value, onChange, prefix, disabled = false, compact = false, currentRun = false, showDocumentSource = true, showExpandSources = true }: {
  value: ReviewPreferences; onChange: (value: ReviewPreferences) => void; prefix: string; disabled?: boolean;
  compact?: boolean; currentRun?: boolean; showDocumentSource?: boolean; showExpandSources?: boolean;
}) {
  return <div className={compact ? "grid gap-4" : "grid gap-5 sm:grid-cols-2"}>
    {showDocumentSource && <div className="flex flex-col items-start gap-2">
      <p id={`${prefix}-source-label`} className="inline-flex items-center gap-2 font-medium text-base/4.5 text-foreground sm:text-sm/4">{currentRun ? "문서 입력 방식" : "문서 입력 기본 방식"}</p>
      <RadioGroup aria-labelledby={`${prefix}-source-label`} className="flex-row gap-5" value={value.documentSource} disabled={disabled}
        onValueChange={(source) => { if (source === "file" || source === "text") onChange({ ...value, documentSource: source }); }}>
        <label className="inline-flex items-center gap-2 text-sm"><Radio value="file" /><span>작업 파일</span></label>
        <label className="inline-flex items-center gap-2 text-sm"><Radio value="text" /><span>직접 입력</span></label>
      </RadioGroup>
      <p className="text-xs text-muted-foreground">{currentRun ? "작업 영역의 입력 방식과 함께 변경됩니다." : "문서 검토를 새로 열 때 선택할 입력 방식입니다."}</p>
    </div>}
    {showExpandSources && <Field disabled={disabled}>
      <div className="flex w-full items-center justify-between gap-4">
        <FieldLabel htmlFor={`${prefix}-sources`}>출처 내용을 펼쳐서 표시</FieldLabel>
        <Switch id={`${prefix}-sources`} checked={value.expandSources} disabled={disabled} onCheckedChange={(expandSources) => onChange({ ...value, expandSources })} />
      </div>
      <FieldDescription>{compact ? "실행 결과의 근거 내용을 처음부터 펼칩니다. 조회 범위와 법적 판단은 바뀌지 않습니다." : "리서치 출처 원문과 문서 검토의 관련 법령·판례를 처음부터 펼칩니다. 조회 범위와 법적 판단은 바뀌지 않습니다."}</FieldDescription>
    </Field>}
  </div>;
}
export function ReviewSettings({ draft, onChange, onSave, onReset, error, notice, ready }: {
  draft: ReviewPreferences; onChange: (value: ReviewPreferences) => void; onSave: () => void; onReset: () => void;
  error: string | null; notice: string | null; ready: boolean;
}) {
  return <section className="review-settings-section" aria-labelledby="review-settings-title">
    <header className="mb-6 space-y-2"><h2 id="review-settings-title" className="text-lg font-semibold">법령 리서치 기본값</h2>
      <p className="text-sm leading-6 text-muted-foreground">이 브라우저에서 사용할 기본값입니다. 저장한 설정은 새 검토와 재진입 시 적용되며, 아래 변경은 저장 전까지 실행에 적용되지 않습니다.</p></header>
    <div className="review-settings-groups">
      <div><h3>문서 검토</h3><ReviewPreferenceFields value={draft} onChange={onChange} prefix="saved-review-document" disabled={!ready} showDocumentSource showExpandSources={false} /></div>
      <div><h3>결과 표시</h3><ReviewPreferenceFields value={draft} onChange={onChange} prefix="saved-review-results" disabled={!ready} showDocumentSource={false} /></div>
    </div>
    <div className="mt-6 flex flex-wrap gap-2"><Button type="button" disabled={!ready} onClick={onSave}>기본값 저장</Button>
      <Button type="button" variant="outline" disabled={!ready} onClick={onReset}>시스템 기본값으로 초기화</Button></div>
    {error && <p className="mt-4 text-sm text-destructive-foreground" role="alert">{error}</p>}
    {notice && <p className="mt-4 text-sm text-muted-foreground" role="status">{notice}</p>}
    <p className="mt-6 border-t border-border pt-4 text-xs leading-5 text-muted-foreground">입력 방식과 출처 표시 설정만 브라우저에 저장합니다. 문서, 질문, 검토 결과와 근거는 저장하지 않습니다. 서버의 문서 분류·법령 조회·검토 기준은 변경하지 않습니다.</p>
  </section>;
}
