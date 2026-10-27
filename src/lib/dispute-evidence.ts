import { researchResult } from "@/lib/law-research-parse";
import { questionSubjectTerms, questionTerms } from "@/lib/research-relevance";
import { capForFailure, hasAvailableContent, hasFailedSection, hasNoUsableSection, verifiedDecisionCaseNumbers, type TaskEvidence } from "@/lib/task-evidence";

/**
 * 분쟁·불복 자료: search success and relevance are kept apart, and a title
 * or case number alone never adopts a decision.
 * - 판례·결정례·재결례 verified: the decision appears in a search list AND
 *   its case number appears in a detail section carrying 판시사항/판결요지/
 *   결정요지/재결요지, AND the substance after that marker (never the
 *   detail section's repeated title line) contains a subject term from
 *   the question itself. Detail content about another case (e.g. the MCP's
 *   top-2 detail fetch returning an off-topic case) does not verify this
 *   question.
 * - 법령 verified: a parsed law article whose excerpt names a subject term.
 * Which kinds a question asks is read from the question: 법령/조문/근거
 * asks for statutes, 판례/결정/재결/소송/심판/구제 asks for decisions; a
 * question naming neither is judged on both (the type's own scope). All
 * asked kinds verified → `matched`; some → `partial`; lists retrieved but
 * nothing verified → `viewed`.
 */
const STATUTE_ASKED = /법령|조문|근거|적용/u;
const DECISION_ASKED = /판례|결정|재결|소송|심판|구제|청구/u;

export function assessDispute(query: string, text: string): TaskEvidence {
  if (hasNoUsableSection(text)) {
    return { status: hasFailedSection(text) ? "failed" : "none", items: [] };
  }
  const subjects = questionSubjectTerms(query);
  const terms = subjects.length ? subjects : questionTerms(query);
  const document = researchResult(text);
  const decisions = document.sections.filter((section) => section.status === "available")
    .flatMap((section) => section.decisions?.entries ?? []);
  const verified = verifiedDecisionCaseNumbers(text);
  // Substance only: everything from the first 판시사항/판결요지/결정요지/
  // 재결요지 marker onward. The detail section repeats the decision title
  // above that marker, and a title match is exactly what must not verify.
  const substance = document.sections.filter((section) => section.kind === "detail")
    .map((section) => {
      const body = section.lines.join("\n");
      const at = body.search(/판시사항|판결요지|결정요지|재결요지/u);
      return at < 0 ? "" : body.slice(at);
    }).join("\n");
  const decisionVerified = decisions.some((entry) => entry.caseNumber && verified.has(entry.caseNumber)
    && terms.some((term) => substance.includes(term)));
  const decisionListed = decisions.length > 0;
  const articles = document.sections.filter((section) => section.status === "available")
    .flatMap((section) => section.articles ?? []);
  const statuteVerified = articles.some((article) => article.excerpt.trim()
    && terms.some((term) => `${article.law} ${article.title ?? ""} ${article.excerpt}`.includes(term)));
  const askedStatute = STATUTE_ASKED.test(query) || !DECISION_ASKED.test(query);
  const askedDecision = DECISION_ASKED.test(query) || !STATUTE_ASKED.test(query);
  const items: TaskEvidence["items"] = [];
  if (askedStatute) {
    items.push({ label: "관련 법령", status: statuteVerified ? "found" : articles.length ? "viewed" : "none",
      ...(articles.length ? { detail: `조문 ${articles.length}건` } : {}) });
  }
  if (askedDecision) {
    items.push({ label: "판례·결정례·재결례", status: decisionVerified ? "found" : decisionListed ? "viewed" : "none",
      ...(decisionListed ? { detail: `검색 ${decisions.length}건${verified.size ? ` · 상세 확인 ${verified.size}건` : ""}` } : {}) });
  }
  const asked = items.length;
  const found = items.filter((item) => item.status === "found").length;
  const base = found === asked && asked > 0 ? "matched" : found > 0 ? "partial" : hasAvailableContent(text) ? "viewed" : "none";
  return { status: capForFailure(base, hasFailedSection(text)), items };
}
