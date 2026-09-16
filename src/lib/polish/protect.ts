import type { PolishRejection } from "@/domain/polish";

/**
 * Deterministic guard for polished prose.
 *
 * The prompt asks the model to preserve facts; this module verifies it. Every
 * value a business document is read for — amounts, dates, times, percentages,
 * units, identifiers, addresses — must survive a rewrite unchanged, and so
 * must the strength of what the sentence claims. A rewrite that fails any of
 * these checks is discarded and the original text is kept.
 */

/** Values the reader acts on. A change here is a different document. */
const NUMBER = /\d[\d,.]*/g;
const PERCENT = /\d[\d,.]*\s*(?:%|퍼센트|percent)/gu;
const DATE = /\d{4}\s*[-./년]\s*\d{1,2}(?:\s*[-./월]\s*\d{1,2}\s*일?)?|\d{1,2}\s*월\s*\d{1,2}\s*일/gu;
const TIME = /\d{1,2}\s*:\s*\d{2}(?:\s*:\s*\d{2})?|\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?/gu;
const MONEY = /(?:₩|\$|€|¥|USD|KRW)\s*\d[\d,.]*|\d[\d,.]*\s*(?:원|달러|엔|유로|만원|억원)/gu;
const UNIT = /\d[\d,.]*\s*(?:km|m|cm|mm|kg|g|t|톤|개|건|명|시간|분|초|일|주|개월|년|배|회|GB|MB|KB|TB)/giu;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const URL = /(?:https?:\/\/|www\.)[^\s<>()"']+/gi;
/** Identifiers and codes: `WL-2026`, `SOP-Q3`, `ISO 27001`, `A1:B5`. */
const CODE = /\b[A-Z]{2,}(?:[-_ ]?\d+)+\b|\b[A-Z]+\d+(?::[A-Z]+\d+)?\b/g;
/** Straight and typographic quotation, plus Korean corner brackets. */
const QUOTE = /"([^"]{2,})"|“([^”]{2,})”|'([^']{3,})'|‘([^’]{3,})’|「([^」]{2,})」/gu;

/**
 * Strength markers. Polishing may change the wording of a sentence but not
 * what it commits its author to: a possibility must not become a fact, a
 * request must not become an order, a negation must not disappear.
 */
const MODALITY: Record<string, RegExp> = {
  possibility: /(가능성|수도\s*있|을\s*수\s*있|ㄹ\s*수\s*있|것으로\s*보|추정|예상|전망|듯|may|might|could)/u,
  obligation: /(해야|하여야|필수|의무|반드시|must|required)/u,
  recommendation: /(권고|권장|바랍니다|바라며|제안|검토\s*필요|should|recommend)/u,
  request: /(부탁|요청|주시기|주세요|please)/u,
  plan: /(예정|계획|목표|will|plan)/u,
  negation: /(않|없|못|아니|불가|no\s|not\s)/u,
};

function collect(text: string, pattern: RegExp): string[] {
  const normalized = text.normalize("NFKC");
  const matches = normalized.match(pattern) ?? [];
  return matches
    .map((value) => value.replace(/\s+/gu, "").replaceAll(",", "").toLowerCase())
    .sort();
}

function quotes(text: string): string[] {
  const found: string[] = [];
  for (const match of text.normalize("NFKC").matchAll(QUOTE)) {
    const body = match.slice(1).find((group) => typeof group === "string");
    if (body) found.push(body.replace(/\s+/gu, " ").trim());
  }
  return found.sort();
}

/** Content tokens, used to measure how much of the original survived. */
function contentTokens(text: string): string[] {
  return (text.normalize("NFKC").toLocaleLowerCase("ko-KR").match(/[0-9]+|[a-z]+|[가-힣]{2,}/gu) ?? []);
}

export interface ProtectedTokens {
  numbers: string[];
  percents: string[];
  dates: string[];
  times: string[];
  money: string[];
  units: string[];
  emails: string[];
  urls: string[];
  codes: string[];
  quotes: string[];
}

export function protectedTokens(text: string): ProtectedTokens {
  return {
    numbers: collect(text, NUMBER),
    percents: collect(text, PERCENT),
    dates: collect(text, DATE),
    times: collect(text, TIME),
    money: collect(text, MONEY),
    units: collect(text, UNIT),
    emails: collect(text, EMAIL),
    urls: collect(text, URL),
    codes: collect(text, CODE),
    quotes: quotes(text),
  };
}

export interface PolishVerdict {
  ok: boolean;
  rejection?: PolishRejection;
  /** Which guard fired, for the result detail line. */
  detail?: string;
}

/**
 * Compares a rewrite against its original. Returns the first violation found,
 * because one is enough to keep the original text.
 */
export function verifyPolish(original: string, revised: string): PolishVerdict {
  if (revised.trim().length === 0) return { ok: false, rejection: "empty" };

  const before = protectedTokens(original);
  const after = protectedTokens(revised);
  for (const key of ["numbers", "percents", "dates", "times", "money", "units", "emails", "urls", "codes"] as const) {
    if (before[key].join("|") !== after[key].join("|")) {
      return { ok: false, rejection: "protected-token", detail: key };
    }
  }
  // Quotation is the author's, not the model's: it must come through verbatim.
  if (before.quotes.join("|") !== after.quotes.join("|")) {
    return { ok: false, rejection: "quote" };
  }
  for (const [name, pattern] of Object.entries(MODALITY)) {
    if (pattern.test(original) !== pattern.test(revised)) {
      return { ok: false, rejection: "modality", detail: name };
    }
  }
  // Minimal edit: a rewrite that keeps little of the original is a new text,
  // and a new text can carry facts the original never had.
  const originalTokens = contentTokens(original);
  if (originalTokens.length >= 4) {
    const kept = new Set(contentTokens(revised));
    const retained = originalTokens.filter((token) => kept.has(token)).length / originalTokens.length;
    if (retained < 0.5) return { ok: false, rejection: "over-edit", detail: retained.toFixed(2) };
  }
  return { ok: true };
}
