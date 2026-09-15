import type { SourceRef } from "@/domain/document";
import type {
  CheckCategory,
  CheckCode,
  CheckConfidence,
  CheckFinding,
  CheckSeverity,
} from "@/domain/operations";
import type { TermDictionary } from "./dictionary";

/** One reviewable piece of text with the evidence location it came from. */
export interface TextUnit {
  text: string;
  source: SourceRef;
  blockId: string;
  kind: "paragraph" | "cell";
  /** Position in document order; drives the tie-break in result sorting. */
  order: number;
  headingLevel?: number;
  page?: number;
  row?: number;
  column?: number;
}

export interface FindingInput {
  code: CheckCode;
  ruleId: string;
  category: CheckCategory;
  severity: CheckSeverity;
  confidence: CheckConfidence;
  issue: string;
  message: string;
  reason: string;
  recommendation: string;
  sources: SourceRef[];
  originalText?: string;
  suggestedText?: string;
  /** Word that would suppress this finding once added to a dictionary. */
  normalizedToken?: string;
}

export interface RuleContext {
  dictionary: TermDictionary;
}

export function stableId(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function uniqueSources(sources: readonly SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.fileId}\0${source.nodeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Builds the public finding. The id stays stable across runs for the same
 * document position and text, so UI ignore state survives a re-run.
 */
export function makeFinding(input: FindingInput): CheckFinding {
  const sources = uniqueSources(input.sources);
  const source = sources[0];
  if (!source) throw new Error("Check findings require source evidence.");
  const id = `check:${input.code}:${stableId(`${source.fileId}\0${source.nodeId}\0${input.originalText ?? input.message}\0${input.suggestedText ?? ""}`)}`;
  return {
    id,
    ...input,
    source,
    sources,
    ...(input.normalizedToken ? { dictionaryEligible: true } : {}),
  };
}
