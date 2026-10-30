import type { SupplementArticle } from "@/lib/research-relevance";

/** Presentation only: never merge different versions or different source excerpts. */
export function articleDisplayKey(article: { law: string; jo: string; excerpt: string; effective?: string }): string {
  return JSON.stringify([article.law, article.jo, article.effective ?? "", article.excerpt.trim()]);
}

/** Describe the title we can see, without claiming which lookup produced it. */
export function hasQuestionTermInTitle(article: SupplementArticle): boolean {
  return !article.explicit && article.matched.some((term) => Boolean(term.trim()) && article.title.includes(term));
}
