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
import { questionTerms, termInText } from "@/lib/research-relevance";

export type ClaimVerdict = "supported" | "mismatch" | "unverified";

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
  const anchored = claimTerms.filter((term) => termAnchoredCompound(term, corpus));
  if (anchored.length) return { verdict: "supported", reason: "" };
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
