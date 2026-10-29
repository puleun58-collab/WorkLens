/**
 * One result-status vocabulary for every 종합 리서치 task. Each task decides the
 * status from the evidence it actually adopted, never from how many hits a search returned.
 */
export type ResearchStatus = "matched" | "partial" | "weak" | "viewed" | "failed" | "none";

/**
 * `viewed` is retrieval without confirmation (the old blanket `weak` claimed
 * a relevance judgment no check had made); `failed` is an unfinished lookup,
 * never a claim that no law exists. Both keep the existing four meanings
 * untouched. They are produced by the server evidence assessments:
 * procedure_detail (PR #326) and law_system / action_basis / dispute_prep /
 * amendment_track (this change).
 */
/**
 * Integrated-research overall status, from what was actually adopted.
 * `matched` requires a confirmed statute article somewhere in the answer:
 * precedents alone never confirm a statute question, so a fully
 * precedent-covered answer is `partial`, not `matched`. A relation
 * question (law + article named, counterpart tier asked about) whose
 * adopted articles contain no subordinate-law article is likewise capped
 * at `partial`: the parent article's delegation wording is confirmed, but
 * the counterpart article itself is not. Both caps only ever downgrade.
 * Exception (policy decision, 2026-10-28 integrated directive): when the
 * question names no law at all, a directly-adopted precedent IS the
 * adopted evidence for that precedent-seeking question, so
 * `precedentSufficient` admits `matched`. A law-seeking question still
 * needs an adopted statute article.
 */
export function integratedEvidenceStatus(
  coveredCount: number,
  issueCount: number,
  hasArticle: boolean,
  relationCapped = false,
  precedentSufficient = false,
): "matched" | "partial" | "unverified" {
  if (coveredCount === issueCount && (hasArticle || precedentSufficient) && !relationCapped) return "matched";
  return coveredCount ? "partial" : "unverified";
}

export const STATUS_TITLE: Record<ResearchStatus, string> = {
  matched: "관련 근거를 확인했습니다",
  partial: "관련 근거를 일부 확인했습니다",
  weak: "직접 관련된 근거가 충분하지 않습니다",
  viewed: "관련 자료를 조회했습니다",
  failed: "자료 조회를 완료하지 못했습니다",
  none: "관련 근거를 확인하지 못했습니다",
};
