import type {
  CheckCategoryGroup,
  CheckConfidence,
  CheckFinding,
  CheckResult,
  CheckSeverity,
} from "@/domain/operations";
import { checkCategoryGroup } from "@/domain/operations";
import { uniqueSources } from "./types";

export const MAX_FINDINGS = 500;

const SEVERITY_RANK: Record<CheckSeverity, number> = { critical: 3, warning: 2, suggestion: 1 };
const CONFIDENCE_RANK: Record<CheckConfidence, number> = { high: 3, medium: 2, low: 1 };

/** Dedupe key family: spelling and grammar collapse so one sentence issue is reported once. */
function familyOf(finding: CheckFinding): string {
  return finding.category === "spelling" || finding.category === "grammar" ? "language" : finding.code;
}

function dedupe(findings: readonly CheckFinding[]): CheckFinding[] {
  const merged = new Map<string, CheckFinding>();
  for (const finding of findings) {
    const sourceKey = finding.sources.map((source) => `${source.fileId}:${source.nodeId}`).sort().join("|");
    const textKey = (finding.originalText ?? finding.message).normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase();
    const key = `${familyOf(finding)}\0${textKey}\0${sourceKey}`;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, finding);
      continue;
    }
    const severityDelta = SEVERITY_RANK[finding.severity] - SEVERITY_RANK[previous.severity];
    const preferred = severityDelta > 0 || (severityDelta === 0 && CONFIDENCE_RANK[finding.confidence] > CONFIDENCE_RANK[previous.confidence])
      ? finding
      : previous;
    merged.set(key, {
      ...preferred,
      sources: uniqueSources([...previous.sources, ...finding.sources]),
      source: preferred.source,
    });
  }
  return [...merged.values()];
}

/**
 * Severity first, then confidence, then document order. Callers pass the
 * nodeId ordering of the parsed document so evidence reads top to bottom.
 */
export function sortFindings(findings: readonly CheckFinding[], order: ReadonlyMap<string, number>): CheckFinding[] {
  return [...findings].sort((left, right) => {
    const bySeverity = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
    if (bySeverity !== 0) return bySeverity;
    const byConfidence = CONFIDENCE_RANK[right.confidence] - CONFIDENCE_RANK[left.confidence];
    if (byConfidence !== 0) return byConfidence;
    const leftOrder = order.get(left.source.nodeId) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.source.nodeId) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.id.localeCompare(right.id);
  });
}

export function summarize(all: readonly CheckFinding[], returned: readonly CheckFinding[]): CheckResult["summary"] {
  const bySeverity: Record<CheckSeverity, number> = { critical: 0, warning: 0, suggestion: 0 };
  const byGroup: Record<CheckCategoryGroup, number> = { writing: 0, consistency: 0, data: 0, privacy: 0 };
  const byConfidence: Record<CheckConfidence, number> = { high: 0, medium: 0, low: 0 };
  for (const finding of all) {
    bySeverity[finding.severity] += 1;
    byGroup[checkCategoryGroup(finding.category)] += 1;
    byConfidence[finding.confidence] += 1;
  }
  return {
    totalFound: all.length,
    returned: returned.length,
    truncated: returned.length < all.length,
    bySeverity,
    byGroup,
    byConfidence,
  };
}

/**
 * Dedupes, prioritises and caps the finding list, then reports what was cut so
 * the UI can tell the user the result is partial.
 */
export function mergeFindings(
  findings: readonly CheckFinding[],
  order: ReadonlyMap<string, number>,
  limit: number = MAX_FINDINGS,
): { findings: CheckFinding[]; summary: CheckResult["summary"] } {
  const prioritised = sortFindings(dedupe(findings), order);
  const returned = prioritised.slice(0, limit);
  const idsByCode = new Map<string, string[]>();
  for (const finding of returned) idsByCode.set(finding.code, [...(idsByCode.get(finding.code) ?? []), finding.id]);
  const withRelations = returned.map((finding) => {
    const related = (idsByCode.get(finding.code) ?? []).filter((id) => id !== finding.id).slice(0, 5);
    return related.length ? { ...finding, relatedFindingIds: related } : finding;
  });
  return { findings: withRelations, summary: summarize(prioritised, withRelations) };
}
