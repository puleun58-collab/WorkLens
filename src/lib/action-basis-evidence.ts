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
 *   When the question does not ask about a substitute fine (과징금), a
 *   substitute-fine provision alone never confirms the direct disposition
 *   basis: it is shown, marked as such, and the kind stays `viewed`.
 * - 적용 요건 (two tiers): a body that merely mentions a requirement word
 *   (요건/기준/대상/예외/해당/경우) is requirement-related text only
 *   (`viewed`). Confirmation (`found`) additionally requires a
 *   conditional, duty, or criterion construction in the same body — the
 *   actual condition or standard, not the word alone. This confirms
 *   requirement-related text was retrieved and identified; it does not
 *   judge whether a concrete case meets the requirement — the UI caution
 *   keeps that distinction.
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
 * bare body count. Detail text never carries body counts: counts stay in
 * the internal aggregation, and the screen shows the provision list once.
 */
const AUTHORITY = /처분|허가|인가|할 수 있다|하여야 한다|명령/u;
const REQUIREMENT = /요건|기준|대상|예외|해당|경우/u;
/** A requirement word plus a conditional, duty, or criterion construction
 * in the same body: the actual condition or standard, not the word alone. */
const REQUIREMENT_CONFIRMED = /하면|할 수 있다|하여야 한다|해야 한다|인 경우|경우에는|기준은|요건은|해당하는|필요하다|충족/u;
/** A substitute-fine (과징금) provision: a fine in place of the disposition,
 * never the disposition authority itself — unless the question asks about it. */
const SUBSTITUTE_FINE = /과징금/u;

interface BodyRef {
  law: string;
  jo: string;
  title: string;
  body: string;
  note?: string;
}

/** Keep distinct retrieved excerpts; unique provision counts are separate. */
function structuredRefs(refs: readonly BodyRef[]): TaskEvidenceBodyRef[] {
  return [...new Map(refs.map((ref) => [JSON.stringify([ref.law, ref.jo, ref.title, ref.body]),
    { law: ref.law, jo: ref.jo, title: ref.title, excerpt: ref.body, ...(ref.note ? { note: ref.note } : {}) }] as const)).values()];
}

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
  const asksFine = /과징금|갈음/u.test(query);
  const basisRefs = subjectBodies(AUTHORITY).map((ref) => (!asksFine && SUBSTITUTE_FINE.test(`${ref.title}\n${ref.body}`)
    ? { ...ref, note: "과징금 갈음 규정 — 직접 처분 근거와 구분" } : ref));
  const authorityRefs = basisRefs.filter((ref) => !ref.note);
  const requirementMentioned = /요건|기준|조건|대상|예외/u.test(query) ? subjectBodies(REQUIREMENT) : undefined;
  const requirementRefs = requirementMentioned?.filter((ref) => REQUIREMENT_CONFIRMED.test(ref.body));
  const items: TaskEvidence["items"] = [
    { label: "처분·허가 근거",
      status: authorityRefs.length ? "found" : basisRefs.length || bodies.length ? "viewed" : "none",
      basisRefs: structuredRefs(basisRefs),
      ...(authorityRefs.length === 0 && basisRefs.length ? { detail: "과징금 갈음 규정만 확인 — 직접 처분 근거 추가 확인 필요" }
        : authorityRefs.length === 0 && bodies.length ? { detail: "직접 처분 근거 문언 미확인" } : {}) },
  ];
  if (requirementRefs !== undefined) {
    const mentionOnly = (requirementMentioned ?? []).length > 0 && requirementRefs.length === 0;
    items.push({ label: "적용 요건", status: requirementRefs.length ? "found" : bodies.length ? "viewed" : "none",
      requirementRefs: structuredRefs(requirementRefs),
      ...(mentionOnly ? { detail: "요건 관련 문언 확인 — 실제 요건·기준은 원문에서 대조 필요" } : {}) });
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
