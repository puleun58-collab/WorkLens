/**
 * HITL (Human-in-the-loop) review logic - Phase 2
 *
 * AI 진단 원본과 사람 검토 데이터를 분리 관리하고,
 * 원본 변경 시 재확인 필요 여부를 판정한다.
 */

import { createHash } from "crypto";
import type { AxDiagnosis, AxPlan, AxTaskV2, HitlReview, HitlTargetType, HitlAction, HitlStatus } from "./types";

/** 원본 텍스트의 SHA-256 해시 (변경 감지용) */
export function hashSource(text: string): string {
  return createHash("sha256").update(text.trim(), "utf8").digest("hex");
}

/** 검토 대상 식별 키 생성 */
export function makeTargetKey(type: HitlTargetType, source: "diagnosis" | "planCodex" | "planClaude", text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  return `${type}:${source}:${hashSource(normalized).slice(0, 16)}`;
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

  // step: 단계별 자동화 판단
  for (const s of diagnosis.stepAssessments ?? []) {
    const text = `${s.step}: ${s.verdict} (${s.owner})${s.note ? ` - ${s.note}` : ""}`;
    items.push({
      type: "step",
      source: "diagnosis",
      key: makeTargetKey("step", "diagnosis", s.step),
      text,
      sourceHash: hashSource(text),
    });
  }

  // risk: 위험 사항
  for (const r of diagnosis.risks ?? []) {
    items.push({
      type: "risk",
      source: "diagnosis",
      key: makeTargetKey("risk", "diagnosis", r),
      text: r,
      sourceHash: hashSource(r),
    });
  }

  // risk: 기술 확인 사항 (확인 필요/불가인 경우)
  for (const t of diagnosis.technicalChecks ?? []) {
    if (t.status !== "확인됨") {
      const text = `${t.topic}: ${t.status} - ${t.note}`;
      items.push({
        type: "risk",
        source: "diagnosis",
        key: makeTargetKey("risk", "diagnosis", t.topic),
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

  // planItem: 구현 계획 항목
  for (const p of plan.implementation ?? []) {
    items.push({
      type: "planItem",
      source,
      key: makeTargetKey("planItem", source, p),
      text: p,
      sourceHash: hashSource(p),
    });
  }

  // criterion: 완료 기준 (acceptance + tests)
  for (const c of [...(plan.acceptance ?? []), ...(plan.tests ?? [])]) {
    items.push({
      type: "criterion",
      source,
      key: makeTargetKey("criterion", source, c),
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
