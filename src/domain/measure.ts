/**
 * Decides whether two values are comparable measurements before any arithmetic.
 *
 * A number on screen is not automatically a quantity: `9월 → 10월`, `v1 → v2`,
 * `문서번호 1001 → 1002` and `2026.09.30 → 2026.10.28` all contain digits and
 * none of them has a difference worth showing. A delta is produced only when
 * both sides carry the same unit of the same kind, so the arithmetic answers a
 * question the reader actually asked.
 */
export type MeasureKind = "money" | "percent" | "count" | "plain";

export interface Measure {
  value: number;
  /** Canonical unit text, empty for a bare number. */
  unit: string;
  kind: MeasureKind;
  /** Currency and similar units that precede the number. */
  prefixed: boolean;
  /** The numeral exactly as written, so a stricter reader can re-validate it. */
  numberText: string;
}

export interface MeasureDelta {
  difference: number;
  changePercent: number | null;
  unit: string;
  kind: MeasureKind;
  /** The difference as the reader sees it, including unit or percentage points. */
  text: string;
}

const PREFIX_UNITS = ["₩", "$", "€", "¥"] as const;
const MONEY_UNITS = ["조원", "억원", "만원", "천원", "원", "달러", "유로", "엔", "krw", "usd", "eur", "jpy"] as const;
const COUNT_UNITS = [
  "명", "건", "개", "대", "회", "매", "부", "쪽", "종", "곳", "팀", "인",
  "시간", "분", "초", "개월", "주",
  "kg", "g", "t", "톤", "km", "m", "cm", "mm", "gb", "mb", "kb", "㎡", "㎥", "배", "점",
] as const;
/** Units that label a position in a sequence; their numbers are not amounts. */
const ORDINAL_UNITS = ["년", "월", "일", "기", "차", "호", "번", "차수", "분기", "쪽수", "page", "p"] as const;

const NUMBER_SHAPE = /^[+-]?\d[\d,]*(?:\.\d+)?$/u;
const DATE_LIKE = /\d{4}\s*[-./년]\s*\d{1,2}|\d{1,2}\s*[-./월]\s*\d{1,2}\s*일?|\d{1,2}:\d{2}/u;
const VERSION_LIKE = /(?:^|\s)(?:v|ver|version|rev|no)\.?\s*\d/iu;
const CODE_LIKE = /[A-Za-z]{1,}[-_]?\d+|\d+[-_][A-Za-z\d]+/u;

const parseNumber = (text: string): number | undefined => {
  if (!NUMBER_SHAPE.test(text)) return undefined;
  const value = Number(text.replaceAll(",", ""));
  return Number.isFinite(value) ? value : undefined;
};

/** Reads one measurement, or nothing when the text is not purely a measurement. */
export function parseMeasure(input: string): Measure | undefined {
  const text = input.normalize("NFKC").trim().replace(/(만|억|조)\s+(?=원)/u, "$1");
  if (!text || DATE_LIKE.test(text) || VERSION_LIKE.test(text)) return undefined;

  for (const unit of PREFIX_UNITS) {
    if (!text.startsWith(unit)) continue;
    const numberText = text.slice(unit.length).trim();
    const value = parseNumber(numberText);
    return value === undefined ? undefined : { value, unit, kind: "money", prefixed: true, numberText };
  }

  const percent = /^([+-]?[\d,]+(?:\.\d+)?)\s*(%p|%|퍼센트|포인트)$/u.exec(text);
  if (percent) {
    const value = parseNumber(percent[1]);
    return value === undefined ? undefined : { value, unit: "%", kind: "percent", prefixed: false, numberText: `${percent[1]}%` };
  }

  const suffix = /^([+-]?[\d,]+(?:\.\d+)?)\s*([^\d\s,.]\S{0,3})$/u.exec(text);
  if (suffix) {
    const value = parseNumber(suffix[1]);
    const unit = suffix[2].toLocaleLowerCase();
    if (value === undefined) return undefined;
    if (ORDINAL_UNITS.some((entry) => entry === unit)) return undefined;
    if (MONEY_UNITS.some((entry) => entry === unit)) return { value, unit: suffix[2], kind: "money", prefixed: false, numberText: suffix[1] };
    if (COUNT_UNITS.some((entry) => entry === unit)) return { value, unit: suffix[2], kind: "count", prefixed: false, numberText: suffix[1] };
    return undefined;
  }

  if (CODE_LIKE.test(text)) return undefined;
  const bare = parseNumber(text);
  return bare === undefined ? undefined : { value: bare, unit: "", kind: "plain", prefixed: false, numberText: text };
}

/**
 * The unit a reader would say aloud, taken from the words that follow the
 * number: `75명입니다` measures people, and `10월` measures nothing.
 */
const KNOWN_UNITS = [...MONEY_UNITS, ...COUNT_UNITS, ...ORDINAL_UNITS].slice().sort((left, right) => right.length - left.length);

function trailingUnit(text: string): string {
  const normalized = text.trimStart().replace(/^(만|억|조)\s+(?=원)/u, "$1");
  if (normalized.startsWith("%p")) return "%p";
  if (normalized.startsWith("%")) return "%";
  const lower = normalized.toLocaleLowerCase();
  return KNOWN_UNITS.find((unit) => lower.startsWith(unit)) ?? "";
}

const formatNumber = (value: number): string =>
  `${value > 0 ? "+" : value < 0 ? "-" : ""}${Math.abs(value).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}`;

function deltaText(difference: number, measure: Measure): string {
  const number = formatNumber(difference);
  if (measure.kind === "percent") return `${number}%p`;
  if (measure.prefixed) return `${difference < 0 ? "-" : "+"}${measure.unit}${Math.abs(difference).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}`;
  return measure.unit ? `${number}${measure.unit}` : number;
}

/** A delta exists only between two measurements of the same unit. */
export function measureDelta(previous: Measure | undefined, current: Measure | undefined): MeasureDelta | undefined {
  if (!previous || !current) return undefined;
  if (previous.kind !== current.kind) return undefined;
  if (previous.unit.toLocaleLowerCase() !== current.unit.toLocaleLowerCase()) return undefined;
  const difference = current.value - previous.value;
  return {
    difference,
    // Dividing by zero is not a percentage; it is a missing baseline.
    changePercent: previous.value === 0 ? null : (difference / previous.value) * 100,
    unit: current.unit,
    kind: current.kind,
    text: deltaText(difference, current),
  };
}

export function valueDelta(previous: string, current: string): MeasureDelta | undefined {
  return measureDelta(parseMeasure(previous), parseMeasure(current));
}

const NUMBER_TOKEN = /[+-]?\d[\d,]*(?:\.\d+)?/gu;

/** Everything but the numbers, so only sentences that differ in one number align. */
export function numberSkeleton(value: string): string {
  return value.toLocaleLowerCase().replace(/[+-]?\d[\d,.]*/gu, "#").replace(/\s+/gu, " ").trim();
}

/**
 * A measurement embedded in a sentence: the wording around it must be identical
 * and the number must carry a unit, so `참석 75명 → 참석 32명` is a change of 43
 * people while `9월 교육 계획 → 10월 교육 계획` is not a change of one.
 */
export function sentenceDelta(previous: string, current: string): MeasureDelta | undefined {
  if (numberSkeleton(previous) !== numberSkeleton(current)) return undefined;
  if (DATE_LIKE.test(previous) || DATE_LIKE.test(current)) return undefined;
  if (VERSION_LIKE.test(previous) || VERSION_LIKE.test(current)) return undefined;

  const measureIn = (text: string): Measure | undefined => {
    const normalized = text.normalize("NFKC");
    const matches = [...normalized.matchAll(NUMBER_TOKEN)];
    if (matches.length !== 1) return undefined;
    const match = matches[0];
    const start = match.index ?? 0;
    const before = normalized.slice(Math.max(0, start - 1), start);
    const after = normalized.slice(start + match[0].length).trimStart();
    const unit = trailingUnit(after);
    const candidate = PREFIX_UNITS.some((entry) => entry === before)
      ? `${before}${match[0]}`
      : `${match[0]}${unit}`;
    return parseMeasure(candidate);
  };

  const delta = measureDelta(measureIn(previous), measureIn(current));
  // A bare number inside prose has no unit to make it comparable.
  return delta && delta.kind === "plain" ? undefined : delta;
}
