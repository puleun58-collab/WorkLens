import { citesParent } from "@/lib/research-citations";
import { researchResult } from "@/lib/law-research-parse";
import { compactLaw, lawRoot, sameLawFamily } from "@/lib/research-scope";
import { isLawName, isSubjectTerm, questionTerms, researchEvidenceSources, type ResearchEnrichment, type SupplementArticle } from "@/lib/research-relevance";
import { articleExcerpt, explicitArticlePairs, type EnrichmentSources } from "@/server/research-enrichment";

export interface FollowupReport {
  status: "complete" | "partial" | "failed" | "not-searched";
  attempted: number;
  failed: number;
  missing: number;
  /** Unread candidates/budget exhaustion, not evidence of legal absence. */
  limited: boolean;
}
export interface FollowupArticle extends SupplementArticle { body: string }
export interface ResearchFollowup {
  articles: FollowupArticle[];
  report: FollowupReport;
}

/** A bounded second retrieval stage. Numbers come only from the question,
 * official headings or source citations. Title matches generate candidates;
 * a subordinate article must cite the fetched parent before it joins a link.
 */
export async function retrieveResearchFollowup(
  mode: "law_system" | "action_basis" | "procedure_detail",
  query: string, text: string, enrichment: ResearchEnrichment | undefined,
  sources: EnrichmentSources, asked: readonly string[] = [], now: () => number = Date.now,
): Promise<ResearchFollowup> {
  const started = now();
  const report: FollowupReport = { status: "not-searched", attempted: 0, failed: 0, missing: 0, limited: false };
  const expired = () => now() - started >= 15_000;
  const articles = new Map<string, FollowupArticle>();
  const readKeys = new Set<string>();
  const safe = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
    if (expired()) { report.limited = true; return undefined; }
    report.attempted++;
    try { return await read(); } catch { report.failed++; return undefined; }
  };
  const read = async (law: { name: string; mst: string }, jo: string): Promise<FollowupArticle | undefined> => {
    const key = `${compactLaw(law.name)}\0${jo}`;
    if (readKeys.has(key)) return articles.get(key);
    if (readKeys.size >= 18 || expired()) { report.limited = true; return undefined; }
    readKeys.add(key);
    const fetched = await safe(() => sources.article(law.mst, jo));
    if (!fetched) { report.missing++; return undefined; }
    if (fetched.name && compactLaw(fetched.name) !== compactLaw(law.name)) { report.missing++; return undefined; }
    const head = new RegExp(`^${jo}(?:\\s|\\()`, "mu");
    if (!head.test(fetched.text)) { report.missing++; return undefined; }
    const heading = new RegExp(`^${jo}\\s*\\(([^)]+)\\)`, "mu").exec(fetched.text);
    const title = heading?.[1] ?? new RegExp(`^${jo} ([^\\n]+)`, "mu").exec(fetched.text)?.[1] ?? "";
    // Remove only the header prefix (number + optional parenthesized title), not the whole first line: when the body starts on the header line itself, dropping the line loses the first sentence, including the citation the delegation check looks for.
    const body = fetched.text.slice(fetched.text.search(head)).replace(new RegExp(`^${jo}\\s*(?:\\([^)]*\\)\\s*)?`, "u"), "").trim();
    const excerpt = articleExcerpt(fetched.text, jo);
    if (!excerpt || /^삭제\b/u.test(excerpt)) { report.missing++; return undefined; }
    return { law: law.name, jo, title, body, excerpt, matched: [], stage: "supplement", ...(fetched.effectiveDate ? { effectiveDate: fetched.effectiveDate } : {}) };
  };
  const add = (article: FollowupArticle) => articles.set(`${compactLaw(article.law)}\0${article.jo}`, article);
  const terms = questionTerms(query);
  const bare = new Set(["시행령", "시행규칙", "법령", "대통령령", "부령", "총리령"]);
  let names = terms.filter((term) => isLawName(term) && !bare.has(term));
  // A law-less procedure question can use an upstream identity only when its
  // name contains the question's own subject. A chain title alone is insufficient.
  if (!names.length && mode === "procedure_detail") {
    names = [...text.matchAll(/^법령(?:명)?:\s*([^|(\n]+)/gmu)].map((m) => m[1].trim())
      .filter((name) => terms.some((term) => isSubjectTerm(term) && compactLaw(name).includes(compactLaw(term))));
  }
  names = [...new Set(names.map(lawRoot))].slice(0, 2);
  const pairs = explicitArticlePairs(terms);
  if (!pairs.length && names.length === 1) for (const jo of asked) pairs.push({ law: names[0], jo });
  const adopted = researchEvidenceSources(text, query, enrichment).articles;
  const seeds = [...(enrichment?.supplement?.articles ?? []),
    ...researchResult(text).sections.flatMap((s) => s.articles ?? []).map((a) => ({ ...a, title: a.title ?? "", matched: [] }))]
    .filter((a) => adopted.some((b) => b.law === a.law && b.jo === a.jo));
  for (const name of names) {
    const laws = await safe(() => sources.laws(name));
    const exact = laws?.find((law) => compactLaw(law.name) === compactLaw(name));
    if (!exact) { report.missing++; continue; }
    const parents: FollowupArticle[] = [];
    const parentJo = [...new Set([...pairs.filter((p) => sameLawFamily(p.law, name)).map((p) => p.jo),
      ...seeds.filter((a) => compactLaw(a.law) === compactLaw(exact.name)).map((a) => a.jo)])];
    for (const jo of parentJo.slice(0, 4)) {
      const article = await read(exact, jo);
      if (article) { parents.push(article); add(article); }
    }
    // Procedure coverage includes periods and forms, which short chain previews omit.
    if (mode === "procedure_detail") {
      const toc = await safe(() => sources.toc(exact.mst));
      const candidates = (toc ?? []).filter((a) => /기간|기한|청구|신청|서식|서류/u.test(a.title));
      candidates.sort((a, b) => Number(/기간|기한/u.test(b.title)) - Number(/기간|기한/u.test(a.title)));
      report.limited ||= candidates.length > 4;
      for (const candidate of candidates.slice(0, 4)) {
        const article = await read(exact, candidate.jo);
        if (article) { parents.push(article); add(article); }
      }
    }
    if (!parents.length && mode !== "procedure_detail") continue;
    const parentText = parents.map((a) => `${a.title}\n${a.body}`).join("\n");
    const tiers = mode === "law_system"
      ? ([...new Set(query.match(/시행령|시행규칙/gu) ?? ["시행령", "시행규칙"])])
      : mode === "procedure_detail" ? ["시행규칙", "시행령"]
      : ["시행규칙", "시행령"].filter((tier) => tier === "시행규칙" ? /부령|시행규칙/u.test(parentText) : /대통령령|시행령/u.test(parentText));
    for (const tier of tiers) {
      const targetName = `${exact.name} ${tier}`;
      const lower = (await safe(() => sources.laws(targetName)))?.find((law) => compactLaw(law.name) === compactLaw(targetName));
      if (!lower) { report.missing++; continue; }
      const toc = await safe(() => sources.toc(lower.mst));
      const candidates = (toc ?? []).map((entry) => {
        const words = questionTerms(entry.title).filter((t) => !isLawName(t) && isSubjectTerm(t));
        const score = words.reduce((n, t) => n + (compactLaw(parentText).includes(compactLaw(t)) ? Math.min(t.length, 6) : 0), 0)
          + (/처분/u.test(entry.title) && /처분/u.test(parentText) ? 4 : 0)
          + (mode === "procedure_detail" && /서식|서류/u.test(entry.title) ? 12 : 0);
        return { ...entry, score };
      }).filter((a) => a.score > 0).sort((a, b) => b.score - a.score);
      report.limited ||= candidates.length > 6;
      for (const candidate of candidates.slice(0, 6)) {
        const article = await read(lower, candidate.jo);
        if (!article) continue;
        if (mode === "procedure_detail" || parents.some((p) => citesParent(article.body, p.jo))) add(article);
      }
    }
  }
  report.status = !report.attempted ? "not-searched" : report.failed === report.attempted ? "failed"
    : report.failed || report.limited || report.missing ? "partial" : "complete";
  return { articles: [...articles.values()], report };
}

/** Preserve actual returned text; source identity is explicit for the shared assessor. */
export function followupDetailText(articles: readonly FollowupArticle[]): string {
  return articles.length ? `\n▶ 추가 조회 조문\n${articles.map((a) => {
    const tier = /시행규칙$/u.test(a.law) ? "시행규칙" : /시행령$/u.test(a.law) ? "시행령" : "법률";
    return `[${tier}] ${a.law} ${a.jo} (${a.title || "제목 미제공"})\n${a.body}\n`;
  }).join("\n")}` : "";
}
