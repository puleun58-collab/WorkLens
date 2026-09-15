import type { NormalizedDocument, SourceRef } from "@/domain/document";
import type { CheckFinding } from "@/domain/operations";
import { makeFinding, uniqueSources, type TextUnit } from "../types";

const PLACEHOLDER = /\b(?:lorem\s+ipsum|TBD|TODO|XXX|FIXME|PLACEHOLDER)\b|(?:추후|향후)\s*(?:입력|작성|확정)|내용\s*(?:입력|작성)/iu;
const DUPLICATE_WORD = /(^|[\s("'])((?:[A-Za-z]{2,}|[가-힣]{2,}))(?:\s+\2)+(?=$|[\s.,!?…])/iu;
const REPEATED_CHARACTER = /([A-Za-z가-힣])\1{3,}/u;
const REPEATED_PUNCTUATION = /([!?])\1{2,}|([,.])\2{2,}/u;

/**
 * Repetition and hygiene rules. Dictionary terms are never exempt here: a
 * protected term repeated twice is still a duplicated word.
 */
export function repetitionFindings(unit: TextUnit, kind: NormalizedDocument["kind"]): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const text = unit.text;

  const placeholder = text.match(PLACEHOLDER)?.[0];
  if (placeholder) findings.push(makeFinding({
    code: "placeholder-text",
    ruleId: "writing/placeholder",
    category: "placeholder",
    severity: "warning",
    confidence: "high",
    issue: "미정 또는 placeholder 문구",
    message: `제출 전 확정되지 않은 문구 "${placeholder}"가 남아 있습니다.`,
    reason: "미완성 표시는 최종 문서의 신뢰도를 낮추고 누락으로 이어질 수 있습니다.",
    recommendation: "내용을 확정해 교체하거나 해당 블록을 삭제하세요.",
    sources: [unit.source],
    originalText: text,
  }));

  const duplicateWord = DUPLICATE_WORD.exec(text);
  if (duplicateWord) findings.push(makeFinding({
    code: "repeated-word",
    ruleId: "writing/repeated-word",
    category: "duplication",
    severity: "warning",
    confidence: "high",
    issue: "중복 단어",
    message: `"${duplicateWord[2]}"가 연속해서 반복됩니다.`,
    reason: "동일 단어의 연속 반복은 입력 오류일 가능성이 높습니다.",
    recommendation: "중복된 단어를 하나만 남기세요.",
    sources: [unit.source],
    originalText: text,
    suggestedText: text.replace(duplicateWord[0], `${duplicateWord[1]}${duplicateWord[2]}`),
  }));

  const repeatedCharacter = REPEATED_CHARACTER.exec(text);
  if (repeatedCharacter) findings.push(makeFinding({
    code: "repeated-character",
    ruleId: "writing/repeated-character",
    category: "spelling",
    severity: "suggestion",
    confidence: "medium",
    issue: "반복 문자",
    message: `"${repeatedCharacter[0]}"에 같은 문자가 과도하게 반복됩니다.`,
    reason: "강조가 아니라면 키 입력 오류일 수 있습니다.",
    recommendation: "의도된 강조인지 확인하고 불필요한 반복 문자를 정리하세요.",
    sources: [unit.source],
    originalText: text,
    suggestedText: text.replace(repeatedCharacter[0], repeatedCharacter[1]),
  }));

  const repeatedPunctuation = REPEATED_PUNCTUATION.exec(text);
  if (repeatedPunctuation) findings.push(makeFinding({
    code: "repeated-punctuation",
    ruleId: "writing/repeated-punctuation",
    category: "formatting",
    severity: "suggestion",
    confidence: "medium",
    issue: "특수문자 반복",
    message: `문장부호 "${repeatedPunctuation[0]}"가 과도하게 반복됩니다.`,
    reason: "업무 문서에서는 반복 문장부호가 비공식적으로 보일 수 있습니다.",
    recommendation: "문맥에 맞는 문장부호 하나로 정리하세요.",
    sources: [unit.source],
    originalText: text,
    suggestedText: text.replace(repeatedPunctuation[0], repeatedPunctuation[1] ?? repeatedPunctuation[2]),
  }));

  if (/ {2,}|\t+/u.test(text)) findings.push(makeFinding({
    code: "abnormal-spacing",
    ruleId: "writing/abnormal-spacing",
    category: "formatting",
    severity: "suggestion",
    confidence: "medium",
    issue: "비정상 공백",
    message: "문장 안에 연속 공백 또는 탭이 있습니다.",
    reason: "불규칙한 공백은 줄바꿈과 정렬을 깨뜨릴 수 있습니다.",
    recommendation: "공백을 하나로 통일하세요.",
    sources: [unit.source],
    originalText: text,
    suggestedText: text.replace(/[ \t]+/gu, " "),
  }));

  const sentenceLimit = kind === "pptx" ? 90 : 140;
  const longSentence = (text.match(/[^.!?。]+[.!?。]?/gu) ?? []).find((sentence) => sentence.trim().length > sentenceLimit);
  if (longSentence) findings.push(makeFinding({
    code: "long-sentence",
    ruleId: "writing/long-sentence",
    category: "wording",
    severity: "suggestion",
    confidence: "low",
    issue: "지나치게 긴 문장",
    message: `${longSentence.trim().length}자의 긴 문장이 있습니다.`,
    reason: kind === "pptx" ? "슬라이드의 긴 문장은 빠른 이해를 어렵게 합니다." : "긴 문장은 핵심 논리와 책임 주체를 흐릴 수 있습니다.",
    recommendation: "한 문장에 한 가지 핵심만 남기고 두 문장 이상으로 나누세요.",
    sources: [unit.source],
    originalText: longSentence.trim(),
  }));
  return findings;
}

export function duplicateSentenceFindings(units: readonly TextUnit[]): CheckFinding[] {
  const sentences = new Map<string, { text: string; sources: SourceRef[] }>();
  for (const unit of units) {
    for (const sentence of unit.text.split(/(?<=[.!?。])\s+|\n+/u)) {
      const text = sentence.trim();
      if (text.length < 18) continue;
      const key = text.normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase();
      const existing = sentences.get(key) ?? { text, sources: [] };
      existing.sources.push(unit.source);
      sentences.set(key, existing);
    }
  }
  const findings: CheckFinding[] = [];
  for (const entry of sentences.values()) {
    const sources = uniqueSources(entry.sources);
    if (sources.length < 2) continue;
    findings.push(makeFinding({
      code: "duplicate-sentence",
      ruleId: "writing/duplicate-sentence",
      category: "duplication",
      severity: "suggestion",
      confidence: "medium",
      issue: "중복 문장",
      message: "동일한 문장이 문서의 여러 위치에서 반복됩니다.",
      reason: "의도하지 않은 복제는 문서를 길게 만들고 버전별 수정 누락을 유발할 수 있습니다.",
      recommendation: "반복이 필요한 문장인지 확인하고 불필요한 사본을 삭제하세요.",
      sources,
      originalText: entry.text,
    }));
  }
  return findings;
}

export function sentenceEndingFindings(units: readonly TextUnit[], kind: NormalizedDocument["kind"]): CheckFinding[] {
  if (!(["pptx", "docx", "pdf"] as const).includes(kind as "pptx" | "docx" | "pdf")) return [];
  const classified = units
    .filter((unit) => unit.kind === "paragraph")
    .map((unit) => ({
      unit,
      style: /(?:습니다|입니다|합니다|됩니다)[.!?]?$/u.test(unit.text)
        ? "formal"
        : /(?:함|임|됨|음)[.!?]?$/u.test(unit.text) ? "nominal" : undefined,
    }))
    .filter((entry): entry is { unit: TextUnit; style: "formal" | "nominal" } => Boolean(entry.style));
  const formal = classified.filter((entry) => entry.style === "formal");
  const nominal = classified.filter((entry) => entry.style === "nominal");
  if (classified.length < 3 || formal.length === 0 || nominal.length === 0 || Math.max(formal.length, nominal.length) < 2) return [];
  const minority = formal.length >= nominal.length ? nominal : formal;
  const majorityLabel = formal.length >= nominal.length ? "합니다체" : "명사형 종결";
  return [makeFinding({
    code: "sentence-ending-inconsistency",
    ruleId: "writing/sentence-ending",
    category: "wording",
    severity: "suggestion",
    confidence: "low",
    issue: "문장 끝맺음 불일치",
    message: `문서의 주된 ${majorityLabel}와 다른 끝맺음이 섞여 있습니다.`,
    reason: "같은 수준의 본문에서 종결 방식이 달라 문서의 어조가 불균일합니다.",
    recommendation: `문서의 기준 어조인 ${majorityLabel}로 통일하세요.`,
    sources: minority.map((entry) => entry.unit.source),
    originalText: minority[0].unit.text,
  })];
}
