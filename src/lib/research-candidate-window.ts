import { questionSubjectTerms, questionTerms, type ResearchAdoptionCandidate, type ResearchAdoptionVerdict } from "./research-relevance";

/** Fair bounded views of obtained originals; windows never claim that unseen clauses were inspected. */
export function researchCandidateWindows(originalQuery: string, issues: readonly { query: string }[], candidates: readonly ResearchAdoptionCandidate[], budget: number, perSource: number): (ResearchAdoptionCandidate & { window?: ResearchAdoptionVerdict["window"] })[] {
  const available = candidates.filter(candidate => candidate.text.trim() && !candidate.partial);
  const terms = [...new Set([...questionSubjectTerms(originalQuery), ...issues.flatMap(issue => questionTerms(issue.query))])];
  let remaining = budget;
  return available.flatMap((candidate, index) => {
    const limit = Math.min(perSource, Math.floor(remaining / (available.length - index)));
    if (limit < 80) return [];
    if (candidate.text.length <= limit) {
      remaining -= candidate.text.length;
      return [{ ...candidate }];
    }
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
    remaining -= text.length;
    return [{ ...candidate, text, window: { start, end, total: candidate.text.length } }];
  });
}
