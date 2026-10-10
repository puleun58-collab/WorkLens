"use client";

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
      <p className="text-xs text-muted-foreground">{currentRun ? "작업 영역의 입력 방식과 함께 변경" : "문서 검토를 새로 열 때 적용"}</p>
    </div>}
    {showExpandSources && <Field disabled={disabled}>
      <div className="flex w-full items-center justify-between gap-4">
        <FieldLabel htmlFor={`${prefix}-sources`}>출처 내용을 펼쳐서 표시</FieldLabel>
        <Switch id={`${prefix}-sources`} checked={value.expandSources} disabled={disabled} onCheckedChange={(expandSources) => onChange({ ...value, expandSources })} />
      </div>
      <FieldDescription>{compact ? "실행 결과의 근거 내용을 처음부터 펼칩니다. 조회 범위와 법적 판단은 바뀌지 않습니다" : "리서치 출처 원문과 문서 검토의 관련 법령·판례를 처음부터 펼칩니다. 조회 범위와 법적 판단은 바뀌지 않습니다"}</FieldDescription>
    </Field>}
  </div>;
}
