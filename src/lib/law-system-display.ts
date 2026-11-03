import type { TaskEvidenceArticle, TaskEvidenceItem } from "@/lib/task-evidence";
import { sameLawFamily } from "@/lib/research-scope";

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
export function lawSystemTopSummary(item: TaskEvidenceItem, parentLaw?: string): string | undefined {
  const articles = item.articles ?? [];
  const direct = articles.filter((article) => article.relation === "twoWay")
    .sort((a, b) => Number(a.parentParagraph ?? Infinity) - Number(b.parentParagraph ?? Infinity));
  if (direct.length) return direct.map((article) => {
    const parentPrefix = parentLaw && sameLawFamily(parentLaw, article.law) ? ""
      : parentLaw ? `${article.law.replace(/\s*시행(?:령|규칙)$/u, "")} ` : "법 ";
    const parent = article.parentJo ? `${parentPrefix}${article.parentJo}${article.parentParagraph ? ` 제${article.parentParagraph}항` : ""} → ` : "";
    const subject = article.subject ?? article.title;
    return `${parent}${item.label} ${article.jo}${subject ? `\n${subject}에 관한 사항` : ""}`;
  }).join("\n\n");
  if (articles.some((article) => article.relation === "citation" || article.relation === "direct")) {
    return "질문 조항을 인용·준용하는 규정 확인";
  }
  return "직접 위임관계 미확인 (원문 부족은 관계 부존재를 뜻하지 않습니다)";
}

export interface LawSystemRelationGroup {
  key: "direct" | "citation" | "other" | "unidentified" | "related";
  label: string;
  articles: TaskEvidenceArticle[];
}

const RELATION_GROUPS: Array<{ key: LawSystemRelationGroup["key"]; label: string;
  match: (relation: TaskEvidenceArticle["relation"]) => boolean }> = [
  { key: "direct", label: "직접 위임관계", match: (relation) => relation === "twoWay" },
  { key: "citation", label: "단순 인용·준용 (직접 위임 미확인)", match: (relation) => relation === "citation" || relation === "direct" },
  { key: "other", label: "다른 조항 참조", match: (relation) => relation === "other" },
  { key: "unidentified", label: "위임 대상 조항 확인 필요", match: (relation) => relation === "unidentified" },
  { key: "related", label: "간접 관련·조회 자료", match: (relation) => relation === "related" },
];

/** Group provisions by judged relation, in display order; empty groups omitted. */
export function groupLawSystemArticles(articles: readonly TaskEvidenceArticle[]): LawSystemRelationGroup[] {
  return RELATION_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    articles: articles.filter((article) => group.match(article.relation)),
  })).filter((group) => group.articles.length > 0);
}
