import { questionSubjectTerms, questionTerms, type ResearchAdoptionCandidate, type ResearchAdoptionVerdict } from "./research-relevance";

/**
 * Fair bounded views of obtained originals within the unchanged shared budget.
 * Allocation is max-min fair (water-filling): candidates are served shortest
 * first, each receiving at most an equal share of what is left, so a short
 * original is never cut while its unused share passes to longer ones, and a
 * long original can no longer crowd later candidates out of review.
 * Complete originals are served before partial previews: a preview can never
 * be adopted, so it only receives what the complete originals left over
 * (DESIGN §5-4: §6 evidence showed core articles windowed because previews and
 * long precedents took equal sequential shares).
 * Windows never claim that unseen clauses were inspected (offsets are kept);
 * the output keeps the caller's candidate order.
 */
export function researchCandidateWindows(originalQuery: string, issues: readonly { query: string }[], candidates: readonly ResearchAdoptionCandidate[], budget: number, perSource: number): (ResearchAdoptionCandidate & { window?: ResearchAdoptionVerdict["window"] })[] {
  const available = candidates.filter(candidate => candidate.text.trim());
  const terms = [...new Set([...questionSubjectTerms(originalQuery), ...issues.flatMap(issue => questionTerms(issue.query))])];
  const views = new Map<ResearchAdoptionCandidate, ResearchAdoptionCandidate & { window?: ResearchAdoptionVerdict["window"] }>();
  let remaining = budget;
  for (const tier of [available.filter(candidate => !candidate.partial), available.filter(candidate => candidate.partial)]) {
    const ordered = [...tier].sort((a, b) => a.text.length - b.text.length);
    ordered.forEach((candidate, index) => {
      const limit = Math.min(perSource, Math.floor(remaining / (ordered.length - index)));
      if (limit < 80) return;
      const view = boundedView(candidate, limit, terms);
      remaining -= view.text.length;
      views.set(candidate, view);
    });
  }
  return available.flatMap(candidate => views.get(candidate) ?? []);
}

function boundedView(candidate: ResearchAdoptionCandidate, limit: number, terms: readonly string[]): ResearchAdoptionCandidate & { window?: ResearchAdoptionVerdict["window"] } {
  if (candidate.text.length <= limit) return { ...candidate, partial: Boolean(candidate.partial) };
  // Retain the original offsets. Selecting a paragraph is attention, not adoption.
  let cursor = 0, best = 0, bestScore = -1;
  for (const line of candidate.text.split(/\n/gu)) {
    const score = terms.reduce((sum, term) => sum + (line.includes(term) ? Math.min(term.length, 8) : 0), 0);
    if (score > bestScore && line.trim()) { bestScore = score; best = cursor; }
    cursor += line.length + 1;
  }
  const start = Math.min(best, Math.max(0, candidate.text.length - limit));
  let end = Math.min(candidate.text.length, start + limit);
  if (end < candidate.text.length) {
    const viewed = candidate.text.slice(start, end);
    const boundary = Math.max(viewed.lastIndexOf("\n"), viewed.lastIndexOf("."));
    if (boundary >= Math.floor(limit / 2)) end = start + boundary + 1;
  }
  const text = candidate.text.slice(start, end);
  return { ...candidate, text, partial: Boolean(candidate.partial), window: { start, end, total: candidate.text.length } };
}
