import type { SupplementArticle } from "@/lib/research-relevance";
import type { TaskEvidenceItem, TaskEvidenceArticle, TaskEvidenceBodyRef } from "@/lib/task-evidence";
import { lawSourceUrl } from "@/lib/research-scope";
export interface TaskSource {
  law: string;
  jo: string;
  title?: string;
  excerpt: string;
  effective?: string;
  source?: string;
  /** An article may support several independently assessed items. */
  links: Array<{ label: string; status: TaskEvidenceItem["status"]; role: string; expression?: string }>;
}

/** Combine only the same official source, provision, version and actual text range.
 * A shorter excerpt contained in a longer one is the same range's preview;
 * disjoint excerpts and distinct versions remain separate entries. */
export function taskSources(
  items: readonly TaskEvidenceItem[],
  candidates: readonly Omit<TaskSource, "links">[],
): TaskSource[] {
  const rows: TaskSource[] = [];
  const add = (candidate: Omit<TaskSource, "links">, link?: TaskSource["links"][number]) => {
    const text = candidate.excerpt.trim();
    const range = text.replace(/\s*…\s*$/u, "");
    const compatible = (row: TaskSource) => row.law === candidate.law && row.jo === candidate.jo
      && row.source === candidate.source && (row.effective === candidate.effective || !row.effective || !candidate.effective)
      && (!text || !row.excerpt || row.excerpt.includes(range) || range.includes(row.excerpt.replace(/\s*…\s*$/u, "")));
    const row = rows.find(compatible);
    if (row) {
      if (!row.effective) row.effective = candidate.effective;
      if (text.length > row.excerpt.length) row.excerpt = text;
      if (!row.title) row.title = candidate.title;
      if (link && !row.links.some((entry) => entry.label === link.label && entry.role === link.role && entry.status === link.status)) row.links.push(link);
    } else rows.push({ ...candidate, excerpt: text, links: link ? [link] : [] });
  };
  // Start with known versions so an unversioned reference is attached to its
  // matching excerpt rather than merging two dated versions by article number.
  for (const candidate of candidates) add(candidate);
  for (const item of items) for (const ref of item.articles ?? item.basisRefs ?? item.requirementRefs ?? []) {
    const article = ref as TaskEvidenceArticle | TaskEvidenceBodyRef;
    const role = "relation" in article ? ({
      direct: "직접 연결", twoWay: "법률 위임·직접 연결", other: "다른 조항 참조",
      unidentified: "위임 대상 미확인", related: "관련 조항",
    })[article.relation] : "note" in article && article.note ? article.note : item.label === "적용 요건" ? "요건 문언" : item.label === "세부 기준(별표)" ? "세부 기준 인용 조항" : "법적 근거";
    add({
      law: article.law, jo: article.jo, title: article.title,
      excerpt: "excerpt" in article ? article.excerpt : "",
      source: lawSourceUrl(article.law, article.jo),
    }, { label: item.title ?? item.label, status: item.status, role, ...("expression" in article && article.expression ? { expression: article.expression } : {}) });
  }
  return rows;
}
/** Presentation only: never merge different versions or different source excerpts. */
export function articleDisplayKey(article: { law: string; jo: string; excerpt: string; effective?: string }): string {
  return JSON.stringify([article.law, article.jo, article.effective ?? "", article.excerpt.trim()]);
}

/** Describe the title we can see, without claiming which lookup produced it. */
export function hasQuestionTermInTitle(article: SupplementArticle): boolean {
  return !article.explicit && article.matched.some((term) => Boolean(term.trim()) && article.title.includes(term));
}
