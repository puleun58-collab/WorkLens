import type { SourceRef } from "@/domain/document";
import type { CheckFinding } from "@/domain/operations";
import { isProtectedToken } from "../dictionary";
import { makeFinding, type RuleContext, type TextUnit } from "../types";

interface TerminologyGroup {
  canonical: string;
  pattern: RegExp;
}

const TERMINOLOGY_GROUPS: readonly TerminologyGroup[] = [
  { canonical: "WorkLens", pattern: /\b(?:WorkLens|Work Lens|Worklens)\b/gu },
  { canonical: "Forecast", pattern: /\b(?:Forecast|forecast)\b/gu },
  { canonical: "1주 Forecast", pattern: /(?:1주\s+Forecast|Forecast\s+1주)/gu },
  { canonical: "개인정보", pattern: /(?:개인정보|개인 정보)/gu },
  { canonical: "향후 13주 전망", pattern: /(?:향후\s+13주\s+전망|13주\s+전망)/gu },
];

const RESERVED: Record<string, true> = { worklens: true, forecast: true };

export function terminologyFindings(units: readonly TextUnit[], context: RuleContext): CheckFinding[] {
  const findings: CheckFinding[] = [];
  for (const group of TERMINOLOGY_GROUPS) {
    const occurrences = new Map<string, { count: number; sources: SourceRef[] }>();
    for (const unit of units) {
      for (const match of unit.text.matchAll(new RegExp(group.pattern.source, group.pattern.flags))) {
        const existing = occurrences.get(match[0]) ?? { count: 0, sources: [] };
        existing.count += 1;
        existing.sources.push(unit.source);
        occurrences.set(match[0], existing);
      }
    }
    if (occurrences.size < 2) continue;
    const preferred = [...occurrences.entries()]
      .sort((left, right) => right[1].count - left[1].count || (left[0] === group.canonical ? -1 : 1))[0][0];
    const variants = [...occurrences.keys()];
    findings.push(makeFinding({
      code: "terminology-inconsistency",
      ruleId: `consistency/terminology:${group.canonical}`,
      category: "terminology",
      severity: "suggestion",
      confidence: "medium",
      issue: "용어 일관성",
      message: `동일 개념이 ${variants.map((variant) => `"${variant}"`).join(", ")}로 혼용됩니다.`,
      reason: "같은 개념의 표기가 달라 검색성과 문서 일관성이 낮아질 수 있습니다.",
      recommendation: `문서에서 가장 많이 사용된 "${preferred}" 표기로 통일하세요.`,
      sources: [...occurrences.values()].flatMap((entry) => entry.sources),
      originalText: variants.join(" / "),
      suggestedText: preferred,
    }));
  }

  // Generic casing drift. Acronyms, system codes and dictionary terms are exempt
  // so that GMK / SKU / WL-2026 never surface as terminology noise.
  const latinVariants = new Map<string, Map<string, SourceRef[]>>();
  for (const unit of units) {
    for (const match of unit.text.matchAll(/\b[A-Za-z][A-Za-z0-9]{3,}\b/gu)) {
      const token = match[0];
      const lower = token.toLocaleLowerCase();
      if (RESERVED[lower]) continue;
      if (isProtectedToken(token, context.dictionary)) continue;
      const variants = latinVariants.get(lower) ?? new Map<string, SourceRef[]>();
      variants.set(token, [...(variants.get(token) ?? []), unit.source]);
      latinVariants.set(lower, variants);
    }
  }
  for (const [lower, variants] of latinVariants) {
    if (variants.size < 2) continue;
    const preferred = [...variants.entries()].sort((left, right) => right[1].length - left[1].length)[0][0];
    findings.push(makeFinding({
      code: "terminology-inconsistency",
      ruleId: `consistency/casing:${lower}`,
      category: "terminology",
      severity: "suggestion",
      confidence: "medium",
      issue: "영문 대소문자 일관성",
      message: `${[...variants.keys()].map((variant) => `"${variant}"`).join(", ")} 표기가 혼용됩니다.`,
      reason: "동일한 영문 단어의 대소문자 표기가 문서 내에서 다릅니다.",
      recommendation: `"${preferred}" 표기로 통일하되 고유명사 또는 문장 첫 단어는 예외인지 확인하세요.`,
      sources: [...variants.values()].flat(),
      originalText: [...variants.keys()].join(" / "),
      suggestedText: preferred,
      normalizedToken: preferred,
    }));
  }
  return findings;
}
