/**
 * HITL (Human-in-the-loop) 검토 UI 컴포넌트
 *
 * AI 진단 원본과 사람 검토 내용을 구분하여 표시하고,
 * 4종 액션(keep/defer/exclude/supplement)과 4종 상태(pending/editing/confirmed/stale)를 관리한다.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import type { HitlReview, HitlAction, HitlStatus } from "@/lib/ax/types";
import type { ReviewableItem } from "@/lib/ax/hitl";

// 상태별 표시 문구와 스타일 (사용자 표시 통일)
const STATUS_META: Record<HitlStatus, { label: string; className: string }> = {
  pending: { label: "검토 전", className: "ax-hitl-badge-pending" },
  editing: { label: "보완 중", className: "ax-hitl-badge-editing" },
  confirmed: { label: "검토 완료", className: "ax-hitl-badge-confirmed" },
  stale: { label: "재확인 필요", className: "ax-hitl-badge-stale" },
};

// 액션별 표시 문구 및 선택 강조색
const ACTION_META: Record<HitlAction, { label: string; description: string; tone: string }> = {
  keep: { label: "유지", description: "AI 판단 그대로 적용합니다.", tone: "blue" },
  defer: { label: "보류", description: "현재 진행하지 않고 보류합니다.", tone: "orange" },
  exclude: { label: "제외", description: "실행 대상에서 제외합니다.", tone: "red" },
  supplement: { label: "보완", description: "AI 원본에 추가 내용을 반영합니다.", tone: "green" },
};

const MAX_INPUT_LENGTH = 500;

/** 검토 상태 배지 */
export function HitlStatusBadge({ status }: { status: HitlStatus }) {
  const meta = STATUS_META[status];
  return <Badge className={`ax-hitl-status ${meta.className}`}>{meta.label}</Badge>;
}

/** 재확인 필요 안내 */
export function StaleNotice({ review, currentText }: { review: HitlReview; currentText: string }) {
  const changed = review.target.sourceText !== currentText;
  return (
    <div className="ax-hitl-stale-notice" role="alert">
      <p className="ax-hitl-stale-title">AI 진단 내용이 변경되었습니다. 이전 검토를 확인해 주세요.</p>
      {changed ? (
        <div className="ax-hitl-stale-compare">
          <div className="ax-hitl-stale-old">
            <span className="ax-hitl-stale-label">이전 원본</span>
            <p>{review.target.sourceText}</p>
          </div>
          <div className="ax-hitl-stale-new">
            <span className="ax-hitl-stale-label">현재 원본</span>
            <p>{currentText}</p>
          </div>
        </div>
      ) : null}
      {review.action === "supplement" && review.supplement ? (
        <div className="ax-hitl-stale-supplement">
          <span className="ax-hitl-stale-label">이전 보완 내용</span>
          <p>{review.supplement}</p>
        </div>
      ) : null}
    </div>
  );
}

export interface HitlReviewPanelProps {
  item: ReviewableItem;
  review?: HitlReview;
  onSave: (review: Omit<HitlReview, "id" | "reviewedAt" | "updatedAt"> & { id?: string }) => void;
  onCancel?: () => void;
  onEdit?: () => void;
}

/** 입력창 (글자 수 표시 포함) */
function ReviewTextarea({
  label,
  required,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  required: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="ax-hitl-field">
      <span className="ax-hitl-field-label">
        {label} <span className={required ? "ax-hitl-required" : "ax-hitl-optional"}>({required ? "필수" : "선택"})</span>
      </span>
      <span className="ax-hitl-textarea-wrap">
        <Textarea
          rows={2}
          maxLength={MAX_INPUT_LENGTH}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="ax-hitl-textarea"
        />
        <span className="ax-hitl-char-count" aria-hidden="true">{value.length}/{MAX_INPUT_LENGTH}</span>
      </span>
    </label>
  );
}

/** 개별 검토 항목 패널
 * 주의: 대상 변경 시 부모에서 key={item.key}로 리마운트해야 입력값이 초기화됨 */
export function HitlReviewPanel({ item, review, onSave, onCancel, onEdit }: HitlReviewPanelProps) {
  const isStale = review?.status === "stale";
  // 최초 검토는 기본 선택 없음 (사용자가 명시적으로 선택)
  const [action, setAction] = useState<HitlAction | null>(review?.action ?? null);
  const [comment, setComment] = useState(review?.comment ?? "");
  const [reason, setReason] = useState(review?.reason ?? "");
  const [supplement, setSupplement] = useState(review?.supplement ?? "");
  const [resumeCondition, setResumeCondition] = useState(review?.resumeCondition ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const status: HitlStatus = review?.status ?? "pending";
  const isEditing = status === "pending" || status === "editing" || isStale;

  function handleSave() {
    if (!action || saving) return;
    setError("");
    // 액션별 필수 입력 검증
    if (action === "supplement" && !supplement.trim()) {
      setError("보완 내용을 입력해 주세요.");
      return;
    }
    if ((action === "defer" || action === "exclude") && !reason.trim()) {
      setError("사유를 입력해 주세요.");
      return;
    }
    setSaving(true);
    try {
      onSave({
        id: review?.id,
        target: {
          type: item.type,
          key: item.key,
          source: item.source,
          sourceText: item.text,
          sourceHash: item.sourceHash,
        },
        action,
        status: "confirmed",
        comment: comment.trim() || undefined,
        supplement: supplement.trim() || undefined,
        reason: reason.trim() || undefined,
        resumeCondition: resumeCondition.trim() || undefined,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ax-hitl-panel-v2">
      <div className="ax-hitl-v2-head">
        <h4 className="ax-hitl-v2-title">검토하기</h4>
        <p className="ax-hitl-v2-subtitle">선택한 항목에 대해 검토 의견을 확정합니다.</p>
      </div>

      {isStale && review ? <StaleNotice review={review} currentText={item.text} /> : null}

      <div className="ax-hitl-v2-original">
        <div className="ax-hitl-v2-original-head">
          <span className="ax-hitl-v2-original-title">AI 판단</span>
          <span className="ax-hitl-v2-original-sub">검토 대상 원본</span>
        </div>
        <p className="ax-hitl-v2-original-text">{item.text}</p>
      </div>

      {isEditing ? (
        <div className="ax-hitl-v2-edit">
          <span className="ax-hitl-v2-section-label">내 검토</span>
          <div className="ax-hitl-v2-actions" role="radiogroup" aria-label="검토 액션">
            {(Object.keys(ACTION_META) as HitlAction[]).map(a => (
              <label
                key={a}
                className={`ax-hitl-v2-action${action === a ? ` is-selected tone-${ACTION_META[a].tone}` : ""}`}
                data-tone={ACTION_META[a].tone}
              >
                <input
                  type="radio"
                  name={`hitl-action-${item.key}`}
                  value={a}
                  checked={action === a}
                  onChange={() => setAction(a)}
                />
                <span className="ax-hitl-v2-action-label">{ACTION_META[a].label}</span>
                <span className="ax-hitl-v2-action-desc">{ACTION_META[a].description}</span>
              </label>
            ))}
          </div>

          {action === "keep" ? (
            <ReviewTextarea
              label="의견"
              required={false}
              value={comment}
              onChange={setComment}
              placeholder="유지 이유나 참고 사항을 입력하세요."
            />
          ) : null}

          {action === "defer" ? (
            <>
              <ReviewTextarea
                label="보류 사유"
                required={true}
                value={reason}
                onChange={setReason}
                placeholder="보류 사유를 입력하세요."
              />
              <ReviewTextarea
                label="재개 조건"
                required={false}
                value={resumeCondition}
                onChange={setResumeCondition}
                placeholder="재개 조건을 입력하세요."
              />
            </>
          ) : null}

          {action === "exclude" ? (
            <ReviewTextarea
              label="제외 사유"
              required={true}
              value={reason}
              onChange={setReason}
              placeholder="제외 사유를 입력하세요."
            />
          ) : null}

          {action === "supplement" ? (
            <ReviewTextarea
              label="보완 내용"
              required={true}
              value={supplement}
              onChange={setSupplement}
              placeholder="추가 내용을 입력하세요."
            />
          ) : null}

          {error ? <p className="ax-hitl-error" role="alert">{error}</p> : null}

          <div className="ax-hitl-v2-notice" role="note">
            <span className="ax-hitl-v2-notice-icon" aria-hidden="true">ⓘ</span>
            <span>확정한 검토 내용은 구현 지시문에 반영되며, AI 원본과 기존 진단 결과는 변경되지 않습니다.</span>
          </div>

          <div className="ax-hitl-v2-buttons">
            <Button type="button" onClick={handleSave} disabled={!action || saving}>
              {saving ? "저장 중..." : "확정"}
            </Button>
            {onCancel ? <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>취소</Button> : null}
          </div>
        </div>
      ) : (
        <div className="ax-hitl-confirmed">
          <span className="ax-hitl-label">내 검토</span>
          <p>
            <strong>{ACTION_META[review!.action].label}</strong>
            {review!.action === "supplement" && review!.supplement ? ` — ${review!.supplement}` : null}
            {(review!.action === "defer" || review!.action === "exclude") && review!.reason ? ` — ${review!.reason}` : null}
            {review!.comment ? ` (${review!.comment})` : null}
          </p>
          {onEdit ? (
            <div className="ax-hitl-buttons">
              <Button type="button" variant="outline" onClick={onEdit}>수정</Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
