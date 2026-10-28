import { capForFailure, detailArticles, hasAvailableContent, hasFailedSection, hasNoUsableSection, type TaskEvidence } from "@/lib/task-evidence";

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

export function assessLawSystem(text: string, question?: string, articles?: string[]): TaskEvidence {
  if (hasNoUsableSection(text)) {
    return { status: hasFailedSection(text) ? "failed" : "none", items: [] };
  }
  const details = detailArticles(text);
  const lawTitle = /^═══\s*법체계 확인:\s*(.+?)\s*═══/mu.exec(text)?.[1]?.trim();
  const coreBody = /▶\s*핵심 조문\n([\s\S]*?)(?:\n▶|\n═══|$)/u.exec(text)?.[1]?.trim() ?? "";
  const lawFound = Boolean(lawTitle) || coreBody.length > 0;
  const asked = askedArticles(question, articles);
  // Parent-law side text only: law-tier detail articles plus the core body.
  // Sub-law bodies are excluded so an anchor cannot confirm itself.
  const parentText = [...details.filter((article) => article.tier === "law").map((article) => article.body), coreBody].join("\n");
  const parentDelegates = (jo: string) => {
    const parsed = /^제(\d+)조(?:의(\d+))?$/.exec(jo);
    if (!parsed) return false;
    const pattern = `제\\s*${parsed[1]}\\s*조${parsed[2] ? `(?:의\\s*${parsed[2]})?` : ""}[^\\n]{0,80}(대통령령|시행령|시행규칙|으로\\s*정|위임)`;
    return new RegExp(pattern, "u").test(parentText);
  };
  const tiers = (["decree", "rule"] as const).map((tier) => {
    const found = details.filter((article) => article.tier === tier);
    const anchored = found.map((article) => {
      const match = DELEGATION_ANCHOR.exec(article.body);
      return match ? { article, cited: `제${match[1]}조${match[2] ? `의${match[2]}` : ""}` } : undefined;
    }).filter((item): item is { article: (typeof found)[number]; cited: string } => Boolean(item));
    const direct = asked.length ? anchored.filter(({ cited }) => asked.includes(cited)) : anchored;
    const anchorOnly = asked.length ? anchored.filter(({ cited }) => !asked.includes(cited)) : [];
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
