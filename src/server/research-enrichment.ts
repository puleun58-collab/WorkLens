import { lawDisplayText } from "@/lib/law-display";
import { researchResult } from "@/lib/law-research-parse";
import {
  isDefinitionTitle, isLawName, isSubjectTerm, questionTerms, questionTermsRelationLess, questionTermsSubjectLess, rankPrecedent, titleMatches, termInText,
  type PrecedentRelevance, type ResearchEnrichment, type SupplementArticle,
} from "@/lib/research-relevance";
import { parseExplicitIdentities, type ExplicitIdentity } from "@/lib/law-identity";
import type { ResearchDecision } from "@/lib/law-research-parse";
import { getDecisionText, searchDecisions } from "@/server/decision-mcp";
import { getLawText, searchLaw } from "@/server/law-mcp";

type Context = { requestId: string; signal?: AbortSignal };

/** The 법제처 lookups enrichment uses; injectable so the rules are testable offline. */
export interface EnrichmentSources {
  /**
   * 판시사항 + 판결요지 + 참조조문 of a precedent; lower-court rulings often have
   * none, and then the opening of the judgment the MCP returns (`excerpt: true`).
   */
  summary(id: string): Promise<{ text: string; excerpt: boolean } | undefined>;
  /** Laws returned by the official index; explicit non-current statuses are excluded. */
  laws(query: string): Promise<Array<{ name: string; mst: string }>>;
  toc(mst: string): Promise<Array<{ jo: string; title: string }>>;
  article(mst: string, jo: string): Promise<{ text: string; name?: string; effectiveDate?: string } | undefined>;
  /** 법령해석례 search; [] when the MCP reports no result. */
  interpretations(query: string): Promise<Array<{ id: string; title?: string; caseNumber?: string; body?: string; date?: string }>>;
  /** 판례 search for one issue's short phrase; [] when the MCP reports no result. */
  precedents(query: string): Promise<ResearchDecision[]>;
}

const SUMMARY_HEADINGS = new Set(["판시사항", "판결요지", "결정요지", "참조조문"]);
/** `주문` lines some sources file under 판결요지: they decide the case but say nothing about the issue. */
const DISPOSITION_LINE = /(?:각하한다|기각한다|인용한다|취소한다|환송한다|부담한다|지급하라|이행하라)\.?\s*$/u;
const isDisposition = (text: string) => text.split(/\r?\n/u).filter((line) => line.trim()).every((line) => DISPOSITION_LINE.test(line));

/**
 * What a precedent's text offers as relevance evidence: its summary sections,
 * or — when there are none, or only a filed 주문 — the judgment opening.
 */
export function precedentEvidence(result: { text: string; sections?: Array<{ heading: string; text: string }> }): { text: string; excerpt: boolean } | undefined {
  const text = (result.sections ?? [])
    .filter((section) => SUMMARY_HEADINGS.has(section.heading) && !isDisposition(section.text))
    .map((section) => section.text).join("\n");
  if (text.trim()) return { text: lawDisplayText(text), excerpt: false };
  return result.text.trim() ? { text: lawDisplayText(result.text), excerpt: true } : undefined;
}

export function mcpEnrichmentSources(context: Context): EnrichmentSources {
  return {
    async summary(id) {
      const result = await getDecisionText("precedent", id, undefined, context);
      return result.found ? precedentEvidence(result) : undefined;
    },
    async laws(query) {
      const result = await searchLaw(query, context);
      if (!result.found) return [];
      return result.laws.filter((law) => law.mst && (!law.status || law.status === "현행")).map((law) => ({ name: law.name, mst: law.mst! }));
    },
    async toc(mst) {
      const result = await getLawText({ mst }, undefined, context);
      if (!result.found) return [];
      if (result.mode === "toc") return result.articles ?? [];
      // Small laws return full text instead of a TOC. Read real heading lines.
      return [...result.text.matchAll(/^(제[1-9]\d{0,3}조(?:의[1-9]\d*)?) ([^\n]+)$/gmu)]
        .map((match) => ({ jo: match[1], title: match[2].trim() }));
    },
    async article(mst, jo) {
      const result = await getLawText({ mst }, jo, context);
      return result.found ? { text: result.text, ...(result.name ? { name: result.name } : {}),
        ...(result.effectiveDate ? { effectiveDate: result.effectiveDate } : {}) } : undefined;
    },
    async interpretations(query) {
      const result = await searchDecisions("interpretation", query, 1, context);
      return result.found ? result.entries.map((entry) => ({ id: entry.id, ...(entry.title ? { title: entry.title } : {}),
        ...(entry.caseNumber ? { caseNumber: entry.caseNumber } : {}), ...(entry.date ? { date: entry.date } : {}) })) : [];
    },
    async precedents(query) {
      const result = await searchDecisions("precedent", query, 1, context);
      return result.found ? result.entries.map((entry) => ({ id: entry.id, ...(entry.title ? { title: entry.title } : {}),
        ...(entry.caseNumber ? { caseNumber: entry.caseNumber } : {}), ...(entry.court ? { body: entry.court } : {}),
        ...(entry.date ? { date: entry.date } : {}) })) : [];
    },
  };
}

/**
 * One cache and one concurrency limit for every lookup a request makes: issues that
 * reach the same law, table of contents, article or case never repeat the call.
 */
export function sharedSources(sources: EnrichmentSources, limit = CONCURRENCY): EnrichmentSources {
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = () => active < limit
    ? (active++, Promise.resolve())
    : new Promise<void>((resolve) => waiting.push(() => { active++; resolve(); }));
  const release = () => { active--; waiting.shift()?.(); };
  const cache = new Map<string, Promise<unknown>>();
  const call = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    let pending = cache.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = acquire().then(run).finally(release);
      cache.set(key, pending);
    }
    return pending;
  };
  return {
    summary: (id) => call(`summary\0${id}`, () => sources.summary(id)),
    laws: (query) => call(`laws\0${query}`, () => sources.laws(query)),
    toc: (mst) => call(`toc\0${mst}`, () => sources.toc(mst)),
    article: (mst, jo) => call(`article\0${mst}\0${jo}`, () => sources.article(mst, jo)),
    interpretations: (query) => call(`interpretations\0${query}`, () => sources.interpretations(query)),
    precedents: (query) => call(`precedents\0${query}`, () => sources.precedents(query)),
  };
}

/** Follow-up lookups stay inside a fixed share of the request and never outrun it. */
const CONCURRENCY = 4;
const BUDGET_MS = 15_000;
const MAX_PRECEDENTS = 10;
const MAX_LAWS = 3;
const MAX_LAWS_PER_TERM = 2;
const MAX_ARTICLES = 3;
const EXCERPT_CHARS = 600;

async function pool<T>(items: readonly T[], worker: (item: T) => Promise<void>, expired: () => boolean): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length && !expired()) {
      const item = items[next++];
      await worker(item);
    }
  }));
}

export function articleExcerpt(text: string, jo: string): string {
  const lines = text.split(/\r?\n/u).map((line) => line.trim());
  const heading = new RegExp(`^${jo}(?:\\s|\\(|$)`, "u");
  // Upstream prints a `제80조 이행강제금` label, then `제80조(이행강제금) ① …`; the body starts after the last heading line.
  let head = lines.findIndex((line) => heading.test(line));
  while (head >= 0 && heading.test(lines[head + 1] ?? "")) head++;
  // No requested header, but a different article's header is present:
  // the fetched text belongs to another article, so attributing the
  // whole text to the requested number would misconnect it. Only an
  // unformatted body (no article header at all) keeps the fallback.
  if (head < 0 && lines.some((line) => /^제[1-9]\d{0,3}조(?:의[1-9]\d?)?(?:\s|\(|$)/u.test(line))) return "";
  const first = head < 0 ? [] : [lines[head].slice(jo.length).replace(/^\s*\([^)]*\)\s*/u, "")];
  const body = [...first, ...(head < 0 ? lines : lines.slice(head + 1))].filter(Boolean).join("\n");
  const shown = lawDisplayText(body);
  return shown.length > EXCERPT_CHARS ? `${shown.slice(0, EXCERPT_CHARS).trimEnd()} …` : shown;
}

/**
 * Re-ranks the precedents a research answer listed and looks up articles whose
 * titles carry the question's terms. Nothing here invents a citation: every
 * article comes from a 법제처 lookup, and a precedent that could not be read
 * stays `unknown` in its original place.
 */
export async function enrichResearch(
  task: "full_research" | "action_basis",
  query: string,
  text: string,
  sources: EnrichmentSources,
  now: () => number = Date.now,
  // A per-issue retry chain's precedents and interpretations are discarded by
  // its caller, so skipping their lookups changes nothing it returns except
  // time. The main chain and action-basis paths never pass these.
  options: {
    skipPrecedentSummaries?: boolean; skipInterpretationRetry?: boolean;
    // Law names the user's own question named but an interpreted issue phrase dropped
    // (e.g. "식품위생법 영업정지 조사 의무" → issue "영업정지 조사 의무"):
    // without them the chain supplement's title lookup has no law to search under.
    // Mirrors lookupIssue's extraNamed; adoption rules are untouched — this only
    // names laws whose title-matching articles may be shown as references.
    extraNamed?: readonly string[];
  } = {},
): Promise<ResearchEnrichment> {
  const started = now();
  const expired = () => now() - started > BUDGET_MS;
  const document = researchResult(text);
  const terms = (task === "full_research" ? questionTerms(query).slice(0, 8) : questionTerms(query));
  const enrichment: ResearchEnrichment = {};

  const shownArticles = document.sections.flatMap((section) => section.articles ?? []);
  const cited = shownArticles.filter((article) => task !== "full_research" || terms.some((term) => !isLawName(term)
    && (article.title?.includes(term) || article.excerpt.includes(term)))).map((article) => `${article.law} ${article.jo}`);

  // Precedent lists only (not interpretations or tribunal rulings): the case summary is what the MCP can return.
  const precedentIds = [...new Set(document.sections
    .filter((section) => section.kind === "decision_search" && /판례/u.test(section.heading ?? ""))
    .flatMap((section) => section.decisions?.entries ?? [])
    .map((entry) => entry.id))].slice(0, MAX_PRECEDENTS);
  if (task === "full_research" && precedentIds.length && !options.skipPrecedentSummaries) {
    const titles = new Map(document.sections.flatMap((section) => section.decisions?.entries ?? []).map((entry) => [entry.id, entry.title]));
    const excerpts: Record<string, string> = {};
    const relevance: Record<string, PrecedentRelevance> = {};
    await pool(precedentIds, async (id) => {
      const summary = await sources.summary(id).catch(() => undefined);
      relevance[id] = rankPrecedent(terms, { title: titles.get(id), ...(summary ? { summary: summary.text, excerpt: summary.excerpt } : {}) }, cited);
      if (summary?.text && relevance[id].rank !== "low" && relevance[id].rank !== "unknown") {
        // Signal truncation like articleExcerpt does: a cut excerpt without
        // an ellipsis reads as the whole holding.
        excerpts[id] = summary.text.length > EXCERPT_CHARS ? `${summary.text.slice(0, EXCERPT_CHARS).trimEnd()} …` : summary.text;
      }
    }, expired);
    for (const id of precedentIds) relevance[id] ??= rankPrecedent(terms, { title: titles.get(id) });
    enrichment.precedents = relevance;
    enrichment.precedentExcerpts = excerpts;
  }

  // An empty 법령 해석례 section: retry once with the subject terms only. Titles
  // remain search candidates, never proof of a legal interpretation.
  const interpretation = document.sections.find((section) => section.status === "not_found" && /해석례/u.test(section.heading ?? ""));
  const retryQuery = terms.join(" ");
  if (interpretation && terms.length && retryQuery !== query.trim() && !expired() && !options.skipInterpretationRetry) {
    const entries = await sources.interpretations(retryQuery).catch(() => []);
    const relevant = task === "full_research"
      ? entries.filter((entry) => terms.some((term) => (entry.title ?? "").replace(/\s+/gu, "").includes(term.replace(/\s+/gu, ""))))
      : entries;
    if (relevant.length) enrichment.interpretations = { query: retryQuery, entries: relevant.slice(0, 5) };
  }

  const keywords = terms.filter((term) => !isLawName(term));
  if (!keywords.length) {
    enrichment.supplement = { status: "not_searched", articles: [] };
    return enrichment;
  }
  // Laws named in the question, inherited from the original question when an
  // interpreted issue phrase dropped them, or in the answer's title — then
  // laws whose names contain a question term.
  const named = [...terms.filter(isLawName), ...(options.extraNamed ?? []), ...(document.title?.split(":").slice(1).map((part) => part.trim()).filter(isLawName) ?? [])];
  enrichment.supplement = await titleArticles(keywords, named, shownArticles, sources, expired, task === "full_research", true);
  // Body cross-references the title lookup cannot see: an article's own
  // text cites the provision it implements or replaces (제82조's "제75조"
  // for an 영업정지 question). Follow at most two citations per
  // supplement article and three new articles in total, all inside the
  // same law, through the official lookup — never a guessed number, and
  // never a different law's article. Adoption is still judged by the
  // caller from the fetched excerpt, so a cited article that does not
  // address the issue stays a displayed candidate only.
  if (enrichment.supplement.articles.length && !expired()) {
    const followed = await followArticleCitations(enrichment.supplement.articles, keywords, sources, expired);
    if (followed.articles.length || followed.partialFailure) {
      enrichment.supplement = { ...enrichment.supplement,
        articles: [...enrichment.supplement.articles, ...followed.articles],
        ...(enrichment.supplement.partialFailure || followed.partialFailure ? { partialFailure: true as const } : {}) };
    }
  }
  return enrichment;
}

/**
 * Articles a supplement article's own body cites ("제N조"), fetched from
 * the same law through the official lookup. Bounded (see caller) and
 * budget-checked; a failed fetch simply yields no candidate.
 */
export async function followArticleCitations(
  articles: ReadonlyArray<SupplementArticle>,
  keywords: readonly string[],
  sources: EnrichmentSources,
  expired: () => boolean,
): Promise<{ articles: SupplementArticle[]; partialFailure: boolean }> {
  const compactName = (value: string) => value.replace(/\s+/gu, "");
  const seen = new Set(articles.map((article) => `${article.law}\0${article.jo}`));
  const followed: SupplementArticle[] = [];
  let partialFailure = false;
  for (const article of articles) {
    if (expired() || followed.length >= 3) break;
    const cited: string[] = [];
    for (const match of article.excerpt.matchAll(/제([1-9]\d{0,3})조(?:의([1-9]\d?))?/gu)) {
      const clause = article.excerpt.slice(0, match.index).split(/[.\n①②③④⑤⑥⑦⑧⑨⑩]/u).at(-1) ?? "";
      if (/「|」|법\s*$|영\s*$|시행령|시행규칙|같은\s*법/u.test(clause)) continue;
      const jo = `제${match[1]}조${match[2] ? `의${match[2]}` : ""}`;
      if (jo !== article.jo && !seen.has(`${article.law}\0${jo}`) && !cited.includes(jo)) cited.push(jo);
    }
    if (!cited.length) continue;
    const found = await sources.laws(article.law).catch(() => { partialFailure = true; return []; });
    const exact = found.find((law) => compactName(law.name) === compactName(article.law));
    if (!exact) continue;
    for (const jo of cited.slice(0, 2)) {
      if (expired() || followed.length >= 3) break;
      const fetched = await sources.article(exact.mst, jo).catch(() => { partialFailure = true; return undefined; });
      if (!fetched) continue;
      if (fetched.name && fetched.name !== exact.name) continue; // Stale/misdirected MST.
      const excerpt = articleExcerpt(fetched.text, jo);
      if (!excerpt) continue;
      const title = /제[1-9]\d{0,3}조(?:의[1-9]\d?)?\(([^)]+)\)/u.exec(fetched.text)?.[1]?.trim() ?? "";
      const key = `${article.law}\0${jo}`;
      seen.add(key);
      followed.push({ law: article.law, jo, title, excerpt,
        matched: keywords.filter((term) => termInText(term, excerpt)),
        role: isDefinitionTitle(title) ? "definition" : "other", stage: "supplement",
        ...(fetched.effectiveDate ? { effectiveDate: fetched.effectiveDate } : {}) });
    }
  }
  return { articles: followed, partialFailure };
}

/**
 * Articles whose titles carry a subject term, from laws the terms name exactly or whose
 * names contain a term. `strictName` drops an article whose text names a different law.
 * `strictCandidates` is only for the displayed supplement (the main chain's
 * related-articles list): there a single generic title word is pollution, so
 * law discovery and candidates need a subject term. An issue's own lookup
 * keeps the looser rule — its candidates are never displayed, only judged
 * for adoption by the caller, and the looser rule is what lets a title like
 * "직장 내 괴롭힘 발생 시 조치" be found for "사용자 조치 의무" (V4).
 */
async function titleArticles(
  keywords: readonly string[],
  named: readonly string[],
  shownArticles: ReadonlyArray<{ law: string; jo: string }>,
  sources: EnrichmentSources,
  expired: () => boolean,
  strictName: boolean,
  strictCandidates = false,
): Promise<NonNullable<ResearchEnrichment["supplement"]>> {
  const compactName = (value: string) => value.replace(/\s+/gu, "");
  const laws = new Map<string, string>();
  let failures = 0;
  let lookups = 0;
  for (const name of new Set(named)) {
    if (laws.size >= MAX_LAWS || expired()) break;
    lookups++;
    const found = await sources.laws(name).catch(() => { failures++; return []; });
    // The official name may space a compound the question wrote joined
    // (개인정보보호법 → 개인정보 보호법): compare compacted, never guess a
    // different law — a spaced name that only differs by spaces is the same law.
    const exact = found.find((law) => compactName(law.name) === compactName(name));
    if (exact) laws.set(exact.name, exact.mst);
  }
  for (const term of keywords) {
    // In the displayed supplement, a generic word must not discover laws by
    // itself: searching "조사" or "의무" returned whole unrelated regimes
    // (대일항쟁기 특별법, 이태원 특별법…) whose titles merely share that
    // word, and those filled the related-articles list. Law discovery uses
    // subject terms only there; named laws above are unaffected.
    if (strictCandidates && !isSubjectTerm(term)) continue;
    if (laws.size >= MAX_LAWS || expired()) break;
    lookups++;
    const found = await sources.laws(term).catch(() => { failures++; return []; });
    for (const law of found.filter((entry) => entry.name.includes(term) && entry.name.endsWith("법")).slice(0, MAX_LAWS_PER_TERM)) {
      if (laws.size < MAX_LAWS) laws.set(law.name, law.mst);
    }
  }

  const candidates: Array<{ law: string; mst: string; jo: string; title: string; matched: string[] }> = [];
  const subjectMatched = (matched: readonly string[]) => matched.filter(isSubjectTerm).length;
  // Laws the caller named (the question's own laws, inherited laws, answer
  // title laws): inside a named law, a generic title word is not
  // cross-regime pollution — the regime is already fixed by the user. So
  // when the keywords contain no subject term at all (e.g. a named-law
  // "정지 요건" question, whose only keyword is the generic 정지), the
  // subject-term requirement for displayed candidates does not apply to
  // that law's own articles — otherwise a named law's supplement could
  // never contain anything. When a subject term exists, the strict rule
  // stays: a title matching only generic words (조사 의무 for an
  // 영업정지 issue) is still dropped. Laws discovered by keyword search
  // keep the strict rule in both cases: a generic word must not discover
  // a regime by itself.
  const namedCompacts = new Set(named.map(compactName));
  const namedRelaxation = !keywords.some(isSubjectTerm);
  await pool([...laws], async ([law, mst]) => {
    lookups++;
    const toc = await sources.toc(mst).catch(() => { failures++; return []; });
    for (const article of toc) {
      const matched = titleMatches(keywords, law, article.title);
      // In the displayed supplement, generic words alone are not
      // relatedness, however many match: "조사 의무" matched two generic
      // words for a 식품위생법 영업정지 question and still named no
      // subject. A displayed candidate needs a subject term, unless the
      // no-subject-term named-law relaxation above applies; the looser
      // rule stays available to per-issue lookup (strictCandidates off),
      // where the issue's own adoption check still applies.
      if (matched.length && (!strictCandidates || matched.some(isSubjectTerm) || (namedRelaxation && namedCompacts.has(compactName(law))))
        && !shownArticles.some((shown) => shown.law === law && shown.jo === article.jo)) {
        candidates.push({ law, mst, jo: article.jo, title: article.title, matched });
      }
    }
  }, expired);
  // Subject-term coverage first, then a substantive article before a
  // definition article, then matched-term count; laws in lookup order, then
  // article order, as tie-breakers. The 3-article cap is unchanged.
  const order = [...laws.keys()];
  const chosen = candidates
    .sort((a, b) => subjectMatched(b.matched) - subjectMatched(a.matched)
      || Number(isDefinitionTitle(a.title)) - Number(isDefinitionTitle(b.title))
      || b.matched.length - a.matched.length || order.indexOf(a.law) - order.indexOf(b.law))
    .slice(0, MAX_ARTICLES);

  const articles: SupplementArticle[] = [];
  await pool(chosen, async (candidate) => {
    const found = await sources.article(candidate.mst, candidate.jo).catch(() => { failures++; return undefined; });
    if (strictName && found?.name && found.name !== candidate.law) return; // Stale/misdirected MST.
    const excerpt = found ? articleExcerpt(found.text, candidate.jo) : "";
    if (excerpt) articles.push({ law: candidate.law, jo: candidate.jo, title: candidate.title, excerpt, matched: candidate.matched,
      role: isDefinitionTitle(candidate.title) ? "definition" : "other", stage: "supplement",
      ...(found?.effectiveDate ? { effectiveDate: found.effectiveDate } : {}) });
  }, expired);
  articles.sort((a, b) => chosen.findIndex((c) => c.law === a.law && c.jo === a.jo) - chosen.findIndex((c) => c.law === b.law && c.jo === b.jo));
  return { status: articles.length ? "found" : failures && failures === lookups ? "failed" : "none", articles,
    // A landed article does not erase a failed sibling lookup: the supplement
    // is partial, and a per-issue caller surfaces that instead of reporting a
    // complete confirmation. Timeouts that merely stop the search are not
    // counted here — only lookups that actually threw.
    ...(failures > 0 && articles.length > 0 ? { partialFailure: true as const } : {}) };
}

/** Cases read per issue search: the first hits, in the MCP's own order. */
const ISSUE_PRECEDENTS = 4;

export interface IssueLookup {
  /** `failed`: every lookup failed; `timeout`: the shared budget ran out before any lookup finished. */
  status: "found" | "none" | "failed" | "timeout";
  articles: SupplementArticle[];
  /** Cases this issue's own search returned, each with the summary text its relevance was judged on. */
  precedents: Array<ResearchDecision & { summary: string; excerpt: boolean }>;
  /**
   * One branch failed while the other covered the issue, so `found` alone would hide the
   * failure: the uncovered branch was never confirmed. This now also covers
   * failures inside a branch: a title lookup that landed one article while
   * another law's lookup threw, and a precedent summary that could not be
   * read while another branch covered the issue. A summary that simply does
   * not exist (no text returned) is not a failure — only a thrown lookup is.
   */
  partialFailure?: boolean;
}

const JO_TERM = /^제[1-9]\d{0,3}조(?:의[1-9]\d?)?$/u;
/** A bare subordinate-law noun ("그 시행령") names no law of its own: it refers to the preceding law, so it must not replace it as the law a following 조 belongs to, and it must not block a unique parent pair from qualifying (see lookupIssue). */
const BARE_SUBORDINATE = new Set(["시행령", "시행규칙", "법령", "대통령령", "총리령", "부령"]);

/**
 * (law, article) pairs a term list names, in order: each 조 belongs to the
 * most recent law name before it ("개인정보보호법 제38조 … 제39조" pairs
 * both 조 with 개인정보보호법; "근로기준법 제76조의3과 개인정보보호법
 * 제38조" pairs each with its own law). No number is invented and no pair
 * is guessed: a 조 with no preceding law name yields no pair here, and
 * two-character law names are not law names under the shared isLawName
 * rule (which keeps 방법 from becoming a law), so they pair nothing.
 */
export function explicitArticlePairs(terms: readonly string[]): Array<{ law: string; jo: string }> {
  const pairs: Array<{ law: string; jo: string }> = [];
  let lastLaw: string | undefined;
  for (const term of terms) {
    if (isLawName(term) && !BARE_SUBORDINATE.has(term)) lastLaw = term;
    else if (JO_TERM.test(term) && lastLaw && !pairs.some((pair) => pair.law === lastLaw && pair.jo === term)) {
      pairs.push({ law: lastLaw, jo: term });
    }
  }
  return pairs;
}

/** A law article delegating its detail to a subordinate law ("대통령령으로 정하는 …"): the text itself states the law↔시행령 link. */
const DELEGATION = /(?:대통령령|총리령|부령|시행령)으로 정/u;

/**
 * Fetch exactly the articles a pair names, through the official lookup, and
 * mark them explicit so the caller adopts them by identity for a qualifying
 * issue. A pair that resolves to no current law, to more than one law by
 * suffix, or to no article text is skipped, never guessed. A joined spaced
 * law name falls back to its fragment key when the joined key resolves to
 * nothing, so a wrong join cannot lose a real law either. An empty or
 * deleted body is not an article: it is skipped, never adopted.
 * Failures degrade to "no explicit article", never to a failed lookup.
 */
async function fetchExplicitArticles(
  pairs: ReadonlyArray<{ law: string; jo: string; lawAlt?: string }>,
  sources: EnrichmentSources,
  expired: () => boolean,
): Promise<SupplementArticle[]> {
  const compactName = (value: string) => value.replace(/\s+/gu, "");
  const resolve = (found: Array<{ name: string; mst: string }>, name: string) => {
    const exact = found.find((law) => compactName(law.name) === compactName(name));
    if (exact) return exact;
    const suffix = found.filter((law) => compactName(law.name).endsWith(compactName(name)));
    return suffix.length === 1 ? suffix[0] : undefined;
  };
  const articles: SupplementArticle[] = [];
  for (const pair of pairs.slice(0, 6)) {
    if (expired()) break;
    const found = await sources.laws(pair.law).catch(() => []);
    let law = resolve(found, pair.law);
    if (!law && pair.lawAlt) {
      const altFound = await sources.laws(pair.lawAlt).catch(() => []);
      law = resolve(altFound, pair.lawAlt);
    }
    if (!law) continue;
    const fetched = await sources.article(law.mst, pair.jo).catch(() => undefined);
    if (!fetched) continue;
    if (fetched.name && fetched.name !== law.name) continue; // Stale/misdirected MST.
    const excerpt = articleExcerpt(fetched.text, pair.jo);
    // \b is an ASCII word boundary and never fires after a Hangul
    // syllable, so a deleted body ("삭제…") must be caught by prefix.
    if (!excerpt || /^삭제/u.test(excerpt)) continue;
    const title = /제[1-9]\d{0,3}조(?:의[1-9]\d?)?\(([^)]+)\)/u.exec(fetched.text)?.[1]?.trim() ?? "";
    articles.push({ law: law.name, jo: pair.jo, title, excerpt, matched: [], explicit: true, stage: "issue",
      role: isDefinitionTitle(title) ? "definition" : "other",
      ...(fetched.effectiveDate ? { effectiveDate: fetched.effectiveDate } : {}) });
  }
  return articles;
}

/**
 * A search for one issue that the combined research answer did not cover: its short
 * phrase goes to 판례 search and to the statute-title lookup, never the user's sentence.
 * Relevance is still judged by the caller from the source text returned here.
 * Additionally, articles the question or the issue itself named by law + number
 * are fetched directly (see fetchExplicitArticles): a title lookup can never
 * find 제38조, because no table-of-contents title contains its own number.
 */
export async function lookupIssue(
  query: string,
  shownArticles: ReadonlyArray<{ law: string; jo: string }>,
  sources: EnrichmentSources,
  expired: () => boolean,
  // Law names the user's own question named but the issue phrase dropped
  // (e.g. "근로기준법상 … 사용자의 조치 의무" → issue "사용자 조치 의무"):
  // without them the title lookup has no law to search under.
  extraNamed: ReadonlyArray<string> = [],
  // Subject terms the user's own question carried but the issue phrase dropped
  // (e.g. "… 사용자의 조치 의무" → issue "사용자 의무" loses 조치·괴롭힘):
  // the official TOC title of the core article ("직장 내 괴롭힘 발생 시 조치")
  // contains neither surviving issue term, so title candidates are generated
  // from the union while adoption itself is still judged by the issue's own
  // terms in the caller. Only the user's own words are inherited — nothing
  // is invented — and law names stay in extraNamed, not here.
  extraTerms: ReadonlyArray<string> = [],
  // Structured identities parsed once from the user's own question
  // (see law-identity): when supplied, they replace the token-derived
  // question pairs below, so a spaced official name keeps one identity
  // across the chain search, this lookup, the followup and the law-system
  // assessment instead of fragmenting into "보호법" in each of them.
  questionIdentities: ReadonlyArray<ExplicitIdentity> = [],
): Promise<IssueLookup> {
  const terms = questionTerms(query);
  const keywords = terms.filter((term) => !isLawName(term));
  if (!keywords.length) return { status: "none", articles: [], precedents: [] };
  if (expired()) return { status: "timeout", articles: [], precedents: [] };
  const titleKeywords = [...new Set([...keywords, ...extraTerms.filter((term) => !isLawName(term))])];
  let failed = false;
  const [hits, statutes, explicit] = await Promise.all([
    sources.precedents(query).catch(() => { failed = true; return []; }),
    titleArticles(titleKeywords, [...new Set([...terms.filter(isLawName), ...extraNamed])], shownArticles, sources, expired, true),
    (async () => {
      // Articles the issue itself named are fetched for this issue. The
      // issue phrase is parsed from its raw text, not from its tokens,
      // so a spaced law name in the issue itself keeps one identity too.
      const ownIdentities = parseExplicitIdentities(query);
      const own = await fetchExplicitArticles(ownIdentities.length ? ownIdentities : explicitArticlePairs(terms), sources, expired);
      // Articles the question named qualify for this issue only when the
      // issue itself names their number (with no law of its own — the law
      // then comes from the question, and only when the number belongs to
      // exactly one question law), or when the issue names no subject at
      // all and the article's own text states the delegation the issue
      // asks about (a "법령·시행령 관계" issue and 제38조's 대통령령 위임).
      // A relation-phrased issue ("법령 위계") names no subject either —
      // 위계/체계/구조 are link words, not topics — so it qualifies under
      // the same delegation condition; without the delegation wording in
      // the article's own text it still does not qualify. Anything else
      // would let one issue confirm another's article.
      const questionPairs = questionIdentities.length ? [...questionIdentities] : explicitArticlePairs(extraTerms);
      if (!questionPairs.length) return own;
      const subjectLess = questionTermsSubjectLess(query) || questionTermsRelationLess(query);
      const issueJoTerms = terms.filter((term) => JO_TERM.test(term));
      // A bare subordinate noun ("제38조 시행령") is not a law of the
      // issue's own: it must not block the question's unique parent pair
      // from qualifying, the way a real named law would.
      const issueHasLaw = terms.some((term) => isLawName(term) && !BARE_SUBORDINATE.has(term));
      const fetched = await fetchExplicitArticles(questionPairs, sources, expired);
      const qualified = fetched.filter((article) => {
        if (subjectLess && DELEGATION.test(article.excerpt)) return true;
        if (!issueHasLaw && issueJoTerms.includes(article.jo)
          && questionPairs.filter((pair) => pair.jo === article.jo).length === 1) return true;
        return false;
      });
      const seen = new Set(own.map((article) => `${article.law}\0${article.jo}`));
      return [...own, ...qualified.filter((article) => !seen.has(`${article.law}\0${article.jo}`))];
    })(),
  ]);
  const mergedArticles = [...explicit,
    ...statutes.articles.filter((article) => !explicit.some((item) => item.law === article.law && item.jo === article.jo))];
  const precedents: IssueLookup["precedents"] = [];
  let summaryFailed = false;
  const read = hits.slice(0, ISSUE_PRECEDENTS);
  await pool(read, async (hit) => {
    const summary = await sources.summary(hit.id).catch(() => { summaryFailed = true; return undefined; });
    if (summary?.text) precedents.push({ ...hit, summary: summary.text, excerpt: summary.excerpt });
  }, expired);
  precedents.sort((a, b) => read.findIndex((hit) => hit.id === a.id) - read.findIndex((hit) => hit.id === b.id));
  // Absence is only reported when both searches actually answered; otherwise it is unknown.
  const status = mergedArticles.length || precedents.length ? "found"
    : failed || statutes.status === "failed" ? "failed"
    : expired() ? "timeout" : "none";
  // A covering branch must not swallow the other branch's failure: when the lookup
  // still reports `found`, the failure is carried separately for the caller to surface.
  // That now includes failures inside a branch (a title lookup that landed one
  // article while another law threw, or a precedent summary that threw while
  // articles or other precedents covered the issue).
  const partialFailure = status === "found"
    && ((failed && mergedArticles.length > 0) || (statutes.status === "failed" && precedents.length > 0)
      || statutes.partialFailure === true
      || (summaryFailed && (mergedArticles.length > 0 || precedents.length > 0)));
  return { status, articles: mergedArticles, precedents, ...(partialFailure ? { partialFailure: true as const } : {}) };
}

/**
 * A chain article an issue could not adopt from its preview: the MCP preview
 * can stop mid-article (a `③...` cut), hiding the clause the issue asks
 * about. Re-read the full text of the few chain articles whose titles match
 * the issue's or the request's terms, and return them as supplement
 * candidates — adoption itself still judges the excerpt by the issue's own
 * terms in the caller, so a title match alone never confirms anything.
 * Bounded (at most two articles) and budget-checked; a fetch that fails or
 * times out simply yields no candidate, never a guessed one.
 */
export async function rereadShownArticles(
  shown: ReadonlyArray<{ law: string; jo: string; title?: string }>,
  candidateTerms: readonly string[],
  sources: EnrichmentSources,
  expired: () => boolean,
  limit = 2,
): Promise<SupplementArticle[]> {
  const candidates = shown
    .map((article) => ({ article, matched: article.title ? titleMatches(candidateTerms, article.law, article.title) : [] }))
    .filter((entry) => entry.matched.length > 0)
    .sort((a, b) => b.matched.length - a.matched.length)
    .slice(0, limit);
  const articles: SupplementArticle[] = [];
  for (const { article, matched } of candidates) {
    if (expired()) break;
    const found = await sources.laws(article.law).catch(() => []);
    const exact = found.find((law) => law.name === article.law);
    if (!exact) continue;
    if (expired()) break;
    const fetched = await sources.article(exact.mst, article.jo).catch(() => undefined);
    if (!fetched) continue;
    const excerpt = articleExcerpt(fetched.text, article.jo);
    if (excerpt) articles.push({ law: article.law, jo: article.jo, title: article.title ?? "", excerpt, matched,
      role: isDefinitionTitle(article.title) ? "definition" : "other", stage: "reread",
      ...(fetched.effectiveDate ? { effectiveDate: fetched.effectiveDate } : {}) });
  }
  return articles;
}
