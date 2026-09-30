import type {
  SupplementDraft,
  SupplementFinding,
  SupplementResult,
  SupplementReviewVerdict,
} from "@/domain/supplement";

const SEVERITY_ORDER = { critical: 0, warning: 1, suggestion: 2 } as const;
const MAX_QUESTIONS = 6;

/**
 * Final decision. A candidate the meaning-level re-check found supplied
 * elsewhere is dropped; one it could not decide is withheld rather than shown
 * as a gap. Candidates the re-check never reached keep their deterministic
 * verdict, and the result says the re-check was partial.
 */
export function finalizeSupplement(
  draft: SupplementDraft,
  verdicts: ReadonlyMap<string, SupplementReviewVerdict["verdict"]>,
): SupplementResult {
  const reviewed = new Set(draft.reviews.flatMap((batch) => batch.checks.map((check) => check.candidateId)));
  let resolvedCount = draft.resolvedCount;
  let withheldCount = 0;
  let unreviewed = 0;
  const findings: SupplementFinding[] = [];
  for (const candidate of draft.candidates) {
    const verdict = verdicts.get(candidate.id);
    if (verdict === "found") { resolvedCount += 1; continue; }
    if (verdict === "unclear") { withheldCount += 1; continue; }
    if (reviewed.has(candidate.id) && verdict === undefined) unreviewed += 1;
    const finding: SupplementFinding = { ...candidate };
    delete (finding as Partial<typeof candidate>).requirement;
    findings.push(finding);
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const questions = [...new Set(findings
    .filter((finding) => finding.severity !== "suggestion" && finding.question)
    .map((finding) => finding.question!))].slice(0, MAX_QUESTIONS);
  return {
    files: draft.files,
    coverage: draft.coverage,
    findings,
    questions,
    resolvedCount,
    withheldCount,
    semanticReview: reviewed.size === 0 ? "not-needed" : unreviewed > 0 ? "partial" : "complete",
  };
}
