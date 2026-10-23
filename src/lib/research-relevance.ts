import { researchResult } from "@/lib/law-research-parse";

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
  /** Bounded official holding/opening text used to verify each precedent's topical match. */
  precedentExcerpts?: Record<string, string>;
  /** `none`: looked up and nothing matched; `failed`: lookups failed; `not_searched`: no usable term. */
  supplement?: { status: "found" | "none" | "failed" | "not_searched"; articles: SupplementArticle[] };
  /**
   * The MCP searches 법령해석례 with the whole question, which AND-matches framing
   * words and often returns nothing. When that section is empty, one retry with
   * only the question's subject terms; `entries` are that search's hits.
   */
  interpretations?: { query: string; entries: Array<{ id: string; title?: string; caseNumber?: string; body?: string; date?: string }> };
}

/** Words that frame a question rather than name its subject: question scaffolding, scene nouns and speech acts. */
const FRAME_WORDS = new Set([
  "판단", "기준", "방법", "절차", "관련", "요건", "근거", "여부", "효력", "내용", "사례", "판례", "처분", "문제", "경우",
  "및", "등", "내", "의", "에서", "대한", "관한", "위한", "대해", "알려줘", "무엇", "어떻게", "가능", "해석", "적용", "범위",
  "회사", "업무", "궁금", "궁금해", "싶어", "알고",
]);
const PARTICLE = /(?:의|을|를|이|가|은|는|에|에서|으로|로|과|와|도)$/u;
/** Endings of a spoken or written question (…당했어, …관련해서, …해고됐는데, …인지): they inflect, they do not name a subject. */
const ENDING = /(?:됐는데|했는데|였는데|인데|해서|하여|했어|됐어|았어|었어|였어|인지|은지|는지|인가|을까|일까)$/u;
const LAW_NAME = /(?:법|법률|령|규칙|조례)$/u;
/** `근로기준법상` names the law under a locative suffix; the law name itself is the subject. */
const LAW_UNDER = /^(.+(?:법|법률|령|규칙|조례))상$/u;

const compact = (text: string) => text.replace(/\s+/gu, "");

/** Subject terms of a question, in order; law names are kept (they are subjects too). */
export function questionTerms(query: string): string[] {
  const terms: string[] = [];
  for (const raw of query.split(/[\s,.;:·!?()「」『』"'“”‘’/]+/u)) {
    let word = raw.trim().replace(LAW_UNDER, "$1");
    // Endings first: a particle strip would break them (무엇인가 → 무엇인).
    if (word.length > 2) word = word.replace(ENDING, "");
    if (word.length > 2 && !LAW_NAME.test(word)) word = word.replace(PARTICLE, "");
    if (word.length < 2 || FRAME_WORDS.has(word) || /^\d+$/u.test(word)) continue;
    if (!terms.includes(word)) terms.push(word);
  }
  return terms;
}

/**
 * Whether verified source text contains a question term. Statute titles and
 * bodies name the act (모욕), while questions name the offense (모욕죄), so an
 * offense name also matches through its act noun. A morphological rule only:
 * no other form is inferred, and shorter names (범죄) are never cut.
 */
export function termInText(term: string, compactedText: string): boolean {
  const needle = compact(term);
  if (!needle) return false;
  if (compactedText.includes(needle)) return true;
  return needle.length >= 3 && needle.endsWith("죄") && compactedText.includes(needle.slice(0, -1));
}

export const isLawName = (term: string) => LAW_NAME.test(term) && term.length >= 3;

/**
 * The case title is a candidate signal only; relevance evidence is the
 * 판시사항/판결요지/참조조문 (or, for lower courts without one, the judgment
 * opening with the title lines removed).
 *
 * `direct`: every subject term, or a statute article the answer cites, appears
 * in the summary. `related`: at least half the terms including one of the most
 * specific (longest). Otherwise `low`: the summary was read and does not
 * address the question, whatever the title says. An `excerpt` can at most
 * make a case `related`; without any summary the case stays `unknown`.
 * `matched` lists the evidence terms only.
 */
export function rankPrecedent(
  terms: readonly string[],
  entry: { title?: string; summary?: string; excerpt?: boolean },
  citedArticles: readonly string[] = [],
): PrecedentRelevance {
  if (!terms.length || entry.summary === undefined) return { rank: "unknown", matched: [] };
  // A judgment opening repeats the case name (`[id] 사건명`, `=== 사건명 ===`); that is still the title.
  const evidence = compact(entry.excerpt && entry.title ? entry.summary.split(entry.title).join(" ") : entry.summary);
  const matched = terms.filter((term) => termInText(term, evidence));
  const articles = citedArticles.filter((article) => evidence.includes(compact(article)));
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
  return terms.filter((term) => !isLawName(term) && !name.includes(compact(term)) && termInText(term, heading));
}

/**
 * A search total or decision title is merely a candidate. Only source text
 * reflecting the issue can be cited as a topical match; applicability still
 * depends on the user's facts and the source's effective date.
 */
export function researchEvidenceSources(text: string, query: string, enrichment?: ResearchEnrichment): {
  articles: Array<{ law: string; jo: string }>; precedents: string[];
} {
  const terms = questionTerms(query).filter((term) => !isLawName(term));
  if (!terms.length) return { articles: [], precedents: [] };
  const longest = Math.max(...terms.map((term) => term.length));
  const addressesIssue = (excerpt: string) => {
    if (!excerpt.trim()) return false;
    const normalized = compact(excerpt);
    const matched = terms.filter((term) => termInText(term, normalized));
    return matched.length >= Math.ceil(terms.length / 2) && matched.some((term) => term.length === longest);
  };
  const articles = [
    ...researchResult(text).sections.filter((section) => section.status === "available").flatMap((section) => section.articles ?? []),
    ...(enrichment?.supplement?.articles ?? []),
  ].filter((article) => addressesIssue(article.excerpt)).map(({ law, jo }) => ({ law, jo }));
  const precedents = Object.entries(enrichment?.precedents ?? {})
    .filter(([, { rank, matched }]) => (rank === "direct" || rank === "related")
      && addressesIssue(matched.filter((term) => terms.includes(term)).join(" ")))
    .map(([id]) => id);
  return { articles, precedents };
}

/** Whether verified source content addresses an interpreted issue. */
export function hasRelevantResearchEvidence(text: string, query: string, enrichment?: ResearchEnrichment): boolean {
  const sources = researchEvidenceSources(text, query, enrichment);
  return sources.articles.length > 0 || sources.precedents.length > 0;
}
