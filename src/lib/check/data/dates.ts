import type { CheckFinding } from "@/domain/operations";
import { makeFinding, uniqueSources, type TextUnit } from "../types";

export interface DateOccurrence {
  raw: string;
  style: "dot" | "dash" | "slash" | "korean";
  year?: number;
  month: number;
  day: number;
  unit: TextUnit;
}

interface ReportingPeriod {
  raw: string;
  year: number;
  month: number;
  unit: TextUnit;
}

const DATE_PATTERNS: ReadonlyArray<{ style: DateOccurrence["style"]; regex: RegExp }> = [
  { style: "korean", regex: /\b(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\b/gu },
  { style: "dash", regex: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/gu },
  { style: "dot", regex: /\b(\d{4})\.(\d{1,2})\.(\d{1,2})\b/gu },
  { style: "slash", regex: /\b(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})\b/gu },
];

export function datesIn(unit: TextUnit): DateOccurrence[] {
  const occurrences: DateOccurrence[] = [];
  for (const { style, regex } of DATE_PATTERNS) {
    for (const match of unit.text.matchAll(new RegExp(regex.source, regex.flags))) {
      if (style === "slash") {
        occurrences.push({
          raw: match[0],
          style,
          ...(match[1] ? { year: Number(match[1]) } : {}),
          month: Number(match[2]),
          day: Number(match[3]),
          unit,
        });
      } else {
        occurrences.push({ raw: match[0], style, year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), unit });
      }
    }
  }
  return occurrences;
}

function validDate(date: DateOccurrence): boolean {
  if (date.month < 1 || date.month > 12 || date.day < 1) return false;
  const year = date.year ?? 2000;
  return date.day <= new Date(Date.UTC(year, date.month, 0)).getUTCDate();
}

function dateStyleLabel(style: DateOccurrence["style"]): string {
  return style === "korean" ? "YYYY년 M월 D일" : style === "dash" ? "YYYY-MM-DD" : style === "dot" ? "YYYY.MM.DD" : "M/D";
}

function reportingPeriods(units: readonly TextUnit[]): ReportingPeriod[] {
  const periods: ReportingPeriod[] = [];
  for (const unit of units) {
    for (const match of unit.text.matchAll(/\b(\d{4})년\s*(\d{1,2})월(?:\s*(?:보고서|보고|실적|계획|전망))?/gu)) {
      periods.push({ raw: match[0], year: Number(match[1]), month: Number(match[2]), unit });
    }
  }
  return periods;
}

export function dateFindings(units: readonly TextUnit[]): CheckFinding[] {
  const dates = units.flatMap(datesIn);
  const findings: CheckFinding[] = [];
  for (const date of dates.filter((entry) => !validDate(entry))) {
    findings.push(makeFinding({
      code: "impossible-date",
      ruleId: "data/date/impossible",
      category: "date",
      severity: "warning",
      confidence: "high",
      issue: "불가능한 날짜",
      message: `"${date.raw}"은(는) 달력에 존재하지 않는 날짜입니다.`,
      reason: "월 또는 일 값이 해당 연도의 달력 범위를 벗어납니다.",
      recommendation: "원본 자료에서 정확한 날짜를 확인해 수정하세요.",
      sources: [date.unit.source],
      originalText: date.raw,
    }));
  }

  const valid = dates.filter(validDate);
  const styles = new Map<DateOccurrence["style"], DateOccurrence[]>();
  for (const date of valid) styles.set(date.style, [...(styles.get(date.style) ?? []), date]);
  if (styles.size > 1) {
    const preferred = [...styles.entries()].sort((left, right) => right[1].length - left[1].length)[0];
    findings.push(makeFinding({
      code: "inconsistent-date-format",
      ruleId: "data/date/format",
      category: "date",
      severity: "suggestion",
      confidence: "medium",
      issue: "날짜 표기 방식 불일치",
      message: `날짜가 ${[...styles.keys()].map(dateStyleLabel).join(", ")} 형식으로 혼용됩니다.`,
      reason: "한 문서에서 날짜 형식이 다르면 기준일을 빠르게 비교하기 어렵습니다.",
      recommendation: `가장 많이 사용된 ${dateStyleLabel(preferred[0])} 형식으로 통일하세요.`,
      sources: valid.map((date) => date.unit.source),
      originalText: [...new Set(valid.map((date) => date.raw))].join(" / "),
      suggestedText: dateStyleLabel(preferred[0]),
    }));
  }

  const contextual = new Map<string, DateOccurrence[]>();
  for (const date of valid) {
    const keyword = date.unit.text.match(/(?:기준일|작성일|계약일|시행일|마감일|보고일)/u)?.[0];
    if (keyword) contextual.set(keyword, [...(contextual.get(keyword) ?? []), date]);
  }
  for (const [keyword, entries] of contextual) {
    const values = new Set(entries.map((date) => `${date.year ?? ""}-${date.month}-${date.day}`));
    const sources = uniqueSources(entries.map((date) => date.unit.source));
    if (values.size < 2 || sources.length < 2) continue;
    findings.push(makeFinding({
      code: "date-conflict",
      ruleId: `data/date/conflict:${keyword}`,
      category: "date",
      severity: "warning",
      confidence: "medium",
      issue: "날짜 충돌 가능성",
      message: `동일한 "${keyword}" 문맥에 서로 다른 날짜가 사용됩니다.`,
      reason: "같은 기준을 가리키는 날짜가 다르면 버전 또는 작성 시점이 충돌할 수 있습니다.",
      recommendation: "기준시점과 적용 조건을 확인하고 날짜 또는 문맥을 명확히 구분하세요.",
      sources,
      originalText: [...new Set(entries.map((date) => date.raw))].join(" / "),
    }));
  }

  const periods = reportingPeriods(units).filter((period) => period.month >= 1 && period.month <= 12);
  const periodValues = new Set(periods.map((period) => `${period.year}-${period.month}`));
  const periodSources = uniqueSources(periods.map((period) => period.unit.source));
  if (periodValues.size > 1 && periodSources.length > 1) {
    findings.push(makeFinding({
      code: "date-conflict",
      ruleId: "data/date/reporting-period",
      category: "date",
      severity: "warning",
      confidence: "medium",
      issue: "보고 기준월 충돌 가능성",
      message: `문서에 서로 다른 보고 기준월 ${[...periodValues].join(", ")}이 사용됩니다.`,
      reason: "표지와 본문의 보고월 또는 실적월이 다르면 문서 기준시점이 충돌할 수 있습니다.",
      recommendation: "각 기준월이 의도된 비교기간인지 확인하고, 아니라면 하나의 기준월로 수정하세요.",
      sources: periodSources,
      originalText: [...new Set(periods.map((period) => period.raw))].join(" / "),
    }));
  }
  return findings;
}
