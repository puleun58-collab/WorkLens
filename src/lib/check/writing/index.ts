import type { NormalizedDocument } from "@/domain/document";
import type { CheckFinding } from "@/domain/operations";
import type { RuleContext, TextUnit } from "../types";
import { companyTermCasingFindings, englishSpellingFindings } from "./english-rules";
import { koreanSpellingFindings } from "./korean-rules";
import { duplicateSentenceFindings, repetitionFindings, sentenceEndingFindings } from "./repetition";
import { koreanSpacingFindings } from "./spacing";

const PROSE_KINDS: Record<NormalizedDocument["kind"], boolean> = {
  pptx: true,
  docx: true,
  pdf: true,
  xlsx: false,
  csv: false,
};

/** Per-unit writing review: spelling, spacing, repetition and hygiene. */
export function writingFindingsForUnit(
  unit: TextUnit,
  kind: NormalizedDocument["kind"],
  context: RuleContext,
): CheckFinding[] {
  if (!PROSE_KINDS[kind]) return [];
  return [
    ...repetitionFindings(unit, kind),
    ...koreanSpellingFindings(unit, context),
    ...koreanSpacingFindings(unit, context),
    ...englishSpellingFindings(unit, context),
  ];
}

/** Document-wide writing review that needs every unit at once. */
export function writingFindingsForDocument(
  units: readonly TextUnit[],
  kind: NormalizedDocument["kind"],
  context: RuleContext,
): CheckFinding[] {
  return [
    ...duplicateSentenceFindings(units),
    ...sentenceEndingFindings(units, kind),
    ...companyTermCasingFindings(units, context),
  ];
}

export { ENGLISH_MISSPELLINGS } from "./english-rules";
export { KOREAN_SPELLING_RULES } from "./korean-rules";
export { mergeSemanticFindings, semanticFindings } from "./semantic-review";
