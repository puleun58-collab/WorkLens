import { researchResult } from "@/lib/law-research-parse";
import type { AnnexEvidence } from "@/lib/research-annex";
import type { ResearchEnrichment } from "@/lib/research-relevance";
import { isLawName, questionSubjectTerms, questionTerms } from "@/lib/research-relevance";
import { compactLaw, sameLawFamily } from "@/lib/research-scope";
import { capForFailure, detailArticles, hasAvailableContent, hasFailedSection, hasNoUsableSection, verifiedDecisionCaseNumbers, type TaskEvidence, type TaskEvidenceBodyRef, type TaskEvidenceStatus } from "@/lib/task-evidence";

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
 *   When the question names a law, only that law family's entries count:
 *   another law's table is not this question's criteria. A list verifies
 *   the kind, never an original: when the caller passes the annexes the
 *   server retrieved, an all-found result still demotes to `partial`
 *   unless a verified annex original matches a counted entry's law.
 * - 불복 자료: a listed decision whose substance was fetched into a detail
 *   section (same rule as dispute evidence).
 * Kinds are asked only when the question names them (근거 is always asked);
 * all asked kinds verified → `matched`, some → `partial`, material
 * retrieved but nothing verified → `viewed`.
 * Every found law kind carries its supporting articles (law + article) in
 * its detail, so the verdict links to the articles behind it instead of a
 * bare body count.
 */
const AUTHORITY = /처분|허가|인가|할 수 있다|하여야 한다|명령/u;
const REQUIREMENT = /요건|기준|대상|예외|해당|경우/u;

interface BodyRef {
  law: string;
  jo: string;
  title: string;
  body: string;
}

/** Keep distinct retrieved excerpts; unique provision counts are separate. */
function structuredRefs(refs: readonly BodyRef[]): TaskEvidenceBodyRef[] {
  return [...new Map(refs.map((ref) => [JSON.stringify([ref.law, ref.jo, ref.title, ref.body]),
    { law: ref.law, jo: ref.jo, title: ref.title, excerpt: ref.body }] as const)).values()];
}

const refsText = (refs: readonly BodyRef[]): string => {
  const shown = [...new Map(refs.map((ref) => [`${ref.law}\0${ref.jo}`, ref] as const)).values()]
    .slice(0, 3).map((ref) => `${ref.law} ${ref.jo}`);
  const hidden = new Set(refs.map((ref) => `${ref.law}\0${ref.jo}`)).size - shown.length;
  return [...shown, ...(hidden > 0 ? [`외 ${hidden}건`] : [])].join(" · ");
};

export function assessActionBasis(query: string, text: string, enrichment?: ResearchEnrichment, annexes?: readonly AnnexEvidence[]): TaskEvidence {
  if (hasNoUsableSection(text)) {
    return { status: hasFailedSection(text) ? "failed" : "none", items: [] };
  }
  const subjects = questionSubjectTerms(query);
  const terms = subjects.length ? subjects : questionTerms(query);
  const document = researchResult(text);
  const bodies: BodyRef[] = [
    ...document.sections.filter((section) => section.status === "available").flatMap((section) => section.articles ?? [])
      .map((article) => ({ law: article.law, jo: article.jo, title: article.title ?? "", body: article.excerpt })),
    ...detailArticles(text).map((article) => ({ law: article.law, jo: article.jo, title: article.title, body: article.body })),
    ...(enrichment?.supplement?.articles ?? []).map((article) => ({ law: article.law, jo: article.jo, title: article.title, body: article.excerpt })),
  ].filter((ref) => ref.body.trim());
  const subjectBodies = (pattern: RegExp) => bodies.filter((ref) => terms.some((term) => ref.body.includes(term)) && pattern.test(ref.body));
  // The question's named laws, as tokens. A spaced official name tokenizes
  // to a fragment ("개인정보 보호법" → "보호법"), so a candidate law also
  // matches by suffix when the question itself supplies the missing prefix
  // ("개인정보") — the same rule the full-research evidence uses. A bare
  // suffix alone never admits a different regime.
  const named = questionTerms(query).filter(isLawName).filter((law) => !["시행령", "시행규칙", "법령"].includes(law));
  const questionWords = compactLaw(query);
  const lawMatches = (law: string, namedLaw: string) => {
    if (sameLawFamily(law, namedLaw)) return true;
    const cl = compactLaw(law), cn = compactLaw(namedLaw);
    if (!cl.endsWith(cn) || cl === cn) return false;
    const prefix = cl.slice(0, cl.length - cn.length);
    return prefix.length > 0 && questionWords.includes(prefix);
  };
  const annexEntries = document.sections.filter((section) => section.status === "available")
    .flatMap((section) => section.annex?.entries ?? [])
    .filter((entry) => {
      const law = entry.law;
      return !named.length || (law !== undefined && named.some((namedLaw) => lawMatches(law, namedLaw)));
    });
  const annexCount = annexEntries.length;
  const annexLaws = [...new Set(annexEntries.map((entry) => entry.law).filter((law): law is string => Boolean(law)))];
  const decisions = document.sections.filter((section) => section.status === "available")
    .flatMap((section) => section.decisions?.entries ?? []);
  const verified = verifiedDecisionCaseNumbers(text);
  const appealVerified = decisions.some((entry) => entry.caseNumber && verified.has(entry.caseNumber));
  const basisRefs = subjectBodies(AUTHORITY);
  const requirementRefs = /요건|기준|조건|대상|예외/u.test(query) ? subjectBodies(REQUIREMENT) : undefined;
  const items: TaskEvidence["items"] = [
    { label: "처분·허가 근거", status: basisRefs.length ? "found" : bodies.length ? "viewed" : "none", basisRefs: structuredRefs(basisRefs),
      ...(bodies.length ? { detail: basisRefs.length ? `${refsText(basisRefs)} · 조문 본문 ${bodies.length}건` : `조문 본문 ${bodies.length}건` } : {}) },
  ];
  if (requirementRefs !== undefined) {
    items.push({ label: "적용 요건", status: requirementRefs.length ? "found" : bodies.length ? "viewed" : "none", requirementRefs: structuredRefs(requirementRefs),
      ...(requirementRefs.length ? { detail: refsText(requirementRefs) } : {}) });
  }
  if (/별표|기준표|과태료|벌칙/u.test(query)) {
    items.push({ label: "세부 기준(별표)", status: annexCount ? "found" : "none",
      ...(annexCount ? { detail: annexLaws.length === 1 ? `${annexLaws[0]} 별표 항목 ${annexCount}건` : `별표 항목 ${annexCount}건` } : {}) });
  }
  if (/불복|심판|소송|이의|구제/u.test(query)) {
    items.push({ label: "불복 자료", status: appealVerified ? "found" : decisions.length ? "viewed" : "none" });
  }
  const found = items.filter((item) => item.status === "found").length;
  let base: TaskEvidenceStatus = found === items.length ? "matched" : found > 0 ? "partial" : hasAvailableContent(text) ? "viewed" : "none";
  // A list verifies the annex kind, never an original: without a verified
  // annex original of a counted entry's law, an otherwise complete result
  // is partial, not matched. Entries without any law cannot be attributed
  // to a verified original, so they never satisfy this gate. Callers that
  // do not pass annexes keep the previous behaviour.
  const annexKindFound = items.some((item) => item.label === "세부 기준(별표)" && item.status === "found");
  const annexVerified = annexes?.some((annex) => annex.status === "verified"
    && annexLaws.some((law) => sameLawFamily(annex.law, law))) ?? false;
  if (annexes !== undefined && annexKindFound && !annexVerified && base === "matched") base = "partial";
  return { status: capForFailure(base, hasFailedSection(text)), items };
}
