/**
 * Claim-support assessment for citation verification, kept separate from
 * existence verification on purpose.
 *
 * The upstream verifier only establishes that a cited article exists
 * (symbol ✓ plus its title). Whether the input sentence's legal claim is
 * actually supported by that article's content is a different question, and
 * answering it from the verdict marker alone would promote existence to
 * claim confirmation. This module answers it from the article text actually
 * fetched from 법제처, with an explicit "unverified" outcome whenever the
 * text cannot settle it — never a guess dressed as verification.
 */
import { isSubjectTerm, questionTerms, termInText } from "@/lib/research-relevance";

export type ClaimVerdict = "supported" | "mismatch" | "unverified";

/**
 * Legal-effect words whose presence in a claim must itself be confirmed by
 * the article. "처벌" is deliberately absent: its verb forms (처하다 /
 * 처벌하다 / 처벌된다) do not anchor under the noun-stem rule, so including
 * it would demote every legitimate punishment claim (e.g. 형법 제311조
 * "공연히 사람을 모욕하면 처벌된다"). Subject coverage governs those claims.
 */
const EFFECT_WORDS = [
  "손해배상", "배상", "청구", "책임", "해제", "지급", "반환", "보상",
  "무효", "취소", "정지", "벌금", "징역", "금고", "과징금",
];

/** Final-predicate negation markers: the claim's effect is asserted as absent. */
const NEGATED_PREDICATE = /(없다|없습니다|아니다|아닙니다|않는다|않습니다|못한다|못했습니다|할 수 없다|할 수 없습니다|불가능하다|불가능합니다)$/;

/**
 * Whether a claim term is covered by the article text, allowing the
 * article's own split forms: a compound such as 손해배상책임 is covered
 * when its parts (손해배상 → 손해 + 배상, 책임) are all covered, even
 * though the compound itself never appears verbatim. Single words still
 * need a whole-token anchor, so unrelated compounds are not rescued.
 */
function termCovered(term: string, corpus: string, seen: Set<string> = new Set()): boolean {
  if (termAnchoredCompound(term, corpus)) return true;
  if (seen.has(term)) return false;
  seen.add(term);
  for (let split = 2; split <= term.length - 2; split++) {
    const left = term.slice(0, split);
    const right = term.slice(split);
    if (left.length >= 2 && right.length >= 2 && termCovered(left, corpus, seen) && termCovered(right, corpus, seen)) {
      return true;
    }
  }
  return false;
}

/**
 * True when the input's final sentence ends in a negated predicate. Only
 * the final predicate is checked: a contrast inside the sentence ("고의가
 * 아닌 과실") must not demote a claim whose own predicate is positive.
 */
function hasNegatedPredicate(input: string): boolean {
  const sentences = input.split(/[.!?。\n]+/).map((part) => part.trim()).filter(Boolean);
  const last = sentences.at(-1) ?? "";
  return NEGATED_PREDICATE.test(last);
}

export interface ClaimAssessment {
  verdict: ClaimVerdict;
  /** Short user-facing reason; empty for supported. */
  reason: string;
}

/** One assessed citation, matched by index into the verifier's law-citation list. */
export interface ClaimSupportEntry {
  index: number;
  verdict: ClaimVerdict;
  reason: string;
}

/** Whole-token scaffolding that names no legal assertion. */
const CLAIM_STOP = new Set([
  "따른", "따라", "각각", "확인해", "확인", "알려줘", "알려주세요", "궁금해", "궁금해요",
  "수", "것", "경우", "때", "의하여", "의해", "의거", "근거로", "대해", "하면",
  "있다", "없다", "이다", "입니다", "한다", "된다", "되어", "되면", "되고",
  // Contrast particles ("고의가 아닌 과실") are grammar, not assertion
  // content; sentence-final negation is still caught by the predicate check.
  "아닌", "아니라", "아니",
]);

/** Verb endings stripped so a claim stem matches the article's own forms (청구할 → 청구). */
const CLAIM_TAILS = [
  "하십시오", "하여야", "하도록", "하기로", "하므로", "하지는", "하지도",
  "당하였다", "당했다", "당하는", "당하여", "당하면", "당하고",
  "받았다", "받는", "받아", "받음",
  "되어야", "되어", "되면", "되고", "될", "된다", "됨", "되지",
  "하였다", "했다", "하는", "하여", "하면", "하고", "하며", "해서", "해야", "한다", "함", "할", "한",
  "이다", "입니다",
];

const ARTICLE_REF = /제\s*\d+\s*조(?:\s*의\s*\d+)?(?:\s*제\s*\d+\s*항)?(?:\s*제\s*\d+\s*호)?/gu;
/** Two-character legal terms ending in 의 that must survive the particle strip (고의, 선의 …). */
const DEPARTICLE_EXCEPTIONS = new Set(["고의", "선의", "악의", "주의", "명의"]);
/** A sentence concluding about a specific case, which an article alone can never settle. */
const CASE_REFERENT = /(?:이 사건|본 사건|해당 사건|본 건|위 사건)/u;

function stemClaimTerm(term: string): string {
  let stem = term;
  for (const tail of CLAIM_TAILS) {
    if (stem.length - tail.length >= 2 && stem.endsWith(tail)) {
      stem = stem.slice(0, -tail.length);
      break;
    }
  }
  return stem;
}

/**
 * The sentence's legal assertion as terms: the citation itself (law name and
 * article references) removed, question scaffolding stripped, verb stems kept.
 * Generic legal-effect words (손해배상, 청구) stay — they ARE the assertion.
 * A second particle strip runs even on two-character tokens, because
 * questionTerms only strips particles from longer ones and a leftover
 * grammatical word (자는, 이를) would otherwise anchor in almost any article.
 */
export function extractClaimTerms(input: string, lawName: string): string[] {
  const stripped = input.split(lawName).join(" ").replace(ARTICLE_REF, " ");
  const terms: string[] = [];
  for (const raw of questionTerms(stripped)) {
    if (/^제?\d+조/u.test(raw) || /^\d/u.test(raw)) continue;
    const departicle = DEPARTICLE_EXCEPTIONS.has(raw) ? raw : raw.replace(/(은|는|이|가|을|를|의|과|와)$/u, "");
    const stem = stemClaimTerm(departicle);
    if (stem.length < 2 || CLAIM_STOP.has(stem)) continue;
    if (!terms.includes(stem)) terms.push(stem);
  }
  return terms;
}

const compact = (text: string) => text.replace(/\s+/gu, "");
const looseIncludes = (term: string, text: string) => Boolean(term) && compact(text).includes(compact(term));

/**
 * Whether a claim term stands in the corpus: as a word of its own, or as a
 * compound whose every part stands as a word (손해배상 against 손해를 …
 * 배상할 — the article states the same proposition with the compound split).
 * A single part anchoring never suffices.
 */
function termAnchoredCompound(term: string, corpus: string): boolean {
  if (termInText(term, corpus)) return true;
  for (let split = 2; split <= term.length - 2; split++) {
    const left = term.slice(0, split);
    const right = term.slice(split);
    if (left.length >= 2 && right.length >= 2 && termInText(left, corpus) && termInText(right, corpus)) return true;
  }
  return false;
}

/**
 * Judges one cited article against the sentence that cited it.
 * - supported: at least one claim term stands in the article title or body as
 *   a word of its own (termInText completion rule, same standard as research
 *   relevance — a compound-internal partial match never carries support).
 * - mismatch: no claim term stands in title or body AND no claim term even
 *   loosely overlaps the title, so the title names a different subject.
 *   The loose-overlap veto keeps a paraphrase (손해배상 vs 손해배상책임) from
 *   being called a mismatch.
 * - unverified: anything else — a case-specific conclusion, no extractable
 *   claim, or a title overlap without anchored support.
 */
export function assessClaimSupport(
  input: string,
  lawName: string,
  title: string,
  content: string,
): ClaimAssessment {
  if (CASE_REFERENT.test(input)) {
    return { verdict: "unverified", reason: "구체적인 사실관계가 필요한 결론은 조문만으로 확인되지 않습니다." };
  }
  const claimTerms = extractClaimTerms(input, lawName);
  if (!claimTerms.length) {
    return { verdict: "unverified", reason: "입력 문장에서 검증할 법적 주장을 특정하지 못했습니다." };
  }
  const corpus = `${title}\n${content}`;
  const anchored = claimTerms.filter((term) => termCovered(term, corpus));
  // One anchored term alone used to confirm a claim. That over-promotes
  // three shapes: a claim whose final predicate negates the effect, a
  // claim whose core (subject/basis) term never anchors while a common
  // effect word does, and a claim whose asserted legal effect is absent
  // from the article. Each check below only demotes a would-be supported
  // verdict to unverified; mismatch and unverified paths are untouched,
  // and no verdict is ever raised.
  if (anchored.length) {
    if (hasNegatedPredicate(input)) {
      return { verdict: "unverified", reason: "부정 표현으로 제시된 법적 효과는 조문만으로 확정하지 않았습니다." };
    }
    if (claimTerms.length === 1 && !isSubjectTerm(claimTerms[0])) {
      return { verdict: "unverified", reason: "입력한 주장만으로는 법적 주장을 확정할 수 없습니다." };
    }
    if (claimTerms.some((term) => isSubjectTerm(term) && !termCovered(term, corpus))) {
      return { verdict: "unverified", reason: "입력한 주장의 핵심 내용이 조문에서 확인되지 않아 확정하지 않았습니다." };
    }
    const effectPresent = EFFECT_WORDS.filter((effect) =>
      claimTerms.some((term) => term === effect || term.includes(effect)));
    const effectAnchored = effectPresent.some((effect) =>
      termCovered(effect, corpus) ||
      claimTerms.some((term) => term.includes(effect) && termCovered(term, corpus)));
    if (effectPresent.length && !effectAnchored) {
      return { verdict: "unverified", reason: "입력한 주장의 법적 효과가 조문에서 확인되지 않아 확정하지 않았습니다." };
    }
    return { verdict: "supported", reason: "" };
  }
  const titleTerms = questionTerms(title);
  const overlapsTitle = claimTerms.some((term) => looseIncludes(term, title))
    || titleTerms.some((term) => looseIncludes(term, input));
  if (overlapsTitle) {
    return { verdict: "unverified", reason: "입력한 주장과 조문 내용의 직접 관련성을 확인하지 못했습니다." };
  }
  return {
    verdict: "mismatch",
    reason: title
      ? `조문은 존재하지만, 입력한 법적 주장과 조문 내용(${title})이 맞지 않습니다.`
      : "조문은 존재하지만, 입력한 법적 주장과 조문 내용이 맞지 않습니다.",
  };
}
