/**
 * 범용 업무 규칙 (D1~D7과 별개 체계).
 *
 * 원칙:
 * - 규칙은 사용자가 근거(출처·관련 단계)와 함께 직접 추가·확정한 것만 저장한다.
 *   AI가 자동 생성·확정하지 않으며, 키워드만으로 적용 여부를 결정하지 않는다.
 * - 적용 여부(applicability)와 확정 여부(status)는 별개 차원이다. 적용 근거가
 *   없는 사항을 자동 "해당 없음"·"확정"으로 바꾸지 않는다.
 * - id는 D1~D7과 충돌하지 않는 고유 체계(R + 숫자)를 쓴다. 의미가 일부만
 *   겹치는 규칙은 자동 병합하지 않는다.
 * - 완료 현황 분모는 실제로 적용되는 확인 대상 규칙 수다. D규칙의 "해당 없음"과
 *   범용 규칙의 적용 "해당 없음"은 적용 제외로 분모에서 빠진다.
 */
import { DECISION_POINT_IDS, GENERIC_RULE_APPLICABILITY, GENERIC_RULE_CATEGORIES, GENERIC_RULE_STATUSES } from "./schema";
import type { GenericRule, GenericRuleApplicability, GenericRuleStatus } from "./types";
import type { ResolvedDecisionPoint } from "./decision-points";

const DECISION_IDS = new Set<string>(DECISION_POINT_IDS);
const CATEGORIES = new Set<string>(GENERIC_RULE_CATEGORIES);
const APPLICABILITY = new Set<string>(GENERIC_RULE_APPLICABILITY);
const STATUSES = new Set<string>(GENERIC_RULE_STATUSES);

const clean = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};

/** 저장된 목록을 유효한 범용 규칙만 남도록 정리한다. 무효 항목은 버린다 (자동 생성·보정 없음). */
export function resolveGenericRules(list?: readonly GenericRule[] | null): GenericRule[] {
  const seen = new Set<string>();
  const out: GenericRule[] = [];
  for (const item of list ?? []) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    const name = clean(item?.name, 120);
    if (!id || DECISION_IDS.has(id) || seen.has(id) || !name) continue;
    if (!CATEGORIES.has(item?.category) || !APPLICABILITY.has(item?.applicability) || !STATUSES.has(item?.status)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      category: item.category,
      ...(clean(item?.detail, 2000) ? { detail: clean(item.detail, 2000) as string } : {}),
      ...(clean(item?.source, 500) ? { source: clean(item.source, 500) as string } : {}),
      ...(clean(item?.step, 500) ? { step: clean(item.step, 500) as string } : {}),
      applicability: item.applicability,
      status: item.status,
      ...(item?.linkedDecisionId && DECISION_IDS.has(item.linkedDecisionId) ? { linkedDecisionId: item.linkedDecisionId } : {}),
    });
  }
  return out;
}

/** 다음 규칙 id. 기존 R + 숫자 중 최대값 + 1이며, D ID와는 겹치지 않는다. */
export function nextGenericRuleId(existing: readonly GenericRule[]): string {
  let max = 0;
  for (const rule of existing) {
    const match = /^R(\d+)$/u.exec(rule.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `R${max + 1}`;
}

/** 확정 규칙: 적용 + 확정인 경우만. 미확정·적용 여부 미확정·해당 없음은 확정 규칙이 아니다. */
export function confirmedGenericRules(rules: readonly GenericRule[]): GenericRule[] {
  return rules.filter(rule => rule.applicability === "적용" && rule.status === "확정");
}

/** 적용되나 미확정인 규칙 (완료 현황 분모에 포함, 완료에는 포함되지 않음). */
export function pendingGenericRules(rules: readonly GenericRule[]): GenericRule[] {
  return rules.filter(rule => rule.applicability === "적용" && rule.status === "미확정");
}

/** 적용 여부 자체가 미확정인 규칙 (분모에 포함하지 않고 별도 건수로 표시). */
export function applicabilityPendingGenericRules(rules: readonly GenericRule[]): GenericRule[] {
  return rules.filter(rule => rule.applicability === "적용 여부 미확정");
}

export interface RuleProgress {
  /** 확정된 규칙 수. */
  done: number;
  /** 실제로 적용되는 확인 대상 규칙 수 (해당 없음 제외). */
  total: number;
  /** 적용 여부 확인이 필요한 규칙 수 (분모 외 별도 표시). */
  applicabilityPending: number;
}

/**
 * D규칙 + 범용 규칙 통합 완료 현황.
 * - D규칙: "확정"은 완료, "해당 없음"은 적용 제외(분모 제외), "미확정"은 분모에 포함.
 * - 범용 규칙: 적용 + 확정은 완료, 적용 + 미확정은 분모에 포함,
 *   적용 여부 미확정은 분모 외 별도 건수, 해당 없음은 적용 제외.
 */
export function ruleProgress(points: readonly ResolvedDecisionPoint[], rules: readonly GenericRule[]): RuleProgress {
  let done = 0;
  let total = 0;
  for (const point of points) {
    if (point.status === "확정") { done += 1; total += 1; }
    else if (point.status === "미확정") total += 1;
  }
  for (const rule of rules) {
    if (rule.applicability === "적용" && rule.status === "확정") { done += 1; total += 1; }
    else if (rule.applicability === "적용") total += 1;
  }
  return { done, total, applicabilityPending: applicabilityPendingGenericRules(rules).length };
}

/** 확정 규칙 중 지시문 본문에 규칙명이 나타나지 않는 항목 (§8.4 전달 누락 검출용). */
export function missingConfirmedGenericRules(prompt: string, rules: readonly GenericRule[]): GenericRule[] {
  return confirmedGenericRules(rules).filter(rule => !prompt.includes(rule.name));
}

const normalizeName = (name: string): string => name.replace(/\s+/gu, " ").trim();

/**
 * 동일 정규화 규칙명에 상이한 상세가 있는 확정 규칙 쌍 (§9.2 의미 중복·충돌 검출).
 * 자동 병합·삭제하지 않고 확인 필요 문구만 반환한다.
 */
export function duplicateGenericRuleConflicts(rules: readonly GenericRule[]): string[] {
  const byName = new Map<string, GenericRule[]>();
  for (const rule of confirmedGenericRules(rules)) {
    const key = normalizeName(rule.name);
    const group = byName.get(key) ?? [];
    group.push(rule);
    byName.set(key, group);
  }
  const out: string[] = [];
  for (const [name, group] of byName) {
    const details = new Set(group.map(rule => normalizeName(rule.detail ?? "")));
    if (group.length > 1 && details.size > 1) {
      out.push(`범용 규칙 "${name}"에 서로 다른 확정 내용(${group.map(rule => rule.id).join(", ")})이 있습니다. 어느 쪽도 임의로 선택하지 말고 확인 대상으로 보고하세요.`);
    }
  }
  return out;
}
