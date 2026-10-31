import type { TaskEvidenceArticle, TaskEvidenceItem } from "@/lib/task-evidence";

/**
 * Law-system display rules (no counts at the top, one grouped list below).
 * The top summary is the core answer for one tier — which provisions
 * directly cite the asked article, or that no direct link was confirmed —
 * never a provision count, and the evidence toggle groups provisions by
 * their judged relation, so the same provision is never listed twice and a
 * directly linked decree is never mixed with a decree that cites another
 * article.
 */

/** Top summary for one law-system tier item: the directly linked provisions
 * by name, or that the direct link to the asked article is unconfirmed. */
export function lawSystemTopSummary(item: TaskEvidenceItem): string | undefined {
  const articles = item.articles ?? [];
  const direct = articles.filter((article) => article.relation === "direct" || article.relation === "twoWay");
  if (direct.length) return `직접 연결: ${direct.map((article) => `${article.jo}${article.title ? `(${article.title})` : ""}`).join(" · ")}`;
  return articles.length ? "질문한 조항과의 직접 연결 미확인" : undefined;
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
