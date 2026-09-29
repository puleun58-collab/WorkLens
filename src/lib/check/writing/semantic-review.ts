import type { GroundedClaim } from "@/domain/ai";
import type { CheckFinding } from "@/domain/operations";
import type { TermDictionary } from "../dictionary";
import { makeFinding } from "../types";
import { classifyEnglishCorrection, englishSpellingFinding } from "./english-rules";

/**
 * Grounded semantic layer.
 *
 * The deterministic layers above never call a model. A model claim that
 * proposes a single English word correction is classified exactly like a
 * deterministic spelling finding, so its severity follows the correction's
 * certainty, not the detector. Every other claim stays a suggestion that can
 * never outrank a deterministic rule.
 */

/** `‘teh’는 ‘the’로 …`, `"teh" → "the"`: quoted segments in the order the model wrote them. */
const QUOTED = /[‘'"“「]([^’'"”」]+)[’'"”」]/gu;
const ALTERNATIVES = /또는|혹은|\bor\b/iu;

function wordPattern(word: string): RegExp {
  return new RegExp(`(?<![A-Za-z])${word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![A-Za-z])`, "iu");
}

/** Reads a claim as `original → replacement(s)` when it names quoted English words that occur in its evidence. */
function proposedCorrection(text: string, evidence: readonly string[]): { word: string; replacements: string[] } | undefined {
  const quoted = [...text.matchAll(QUOTED)].map((match) => match[1].trim());
  if (quoted.length < 2) return undefined;
  const [first, ...replacements] = quoted;
  const occurrence = evidence.map((quote) => wordPattern(first).exec(quote)?.[0]).find(Boolean);
  return occurrence ? { word: occurrence, replacements } : undefined;
}

function spellingFromClaim(claim: GroundedClaim, text: string, dictionary: TermDictionary): CheckFinding | null | undefined {
  const quotes = claim.evidence.map((binding) => binding.source.quote ?? "");
  const proposal = proposedCorrection(text, quotes);
  if (!proposal) return undefined;
  const certainties = proposal.replacements.map((replacement) => classifyEnglishCorrection(proposal.word, replacement, dictionary));
  // A protected term is the author's own spelling: neither a typo nor worth a suggestion.
  if (certainties.includes("protected")) return null;
  if (certainties.some((certainty) => certainty === undefined)) return undefined;
  const single = proposal.replacements.length === 1 && !ALTERNATIVES.test(text);
  const confidence = claim.kind === "inference" ? claim.confidence ?? "low" : "high";
  const certainty = single && certainties[0] === "clear" && confidence !== "low" ? "clear" : "uncertain";
  const source = claim.evidence.find((binding) => wordPattern(proposal.word).test(binding.source.quote ?? ""))?.source ?? claim.evidence[0].source;
  return englishSpellingFinding({
    word: proposal.word,
    replacement: proposal.replacements[0],
    certainty,
    confidence,
    sources: [source, ...claim.evidence.map((binding) => binding.source)],
    originalText: source.quote ?? "",
  });
}

export function semanticFindings(claims: readonly GroundedClaim[], dictionary: TermDictionary): CheckFinding[] {
  const findings: CheckFinding[] = [];
  for (const claim of claims) {
    // `추론:` marks how grounding produced the claim; a finding states its basis in `reason` instead.
    const text = claim.text.trim().replace(/^추론:\s*/u, "");
    if (!text) continue;
    const sources = claim.evidence.map((binding) => binding.source);
    if (sources.length === 0) continue;
    const spelling = spellingFromClaim(claim, text, dictionary);
    if (spelling === null) continue;
    if (spelling) {
      findings.push(spelling);
      continue;
    }
    findings.push(makeFinding({
      code: "semantic-writing-suggestion",
      ruleId: `writing/semantic:${claim.kind}`,
      category: "wording",
      severity: "suggestion",
      confidence: claim.kind === "inference" ? claim.confidence ?? "low" : "low",
      issue: "문장 검토 의견",
      message: text,
      reason: claim.kind === "fact"
        ? "원문에서 직접 확인한 문장 문제입니다."
        : "문맥 기반 판단이며 확정된 오류가 아닙니다.",
      recommendation: "제안 내용을 원문과 대조한 뒤 필요할 때만 반영하세요.",
      sources,
      originalText: claim.evidence[0]?.source.quote || undefined,
    }));
  }
  return findings;
}

function locations(finding: CheckFinding): string[] {
  return finding.sources.map((source) => `${source.fileId}\0${source.nodeId}`);
}

/**
 * Appends semantic findings to an existing deterministic finding list. An
 * English spelling finding is one issue per word and location whichever
 * detector found it, so a repeat is dropped and the deterministic finding,
 * classified by the same rule, stands. Other semantic suggestions are dropped
 * when a deterministic finding of the same category already covers that
 * location. Pure function: the caller owns re-sorting.
 */
export function mergeSemanticFindings(
  deterministic: readonly CheckFinding[],
  semantic: readonly CheckFinding[],
): CheckFinding[] {
  const spellingKey = (finding: CheckFinding, location: string) => `${location}\0${finding.normalizedToken?.toLocaleLowerCase()}`;
  const spelled = new Set(deterministic.filter((finding) => finding.code === "english-spelling")
    .flatMap((finding) => locations(finding).map((location) => spellingKey(finding, location))));
  const occupied = new Set(deterministic.map((finding) => `${finding.source.fileId}\0${finding.source.nodeId}\0${finding.category}`));
  const added: CheckFinding[] = [];
  for (const finding of semantic) {
    if (finding.code === "english-spelling") {
      const keys = locations(finding).map((location) => spellingKey(finding, location));
      if (keys.some((key) => spelled.has(key))) continue;
      keys.forEach((key) => spelled.add(key));
    } else if (occupied.has(`${finding.source.fileId}\0${finding.source.nodeId}\0${finding.category}`)) {
      continue;
    }
    added.push(finding);
  }
  return [...deterministic, ...added];
}
