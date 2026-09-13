/**
 * Single canonical numeric parser shared by comparison and deterministic analysis.
 *
 * Rules are locale-independent and deliberately refuse ambiguity rather than guessing:
 * - Repeated three-digit groups after a single separator kind are thousands separators.
 * - A single separator followed by exactly three digits is ambiguous and is refused.
 * - Mixed `,` and `.` use the last separator as the decimal mark.
 * - Parentheses denote a negative value; a trailing `%` scales by 1/100.
 */
export interface CanonicalNumber {
  value: number;
  format: string;
}

const NUMERIC_SHAPE = /^([+-]?)([\d,.\s]+)(%?)$/;

export function parseCanonicalNumber(input: string): CanonicalNumber | undefined {
  const text = input.trim();
  if (!text || /[a-z]/i.test(text) || /\s/.test(text)) return undefined;

  const startsParenthesis = text.startsWith("(");
  const endsParenthesis = text.endsWith(")");
  if (startsParenthesis !== endsParenthesis) return undefined;
  const negative = startsParenthesis && endsParenthesis;
  const stripped = negative ? text.slice(1, -1) : text;
  const match = NUMERIC_SHAPE.exec(stripped);
  if (!match) return undefined;

  const [, sign, body, percent] = match;
  if (!body.replace(/[,.\s]/g, "")) return undefined;

  const normalized = normalizeSeparators(body.replace(/\s/g, ""));
  if (normalized === undefined) return undefined;

  const parsed = Number(`${sign}${normalized}`);
  if (!Number.isFinite(parsed)) return undefined;

  const signed = negative ? -Math.abs(parsed) : parsed;
  return {
    value: percent ? signed / 100 : signed,
    format: percent ? "percent" : displayFormat(text),
  };
}

function normalizeSeparators(value: string): string | undefined {
  const separators = value.match(/[,.]/g) ?? [];
  if (separators.length === 0) return value;

  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");
  const hasBoth = lastComma >= 0 && lastDot >= 0;

  if (hasBoth) {
    const decimal = Math.max(lastComma, lastDot);
    const decimalSeparator = value[decimal];
    const groupingSeparator = decimalSeparator === "," ? "." : ",";
    const integer = value.slice(0, decimal);
    const fraction = value.slice(decimal + 1);
    const groups = integer.split(groupingSeparator);
    if (
      fraction.length === 0 ||
      !/^\d+$/.test(fraction) ||
      groups.length < 2 ||
      groups[0].length < 1 ||
      groups[0].length > 3 ||
      !groups.every((group, index) => /^\d+$/.test(group) && (index === 0 || group.length === 3))
    ) {
      return undefined;
    }
    return `${groups.join("")}.${fraction}`;
  }

  const separator = lastComma >= 0 ? "," : ".";
  const groups = value.split(separator);
  const grouped =
    groups.length > 1 &&
    groups[0].length >= 1 &&
    groups[0].length <= 3 &&
    groups.slice(1).every((group) => group.length === 3);

  // `1,234,567` is unambiguously grouped; a lone `1,234` could be either reading.
  if (separators.length > 1) return grouped ? groups.join("") : undefined;
  return grouped ? undefined : value.replace(separator, ".");
}

/** Describes how a value is rendered, used to detect inconsistent column formatting. */
export function displayFormat(value: string): string {
  if (/^\(.*\)$/.test(value)) return "parentheses";
  if (value.includes(",") && value.includes(".")) return "mixed-separators";
  if (value.includes(",")) return "comma";
  if (value.includes(".")) return "dot";
  return "integer";
}
