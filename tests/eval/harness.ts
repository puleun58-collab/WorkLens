import type { NormalizedDocument, SourceRef } from "@/domain/document";
import type { AiEvidenceNode } from "@/lib/ai/contract";
import { buildEvidenceNodes, groundAiResult } from "@/lib/ai/grounding";
import { evidenceWindow, resolveClaims, type ModelClaim } from "@/lib/ai/prompt";
import { selectEvidence } from "@/lib/ai/retrieval";
import type { EvalCase } from "./cases";
import { evalDocuments } from "./fixtures";

/** Numbers are compared after normalization: 158,000 and 158000 are equal. */
export function normalizeForCompare(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replaceAll(",", "").replace(/\s+/gu, " ").trim();
}

export function matchesExpectation(text: string, expected: readonly string[]): boolean {
  const haystack = normalizeForCompare(text);
  return expected.every((needle) => haystack.includes(normalizeForCompare(needle)));
}

export interface RetrievalOutcome {
  case: EvalCase;
  /** The correct evidence is inside the window selected for this K. */
  hit: boolean;
  /** Correct evidence exists in the document at all. */
  present: boolean;
  candidates: number;
}

function locatorMatches(evalCase: EvalCase, source: SourceRef): boolean {
  if (evalCase.sheet && source.sheet !== evalCase.sheet) return false;
  if (evalCase.page !== undefined && source.page !== evalCase.page) return false;
  if (evalCase.slide !== undefined && (source.locator?.kind !== "pptx" || source.locator.slide !== evalCase.slide)) return false;
  return true;
}

function isCorrect(evalCase: EvalCase, node: AiEvidenceNode): boolean {
  return locatorMatches(evalCase, node.source) && matchesExpectation(`${node.text} ${node.source.label}`, evalCase.answerContains);
}

export async function runRetrieval(evalCase: EvalCase, limit = 20): Promise<RetrievalOutcome> {
  const documents = await evalDocuments();
  const document = documents.get(evalCase.format);
  if (!document) throw new Error(`missing eval fixture for ${evalCase.format}`);
  const candidates = buildEvidenceNodes([document]);
  const selected = selectEvidence(candidates, evalCase.request, { limit });
  return {
    case: evalCase,
    hit: selected.some((node) => isCorrect(evalCase, node)),
    present: candidates.some((node) => isCorrect(evalCase, node)),
    candidates: candidates.length,
  };
}

export interface GroundingOutcome {
  case: EvalCase;
  /** The pipeline produced a grounded claim that cites the correct evidence. */
  grounded: boolean;
  /** Every cited source resolves to a canonical SourceRef in the document. */
  sourcesCanonical: boolean;
  /** The answer text only repeats values that exist in the cited evidence. */
  valueSupported: boolean;
  refused: boolean;
}

/**
 * Simulates the honest part of a model answer: a claim that quotes retrieved
 * evidence and cites its handle. Generation quality needs a real model (see
 * `test:eval:ai`); what this measures is that the grounding contract turns such
 * a claim back into canonical sources, and that an unsupported claim is
 * rejected instead of shown.
 */
export async function runGrounding(evalCase: EvalCase): Promise<GroundingOutcome> {
  const documents = await evalDocuments();
  const document = documents.get(evalCase.format) as NormalizedDocument;
  const window = evidenceWindow(selectEvidence(buildEvidenceNodes([document]), evalCase.request));
  const supporting = window.items.find((item) => {
    const node = window.nodes.get(item.handle);
    return node ? isCorrect(evalCase, node) : false;
  });

  if (evalCase.refuse || !supporting) {
    // Nothing in the window supports the question: a fabricated claim that
    // cites a real handle must still fail the value check, and a claim that
    // cites nothing must be dropped before grounding.
    const fabricated: ModelClaim[] = [
      { text: `${evalCase.answerContains.join(" ")} 입니다.`, handles: [window.items[0]?.handle ?? "E1"], confidence: "high" },
      { text: "출처 없는 추정입니다.", handles: [], confidence: "low" },
    ];
    const completion = resolveClaims(window, fabricated);
    const result = groundAiResult(evalCase.request, [document], completion);
    const supported = result.claims.some((claim) => claim.evidence.some((binding) =>
      matchesExpectation(binding.source.quote ?? "", evalCase.answerContains)));
    return { case: evalCase, grounded: false, sourcesCanonical: true, valueSupported: false, refused: !supported };
  }

  const claims: ModelClaim[] = [{
    text: `${evalCase.answerContains.join(" ")}`,
    handles: [supporting.handle],
    confidence: "medium",
  }];
  const result = groundAiResult(evalCase.request, [document], resolveClaims(window, claims));
  const cited = result.claims.flatMap((claim) => claim.evidence.map((binding) => binding.source));
  const expectedNode = window.nodes.get(supporting.handle)!;
  return {
    case: evalCase,
    grounded: result.rejectedClaimCount === 0 && result.claims.length > 0,
    sourcesCanonical: cited.length > 0 && cited.every((source) =>
      typeof source.documentId === "string" && typeof source.quoteHash === "string" && source.fileId === document.fileId),
    valueSupported: cited.some((source) =>
      matchesExpectation(`${source.quote ?? ""} ${source.label}`, evalCase.answerContains)
      && source.nodeId === expectedNode.source.nodeId),
    refused: false,
  };
}

export function percentage(passed: number, total: number): number {
  return total === 0 ? 0 : Math.round((passed / total) * 1000) / 10;
}
