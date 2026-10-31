import type { TaskEvidenceArticle, TaskEvidenceItem } from "@/lib/task-evidence";

/**
 * Law-system display rules (no counts at the top, one grouped list below).
 * The top summary carries relation phrases only — never a provision count —
 * and the evidence toggle groups provisions by their judged relation, so
 * the same provision is never listed twice and a directly linked decree
 * is never mixed with a decree that cites another article.
 */

/** Top summary for one law-system tier item: relation phrases only. */
export function lawSystemTopSummary(item: TaskEvidenceItem): string | undefined {
  const articles = item.articles ?? [];
  const direct = articles.some((article) => article.relation === "direct" || article.relation === "twoWay");
  const needsMore = articles.some((article) => article.relation === "other" || article.relation === "unidentified" || article.relation === "related")
    || (articles.length > 0 && !direct);
  const parts = [...(direct ? ["직접 위임 확인됨"] : []), ...(needsMore ? ["추가 확인 필요"] : [])];
  return parts.length ? parts.join(" · ") : undefined;
}

export interface LawSystemRelationGroup {
  key: "direct" | "other" | "unidentified" | "related";
  label: string;
  articles: TaskEvidenceArticle[];
}

const RELATION_GROUPS: Array<{ key: LawSystemRelationGroup["key"]; label: string;
  match: (relation: TaskEvidenceArticle["relation"]) => boolean }> = [
  { key: "direct", label: "직접 연결", match: (relation) => relation === "direct" || relation === "twoWay" },
  { key: "other", label: "다른 조항 참조", match: (relation) => relation === "other" },
  { key: "unidentified", label: "위임 대상 조항 확인 필요", match: (relation) => relation === "unidentified" },
  { key: "related", label: "조회된 조항", match: (relation) => relation === "related" },
];

/** Group provisions by judged relation, in display order; empty groups omitted. */
export function groupLawSystemArticles(articles: readonly TaskEvidenceArticle[]): LawSystemRelationGroup[] {
  return RELATION_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    articles: articles.filter((article) => group.match(article.relation)),
  })).filter((group) => group.articles.length > 0);
}
