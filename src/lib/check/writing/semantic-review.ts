import type { GroundedClaim } from "@/domain/ai";
import type { CheckFinding } from "@/domain/operations";
import { makeFinding } from "../types";

/**
 * Browser Semantic Layer.
 *
 * The deterministic layers above never call a model. When the in-browser model
 * is available, its grounded sentence review is folded into the same finding
 * list, always as suggestions so a model can never outrank a deterministic
 * rule in the result ordering.
 */
export function semanticFindings(claims: readonly GroundedClaim[]): CheckFinding[] {
  const findings: CheckFinding[] = [];
  for (const claim of claims) {
    const text = claim.text.trim();
    if (!text) continue;
    const sources = claim.evidence.map((binding) => binding.source);
    if (sources.length === 0) continue;
    findings.push(makeFinding({
      code: "semantic-writing-suggestion",
      ruleId: `writing/semantic:${claim.kind}`,
      category: "wording",
      severity: "suggestion",
      confidence: claim.kind === "inference" ? claim.confidence ?? "low" : "low",
      issue: "브라우저 AI 문장 검토 의견",
      message: text,
      reason: claim.kind === "fact"
        ? "브라우저 AI가 원문에서 직접 확인한 문장 문제입니다."
        : "브라우저 AI의 문맥 판단이며 확정된 오류가 아닙니다.",
      recommendation: "제안 내용을 원문과 대조한 뒤 필요할 때만 반영하세요.",
      sources,
      originalText: claim.evidence[0]?.source.quote || undefined,
    }));
  }
  return findings;
}

/**
 * Appends semantic suggestions to an existing deterministic finding list,
 * dropping duplicates that already have a deterministic equivalent at the same
 * location. Pure function: the caller owns re-sorting.
 */
export function mergeSemanticFindings(
  deterministic: readonly CheckFinding[],
  semantic: readonly CheckFinding[],
): CheckFinding[] {
  const occupied = new Set(deterministic.map((finding) => `${finding.source.fileId}\0${finding.source.nodeId}\0${finding.category}`));
  return [
    ...deterministic,
    ...semantic.filter((finding) => !occupied.has(`${finding.source.fileId}\0${finding.source.nodeId}\0${finding.category}`)),
  ];
}
