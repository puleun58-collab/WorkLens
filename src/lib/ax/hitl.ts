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

/** 계획 항목의 검토 키를 (필드, 인덱스) 기준으로 미리 계산
 * extractPlanReviewableItems와 동일한 순서·occurrence 규칙을 사용하여,
 * buildAgentInstructionModel에서 classified 항목에 정확한 reviewKey를 부여한다.
 * 반환: `${field}:${index}` -> reviewable key (field: implementation|acceptance|tests) */
export function buildPlanReviewKeyMap(plan: AxPlan, tool: "codex" | "claude"): Map<string, string> {
  const source = tool === "codex" ? "planCodex" : "planClaude";
  const counts = new Map<string, number>();
  const map = new Map<string, string>();
  const nextKey = (type: HitlTargetType, text: string): string => {
    const normalized = text.trim().replace(/\s+/g, " ");
    const hash = hashSource(normalized).slice(0, 16);
    const base = `${type}:${source}:${hash}`;
    const occurrence = counts.get(base) ?? 0;
    counts.set(base, occurrence + 1);
    return makeTargetKey(type, source, text, occurrence);
  };
  // extractPlanReviewableItems와 동일한 순서: implementation[] → acceptance[] → tests[]
  (plan.implementation ?? []).forEach((item, i) => map.set(`implementation:${i}`, nextKey("planItem", item)));
  (plan.acceptance ?? []).forEach((item, i) => map.set(`acceptance:${i}`, nextKey("criterion", item)));
  (plan.tests ?? []).forEach((item, i) => map.set(`tests:${i}`, nextKey("criterion", item)));
  return map;
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
  // 중복 키 감지: 동일 키가 여러 항목에 존재하면 모호함
  const keyCounts = new Map<string, number>();
  for (const item of currentItems) {
    keyCounts.set(item.key, (keyCounts.get(item.key) ?? 0) + 1);
  }

  for (const review of reviews) {
    const current = itemByKey.get(review.target.key);
    if (!current) {
      // 키로 찾지 못함 → 대상 소멸 또는 식별 불가
      // 기존 기록은 보존하되 현행 판단으로 사용하지 않음
      result.set(review.id, { review, status: "gone" });
    } else if ((keyCounts.get(review.target.key) ?? 0) > 1) {
      // 동일 키가 여러 항목에 존재 → 모호한 연결, 자동 적용 금지
      result.set(review.id, { review, status: "ambiguous", currentItem: current });
    } else if ((review.target.type && current.type !== review.target.type) || (review.target.source && current.source !== review.target.source)) {
      // 유형·출처 불일치 → 모호함 (필드가 있을 때만 검증)
      result.set(review.id, { review, status: "ambiguous", currentItem: current });
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

/** 현재 원본 기준으로 유효한 confirmed 검토만 반환
 * 저장된 confirmed와 현재 유효한 confirmed를 구분 (HITL 3차 대비)
 * - 현재 업무에 속함
 * - 대상이 현재 원본에 존재함
 * - 검토 당시 해시와 현재 해시가 일치함 */
export function getValidConfirmedReviews(task: AxTaskV2, currentItems: ReviewableItem[]): HitlReview[] {
  const itemMap = new Map(currentItems.map(i => [i.key, i]));
  // 중복 키 감지: 동일한 키가 여러 항목에 존재하면 모호함
  const keyCounts = new Map<string, number>();
  for (const item of currentItems) {
    keyCounts.set(item.key, (keyCounts.get(item.key) ?? 0) + 1);
  }
  return (task.reviews ?? []).filter(r => {
    if (r.status !== "confirmed") return false;
    const current = itemMap.get(r.target.key);
    if (!current) return false; // 대상 소멸 (gone)
    // 유형·출처 검증 (필드가 있을 때만 검증 - 기존 데이터 호환)
    if (r.target.type && current.type !== r.target.type) return false;
    if (r.target.source && current.source !== r.target.source) return false;
    // 해시 검증 (원본 변경 시 stale)
    if (current.sourceHash !== r.target.sourceHash) return false;
    // 중복·모호성 검증: 동일한 키가 여러 항목에 있으면 자동 적용 금지
    if ((keyCounts.get(r.target.key) ?? 0) > 1) return false;
    return true;
  });
}

/** 액션별 실행 반영 여부 (3차에서 사용, 2차에서는 저장만) */
export function isReviewActionApplicable(review: HitlReview): boolean {
  return review.status === "confirmed";
}

/** 검토 확정 전 원본 유효성 검증 결과 */
export interface ReviewValidation {
  valid: boolean;
  /** valid=false일 때 사용자에게 안내할 사유 */
  reason?: string;
}

/**
 * confirmed 저장 전 현재 원본 기준으로 검토 대상의 전체 일치 여부를 검증한다.
 * - 업무/진단/계획 존재, 대상 존재, 키·유형·출처·해시 일치, 중복 없음
 * - 원본이 없거나 검증에 실패하면 confirmed 저장을 차단해야 한다.
 */
export function validateReviewForConfirm(
  task: AxTaskV2 | undefined,
  target: Pick<HitlReview["target"], "key" | "type" | "source" | "sourceHash">,
): ReviewValidation {
  if (!task) return { valid: false, reason: "업무를 찾을 수 없습니다." };
  let currentItems: ReviewableItem[];
  try {
    if (target.source === "diagnosis") {
      if (!task.diagnosis) return { valid: false, reason: "진단 결과가 없어 검토를 확정할 수 없습니다." };
      currentItems = extractReviewableItems(task.diagnosis);
    } else if (target.source === "planCodex" || target.source === "planClaude") {
      if (!task.diagnosis) return { valid: false, reason: "진단 결과가 없어 검토를 확정할 수 없습니다." };
      const tool = target.source === "planCodex" ? "codex" : "claude";
      const plan = tool === "codex" ? task.diagnosis.planCodex : task.diagnosis.planClaude;
      if (!plan) return { valid: false, reason: "해당 계획이 없어 검토를 확정할 수 없습니다. 계획을 먼저 생성하세요." };
      currentItems = extractPlanReviewableItems(plan, tool);
    } else {
      return { valid: false, reason: "알 수 없는 검토 출처입니다." };
    }
  } catch {
    return { valid: false, reason: "원본을 확인할 수 없어 검토를 확정할 수 없습니다." };
  }
  if (currentItems.length === 0) return { valid: false, reason: "검토 대상이 없어 확정을 진행할 수 없습니다." };
  const matches = currentItems.filter((item) => item.key === target.key);
  if (matches.length === 0) return { valid: false, reason: "검토 대상이 현재 원본에 없습니다. 원본이 변경되었을 수 있습니다." };
  if (matches.length > 1) return { valid: false, reason: "동일한 검토 대상이 여러 개 있어 확정할 수 없습니다. 다시 확인해 주세요." };
  const current = matches[0];
  if (target.type && current.type !== target.type) return { valid: false, reason: "검토 대상 유형이 현재 원본과 다릅니다." };
  if (current.source !== target.source) return { valid: false, reason: "검토 출처가 현재 원본과 다릅니다." };
  if (current.sourceHash !== target.sourceHash) return { valid: false, reason: "원본이 변경되어 재확인이 필요합니다." };
  return { valid: true };
}
