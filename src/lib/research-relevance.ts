/**
 * Relevance of `legal_research` results to the user's question, decided by
 * WorkLens rather than the upstream order. Rule-based and explainable: every
 * judgement names the question terms (or cited article) it matched.
 *
 * The MCP falls back to full-text search when a title search misses, so a
 * precedent can be listed only because a question word appears somewhere in a
 * long judgment. Case titles are therefore never enough on their own; the
 * 판시사항/판결요지 decide, and a precedent whose summary could not be read is
 * kept as "unknown" instead of being guessed either way.
 */

/** How a precedent relates to the question; `low` ones are folded, never deleted. */
export type PrecedentRank = "direct" | "related" | "unknown" | "low";

export interface PrecedentRelevance {
  rank: PrecedentRank;
  /** Question terms or articles found in the title/summary, for the reader and for tests. */
  matched: string[];
}

/** An article WorkLens looked up because a question term is in its title. */
export interface SupplementArticle {
  law: string;
  jo: string;
  title: string;
  excerpt: string;
  effectiveDate?: string;
  /** Question terms found in the article title. */
  matched: string[];
}

export interface ResearchEnrichment {
  /** Keyed by precedent id as printed by the MCP (`[619479]`). */
  precedents?: Record<string, PrecedentRelevance>;
  /** `none`: looked up and nothing matched; `failed`: lookups failed; `not_searched`: no usable term. */
  supplement?: { status: "found" | "none" | "failed" | "not_searched"; articles: SupplementArticle[] };
}

/** Words that frame a question rather than name its subject. */
const FRAME_WORDS = new Set([
  "판단", "기준", "방법", "절차", "관련", "요건", "근거", "여부", "효력", "내용", "사례", "판례", "처분", "문제", "경우",
  "및", "등", "내", "의", "에서", "대한", "관한", "위한", "대해", "알려줘", "무엇", "어떻게", "가능", "해석", "적용", "범위",
]);
const PARTICLE = /(?:의|을|를|이|가|은|는|에|에서|으로|로|과|와|도)$/u;
const LAW_NAME = /(?:법|법률|령|규칙|조례)$/u;

const compact = (text: string) => text.replace(/\s+/gu, "");

/** Subject terms of a question, in order; law names are kept (they are subjects too). */
export function questionTerms(query: string): string[] {
  const terms: string[] = [];
  for (const raw of query.split(/[\s,.;:·!?()「」『』"'“”‘’/]+/u)) {
    let word = raw.trim();
    if (word.length > 2 && !LAW_NAME.test(word)) word = word.replace(PARTICLE, "");
    if (word.length < 2 || FRAME_WORDS.has(word) || /^\d+$/u.test(word)) continue;
    if (!terms.includes(word)) terms.push(word);
  }
  return terms;
}

export const isLawName = (term: string) => LAW_NAME.test(term) && term.length >= 3;

/**
 * `direct`: every subject term (or a cited article from the statute hits)
 * appears in the title or summary. `related`: at least half the terms,
 * including one of the most specific (longest) ones. Otherwise `low`.
 * An `excerpt` (judgment opening, no 판시사항) can at most make a case
 * `related`; without any text the title alone cannot place it above `unknown`.
 */
export function rankPrecedent(
  terms: readonly string[],
  entry: { title?: string; summary?: string; excerpt?: boolean },
  citedArticles: readonly string[] = [],
): PrecedentRelevance {
  if (!terms.length) return { rank: "unknown", matched: [] };
  const haystack = compact(`${entry.title ?? ""}\n${entry.summary ?? ""}`);
  const matched = terms.filter((term) => haystack.includes(compact(term)));
  const articles = citedArticles.filter((article) => haystack.includes(compact(article)));
  if (entry.summary === undefined) return { rank: "unknown", matched: [...matched, ...articles] };
  const longest = Math.max(...terms.map((term) => term.length));
  const specific = matched.some((term) => term.length === longest);
  if (!entry.excerpt && (matched.length === terms.length || articles.length)) return { rank: "direct", matched: [...matched, ...articles] };
  if ((specific && matched.length >= Math.ceil(terms.length / 2)) || (entry.excerpt && articles.length)) {
    return { rank: "related", matched: [...matched, ...articles] };
  }
  return { rank: "low", matched };
}
const ORDER: Record<PrecedentRank, number> = { direct: 0, related: 1, unknown: 2, low: 3 };

/** Stable: within a rank the MCP's own order is the tie-breaker. */
export function orderByRelevance<T extends { id: string }>(entries: readonly T[], relevance: Record<string, PrecedentRelevance> | undefined): T[] {
  if (!relevance) return [...entries];
  return entries
    .map((entry, index) => ({ entry, index, rank: ORDER[relevance[entry.id]?.rank ?? "unknown"] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ entry }) => entry);
}

/**
 * Article titles that contain a question term. Terms that are part of the law's
 * own name say nothing about which article is meant, so they never count.
 */
export function titleMatches(terms: readonly string[], law: string, title: string): string[] {
  const name = compact(law);
  const heading = compact(title);
  return terms.filter((term) => !isLawName(term) && !name.includes(compact(term)) && heading.includes(compact(term)));
}
