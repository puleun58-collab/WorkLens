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
/** Preserve the operative clause, not a title, update history or an entire
 * unrelated article. A numbered violation may only be named if the question
 * and the retrieved source both identify it. */
function operativeClause(body: string): string {
  const first = body.indexOf("①");
  const numbered = first >= 0 ? body.slice(first + 1).split(/[②-⑳]|<개정/u)[0] : body.split(/<개정/u)[0];
  const closing = /(?:할 수 있다|하여야 한다|해야 한다|정한다|된다)\./u.exec(numbered);
  const sentence = closing ? numbered.slice(0, closing.index + closing[0].length)
    : numbered.match(/^[\s\S]*?[.。](?=\s|$|다만|<)/u)?.[0] ?? numbered;
  return sentence.trim().slice(0, 1_400);
}

function legalAnswer(ref: BodyRef, query?: string): string {
  const clause = operativeClause(ref.body);
  const tokens = query ? questionSubjectTerms(query).filter((term) => term.length >= 3 && !isLawName(term)
    && !/정지|허가|처분|기준|요건|위반|영업|별표/u.test(term)) : [];
  const numbered = tokens.length ? [...ref.body.matchAll(/(?:^|[.\n])\s*(\d+)\.\s*([^.\n]{5,250})/gu)]
    .find((match) => tokens.some((term) => match[2].includes(term))) : undefined;
  return `${ref.law} ${ref.jo}${ref.title ? `(${ref.title})` : ""}: ${clause}${numbered ? ` 해당 위반 항목: ${numbered[1]}. ${numbered[2].trim()}` : ""}`;
}

/** The requirements and the authority may share a provision, but never the
 * same answer sentence. Only the provision's operative paragraph and its own
 * numbered subitems can establish a condition; a search preview cannot fill
 * in a missing violation or exception. */
function requirementAnswer(ref: BodyRef, query: string): string {
  const first = ref.body.indexOf("①");
  const paragraph = first < 0 ? ref.body : ref.body.slice(first + 1).split(/[②-⑳]/u)[0];
  const sentence = operativeClause(ref.body);
  const subject = /([^\s,。]{2,28}(?:자|인|업체))(?:가|는|이)\s+다음 각 호/u.exec(sentence)?.[1];
  const conditionEnd = /경우에는|경우에|해당하면|하려는 자는|하려는 사람은|하는 자는/u.exec(sentence);
  const condition = conditionEnd
    ? sentence.slice(subject ? sentence.lastIndexOf(subject) : 0, conditionEnd.index + conditionEnd[0].length).trim()
    : "";
  const violations = [...paragraph.matchAll(/(?:^|\n)\s*(\d+(?:의\d+)?)\.\s*([^\n]+)/gu)]
    .filter((match) => !/^삭제(?:\b|<|$)/u.test(match[2]) && !/…\s*$/u.test(match[2]));
  const cited = [...query.matchAll(/제\d+조(?:의\d+)?(?:제\d+항)?/gu)].map((match) => match[0]);
  const scoped = cited.length ? violations.filter((entry) => cited.some((jo) => entry[2].includes(jo))) : [];
  const examples = scoped.length === 1 ? scoped : violations.slice(0, 3);
  const heading = `${ref.law} ${ref.jo}${ref.title ? `(${ref.title})` : ""}`;
  const parts = [`${heading} 적용 대상·조건: ${condition || "원문에서 개별 요건을 분리하지 못했습니다"}.`];
  if (violations.length) {
    parts.push(`${first >= 0 ? "제1항 " : ""}원문에서 확인한 위반행위 ${violations.length}개 호(삭제 호 제외): ${examples.map((entry) => `${entry[1]}. ${entry[2].trim()}`).join(" · ")}${scoped.length !== 1 && violations.length > examples.length ? " · 나머지 호는 하단 조문 원문에서 확인" : ""}.`);
  }
  const exception = /다만,?[^\n]{10,400}?(?:할 수 있다|하여야 한다|해야 한다|된다)\./u.exec(paragraph);
  if (exception) parts.push(`예외 단서: ${exception[0]}`);
  else if (paragraph.includes("다만")) parts.push("예외 단서는 발췌가 중략되어 세부 요건 미확인.");
  return parts.join(" ");
}

/** An authority must confer the act being asked about; permission revocation
 * is not permission to grant, and a subordinate criteria rule is not the
 * enabling statute. */
function grantsAskedAct(ref: BodyRef, acts: readonly ActionTerm[]): boolean {
  if (!acts.length || !concernsAction(ref.body, acts)) return false;
  const permission = acts.some((act) => PERMISSION_CORE.test(act.core));
  if (permission) return /허가|인가|등록|신고|승인|면허|지정/u.test(ref.body)
    && /(?:허가|인가|등록|신고|승인|면허|지정)(?:를|을|할 수|하여야)/u.test(ref.body)
    && !/취소|철회|정지|폐쇄/u.test(ref.title);
  return /(?:정지|취소|폐쇄|명령|처분|과징금|과태료)/u.test(ref.body)
    && /(?:할 수 있다|명할 수 있다|하여야 한다|부과할 수 있다)/u.test(ref.body);
}

/** Identify a table row only when the industry and a distinctive violation
 * phrase in the question match one unique row in the official original. */
export function annexCriteriaForQuestion(query: string, original: string, authorities?: readonly string[]): string | undefined {
  const table = /\nⅡ\.\s*개별기준\s*\n/u.exec(original);
  if (!table) return undefined;
  const headings = [...original.slice(table.index + table[0].length).matchAll(/(?:^|\n)(\d+\.\s*([^\n]+?업(?:\s*등)?))\n/gu)]
    .map((match) => ({ name: match[2].replace(/\s*등$/u, ""), start: table.index + table[0].length + match.index, number: Number(match[1].split(".")[0]) }))
    .filter((heading, index, all) => index === 0 || all.slice(0, index).every((prior) => prior.number < heading.number));
  const chosen = headings.filter((heading) => compactLaw(query).includes(compactLaw(heading.name)));
  if (chosen.length !== 1) return undefined;
  const next = headings.find((heading) => heading.start > chosen[0].start);
  const section = original.slice(chosen[0].start, next?.start ?? original.length);
  const subjects = questionTerms(query).filter((term) => term.length >= 2 && !isLawName(term)
    && !/기준|처분|위반|영업|업종|법률|별표|[123]차/u.test(term)
    && !headings.some((heading) => compactLaw(heading.name).includes(compactLaw(term))));
  if (!subjects.length) return undefined;
  const tableRows = [...section.matchAll(/<tr>([\s\S]*?)<\/tr>/gu)].map((match) =>
    [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gu)].map((cell) => cell[1].replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim()));
  const matches: Array<{ cells: string[]; parent?: string; basis?: string }> = [];
  let parent: string | undefined;
  let basis: string | undefined;
  for (const cells of tableRows) {
    if (cells.length < 5) continue;
    if (cells[1]) basis = cells[1];
    if (cells[0] && cells.every((cell, index) => index === 0 || !cell)) parent = cells[0];
    const rowText = compactLaw(cells[0]);
    const contextText = compactLaw(`${parent ?? ""} ${cells[0]}`);
    if (subjects.some((term) => rowText.includes(compactLaw(term)))
      && subjects.every((term) => contextText.includes(compactLaw(term)))) {
      matches.push({ cells, parent, basis });
    }
  }
  if (matches.length !== 1) return undefined;
  const { cells: row, parent: rowParent, basis: rowBasis } = matches[0];
  if (authorities?.length && (!rowBasis || !authorities.some((jo) => rowBasis.includes(jo)))) return undefined;
  const count = /(\d+)차\s*위반/u.exec(query)?.[1];
  if (count && !["1", "2", "3"].includes(count)) return undefined;
  const applicable = count ? row[Number(count) + 1] : undefined;
  if (count && !applicable) return undefined;
  return `${chosen[0].name} · ${rowParent ? `${rowParent} · ` : ""}${row[0]} · ${rowBasis ? `근거 법령: ${rowBasis} · ` : ""}${count ? `${count}차 위반: ${applicable}` : `차수별 기준: 1차 ${row[2] || "미기재"} / 2차 ${row[3] || "미기재"} / 3차 ${row[4] || "미기재"}`}`;
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
  const actBodies = (pattern: RegExp) => bodies.filter((ref) => inScope(ref.law) && concernsAction(ref.body, gate) && pattern.test(ref.body));
  const annexEntries = document.sections.filter((section) => section.status === "available")
    .flatMap((section) => section.annex?.entries ?? [])
    .filter((entry) => inScope(entry.law));
  const decisions = document.sections.filter((section) => section.status === "available")
    .flatMap((section) => section.decisions?.entries ?? []);
  const verified = verifiedDecisionCaseNumbers(text);
  const appealVerified = decisions.some((entry) => entry.caseNumber && verified.has(entry.caseNumber));
  const asksFine = asksSubstituteFine(query);
  const disposition = isDispositionAct(acts);
  const asksPermission = !disposition && acts.some((act) => PERMISSION_CORE.test(act.core));
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
  const basisRefs = actBodies(AUTHORITY).map(tier).map((ref) =>
    !ref.note && !grantsAskedAct(ref, acts) ? { ...ref, note: "추가 조회 자료 · 질문한 법적 행위의 권한 문언 미확인" } : ref);
  const authorityRefs = basisRefs.filter((ref) => !ref.note && grantsAskedAct(ref, acts));
  const requirementMentioned = /요건|기준|조건|대상|예외|위반/u.test(query) ? actBodies(REQUIREMENT).map(tier) : undefined;
  const requirementRefs = requirementMentioned?.filter((ref) => REQUIREMENT_CONFIRMED.test(ref.body) && grantsAskedAct(ref, acts));
  const directRequirementRefs = requirementRefs?.filter((ref) => !ref.note);
  // Direct refs first, supporting refs after them: one list, roles marked.
  const ordered = (refs: readonly BodyRef[]) => [...refs.filter((ref) => !ref.note), ...refs.filter((ref) => ref.note)];
  const basisTitle = actionBasisTitle(query);
  const items: TaskEvidence["items"] = [
    { label: "처분·허가 근거", ...(basisTitle !== "처분·허가 근거" ? { title: basisTitle } : {}),
      status: authorityRefs.length ? "found" : basisRefs.length || bodies.length ? "viewed" : "none",
      ...(authorityRefs[0] ? { answer: legalAnswer(authorityRefs[0], query) } : {}),
      uncertainty: authorityRefs.length
        ? asksPermission ? "법정 허가·등록 권한 확인은 신청인의 개별 요건 충족이나 허가·등록 확정이 아닙니다."
          : "법정 권한 확인은 개별 위반행위의 성립이나 실제 처분 확정이 아닙니다."
        : asksPermission ? "직접 권한 원문 미확보 — 조회 실패나 제목 일치만으로 허가·등록이 불가능하다고 단정할 수 없습니다."
          : "직접 근거 원문 미확보 — 조회 실패나 제목 일치만으로 근거가 없다고 단정할 수 없습니다.",
      basisRefs: structuredRefs(ordered(basisRefs)),
      ...(authorityRefs.length === 0 && basisRefs.length ? { detail: asksPermission
        ? "조회 조문은 허가·등록 직접 근거로 확인되지 않아 추가 원문 대조가 필요합니다."
        : "과징금 갈음 규정만 확인 — 직접 처분 근거 추가 확인 필요" }
        : authorityRefs.length === 0 && bodies.length ? { detail: "질문한 법적 행위의 직접 근거 문언 미확인 — 조회된 조문은 관련성이 확인되지 않아 근거로 표시하지 않습니다." } : {}) },
  ];
  if (requirementRefs !== undefined && directRequirementRefs !== undefined) {
    const mentionOnly = (requirementMentioned ?? []).some((ref) => !ref.note) && directRequirementRefs.length === 0;
    // The chain preview and the separately fetched full article can describe
    // the same provision. Use the fullest adopted original for its numbered
    // conditions, while keeping the authority provision's scope unchanged.
    let requirementSource: BodyRef | undefined;
    for (const ref of directRequirementRefs) {
      if (authorityRefs[0] && (ref.law !== authorityRefs[0].law || ref.jo !== authorityRefs[0].jo)) continue;
      if (!requirementSource || ref.body.length > requirementSource.body.length) requirementSource = ref;
    }
    requirementSource ??= directRequirementRefs[0];
    items.push({ label: "적용 요건", status: directRequirementRefs.length ? "found" : bodies.length ? "viewed" : "none",
      ...(requirementSource ? { answer: requirementAnswer(requirementSource, query) } : {}),
      uncertainty: asksPermission
        ? "신청 대상 업종·자격·시설 등 필요한 사실과 예외를 대조해야 하며, 원문 확인만으로 허가·등록 가능 여부를 확정할 수 없습니다."
        : "위반행위와 영업 종류가 특정되지 않으면 개별 적용 여부를 판단할 수 없습니다. 업종·위반행위·예외 사실을 대조해야 합니다.",
      requirementRefs: structuredRefs(ordered(requirementRefs)),
      ...(mentionOnly ? { detail: "요건 관련 문언 확인 — 실제 요건·기준은 원문에서 대조 필요" }
        : directRequirementRefs.length === 0 && bodies.length ? { detail: "질문한 법적 행위의 요건 문언 미확인" } : {}) });
  }
  const asksAnnex = /별표|기준표|과태료|벌칙/u.test(query);
  const criteria = (annexes ?? []).filter((annex) => annex.relevance === "direct" && inScope(annex.law)
    && (!authorityRefs.length || authorityRefs.some((ref) => sameLawFamily(ref.law, annex.law))));
  const original = criteria.filter((annex) => annex.status === "verified" && Boolean(annex.text?.trim()));
  const listed = annexEntries.filter((entry) => criteria.some((annex) => sameLawFamily(annex.law, entry.law ?? "") && entry.title.includes(annex.label))
    || (asksAnnex && (acts.length === 0 || concernsAction(entry.title, acts) || compactLaw(query).includes(compactLaw(entry.title)))));
  if (asksAnnex || (disposition && (criteria.length > 0 || listed.length > 0))) {
    const selected = original[0] ?? criteria[0];
    const row = original[0]?.text ? annexCriteriaForQuestion(query, original[0].text, authorityRefs.map((ref) => ref.jo)) : undefined;
    items.push({ label: "세부 기준(별표)", title: disposition ? "세부 처분 기준" : "세부 기준", ...(asksAnnex ? {} : { optional: true }),
      status: original.length ? "found" : criteria.length || listed.length ? "viewed" : "none",
      ...(selected ? { answer: `${selected.law} ${selected.sourceArticle}가 인용한 ${selected.label}${selected.title ? `(${selected.title})` : ""} — ${selected.citation.trim()}${row ? ` 해당 표의 확인 행: ${row}` : ""}` } : {}),
      uncertainty: original.length ? row ? "표의 행·차수 원문 확인. 위반행위 성립·감경·가중 및 개별 사안 적용 여부는 확인되지 않았습니다." : "별표 원문 확보. 위반 유형·업종·차수 또는 유일한 해당 행을 특정하지 못해 개별 기준은 미확인입니다." : "별표 원문 미확보 — 존재·목록 확인만으로 세부 처분 기준을 확인할 수 없습니다.",
      ...(listed.length ? { detail: `별표 목록 ${listed.length}건 · 원문 ${original.length ? "확보" : "미확보"}` } : {}) });
  }
  if (/불복|심판|소송|이의|구제/u.test(query)) {
    items.push({ label: "불복 자료", status: appealVerified ? "found" : decisions.length ? "viewed" : "none" });
  }
  const required = items.filter((item) => !item.optional);
  const found = required.filter((item) => item.status === "found").length;
  const base: TaskEvidenceStatus = found === required.length ? "matched" : found > 0 ? "partial" : hasAvailableContent(text) ? "viewed" : "none";
  return { status: capForFailure(base, hasFailedSection(text)), items };
}
