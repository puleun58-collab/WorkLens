import { compactLaw, sameLawFamily } from "@/lib/research-scope";
import { researchResult } from "@/lib/law-research-parse";

/**
 * Relevance of `legal_research` results to the user's question, decided by
 * WorkLens rather than the upstream order. Rule-based and explainable: every
 * judgement names the question terms (or cited article) it matched.
 *
 * The MCP falls back to full-text search when a title search misses, so a
 * precedent can be listed only because a question word appears somewhere in a
 * long judgment. Case titles are therefore never enough on their own; the
 * 판시사항/판결요지 decide, and a precedent whose summary could not be read is
 * kept as "unknown" instead of being guessed either way.
 */

/** How a precedent relates to the question; `low` ones are folded, never deleted. */
export type PrecedentRank = "direct" | "related" | "unknown" | "low";

export interface PrecedentRelevance {
  rank: PrecedentRank;
  /** Question terms or articles found in the title/summary, for the reader and for tests. */
  matched: string[];
}

/** A title that names a definition (용어 정의) rather than a substantive duty, sanction or procedure. */
export function isDefinitionTitle(title: string | undefined): boolean {
  return title ? /정의/u.test(title) : false;
}

/** An article WorkLens looked up because a question term is in its title. */
export interface SupplementArticle {
  law: string;
  jo: string;
  title: string;
  excerpt: string;
  effectiveDate?: string;
  /** Question terms found in the article title. */
  matched: string[];
  /** Role signal: a definition article is a candidate, never core evidence on its title alone. */
  role?: "definition" | "other";
  /** Where this article came from, so an adopted article's provenance is recorded, not guessed. */
  stage?: "supplement" | "issue" | "reread" | "retry";
  /**
   * Fetched directly because the user's question or issue named this exact
   * law + article (not because a search term matched its title): adoption
   * for its issue is by identity, never by a guessed number.
   */
  explicit?: true;
}

export interface ResearchEnrichment {
  /** Keyed by precedent id as printed by the MCP (`[619479]`). */
  precedents?: Record<string, PrecedentRelevance>;
  /** Bounded official holding/opening text used to verify each precedent's topical match. */
  precedentExcerpts?: Record<string, string>;
  /** `none`: looked up and nothing matched; `failed`: lookups failed; `not_searched`: no usable term. */
  supplement?: { status: "found" | "none" | "failed" | "not_searched"; articles: SupplementArticle[];
    /**
     * Some title lookups failed while another article still landed, so the
     * supplement is incomplete even though its status is `found`. The caller
     * decides whether that incompleteness is attributable to one issue
     * (lookupIssue surfaces it as `partialFailure`); the shared chain
     * supplement carries the flag without a UI demotion of its own.
     */
    partialFailure?: boolean };
  /**
   * The MCP searches 법령해석례 with the whole question, which AND-matches framing
   * words and often returns nothing. When that section is empty, one retry with
   * only the question's subject terms; `entries` are that search's hits.
   */
  interpretations?: { query: string; entries: Array<{ id: string; title?: string; caseNumber?: string; body?: string; date?: string }> };
}

/** Words that frame a question rather than name its subject: question scaffolding, scene nouns and speech acts. */
const FRAME_WORDS = new Set([
  "판단", "기준", "방법", "절차", "관련", "요건", "근거", "여부", "효력", "내용", "사례", "판례", "처분", "문제", "경우",
  "및", "등", "내", "의", "에서", "대한", "관한", "위한", "대해", "알려줘", "알려주세요", "무엇", "어떻게", "가능", "해석", "적용", "범위",
  "어떤", "또는", "혹은",
  "회사", "업무", "궁금", "궁금해", "궁금해요", "싶어", "알고",
  // 규정 carries no discriminating information (every article is a 규정):
  // "해고 규정" names 해고, and keeping 규정 as a term would demand a body
  // word no dismissal article uses.
  "규정",
]);
const PARTICLE = /(?:의|을|를|이|가|은|는|에|에서|으로|로|과|와|도)$/u;
/** Endings of a spoken or written question (…당했어, …관련해서, …해고됐는데, …인지): they inflect, they do not name a subject. */
const ENDING = /(?:됐는데|했는데|였는데|인데|해서|하여|했어|됐어|았어|었어|였어|인지|은지|는지|인가|을까|일까|나요|되면|하면)$/u;
const LAW_NAME = /(?:법|법률|령|규칙|조례)$/u;
/** `근로기준법상` names the law under a locative suffix; the law name itself is the subject. */
const LAW_UNDER = /^(.+(?:법|법률|령|규칙|조례))상$/u;

const compact = (text: string) => text.replace(/\s+/gu, "");

/**
 * Grammar that may close a written token after a word: particles, the copula,
 * and the endings of the verbs a noun stem forms (하다·되다·당하다·받다 등).
 * Anything else after a term inside its token is another noun, and then the
 * term only modifies a different concept: 사용자등록 is a kind of 등록, not of
 * 사용자, and 금융지주회사 continues past 회사 into a specific institution.
 */
const GRAMMATICAL_TAIL = /^(?:[은는이가을를에의와과도만씩뿐로]|에서|에게|한테|으로|으로서|으로써|로써|으로부터|까지|부터|처럼|보다|께|조차|마저|이나|든지|등|등의|적인|적으로|상|중|내|간|별|들|이며|이고|이다|입니다|인|일|이|이란|이라는|이라고|이라|란|라는|라고|한|하는|하여|하면|하고|하며|할|해|했|한다|함|하지|하지는|하지도|하니|하므로|하기|하기로|하도록|하게|하자|합니다|하십시오|하여야|해야|아니|아니한|당한|당하는|당하여|당하면|당하고|당했|당했다|당함|받은|받는|받아|받았|받음|되|된|되는|되어|되면|되고|될|된다|됨|되지|되어야|시킨|시키는|시켜|어야|여야|아서|여서|으면|면|고|며|지|게|기|다|요|니)*$/u;
const TOKEN_SPLIT = /[\s,.;:·!?()「」『』"'“”‘’/[\]{}<>※—-]+/u;

/** Subject terms of a question, in order; law names are kept (they are subjects too). */
export function questionTerms(query: string): string[] {
  const terms: string[] = [];
  for (const raw of query.split(/[\s,.;:·!?()「」『』"'“”‘’/]+/u)) {
    let word = raw.trim().replace(LAW_UNDER, "$1");
    // Endings first: a particle strip would break them (무엇인가 → 무엇인).
    if (word.length > 2) word = word.replace(ENDING, "");
    if (word.length > 2 && !LAW_NAME.test(word)) word = word.replace(PARTICLE, "");
    if (word.length < 2 || FRAME_WORDS.has(word) || /^\d+$/u.test(word)) continue;
    if (!terms.includes(word)) terms.push(word);
  }
  return terms;
}

/**
 * A question's own subject words: its terms minus generic procedure/effect
 * words and actor words. Used for the unread-question fallback: the lookup
 * query and the adoption subjects come from these, never from an invented
 * legal term.
 */
export function questionSubjectTerms(query: string): string[] {
  return questionTerms(query).filter(isSubjectTerm);
}

/**
 * Whether a phrase names no subject at all: every term is a generic
 * procedure/effect word, an actor word, or sentence scaffolding (따른, 각각).
 * Such a phrase cannot name its regime upstream ("피해자 보호" retrieves
 * every victim-protection law but the workplace one), so a retry qualifies
 * it with the request's subjects.
 */
export function questionTermsSubjectLess(query: string): boolean {
  const terms = questionTerms(query).filter((term) => !isLawName(term));
  return terms.length > 0 && terms.every((term) => GENERIC_TERMS.has(term) || ACTOR_TERMS.has(term) || SUBJECT_STOP.has(term));
}

/** Any occurrence at all, including inside a longer compound (사용자등록 for 사용자). */
function termOccurs(term: string, compactedText: string): boolean {
  const needle = compact(term);
  if (!needle) return false;
  if (compactedText.includes(needle)) return true;
  return needle.length >= 3 && needle.endsWith("죄") && compactedText.includes(needle.slice(0, -1));
}

/**
 * Whether verified source text uses a question term as a word of its own: the
 * term completes a written token — itself with its grammar (모욕한, 보증금의),
 * or the head of a compound (부당해고 for 해고, 제출의무 for 의무). Where a
 * longer compound merely continues past it, the occurrence belongs to that
 * other concept: a modifier inside 사용자등록 or 금융지주회사 is not the word.
 *
 * Statute titles and bodies name the act (모욕), while questions name the
 * offense (모욕죄), so an offense name also matches through its act noun,
 * under the same completion rule. A morphological rule only: no other form
 * is inferred, and shorter names (범죄) are never cut.
 */
export function termInText(term: string, text: string): boolean {
  const needles = [term];
  if (term.length >= 3 && term.endsWith("죄")) needles.push(term.slice(0, -1));
  for (const token of text.split(TOKEN_SPLIT)) {
    if (!token) continue;
    for (const needle of needles) {
      let at = token.indexOf(needle);
      while (at !== -1) {
        const tail = token.slice(at + needle.length);
        if (!tail || GRAMMATICAL_TAIL.test(tail)) return true;
        at = token.indexOf(needle, at + 1);
      }
    }
  }
  return false;
}

/**
 * A term standing behind a relevance decision: used as a word of its own, or
 * written joined with another of the question's own terms (소유권이전등기 stacks
 * 소유권·이전·등기 — the question's phrase without spaces). A term that only
 * modifies an unrelated compound (사용자 inside 사용자등록) never qualifies, so
 * a compound-internal partial match cannot carry a decision on its own.
 */
function termAnchored(term: string, terms: readonly string[], text: string): boolean {
  if (termInText(term, text)) return true;
  return text.split(TOKEN_SPLIT).some((token) => token.includes(term)
    && terms.some((other) => other !== term && token.includes(other)));
}

/**
 * Action words a compound sanction/procedure term may split into
 * ("영업정지" → 영업 + 정지). Only these tails split: a subject noun
 * splitting into an unrelated compound (명예훼손 → 명예 + 훼손) is not
 * an operative act and must not gain adoption from this rule.
 */
const ACTION_TAILS = new Set([
  "정지", "취소", "처분", "부과", "징수", "금지", "제한", "허가", "인가", "승인", "폐쇄", "말소",
]);
/** Authority wording that makes a sentence operative rather than a mere mention. */
const AUTHORITY_WORDING = /(할수있다|하여야한다|해야한다|하여야할|해야할|명할수|할수있는)/u;
/** Negation that cancels the act it follows, in the act's own clause span. */
const ACT_NEGATION = /(아니|않|면제)/u;

/**
 * Whether a compound term is written split across its own act in one
 * sentence ("그 영업의 전부 또는 일부를 정지하거나 … 할 수 있다" for
 * 영업정지): both halves close together (at most 16 compacted characters
 * apart), in the same sentence, under operative authority wording, with
 * no negation cancelling the act, and not inside a quoted citation
 * (「…」 quotes another provision, they are not this article's own act).
 * Halves scattered across sentences, a negated act, a mention without
 * authority wording, or a quoted citation alone never match.
 */
/** Split into sentence spans: a `.` inside parentheses does not end a
 * sentence (a qualifier such as "(…신고한 영업만 해당한다. 이하 … 같다)"
 * must not cut the operative grant from its act), while newlines and
 * ①–⑩ markers always do and reset the parenthesis tracking, so an
 * excerpt cut mid-parenthesis cannot merge the sentences that follow.
 * Only the sentence split changes; the act, distance, negation and
 * quotation guards below are untouched. */
function splitSentences(content: string): string[] {
  const sentences: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of content) {
    if (char === "(" || char === "（") depth++;
    else if (char === ")" || char === "）") { if (depth > 0) depth--; }
    if ((char === "." && depth === 0) || char === "\n" || /[①②③④⑤⑥⑦⑧⑨⑩]/u.test(char)) {
      sentences.push(current);
      current = "";
      depth = 0;
    } else {
      current += char;
    }
  }
  if (current) sentences.push(current);
  return sentences;
}

/** Authority wording outside parentheses: a grant mentioned only inside a
 * qualifier ("(명할 수 있다. …)") is not the sentence's own operative
 * authority, so it must not join an act to a permission it never grants.
 * Parenthesis characters themselves are dropped, so an authority phrase
 * merely interrupted by a qualifier still counts. */
function hasOperativeAuthority(compacted: string): boolean {
  let depth = 0;
  let outside = "";
  for (const char of compacted) {
    if (char === "(" || char === "（") { depth++; continue; }
    if (char === ")" || char === "）") { if (depth > 0) depth--; continue; }
    if (depth === 0) outside += char;
  }
  return AUTHORITY_WORDING.test(outside);
}

export function splitActionMatches(term: string, content: string): boolean {
  if (term.length < 4) return false;
  for (let i = 2; i <= term.length - 2; i++) {
    const head = term.slice(0, i);
    const tail = term.slice(i);
    if (!ACTION_TAILS.has(tail)) continue;
    for (const sentence of splitSentences(content)) {
      const compacted = sentence.replace(/\s+/gu, "");
      if (!hasOperativeAuthority(compacted)) continue;
      let at = compacted.indexOf(head);
      while (at !== -1) {
        // A quoted span cites another provision; it is not this text's act.
        const quotes = (compacted.slice(0, at).match(/「/gu) ?? []).length - (compacted.slice(0, at).match(/」/gu) ?? []).length;
        if (quotes <= 0) {
          const tailAt = compacted.indexOf(tail, at + head.length);
          if (tailAt !== -1 && tailAt - (at + head.length) <= 16) {
            const span = compacted.slice(at, tailAt + tail.length);
            const after = compacted.slice(tailAt + tail.length, tailAt + tail.length + 8);
            if (!ACT_NEGATION.test(span) && !ACT_NEGATION.test(after)) return true;
          }
        }
        at = compacted.indexOf(head, at + 1);
      }
    }
  }
  return false;
}

/** A question term that is an article number, not a lexical subject word. */
const JO_TERM = /^제[1-9]\d{0,3}조(?:의[1-9]\d?)?$/u;
/** Bare subordinate-law nouns name no regime, so they never restrict adoption. */
const BARE_LAW_TERM = new Set(["시행령", "시행규칙", "법령", "대통령령", "총리령", "부령"]);

export const isLawName = (term: string) => LAW_NAME.test(term) && term.length >= 3;

/** A strict majority: half is not a majority (2 terms need 2, 4 terms need 3). */
const strictMajority = (count: number) => Math.floor(count / 2) + 1;

/**
 * Words that name a procedure, effect or legal function rather than a subject:
 * an issue made only of these (plus actor words below) names no subject of its
 * own, so its terms alone cannot tell one regime's provision from another's
 * (조정 신청 matches every 조정 제도; 조사 의무 matches every 조사 규정).
 * These words never count as a subject — neither for the subject-less test nor
 * for the request-subject set of rule (B) below.
 */
const GENERIC_TERMS = new Set([
  // 발생 is an event word, not a subject: "직장 내 괴롭힘 발생 시 조치" is
  // about 직장 내 괴롭힘 조치 whether or not the request says 발생. Without
  // it the title-subject guard vetoes the core article for a request that
  // never uses the word (live probe: 조사·보호·조치 의무 issues).
  "발생",
  "금지", "벌칙", "처벌", "의무", "조치", "조사", "보호", "절차", "적용", "효력", "위반", "책임",
  "신고", "구제", "제한", "정지", "취소", "무효", "규정", "준용", "특례", "예외", "사항", "내용",
  "범위", "대상", "손해배상", "배상", "청구", "고소", "고발", "보상", "지급", "반환", "이행", "준수",
  // 관계 names a link between two things, not a subject of its own: an issue
  // "법령·시행령 관계" must not adopt any article that merely mentions 관계
  // (a purpose clause's "관계 규정" adopted 회계관계직원법 제1조 for a
  // 개인정보보호법 question). With it generic, such an issue falls under
  // rule (B) and needs a request subject anchored in the text as well.
  "관계",
  // 기간 is a dimension, not a topic: a title matching only 기간 ("인증
  // 유효기간" for an 영업정지 question) says nothing about the question's
  // subject, so it must not discover laws or carry a supplement candidate.
  "기간",
  // 법령/법률 are two characters, so the shared law-name rule (length ≥ 3,
  // which keeps 방법 from becoming a law) never treats them as law names;
  // as terms they are generic nouns ("laws in general"), not subjects.
  "법령", "법률",
  "등록", "신청", "심사", "결정", "판정", "심판", "조정", "중재", "소송", "허가", "인가", "처분",
  "부과", "징수", "감면", "면제", "지원", "관리", "운영", "구성", "변경", "해지", "연장",
  "대처", "대응", "방지", "예방", "해결", "상담", "문의", "접수", "가능성", "확인", "검토",
  // Further action words, not subjects: 회수 is the action of recovering a
  // deposit (보증금의 회수), like 반환 — a title naming only such actions
  // plus the issue's own terms names no new subject.
  "회수", "추심", "환급", "환불", "상환", "변제", "납부", "수령", "수취", "인도", "양도",
  "양수", "승계", "이전", "설정", "해제", "말소", "정산", "제출", "통지", "고지", "통보",
  "제기", "제소", "소장", "기재", "첨부", "구비",
  "공고", "게시", "열람", "제공", "작성", "비치", "보존", "예치", "보관", "위임", "위탁",
  "대행", "중개", "알선", "모집", "승인", "동의", "심의", "의결", "선고", "판결", "확정",
  "시정", "진행", "시행", "실시", "개시", "완료", "설치", "해산", "합병", "분할", "청산",
  "육성", "진흥", "보조", "장려",
]);
/** Roles, not subjects: 피해자·가해자 name a side of a dispute, not what it is about. */
const ACTOR_TERMS = new Set([
  "사용자", "근로자", "사업주", "고용주", "피해자", "가해자", "행위자", "피고", "원고",
  "신청인", "피신청인", "채무자", "채권자", "임대인", "임차인",
]);

/** Relation words that name a link between laws, not a subject of their own (위계, 체계, 구조): like 관계, they never count as a subject term. */
const RELATION_TERMS = new Set(["위계", "체계", "구조", "연계"]);

/** Whether a phrase names no subject at all once relation words are also set aside: a "법령 위계" issue is about the link the question's own law + article names, not about 위계 as a topic. */
export function questionTermsRelationLess(query: string): boolean {
  const terms = questionTerms(query).filter((term) => !isLawName(term));
  return terms.length > 0 && terms.every((term) => GENERIC_TERMS.has(term) || ACTOR_TERMS.has(term) || SUBJECT_STOP.has(term) || RELATION_TERMS.has(term));
}

/** Sentence scaffolding that names no subject: it survives questionTerms (에 따른, 각각, 확인해 줘) yet anchors in almost any article ("제X조에 따른 …"), so it must never count as a request subject for rule (B). Without this, a subject-less issue (조사 의무, 피해자 보호) adopts any regime's provision that happens to contain its generic term plus 따른. */
const SUBJECT_STOP = new Set([
  "따른", "따라", "각각", "확인해", "확인", "알려줘", "알려주세요", "궁금해", "궁금해요",
  "대해", "관해", "관련", "기준", "경우", "때",
]);

export function isSubjectTerm(term: string): boolean {
  return !GENERIC_TERMS.has(term) && !ACTOR_TERMS.has(term) && !SUBJECT_STOP.has(term);
}

/**
 * Law names a text identifiably cites, from its compacted form: maximal
 * Korean runs ending in a law suffix. Generic two-character nouns (법령,
 * 법률) and method words (방법, 기법, 수법, 요법) are not law names, and a
 * two-character run counts only when it is immediately followed by an
 * article citation (민법제750조) — bare 방법 in "판단하는 방법" must never
 * read as a cited regime. A run is returned compacted, so a spaced official
 * name (개인정보 보호법) matches the question's joined spelling.
 */
export function lawNameRunsInText(text: string): string[] {
  const compacted = compact(text);
  const runs: string[] = [];
  const pattern = /[가-힣]{2,}(?:법률|시행규칙|시행령|법|령|규칙|조례)/gu;
  for (const match of compacted.matchAll(pattern)) {
    const run = match[0];
    // Bare subordinate-law type nouns (시행령, 대통령령…) and generic
    // compounds ending in 법령 (관계법령, 관련법령) name no regime of
    // their own: only a law-prefixed run (식품위생법시행령) identifies one.
    if (["시행령", "시행규칙", "대통령령", "총리령", "부령"].includes(run) || run.endsWith("법령")) continue;
    if (run.length < 3) {
      // Two-character law names (형법, 민법) are real, but so are 방법-style
      // nouns: only an immediately following article citation identifies one.
      const after = compacted.slice(match.index + run.length);
      if (!/^제[1-9]\d{0,3}조/u.test(after)) continue;
    }
    if (/(?:방법|기법|수법|요법|처법)$/u.test(run)) continue;
    if (!runs.includes(run)) runs.push(run);
  }
  return runs;
}

/**
 * Whether every content token of a title is explained by the request's own
 * words, a generic function word, or an actor word. A token is explained when
 * removing those words (longest first, so 법정모욕 splits into 법정+모욕)
 * leaves nothing or a one-character particle residue. A token that survives
 * (국기 in 국기·국장 모욕, 비밀준수 in 비밀준수의무) names a subject the
 * request never mentioned.
 */
function titleTokenExplained(token: string, stripTerms: readonly string[]): boolean {
  if (stripTerms.includes(token)) return true;
  // An offense name also explains its act noun: 모욕죄 explains 모욕, as in
  // the title rule elsewhere (a title of 모욕 is the article 모욕죄 points to).
  const expanded = [...stripTerms, ...stripTerms.filter((term) => term.length >= 3 && term.endsWith("죄")).map((term) => term.slice(0, -1))];
  let rest = token;
  for (const term of [...expanded].sort((a, b) => b.length - a.length)) {
    if (term && rest.includes(term)) rest = rest.split(term).join("");
  }
  if (rest.length <= 1) return true;
  // An abbreviated compound is explained by the term it abbreviates: 심판 in
  // 심판청구 is the 심판 of 행정심판, not a new subject. A remainder that is
  // no request word's part (국기, 비밀준수) still names a new subject.
  return rest.length >= 2 && expanded.some((term) => term.includes(rest));
}

/**
 * Whether the title-subject guard vetoes an article. A title joining subjects
 * with a disjunction (또는/혹은) names each branch separately, so the guard
 * vetoes only when NO branch is fully explained: 법정 또는 국회회의장모욕 is
 * kept for a 법정 모욕 issue because its 법정 branch matches, even though
 * 국회회의장 is unmentioned. A title without a disjunction is a single
 * branch, so this reduces exactly to the previous all-tokens-explained rule.
 */
function titleVetoed(title: string, stripTerms: readonly string[]): boolean {
  return title.split(/또는|혹은/u).every((branch) =>
    questionTerms(branch).some((token) => !isLawName(token) && !titleTokenExplained(token, stripTerms)));
}

/**
 * The case title is a candidate signal only; relevance evidence is the
 * 판시사항/판결요지/참조조문 (or, for lower courts without one, the judgment
 * opening with the title lines removed).
 *
 * `direct`: every subject term, or a statute article the answer cites, appears
 * in the summary. `related`: a strict majority of the terms including one of
 * the most specific (longest) — under the same anchored standard as `direct`
 * and as citation, so a term that appears only inside another compound (사용자
 * inside 사용자등록) carries neither promotion. Otherwise `low`: the summary
 * was read and does not address the question, whatever the title says. An
 * `excerpt` can at most make a case `related`; without any summary the case
 * stays `unknown`. `matched` lists the evidence terms only.
 */
export function rankPrecedent(
  terms: readonly string[],
  entry: { title?: string; summary?: string; excerpt?: boolean },
  citedArticles: readonly string[] = [],
): PrecedentRelevance {
  if (!terms.length || entry.summary === undefined) return { rank: "unknown", matched: [] };
  // A judgment opening repeats the case name (`[id] 사건명`, `=== 사건명 ===`); that is still the title.
  const evidence = entry.excerpt && entry.title ? entry.summary.split(entry.title).join(" ") : entry.summary;
  const matched = terms.filter((term) => termOccurs(term, compact(evidence)));
  const articles = citedArticles.filter((article) => compact(evidence).includes(compact(article)));
  const longest = Math.max(...terms.map((term) => term.length));
  // Promotion is the step a stray partial match must not carry: the most
  // specific term has to be there as a word, not only inside a compound.
  // Ranking and citation judge by this one standard, so a case the citation
  // step would reject on compound-internal evidence alone is not shown as
  // related either; it stays a `low` candidate, never deleted.
  const anchored = matched.some((term) => term.length === longest && termAnchored(term, terms, evidence));
  if (!entry.excerpt && ((matched.length === terms.length && anchored) || articles.length)) return { rank: "direct", matched: [...matched, ...articles] };
  if ((anchored && matched.length >= strictMajority(terms.length)) || (entry.excerpt && articles.length)) {
    return { rank: "related", matched: [...matched, ...articles] };
  }
  return { rank: "low", matched };
}
const ORDER: Record<PrecedentRank, number> = { direct: 0, related: 1, unknown: 2, low: 3 };

/** Stable: within a rank the MCP's own order is the tie-breaker. */
export function orderByRelevance<T extends { id: string }>(entries: readonly T[], relevance: Record<string, PrecedentRelevance> | undefined): T[] {
  if (!relevance) return [...entries];
  return entries
    .map((entry, index) => ({ entry, index, rank: ORDER[relevance[entry.id]?.rank ?? "unknown"] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ entry }) => entry);
}

/**
 * Article titles that contain a question term. Terms that are part of the law's
 * own name say nothing about which article is meant, so they never count.
 */
export function titleMatches(terms: readonly string[], law: string, title: string): string[] {
  const name = compact(law);
  return terms.filter((term) => !isLawName(term) && !name.includes(compact(term)) && termInText(term, title));
}

/**
 * A search total or decision title is merely a candidate. Only source text
 * reflecting the issue can be cited as a topical match; applicability still
 * depends on the user's facts and the source's effective date.
 *
 * Adoption for one issue, in order:
 * - (A) The issue's own terms, under a strict majority plus longest-term
 *   anchoring: coverage alone is not adoption, and the most specific term
 *   must be present as a word of its own, so a compound-internal partial
 *   match (사용자 only inside 사용자등록) cannot adopt a source by itself.
 *   Article numbers are not lexical terms here at all (see the function
 *   body): they are identities, judged through `explicit` only. A
 *   compound sanction term also counts when its own act is spelled split
 *   in one operative sentence (splitActionMatches); halves scattered
 *   across sentences, negated, or merely quoted do not.
 *   A title adopts under exactly the same standard as a body (F1 M1: a body
 *   that splits a compound across particles — 명예를 훼손한 for 명예훼손 —
 *   must not drop an article whose own title names the issue; a partial
 *   title — 명예훼손 inside 명예훼손분쟁조정부 — still promotes nothing).
 * - (B) When the issue names no subject at all (every term is a generic
 *   procedure/effect word or an actor word), (A) cannot discriminate regimes
 *   and is replaced, not supplemented: the same body or title must anchor at
 *   least one of the issue's own terms AND at least one subject term of the
 *   whole request (`requestTerms`: the user's question plus the sibling
 *   issues' terms). Subject terms alone never adopt — the issue term is
 *   still required — and when the request names no subject, (A) applies.
 * - Title-subject guard, on articles only: a title that names the issue's
 *   term but also an unexplained subject (a token neither the issue, the
 *   request, a generic word, an actor word, nor a law name explains) is about
 *   a different subject (국기·국장 모욕 for a workplace insult; 비밀준수의무
 *   for a harassment-measures issue) and is not direct evidence for this
 *   issue, however its body reads. A title with no issue term (벌칙) is
 *   untouched by the guard. Candidates are unaffected — only adoption.
 *   A disjunctive title (또는/혹은) is vetoed only when no branch matches:
 *   법정 또는 국회회의장모욕 is kept for a 법정 모욕 issue via its 법정 branch.
 * - (F) An unread question (fallback: no interpreted issue) cannot use (A):
 *   one issue bundles every aspect the question asked, so a strict majority
 *   over all its terms is unreachable, and question scaffolding used to
 *   hijack the longest term. (F) replaces (A) for that issue only: at least
 *   two of its terms anchored in the source text, including at least one
 *   subject term of the question itself — or, for a one-term question, that
 *   single term anchored and itself a subject. A single shared generic word
 *   (조사 alone) still adopts nothing, and a subject-free question adopts
 *   nothing. The title guard and the excerpt requirement apply unchanged.
 * - An article with no excerpt text is never adopted: the UI cannot display
 *   it, so adopting it would show "근거 확인" with "표시 근거 없음" underneath.
 */
export function researchEvidenceSources(text: string, query: string, enrichment?: ResearchEnrichment, requestTerms?: readonly string[],
  options?: { fallback?: boolean }): {
  articles: Array<{ law: string; jo: string }>; precedents: string[];
} {
  const allTerms = questionTerms(query).filter((term) => !isLawName(term));
  /**
   * An article number is an identity, not a lexical subject: it must never
   * become the longest term a body has to anchor (a body never repeats its
   * own number), and it must never count toward lexical coverage. Identity
   * adoption travels through the caller's `explicit` flag instead. A
   * question with no lexical term left adopts only an explicit article
   * whose number it actually named — never a lexical look-alike, and
   * never a sibling article's number.
   */
  const joTerms = allTerms.filter((term) => JO_TERM.test(term));
  const terms = allTerms.filter((term) => !JO_TERM.test(term));
  if (!terms.length) {
    const explicit = (enrichment?.supplement?.articles ?? [])
      .filter((article) => (article as SupplementArticle).explicit && article.excerpt.trim()
        && joTerms.includes(article.jo));
    if (!explicit.length) return { articles: [], precedents: [] };
    const namedForExplicit = [...new Set([...questionTerms(query).filter((term) => isLawName(term) && !BARE_LAW_TERM.has(term)),
      ...(requestTerms ?? []).filter((term) => isLawName(term) && !BARE_LAW_TERM.has(term))])];
    const allowed = (law: string) => !namedForExplicit.length || namedForExplicit.some((named) =>
      sameLawFamily(law, named) || (compactLaw(law).endsWith(compactLaw(named)) && compact([query, ...(requestTerms ?? [])].join(" "))
        .includes(compactLaw(law).slice(0, compactLaw(law).length - compactLaw(named).length))));
    return { articles: explicit.filter((article) => allowed(article.law)).map(({ law, jo }) => ({ law, jo })), precedents: [] };
  }
  /**
   * Laws the request itself named (the question plus every issue phrase).
   * When the user named a regime, an article of an unrelated regime is not
   * confirmation for their issue, however its body reads: a 식품위생법
   * 영업정지 question adopted 미술진흥법 제19조 on the single shared word
   * 영업정지. A named law's own subordinate laws (식품위생법 시행령·
   * 시행규칙) and a parent law of a named subordinate law share the compact
   * name as a prefix, so they stay admissible; spacing differences in the
   * official name (개인정보보호법 vs 개인정보 보호법) are compacted away.
   * No named law means no restriction, as before.
   */
  const namedLaws = [...new Set([...questionTerms(query).filter((term) => isLawName(term) && !BARE_LAW_TERM.has(term)),
    ...(requestTerms ?? []).filter((term) => isLawName(term) && !BARE_LAW_TERM.has(term))])];
  // The question's own words, for reconstructing a spaced official name:
  // "개인정보 보호법" tokenizes to "보호법", which must not reject the
  // question's own law ("개인정보보호법") — nor admit a different
  // "보호법" regime by suffix alone. A candidate law matches a named
  // token by family, or by suffix when the question itself supplies the
  // missing prefix ("개인정보").
  const questionWords = compact([query, ...(requestTerms ?? [])].join(" "));
  const lawMatches = (law: string, named: string) => {
    if (sameLawFamily(law, named)) return true;
    const cl = compactLaw(law), cn = compactLaw(named);
    if (!cl.endsWith(cn) || cl === cn) return false;
    const prefix = cl.slice(0, cl.length - cn.length);
    return prefix.length > 0 && questionWords.includes(prefix);
  };
  const lawAllowed = (law: string) => !namedLaws.length || namedLaws.some((named) => lawMatches(law, named));
  const request = [...new Set((requestTerms ?? []).filter((term) => !isLawName(term) && !JO_TERM.test(term)))];
  const subjectTerms = request.filter((term) => !terms.includes(term) && isSubjectTerm(term));
  // A single generic word ("정지" alone) names no subject and no regime:
  // one occurrence of it in an article must not adopt that article. Such an
  // issue stays unverified until a subject term or a second signal arrives.
  // Explicitly named law + article pairs are exempt: the user asked for them.
  const singleGeneric = terms.length === 1 && !isSubjectTerm(terms[0]);
  const subjectLess = terms.every((term) => GENERIC_TERMS.has(term) || ACTOR_TERMS.has(term));
  const useDomainRule = subjectLess && subjectTerms.length > 0;
  const combined = [...new Set([...terms, ...subjectTerms])];
  const longest = Math.max(...terms.map((term) => term.length));
  // For an unread question the request is the issue itself, so its subjects
  // come from its own terms rather than from sibling issues.
  const fallbackSubjects = options?.fallback
    ? terms.filter(isSubjectTerm) : [];
  const addresses = (content: string) => {
    if (!content.trim()) return false;
    // A split act counts as anchored for the term it spells out, under the
    // same guards splitActionMatches applies — it is the term's own act,
    // not a partial match inside an unrelated compound.
    const anchoredOrSplit = (term: string, pool: readonly string[]) => termAnchored(term, pool, content) || splitActionMatches(term, content);
    if (options?.fallback) {
      const anchored = terms.filter((term) => anchoredOrSplit(term, terms));
      return anchored.length >= Math.min(2, terms.length) && anchored.some((term) => fallbackSubjects.includes(term));
    }
    if (useDomainRule) {
      return terms.some((term) => anchoredOrSplit(term, combined))
        && subjectTerms.some((term) => anchoredOrSplit(term, combined));
    }
    const compacted = compact(content);
    const matched = terms.filter((term) => termOccurs(term, compacted));
    const splitMatched = terms.filter((term) => !matched.includes(term) && splitActionMatches(term, content));
    // A user's situation word ("미지급": the payment did not happen) names
    // the same provision as its stem ("지급"): statutes state the duty,
    // not the user's breach state. The stem counts toward the majority so
    // a non-payment issue can adopt its payment provisions, but it never
    // satisfies the longest-term anchor on its own, and at least one term
    // must match in full or as a split act — a bare stem alone adopts
    // nothing. No question-specific word list: any 미-prefixed term whose
    // stem (2+ characters) occurs in the text qualifies.
    const stemMatched = terms.filter((term) => !matched.includes(term) && !splitMatched.includes(term)
      && term.startsWith("미") && term.length >= 3 && termOccurs(term.slice(1), compacted));
    const allMatched = [...matched, ...splitMatched, ...stemMatched];
    return (matched.length + splitMatched.length) >= 1 && allMatched.length >= strictMajority(terms.length)
      && allMatched.some((term) => term.length === longest && (termAnchored(term, terms, content) || splitMatched.includes(term)));
  };
  const addressesTitle = (title: string | undefined) => title?.trim() ? addresses(title) : false;
  const stripTerms = [...new Set([...terms, ...request, ...GENERIC_TERMS, ...ACTOR_TERMS, ...FRAME_WORDS])];
  const articles = [
    ...researchResult(text).sections.filter((section) => section.status === "available").flatMap((section) => section.articles ?? []),
    ...(enrichment?.supplement?.articles ?? []),
  ].filter((article) => {
    if (!article.excerpt.trim()) return false;
    if (!lawAllowed(article.law)) return false;
    // A single generic word alone names no subject — but when the domain
    // rule already applies, adoption needs TWO anchored signals (the issue
    // term plus a request subject term), which is exactly the second
    // signal this veto demands. The veto then only blocks the lone-word
    // case (V5-F1b: a holding that confirms both 손해배상 and 명예훼손
    // must not be vetoed for the generic word alone).
    if (singleGeneric && !namedLaws.length && !useDomainRule && !(article as SupplementArticle).explicit) return false;
    // An article fetched because the request named exactly this law + number
    // is adopted by identity: its fetched text exists, so term matching
    // (which the article's own number never appears in) and the title guard
    // must not veto the very source the user asked about. The caller only
    // marks articles explicit for issues that named the pair or, for a
    // subject-less issue, whose text carries the delegation the issue asks
    // about — the flag never reaches an unrelated issue.
    if ((article as SupplementArticle).explicit) return true;
    const title = article.title;
    if (title && terms.some((term) => termInText(term, title)) && titleVetoed(title, stripTerms)) {
      // A replacement/implementation clause can introduce a new title noun.
      // Require both topical body text and an operative citation, not a token whitelist.
      if (!addresses(article.excerpt) || !/제\d+조[^.\n]{0,100}(?:따라|해당|갈음|정하는)/u.test(article.excerpt)) return false;
    }
    // A definition title never adopts on its title alone: the body itself
    // must address the issue, or the definition would stand in for the
    // substantive provision (e.g. a 정의 article for a 정지-요건 question).
    if (isDefinitionTitle(title)) return addresses(article.excerpt);
    return addresses(article.excerpt) || addressesTitle(title);
  }).map(({ law, jo }) => ({ law, jo }));
  const precedents = Object.entries(enrichment?.precedents ?? {})
    .filter(([id, { rank }]) => {
      if (rank !== "direct" && rank !== "related") return false;
      // Judged on the holding text itself when it was read. A ranking whose
      // text is unavailable cannot be citation-verified: the matched-term
      // list is the question's own terms, so judging it would only verify
      // the question against itself. Such a precedent stays a candidate.
      const excerpt = enrichment?.precedentExcerpts?.[id];
      if (excerpt === undefined || !addresses(excerpt)) return false;
      if (singleGeneric && !namedLaws.length && !useDomainRule) return false;
      // A named regime needs positive evidence in the holding itself —
      // but absence of a statute mention is not evidence of another
      // regime. A holding anchored in a different statute (an
      // e-commerce-act holding cited for a food-hygiene question) is
      // not direct evidence for the named regime; a holding that names
      // no statute at all stays adopted, and a holding that names the
      // named regime stays adopted as before. Constitutional mentions
      // alone do not anchor a holding to a regime, so 헌법 is ignored
      // when collecting anchors. Ranking.matched is derived data and
      // cannot prove a citation.
      if (!namedLaws.length) return true;
      const anchors = lawNameRunsInText(excerpt)
        .map((run) => run.replace(/^구/u, ""))
        .filter((run) => run !== "" && run !== "헌법");
      if (!anchors.length) return true;
      return anchors.some((cited) => namedLaws.some((named) => lawMatches(cited, named)));
    })
    .map(([id]) => id);
  return { articles, precedents };
}

/** Whether verified source content addresses an interpreted issue. */
export function hasRelevantResearchEvidence(text: string, query: string, enrichment?: ResearchEnrichment, requestTerms?: readonly string[],
  options?: { fallback?: boolean }): boolean {
  const sources = researchEvidenceSources(text, query, enrichment, requestTerms, options);
  return sources.articles.length > 0 || sources.precedents.length > 0;
}
