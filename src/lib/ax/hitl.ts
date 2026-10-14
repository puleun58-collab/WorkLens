/**
 * HITL (Human-in-the-loop) review logic - Phase 2
 *
 * AI 진단 원본과 사람 검토 데이터를 분리 관리하고,
 * 원본 변경 시 재확인 필요 여부를 판정한다.
 */

import { sha256Hex } from "@/domain/hash";
import type { AxDiagnosis, AxPlan, AxTaskV2, HitlReview, HitlTargetType, HitlStatus } from "./types";

/** 원본 텍스트의 SHA-256 해시 (변경 감지용)
 * 브라우저·서버 공용 순수 TS 구현 사용 (Node crypto 불필요)
 * 기존 createHash("sha256")와 동일한 표준 SHA-256 출력 */
export function hashSource(text: string): string {
  return sha256Hex(text.trim());
}

/** 검토 대상 식별 키 생성
 * 동일 문구가 복수 항목에 존재할 때 충돌 방지용 occurrence 인덱스 포함
 * occurrence는 같은 type+source+텍스트 해시 내에서의 등장 순서 (0부터)
 * 재정렬 시에도 동일 항목은 동일 키 유지 (등장 순서 기준) */
export function makeTargetKey(
  type: HitlTargetType,
  source: "diagnosis" | "planCodex" | "planClaude",
  text: string,
  occurrence: number = 0,
): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  const hash = hashSource(normalized).slice(0, 16);
  return occurrence > 0 ? `${type}:${source}:${hash}:${occurrence}` : `${type}:${source}:${hash}`;
}

/** 중복 문구의 occurrence 카운터 */
class OccurrenceTracker {
  private counts = new Map<string, number>();
  /** 해당 키의 다음 occurrence 인덱스 반환 (0부터) */
  next(baseKey: string): number {
    const count = this.counts.get(baseKey) ?? 0;
    this.counts.set(baseKey, count + 1);
    return count;
  }
}

export interface ReviewableItem {
  type: HitlTargetType;
  source: "diagnosis" | "planCodex" | "planClaude";
  key: string;
  text: string;
  sourceHash: string;
}

/** 진단에서 검토 가능한 항목 추출 */
export function extractReviewableItems(diagnosis: AxDiagnosis): ReviewableItem[] {
  const items: ReviewableItem[] = [];
  const tracker = new OccurrenceTracker();

  // step: 단계별 자동화 판단
  for (const s of diagnosis.stepAssessments ?? []) {
    const text = `${s.step}: ${s.verdict} (${s.owner})${s.note ? ` - ${s.note}` : ""}`;
    const baseKey = makeTargetKey("step", "diagnosis", s.step);
    const occurrence = tracker.next(baseKey);
    items.push({
      type: "step",
      source: "diagnosis",
      key: makeTargetKey("step", "diagnosis", s.step, occurrence),
      text,
      sourceHash: hashSource(text),
    });
  }

  // risk: 위험 사항
  for (const r of diagnosis.risks ?? []) {
    const baseKey = makeTargetKey("risk", "diagnosis", r);
    const occurrence = tracker.next(baseKey);
    items.push({
      type: "risk",
      source: "diagnosis",
      key: makeTargetKey("risk", "diagnosis", r, occurrence),
      text: r,
      sourceHash: hashSource(r),
    });
  }

  // risk: 기술 확인 사항 (확인 필요/불가인 경우)
  for (const t of diagnosis.technicalChecks ?? []) {
    if (t.status !== "확인됨") {
      const text = `${t.topic}: ${t.status} - ${t.note}`;
      const baseKey = makeTargetKey("risk", "diagnosis", t.topic);
      const occurrence = tracker.next(baseKey);
      items.push({
        type: "risk",
        source: "diagnosis",
        key: makeTargetKey("risk", "diagnosis", t.topic, occurrence),
        text,
        sourceHash: hashSource(text),
      });
    }
  }

  return items;
}

/** 계획에서 검토 가능한 항목 추출 */
export function extractPlanReviewableItems(plan: AxPlan, tool: "codex" | "claude"): ReviewableItem[] {
  const items: ReviewableItem[] = [];
  const source = tool === "codex" ? "planCodex" : "planClaude";
  const tracker = new OccurrenceTracker();

  // planItem: 구현 계획 항목
  for (const p of plan.implementation ?? []) {
    const baseKey = makeTargetKey("planItem", source, p);
    const occurrence = tracker.next(baseKey);
    items.push({
      type: "planItem",
      source,
      key: makeTargetKey("planItem", source, p, occurrence),
      text: p,
      sourceHash: hashSource(p),
    });
  }

  // criterion: 완료 기준 (acceptance + tests)
  for (const c of [...(plan.acceptance ?? []), ...(plan.tests ?? [])]) {
    const baseKey = makeTargetKey("criterion", source, c);
    const occurrence = tracker.next(baseKey);
    items.push({
      type: "criterion",
      source,
      key: makeTargetKey("criterion", source, c, occurrence),
      text: c,
      sourceHash: hashSource(c),
    });
  }

  return items;
}

/** 검토 상태 전환 가능 여부 */
export function canTransition(from: HitlStatus, to: HitlStatus): boolean {
  const allowed: Record<HitlStatus, HitlStatus[]> = {
    pending: ["editing"],
    editing: ["pending", "confirmed"],
    confirmed: ["editing", "stale"],
    stale: ["editing", "confirmed"],
  };
  return allowed[from]?.includes(to) ?? false;
}

/** 원본 변경 시 stale 판정 */
export function shouldMarkStale(review: HitlReview, currentHash: string): boolean {
  if (review.status !== "confirmed") return false;
  return review.target.sourceHash !== currentHash;
}

/** 검토 대상 연결 상태 */
export type ReviewLinkStatus =
  | "matched"      // 현재 원본과 일치
  | "changed"      // 동일 대상, 내용 변경 → stale
  | "gone"         // 원본 대상 없음 (기록 보존, 현행 적용 제한)
  | "ambiguous";   // 연결 불명확 (자동 적용 금지)

/** 재진단/재생성 후 검토와 새 원본의 연결 상태 판정 */
export function reconcileReviews(
  reviews: HitlReview[],
  currentItems: ReviewableItem[],
): Map<string, { review: HitlReview; status: ReviewLinkStatus; currentItem?: ReviewableItem }> {
  const result = new Map<string, { review: HitlReview; status: ReviewLinkStatus; currentItem?: ReviewableItem }>();
  const itemByKey = new Map(currentItems.map(i => [i.key, i]));

  for (const review of reviews) {
    const current = itemByKey.get(review.target.key);
    if (!current) {
      // 키로 찾지 못함 → 대상 소멸 또는 식별 불가
      // 기존 기록은 보존하되 현행 판단으로 사용하지 않음
      result.set(review.id, { review, status: "gone" });
    } else if (current.sourceHash === review.target.sourceHash) {
      result.set(review.id, { review, status: "matched", currentItem: current });
    } else {
      // 동일 키, 내용 변경 → stale
      result.set(review.id, { review, status: "changed", currentItem: current });
    }
  }

  return result;
}

/** 업무의 특정 대상에 대한 검토 조회 */
export function findReview(task: AxTaskV2, key: string): HitlReview | undefined {
  return task.reviews?.find(r => r.target.key === key);
}

/** 유효한(확인 완료된) 검토만 필터링 */
export function getConfirmedReviews(task: AxTaskV2): HitlReview[] {
  return (task.reviews ?? []).filter(r => r.status === "confirmed");
}

/** 액션별 실행 반영 여부 (3차에서 사용, 2차에서는 저장만) */
export function isReviewActionApplicable(review: HitlReview): boolean {
  return review.status === "confirmed";
}
