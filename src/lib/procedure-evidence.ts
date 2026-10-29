import type { ResearchDocument } from "@/lib/law-research-parse";
import type { AnnexEvidence } from "@/lib/research-annex";
import { sameLawFamily } from "@/lib/research-scope";

/**
 * Server-side, deterministic evidence assessment for the 절차·서식
 * (procedure_detail) task. No AI interpretation, no new lookup: it judges
 * only the MCP text the chain already returned, requirement by requirement.
 *
 * Status vocabulary (per requirement, then overall):
 * - `found`: an article body actually supports the requirement (title alone
 *   never counts, an annex list alone never counts as a filing duty).
 * - `viewed`: related material was retrieved (a matching title, an annex
 *   entry, or unparsed section text) but no supporting body was confirmed.
 * - `none`: searched, nothing related was found.
 * - `failed`: no material for the requirement and a section failed or timed
 *   out, so absence is unknown — never "no such law".
 *
 * Overall: all found → `matched`; some found → `partial`; no found but some
 * viewed → `viewed`; no material but a failure → `failed`; else `none`.
 * A would-be `matched` with any failed section is demoted to `partial`:
 * confirmed facts stay, but completeness is not claimed.
 */

export type ProcedureRequirementKind = "procedure" | "forms" | "cost" | "general";
export type ProcedureRequirementStatus = "found" | "viewed" | "none" | "failed";
export type ProcedureOverall = "matched" | "partial" | "viewed" | "none" | "failed";
export type ProcedureFormNature = "required" | "conditional" | "optional" | "unconfirmed";

export interface ProcedureArticleRef {
  law: string;
  jo: string;
  title?: string;
  /** Forms only: what the article body itself says about the filing duty. */
  nature?: ProcedureFormNature;
}

/** How far annex originals got. Without retrieved annexes every entry is
 *  `list-only` — a title in a list, never a retrieved form body or link.
 *  A complete list is still list-only; truncation and origin stage are
 *  separate facts and must not be conflated. When the caller passes the
 *  annexes the server retrieved, a requirement's stage rises to `identified`
 *  (an original was fetched but cut) or `verified` (a complete original was
 *  fetched) only for an annex of the requirement's own law — and, when the
 *  counted entries carry 별지 labels, only for the same-numbered form.
 *  List codes are internal index keys, never form numbers, so entries
 *  without a 별지 label match by law alone. */
export type AnnexOriginStage = "list-only" | "identified" | "linked" | "verified";

export interface ProcedureRequirementEvidence {
  label: string;
  kind: ProcedureRequirementKind;
  status: ProcedureRequirementStatus;
  /** Directly supporting articles; empty for viewed/none/failed. */
  articles: ProcedureArticleRef[];
  /** Title-only or otherwise related articles (viewed, never direct). */
  related?: ProcedureArticleRef[];
  /** Distinct matching annex entries (titles only — never direct evidence). */
  annexCount: number;
  annexTotal?: number;
  /** Origin stage of the annex entries above; `list-only` unless the caller
   *  passes retrieved annexes that verify one of them (see AnnexOriginStage). */
  annexOriginStage: AnnexOriginStage;
  /** Title-correspondence candidates for this requirement (additive display
   *  only): annex titles whose wording matches the requirement's subject.
   *  Separate from `annexCount` (law-name match) and never direct evidence. */
  annexRelatedCandidates: string[];
  /** No parsed article matched, but section text mentions the requirement. */
  unparsed?: true;
  /** Forms only: duty + original classification of the counted list entries
   *  plus duty-confirmed forms named by articles but absent from the list. */
  classifiedForms?: ClassifiedForm[];
  /** Forms only: counted entries whose original was retrieved and verified. */
  annexVerifiedCount?: number;
  /** Forms only: a form the query names directly whose full original is not held. */
  directFormOriginalMissing?: boolean;
}

export interface ProcedureEvidence {
  requirements: ProcedureRequirementEvidence[];
  overall: ProcedureOverall;
  /** A section failed/timed out or a requirement failed: completeness is open. */
  incomplete: boolean;
  /** An annex list was cut (entries < the stated total): originals not held. */
  annexTruncated: boolean;
  /** Overall annex origin stage: `verified` only when every requirement
   *  with counted entries is verified, `identified` when at least one
   *  counted requirement has a retrieved original, else `list-only`. */
  annexOriginStage: AnnexOriginStage;
  failedSections: number;
  /**
   * Deterministic procedure steps for the procedure requirements: phases in
   * canonical order, each with its body-supported articles and a body
   * excerpt. A phase with no supporting article is `missing` (shown as
   * "확인 필요", never invented). Empty when no procedure requirement has a
   * body-supported article at all.
   */
  steps: ProcedureStep[];
}

export type ProcedureStepPhase = "scope" | "period" | "filing" | "intake" | "review" | "decision";

export interface ProcedureStepArticle {
  law: string;
  jo: string;
  title?: string;
  /** First body sentence carrying the phase keyword, else the first sentence (≤140자). */
  excerpt?: string;
}

export interface ProcedureStep {
  phase: ProcedureStepPhase;
  label: string;
  articles: ProcedureStepArticle[];
  missing: boolean;
}

export type ClassifiedFormDuty = "required" | "conditional" | "reference";
export type ClassifiedFormOriginal = "verified" | "identified" | "missing";

export interface ClassifiedForm {
  /** Form name as named by a duty article, or the list entry title. */
  title: string;
  law?: string;
  formLabel?: string;
  /**
   * Duty from an article body that names the form: `required`/`conditional`
   * only when a required/conditional article names it. A list entry alone
   * never confers a duty (`reference`).
   */
  duty: ClassifiedFormDuty;
  /** Whether a retrieved annex original matches this form (title or 별지 label). */
  original: ClassifiedFormOriginal;
  /** Duty-confirming articles; empty for reference entries. */
  articles: ProcedureArticleRef[];
  /** The query itself names this form (청구서/신청서/보정서/취하서). */
  direct: boolean;
}

export interface ProcedureRequirement {
  label: string;
  kind: ProcedureRequirementKind;
}

const PROCEDURE_STEMS = ["절차", "진행", "방법", "방식", "단계", "접수", "처리"];
const FORMS_STEMS = ["서식", "서류", "신청서", "청구서", "첨부서류", "구비서류", "양식"];
const COST_STEMS = ["비용", "수수료", "부담금", "송달료"];
const KIND_STEMS = [...PROCEDURE_STEMS, ...FORMS_STEMS, ...COST_STEMS, "신청", "청구", "제출", "안내", "확인"];
const FRAME_WORDS = new Set(["알려줘", "알려주세요", "궁금해", "궁금해요", "대해", "대한", "관해", "관련", "기준", "경우", "때", "확인해", "줘", "주세요"]);
const PARTICLE = /(?:와|과|은|는|이|가|을|를|의|에|로|도|만)$/u;
/** Verb-tail fragments left after a kind stem is stripped ("제출해야" →
 * "해야"): they are predicate endings, never subjects. Without this, a
 * segment like "제출해야 할 청구서 서식" yields the nonsense subject
 * "해야" and labels such as "해야 청구서". */
const VERB_TAIL = new Set(["해야", "해야할", "하는", "된다", "되어", "되는", "한다", "할수", "있다", "없다", "이다", "입니다"]);

const compact = (value: string) => value.replace(/\s+/gu, "");

/** Subject stems of a phrase: words left after kind stems and particles are stripped. */
function subjectStems(text: string): string[] {
  const stems: string[] = [];
  for (const raw of text.split(/[\s,·]+/u)) {
    // A trailing sentence mark belongs to the sentence, not to the word:
    // without this, "알려줘." misses the "알려줘" frame word and becomes a
    // subject of its own.
    const word = raw.replace(/[.?!。？]+$/u, "");
    if (!word || FRAME_WORDS.has(word)) continue;
    let token = word.replace(PARTICLE, "");
    for (const stem of KIND_STEMS) token = token.split(stem).join("");
    if (VERB_TAIL.has(token)) continue;
    // A predicate or modifier ending (…한/할/된/될) never names the subject:
    // "필요한" in "필요한 서식" is a modifier, not what the form is about.
    // Two-letter nouns that happen to end in 한 (기한, 권한, 제한) are
    // protected by the length rule below.
    if (token.length >= 3 && /(?:한|할|된|될)$/u.test(token)) continue;
    token = token.replace(/^(?:법령|법률)$/u, "");
    if (token.length >= 2 && !stems.includes(token)) stems.push(token);
  }
  return stems;
}

function tokensWith(text: string, stems: readonly string[]): string[] {
  return text.split(/[\s,·]+/u).filter((token) => stems.some((stem) => token.includes(stem)));
}

/** Split a question on 와/과/및/그리고/콤마; a segment without a subject inherits the first segment's. */
export function identifyProcedureRequirements(query: string): ProcedureRequirement[] {
  const cleaned = query.trim().replace(/[?.!\uFF1F\u3002\s]+$/u, "");
  const tokens = cleaned.split(/\s+/u).flatMap((token) => token.split(/(?<=,)/u)).filter(Boolean);
  const segments: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const segment = current.join(" ").replace(/,\s*$/u, "").trim();
    if (segment) segments.push(segment);
    current = [];
  };
  for (const token of tokens) {
    if (/^(?:와|과|및|그리고|,)$/u.test(token)) { flush(); continue; }
    const connective = /^(.*?)(와|과|및|그리고)$/u.exec(token);
    if (connective && connective[1].length >= 2) { current.push(connective[1]); flush(); continue; }
    const comma = /^(.*?),$/u.exec(token);
    if (comma && comma[1]) { current.push(comma[1]); flush(); continue; }
    current.push(token);
  }
  flush();
  if (segments.length > 6) return [{ label: cleaned, kind: "general" }];
  const firstSubjects = segments.length ? subjectStems(segments[0]) : [];
  const requirements: ProcedureRequirement[] = [];
  for (const segment of segments) {
    const subjects = subjectStems(segment);
    const subjectPrefix = subjects.length ? "" : firstSubjects.length ? `${firstSubjects.join(" ")} ` : "";
    const labelled = `${subjectPrefix}${segment}`;
    const hasForms = FORMS_STEMS.some((stem) => segment.includes(stem));
    const hasCost = COST_STEMS.some((stem) => segment.includes(stem));
    const hasProcedure = PROCEDURE_STEMS.some((stem) => segment.includes(stem))
      || /신청|청구/u.test(segment);
    const kinds: ProcedureRequirementKind[] = [];
    if (hasProcedure) kinds.push("procedure");
    if (hasForms) kinds.push("forms");
    if (hasCost) kinds.push("cost");
    if (!kinds.length) {
      requirements.push({ label: labelled, kind: "general" });
      continue;
    }
    for (const kind of kinds) {
      const stems = kind === "procedure" ? [...PROCEDURE_STEMS, "신청", "청구"]
        : kind === "forms" ? FORMS_STEMS : COST_STEMS;
      // Phrase tokens keep their particles in the raw segment ("서식을");
      // a label must not ("행정심판 청구서 서식을" → "행정심판 청구서 서식").
      const phrase = tokensWith(segment, stems).map((token) => token.replace(PARTICLE, "")).filter(Boolean).join(" ");
      const subject = subjects.length ? subjects.join(" ") : firstSubjects.join(" ");
      const finalLabel = kinds.length > 1
        ? `${subject ? `${subject} ` : ""}${phrase || segment}`.trim()
        : labelled;
      if (!requirements.some((item) => item.kind === kind && item.label === finalLabel)) {
        requirements.push({ label: finalLabel, kind });
      }
    }
  }
  return requirements.length ? requirements : [{ label: cleaned, kind: "general" }];
}

interface ArticleCandidate {
  law: string;
  jo: string;
  title: string;
  body: string;
  truncated: boolean;
}

/** `[시행령] 행정심판법 시행령 제13조 (제목)` + body lines: the format the shared parser leaves as `other`. */
const DETAIL_LINE = /^\[(시행령|시행규칙|법률|대통령령|총리령|부령|규칙)\]\s*(.+?)\s+제(\d+)조(의\d+)?\s*\((.+)\)\s*$/u;
const TRUNCATION_LINE = /위임 내용 .*일부만 표시|외 \d+개 .*\(생략\)/u;

function extractDetailArticles(text: string): ArticleCandidate[] {
  const lines = text.split("\n");
  const found = new Map<string, ArticleCandidate>();
  for (let i = 0; i < lines.length; i++) {
    const match = DETAIL_LINE.exec(lines[i].trim());
    if (!match) continue;
    const law = match[2].trim();
    const jo = `제${match[3]}조${match[4] ?? ""}`;
    const title = match[5].trim();
    const bodyLines: string[] = [];
    let truncated = false;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim() || line.startsWith("▶") || line.startsWith("═══") || line.trim() === "---"
        || DETAIL_LINE.test(line.trim()) || /^\s*\[/u.test(line) && !/^\s*①/u.test(line)) break;
      if (TRUNCATION_LINE.test(line)) { truncated = true; continue; }
      bodyLines.push(line.trim());
    }
    const key = `${law}\0${jo}`;
    if (!found.has(key)) found.set(key, { law, jo, title, body: bodyLines.join(" "), truncated });
  }
  return [...found.values()];
}

function chainLaws(text: string): string[] {
  const laws: string[] = [];
  for (const match of text.matchAll(/^\s*법령명:\s*(.+?)\s*$/gmu)) {
    const law = match[1].trim();
    if (law && !laws.includes(law)) laws.push(law);
  }
  const header = /^\s*법령:\s*([^|(]+?)\s*(?:\(|\|)/mu.exec(text)?.[1]?.trim();
  if (header && !laws.includes(header)) laws.unshift(header);
  return laws.slice(0, 3);
}

function chainRoot(law: string): string {
  let root = compact(law);
  for (const suffix of ["시행규칙", "시행령", "법률", "규칙", "법"]) {
    if (root.endsWith(suffix) && root.length > suffix.length) root = root.slice(0, -suffix.length);
  }
  return root;
}

function anchored(candidate: { law: string; title: string; body: string }, subjects: string[], chains: string[]): boolean {
  const law = compact(candidate.law);
  const title = compact(candidate.title);
  const body = compact(candidate.body);
  if (subjects.length) {
    return subjects.some((subject) => {
      const needle = compact(subject);
      return needle.length >= 2 && (law.includes(needle) || title.includes(needle) || body.includes(needle));
    });
  }
  return chains.some((chain) => {
    const root = chainRoot(chain);
    return root.length >= 2 && law.includes(root);
  });
}

const PROCEDURE_TITLE_TERMS = ["절차", "진행", "방법", "방식", "단계", "접수", "처리", "신청", "청구", "심리", "통지", "송달", "기한", "보정"];
const PROCEDURE_BODY_TERMS = [...PROCEDURE_TITLE_TERMS, "제출", "서면", "결정", "기간"];
const FORM_NOUNS = ["청구서", "신청서", "서식", "첨부서류", "구비서류", "별지"];
const FORM_CONTENT_TERMS = ["제출", "작성", "포함", "첨부", "기재", "서면"];
const COST_BODY_TERMS = ["비용", "수수료"];

function distinctTerms(body: string, terms: readonly string[]): number {
  return terms.filter((term) => body.includes(term)).length;
}

function formNature(body: string): ProcedureFormNature {
  if (/(하여야 한다|해야 한다|제출하여야|포함되어야|서면으로 하여야)/u.test(body)) return "required";
  if (/(인 경우|경우에는|해당하는)/u.test(body) && /(하여야|해야|제출|첨부)/u.test(body)) return "conditional";
  if (/할 수 있다/u.test(body)) return "optional";
  return "unconfirmed";
}

/** Phase order for display; classification priority is the reverse of the
 * fallback: a title carrying two phase signals lands in the earlier phase
 * below (intake before period, period before filing, …). The grouping is a
 * reading aid — every step still shows its own article titles — never a
 * verdict about the procedure's legal order. */
const PROCEDURE_PHASES: Array<{ phase: ProcedureStepPhase; label: string; titleTerms: string[] }> = [
  { phase: "intake", label: "접수·보정", titleTerms: ["보정", "보완", "접수"] },
  { phase: "period", label: "기간", titleTerms: ["기간", "기한"] },
  { phase: "filing", label: "서류 작성·제출", titleTerms: ["청구서", "신청서", "제출", "작성", "기재"] },
  { phase: "review", label: "심리", titleTerms: ["심리", "조사", "심문", "증거"] },
  { phase: "decision", label: "결정·통지", titleTerms: ["재결", "결정", "통지", "송달"] },
  { phase: "scope", label: "대상·요건", titleTerms: ["청구", "신청", "대상", "요건"] },
];
const PROCEDURE_PHASE_ORDER: ProcedureStepPhase[] = ["scope", "period", "filing", "intake", "review", "decision"];

function classifyPhase(title: string): ProcedureStepPhase | null {
  for (const { phase, titleTerms } of PROCEDURE_PHASES) {
    if (titleTerms.some((term) => title.includes(term))) return phase;
  }
  // A title with no phase signal (e.g. "위원회 운영") is not step material:
  // it stays in the requirement's article list and the 근거 sections, but it
  // must not be forced into "대상·요건" and read as a step to follow.
  return null;
}

/** First body sentence after the title/header duplication, capped. The first
 * sentence carries the operative rule (e.g. the 90-day period); picking a
 * later keyword sentence would surface an exception paragraph instead. */
function procedureExcerpt(body: string): string | undefined {
  // Detail bodies repeat the title and article header before the first
  // paragraph marker ("심판청구의 기간 제27조(…) ① …"): drop everything up
  // to the first ① so the excerpt starts with the operative sentence.
  const withoutHeader = body.replace(/^[^①]*①\s*/u, "").trim() || body.replace(/^제\d+조(?:의\d+)?\([^)]*\)\s*/u, "").trim();
  if (!withoutHeader) return undefined;
  const first = withoutHeader.split(/(?<=[.!?。])\s+/u).map((sentence) => sentence.trim()).filter(Boolean)[0];
  if (!first) return undefined;
  return first.length > 140 ? `${first.slice(0, 140)}…` : first;
}

function buildProcedureSteps(requirements: readonly ProcedureRequirementEvidence[], candidates: readonly ArticleCandidate[]): ProcedureStep[] {
  const seen = new Set<string>();
  const byPhase = new Map<ProcedureStepPhase, ProcedureStepArticle[]>();
  for (const requirement of requirements.filter((item) => item.kind === "procedure")) {
    for (const ref of requirement.articles) {
      const key = `${ref.law}\0${ref.jo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const candidate = candidates.find((item) => item.law === ref.law && item.jo === ref.jo);
      const title = candidate?.title ?? ref.title ?? "";
      const phase = classifyPhase(title);
      if (!phase) continue;
      const excerpt = candidate ? procedureExcerpt(candidate.body) : undefined;
      const list = byPhase.get(phase) ?? [];
      list.push({ law: ref.law, jo: ref.jo, ...(title ? { title } : {}), ...(excerpt ? { excerpt } : {}) });
      byPhase.set(phase, list);
    }
  }
  const anyArticle = [...byPhase.values()].some((articles) => articles.length > 0);
  if (!anyArticle) return [];
  return PROCEDURE_PHASE_ORDER.map((phase) => {
    const label = PROCEDURE_PHASES.find((item) => item.phase === phase)!.label;
    const articles = byPhase.get(phase) ?? [];
    return { phase, label, articles, missing: articles.length === 0 };
  });
}

/** A word that cannot start a form name: particles, verb tails, and frame words. */
const INVALID_FORM_PREFIX_END = /(은|는|이|가|을|를|의|에|에서|에게|으로|로|도|만|부터|까지|와|과|만큼|따라|경우|때|한|할|된|될|하는|되는|한다|된다|이다|있다|없다|해야|하여야)$/u;
const stripFormSuffix = (title: string) => title.replace(/\s*\(서식\)\s*$/u, "").trim();

/** Two form titles name the same form: equal, or one carries a subject prefix the other lacks. */
function sameFormTitle(a: string, b: string): boolean {
  const left = compact(a);
  const right = compact(b);
  if (left === right) return true;
  // A bare noun ("청구서") must not match every longer form ("이행신청서" is
  // not "신청서"): a suffix match counts only when the shorter side still
  // carries a subject prefix.
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  return shorter.length > 3 && longer.endsWith(shorter);
}

/**
 * Filing forms a duty article's body names: a filing noun (청구서/신청서/
 * 보정서/취하서) plus at most one preceding noun word. The preceding word
 * must not end with a particle or verb tail, so "따라 심판청구서",
 * "수만큼 심판청구서", "경우에는 심판청구서" collapse to "심판청구서"
 * instead of inventing a form name. No 별지 label is attached here on
 * purpose: a label near a noun in a long article (e.g. a 접수증 label
 * near a 청구서 mention) is not proof that the label belongs to that form,
 * and a wrong label would misconnect the form to another original. Label
 * connections come only from list entries (parser-provided) and from
 * title matching against retrieved originals. A bare 별지 label never
 * confers a filing duty on its own. "보정요구서" is not "보정서" and never
 * matches.
 */
function namedFilingForms(body: string): Array<{ title: string }> {
  const found: Array<{ title: string }> = [];
  for (const match of body.matchAll(/[가-힣]*?(?:청구서|신청서|보정서|취하서)/gu)) {
    let title = match[0];
    const before = body.slice(0, match.index ?? 0);
    const prev = /([가-힣]{2,})\s$/u.exec(before)?.[1];
    if (prev && !INVALID_FORM_PREFIX_END.test(prev)) title = `${prev} ${title}`;
    const existing = found.find((item) => sameFormTitle(item.title, title));
    if (existing) {
      if (compact(existing.title).length < compact(title).length) existing.title = title;
      continue;
    }
    found.push({ title });
  }
  return found;
}

/** Per-entry original: a retrieved annex matches by title or 별지 label within the same law family. */
function entryOriginal(entry: { title: string; law: string; formLabel?: string }, annexes: readonly AnnexEvidence[] | undefined): ClassifiedFormOriginal {
  if (!annexes) return "missing";
  const match = (status: AnnexOriginStage) => annexes.some((annex) => annex.status === status
    && sameLawFamily(annex.law, entry.law)
    && (sameFormTitle(stripFormSuffix(annex.title ?? ""), stripFormSuffix(entry.title))
      || (entry.formLabel ? compact(annex.label) === compact(entry.formLabel) : false)));
  if (match("verified")) return "verified";
  if (match("identified")) return "identified";
  return "missing";
}

interface CountedAnnexEntry { title: string; law: string; formLabel?: string }

function buildClassifiedForms(
  articles: readonly ProcedureArticleRef[],
  candidates: readonly ArticleCandidate[],
  countedEntries: readonly CountedAnnexEntry[],
  annexes: readonly AnnexEvidence[] | undefined,
  /** Full form phrases the query itself names (e.g. "행정심판 청구서"), not bare nouns. */
  queryFormPhrases: readonly string[],
): { classifiedForms: ClassifiedForm[]; annexVerifiedCount: number; directFormOriginalMissing: boolean } {
  // Direct means the form is the one the query names: its title contains the
  // query phrase, or carries the same form under a subject prefix
  // ("심판청구서" for "행정심판 청구서"). A bare noun alone ("신청서") is
  // not used: it would mark every unrelated 신청서 direct.
  const directOf = (title: string) => queryFormPhrases.some((phrase) =>
    compact(title).includes(compact(phrase)) || sameFormTitle(title, phrase));
  const named: Array<{ title: string; duty: "required" | "conditional"; articles: ProcedureArticleRef[] }> = [];
  for (const ref of articles) {
    if (ref.nature !== "required" && ref.nature !== "conditional") continue;
    const candidate = candidates.find((item) => item.law === ref.law && item.jo === ref.jo);
    if (!candidate) continue;
    for (const form of namedFilingForms(candidate.body)) {
      const existing = named.find((item) => sameFormTitle(item.title, form.title));
      if (existing) {
        if (compact(existing.title).length < compact(form.title).length) existing.title = form.title;
        if (ref.nature === "required") existing.duty = "required";
        if (!existing.articles.some((item) => item.law === ref.law && item.jo === ref.jo)) existing.articles.push(ref);
        continue;
      }
      named.push({ ...form, duty: ref.nature, articles: [ref] });
    }
  }
  const merged: ClassifiedForm[] = [];
  const usedNamed = new Set<(typeof named)[number]>();
  for (const entry of countedEntries) {
    const entryTitle = stripFormSuffix(entry.title);
    const match = named.find((item) => !usedNamed.has(item) && sameFormTitle(item.title, entryTitle));
    if (match) {
      usedNamed.add(match);
      merged.push({ title: entryTitle, law: entry.law, ...(entry.formLabel ? { formLabel: entry.formLabel } : {}),
        duty: match.duty, original: entryOriginal(entry, annexes), articles: match.articles,
        direct: directOf(entryTitle) || directOf(match.title) });
      continue;
    }
    merged.push({ title: entryTitle, law: entry.law, ...(entry.formLabel ? { formLabel: entry.formLabel } : {}),
      duty: "reference", original: entryOriginal(entry, annexes), articles: [], direct: directOf(entryTitle) });
  }
  for (const item of named) {
    if (usedNamed.has(item)) continue;
    // No law for a list-absent form: the article refs below carry the
    // grounding law; claiming the form's own law from the article would be
    // a guess (the form itself usually lives in the enforcement rule).
    merged.push({ title: item.title,
      duty: item.duty, original: entryOriginal({ title: item.title, law: item.articles[0]?.law ?? "" }, annexes),
      articles: item.articles, direct: directOf(item.title) });
  }
  const rank = (form: ClassifiedForm) => form.duty === "required" ? 0 : form.duty === "conditional" ? 1 : 2;
  const classifiedForms = [...merged].sort((a, b) => rank(a) - rank(b) || Number(b.direct) - Number(a.direct));
  const annexVerifiedCount = countedEntries.filter((entry) => entryOriginal(entry, annexes) === "verified").length;
  const directFormOriginalMissing = classifiedForms.some((form) => form.direct && form.original !== "verified");
  return { classifiedForms, annexVerifiedCount, directFormOriginalMissing };
}

export function assessProcedureEvidence(query: string, document: ResearchDocument, text: string, annexes?: readonly AnnexEvidence[]): ProcedureEvidence {
  const requirements = identifyProcedureRequirements(query);
  const chains = chainLaws(text);
  const parsed: ArticleCandidate[] = document.sections
    .filter((section) => section.status === "available")
    .flatMap((section) => (section.articles ?? []).map((article) => ({
      law: article.law, jo: article.jo, title: article.title ?? "", body: article.excerpt ?? "",
      truncated: article.excerpt.trim().endsWith("..."),
    })));
  const detail = extractDetailArticles(text);
  const candidates = [...parsed];
  for (const article of detail) {
    const existing = candidates.find((item) => item.law === article.law && item.jo === article.jo);
    if (!existing) { candidates.push(article); continue; }
    // A truncated search preview must not hide the full body the detail
    // format carries for the same article: the evidence judges the body,
    // so a longer detail body replaces the preview (law, jo and title
    // stay the parsed article's).
    if (existing.truncated && article.body.length > existing.body.length) {
      existing.body = article.body;
      existing.truncated = article.truncated;
    }
  }
  const annexEntries = new Map<string, { title: string; law: string; formLabel?: string }>();
  let annexTotal: number | undefined;
  let annexTruncated = false;
  for (const section of document.sections.filter((section) => section.status === "available" && section.kind === "annex" && section.annex)) {
    annexTotal = Math.max(annexTotal ?? 0, section.annex!.total ?? 0);
    for (const entry of section.annex!.entries) {
      // The same form under two list titles ("행정심판 청구서" vs "청구서")
      // is one form: key on its 별지 label when it has one, else its title.
      annexEntries.set(`${entry.formLabel ?? entry.title}\0${entry.law ?? ""}`, { title: entry.title, law: entry.law ?? "",
        ...(entry.formLabel ? { formLabel: entry.formLabel } : {}) });
    }
  }
  if (annexTotal !== undefined && annexEntries.size < annexTotal) annexTruncated = true;
  const failedSections = document.sections.filter((section) => section.unavailable).length;

  // Full form phrases the query names, extracted with the same rule as
  // article bodies (prefix-validated), so a generic noun alone does not
  // mark every same-noun form direct.
  const queryFormPhrases = namedFilingForms(query).map((form) => form.title);

  const assessed: ProcedureRequirementEvidence[] = requirements.map((requirement) => {
    const subjects = requirement.kind === "general"
      ? subjectStems(query)
      : subjectStems(requirement.label);
    const articles: ProcedureArticleRef[] = [];
    const related: ProcedureArticleRef[] = [];
    const seen = new Set<string>();
    const push = (list: ProcedureArticleRef[], candidate: ArticleCandidate, nature?: ProcedureFormNature) => {
      const key = `${candidate.law}\0${candidate.jo}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ law: candidate.law, jo: candidate.jo, ...(candidate.title ? { title: candidate.title } : {}),
        ...(nature ? { nature } : {}) });
    };
    for (const candidate of candidates) {
      if (!anchored(candidate, subjects, chains)) continue;
      const body = candidate.body.trim();
      const bodyLen = body.length;
      if (requirement.kind === "procedure") {
        const titleHit = PROCEDURE_TITLE_TERMS.some((term) => candidate.title.includes(term));
        const bodyHits = distinctTerms(body, PROCEDURE_BODY_TERMS);
        if (bodyLen >= 20 && bodyHits >= 1 && (titleHit || bodyHits >= 2)) {
          push(articles, candidate);
        } else if (titleHit) {
          push(related, candidate);
        }
      } else if (requirement.kind === "forms") {
        const formHit = FORM_NOUNS.some((term) => candidate.title.includes(term) || body.includes(term));
        const contentHit = FORM_CONTENT_TERMS.some((term) => body.includes(term));
        if (bodyLen >= 20 && formHit && contentHit) {
          push(articles, candidate, formNature(body));
        } else if (formHit) {
          push(related, candidate);
        }
      } else if (requirement.kind === "cost") {
        const costHit = COST_BODY_TERMS.some((term) => body.includes(term));
        const amountHit = /(원|금액|부담|납부|면제)/u.test(body);
        if (bodyLen >= 20 && costHit && amountHit) push(articles, candidate);
        else if (costHit) push(related, candidate);
      } else {
        if (bodyLen >= 20) push(articles, candidate);
        else if (candidate.title) push(related, candidate);
      }
    }
    let annexCount = 0;
    const annexRelatedCandidates: string[] = [];
    const countedEntries: Array<{ title: string; law: string; formLabel?: string }> = [];
    if (requirement.kind === "forms" || requirement.kind === "general") {
      for (const entry of annexEntries.values()) {
        const entrySubjects = subjects.length ? subjects : chains.map(chainRoot);
        const lawHit = entrySubjects.some((subject) => compact(entry.law).includes(compact(subject)))
          || chains.some((chain) => compact(entry.law).includes(chainRoot(chain)));
        if (lawHit) { annexCount++; countedEntries.push(entry); }
        // Title correspondence is a separate, additive signal. For a forms
        // requirement it is a form-named entry of the matching law (a 청구서
        // title for a 청구 filing); for a general requirement the entry's
        // own wording must name the subject. It never promotes the entry
        // to direct evidence.
        const titleText = compact(`${entry.formLabel ?? ""} ${entry.title}`);
        // Filing-form titles only (청구서/신청서/보정서/취하서): a bare
        // "(서식)" suffix would admit every listed form, including 집행문.
        const FORM_CANDIDATES = ["청구서", "신청서", "보정서", "취하서"];
        const titleHit = requirement.kind === "forms"
          ? lawHit && FORM_CANDIDATES.some((noun) => compact(entry.title).includes(noun))
          : subjects.some((subject) => {
            const needle = compact(subject);
            return needle.length >= 2 && titleText.includes(needle);
          });
        if (titleHit && annexRelatedCandidates.length < 5) {
          const shown = entry.formLabel ? `${entry.formLabel} ${entry.title}` : entry.title;
          if (!annexRelatedCandidates.includes(shown)) annexRelatedCandidates.push(shown);
        }
      }
    }
    let status: ProcedureRequirementStatus;
    let unparsed: true | undefined;
    if (articles.length) {
      status = "found";
    } else if (related.length || annexCount > 0) {
      status = "viewed";
    } else {
      // Unparsed section prose that names the subject and the requirement's
      // kind is related material, never direct evidence.
      const kindTerms = requirement.kind === "procedure" ? PROCEDURE_TITLE_TERMS
        : requirement.kind === "forms" ? FORM_NOUNS
        : requirement.kind === "cost" ? COST_BODY_TERMS : [];
      const prose = document.sections.some((section) => section.status === "available"
        && (section.kind === "other" || section.kind === "detail")
        && (subjects.length
          ? subjects.some((subject) => compact(section.lines.join("\n")).includes(compact(subject)))
          : chains.some((chain) => compact(section.lines.join("\n")).includes(chainRoot(chain))))
        && (requirement.kind === "general" || kindTerms.some((term) => section.lines.join("\n").includes(term))));
      if (prose) { status = "viewed"; unparsed = true; }
      else status = failedSections > 0 ? "failed" : "none";
    }
    // Origin stage for the counted entries only: a retrieved annex verifies
    // a requirement when it is of the same law family and, when the counted
    // entries carry 별지 labels, the same-numbered form. Entries without a
    // 별지 label (internal codes, bare titles) match by law alone, since no
    // finer identifier bridges the list and the retrieved original.
    const entryLaws = [...new Set(countedEntries.map((entry) => entry.law).filter(Boolean))];
    const entryLabels = countedEntries.map((entry) => entry.formLabel).filter((label): label is string => Boolean(label));
    const annexMatches = (annex: AnnexEvidence) =>
      entryLaws.some((law) => sameLawFamily(annex.law, law))
      && (entryLabels.length === 0 || entryLabels.some((label) => compact(label) === compact(annex.label)));
    const annexOriginStage: AnnexOriginStage = annexes?.some((annex) => annex.status === "verified" && annexMatches(annex)) ? "verified"
      : annexes?.some((annex) => annex.status === "identified" && annexMatches(annex)) ? "identified"
      : "list-only";
    const classification = requirement.kind === "forms"
      ? buildClassifiedForms(articles, candidates, countedEntries, annexes, queryFormPhrases)
      : undefined;
    return {
      label: requirement.label, kind: requirement.kind, status, articles,
      ...(related.length ? { related } : {}),
      annexCount, ...(annexTotal !== undefined ? { annexTotal } : {}),
      annexOriginStage, annexRelatedCandidates,
      ...(unparsed ? { unparsed } : {}),
      ...(classification ? { classifiedForms: classification.classifiedForms,
        annexVerifiedCount: classification.annexVerifiedCount,
        directFormOriginalMissing: classification.directFormOriginalMissing } : {}),
    };
  });

  const foundCount = assessed.filter((item) => item.status === "found").length;
  const viewedCount = assessed.filter((item) => item.status === "viewed").length;
  const failedCount = assessed.filter((item) => item.status === "failed").length;
  const incomplete = failedSections > 0 || failedCount > 0;
  let overall: ProcedureOverall = foundCount === assessed.length ? "matched"
    : foundCount > 0 ? "partial"
    : viewedCount > 0 ? "viewed"
    : failedCount > 0 ? "failed" : "none";
  if (overall === "matched" && incomplete) overall = "partial";
  // `overall` and requirement statuses are unchanged by the origin stage:
  // the stage is additive information, never a demotion or promotion. The
  // overall stage is `verified` only when every requirement with counted
  // entries is verified; a single verified requirement among list-only ones
  // still leaves the overall at `identified`, so the list-only notice
  // (which reads only the overall) never claims an unverified entry holds
  // an original — and never hides that some original was retrieved.
  const counted = assessed.filter((item) => item.annexCount > 0);
  const annexOriginStage: AnnexOriginStage = counted.length && counted.every((item) => item.annexOriginStage === "verified") ? "verified"
    : counted.some((item) => item.annexOriginStage === "verified" || item.annexOriginStage === "identified") ? "identified"
    : "list-only";
  return { requirements: assessed, overall, incomplete, annexTruncated, annexOriginStage, failedSections,
    steps: buildProcedureSteps(assessed, candidates) };
}
