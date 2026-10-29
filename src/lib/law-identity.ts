/**
 * Structured law + article identities parsed once from the user's own
 * question text — never reassembled from generic subject tokens.
 *
 * `questionTerms` splits "개인정보 보호법" into "개인정보" + "보호법", and
 * the second fragment alone is not the law the user named: it fails an
 * exact official-name match and it is not the same regime as every other
 * "보호법". The helpers here read the raw question instead: a law name is
 * the token (or, for a short fragment such as 보호법, the token plus its
 * immediately preceding modifier) that ends in a law suffix, and a 조
 * number belongs to the most recent such law. A candidate joined name is
 * only a lookup key: callers confirm it against the official index with a
 * compact exact match, and keep the fragment as a fallback key, so a
 * wrong join can never invent a law — it can only fail to resolve, and
 * then the fragment is tried.
 *
 * A bare subordinate-law noun (시행령, 대통령령, …) names no regime of
 * its own: it never becomes the law a following 조 belongs to, and it
 * never blocks an otherwise unique parent pair.
 */

/** Bare subordinate-law nouns: a reference to "the" subordinate law, not a law name. */
export const BARE_SUBORDINATE_LAWS = new Set(["시행령", "시행규칙", "법령", "대통령령", "총리령", "부령"]);

export function isBareSubordinateLaw(name: string): boolean {
  return BARE_SUBORDINATE_LAWS.has(name);
}

export interface LawNameCandidate {
  /** Primary name: the joined spaced name when one was formed, else the token itself. */
  name: string;
  /** The short fragment the primary was joined from, for exact-match fallback. */
  fallback?: string;
}

export interface ExplicitIdentity {
  law: string;
  jo: string;
  /** Fragment fallback for a joined law name (see LawNameCandidate). */
  lawAlt?: string;
}

const TOKEN_SPLIT = /[\s,.;:·!?()「」『』"'“”‘’/[\]{}<>※—-]+/u;
const LAW_SUFFIX = /(?:법률|법|시행령|시행규칙|조례)$/u;
/** Words that can never be the modifier half of a spaced official name. */
const MODIFIER_STOP = new Set([
  "관련", "관계", "해당", "같은", "본", "당", "위", "아래", "각", "모든", "전체",
  "기준", "방법", "절차", "요건", "근거", "여부", "내용", "경우", "및", "등",
  "알려줘", "알려주세요", "궁금해", "궁금해요", "대해", "관해", "위한", "대한", "관한",
]);
const PARTICLE_TAIL = /(?:에서|으로|로|에게|한테|의|을|를|이|가|은|는|과|와|도|만|까지|부터)$/u;
const JO_TOKEN = /^제([1-9]\d{0,3})조(?:의([1-9]\d?))?(.*)$/u;

/** Strip a locative `상` and a trailing particle from a law token, if one is present. */
function cleanLawToken(raw: string): string {
  let token = raw.replace(/^(.+(?:법|법률|령|규칙|조례))상$/u, "$1");
  if (LAW_SUFFIX.test(token)) {
    const stripped = token.replace(PARTICLE_TAIL, "");
    if (stripped && LAW_SUFFIX.test(stripped)) token = stripped;
  }
  return token;
}

function isLawToken(token: string): boolean {
  return token.length >= 3 && LAW_SUFFIX.test(token);
}

/** Whether `token` may be the modifier half of a spaced law name. */
function isModifier(token: string): boolean {
  if (token.length < 2 || MODIFIER_STOP.has(token)) return false;
  if (PARTICLE_TAIL.test(token)) return false;
  if (isLawToken(token)) return false;
  if (JO_TOKEN.test(token)) return false;
  return true;
}

/**
 * Law names the raw question names, in order. A short (3-character) law
 * fragment preceded by an eligible modifier is joined with it
 * ("개인정보" + "보호법" → "개인정보보호법", fragment kept as fallback);
 * longer law tokens and bare subordinate nouns are never joined.
 */
export function lawNameCandidates(query: string): LawNameCandidate[] {
  const candidates: LawNameCandidate[] = [];
  const tokens = query.split(TOKEN_SPLIT).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const token = cleanLawToken(tokens[i]);
    if (!isLawToken(token) || isBareSubordinateLaw(token)) continue;
    // A full subordinate-law name (…법시행령) is one name, not a bare noun.
    if (token.length === 3 && token.endsWith("법") && i > 0) {
      const prev = tokens[i - 1];
      if (isModifier(prev)) {
        const joined = `${prev}${token}`;
        if (!candidates.some((c) => c.name === joined)) candidates.push({ name: joined, fallback: token });
        continue;
      }
    }
    if (!candidates.some((c) => c.name === token)) candidates.push({ name: token });
  }
  return candidates;
}

/** Primary law names only (see lawNameCandidates). */
export function lawNamesInQuery(query: string): string[] {
  return lawNameCandidates(query).map((c) => c.name);
}

/**
 * (law, article) pairs the raw question names, in order: each 조 belongs
 * to the most recent law name before it. A bare subordinate noun neither
 * becomes that law nor resets it, so "개인정보보호법 제38조와 그 시행령"
 * keeps 제38조 on the parent law and a bare "시행령" after a 조 never
 * steals the next 조. No number is invented and no pair is guessed.
 */
export function parseExplicitIdentities(query: string): ExplicitIdentity[] {
  const pairs: ExplicitIdentity[] = [];
  const tokens = query.split(TOKEN_SPLIT).filter(Boolean);
  let lastLaw: string | undefined;
  let lastAlt: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = cleanLawToken(tokens[i]);
    if (isLawToken(token) && !isBareSubordinateLaw(token)) {
      if (token.length === 3 && token.endsWith("법") && i > 0 && isModifier(tokens[i - 1])) {
        lastLaw = `${tokens[i - 1]}${token}`;
        lastAlt = token;
      } else {
        lastLaw = token;
        lastAlt = undefined;
      }
      continue;
    }
    const jo = JO_TOKEN.exec(tokens[i]);
    if (jo && !jo[3]) {
      const joText = `제${jo[1]}조${jo[2] ? `의${jo[2]}` : ""}`;
      if (lastLaw && !pairs.some((pair) => pair.law === lastLaw && pair.jo === joText)) {
        pairs.push({ law: lastLaw, jo: joText, ...(lastAlt ? { lawAlt: lastAlt } : {}) });
      }
      continue;
    }
    // A 조 token with a particle tail ("제38조의", "제38조와") still counts:
    // the tail is a particle, not another number.
    if (jo && PARTICLE_TAIL.test(jo[3])) {
      const joText = `제${jo[1]}조${jo[2] ? `의${jo[2]}` : ""}`;
      if (lastLaw && !pairs.some((pair) => pair.law === lastLaw && pair.jo === joText)) {
        pairs.push({ law: lastLaw, jo: joText, ...(lastAlt ? { lawAlt: lastAlt } : {}) });
      }
    }
  }
  return pairs;
}
