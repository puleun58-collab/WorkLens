import { lawDisplayText } from "@/lib/law-display";
import { researchResult } from "@/lib/law-research-parse";
import {
  isLawName, questionTerms, rankPrecedent, titleMatches,
  type PrecedentRelevance, type ResearchEnrichment, type SupplementArticle,
} from "@/lib/research-relevance";
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
      return result.found && result.mode === "toc" ? result.articles ?? [] : [];
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

function articleExcerpt(text: string, jo: string): string {
  const lines = text.split(/\r?\n/u).map((line) => line.trim());
  const heading = new RegExp(`^${jo}(?:\\s|\\(|$)`, "u");
  // Upstream prints a `제80조 이행강제금` label, then `제80조(이행강제금) ① …`; the body starts after the last heading line.
  let head = lines.findIndex((line) => heading.test(line));
  while (head >= 0 && heading.test(lines[head + 1] ?? "")) head++;
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
  if (task === "full_research" && precedentIds.length) {
    const titles = new Map(document.sections.flatMap((section) => section.decisions?.entries ?? []).map((entry) => [entry.id, entry.title]));
    const excerpts: Record<string, string> = {};
    const relevance: Record<string, PrecedentRelevance> = {};
    await pool(precedentIds, async (id) => {
      const summary = await sources.summary(id).catch(() => undefined);
      relevance[id] = rankPrecedent(terms, { title: titles.get(id), ...(summary ? { summary: summary.text, excerpt: summary.excerpt } : {}) }, cited);
      if (summary?.text && relevance[id].rank !== "low" && relevance[id].rank !== "unknown") {
        excerpts[id] = summary.text.slice(0, EXCERPT_CHARS);
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
  if (interpretation && terms.length && retryQuery !== query.trim() && !expired()) {
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
  // Laws named in the question or the answer's title, then laws whose names contain a question term.
  const named = [...terms.filter(isLawName), ...(document.title?.split(":").slice(1).map((part) => part.trim()).filter(isLawName) ?? [])];
  enrichment.supplement = await titleArticles(keywords, named, shownArticles, sources, expired, task === "full_research");
  return enrichment;
}

/**
 * Articles whose titles carry a subject term, from laws the terms name exactly or whose
 * names contain a term. `strictName` drops an article whose text names a different law.
 */
async function titleArticles(
  keywords: readonly string[],
  named: readonly string[],
  shownArticles: ReadonlyArray<{ law: string; jo: string }>,
  sources: EnrichmentSources,
  expired: () => boolean,
  strictName: boolean,
): Promise<NonNullable<ResearchEnrichment["supplement"]>> {
  const laws = new Map<string, string>();
  let failures = 0;
  let lookups = 0;
  for (const name of new Set(named)) {
    if (laws.size >= MAX_LAWS || expired()) break;
    lookups++;
    const found = await sources.laws(name).catch(() => { failures++; return []; });
    const exact = found.find((law) => law.name === name);
    if (exact) laws.set(exact.name, exact.mst);
  }
  for (const term of keywords) {
    if (laws.size >= MAX_LAWS || expired()) break;
    lookups++;
    const found = await sources.laws(term).catch(() => { failures++; return []; });
    for (const law of found.filter((entry) => entry.name.includes(term) && entry.name.endsWith("법")).slice(0, MAX_LAWS_PER_TERM)) {
      if (laws.size < MAX_LAWS) laws.set(law.name, law.mst);
    }
  }

  const candidates: Array<{ law: string; mst: string; jo: string; title: string; matched: string[] }> = [];
  await pool([...laws], async ([law, mst]) => {
    lookups++;
    const toc = await sources.toc(mst).catch(() => { failures++; return []; });
    for (const article of toc) {
      const matched = titleMatches(keywords, law, article.title);
      if (matched.length && !shownArticles.some((shown) => shown.law === law && shown.jo === article.jo)) {
        candidates.push({ law, mst, jo: article.jo, title: article.title, matched });
      }
    }
  }, expired);
  // More matched terms first; laws in lookup order, then article order, as tie-breakers.
  const order = [...laws.keys()];
  const chosen = candidates
    .sort((a, b) => b.matched.length - a.matched.length || order.indexOf(a.law) - order.indexOf(b.law))
    .slice(0, MAX_ARTICLES);

  const articles: SupplementArticle[] = [];
  await pool(chosen, async (candidate) => {
    const found = await sources.article(candidate.mst, candidate.jo).catch(() => { failures++; return undefined; });
    if (strictName && found?.name && found.name !== candidate.law) return; // Stale/misdirected MST.
    const excerpt = found ? articleExcerpt(found.text, candidate.jo) : "";
    if (excerpt) articles.push({ law: candidate.law, jo: candidate.jo, title: candidate.title, excerpt, matched: candidate.matched,
      ...(found?.effectiveDate ? { effectiveDate: found.effectiveDate } : {}) });
  }, expired);
  articles.sort((a, b) => chosen.findIndex((c) => c.law === a.law && c.jo === a.jo) - chosen.findIndex((c) => c.law === b.law && c.jo === b.jo));
  return { status: articles.length ? "found" : failures && failures === lookups ? "failed" : "none", articles };
}

/** Cases read per issue search: the first hits, in the MCP's own order. */
const ISSUE_PRECEDENTS = 4;

export interface IssueLookup {
  /** `failed`: every lookup failed; `timeout`: the shared budget ran out before any lookup finished. */
  status: "found" | "none" | "failed" | "timeout";
  articles: SupplementArticle[];
  /** Cases this issue's own search returned, each with the summary text its relevance was judged on. */
  precedents: Array<ResearchDecision & { summary: string; excerpt: boolean }>;
}

/**
 * A search for one issue that the combined research answer did not cover: its short
 * phrase goes to 판례 search and to the statute-title lookup, never the user's sentence.
 * Relevance is still judged by the caller from the source text returned here.
 */
export async function lookupIssue(
  query: string,
  shownArticles: ReadonlyArray<{ law: string; jo: string }>,
  sources: EnrichmentSources,
  expired: () => boolean,
): Promise<IssueLookup> {
  const terms = questionTerms(query);
  const keywords = terms.filter((term) => !isLawName(term));
  if (!keywords.length) return { status: "none", articles: [], precedents: [] };
  if (expired()) return { status: "timeout", articles: [], precedents: [] };
  let failed = false;
  const [hits, statutes] = await Promise.all([
    sources.precedents(query).catch(() => { failed = true; return []; }),
    titleArticles(keywords, terms.filter(isLawName), shownArticles, sources, expired, true),
  ]);
  const precedents: IssueLookup["precedents"] = [];
  const read = hits.slice(0, ISSUE_PRECEDENTS);
  await pool(read, async (hit) => {
    const summary = await sources.summary(hit.id).catch(() => undefined);
    if (summary?.text) precedents.push({ ...hit, summary: summary.text, excerpt: summary.excerpt });
  }, expired);
  precedents.sort((a, b) => read.findIndex((hit) => hit.id === a.id) - read.findIndex((hit) => hit.id === b.id));
  // Absence is only reported when both searches actually answered; otherwise it is unknown.
  const status = statutes.articles.length || precedents.length ? "found"
    : failed || statutes.status === "failed" ? "failed"
    : expired() ? "timeout" : "none";
  return { status, articles: statutes.articles, precedents };
}
