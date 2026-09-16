import type {
  PolishCandidate,
  PolishOutcome,
  PolishProposal,
  PolishResult,
  PolishMode,
  PolishSummary,
  PolishTextResult,
} from "@/domain/polish";
import { verifyPolish } from "./protect";
import { assemblePolishText, type PolishTextSegment } from "./text-input";

/**
 * The single polish pipeline.
 *
 * Every entry point — the Polish view and the inline 윤문 action in Ask,
 * Brief, Check and Extract — turns its text into a `PolishCandidate`, sends it
 * through the same model contract, and accepts the answer only if
 * `verifyPolish` agrees. There is no second implementation and no per-feature
 * prompt: a rule added here applies everywhere at once.
 */

/** Model answers are proposals. This turns one into a verified outcome. */
export function reviewProposal(candidate: PolishCandidate, proposal: PolishProposal): PolishOutcome {
  const revised = proposal.revisedText.trim();
  const base: Pick<PolishOutcome, "id" | "originalText" | "source" | "origin"> = {
    id: candidate.id,
    originalText: candidate.text,
    source: candidate.source,
    origin: candidate.origin,
  };
  if (!proposal.changed || revised.length === 0 || revised === candidate.text.trim()) {
    return { ...base, status: "unchanged", revisedText: candidate.text, reasons: [] };
  }
  const verdict = verifyPolish(candidate.text, revised);
  if (!verdict.ok) {
    return {
      ...base,
      status: "rejected",
      revisedText: candidate.text,
      reasons: [],
      rejection: verdict.rejection,
    };
  }
  return {
    ...base,
    status: "changed",
    revisedText: revised,
    reasons: proposal.reasons.map((reason) => reason.trim()).filter(Boolean).slice(0, 3),
  };
}

export function summarizePolish(outcomes: readonly PolishOutcome[]): PolishSummary {
  return {
    candidates: outcomes.length,
    changed: outcomes.filter((entry) => entry.status === "changed").length,
    unchanged: outcomes.filter((entry) => entry.status === "unchanged").length,
    rejected: outcomes.filter((entry) => entry.status === "rejected").length,
  };
}

export function polishResult(mode: PolishMode, outcomes: readonly PolishOutcome[]): PolishResult {
  return { mode, outcomes: [...outcomes], summary: summarizePolish(outcomes) };
}

/**
 * A pasted-text run. The verified rewrites are placed back into the text the
 * user pasted, so the returned block keeps its line breaks, bullets and
 * numbering even when a segment was left unchanged or refused.
 */
export function polishTextResult(
  mode: PolishMode,
  originalText: string,
  segments: readonly PolishTextSegment[],
  outcomes: readonly PolishOutcome[],
): PolishTextResult {
  const revisedById = new Map(
    outcomes.filter((entry) => entry.status === "changed").map((entry) => [entry.id, entry.revisedText]),
  );
  return {
    mode,
    originalText,
    revisedText: assemblePolishText(segments, revisedById),
    outcomes: [...outcomes],
    summary: summarizePolish(outcomes),
  };
}

/** Copy text for one outcome, and for a whole run. */
export function polishClipboardText(outcomes: readonly PolishOutcome[]): string {
  return outcomes
    .filter((entry) => entry.status === "changed")
    .map((entry) => entry.revisedText)
    .join("\n\n");
}
