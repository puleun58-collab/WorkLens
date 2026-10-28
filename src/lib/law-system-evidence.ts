import { citesParent } from "@/lib/research-citations";
import { sameLawFamily } from "@/lib/research-scope";
import { isLawName, questionTerms } from "@/lib/research-relevance";
import { capForFailure, detailArticles, hasAvailableContent, hasFailedSection, hasNoUsableSection, type DetailArticle, type TaskEvidence } from "@/lib/task-evidence";

/**
 * 법체계 확인: only delegation links the MCP text itself shows count.
 * - 법률: the chain's own law (its title header) or a law-tier article body.
 * - 시행령 / 시행규칙: a detailed-format sub-law article whose body quotes
 *   the parent law ("법 제N조…에 따라 / …정하는") — a mere listing of a
 *   sub-law article, or a sub-law article body without that anchor, is
 *   retrieval (`viewed`), not a confirmed link.
 * - When the question (or an explicit `articles` input) names article
 *   numbers, an anchor counts as a *direct* delegation only when the
 *   article it cites is one of the asked numbers. An anchor citing any
 *   other number is reported separately as "위임 문구 포함" — never as a
 *   direct link to the asked article — and does not confirm its tier.
 *   A delegation phrase with no `법 제N조` prefix is likewise never a
 *   direct link; it is counted separately so it is not silently dropped.
 * - Two-way check, as far as the chain text allows: a direct link also
 *   notes whether the parent-law side carries delegation wording for the
 *   same article (in the law-tier core/detail text). The chain often does
 *   not include the parent article's body, so absence of that wording is
 *   reported ("하위법 인용만 확인"), never silently treated as confirmed
 *   from both sides, and never as proof that no delegation exists.
 * A law with no evidenced sub-law tier is never "fully confirmed": law-only
 * is `viewed`, one confirmed tier is `partial`, both confirmed tiers are
 * `matched`. A failed section caps `matched` to `partial` and never erases
 * a confirmed tier.
 */
const DELEGATION_ANCHOR = /법\s*제(\d+)조(?:의(\d+))?[^\n]{0,60}(에 따라|에서|에 따른|으로 정하는|정하는)/u;
/** Delegation wording without a `법 제N조` prefix (e.g. "대통령령으로 정하는 바에 따라"). */
const UNPREFIXED_DELEGATION = /(대통령령|시행령|시행규칙|총리령|부령)으로\s*정하는|위임(?:받은|된|하는)?\s*(?:사항|범위|내용)/u;
const ASKED_JO = /제\s*(\d+)\s*조(?:의\s*(\d+))?/gu;

export function askedArticles(question: string | undefined, articles: readonly string[] | undefined): string[] {
  const fromInput = (articles ?? []).map((item) => {
    const match = /^제(\d+)조(?:의(\d+))?$/.exec(item.trim());
    return match ? `제${match[1]}조${match[2] ? `의${match[2]}` : ""}` : undefined;
  }).filter((item): item is string => Boolean(item));
  if (fromInput.length) return [...new Set(fromInput)];
  if (!question) return [];
  const found: string[] = [];
  for (const match of question.matchAll(ASKED_JO)) {
    const jo = `제${match[1]}조${match[2] ? `의${match[2]}` : ""}`;
    if (!found.includes(jo)) found.push(jo);
  }
  return found;
}

/** Subordinate-law detail articles whose own body cites one of the asked articles as its delegation source. */
export function delegatingArticles(text: string, asked: readonly string[]): Array<{ tier: "decree" | "rule"; law: string; jo: string; title: string; body: string }> {
  return detailArticles(text)
    .filter((article): article is DetailArticle & { tier: "decree" | "rule" } => article.tier === "decree" || article.tier === "rule")
    .flatMap((article) => {
      const match = DELEGATION_ANCHOR.exec(article.body);
      if (!match) return [];
      const cited = `제${match[1]}조${match[2] ? `의${match[2]}` : ""}`;
      return asked.includes(cited) ? [{ tier: article.tier, law: article.law, jo: article.jo, title: article.title, body: article.body }] : [];
    });
}

/** How many asked articles have a directly delegating subordinate article in this text. */
export function directDelegationCount(text: string, asked: readonly string[]): number {
  return new Set(delegatingArticles(text, asked).map((article) => article.jo)).size;
}

/**
 * Reconstructed detail lines for delegating articles found in `text` that
 * `existingText` does not already contain (same law + article): appending
 * these lines to the original chain text lets assessLawSystem judge a
 * targeted second chain without double-counting articles the first chain
 * already listed. Returns "" when nothing new qualifies.
 */
export function delegatingDetailBlocks(text: string, asked: readonly string[], existingText: string): string {
  const existing = new Set(detailArticles(existingText).map((article) => `${article.law}\0${article.jo}`));
  const blocks = delegatingArticles(text, asked)
    .filter((article) => !existing.has(`${article.law}\0${article.jo}`))
    .map((article) => `[${article.tier === "decree" ? "시행령" : "시행규칙"}] ${article.law} ${article.jo} (${article.title})\n${article.body}`);
  return blocks.length ? `\n▶ 위임 대조 추가 조회\n${blocks.join("\n")}\n` : "";
}

export function assessLawSystem(text: string, question?: string, articles?: string[]): TaskEvidence {
  if (hasNoUsableSection(text)) {
    return { status: hasFailedSection(text) ? "failed" : "none", items: [] };
  }
  const named = questionTerms(question ?? "").filter(isLawName).filter((law) => !["시행령", "시행규칙", "법령"].includes(law));
  const details = detailArticles(text).filter((a) => !a.law || !named.length || named.some((law) => sameLawFamily(law, a.law)));
  const lawTitle = /^═══\s*법체계 확인:\s*(.+?)\s*═══/mu.exec(text)?.[1]?.trim();
  const coreBody = /▶\s*핵심 조문\n([\s\S]*?)(?:\n▶|\n═══|$)/u.exec(text)?.[1]?.trim() ?? "";
  const lawFound = Boolean(lawTitle) || coreBody.length > 0 || details.some((a) => a.tier === "law" && a.body);
  const asked = askedArticles(question, articles);
  // Parent-law side text only: law-tier detail articles plus the core body.
  // Sub-law bodies are excluded so an anchor cannot confirm itself.
  const parentDelegates = (jo: string) => {
    if (details.some((a) => a.tier === "law" && a.jo === jo && UNPREFIXED_DELEGATION.test(a.body))) return true;
    const head = new RegExp(`^${jo}(?:\\s|\\()`, "mu");
    const start = coreBody.search(head);
    if (start < 0) return false;
    const block = coreBody.slice(start).split(/\n(?=제\d+조(?:의\d+)?(?:\s|\())/u)
      .filter((part, i) => i === 0 || head.test(part)).join("\n");
    return UNPREFIXED_DELEGATION.test(block);
  };
  const tiers = (["decree", "rule"] as const).map((tier) => {
    const found = details.filter((article) => article.tier === tier);
    const anchored = found.map((article) => {
      const match = DELEGATION_ANCHOR.exec(article.body);
      return match ? { article, cited: `제${match[1]}조${match[2] ? `의${match[2]}` : ""}` } : undefined;
    }).filter((item): item is { article: (typeof found)[number]; cited: string } => Boolean(item));
    const direct = asked.length ? found.filter((a) => asked.some((jo) => citesParent(a.body, jo)))
      .map((article) => ({ article, cited: asked.find((jo) => citesParent(article.body, jo))! })) : anchored;
    const anchorOnly = asked.length ? anchored.filter(({ article }) => !direct.some((d) => d.article === article)) : [];
    const unprefixed = found.filter((article) => !DELEGATION_ANCHOR.test(article.body) && UNPREFIXED_DELEGATION.test(article.body));
    const twoWay = direct.some(({ cited }) => parentDelegates(cited));
    return { tier, found, anchored, direct, anchorOnly, unprefixed, twoWay };
  });
  const labels = { law: "법률", decree: "시행령", rule: "시행규칙" } as const;
  const items: TaskEvidence["items"] = [
    { label: labels.law, status: lawFound ? "found" : hasAvailableContent(text) ? "viewed" : "none",
      ...(lawTitle ? { detail: lawTitle } : {}) },
    ...tiers.map(({ tier, found, anchored, direct, anchorOnly, unprefixed, twoWay }) => {
      const name = tier === "decree" ? "시행령" : "시행규칙";
      // Count definition (상세 형식 헤더 기준): `found` counts detailed-format
      // headers only; other-format articles are not in this count.
      const parts = [`${name} ${found.length}건(상세 형식 헤더 기준)`];
      if (asked.length) {
        if (direct.length) parts.push(`직접 위임 ${direct.length}건${twoWay ? "(상위법 문언도 확인)" : "(하위법 인용만 확인)"}`);
        if (anchorOnly.length) parts.push(`위임 문구 포함 ${anchorOnly.length}건(묻는 조문과 불일치 — 직접 위임 아님)`);
      } else if (anchored.length) {
        parts.push(`위임 연결 ${anchored.length}건`);
      }
      if (unprefixed.length) parts.push(`접두사 없는 위임 문언 ${unprefixed.length}건(직접 위임 미확인)`);
      const status = (direct.length ? "found" : found.length ? "viewed" : "none") as TaskEvidence["items"][number]["status"];
      return { label: labels[tier], status, ...(found.length ? { detail: parts.join(" · ") } : {}) };
    }),
  ];
  const confirmedTiers = tiers.filter(({ direct }) => direct.length).length;
  const base = confirmedTiers === 2 ? "matched" : confirmedTiers === 1 ? "partial" : "viewed";
  return { status: capForFailure(base, hasFailedSection(text)), items };
}
