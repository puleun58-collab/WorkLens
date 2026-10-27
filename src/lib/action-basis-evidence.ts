import { researchResult } from "@/lib/law-research-parse";
import type { ResearchEnrichment } from "@/lib/research-relevance";
import { questionSubjectTerms, questionTerms } from "@/lib/research-relevance";
import { capForFailure, detailArticles, hasAvailableContent, hasFailedSection, hasNoUsableSection, verifiedDecisionCaseNumbers, type TaskEvidence } from "@/lib/task-evidence";

/**
 * 처분·허가 근거: each kind the question actually asks for is checked
 * against source bodies, never against a title or a list alone.
 * - 처분·허가 근거: a parsed article, a detailed-format article, or an
 *   enrichment supplement article whose body names a question subject term
 *   and carries an authority phrase for the disposition/permission.
 * - 적용 요건: a body naming a subject term and a requirement word
 *   (요건/기준/대상/예외/해당/경우). This confirms requirement-related text
 *   was retrieved; it does not judge whether a concrete case meets the
 *   requirement — the UI caution keeps that distinction.
 * - 세부 기준(별표): an annex section with entries (a list alone never
 *   settles a duty, so it verifies only the "detailed criteria" kind).
 * - 불복 자료: a listed decision whose substance was fetched into a detail
 *   section (same rule as dispute evidence).
 * Kinds are asked only when the question names them (근거 is always asked);
 * all asked kinds verified → `matched`, some → `partial`, material
 * retrieved but nothing verified → `viewed`.
 */
const AUTHORITY = /처분|허가|인가|할 수 있다|하여야 한다|명령/u;
const REQUIREMENT = /요건|기준|대상|예외|해당|경우/u;

export function assessActionBasis(query: string, text: string, enrichment?: ResearchEnrichment): TaskEvidence {
  if (hasNoUsableSection(text)) {
    return { status: hasFailedSection(text) ? "failed" : "none", items: [] };
  }
  const subjects = questionSubjectTerms(query);
  const terms = subjects.length ? subjects : questionTerms(query);
  const document = researchResult(text);
  const bodies = [
    ...document.sections.filter((section) => section.status === "available").flatMap((section) => section.articles ?? []).map((article) => article.excerpt),
    ...detailArticles(text).map((article) => article.body),
    ...(enrichment?.supplement?.articles ?? []).map((article) => article.excerpt),
  ].filter((body) => body.trim());
  const subjectBody = (pattern: RegExp) => bodies.some((body) => terms.some((term) => body.includes(term)) && pattern.test(body));
  const annexEntries = document.sections.filter((section) => section.status === "available")
    .reduce((count, section) => count + (section.annex?.entries.length ?? 0), 0);
  const decisions = document.sections.filter((section) => section.status === "available")
    .flatMap((section) => section.decisions?.entries ?? []);
  const verified = verifiedDecisionCaseNumbers(text);
  const appealVerified = decisions.some((entry) => entry.caseNumber && verified.has(entry.caseNumber));
  const items: TaskEvidence["items"] = [
    { label: "처분·허가 근거", status: subjectBody(AUTHORITY) ? "found" : bodies.length ? "viewed" : "none",
      ...(bodies.length ? { detail: `조문 본문 ${bodies.length}건` } : {}) },
  ];
  if (/요건|기준|조건|대상|예외/u.test(query)) {
    items.push({ label: "적용 요건", status: subjectBody(REQUIREMENT) ? "found" : bodies.length ? "viewed" : "none" });
  }
  if (/별표|기준표|과태료|벌칙/u.test(query)) {
    items.push({ label: "세부 기준(별표)", status: annexEntries ? "found" : "none",
      ...(annexEntries ? { detail: `별표 항목 ${annexEntries}건` } : {}) });
  }
  if (/불복|심판|소송|이의|구제/u.test(query)) {
    items.push({ label: "불복 자료", status: appealVerified ? "found" : decisions.length ? "viewed" : "none" });
  }
  const found = items.filter((item) => item.status === "found").length;
  const base = found === items.length ? "matched" : found > 0 ? "partial" : hasAvailableContent(text) ? "viewed" : "none";
  return { status: capForFailure(base, hasFailedSection(text)), items };
}
