import companyTermFile from "@/config/company-terms.json";

/**
 * Dictionaries only suppress false positives in spelling and terminology rules.
 * A protected term never silences duplication, privacy, numeric or structure findings.
 */
export type TermScope = "company" | "user";

export interface TermDictionaryProvider {
  readonly scope: TermScope;
  terms(): readonly string[];
}

export interface TermDictionary {
  /** True when the token is protected by the company or the personal dictionary. */
  has(token: string): boolean;
  scopeOf(token: string): TermScope | undefined;
  /** Canonical spelling registered in a dictionary, if the token is known. */
  canonical(token: string): string | undefined;
  companyTerms(): readonly string[];
  userTerms(): readonly string[];
}

/** Company terms ship as a static, Git-versioned file. Users cannot edit them at runtime. */
export const companyTermProvider: TermDictionaryProvider = {
  scope: "company",
  terms: () => companyTermFile.terms,
};

export function createUserTermProvider(terms: readonly string[]): TermDictionaryProvider {
  return { scope: "user", terms: () => terms };
}

/** NFKC + case folding so `WorkLens`, `worklens` and `ＷｏｒｋLens` collapse to one key. */
export function normalizeTerm(token: string): string {
  return token
    .normalize("NFKC")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .toLocaleLowerCase();
}

export function buildDictionary(providers: readonly TermDictionaryProvider[]): TermDictionary {
  const entries = new Map<string, { scope: TermScope; canonical: string }>();
  const company: string[] = [];
  const user: string[] = [];
  for (const provider of providers) {
    for (const term of provider.terms()) {
      const trimmed = term.trim();
      if (!trimmed) continue;
      (provider.scope === "company" ? company : user).push(trimmed);
      const key = normalizeTerm(trimmed);
      if (!key || entries.has(key)) continue;
      entries.set(key, { scope: provider.scope, canonical: trimmed });
      // Multi-word terms also protect each of their word parts ("ISO 27001" protects "ISO").
      if (/\s/u.test(trimmed)) {
        for (const part of trimmed.split(/\s+/u)) {
          const partKey = normalizeTerm(part);
          if (partKey && !entries.has(partKey)) entries.set(partKey, { scope: provider.scope, canonical: part });
        }
      }
    }
  }
  return {
    has: (token) => entries.has(normalizeTerm(token)),
    scopeOf: (token) => entries.get(normalizeTerm(token))?.scope,
    canonical: (token) => entries.get(normalizeTerm(token))?.canonical,
    companyTerms: () => company,
    userTerms: () => user,
  };
}

/**
 * Company terms come from the central D1 dictionary at runtime; the static file
 * is the seed and the fallback when that read fails.
 */
export function createDictionary(
  userTerms: readonly string[] = [],
  companyTerms?: readonly string[],
): TermDictionary {
  const company: TermDictionaryProvider = companyTerms
    ? { scope: "company", terms: () => companyTerms }
    : companyTermProvider;
  return buildDictionary([company, createUserTermProvider(userTerms)]);
}

const ACRONYM = /^[A-Z][A-Z0-9&.]{1,7}$/u;
const CODE_LIKE = /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const MIXED_CASE = /^[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+$/u;

/**
 * Conservative guard shared by spelling and casing rules: acronyms, system codes,
 * product names and dictionary terms are never treated as typos.
 */
export function isProtectedToken(token: string, dictionary: TermDictionary): boolean {
  const trimmed = token.trim();
  if (!trimmed) return true;
  if (dictionary.has(trimmed)) return true;
  if (trimmed.length <= 2) return true;
  if (ACRONYM.test(trimmed)) return true;
  if (CODE_LIKE.test(trimmed)) return true;
  if (MIXED_CASE.test(trimmed)) return true;
  return false;
}
