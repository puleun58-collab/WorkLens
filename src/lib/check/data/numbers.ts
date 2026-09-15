import type { SourceRef } from "@/domain/document";
import type { CheckFinding } from "@/domain/operations";
import { makeFinding, uniqueSources, type TextUnit } from "../types";

interface NumberOccurrence {
  label: string;
  value: number;
  raw: string;
  unitLabel: string;
  unit: TextUnit;
}

const UNIT_STYLE_GROUPS = [
  { ruleId: "data/unit/distance", issue: "거리 단위 표기 불일치", variants: ["km", "KM"], regex: /\b(?:km|KM)\b/gu },
  { ruleId: "data/unit/weight", issue: "무게 단위 표기 불일치", variants: ["kg", "KG"], regex: /\b(?:kg|KG)\b/gu },
  { ruleId: "data/unit/area", issue: "면적 단위 표기 불일치", variants: ["m²", "㎡"], regex: /(?:m²|㎡)/gu },
] as const;

export function unitAndFormatFindings(units: readonly TextUnit[]): CheckFinding[] {
  const findings: CheckFinding[] = [];
  for (const group of UNIT_STYLE_GROUPS) {
    const used = new Map<string, SourceRef[]>();
    for (const unit of units) {
      for (const match of unit.text.matchAll(new RegExp(group.regex.source, group.regex.flags))) {
        used.set(match[0], [...(used.get(match[0]) ?? []), unit.source]);
      }
    }
    if (used.size < 2) continue;
    const preferred = [...used.entries()].sort((left, right) => right[1].length - left[1].length)[0][0];
    findings.push(makeFinding({
      code: "inconsistent-unit-format",
      ruleId: group.ruleId,
      category: "unit",
      severity: "suggestion",
      confidence: "medium",
      issue: group.issue,
      message: `${group.variants.join(" / ")} 표기가 한 문서에 함께 사용됩니다.`,
      reason: "동일 단위의 대소문자 또는 기호 표기가 다릅니다.",
      recommendation: `"${preferred}" 표기로 통일하세요.`,
      sources: [...used.values()].flat(),
      originalText: [...used.keys()].join(" / "),
      suggestedText: preferred,
    }));
  }

  const percentStyles = new Map<"attached" | "spaced", SourceRef[]>();
  const currency = new Map<string, SourceRef[]>();
  const numberGrouping = new Map<"comma" | "plain", SourceRef[]>();
  for (const unit of units) {
    for (const match of unit.text.matchAll(/-?\d+(?:[.,]\d+)?(\s*)%/gu)) {
      const style = match[1] ? "spaced" : "attached";
      percentStyles.set(style, [...(percentStyles.get(style) ?? []), unit.source]);
    }
    const malformed = unit.text.match(/(?:\d+(?:\.\d+)?\s*%%|%\s*\d+)/u)?.[0];
    if (malformed) findings.push(makeFinding({
      code: "malformed-percentage",
      ruleId: "data/number/malformed-percentage",
      category: "numeric",
      severity: "warning",
      confidence: "high",
      issue: "잘못된 백분율 표기",
      message: `"${malformed}"은(는) 일반적인 백분율 형식이 아닙니다.`,
      reason: "백분율 기호의 위치 또는 개수가 올바르지 않습니다.",
      recommendation: "숫자 뒤에 % 기호 하나를 사용하세요.",
      sources: [unit.source],
      originalText: malformed,
    }));
    for (const match of unit.text.matchAll(/-?\d[\d,]*(?:\.\d+)?\s*(억원|백만원|천원|원)\b/gu)) {
      currency.set(match[1], [...(currency.get(match[1]) ?? []), unit.source]);
    }
    for (const match of unit.text.matchAll(/\b\d{4,}\b|\b\d{1,3}(?:,\d{3})+\b/gu)) {
      const style = match[0].includes(",") ? "comma" : "plain";
      numberGrouping.set(style, [...(numberGrouping.get(style) ?? []), unit.source]);
    }
  }
  if (percentStyles.size > 1) findings.push(makeFinding({
    code: "inconsistent-unit-format",
    ruleId: "data/unit/percent-spacing",
    category: "unit",
    severity: "suggestion",
    confidence: "medium",
    issue: "백분율 간격 불일치",
    message: "숫자와 % 기호 사이의 공백 사용이 일관되지 않습니다.",
    reason: "10%와 10 % 형식이 함께 사용됩니다.",
    recommendation: "숫자와 %를 붙여 쓰는 형식으로 통일하세요.",
    sources: [...percentStyles.values()].flat(),
    originalText: "10% / 10 %",
    suggestedText: "10%",
  }));
  if (currency.size > 1) findings.push(makeFinding({
    code: "inconsistent-currency-format",
    ruleId: "data/unit/currency",
    category: "unit",
    severity: "suggestion",
    confidence: "medium",
    issue: "금액 단위 혼용",
    message: `금액 단위 ${[...currency.keys()].join(", ")}가 한 문서에서 혼용됩니다.`,
    reason: "표시 단위가 다르면 금액을 직접 비교할 때 오해가 생길 수 있습니다.",
    recommendation: "기준 금액 단위를 통일하거나 각 수치의 단위를 명확히 표시하세요.",
    sources: [...currency.values()].flat(),
    originalText: [...currency.keys()].join(" / "),
  }));
  if (numberGrouping.size > 1) findings.push(makeFinding({
    code: "inconsistent-number-format",
    ruleId: "data/number/grouping",
    category: "formatting",
    severity: "suggestion",
    confidence: "medium",
    issue: "천 단위 구분 형식 불일치",
    message: "네 자리 이상 숫자의 쉼표 표기가 일관되지 않습니다.",
    reason: "1,000과 1000 형식이 함께 사용됩니다.",
    recommendation: "천 단위 쉼표 사용 여부를 하나의 기준으로 통일하세요.",
    sources: [...numberGrouping.values()].flat(),
    originalText: "1,000 / 1000",
  }));
  return findings;
}

const LABELLED_NUMBER = /(?:^|[.!?\n])\s*([가-힣A-Za-z][가-힣A-Za-z ]{0,30}?)\s*(?::|은|는)?\s+(-?\d[\d,]*(?:\.\d+)?)\s*(%|억원|백만원|천원|원|km|KM|kg|KG|m²|㎡)?(?=$|[\s,.;!?])/gu;

function canonicalUnit(unit: string): string {
  const lower = unit.toLocaleLowerCase();
  if (lower === "km" || lower === "kg") return lower;
  if (unit === "m²" || unit === "㎡") return "area";
  return unit;
}

function numberOccurrences(units: readonly TextUnit[]): NumberOccurrence[] {
  const occurrences: NumberOccurrence[] = [];
  for (const unit of units.filter((entry) => entry.kind === "paragraph")) {
    const withoutDates = unit.text.replace(/\b\d{4}(?:[.-]\d{1,2}){2}\b|\b\d{4}년\s*\d{1,2}월(?:\s*\d{1,2}일)?/gu, "");
    for (const match of withoutDates.matchAll(new RegExp(LABELLED_NUMBER.source, LABELLED_NUMBER.flags))) {
      const label = match[1].normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
      if (label.length < 2 || /(?:slide|page|슬라이드|페이지|버전)$/iu.test(label)) continue;
      const value = Number(match[2].replaceAll(",", ""));
      if (!Number.isFinite(value)) continue;
      occurrences.push({ label, value, raw: match[0].trim(), unitLabel: canonicalUnit(match[3] ?? ""), unit });
    }
  }
  return occurrences;
}

export function numericConflictFindings(units: readonly TextUnit[]): CheckFinding[] {
  const groups = new Map<string, NumberOccurrence[]>();
  for (const occurrence of numberOccurrences(units)) {
    const key = `${occurrence.label}\0${occurrence.unitLabel}`;
    groups.set(key, [...(groups.get(key) ?? []), occurrence]);
  }
  const findings: CheckFinding[] = [];
  for (const entries of groups.values()) {
    const values = new Set(entries.map((entry) => entry.value));
    const sources = uniqueSources(entries.map((entry) => entry.unit.source));
    if (values.size < 2 || sources.length < 2) continue;
    const numeric = [...values];
    const minimum = Math.min(...numeric.map(Math.abs).filter((value) => value > 0));
    const maximum = Math.max(...numeric.map(Math.abs));
    const suspicious = Number.isFinite(minimum) && maximum / minimum >= 10;
    findings.push(makeFinding({
      code: suspicious ? "suspicious-number-change" : "repeated-number-conflict",
      ruleId: suspicious ? "data/number/suspicious-change" : "data/number/conflict",
      category: "numeric",
      severity: "warning",
      confidence: "medium",
      issue: suspicious ? "급격한 수치 변화" : "동일 항목 수치 불일치",
      message: `"${entries[0].label}" 항목에 서로 다른 값 ${numeric.join(", ")}이 사용됩니다.`,
      reason: suspicious
        ? "동일 항목의 값 차이가 10배 이상이어서 단위 또는 입력 오류 가능성이 있습니다."
        : "같은 항목과 단위로 보이는 수치가 문서 내에서 일치하지 않습니다.",
      recommendation: "기준시점, 조건과 단위를 확인하고 의도된 차이라면 문맥을 명시하세요.",
      sources,
      originalText: entries.map((entry) => entry.raw).join(" / "),
    }));
  }
  return findings;
}
