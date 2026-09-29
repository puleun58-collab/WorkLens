import type { OrdinanceComparison, OrdinanceRegionResult } from "@/lib/law-research";
import { callLawTool } from "@/server/law-mcp";

type Context = { requestId: string; signal?: AbortSignal };

/** The 법제처 lookups the comparison uses; injectable so the rules are testable offline. */
export interface OrdinanceSources {
  search(query: string): Promise<string>;
  text(ordinSeq: string, jo?: string): Promise<string>;
}

export function mcpOrdinanceSources(context: Context): OrdinanceSources {
  return {
    async search(query) {
      return (await callLawTool("execute_tool", { tool_name: "search_ordinance", params: { query, display: 100 } }, context)).text;
    },
    async text(ordinSeq, jo) {
      return (await callLawTool("execute_tool", { tool_name: "get_ordinance", params: jo ? { ordinSeq, jo } : { ordinSeq } }, context)).text;
    },
  };
}

const MAX_TOPICS = 4;
const EXCERPT_CHARS = 600;
const compact = (text: string) => text.replace(/\s+/gu, "");

interface OrdinanceEntry { id: string; name: string; body?: string; effective?: string }

/** `[2153147] 남동구 주차장 설치 및 관리 조례` / `  지자체: …` / `  시행일: …` blocks. */
export function parseOrdinanceSearch(text: string): OrdinanceEntry[] {
  const entries: OrdinanceEntry[] = [];
  for (const block of text.split(/\n\s*\n/u)) {
    const head = /^\s*\[(\d{1,20})\]\s+(.+?)\s*$/mu.exec(block);
    if (!head) continue;
    const body = /^\s*지자체:\s*(.+?)\s*$/mu.exec(block)?.[1];
    const effective = /^\s*시행일:\s*(\d{8})\s*$/mu.exec(block)?.[1];
    entries.push({ id: head[1], name: head[2], ...(body ? { body } : {}), ...(effective ? { effective } : {}) });
  }
  return entries;
}

/**
 * Article titles in order. Long ordinances return a `목차 (총 N개 조문)` block of bare titles;
 * short ones return the full text, whose `제N조(제목)` headings also give each exact number.
 */
export function parseOrdinanceToc(text: string): Array<{ title: string; jo?: string }> {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^\s*목차\s*\(총\s*\d+\s*개\s*조문\)\s*$/u.test(line));
  if (start < 0) {
    return [...text.matchAll(/^\s*(제\d+조(?:의\d+)?)\s*\(([^)]+)\)/gmu)].map((match) => ({ jo: match[1], title: match[2].trim() }));
  }
  const titles: Array<{ title: string }> = [];
  for (const line of lines.slice(start + 1)) {
    const title = line.trim();
    if (!title) { if (titles.length) break; continue; }
    if (/^특정\s*조문\s*조회/u.test(title)) break;
    titles.push({ title });
  }
  return titles;
}

/** `제19조(임산부 전용주차구획의 설치) 본문…` → the number, title and body actually returned. */
export function parseOrdinanceArticle(text: string): { jo: string; title: string; body: string } | undefined {
  const match = /^\s*(제\d+조(?:의\d+)?)\s*\(([^)]+)\)\s*([\s\S]*)$/mu.exec(text.split(/^---\s*$/mu).at(-1) ?? text);
  if (!match) return undefined;
  const body = match[3].trim();
  return { jo: match[1], title: match[2].trim(), body: body.length > EXCERPT_CHARS ? `${body.slice(0, EXCERPT_CHARS).trimEnd()} …` : body };
}

const SHORTLIST = 6;
const LOOKUP_ATTEMPTS = 6;

/**
 * How much of each topic word a name shares, by longest shared stem: 주차요금 and 주차장 share 주차.
 * Korean compounds share stems, so this ranks 주차장 조례 above an unrelated 시세 감면 조례 for 주차요금 감면.
 */
function stemOverlap(name: string, words: readonly string[]): number {
  const text = compact(name);
  return words.reduce((sum, word) => {
    for (let length = word.length; length >= 2; length--) if (text.includes(word.slice(0, length))) return sum + length;
    return sum;
  }, 0);
}

/** Title words the topic names in full; the measure used for rows and for choosing among shortlisted ordinances. */
function titleFit(title: string, words: readonly string[]): number {
  return words.filter((word) => compact(title).includes(word)).length;
}

type TocEntry = { title: string; jo?: string };

async function regionResult(region: string, topic: string, words: readonly string[], parentKeyword: string | undefined, sources: OrdinanceSources): Promise<OrdinanceRegionResult & { toc: TocEntry[] }> {
  try {
    // Ordinance names rarely carry the topic's own words (주차요금 lives inside 주차장 조례), so a few
    // narrower queries — the parent law's subject, each word, and the longest word's stem — run
    // together and their results are pooled; bounded to five searches.
    const longest = [...words].sort((a, b) => b.length - a.length)[0];
    const queries = [...new Set([`${region} ${topic}`, ...(parentKeyword ? [`${region} ${parentKeyword}`] : []),
      ...(longest ? [`${region} ${longest}`, ...(longest.length > 2 ? [`${region} ${longest.slice(0, 2)}`] : [])] : []),
      ...words.map((word) => `${region} ${word}`)])].slice(0, 5);
    const pooled = new Map<string, OrdinanceEntry>();
    for (const text of await Promise.all(queries.map((query) => sources.search(query)))) {
      for (const entry of parseOrdinanceSearch(text)) pooled.set(entry.id, entry);
    }
    const key = compact(region);
    const nameWords = [...new Set([...words, ...(parentKeyword ? [parentKeyword] : [])])];
    // `광진구` matches `서울특별시 광진구`; the region's own ordinance (not a district's inside it) earns a bonus.
    const inRegion = [...pooled.values()].filter((entry) => compact(entry.body ?? "").includes(key) || compact(entry.name).startsWith(key));
    const score = (entry: OrdinanceEntry) => stemOverlap(entry.name, nameWords) * 2
      + (compact(entry.body ?? "").endsWith(key) ? 5 : 0) + (/조례$/u.test(entry.name) ? 1 : 0);
    const ranked = inRegion.sort((a, b) => score(b) - score(a));
    // Every name within two points of the best competes on article titles (names only suggest); at most six.
    const shortlist = ranked.filter((entry) => score(entry) >= score(ranked[0]) - 2).slice(0, SHORTLIST);
    if (!shortlist.length) return { region, status: "none", candidates: 0, articles: [], toc: [] };
    // Names only suggest; the ordinance whose article titles fit the topic best is the one compared.
    const tocs = await Promise.all(shortlist.map(async (entry) => parseOrdinanceToc(await sources.text(entry.id).catch(() => ""))));
    const fit = tocs.map((toc) => Math.max(0, ...toc.map((entry) => titleFit(entry.title, words))));
    const best = shortlist.map((_, index) => index).sort((a, b) => fit[b] - fit[a] || score(shortlist[b]) - score(shortlist[a]))[0];
    const chosen = shortlist[best];
    return { region, status: "found", candidates: inRegion.length, ordinance: { id: chosen.id, name: chosen.name,
      ...(chosen.body ? { body: chosen.body } : {}), ...(chosen.effective ? { effective: chosen.effective } : {}) }, articles: [], toc: tocs[best] };
  } catch {
    return { region, status: "failed", candidates: 0, articles: [], toc: [] };
  }
}

/**
 * Compares two regions' ordinances on one topic. Every article shown was
 * fetched from 법제처 and its returned number and title were checked against
 * the table of contents; nothing is paired by guesswork or model output.
 */
export async function compareOrdinances(topic: string, regions: readonly [string, string], sources: OrdinanceSources, parentLaw?: string): Promise<OrdinanceComparison> {
  // Topic words as they appear in article titles (`주차장 설치 기준` → 주차장, 설치, 기준), minus the regions themselves.
  const words = [...new Set(topic.split(/[\s,.;:·!?()]+/u)
    .map((word) => word.length > 2 ? word.replace(/(?:의|을|를|에|과|와|은|는|이|가)$/u, "") : word)
    .filter((word) => word.length >= 2 && !regions.some((region) => compact(region).includes(word))))];
  // `주차장법` → `주차장`: the subject a region's ordinance on that law is usually named after.
  const parentKeyword = parentLaw?.replace(/\s+/gu, "").replace(/(?:에관한)?법(?:률)?$/u, "") || undefined;
  const found = await Promise.all(regions.map((region) => regionResult(region, topic, words, parentKeyword, sources)));
  // Rows: article titles sharing the most topic words (at least two when any title has two).
  const titles = [...new Set(found.flatMap((result) => result.toc.map((entry) => entry.title)))];
  const threshold = Math.min(2, Math.max(0, ...titles.map((title) => titleFit(title, words))));
  const topics = threshold ? titles.filter((title) => titleFit(title, words) >= threshold)
    .sort((a, b) => titleFit(b, words) - titleFit(a, words)).slice(0, MAX_TOPICS) : [];
  const results = await Promise.all(found.map(async ({ toc, ...result }) => {
    if (result.status !== "found" || !result.ordinance) return result;
    const articles = (await Promise.all(topics.map(async (title) => {
      const index = toc.findIndex((entry) => entry.title === title);
      if (index < 0) return undefined;
      // A full-text reply names the number. A bare TOC only suggests one by position (chapters, 조의N and
      // deleted articles shift it), so each miss is corrected by where the returned title sits in the TOC.
      // Either way a number is accepted only when 법제처's text for it carries this exact title.
      const known = toc[index].jo;
      if (known) {
        const article = parseOrdinanceArticle(await sources.text(result.ordinance!.id, known).catch(() => ""));
        return article && compact(article.title) === compact(title) ? { ...article, topic: title } : undefined;
      }
      const tried = new Set<number>();
      for (let guess = index + 1; guess > 0 && !tried.has(guess) && tried.size < LOOKUP_ATTEMPTS;) {
        tried.add(guess);
        const article = parseOrdinanceArticle(await sources.text(result.ordinance!.id, `제${guess}조`).catch(() => ""));
        // A deleted article (`제17조 <삭제>`) has no title to steer by; step past it.
        if (!article) { guess += 1; continue; }
        if (compact(article.title) === compact(title)) return { ...article, topic: title };
        const landed = toc.findIndex((entry) => compact(entry.title) === compact(article.title));
        guess += landed < 0 ? 1 : index - landed;
      }
      return undefined;
    }))).filter((article) => article !== undefined);
    return { ...result, articles };
  }));
  return { topic, topics, regions: results };
}
