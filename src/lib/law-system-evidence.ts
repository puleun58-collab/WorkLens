import { citesParent } from "@/lib/research-citations";
import { lawNamesInQuery } from "@/lib/law-identity";
import { sameLawFamily } from "@/lib/research-scope";
import { isLawName, questionTerms } from "@/lib/research-relevance";
import { capForFailure, detailArticles, hasAvailableContent, hasFailedSection, hasNoUsableSection, type DetailArticle, type TaskEvidence, type TaskEvidenceArticle } from "@/lib/task-evidence";

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
 *   other number is reported separately as "위임 관련 표현 발견" — never as a
 *   direct link to the asked article — and does not confirm its tier.
 *   A delegation phrase with no `법 제N조` prefix is likewise never a
 *   direct link; it is counted separately so it is not silently dropped.
 * - Two-way check, as far as the chain text allows: a direct link also
 *   notes whether the parent-law side carries delegation wording for the
 *   same article (in the law-tier core/detail text). The chain often does
 *   not include the parent article's body, so absence of that wording is
 *   reported ("질문한 조항 인용 확인"), never silently treated as confirmed
 *   from both sides, and never as proof that no delegation exists.
 * A law with no evidenced sub-law tier is never "fully confirmed": law-only
 * is `viewed`. Only the tiers the question asks about are required
 * (askedTiers): a question about the decree alone is `matched` once the
 * decree link is confirmed, and an unasked tier is neither required nor
 * shown — unless its own body directly cites an asked article, in which
 * case it is shown as an optional item that never sets the verdict. A
 * question naming no tier keeps both tiers required. A failed section caps
 * `matched` to `partial` and never erases a confirmed tier.
 */
const DELEGATION_ANCHOR = /법\s*제(\d+)조(?:의(\d+))?[^\n]{0,60}(에 따라|에서|에 따른|으로 정하는|정하는)/u;
/** Delegation wording without a `법 제N조` prefix (e.g. "대통령령으로 정하는 바에 따라"). */
const UNPREFIXED_DELEGATION = /(대통령령|시행령|시행규칙|총리령|부령)으로\s*정하는|위임(?:받은|된|하는)?\s*(?:사항|범위|내용)/u;
/** Display-only truncation lines the MCP appends ("위임 내용 N자 중 일부만
 * 표시") are not statute text: they must not match delegation wording on
 * their own. The same pattern already guards procedure evidence. */
const TRUNCATION_LINE = /위임 내용 .*일부만 표시|외 \d+개 .*\(생략\)/u;
const withoutTruncationMarkers = (body: string) => body.split("\n").filter((line) => !TRUNCATION_LINE.test(line)).join("\n");
/** The operative span by which a body cites one of the asked articles, for
 * display alongside the verdict: the first span whose cited number is an
 * asked number, under the same pattern citesParent judges by. Display
 * only — the verdict itself still uses citesParent. */
function citingExpression(body: string, asked: readonly string[]): string | undefined {
  for (const match of body.matchAll(/(?:^|[\s①-⑳.,])법\s+((?:제\d+조(?:의\d+)?[^.\n]{0,160}?))(?:에 따라|에 따른|에서|으로 정하는|정하는|의 기준)/gu)) {
    const numbers = [...match[1].matchAll(/제(\d+)조(?:의(\d+))?/gu)].map((m) => `제${m[1]}조${m[2] ? `의${m[2]}` : ""}`);
    if (numbers.some((jo) => asked.includes(jo))) return match[0].trim();
  }
  return undefined;
}
const ASKED_JO = /제\s*(\d+)\s*조(?:의\s*(\d+))?/gu;

/** The sub-law tiers a question asks about. A question naming neither tier
 * (or asking about the whole chain: 3단·하위 법령·위임 구조) requires both. */
export function askedTiers(question: string | undefined): Array<"decree" | "rule"> {
  const text = question ?? "";
  if (/3단|하위\s*법령|위임\s*구조|법체계\s*전체/u.test(text)) return ["decree", "rule"];
  const tiers: Array<"decree" | "rule"> = [];
  if (/시행령|대통령령/u.test(text)) tiers.push("decree");
  if (/시행규칙|총리령|부령/u.test(text)) tiers.push("rule");
  return tiers.length ? tiers : ["decree", "rule"];
}

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
  // The question's law identity, parsed once from its raw text (so a
  // spaced official name is one identity, not the fragment "보호법"),
  // merged with the token-derived names as a fallback. A detail article
  // of another regime sharing only a suffix never passes sameLawFamily
  // against the joined name, so the join cannot admit a wrong law.
  const named = [...new Set([...lawNamesInQuery(question ?? ""),
    ...questionTerms(question ?? "").filter(isLawName).filter((law) => !["시행령", "시행규칙", "법령"].includes(law))])];
  // One provision counts once: the same detail header returned twice is
  // one provision, not two, so duplicate blocks cannot inflate a count.
  const details = [...new Map(detailArticles(text).filter((a) => !a.law || !named.length || named.some((law) => sameLawFamily(law, a.law)))
    .map((a) => [`${a.tier}\0${a.law}\0${a.jo}`, a] as const)).values()];
  const lawTitle = /^═══\s*법체계 확인:\s*(.+?)\s*═══/mu.exec(text)?.[1]?.trim();
  const coreBody = /▶\s*핵심 조문\n([\s\S]*?)(?:\n▶|\n═══|$)/u.exec(text)?.[1]?.trim() ?? "";
  const lawFound = Boolean(lawTitle) || coreBody.length > 0 || details.some((a) => a.tier === "law" && a.body);
  const asked = askedArticles(question, articles);
  const requiredTiers = askedTiers(question);
  // Parent-law side text only: law-tier detail articles plus the core body.
  // Sub-law bodies are excluded so an anchor cannot confirm itself.
  const parentDelegates = (jo: string) => {
    if (details.some((a) => a.tier === "law" && a.jo === jo && UNPREFIXED_DELEGATION.test(withoutTruncationMarkers(a.body)))) return true;
    const head = new RegExp(`^${jo}(?:\\s|\\()`, "mu");
    const start = coreBody.search(head);
    if (start < 0) return false;
    const block = coreBody.slice(start).split(/\n(?=제\d+조(?:의\d+)?(?:\s|\())/u)
      .filter((part, i) => i === 0 || head.test(part)).join("\n");
    return UNPREFIXED_DELEGATION.test(withoutTruncationMarkers(block));
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
    const unprefixed = found.filter((article) => !DELEGATION_ANCHOR.test(article.body) && UNPREFIXED_DELEGATION.test(withoutTruncationMarkers(article.body)));
    // One display relation per provision, most-confirmed first: a
    // provision can carry several signals (a direct citation and an
    // unprefixed phrase), but the list shows each provision once.
    const relationOf = (article: (typeof found)[number]): TaskEvidenceArticle["relation"] => {
      const directEntry = direct.find((d) => d.article === article);
      if (directEntry) return parentDelegates(directEntry.cited) ? "twoWay" : "direct";
      if (anchorOnly.some((a) => a.article === article)) return "other";
      if (unprefixed.some((a) => a === article)) return "unidentified";
      return "related";
    };
    const expressionOf = (article: (typeof found)[number]): string | undefined => {
      if (direct.some((d) => d.article === article)) return citingExpression(article.body, asked) ?? DELEGATION_ANCHOR.exec(article.body)?.[0]?.trim();
      if (anchorOnly.some((a) => a.article === article)) return DELEGATION_ANCHOR.exec(article.body)?.[0]?.trim();
      if (unprefixed.some((a) => a === article)) return UNPREFIXED_DELEGATION.exec(withoutTruncationMarkers(article.body))?.[0]?.trim();
      return undefined;
    };
    const articles: TaskEvidenceArticle[] = found.map((article) => ({ law: article.law, jo: article.jo, title: article.title,
      relation: relationOf(article), ...(expressionOf(article) ? { expression: expressionOf(article)! } : {}) }));
    return { tier, found, anchored, direct, anchorOnly, unprefixed, articles };
  });
  const labels = { law: "법률", decree: "시행령", rule: "시행규칙" } as const;
  const items: TaskEvidence["items"] = [
    { label: labels.law, status: lawFound ? "found" : hasAvailableContent(text) ? "viewed" : "none",
      ...(lawTitle ? { detail: lawTitle } : {}) },
    ...tiers.flatMap(({ tier, found, anchored, direct, anchorOnly, unprefixed, articles }) => {
      const name = tier === "decree" ? "시행령" : "시행규칙";
      const requested = requiredTiers.includes(tier);
      // An unasked tier is out of scope: shown only when it directly cites an asked article.
      if (!requested && !(asked.length && direct.length)) return [];
      // Counts are unique provisions, and the categories below are
      // subsets of the total — never added to it.
      const parts: string[] = [];
      if (asked.length && !direct.length && found.length) {
        parts.push(`위임 관계 확인 필요 — 조회된 ${name} 자료에서 질문한 법률 조항과 직접 연결되는 위임 근거를 확인하지 못했습니다.`);
      }
      parts.push(`${name} ${found.length}건`);
      if (asked.length) {
        const twoWayDirects = direct.filter(({ cited }) => parentDelegates(cited));
        const citationOnly = direct.length - twoWayDirects.length;
        if (twoWayDirects.length) parts.push(`그 중 법률에서 위임한 사항 확인 ${twoWayDirects.length}건`);
        if (citationOnly) parts.push(`그 중 질문한 조항 인용 확인 ${citationOnly}건`);
        if (anchorOnly.length) parts.push(`그 중 위임 관련 표현 발견 ${anchorOnly.length}건(질문한 조항과 참조 조항이 다름)`);
      } else if (anchored.length) {
        parts.push(`그 중 위임 연결 ${anchored.length}건`);
      }
      if (unprefixed.length) parts.push(`그 중 위임 대상 조항 확인 필요 ${unprefixed.length}건`);
      const status = (direct.length ? "found" : found.length ? "viewed" : "none") as TaskEvidence["items"][number]["status"];
      return [{ label: labels[tier], status, ...(requested ? {} : { optional: true }), ...(found.length ? { detail: parts.join(" · "), articles } : {}) }];
    }),
  ];
  const confirmedTiers = tiers.filter(({ tier, direct }) => requiredTiers.includes(tier) && direct.length).length;
  const base = confirmedTiers === requiredTiers.length ? "matched" : confirmedTiers > 0 ? "partial" : "viewed";
  return { status: capForFailure(base, hasFailedSection(text)), items };
}
