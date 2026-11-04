import { lawDisplayText } from "@/lib/law-display";
import { researchResult } from "@/lib/law-research-parse";
import {
  isDefinitionTitle, isLawName, isSubjectTerm, orderByRelevance, questionTerms, questionTermsRelationLess, questionTermsSubjectLess, rankPrecedent, researchDecisionDomain, titleMatches, termInText,
  type PrecedentRelevance, type ResearchDecisionDomain, type ResearchEnrichment, type SupplementArticle,
} from "@/lib/research-relevance";
import { parseExplicitIdentities, type ExplicitIdentity } from "@/lib/law-identity";
import type { ResearchDecision } from "@/lib/law-research-parse";
import { getDecisionText, parseDecisionText, searchDecisions } from "@/server/decision-mcp";
import { getLawText, searchLaw } from "@/server/law-mcp";

type Context = { requestId: string; signal?: AbortSignal };

export interface EnrichmentLaw {
  name: string;
  mst: string;
  effectiveDate?: string;
}

/** The 법제처 lookups enrichment uses; injectable so the rules are testable offline. */
export interface EnrichmentSources {
  /**
   * Official 판시사항/판결요지, or a judgment opening when no holding is
   * available (`excerpt: true`). Reference lists alone are not evidence.
   */
  summary(id: string): Promise<{ text: string; excerpt: boolean } | undefined>;
  /** Official holding/reply/reasons, never the search title or institution metadata. */
  decisionSummary?(domain: ResearchDecisionDomain, id: string): Promise<{ text: string; excerpt: boolean } | undefined>;
  /** Laws returned by the official index; explicit non-current statuses are excluded. */
  laws(query: string): Promise<EnrichmentLaw[]>;
  toc(mst: string): Promise<Array<{ jo: string; title: string }>>;
  article(mst: string, jo: string): Promise<{ text: string; name?: string; effectiveDate?: string } | undefined>;
  /** 법령해석례 search; [] when the MCP reports no result. */
  interpretations(query: string): Promise<Array<{ id: string; title?: string; caseNumber?: string; body?: string; date?: string }>>;
  /** 판례 search for one issue's short phrase; [] when the MCP reports no result. */
  precedents(query: string): Promise<ResearchDecision[]>;
}

const SUMMARY_HEADINGS: Record<string, true> = { 판시사항: true, 판결요지: true, 결정요지: true, 재결요지: true, 회답: true, 회신내용: true };
/** `주문` lines some sources file under 판결요지: they decide the case but say nothing about the issue. */
const DISPOSITION_LINE = /(?:각하한다|기각한다|인용한다|취소한다|환송한다|부담한다|지급하라|이행하라)\.?\s*$/u;
const isDisposition = (text: string) => text.split(/\r?\n/u).filter((line) => line.trim()).every((line) => DISPOSITION_LINE.test(line));

/**
 * Only holding/reply/reasons carry relevance. References and a 질의요지
 * without an answer cannot establish a judgment or interpretation.
 */
export function precedentEvidence(
  result: { text: string; sections?: Array<{ heading: string; text: string }> },
): { text: string; excerpt: boolean } | undefined {
  const substantive = (result.sections ?? [])
    .filter((section) => Object.hasOwn(SUMMARY_HEADINGS, section.heading) && section.text.trim() && !isDisposition(section.text));
  if (substantive.length) {
    return { text: lawDisplayText(substantive.map((section) => section.text).join("\n")), excerpt: false };
  }
  const reasons = result.sections?.filter((section) => section.heading === "이유" || section.heading === "결정이유")
    .map((section) => section.text).join("\n");
  if (reasons?.trim() && !isDisposition(reasons)) return { text: lawDisplayText(reasons), excerpt: false };
  const body = result.sections?.filter((section) => section.heading === "이유" || section.heading === "전문")
    .map((section) => section.text).join("\n") ?? result.text;
  if (!body.trim() || isDisposition(body)) return undefined;
  // A body without a holding or identified reason section is only an opening,
  // whatever its decision domain. A matching title cannot supply the ruling.
  return { text: lawDisplayText(body), excerpt: true };
}

export function mcpEnrichmentSources(context: Context): EnrichmentSources {
  const fullLaws = new Map<string, { text: string; name?: string; effectiveDate?: string }>();
  return {
    async summary(id) {
      const result = await getDecisionText("precedent", id, undefined, context);
      return result.found ? precedentEvidence(result) : undefined;
    },
    async decisionSummary(domain, id) {
      const result = await getDecisionText(domain === "tribunal" ? "admin_appeal" : domain, id, undefined, context);
      return result.found ? precedentEvidence(result) : undefined;
    },
    async laws(query) {
      const result = await searchLaw(query, context);
      if (!result.found) return [];
      return result.laws.filter((law) => law.mst && (!law.status || law.status === "현행")).map((law) => ({
        name: law.name, mst: law.mst!, ...(law.effectiveDate ? { effectiveDate: law.effectiveDate } : {}),
      }));
    },
    async toc(mst) {
      const result = await getLawText({ mst }, undefined, context);
      if (!result.found) return [];
      if (result.mode === "toc") return result.articles ?? [];
      // A small law already contains official bodies. Keep it request-local
      // so its TOC and subsequent article reads do not refetch one document.
      fullLaws.set(mst, result);
      const articles = new Map<string, { jo: string; title: string }>();
      for (const match of result.text.matchAll(/^(제[1-9]\d{0,3}조(?:의[1-9]\d*)?)(?:\s+([^\n]+)|\(([^)\n]+)\))/gmu)) {
        articles.set(match[1], { jo: match[1], title: (match[3] ?? match[2]).trim() });
      }
      return [...articles.values()];
    },
    async article(mst, jo) {
      const full = fullLaws.get(mst);
      if (full) {
        const headings = [...full.text.matchAll(/^(제[1-9]\d{0,3}조(?:의[1-9]\d*)?)(?:\s|\(|$)/gmu)];
        const start = headings.findIndex((match) => match[1] === jo);
        if (start < 0) return undefined;
        const end = headings.slice(start + 1).find((match) => match[1] !== jo)?.index;
        return { ...full, text: full.text.slice(headings[start].index, end).trim() };
      }
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

const sharedSourceInstances = new WeakSet<EnrichmentSources>();

/**
 * One cache and one concurrency limit for every lookup a request makes: issues that
 * reach the same law, table of contents, article or case never repeat the call.
 */
export function sharedSources(sources: EnrichmentSources, limit = CONCURRENCY): EnrichmentSources {
  if (limit === CONCURRENCY && sharedSourceInstances.has(sources)) return sources;
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
  const shared: EnrichmentSources = {
    summary: (id) => call(`summary\0${id}`, () => sources.summary(id)),
    ...(sources.decisionSummary ? {
      decisionSummary: (domain: ResearchDecisionDomain, id: string) => domain === "precedent"
        ? call(`summary\0${id}`, () => sources.summary(id))
        : call(`decisionSummary\0${domain}\0${id}`, () => sources.decisionSummary!(domain, id)),
    } : {}),
    laws: (query) => {
      const normalized = query.trim().replace(/\s+/gu, " ");
      return call(`laws\0${normalized}`, () => sources.laws(normalized));
    },
    toc: (mst) => call(`toc\0${mst.trim()}`, () => sources.toc(mst.trim())),
    article: (mst, jo) => {
      const normalized = jo.replace(/\s+/gu, "");
      return call(`article\0${mst.trim()}\0${normalized}`, () => sources.article(mst.trim(), normalized));
    },
    interpretations: (query) => call(`interpretations\0${query}`, () => sources.interpretations(query)),
    precedents: (query) => call(`precedents\0${query}`, () => sources.precedents(query)),
  };
  sharedSourceInstances.add(shared);
  return shared;
}

/** Follow-up lookups stay inside a fixed share of the request and never outrun it. */
const CONCURRENCY = 4;
const BUDGET_MS = 15_000;
const MAX_PRECEDENTS = 10;
const MAX_LAWS = 3;
/** A missing index hit must not turn a long planner phrase into unbounded calls. */
const MAX_LAW_QUERIES = 8;
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

export function articleExcerpt(text: string, jo: string, terms: readonly string[] = []): string {
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
  const remainder = head < 0 ? lines : lines.slice(head + 1);
  const next = remainder.findIndex((line) => /^제[1-9]\d{0,3}조(?:의[1-9]\d*)?(?:\s|\(|$)/u.test(line));
  const body = [...first, ...(next < 0 ? remainder : remainder.slice(0, next))].filter(Boolean).join("\n");
  const shown = lawDisplayText(body);
  if (shown.length <= EXCERPT_CHARS) return shown;
  // Display is not the evidence store: keep the original separately. Prefer a
  // clause carrying this issue's terms over an arbitrary first 600 characters.
  const clauses = [...shown.matchAll(/(?:^|[\n①②③④⑤⑥⑦⑧⑨⑩])([^\n①②③④⑤⑥⑦⑧⑨⑩]+)/gu)];
  const ranked = clauses.map((match) => {
    const matched = terms.filter((term) => termInText(term, match[0]));
    const offsets = matched.map((term) => match[0].indexOf(term)).filter((index) => index >= 0);
    const focus = offsets.length ? Math.min(...offsets) : 0;
    return { start: match.index + Math.max(0, focus - 100),
      score: matched.reduce((sum, term) => sum + (isSubjectTerm(term) ? 2 : 1), 0) };
  }).sort((a, b) => b.score - a.score || a.start - b.start);
  const start = ranked[0]?.score ? Math.max(0, Math.min(ranked[0].start, shown.length - EXCERPT_CHARS)) : 0;
  return `${start ? "… " : ""}${shown.slice(start, start + EXCERPT_CHARS).trim()}${start + EXCERPT_CHARS < shown.length ? " …" : ""}`;
}

/**
 * Re-ranks official court, interpretation and administrative-appeal bodies and
 * looks up articles whose titles carry the question's terms. Nothing here
 * invents a citation; unread decisions stay `unknown`.
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

  // An empty interpretation section is retried once using the question's own
  // terms. Search hits stay candidates until their official reply is read.
  const interpretation = document.sections.find((section) => section.status === "not_found" && /해석례/u.test(section.heading ?? ""));
  const retryQuery = terms.join(" ");
  if (interpretation && terms.length && retryQuery !== query.trim() && !expired() && !options.skipInterpretationRetry) {
    const entries = await sources.interpretations(retryQuery).catch(() => []);
    const relevant = task === "full_research"
      ? entries.filter((entry) => terms.some((term) => (entry.title ?? "").replace(/\s+/gu, "").includes(term.replace(/\s+/gu, ""))))
      : entries;
    if (relevant.length) enrichment.interpretations = { query: retryQuery, entries: orderByRelevance(relevant, undefined).slice(0, 5) };
  }

  if (task === "full_research" && !options.skipPrecedentSummaries) {
    const candidates = document.sections.filter((section) => section.kind === "decision_search")
      .flatMap((section) => {
        const domain = researchDecisionDomain(section.heading);
        return domain ? (section.decisions?.entries ?? []).map((entry) => ({ domain, entry })) : [];
      });
    candidates.push(...(enrichment.interpretations?.entries ?? []).map((entry) => ({ domain: "interpretation" as const, entry })));
    const selected = (["precedent", "interpretation", "tribunal"] as const).flatMap((domain) => {
      const unique = new Map(candidates.filter((candidate) => candidate.domain === domain).map(({ entry }) => [entry.id, entry]));
      return [...unique.values()].slice(0, MAX_PRECEDENTS).map((entry) => ({ domain, entry }));
    });
    if (selected.length) {
      const relevance: Record<string, PrecedentRelevance> = {};
      const excerpts: Record<string, string> = {};
      const originals: NonNullable<ResearchEnrichment["decisionOriginals"]> = {};
      await pool(selected, async ({ domain, entry }) => {
        const summary = await (domain === "precedent" ? sources.summary(entry.id)
          : sources.decisionSummary?.(domain, entry.id) ?? Promise.resolve(undefined)).catch(() => undefined);
        const key = `${domain}:${entry.id}`;
        if (summary?.text) originals[key] = { domain, id: entry.id, title: entry.title, caseNumber: entry.caseNumber,
          body: "body" in entry ? entry.body : undefined, date: entry.date, text: summary.text, partial: summary.excerpt };
        relevance[key] = rankPrecedent(terms, { title: entry.title,
          ...(summary ? { summary: summary.text, excerpt: summary.excerpt } : {}) }, cited, { query });
        if (summary?.text && (relevance[key].rank === "direct" || relevance[key].rank === "related")) {
          excerpts[key] = summary.text.length > EXCERPT_CHARS ? `${summary.text.slice(0, EXCERPT_CHARS).trimEnd()} …` : summary.text;
        }
      }, expired);
      for (const { domain, entry } of candidates) {
        const key = `${domain}:${entry.id}`;
        relevance[key] ??= rankPrecedent(terms, { title: entry.title });
      }
      enrichment.decisions = relevance;
      enrichment.decisionExcerpts = excerpts;
      if (Object.keys(originals).length) enrichment.decisionOriginals = originals;
      const precedents = Object.entries(relevance).filter(([key]) => key.startsWith("precedent:"));
      if (precedents.length) {
        enrichment.precedents = Object.fromEntries(precedents.map(([key, value]) => [key.slice("precedent:".length), value]));
        enrichment.precedentExcerpts = Object.fromEntries(Object.entries(excerpts).filter(([key]) => key.startsWith("precedent:"))
          .map(([key, value]) => [key.slice("precedent:".length), value]));
      }
    }
  }
  if (task === "full_research") {
    // Automatic detail blocks are already part of the chain response. Reading
    // them adds no search or detail request, including for constitutional and
    // other decision domains outside the existing three-domain summary budget.
    for (const section of document.sections) {
      const domain = researchDecisionDomain(section.heading);
      if (!domain || section.status !== "available" || section.kind !== "detail") continue;
      const detail = section.lines.join("\n");
      const records = [...detail.matchAll(/^\[(\d+)\][^\n]*\n(?=\s*=== [^\n]+ ===)/gmu)];
      for (const [index, record] of records.entries()) {
        const parsed = parseDecisionText(detail.slice(record.index + record[0].length, records[index + 1]?.index));
        const evidence = precedentEvidence(parsed);
        if (!evidence?.text.trim()) continue;
        const entry = document.sections.filter((source) => researchDecisionDomain(source.heading) === domain)
          .flatMap((source) => source.decisions?.entries ?? []).find((candidate) => candidate.id === record[1]);
        const key = `${domain}:${record[1]}`;
        const previous = enrichment.decisionOriginals?.[key];
        if (previous && (!previous.partial && evidence.excerpt
          || previous.partial === evidence.excerpt && previous.text.length >= evidence.text.length)) continue;
        (enrichment.decisionOriginals ??= {})[key] = { domain, id: record[1], title: parsed.title ?? entry?.title,
          caseNumber: entry?.caseNumber, body: entry?.body, date: entry?.date,
          text: evidence.text, partial: evidence.excerpt };
      }
    }
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
  let attempts = 0;
  for (const article of articles) {
    if (expired() || attempts >= 3) break;
    const cited: string[] = [];
    const original = article.original ?? article.excerpt;
    for (const match of original.matchAll(/제([1-9]\d{0,3})조(?:의([1-9]\d?))?/gu)) {
      const clause = original.slice(0, match.index).split(/[.\n①②③④⑤⑥⑦⑧⑨⑩]/u).at(-1) ?? "";
      if (/「|」|법\s*$|영\s*$|시행령|시행규칙|같은\s*법/u.test(clause)) continue;
      const jo = `제${match[1]}조${match[2] ? `의${match[2]}` : ""}`;
      if (jo !== article.jo && !seen.has(`${article.law}\0${jo}`) && !cited.includes(jo)) cited.push(jo);
    }
    if (!cited.length) continue;
    const found = await sources.laws(article.law).catch(() => { partialFailure = true; return []; });
    const exact = found.find((law) => compactName(law.name) === compactName(article.law));
    if (!exact) continue;
    for (const jo of cited.slice(0, 2)) {
      if (expired() || attempts >= 3) break;
      seen.add(`${article.law}\0${jo}`);
      attempts++;
      const fetched = await sources.article(exact.mst, jo).catch(() => { partialFailure = true; return undefined; });
      if (!fetched) continue;
      if (!sameLawVersion({ name: exact.name, effectiveDate: article.effectiveDate ?? exact.effectiveDate }, fetched)) {
        partialFailure = true;
        continue;
      }
      const excerpt = articleExcerpt(fetched.text, jo, keywords);
      if (!excerpt) continue;
      const title = /제[1-9]\d{0,3}조(?:의[1-9]\d?)?\(([^)]+)\)/u.exec(fetched.text)?.[1]?.trim() ?? "";
      const key = `${article.law}\0${jo}`;
      seen.add(key);
      const effectiveDate = fetched.effectiveDate ?? exact.effectiveDate;
      followed.push({ law: article.law, jo, title, excerpt, original: fetched.text,
        matched: keywords.filter((term) => termInText(term, excerpt)),
        role: isDefinitionTitle(title) ? "definition" : "other", stage: "supplement",
        ...(effectiveDate ? { effectiveDate } : {}) });
    }
  }
  return { articles: followed, partialFailure: partialFailure || expired() };
}

/** A planner direction changes candidate allocation, not the number of searches. */
export interface IssueSearchDirection {
  direction?: "obligation" | "conduct" | "procedure";
  query?: string;
}

const DIRECTION_TITLES = {
  obligation: /의무|준수|조치|보호|금지/u,
  conduct: /행위|금지|제한|위반/u,
  procedure: /절차|신청|신고|통지|청문|의견|조사/u,
};
const compactLawName = (value: string) => value.replace(/\s+/gu, "");

/** Optional source metadata must not conflict with the index-selected MST. */
function sameLawVersion(
  expected: { name: string; effectiveDate?: string },
  actual: { name?: string; effectiveDate?: string },
): boolean {
  return (!actual.name || compactLawName(actual.name) === compactLawName(expected.name))
    && (!expected.effectiveDate || !actual.effectiveDate
      || expected.effectiveDate.replace(/\D/gu, "") === actual.effectiveDate.replace(/\D/gu, ""));
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
  search: IssueSearchDirection = {},
): Promise<NonNullable<ResearchEnrichment["supplement"]>> {
  const compactName = compactLawName;
  const laws = new Map<string, { mst: string; effectiveDate?: string }>();
  let failures = 0;
  let lawQueries = 0;
  for (const name of new Set(named)) {
    if (laws.size >= MAX_LAWS || lawQueries >= MAX_LAW_QUERIES || expired()) break;
    lawQueries++;
    const found = await sources.laws(name).catch(() => { failures++; return []; });
    // The official name may space a compound the question wrote joined
    // (개인정보보호법 → 개인정보 보호법): compare compacted, never guess a
    // different law — a spaced name that only differs by spaces is the same law.
    const exact = found.find((law) => compactName(law.name) === compactName(name));
    if (exact) laws.set(exact.name, exact);
  }
  for (const term of keywords) {
    // In the displayed supplement, a generic word must not discover laws by
    // itself: searching "조사" or "의무" returned whole unrelated regimes
    // (대일항쟁기 특별법, 이태원 특별법…) whose titles merely share that
    // word, and those filled the related-articles list. Law discovery uses
    // subject terms only there; named laws above are unaffected.
    if (strictCandidates && !isSubjectTerm(term)) continue;
    if (laws.size >= MAX_LAWS || lawQueries >= MAX_LAW_QUERIES || expired()) break;
    lawQueries++;
    const found = await sources.laws(term).catch(() => { failures++; return []; });
    for (const law of found.filter((entry) => entry.name.includes(term) && entry.name.endsWith("법")).slice(0, MAX_LAWS_PER_TERM)) {
      if (laws.size < MAX_LAWS && ![...laws.keys()].some((name) => compactName(name) === compactName(law.name))) {
        laws.set(law.name, law);
      }
    }
  }

  const candidates: Array<{ law: string; mst: string; effectiveDate?: string; jo: string; title: string; matched: string[]; directional: boolean }> = [];
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
  await pool([...laws], async ([law, version]) => {
    const toc = await sources.toc(version.mst).catch(() => { failures++; return []; });
    for (const article of toc) {
      const matched = titleMatches(keywords, law, article.title);
      // In the displayed supplement, generic words alone are not
      // relatedness, however many match: "조사 의무" matched two generic
      // words for a 식품위생법 영업정지 question and still named no
      // subject. A displayed candidate needs a subject term, unless the
      // no-subject-term named-law relaxation above applies; the looser
      // rule stays available to per-issue lookup (strictCandidates off),
      // where the issue's own adoption check still applies.
      // Probe generic directional titles only inside a named regime. Their
      // bodies still need the caller's independent per-issue adoption check.
      const directional = !!search.direction && namedCompacts.has(compactName(law))
        && DIRECTION_TITLES[search.direction].test(article.title) && !isDefinitionTitle(article.title);
      if ((directional || matched.length && (!strictCandidates || matched.some(isSubjectTerm) || (namedRelaxation && namedCompacts.has(compactName(law)))))
        && !shownArticles.some((shown) => compactName(shown.law) === compactName(law) && shown.jo === article.jo)) {
        candidates.push({ law, ...version, jo: article.jo, title: article.title, matched, directional });
      }
    }
  }, expired);
  // One directional body probe uses an existing slot. Round-robin regimes
  // before taking a second article: a long first TOC must not starve a peer.
  const order = [...laws.keys()];
  const ranked = candidates.sort((a, b) => subjectMatched(b.matched) - subjectMatched(a.matched)
    || Number(isDefinitionTitle(a.title)) - Number(isDefinitionTitle(b.title))
    || b.matched.length - a.matched.length || order.indexOf(a.law) - order.indexOf(b.law)
    || a.jo.localeCompare(b.jo, "ko", { numeric: true }));
  const chosen: typeof candidates = [];
  const directional = ranked.find((candidate) => candidate.directional);
  if (directional) chosen.push(directional);
  for (const candidate of ranked) {
    if (chosen.length >= MAX_ARTICLES) break;
    if (!chosen.some((item) => item.law === candidate.law)) chosen.push(candidate);
  }
  for (const candidate of ranked) {
    if (chosen.length >= MAX_ARTICLES) break;
    if (!chosen.includes(candidate)) chosen.push(candidate);
  }

  const articles: SupplementArticle[] = [];
  await pool(chosen, async (candidate) => {
    const found = await sources.article(candidate.mst, candidate.jo).catch(() => { failures++; return undefined; });
    // A stale or differently-versioned body is rejected as evidence; it is not an upstream outage.
    if (strictName && found && !sameLawVersion({ name: candidate.law, effectiveDate: candidate.effectiveDate }, found)) return;
    const excerpt = found ? articleExcerpt(found.text, candidate.jo, keywords) : "";
    const effectiveDate = found?.effectiveDate ?? candidate.effectiveDate;
    if (excerpt) articles.push({ law: candidate.law, jo: candidate.jo, title: candidate.title, excerpt, original: found!.text, matched: candidate.matched,
      role: isDefinitionTitle(candidate.title) ? "definition" : "other", stage: "supplement",
      ...(effectiveDate ? { effectiveDate } : {}) });
  }, expired);
  articles.sort((a, b) => chosen.findIndex((c) => c.law === a.law && c.jo === a.jo) - chosen.findIndex((c) => c.law === b.law && c.jo === b.jo));
  const incomplete = failures > 0 || expired();
  return { status: articles.length ? "found" : incomplete ? "failed" : "none", articles,
    ...(incomplete && articles.length ? { partialFailure: true as const } : {}) };
}

/** Cases read per issue search: the first hits, in the MCP's own order. */
const ISSUE_PRECEDENTS = 4;

export interface IssueLookup {
  /** `failed`: a required lookup failed with no evidence; `timeout`: the budget expired with no evidence. */
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
 * Lookup errors are reported separately; they must not become confirmed absence.
 */
async function fetchExplicitArticles(
  pairs: ReadonlyArray<{ law: string; jo: string; lawAlt?: string }>,
  sources: EnrichmentSources,
  expired: () => boolean,
  onFailure: () => void,
): Promise<SupplementArticle[]> {
  const compactName = (value: string) => value.replace(/\s+/gu, "");
  const resolve = (found: EnrichmentLaw[], name: string) => {
    const exact = found.find((law) => compactName(law.name) === compactName(name));
    if (exact) return exact;
    const suffix = found.filter((law) => compactName(law.name).endsWith(compactName(name)));
    return suffix.length === 1 ? suffix[0] : undefined;
  };
  const articles: SupplementArticle[] = [];
  for (const pair of pairs.slice(0, 6)) {
    if (expired()) break;
    const found = await sources.laws(pair.law).catch(() => { onFailure(); return []; });
    let law = resolve(found, pair.law);
    if (!law && pair.lawAlt) {
      const altFound = await sources.laws(pair.lawAlt).catch(() => { onFailure(); return []; });
      law = resolve(altFound, pair.lawAlt);
    }
    if (!law) continue;
    if (expired()) break;
    const fetched = await sources.article(law.mst, pair.jo).catch(() => { onFailure(); return undefined; });
    if (!fetched) continue;
    if (!sameLawVersion(law, fetched)) { onFailure(); continue; }
    const excerpt = articleExcerpt(fetched.text, pair.jo);
    // \b is an ASCII word boundary and never fires after a Hangul
    // syllable, so a deleted body ("삭제…") must be caught by prefix.
    if (!excerpt || /^삭제/u.test(excerpt)) continue;
    const title = /제[1-9]\d{0,3}조(?:의[1-9]\d?)?\(([^)]+)\)/u.exec(fetched.text)?.[1]?.trim() ?? "";
    const effectiveDate = fetched.effectiveDate ?? law.effectiveDate;
    articles.push({ law: law.name, jo: pair.jo, title, excerpt, original: fetched.text, matched: [], explicit: true, stage: "issue",
      role: isDefinitionTitle(title) ? "definition" : "other",
      ...(effectiveDate ? { effectiveDate } : {}) });
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
  search: IssueSearchDirection = {},
): Promise<IssueLookup> {
  const terms = questionTerms(query);
  const keywords = terms.filter((term) => !isLawName(term));
  if (!keywords.length) return { status: "none", articles: [], precedents: [] };
  if (expired()) return { status: "timeout", articles: [], precedents: [] };
  // The issue itself remains the adoption/identity boundary. A planner phrase
  // supplies search terms only and consumes this same lookup's search slots.
  const searchQuery = search.query?.trim() || query;
  const titleKeywords = [...new Set([...keywords, ...questionTerms(searchQuery).filter((term) => !isLawName(term)),
    ...extraTerms.filter((term) => !isLawName(term))])];
  sources = sharedSources(sources);
  let failed = false;
  const explicitFailure = () => { failed = true; };
  const [hits, statutes, explicit] = await Promise.all([
    sources.precedents(searchQuery).catch(() => { failed = true; return []; }),
    titleArticles(titleKeywords, [...new Set([...terms.filter(isLawName), ...extraNamed])], shownArticles, sources, expired, true, false, search),
    (async () => {
      // Articles the issue itself named are fetched for this issue. The
      // issue phrase is parsed from its raw text, not from its tokens,
      // so a spaced law name in the issue itself keeps one identity too.
      const ownIdentities = parseExplicitIdentities(query);
      const own = await fetchExplicitArticles(ownIdentities.length ? ownIdentities : explicitArticlePairs(terms), sources, expired, explicitFailure);
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
      if (!subjectLess && (issueHasLaw || !questionPairs.some((pair) => issueJoTerms.includes(pair.jo)))) return own;
      const fetched = await fetchExplicitArticles(questionPairs, sources, expired, explicitFailure);
      const qualified = fetched.filter((article) => {
        if (subjectLess && DELEGATION.test(article.original ?? article.excerpt)) return true;
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
  // A precedent-summary failure with no covering article or precedent is a
  // lookup failure, not a confirmed absence: without this, the failure is
  // silently reported as "none" and the issue looks merely unconfirmed.
  const timedOut = expired();
  const status = mergedArticles.length || precedents.length ? "found"
    : timedOut ? "timeout"
    : failed || statutes.status === "failed" || summaryFailed ? "failed" : "none";
  // A covering branch must not swallow the other branch's failure: when the lookup
  // still reports `found`, the failure is carried separately for the caller to surface.
  // That now includes failures inside a branch (a title lookup that landed one
  // article while another law threw, or a precedent summary that threw while
  // articles or other precedents covered the issue).
  const partialFailure = status === "found"
    && (failed || statutes.status === "failed" || statutes.partialFailure === true || summaryFailed || timedOut);
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
  shown: ReadonlyArray<{ law: string; jo: string; title?: string; effectiveDate?: string }>,
  candidateTerms: readonly string[],
  sources: EnrichmentSources,
  expired: () => boolean,
  limit = 2,
  options: {
    /** Validate primary bodies even when their headings use different words. */
    includeUnmatched?: boolean;
    onIncomplete?: (reason: "failed" | "timeout" | "identity_mismatch") => void;
  } = {},
): Promise<SupplementArticle[]> {
  sources = sharedSources(sources);
  const seen = new Set<string>();
  const candidates = shown
    .filter((article) => {
      const key = `${compactLawName(article.law)}\0${article.jo}\0${article.effectiveDate?.replace(/\D/gu, "") ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((article) => ({ article, matched: article.title ? titleMatches(candidateTerms, article.law, article.title) : [] }))
    .filter((entry) => options.includeUnmatched || entry.matched.length > 0)
    .sort((a, b) => b.matched.length - a.matched.length)
    .slice(0, Math.min(2, Math.max(0, limit)));
  const articles: SupplementArticle[] = [];
  for (const { article, matched } of candidates) {
    if (expired()) { options.onIncomplete?.("timeout"); break; }
    const found = await sources.laws(article.law).catch(() => { options.onIncomplete?.("failed"); return []; });
    const exact = found.find((law) => compactLawName(law.name) === compactLawName(article.law));
    if (!exact) continue;
    if (article.effectiveDate && exact.effectiveDate
      && article.effectiveDate.replace(/\D/gu, "") !== exact.effectiveDate.replace(/\D/gu, "")) {
      options.onIncomplete?.("identity_mismatch");
      continue;
    }
    if (expired()) { options.onIncomplete?.("timeout"); break; }
    const fetched = await sources.article(exact.mst, article.jo).catch(() => { options.onIncomplete?.("failed"); return undefined; });
    if (!fetched) continue;
    // A displayed version needs an anchor in either the official index (the
    // selected MST) or the detail metadata. Ordinary detail responses may
    // omit optional date headers without making that MST's body invalid.
    if (article.effectiveDate && !exact.effectiveDate && !fetched.effectiveDate
      || !sameLawVersion({ name: exact.name, effectiveDate: article.effectiveDate ?? exact.effectiveDate }, fetched)) {
      options.onIncomplete?.("identity_mismatch");
      continue;
    }
    const excerpt = articleExcerpt(fetched.text, article.jo, candidateTerms);
    if (!excerpt) { options.onIncomplete?.("identity_mismatch"); continue; }
    const effectiveDate = fetched.effectiveDate ?? exact.effectiveDate;
    articles.push({ law: article.law, jo: article.jo, title: article.title ?? "", excerpt, original: fetched.text, matched,
      role: isDefinitionTitle(article.title) ? "definition" : "other", stage: "reread",
      ...(effectiveDate ? { effectiveDate } : {}) });
  }
  if (expired() && candidates.length) options.onIncomplete?.("timeout");
  return articles;
}
