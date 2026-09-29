import type { DecisionDomain } from "@/lib/decision-domain";
import type { DecisionEntry } from "@/lib/decision-search";

/**
 * Official identifier formats per 판례·결정례 domain, taken from the numbers
 * 법제처 returns for each. A query is an identifier only when it is exactly
 * one such number; spaces between its parts carry no meaning and are removed.
 * Domains without a stable, unique number (관세청·국세청 have none, 노동위
 * numbers are masked, 권익위·소청 have too few observed formats) are absent:
 * they keep plain keyword search.
 */
interface IdentifierRule {
  /** Whole-query pattern, spaces allowed between parts. */
  query: RegExp;
  /** Text sent to the search; the upstream finds the number only in this form. */
  search: (value: string) => string;
  /** Comparison key for a query or a result's number; equal keys are the same decision. */
  key: (value: string) => string;
}

const compact = (value: string) => value.replace(/\s+/gu, "");

const RULES: Partial<Record<DecisionDomain, IdentifierRule>> = {
  // 2013다61381
  precedent: { query: /^\d{2,4}\s*[가-힣]{1,3}\s*\d+$/u, search: compact, key: compact },
  // 2022헌마1312
  constitutional: { query: /^\d{4}\s*헌[가-힣]{1,2}\s*\d+$/u, search: compact, key: compact },
  // 2013-01262 (leading zeros are part of the number and never added or removed)
  admin_appeal: { query: /^\d{4}\s*-\s*\d{5}$/u, search: compact, key: compact },
  // 06-0152
  interpretation: { query: /^\d{2}\s*-\s*\d{4}$/u, search: compact, key: compact },
  // 조심2012서3406 and 조심 2018광1070 are both returned; the space is not part of the number.
  tax_tribunal: { query: /^조심\s*\d{4}\s*[가-힣]{1,2}\s*\d+$/u, search: compact, key: compact },
  // 2011카총0367
  ftc: { query: /^\d{4}\s*[가-힣]{2,4}\s*\d{4}$/u, search: compact, key: compact },
  // Returned as 제2026-109-013호; the search finds it only without 제·호.
  pipc: {
    query: /^(?:제\s*)?\d{4}\s*-\s*\d{3}\s*-\s*\d{3}(?:\s*호)?$/u,
    search: (value) => compact(value).replace(/^제|호$/gu, ""),
    key: (value) => compact(value).replace(/^제|호$/gu, ""),
  },
};

export interface DecisionIdentifier {
  /** What the search request carries. */
  search: string;
  key: string;
}

export function decisionIdentifier(domain: DecisionDomain, query: string): DecisionIdentifier | null {
  const rule = RULES[domain];
  const trimmed = query.trim();
  if (!rule || !rule.query.test(trimmed)) return null;
  return { search: rule.search(trimmed), key: rule.key(trimmed) };
}

/** The query as the search should receive it: canonical for an identifier, untouched otherwise. */
export function decisionSearchQuery(domain: DecisionDomain, query: string): string {
  return decisionIdentifier(domain, query)?.search ?? query.trim();
}

/**
 * Splits a page of results into the decisions whose own number equals the
 * identifier and the rest; the same decision (domain + id) appears once.
 */
export function splitExactResults(domain: DecisionDomain, identifier: DecisionIdentifier, entries: readonly DecisionEntry[]): { exact: DecisionEntry[]; others: DecisionEntry[] } {
  const rule = RULES[domain]!;
  const seen = new Set<string>();
  const exact: DecisionEntry[] = [];
  const others: DecisionEntry[] = [];
  for (const entry of entries) {
    const id = `${entry.domain}\0${entry.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    (entry.caseNumber && rule.key(entry.caseNumber) === identifier.key ? exact : others).push(entry);
  }
  return { exact, others };
}
