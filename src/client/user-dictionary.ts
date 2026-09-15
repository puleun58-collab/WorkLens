/**
 * Personal dictionary and rule-ignore state.
 *
 * Only user-typed term strings and rule identifiers are persisted. Document
 * text, parsed content, findings and source evidence are never written to
 * localStorage, and nothing here is ever sent to the server.
 */
const TERMS_KEY = "worklens:user-dictionary:v1";
const IGNORED_RULES_KEY = "worklens:ignored-rules:v1";
const MAX_TERMS = 500;
const MAX_TERM_LENGTH = 64;

function readList(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  } catch {
    return [];
  }
}

function writeList(key: string, values: readonly string[]): string[] {
  const stored = values.slice(0, MAX_TERMS);
  if (typeof window === "undefined") return [...stored];
  try {
    window.localStorage.setItem(key, JSON.stringify(stored));
  } catch {
    // Private mode or a full quota must never break the review flow.
  }
  return [...stored];
}

export function readUserTerms(): string[] {
  return readList(TERMS_KEY);
}

export function addUserTerm(term: string): string[] {
  const trimmed = term.trim().slice(0, MAX_TERM_LENGTH);
  if (!trimmed) return readUserTerms();
  const current = readUserTerms();
  if (current.some((entry) => entry.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) return current;
  return writeList(TERMS_KEY, [...current, trimmed]);
}

export function removeUserTerm(term: string): string[] {
  return writeList(TERMS_KEY, readUserTerms().filter((entry) => entry !== term));
}

export function clearUserTerms(): string[] {
  return writeList(TERMS_KEY, []);
}

export function readIgnoredRules(): string[] {
  return readList(IGNORED_RULES_KEY);
}

export function toggleIgnoredRule(ruleId: string): string[] {
  const current = readIgnoredRules();
  return writeList(
    IGNORED_RULES_KEY,
    current.includes(ruleId) ? current.filter((entry) => entry !== ruleId) : [...current, ruleId],
  );
}

export function clearIgnoredRules(): string[] {
  return writeList(IGNORED_RULES_KEY, []);
}
