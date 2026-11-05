import type { IssueEvidence } from "@/lib/law-research";
import type { SupplementArticle } from "@/lib/research-relevance";
import type { TaskEvidenceItem, TaskEvidenceArticle, TaskEvidenceBodyRef } from "@/lib/task-evidence";
import { compactLaw, lawSourceUrl, sameLawFamily } from "@/lib/research-scope";
import { citesParent } from "@/lib/research-citations";
import { lawNamesInQuery, parseExplicitIdentities } from "@/lib/law-identity";
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

/** Combine the same official provision and version into one displayed source.
 * Preserve disjoint excerpts as separate quoted ranges inside that source. */
export function taskSources(
  items: readonly TaskEvidenceItem[],
  candidates: readonly Omit<TaskSource, "links">[],
): TaskSource[] {
  const rows: TaskSource[] = [];
  const add = (candidate: Omit<TaskSource, "links">, link?: TaskSource["links"][number]) => {
    const text = candidate.excerpt.trim();
    const compatible = (row: TaskSource) => row.law === candidate.law && row.jo === candidate.jo
      && row.source === candidate.source && (row.effective === candidate.effective || !row.effective || !candidate.effective);
    const row = rows.find(compatible);
    if (row) {
      if (!row.effective) row.effective = candidate.effective;
      if (text && !row.excerpt.includes(text.replace(/\s*…\s*$/u, ""))) {
        const old = row.excerpt.replace(/\s*…\s*$/u, "");
        row.excerpt = text.includes(old) ? text : `${row.excerpt}\n…\n${text}`;
      }
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
      direct: "직접 위임 미확인", twoWay: "직접 위임관계", citation: "단순 인용·준용", other: "다른 조항 참조",
      unidentified: "위임 대상 미확인", related: "간접 관련",
    })[article.relation] : "note" in article && article.note ? article.note : item.label === "적용 요건" ? "요건 문언" : item.label === "세부 기준(별표)" ? "세부 기준 인용 조항" : "법적 근거";
    add({
      law: article.law, jo: article.jo, title: article.title,
      excerpt: "excerpt" in article ? article.excerpt : "",
      source: lawSourceUrl(article.law, article.jo),
    }, { label: item.title ?? item.label, status: item.status, role, ...("expression" in article && article.expression ? { expression: article.expression } : {}) });
  }
  return rows;
}

/** Source roles describe evidenced relevance, not merely membership in a task item. */
export function taskSourceRole(
  row: TaskSource,
  askedReferences: readonly { law: string; jo: string }[],
  task: string,
  query: string,
): "직접 관련 근거" | "보충 근거" | "추가 조회 자료" {
  const explicit = task === "law_system" ? parseExplicitIdentities(query) : [];
  const namedLaws = task === "law_system" ? lawNamesInQuery(query) : [];
  const asked = explicit.length ? explicit : askedReferences.filter((ref) =>
    !namedLaws.length || namedLaws.some((law) => compactLaw(law) === compactLaw(ref.law)));
  if (asked.some((ref) => compactLaw(ref.law) === compactLaw(row.law) && ref.jo === row.jo)
    && (task !== "law_system" || Boolean(row.excerpt.trim()))) return "직접 관련 근거";
  if (task !== "law_system") {
    return row.links.some((link) => link.status === "found" && /^(?:직접 위임관계|법적 근거|요건 문언)$/u.test(link.role))
      ? "직접 관련 근거" : row.links.length ? "보충 근거" : "추가 조회 자료";
  }
  const hasExpression = (link: TaskSource["links"][number]) => Boolean(link.expression?.trim())
    && row.excerpt.replace(/\s+/gu, "").includes(link.expression!.replace(/\s+/gu, ""));
  const citesAsked = asked.some((ref) => sameLawFamily(ref.law, row.law) && citesParent(row.excerpt, ref.jo));
  if (row.links.some((link) => link.status === "found" && link.role === "직접 위임관계" && hasExpression(link))
    && (!namedLaws.length || namedLaws.some((law) => sameLawFamily(law, row.law)))
    && (!asked.length || citesAsked)) return "직접 관련 근거";
  return citesAsked && row.links.some((link) => link.role === "단순 인용·준용" && hasExpression(link))
    ? "보충 근거" : "추가 조회 자료";
}
/** Presentation only: never merge different versions or different source excerpts. */
export function articleDisplayKey(article: { law: string; jo: string; excerpt: string; effective?: string }): string {
  return JSON.stringify([article.law, article.jo, article.effective ?? "", article.excerpt.trim()]);
}

/**
 * needs_confirmation (structural S3): the party and act match but the user's
 * facts could not confirm an application requirement. It is never a
 * confirmed source; the list says exactly which facts would settle it.
 */
export function needsConfirmationView(issue: Pick<IssueEvidence, "status" | "unconfirmed" | "followUp">): { items: string[]; followUp: string } | undefined {
  if (issue.status !== "needs_confirmation") return;
  const items = [...new Set((issue.unconfirmed ?? []).map((item) => item.trim()).filter(Boolean))];
  return { items, followUp: issue.followUp?.trim()
    || (items.length ? `다음 적용 요건에 해당하는 사실을 알려주면 다시 확인할 수 있습니다: ${items.join(", ")}.`
      : "적용 요건에 해당하는 사실을 질문에 더하면 다시 확인할 수 있습니다.") };
}

/** Describe the title we can see, without claiming which lookup produced it. */
export function hasQuestionTermInTitle(article: SupplementArticle): boolean {
  return !article.explicit && article.matched.some((term) => Boolean(term.trim()) && article.title.includes(term));
}
