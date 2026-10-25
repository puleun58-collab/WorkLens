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

/**
 * Grammar that may close a written token after a word: particles, the copula,
 * and the endings of the verbs a noun stem forms (하다·되다·당하다·받다 등).
 * Anything else after a term inside its token is another noun, and then the
 * term only modifies a different concept: 사용자등록 is a kind of 등록, not of
 * 사용자, and 금융지주회사 continues past 회사 into a specific institution.
 */
const GRAMMATICAL_TAIL = /^(?:[은는이가을를에의와과도만씩뿐로]|에서|에게|한테|으로|으로서|으로써|로써|으로부터|까지|부터|처럼|보다|께|조차|마저|이나|든지|등|등의|적인|적으로|상|중|내|간|별|들|이며|이고|이다|입니다|인|일|이|이란|이라는|이라고|이라|란|라는|라고|한|하는|하여|하면|하고|하며|할|해|했|한다|함|하지|하지는|하지도|하니|하므로|하기|하기로|하도록|하게|하자|합니다|하십시오|하여야|해야|아니|아니한|당한|당하는|당하여|당하면|당하고|당했|당했다|당함|받은|받는|받아|받았|받음|되|된|되는|되어|되면|되고|될|된다|됨|되지|되어야|시킨|시키는|시켜|어야|여야|아서|여서|으면|면|고|며|지|게|기|다|요|니)*$/u;
const TOKEN_SPLIT = /[\s,.;:·!?()「」『』"'“”‘’/[\]{}<>※—-]+/u;

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

/** Any occurrence at all, including inside a longer compound (사용자등록 for 사용자). */
function termOccurs(term: string, compactedText: string): boolean {
  const needle = compact(term);
  if (!needle) return false;
  if (compactedText.includes(needle)) return true;
  return needle.length >= 3 && needle.endsWith("죄") && compactedText.includes(needle.slice(0, -1));
}

/**
 * Whether verified source text uses a question term as a word of its own: the
 * term completes a written token — itself with its grammar (모욕한, 보증금의),
 * or the head of a compound (부당해고 for 해고, 제출의무 for 의무). Where a
 * longer compound merely continues past it, the occurrence belongs to that
 * other concept: a modifier inside 사용자등록 or 금융지주회사 is not the word.
 *
 * Statute titles and bodies name the act (모욕), while questions name the
 * offense (모욕죄), so an offense name also matches through its act noun,
 * under the same completion rule. A morphological rule only: no other form
 * is inferred, and shorter names (범죄) are never cut.
 */
export function termInText(term: string, text: string): boolean {
  const needles = [term];
  if (term.length >= 3 && term.endsWith("죄")) needles.push(term.slice(0, -1));
  for (const token of text.split(TOKEN_SPLIT)) {
    if (!token) continue;
    for (const needle of needles) {
      let at = token.indexOf(needle);
      while (at !== -1) {
        const tail = token.slice(at + needle.length);
        if (!tail || GRAMMATICAL_TAIL.test(tail)) return true;
        at = token.indexOf(needle, at + 1);
      }
    }
  }
  return false;
}

/**
 * A term standing behind a relevance decision: used as a word of its own, or
 * written joined with another of the question's own terms (소유권이전등기 stacks
 * 소유권·이전·등기 — the question's phrase without spaces). A term that only
 * modifies an unrelated compound (사용자 inside 사용자등록) never qualifies, so
 * a compound-internal partial match cannot carry a decision on its own.
 */
function termAnchored(term: string, terms: readonly string[], text: string): boolean {
  if (termInText(term, text)) return true;
  return text.split(TOKEN_SPLIT).some((token) => token.includes(term)
    && terms.some((other) => other !== term && token.includes(other)));
}

export const isLawName = (term: string) => LAW_NAME.test(term) && term.length >= 3;

/**
 * The case title is a candidate signal only; relevance evidence is the
 * 판시사항/판결요지/참조조문 (or, for lower courts without one, the judgment
 * opening with the title lines removed).
 *
 * `direct`: every subject term, or a statute article the answer cites, appears
 * in the summary. `related`: at least half the terms including one of the most
 * specific (longest) — under the same anchored standard as `direct` and as
 * citation, so a term that appears only inside another compound (사용자 inside
 * 사용자등록) carries neither promotion. Otherwise `low`: the summary was read
 * and does not address the question, whatever the title says. An `excerpt` can
 * at most make a case `related`; without any summary the case stays `unknown`.
 * `matched` lists the evidence terms only.
 */
export function rankPrecedent(
  terms: readonly string[],
  entry: { title?: string; summary?: string; excerpt?: boolean },
  citedArticles: readonly string[] = [],
): PrecedentRelevance {
  if (!terms.length || entry.summary === undefined) return { rank: "unknown", matched: [] };
  // A judgment opening repeats the case name (`[id] 사건명`, `=== 사건명 ===`); that is still the title.
  const evidence = entry.excerpt && entry.title ? entry.summary.split(entry.title).join(" ") : entry.summary;
  const matched = terms.filter((term) => termOccurs(term, compact(evidence)));
  const articles = citedArticles.filter((article) => compact(evidence).includes(compact(article)));
  const longest = Math.max(...terms.map((term) => term.length));
  // Promotion is the step a stray partial match must not carry: the most
  // specific term has to be there as a word, not only inside a compound.
  // Ranking and citation judge by this one standard, so a case the citation
  // step would reject on compound-internal evidence alone is not shown as
  // related either; it stays a `low` candidate, never deleted.
  const anchored = matched.some((term) => term.length === longest && termAnchored(term, terms, evidence));
  if (!entry.excerpt && ((matched.length === terms.length && anchored) || articles.length)) return { rank: "direct", matched: [...matched, ...articles] };
  if ((anchored && matched.length >= Math.ceil(terms.length / 2)) || (entry.excerpt && articles.length)) {
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
  return terms.filter((term) => !isLawName(term) && !name.includes(compact(term)) && termInText(term, title));
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
    const matched = terms.filter((term) => termOccurs(term, compact(excerpt)));
    // Coverage alone is not adoption: the most specific term must be present
    // as a word of its own, so a compound-internal partial match (사용자 only
    // inside 사용자등록) cannot adopt a source by itself.
    return matched.length >= Math.ceil(terms.length / 2)
      && matched.some((term) => term.length === longest && termAnchored(term, terms, excerpt));
  };
  const articles = [
    ...researchResult(text).sections.filter((section) => section.status === "available").flatMap((section) => section.articles ?? []),
    ...(enrichment?.supplement?.articles ?? []),
  ].filter((article) => addressesIssue(article.excerpt)).map(({ law, jo }) => ({ law, jo }));
  const precedents = Object.entries(enrichment?.precedents ?? {})
    .filter(([id, { rank }]) => {
      if (rank !== "direct" && rank !== "related") return false;
      // Judged on the holding text itself when it was read. A ranking whose
      // text is unavailable cannot be citation-verified: the matched-term
      // list is the question's own terms, so judging it would only verify
      // the question against itself. Such a precedent stays a candidate.
      const excerpt = enrichment?.precedentExcerpts?.[id];
      return excerpt !== undefined && addressesIssue(excerpt);
    })
    .map(([id]) => id);
  return { articles, precedents };
}

/** Whether verified source content addresses an interpreted issue. */
export function hasRelevantResearchEvidence(text: string, query: string, enrichment?: ResearchEnrichment): boolean {
  const sources = researchEvidenceSources(text, query, enrichment);
  return sources.articles.length > 0 || sources.precedents.length > 0;
}
