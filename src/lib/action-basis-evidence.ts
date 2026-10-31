import { researchResult } from "@/lib/law-research-parse";
import type { AnnexEvidence } from "@/lib/research-annex";
import type { ResearchEnrichment } from "@/lib/research-relevance";
import { isLawName, questionSubjectTerms, questionTerms } from "@/lib/research-relevance";
import { compactLaw, sameLawFamily } from "@/lib/research-scope";
import { capForFailure, detailArticles, hasAvailableContent, hasFailedSection, hasNoUsableSection, verifiedDecisionCaseNumbers, type TaskEvidence, type TaskEvidenceBodyRef, type TaskEvidenceStatus } from "@/lib/task-evidence";

/**
 * 처분·허가 근거: each kind the question actually asks for is checked
 * against source bodies, never against a title or a list alone.
 * Relevance is a separate gate from retrieval: a body counts only when it
 * concerns the question's legal act (actionTerms — e.g. "영업정지" or its
 * parts "영업" + "정지"), never because it merely names the question's law
 * (every subordinate article quotes 「식품위생법」) or shares a generic word
 * (기준/대상/경우). When the question names a law, only that law family's
 * articles count. Sources are then tiered:
 * - direct: the act's authority (처분권자 + 할 수 있다/명할 수 있다) or the
 *   act's conditions in the named law family — the only refs that confirm;
 * - supporting: related but a different institution, e.g. a substitute fine
 *   (과징금 갈음) when the question did not ask about a fine — shown apart,
 *   never confirming;
 * - unverified: everything else — retrieved, kept in the source text, never
 *   shown as evidence.
 * Kinds:
 * - 처분·허가 근거 (reader title by the act: 처분 근거 / 허가 근거 /
 *   과징금 부과 근거 …): a direct authority body.
 * - 적용 요건 (two tiers): a direct body with a requirement word is
 *   requirement-related text only (`viewed`); confirmation (`found`) also
 *   requires a conditional, duty, or criterion construction in the same body.
 *   Concrete case facts are never judged — the UI caution keeps that.
 * - 세부 기준(별표): asked → an annex section with entries (list ≠ original:
 *   an all-found result demotes to `partial` without a verified original of a
 *   counted law). Not asked → an optional "세부 처분 기준" item when the server
 *   verified an annex the act's own provision cites; it never sets the verdict.
 * - 불복 자료: a listed decision whose substance was fetched.
 * Required kinds all verified → `matched`, some → `partial`, material
 * retrieved but nothing verified → `viewed`. Optional kinds are shown only.
 */
const AUTHORITY = /처분|허가|인가|할 수 있다|하여야 한다|명령/u;
const REQUIREMENT = /요건|기준|대상|예외|해당|경우/u;
/** A requirement word plus a conditional, duty, or criterion construction
 * in the same body: the actual condition or standard, not the word alone. */
const REQUIREMENT_CONFIRMED = /하면|할 수 있다|하여야 한다|해야 한다|인 경우|경우에는|기준은|요건은|해당하는|필요하다|충족/u;
/** A substitute-fine (과징금) provision: a fine in place of the disposition,
 * never the disposition authority itself — unless the question asks about it. */
const SUBSTITUTE_FINE = /과징금/u;
/** Legal-act heads a question term can end with. */
const ACT_CORE = /(영업정지|정지|취소|철회|폐쇄|명령|처분|허가|인가|등록|신고|승인|면허|지정|과징금|과태료|해고|부과)$/u;
const DISPOSITION_CORE = /^(영업정지|정지|취소|철회|폐쇄|명령|처분)$/u;
const PERMISSION_CORE = /^(허가|인가|등록|신고|승인|면허|지정)$/u;

/** One legal act the question asks about: the whole term and its parts. */
export interface ActionTerm {
  term: string;
  /** Object part before the act ("영업" of "영업정지"); may be empty. */
  head: string;
  /** The act itself ("정지"). */
  core: string;
}

/**
 * The question's legal acts: subject terms that are not law names and end in
 * an act head. A stem cut by tokenization ("영업허" of "영업허가") is
 * completed. Law names and generic words never become acts.
 */
export function actionTerms(query: string): ActionTerm[] {
  const terms: ActionTerm[] = [];
  for (const raw of questionSubjectTerms(query).filter((term) => !isLawName(term))) {
    const term = raw.endsWith("허") ? `${raw}가` : raw;
    const core = ACT_CORE.exec(term)?.[1];
    if (!core) continue;
    const act = core === "영업정지" ? { term, head: "영업", core: "정지" } : { term, head: term.slice(0, term.length - core.length), core };
    if (!terms.some((item) => item.term === act.term)) terms.push(act);
  }
  return terms;
}

/** A text concerns the act when it names the act, or its object and act
 * parts in one short phrase ("영업의 전부 또는 일부를 정지" for 영업정지) —
 * not two words anywhere in a long body ("영업자 … 품목 제조정지"). */
export function concernsAction(text: string, acts: readonly ActionTerm[]): boolean {
  return acts.some((act) => text.includes(act.term)
    || (act.head.length > 0 && new RegExp(`${escapeRegExp(act.head)}[^.。\\n]{0,16}${escapeRegExp(act.core)}`, "u").test(text)));
}
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Whether the question asks about a substitute fine itself. */
export function asksSubstituteFine(query: string): boolean {
  return /과징금|갈음/u.test(query);
}

/** Whether an act is a disposition (정지·취소·폐쇄·명령·처분) rather than a permission. */
export function isDispositionAct(acts: readonly ActionTerm[]): boolean {
  return acts.some((act) => DISPOSITION_CORE.test(act.core) || act.core === "영업정지");
}

/** Reader title for the basis kind, from the question's own act. */
export function actionBasisTitle(query: string): string {
  const acts = actionTerms(query);
  if (acts.some((act) => act.core === "과징금")) return "과징금 부과 근거";
  if (acts.some((act) => act.core === "과태료")) return "과태료 부과 근거";
  if (isDispositionAct(acts)) return "처분 근거";
  if (acts.some((act) => PERMISSION_CORE.test(act.core))) return "허가 근거";
  if (acts.some((act) => act.core === "해고")) return "법적 근거";
  return "처분·허가 근거";
}

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
  const acts = actionTerms(query);
  const document = researchResult(text);
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
  const inScope = (law: string | undefined) => !named.length || (law !== undefined && named.some((namedLaw) => lawMatches(law, namedLaw)));
  const bodies: BodyRef[] = [
    ...document.sections.filter((section) => section.status === "available").flatMap((section) => section.articles ?? [])
      .map((article) => ({ law: article.law, jo: article.jo, title: article.title ?? "", body: article.excerpt })),
    ...detailArticles(text).map((article) => ({ law: article.law, jo: article.jo, title: article.title, body: article.body })),
    ...(enrichment?.supplement?.articles ?? []).map((article) => ({ law: article.law, jo: article.jo, title: article.title, body: article.excerpt })),
  ].filter((ref) => ref.body.trim());
  // Relevance gate: the act's own wording in the named law family. A law-name
  // quote or a generic word never makes a body relevant.
  // Without a recognizable act, the question's non-law subject terms stand in
  // (whole-word only); a law name alone never makes a body relevant.
  const gate = acts.length ? acts : (() => {
    const subjects = questionSubjectTerms(query).filter((term) => !isLawName(term));
    return (subjects.length ? subjects : questionTerms(query).filter((term) => !isLawName(term))).map((term) => ({ term, head: "", core: term }));
  })();
  const actBodies = (pattern: RegExp) => bodies.filter((ref) => inScope(ref.law) && concernsAction(`${ref.title}\n${ref.body}`, gate) && pattern.test(ref.body));
  const annexEntries = document.sections.filter((section) => section.status === "available")
    .flatMap((section) => section.annex?.entries ?? [])
    .filter((entry) => inScope(entry.law));
  const annexCount = annexEntries.length;
  const annexLaws = [...new Set(annexEntries.map((entry) => entry.law).filter((law): law is string => Boolean(law)))];
  const decisions = document.sections.filter((section) => section.status === "available")
    .flatMap((section) => section.decisions?.entries ?? []);
  const verified = verifiedDecisionCaseNumbers(text);
  const appealVerified = decisions.some((entry) => entry.caseNumber && verified.has(entry.caseNumber));
  const asksFine = asksSubstituteFine(query);
  const disposition = isDispositionAct(acts);
  const actWords = acts.map((act) => act.term).join(" ");
  // Supporting, not direct: a provision whose own role is a different
  // institution or an ancillary step for the asked act. Judged from the
  // provision's title (its declared subject) and the question's own act, so
  // a reduction, a revocation, a fee or an application step never stands in
  // for the act's authority or conditions. The asked act itself is exempt
  // (a question about 과징금 or 신고 keeps those provisions direct).
  const tier = (ref: BodyRef): BodyRef => {
    const whole = `${ref.title}\n${ref.body}`;
    const note = !asksFine && SUBSTITUTE_FINE.test(whole) ? "보충 근거 · 과징금 갈음 규정 — 직접 처분 근거와 구분"
      : asksFine && !SUBSTITUTE_FINE.test(whole) ? "보충 근거 · 과징금의 전제가 되는 처분 규정"
      : /감면|감경|면제/u.test(ref.title) && !/감면|감경|면제/u.test(actWords) ? "보충 근거 · 처분 감면·예외 규정"
      : acts.length > 0 && !disposition && /취소|정지|폐쇄|철회/u.test(ref.title) ? "보충 근거 · 허가취소 등 다른 처분 규정"
      : /수수료|신청|신고|서식|절차|보고/u.test(ref.title) && !/수수료|신청|신고|서식|절차|보고/u.test(actWords) ? "보충 근거 · 신청·신고·수수료 등 부수 절차 규정"
      : undefined;
    return note ? { ...ref, note } : ref;
  };
  const basisRefs = actBodies(AUTHORITY).map(tier);
  const authorityRefs = basisRefs.filter((ref) => !ref.note);
  const requirementMentioned = /요건|기준|조건|대상|예외/u.test(query) ? actBodies(REQUIREMENT).map(tier) : undefined;
  const requirementRefs = requirementMentioned?.filter((ref) => REQUIREMENT_CONFIRMED.test(ref.body));
  const directRequirementRefs = requirementRefs?.filter((ref) => !ref.note);
  // Direct refs first, supporting refs after them: one list, roles marked.
  const ordered = (refs: readonly BodyRef[]) => [...refs.filter((ref) => !ref.note), ...refs.filter((ref) => ref.note)];
  const basisTitle = actionBasisTitle(query);
  const items: TaskEvidence["items"] = [
    { label: "처분·허가 근거", ...(basisTitle !== "처분·허가 근거" ? { title: basisTitle } : {}),
      status: authorityRefs.length ? "found" : basisRefs.length || bodies.length ? "viewed" : "none",
      basisRefs: structuredRefs(ordered(basisRefs)),
      ...(authorityRefs.length === 0 && basisRefs.length ? { detail: "과징금 갈음 규정만 확인 — 직접 처분 근거 추가 확인 필요" }
        : authorityRefs.length === 0 && bodies.length ? { detail: "질문한 법적 행위의 직접 근거 문언 미확인 — 조회된 조문은 관련성이 확인되지 않아 근거로 표시하지 않습니다." } : {}) },
  ];
  if (requirementRefs !== undefined && directRequirementRefs !== undefined) {
    const mentionOnly = (requirementMentioned ?? []).some((ref) => !ref.note) && directRequirementRefs.length === 0;
    items.push({ label: "적용 요건", status: directRequirementRefs.length ? "found" : bodies.length ? "viewed" : "none",
      requirementRefs: structuredRefs(ordered(requirementRefs)),
      ...(mentionOnly ? { detail: "요건 관련 문언 확인 — 실제 요건·기준은 원문에서 대조 필요" }
        : directRequirementRefs.length === 0 && bodies.length ? { detail: "질문한 법적 행위의 요건 문언 미확인" } : {}) });
  }
  if (/별표|기준표|과태료|벌칙/u.test(query)) {
    items.push({ label: "세부 기준(별표)", status: annexCount ? "found" : "none",
      ...(annexCount ? { detail: annexLaws.length === 1 ? `${annexLaws[0]} 별표 항목 ${annexCount}건` : `별표 항목 ${annexCount}건` } : {}) });
  } else {
    // Not asked: a verified annex the act's own provision cites is shown as
    // the detailed disposition criteria, never counted in the verdict.
    const criteria = (annexes ?? []).filter((annex) => annex.status === "verified" && annex.relevance === "direct" && inScope(annex.law));
    if (criteria.length) items.push({ label: "세부 기준(별표)", title: isDispositionAct(acts) ? "세부 처분 기준" : "세부 기준", optional: true, status: "found",
      detail: criteria.map((annex) => `${annex.law} ${annex.label}${annex.title ? `(${annex.title})` : ""}`).join(" · ") });
  }
  if (/불복|심판|소송|이의|구제/u.test(query)) {
    items.push({ label: "불복 자료", status: appealVerified ? "found" : decisions.length ? "viewed" : "none" });
  }
  const required = items.filter((item) => !item.optional);
  const found = required.filter((item) => item.status === "found").length;
  let base: TaskEvidenceStatus = found === required.length ? "matched" : found > 0 ? "partial" : hasAvailableContent(text) ? "viewed" : "none";
  // A list verifies the annex kind, never an original: without a verified
  // annex original of a counted entry's law, an otherwise complete result
  // is partial, not matched. Entries without any law cannot be attributed
  // to a verified original, so they never satisfy this gate. Callers that
  // do not pass annexes keep the previous behaviour.
  const annexKindFound = required.some((item) => item.label === "세부 기준(별표)" && item.status === "found");
  const annexVerified = annexes?.some((annex) => annex.status === "verified"
    && annexLaws.some((law) => sameLawFamily(annex.law, law))) ?? false;
  if (annexes !== undefined && annexKindFound && !annexVerified && base === "matched") base = "partial";
  return { status: capForFailure(base, hasFailedSection(text)), items };
}
