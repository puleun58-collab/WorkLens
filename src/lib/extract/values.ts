import type { ExtractValueType } from "@/domain/extract";

/**
 * Value typing and normalisation.
 *
 * The document's wording is the value; a normalised form is added only when
 * the reading is beyond doubt (an ISO-shaped date, a plain percentage). Units
 * whose scale has to be guessed — 만원, 억원, 천 단위 shorthand — are typed but
 * never converted, because a wrong conversion is a wrong number.
 */
const EMAIL = /^[\w.+-]+@[\w-]+\.[\w.-]+$/;
const URL = /^(?:https?:\/\/|www\.)\S+$/i;
const PHONE = /^(?:\+?\d{1,3}[-.\s]?)?(?:0\d{1,2}|\d{2,3})[-.\s]?\d{3,4}[-.\s]?\d{4}$/;
const DATE_TIME = /^(\d{4})[-./년]\s*(\d{1,2})[-./월]\s*(\d{1,2})일?\s*(\d{1,2})\s*[:시]\s*(\d{2})분?$/;
const DATE = /^(\d{4})[-./년]\s*(\d{1,2})[-./월]\s*(\d{1,2})일?$/;
const MONTH = /^(\d{4})[-./년]\s*(\d{1,2})월?$/;
const PERIOD = /(분기|반기|상반기|하반기|~|부터|까지)/u;
const MONEY = /(₩|\$|€|¥|원|달러|유로|엔|만원|억원|KRW|USD)/u;
const PERCENT = /^[-+]?\d[\d,.]*\s*(%|퍼센트)$/u;
const NUMBER = /^[-+]?\d[\d,]*(?:\.\d+)?\s*(?:건|명|개|시간|분|초|일|주|개월|년|회|배|km|kg|t|톤|GB|MB)?$/u;
const CODE = /^[A-Z]{2,}(?:[-_ ]?\w+)+$|^[A-Z]+\d+(?::[A-Z]+\d+)?$/;

export function classifyValue(value: string): ExtractValueType {
  const text = value.trim();
  if (EMAIL.test(text)) return "Email";
  if (URL.test(text)) return "Url";
  if (DATE_TIME.test(text)) return "DateTime";
  if (DATE.test(text)) return "Date";
  if (PERCENT.test(text)) return "Percent";
  if (MONEY.test(text) && /\d/.test(text)) return "Money";
  if (MONTH.test(text) || PERIOD.test(text)) return "Period";
  if (PHONE.test(text.replaceAll(" ", ""))) return "Phone";
  if (NUMBER.test(text)) return "Number";
  if (CODE.test(text)) return "Code";
  return "Text";
}

const pad = (value: string): string => value.padStart(2, "0");

/**
 * A machine-readable form of the same value, or nothing. Returning nothing is
 * the normal case: export and filtering benefit from a normalised date, and
 * from little else that can be derived without assuming a scale.
 */
export function normalizeValue(value: string, type: ExtractValueType): string | undefined {
  const text = value.trim();
  if (type === "Date") {
    const match = DATE.exec(text);
    return match ? `${match[1]}-${pad(match[2])}-${pad(match[3])}` : undefined;
  }
  if (type === "DateTime") {
    const match = DATE_TIME.exec(text);
    return match ? `${match[1]}-${pad(match[2])}-${pad(match[3])}T${pad(match[4])}:${match[5]}` : undefined;
  }
  if (type === "Period") {
    const match = MONTH.exec(text);
    return match ? `${match[1]}-${pad(match[2])}` : undefined;
  }
  if (type === "Percent") {
    const numeric = Number(text.replace(/[^\d.-]/gu, ""));
    return Number.isFinite(numeric) ? String(numeric) : undefined;
  }
  if (type === "Number") {
    const numeric = Number(text.replace(/[^\d.-]/gu, ""));
    // A trailing counter word ("12명") is part of the value, not of the number,
    // so only a bare numeral normalises.
    return Number.isFinite(numeric) && /^[-+]?[\d,.]+$/.test(text) ? String(numeric) : undefined;
  }
  return undefined;
}
