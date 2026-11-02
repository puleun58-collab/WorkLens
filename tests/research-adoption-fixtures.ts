import { expect } from "vitest";
import type { ResearchAdoptionCandidate, ResearchAdoptionVerdict } from "@/lib/research-relevance";

/** A recorded semantic decision, bound to the server handle of its actual source text. */
export type AdoptionSelectionFixture = {
  issueIndex: number;
  source: { law: string; jo: string } | { precedentId: string };
  quote: string;
  reason: string;
  role?: ResearchAdoptionVerdict["role"];
};

export function adoptionResponse(selections: readonly AdoptionSelectionFixture[]) {
  return async (
    _originalQuery: string,
    _issues: readonly { label?: string; query: string }[],
    candidates: readonly ResearchAdoptionCandidate[],
  ): Promise<ResearchAdoptionVerdict[]> => selections.map((selection) => {
    const source = selection.source;
    const compactQuote = selection.quote.replace(/\s+/gu, "");
    const candidate = candidates.find((candidate) =>
      ("precedentId" in source
        ? candidate.kind === "precedent" && candidate.precedentId === source.precedentId
        : candidate.kind === "article" && candidate.law === source.law && candidate.jo === source.jo)
      && candidate.text.replace(/\s+/gu, "").includes(compactQuote));
    expect(candidate, `Acquired source for semantic selection: ${JSON.stringify(source)}`).toBeDefined();
    expect(compactQuote.length).toBeGreaterThanOrEqual(16);
    expect(selection.reason.replace(/\s+/gu, "").length).toBeGreaterThanOrEqual(20);
    return {
      issueIndex: selection.issueIndex,
      candidateId: candidate!.id,
      role: selection.role ?? "direct",
      quote: selection.quote,
      reason: selection.reason,
    };
  });
}
