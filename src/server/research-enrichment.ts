import { lawDisplayText } from "@/lib/law-display";
import { researchResult } from "@/lib/law-research-parse";
import {
  isLawName, questionTerms, rankPrecedent, titleMatches,
  type PrecedentRelevance, type ResearchEnrichment, type SupplementArticle,
} from "@/lib/research-relevance";
import { getDecisionText } from "@/server/decision-mcp";
import { getLawText, searchLaw } from "@/server/law-mcp";

type Context = { requestId: string; signal?: AbortSignal };

/** The 법제처 lookups enrichment uses; injectable so the rules are testable offline. */
export interface EnrichmentSources {
  /**
   * 판시사항 + 판결요지 + 참조조문 of a precedent; lower-court rulings often have
   * none, and then the opening of the judgment the MCP returns (`excerpt: true`).
   */
  summary(id: string): Promise<{ text: string; excerpt: boolean } | undefined>;
  /** Current laws whose name matches the query. */
  laws(query: string): Promise<Array<{ name: string; mst: string }>>;
  toc(mst: string): Promise<Array<{ jo: string; title: string }>>;
  article(mst: string, jo: string): Promise<{ text: string; effectiveDate?: string } | undefined>;
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
      return result.found ? { text: result.text, ...(result.effectiveDate ? { effectiveDate: result.effectiveDate } : {}) } : undefined;
    },
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
  const terms = questionTerms(query);
  const enrichment: ResearchEnrichment = {};

  const shownArticles = document.sections.flatMap((section) => section.articles ?? []);
  const cited = shownArticles.map((article) => `${article.law} ${article.jo}`);

  // Precedent lists only (not interpretations or tribunal rulings): the case summary is what the MCP can return.
  const precedentIds = [...new Set(document.sections
    .filter((section) => section.kind === "decision_search" && /판례/u.test(section.heading ?? ""))
    .flatMap((section) => section.decisions?.entries ?? [])
    .map((entry) => entry.id))].slice(0, MAX_PRECEDENTS);
  if (task === "full_research" && precedentIds.length) {
    const titles = new Map(document.sections.flatMap((section) => section.decisions?.entries ?? []).map((entry) => [entry.id, entry.title]));
    const relevance: Record<string, PrecedentRelevance> = {};
    await pool(precedentIds, async (id) => {
      const summary = await sources.summary(id).catch(() => undefined);
      relevance[id] = rankPrecedent(terms, { title: titles.get(id), ...(summary ? { summary: summary.text, excerpt: summary.excerpt } : {}) }, cited);
    }, expired);
    for (const id of precedentIds) relevance[id] ??= rankPrecedent(terms, { title: titles.get(id) });
    enrichment.precedents = relevance;
  }

  const keywords = terms.filter((term) => !isLawName(term));
  if (!keywords.length) {
    enrichment.supplement = { status: "not_searched", articles: [] };
    return enrichment;
  }
  // Laws named in the question or the answer's title, then laws whose names contain a question term.
  const named = [...terms.filter(isLawName), ...(document.title?.split(":").slice(1).map((part) => part.trim()).filter(isLawName) ?? [])];
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
    lookups++;
    const found = await sources.article(candidate.mst, candidate.jo).catch(() => { failures++; return undefined; });
    const excerpt = found ? articleExcerpt(found.text, candidate.jo) : "";
    if (excerpt) articles.push({ law: candidate.law, jo: candidate.jo, title: candidate.title, excerpt, matched: candidate.matched,
      ...(found?.effectiveDate ? { effectiveDate: found.effectiveDate } : {}) });
  }, expired);
  articles.sort((a, b) => chosen.findIndex((c) => c.law === a.law && c.jo === a.jo) - chosen.findIndex((c) => c.law === b.law && c.jo === b.jo));
  enrichment.supplement = {
    status: articles.length ? "found" : failures && failures === lookups ? "failed" : "none",
    articles,
  };
  return enrichment;
}
