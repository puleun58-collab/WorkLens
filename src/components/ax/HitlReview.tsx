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

// 상태별 표시 문구와 스타일
const STATUS_META: Record<HitlStatus, { label: string; className: string }> = {
  pending: { label: "검토 전", className: "ax-hitl-badge-pending" },
  editing: { label: "보완 중", className: "ax-hitl-badge-editing" },
  confirmed: { label: "확인 완료", className: "ax-hitl-badge-confirmed" },
  stale: { label: "재확인 필요", className: "ax-hitl-badge-stale" },
};

// 액션별 표시 문구
const ACTION_META: Record<HitlAction, { label: string; description: string }> = {
  keep: { label: "유지", description: "AI 판단을 그대로 유지합니다." },
  defer: { label: "보류", description: "지금은 진행하지 않고 보류합니다." },
  exclude: { label: "제외", description: "실행 대상에서 제외합니다." },
  supplement: { label: "보완", description: "AI 원본에 보완 내용을 추가합니다." },
};

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

/** 개별 검토 항목 패널
 * 주의: 대상 변경 시 부모에서 key={item.key}로 리마운트해야 입력값이 초기화됨 */
export function HitlReviewPanel({ item, review, onSave, onCancel, onEdit }: HitlReviewPanelProps) {
  const isStale = review?.status === "stale";
  const [action, setAction] = useState<HitlAction>(review?.action ?? "keep");
  const [comment, setComment] = useState(review?.comment ?? "");
  const [reason, setReason] = useState(review?.reason ?? "");
  const [supplement, setSupplement] = useState(review?.supplement ?? "");
  const [resumeCondition, setResumeCondition] = useState(review?.resumeCondition ?? "");
  const [error, setError] = useState("");

  const status: HitlStatus = review?.status ?? "pending";
  const isEditing = status === "pending" || status === "editing" || isStale;

  function handleSave() {
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
  }

  return (
    <div className="ax-hitl-panel">
      <div className="ax-hitl-head">
        <HitlStatusBadge status={status} />
        {review?.reviewedAt ? (
          <span className="ax-hitl-time">
            {new Date(review.reviewedAt).toLocaleString("ko-KR")}
          </span>
        ) : null}
      </div>

      {isStale && review ? <StaleNotice review={review} currentText={item.text} /> : null}

      <div className="ax-hitl-original">
        <span className="ax-hitl-label">AI 원본</span>
        <p className="ax-hitl-original-text">{item.text}</p>
      </div>

      {isEditing ? (
        <div className="ax-hitl-edit">
          <span className="ax-hitl-label">내 검토</span>
          <div className="ax-hitl-actions" role="radiogroup" aria-label="검토 액션">
            {(Object.keys(ACTION_META) as HitlAction[]).map(a => (
              <label key={a} className={`ax-hitl-action${action === a ? " is-selected" : ""}`}>
                <input
                  type="radio"
                  name={`hitl-action-${item.key}`}
                  value={a}
                  checked={action === a}
                  onChange={() => setAction(a)}
                />
                <span className="ax-hitl-action-label">{ACTION_META[a].label}</span>
                <span className="ax-hitl-action-desc">{ACTION_META[a].description}</span>
              </label>
            ))}
          </div>

          {action === "keep" ? (
            <label className="ax-field">
              <span>의견 (선택)</span>
              <Textarea
                rows={2}
                maxLength={2000}
                value={comment}
                onChange={e => setComment(e.target.value)}
                placeholder="유지 이유나 참고 사항을 입력하세요."
              />
            </label>
          ) : null}

          {action === "defer" ? (
            <>
              <label className="ax-field">
                <span>보류 사유 (필수)</span>
                <Textarea
                  rows={2}
                  maxLength={2000}
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="보류하는 이유를 입력하세요."
                />
              </label>
              <label className="ax-field">
                <span>재개 조건 (선택)</span>
                <Textarea
                  rows={2}
                  maxLength={2000}
                  value={resumeCondition}
                  onChange={e => setResumeCondition(e.target.value)}
                  placeholder="다시 진행하기 위한 조건을 입력하세요."
                />
              </label>
            </>
          ) : null}

          {action === "exclude" ? (
            <label className="ax-field">
              <span>제외 사유 (필수)</span>
              <Textarea
                rows={2}
                maxLength={2000}
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="제외하는 이유를 입력하세요."
              />
            </label>
          ) : null}

          {action === "supplement" ? (
            <label className="ax-field">
              <span>보완 내용 (필수)</span>
              <Textarea
                rows={3}
                maxLength={2000}
                value={supplement}
                onChange={e => setSupplement(e.target.value)}
                placeholder="AI 원본에 추가할 보완 내용을 입력하세요. 원본은 변경되지 않습니다."
              />
            </label>
          ) : null}

          {error ? <p className="ax-hitl-error" role="alert">{error}</p> : null}

          <div className="ax-hitl-buttons">
            <Button type="button" onClick={handleSave}>검토 확인</Button>
            {onCancel ? <Button type="button" variant="outline" onClick={onCancel}>취소</Button> : null}
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
              <Button type="button" variant="outline" onClick={onEdit}>검토 수정</Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
