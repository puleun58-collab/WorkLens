import type { SourceRef } from "@/domain/document";
import type {
  SupplementCandidate,
  SupplementDraft,
  SupplementFinding,
  SupplementResult,
  SupplementVerdict,
} from "@/domain/supplement";
import { clip } from "./text";
import type { SupplementDiagnostics } from "./diagnostics";

const SEVERITY_ORDER = { critical: 0, warning: 1, suggestion: 2 } as const;
const SCOPE_ORDER = { all: 0, conflict: 1, report: 2 } as const;
const MAX_QUESTIONS = 6;

/** The meaning-level re-check's answer for one candidate, with the lines it cited. */
export interface SupplementReviewOutcome { verdict: SupplementVerdict; sources: SourceRef[] }

/** Page, slide or cell of a source in the reader's words; never invented. */
function locationOf(source: SourceRef, fileName: string | undefined): string {
  const locator = source.locator;
  const place = locator?.kind === "pptx" ? `${locator.slide}P`
    : locator?.kind === "pdf" ? `${locator.page}페이지`
      : locator?.kind === "xlsx" ? `${locator.sheet} / ${locator.range}`
        : source.label;
  return fileName ? `${fileName} / ${place}` : place;
}

/**
 * Final decision, in the order the evidence was searched:
 * 1. the same file supplies it → dropped (in-file rebuttal);
 * 2. another file supplies it → a report supplement when the gap sits in a
 *    core report and matters for a decision, otherwise confirmed and dropped;
 * 3. nothing supplies it → a gap of the whole set.
 * An undecided re-check withholds the candidate instead of showing a gap.
 */
export function finalizeSupplement(
  draft: SupplementDraft,
  outcomes: ReadonlyMap<string, SupplementReviewOutcome>,
  diagnostics?: SupplementDiagnostics,
): SupplementResult {
  const multi = draft.files.length > 1;
  const nameOf = new Map(draft.files.map((file) => [file.fileId, file.fileName]));
  const reviewed = new Set(draft.reviews.flatMap((batch) => batch.checks.map((check) => check.candidateId)));
  let resolvedCount = draft.resolvedCount;
  let confirmedCount = 0;
  let withheldCount = 0;
  let unreviewed = 0;
  const findings: SupplementFinding[] = [];
  const merged = new Map<string, SupplementFinding>();

  const toFinding = (candidate: SupplementCandidate, overrides: Partial<SupplementFinding> = {}): SupplementFinding => {
    const finding: SupplementFinding & Partial<SupplementCandidate> = { ...candidate, ...overrides };
    delete finding.requirement;
    delete finding.topic;
    delete finding.reportEligible;
    delete finding.reportTitle;
    return finding;
  };

  for (const candidate of draft.candidates) {
    if (candidate.scope === "conflict") { findings.push(toFinding(candidate)); continue; }
    const outcome = outcomes.get(candidate.id);
    const found = outcome?.verdict === "found" ? outcome.sources : [];
    if (found.some((source) => source.fileId === candidate.fileId)) {
      resolvedCount += 1;
      if (diagnostics) { diagnostics.rejected.covered_elsewhere += 1; diagnostics.rebutted += 1; }
      continue;
    }
    if (outcome?.verdict === "unclear") {
      withheldCount += 1;
      if (diagnostics) diagnostics.rejected.insufficient_evidence += 1;
      continue;
    }
    if (reviewed.has(candidate.id) && outcome === undefined) {
      unreviewed += 1;
      if (diagnostics) { diagnostics.rejected.system_failure += 1; diagnostics.systemAffected = true; }
    }

    const elsewhere = [...(candidate.evidence ?? []), ...found.filter((source) => !candidate.evidence?.some((known) => known.nodeId === source.nodeId && known.fileId === source.fileId))];
    if (elsewhere.length > 0) {
      if (!candidate.reportEligible) { confirmedCount += 1; continue; }
      const evidenceFiles = [...new Set(elsewhere.map((source) => nameOf.get(source.fileId) ?? ""))].filter(Boolean);
      const target = nameOf.get(candidate.fileId) ?? "";
      findings.push(toFinding(candidate, {
        scope: "report",
        // The information exists; the report only needs to carry it.
        severity: candidate.severity === "critical" ? "warning" : candidate.severity,
        status: "missing",
        title: candidate.reportTitle,
        message: `${evidenceFiles.join(", ")}에는 관련 설명이 있으나 ${target}에서는 해당 내용을 확인하기 어렵습니다.`,
        additions: elsewhere.map((source) => clip(source.quote ?? "", 80)).filter(Boolean).slice(0, 3),
        evidence: elsewhere,
        // Section-level labels computed while outlining are kept; model-found lines get their own.
        evidenceLocations: [...(candidate.evidenceLocations ?? []), ...elsewhere.slice(candidate.evidence?.length ?? 0).map((source) => locationOf(source, multi ? nameOf.get(source.fileId) : undefined))],
        limitation: undefined,
      }));
      continue;
    }

    // Not found anywhere: one finding per topic across the set.
    const finding = toFinding(candidate);
    if (reviewed.has(candidate.id) && outcome === undefined) {
      finding.status = "unverified";
      finding.limitation = [finding.limitation, "의미 기반 재확인을 완료하지 못해 누락 여부를 확정하지 않았습니다."].filter(Boolean).join(" ");
    }
    const existing = merged.get(candidate.topic);
    if (existing) {
      if (diagnostics) diagnostics.rejected.duplicate += 1;
      existing.sources = [...existing.sources, ...finding.sources];
      existing.locations = [...new Set([...existing.locations, ...finding.locations])];
      if (SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[existing.severity]) existing.severity = finding.severity;
      continue;
    }
    merged.set(candidate.topic, finding);
    findings.push(finding);
  }

  findings.sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  // Questions nobody can answer from the set come first; those the report alone cannot answer next.
  const questions = [...new Set(findings
    .filter((finding) => finding.severity !== "suggestion" && finding.question)
    .sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope])
    .map((finding) => finding.question!))].slice(0, MAX_QUESTIONS);
  if (diagnostics) diagnostics.final = findings.length;
  return {
    files: draft.files,
    coverage: draft.coverage,
    findings,
    questions,
    resolvedCount,
    confirmedCount,
    withheldCount,
    semanticReview: reviewed.size === 0 ? "not-needed" : unreviewed > 0 ? "partial" : "complete",
  };
}
