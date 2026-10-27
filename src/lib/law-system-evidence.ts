import { capForFailure, detailArticles, hasAvailableContent, hasFailedSection, hasNoUsableSection, type TaskEvidence } from "@/lib/task-evidence";

/**
 * 법체계 확인: only delegation links the MCP text itself shows count.
 * - 법률: the chain's own law (its title header) or a law-tier article body.
 * - 시행령 / 시행규칙: a detailed-format sub-law article whose body quotes
 *   the parent law ("법 제N조…에 따라 / …정하는") — a mere listing of a
 *   sub-law article, or a sub-law article body without that anchor, is
 *   retrieval (`viewed`), not a confirmed link.
 * A law with no evidenced sub-law tier is never "fully confirmed": law-only
 * is `viewed`, one anchored tier is `partial`, both anchored tiers are
 * `matched`. A failed section caps `matched` to `partial` and never erases
 * a confirmed tier.
 */
const DELEGATION_ANCHOR = /법\s*제\d+조[^\n]{0,60}(에 따라|에서|에 따른|으로 정하는|정하는)/u;

export function assessLawSystem(text: string): TaskEvidence {
  if (hasNoUsableSection(text)) {
    return { status: hasFailedSection(text) ? "failed" : "none", items: [] };
  }
  const details = detailArticles(text);
  const lawTitle = /^═══\s*법체계 확인:\s*(.+?)\s*═══/mu.exec(text)?.[1]?.trim();
  const coreBody = /▶\s*핵심 조문\n([\s\S]*?)(?:\n▶|\n═══|$)/u.exec(text)?.[1]?.trim() ?? "";
  const lawFound = Boolean(lawTitle) || coreBody.length > 0;
  const tiers = (["decree", "rule"] as const).map((tier) => {
    const found = details.filter((article) => article.tier === tier);
    const anchored = found.filter((article) => DELEGATION_ANCHOR.test(article.body));
    return { tier, found, anchored };
  });
  const labels = { law: "법률", decree: "시행령", rule: "시행규칙" } as const;
  const items: TaskEvidence["items"] = [
    { label: labels.law, status: lawFound ? "found" : hasAvailableContent(text) ? "viewed" : "none",
      ...(lawTitle ? { detail: lawTitle } : {}) },
    ...tiers.map(({ tier, found, anchored }) => ({
      label: labels[tier],
      status: (anchored.length ? "found" : found.length ? "viewed" : "none") as TaskEvidence["items"][number]["status"],
      ...(found.length ? { detail: `${tier === "decree" ? "시행령" : "시행규칙"} ${found.length}건${anchored.length ? ` · 위임 연결 ${anchored.length}건` : ""}` } : {}),
    })),
  ];
  const anchoredTiers = tiers.filter(({ anchored }) => anchored.length).length;
  const base = anchoredTiers === 2 ? "matched" : anchoredTiers === 1 ? "partial" : "viewed";
  return { status: capForFailure(base, hasFailedSection(text)), items };
}
