import { citesParent } from "@/lib/research-citations";
import { researchResult } from "@/lib/law-research-parse";
import { lawNameCandidates, parseExplicitIdentities } from "@/lib/law-identity";
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
    // \b never fires after a Hangul syllable, so catch a deleted body by prefix.
    if (!excerpt || /^삭제/u.test(excerpt)) { report.missing++; return undefined; }
    return { law: law.name, jo, title, body, excerpt, matched: [], stage: "supplement", ...(fetched.effectiveDate ? { effectiveDate: fetched.effectiveDate } : {}) };
  };
  const add = (article: FollowupArticle) => articles.set(`${compactLaw(article.law)}\0${article.jo}`, article);
  const terms = questionTerms(query);
  const bare = new Set(["시행령", "시행규칙", "법령", "대통령령", "부령", "총리령"]);
  // Law names come from the raw question first (one structured identity,
  // so a spaced official name is not fragmented into "보호법"), with the
  // token-derived names kept behind them as a fallback. A joined name
  // keeps its fragment as an exact-match fallback per logical law.
  const candidates = lawNameCandidates(query);
  const fallbackByName = new Map(candidates.filter((c) => c.fallback).map((c) => [compactLaw(c.name), c.fallback!]));
  // A fragment a joined candidate already covers is not a second law to
  // look up: looking it up can only add a spurious missing count.
  const coveredFragments = new Set(candidates.filter((c) => c.fallback).map((c) => c.fallback!));
  let names = [...new Set([...candidates.map((c) => c.name),
    ...terms.filter((term) => isLawName(term) && !bare.has(term) && !coveredFragments.has(term))])];
  // A law-less procedure question can use an upstream identity only when its
  // name contains the question's own subject. A chain title alone is insufficient.
  if (!names.length && mode === "procedure_detail") {
    names = [...text.matchAll(/^법령(?:명)?:\s*([^|(\n]+)/gmu)].map((m) => m[1].trim())
      .filter((name) => terms.some((term) => isSubjectTerm(term) && compactLaw(name).includes(compactLaw(term))));
  }
  names = [...new Set(names.map(lawRoot))].slice(0, 2);
  const parsedPairs = parseExplicitIdentities(query);
  const pairs = parsedPairs.length ? parsedPairs : explicitArticlePairs(terms);
  if (!pairs.length && names.length === 1) for (const jo of asked) pairs.push({ law: names[0], jo });
  const adopted = researchEvidenceSources(text, query, enrichment).articles;
  const seeds = [...(enrichment?.supplement?.articles ?? []),
    ...researchResult(text).sections.flatMap((s) => s.articles ?? []).map((a) => ({ ...a, title: a.title ?? "", matched: [] }))]
    .filter((a) => adopted.some((b) => b.law === a.law && b.jo === a.jo));
  for (const name of names) {
    const laws = await safe(() => sources.laws(name));
    let exact = laws?.find((law) => compactLaw(law.name) === compactLaw(name));
    // A joined spaced name that resolves to nothing falls back to its
    // fragment key, so a wrong join cannot lose a real law. One missing
    // per logical law, not per key tried.
    if (!exact && fallbackByName.has(compactLaw(name))) {
      const alt = await safe(() => sources.laws(fallbackByName.get(compactLaw(name))!));
      exact = alt?.find((law) => compactLaw(law.name) === compactLaw(fallbackByName.get(compactLaw(name))!));
    }
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
    // Limited chain-candidate expansion (not adoption), run before the
    // tier reads so a candidate the tier path reads but discards is not
    // lost to the read cache: a chain or supplement article of this law
    // family that the whole-question adoption missed can still become a
    // followup target when its own preview already shows both halves of
    // the link — a citation of a verified same-family parent article and
    // an annex reference. The candidate is then fetched in full and both
    // halves are verified again on its body before it joins, so expansion
    // never confirms anything by itself: the annex reader still has to
    // verify the annex from the official response, and issue adoption
    // still judges the article by the issue's own terms. Bounded to two
    // candidates, and never used for procedure_detail, whose TOC path
    // already covers it.
    if (mode !== "procedure_detail") {
      const chainCandidates: Array<{ law: string; jo: string; excerpt: string }> = [
        ...researchResult(text).sections.flatMap((s) => s.articles ?? []).map((a) => ({ law: a.law, jo: a.jo, excerpt: a.excerpt ?? "" })),
        ...(enrichment?.supplement?.articles ?? []).map((a) => ({ law: a.law, jo: a.jo, excerpt: a.excerpt })),
      ];
      const parentJos = new Set(chainCandidates
        .filter((a) => sameLawFamily(a.law, name) && !/시행령|시행규칙$/u.test(compactLaw(a.law)))
        .map((a) => a.jo));
      for (const pair of pairs) if (sameLawFamily(pair.law, name)) parentJos.add(pair.jo);
      const expandable = chainCandidates.filter((a) => !articles.has(`${compactLaw(a.law)}\0${a.jo}`)
        && sameLawFamily(a.law, name) && /별표\s*\d+/u.test(a.excerpt)
        && [...parentJos].some((jo) => citesParent(a.excerpt, jo)));
      for (const candidate of expandable.slice(0, 2)) {
        if (expired()) { report.limited = true; break; }
        const found = await safe(() => sources.laws(candidate.law));
        const lawObj = found?.find((law) => compactLaw(law.name) === compactLaw(candidate.law));
        if (!lawObj) continue;
        const fetched = await read(lawObj, candidate.jo);
        if (!fetched) continue;
        if (![...parentJos].some((jo) => citesParent(fetched.body, jo))) continue;
        if (!/별표\s*\d+/u.test(fetched.body)) continue;
        add(fetched);
      }
    }
    if (!parents.length && mode !== "procedure_detail") continue;
    const parentText = parents.map((a) => `${a.title}\n${a.body}`).join("\n");
    const tiers = mode === "law_system"
      ? ([...new Set(query.match(/시행령|시행규칙/gu) ?? ["시행령", "시행규칙"])])
      : mode === "procedure_detail" ? ["시행규칙", "시행령"]
      // A 총리령 delegation is a 시행규칙-tier delegation, like 부령: the
      // parent law's own wording ("총리령으로 정하는 경우") must open the
      // 시행규칙 lookup, not leave it closed because the word is neither
      // 부령 nor 시행규칙.
      : ["시행규칙", "시행령"].filter((tier) => tier === "시행규칙" ? /부령|총리령|시행규칙/u.test(parentText) : /대통령령|시행령/u.test(parentText));
    // Tier reads keep their original order (resolve, then read) so the
    // first-pass timing is unchanged; plans are only retained so a
    // law-system second pass can continue below. A title term that merely
    // repeats the law's own name does not discriminate between that law's
    // articles, so it carries no score: without this, every title
    // containing the regime word outranks a title carrying only the
    // parent's distinctive term, and the article that actually
    // cites the asked parent can sit below the read cut.
    const lawNameCompact = compactLaw(exact.name);
    const tierPlans: Array<{ lower: { name: string; mst: string }; candidates: Array<{ jo: string; title: string; score: number }>; read: number }> = [];
    for (const tier of tiers) {
      const targetName = `${exact.name} ${tier}`;
      const lower = (await safe(() => sources.laws(targetName)))?.find((law) => compactLaw(law.name) === compactLaw(targetName));
      if (!lower) { report.missing++; continue; }
      const toc = await safe(() => sources.toc(lower.mst));
      const candidates = (toc ?? []).map((entry) => {
        const words = questionTerms(entry.title).filter((t) => !isLawName(t) && isSubjectTerm(t) && !lawNameCompact.includes(compactLaw(t)));
        const score = words.reduce((n, t) => n + (compactLaw(parentText).includes(compactLaw(t)) ? Math.min(t.length, 6) : 0), 0)
          + (/처분/u.test(entry.title) && /처분/u.test(parentText) ? 4 : 0)
          + (mode === "procedure_detail" && /서식|서류/u.test(entry.title) ? 12 : 0);
        return { ...entry, score };
      }).filter((a) => a.score > 0).sort((a, b) => b.score - a.score);
      let readCount = 0;
      for (const candidate of candidates.slice(0, 6)) {
        const article = await read(lower, candidate.jo);
        readCount++;
        if (!article) continue;
        if (mode === "procedure_detail" || parents.some((p) => citesParent(article.body, p.jo))) add(article);
      }
      tierPlans.push({ lower, candidates, read: readCount });
    }
    // Phase 2 (law_system only): a tier read exists to discover direct
    // links, not to sample six titles. When scored candidates remain
    // unread, keep reading them in score order — whether or not an
    // earlier candidate already cited the parent, so a genuine link
    // ranked below another citer is not left hidden. The existing
    // guards (readKeys 18, 15 s budget) still bind; no cap is raised.
    // Other modes keep phase 1 only: their tier adds every article it
    // reads, so an unread remainder is already reported via `limited`.
    if (mode === "law_system") {
      for (const plan of tierPlans) {
        for (const candidate of plan.candidates.slice(plan.read)) {
          if (expired() || readKeys.size >= 18) break;
          const article = await read(plan.lower, candidate.jo);
          plan.read++;
          if (!article) continue;
          if (parents.some((p) => citesParent(article.body, p.jo))) add(article);
        }
      }
    }
    for (const plan of tierPlans) report.limited ||= plan.read < plan.candidates.length;
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
