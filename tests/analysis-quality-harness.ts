import { expect } from "vitest";
import type { AiConfidence, AiAvailableResult, GroundedClaim } from "@/domain/ai";
import type { NormalizedDocument, SourceRef } from "@/domain/document";
import { buildEvidenceNodes, groundAiResult } from "@/lib/ai/grounding";
import { evidenceWindow, parseModelResponse, resolveClaims, type EvidenceWindow } from "@/lib/ai/prompt";
import { selectEvidence } from "@/lib/ai/retrieval";
import {
  analysisClaimPresentation,
  claimDisplayText,
  confirmedAnalysisItems,
  confirmedAnalysisMetrics,
  documentAnalysisTopics,
  type AnalysisClaimPresentation,
  type AnalysisMetric,
} from "@/lib/analysis-presentation";
import { analyzeDocument } from "@/lib/deterministic";
import { autoExtract } from "@/lib/extract/auto";
import { parseDocument } from "@/lib/parsers";
import type { DocumentTopic } from "@/domain/operations";

/**
 * The Analyze pipeline exactly as the browser worker and result view run it:
 * parse → deterministic analysis/extraction/topics → bounded evidence window →
 * (mocked) model claims → grounding → presentation. Only the model is fake.
 */
export interface MatrixFile {
  fileId: string;
  fileName: string;
  bytes: Uint8Array;
}

export interface ProposedClaim {
  text: string;
  /** Each pattern must match one shortlisted evidence item; its handle is cited. */
  evidence: RegExp[];
  role: "summary" | "insight";
  confidence?: AiConfidence;
}

export interface AnalyzeRun {
  documents: NormalizedDocument[];
  items: DocumentTopic[];
  metrics: AnalysisMetric[];
  window: EvidenceWindow;
  /** Presentation without an AI result: what the user sees when AI fails. */
  fallback: AnalysisClaimPresentation;
  enrich(claims: readonly ProposedClaim[]): { grounded: AiAvailableResult; presented: AnalysisClaimPresentation };
  /** Raw provider payload path, for invalid handles/JSON cases. */
  enrichRaw(payload: string): { grounded: AiAvailableResult; presented: AnalysisClaimPresentation };
}

export async function runAnalyze(files: readonly MatrixFile[]): Promise<AnalyzeRun> {
  const documents = await Promise.all(files.map((file) =>
    parseDocument({ fileId: file.fileId, fileName: file.fileName, bytes: file.bytes.slice() })));
  const entries = documents.map((document, index) => {
    const file = { id: files[index].fileId, name: files[index].fileName };
    return {
      file,
      analysis: analyzeDocument(document),
      extraction: autoExtract(document, file),
      topics: documentAnalysisTopics(document),
    };
  });
  const items = confirmedAnalysisItems(entries);
  const metrics = confirmedAnalysisMetrics(entries);
  const fields = entries.flatMap((entry) => entry.extraction.fields);
  const request = { operation: "analyze" as const };
  const window = evidenceWindow(selectEvidence(buildEvidenceNodes(documents, request), request), undefined, "analyze");
  const ground = (payload: string) => {
    const response = parseModelResponse(payload);
    const grounded = groundAiResult(request, documents, resolveClaims(window, response.claims));
    return { grounded, presented: analysisClaimPresentation(grounded, fields, items) };
  };
  return {
    documents,
    items,
    metrics,
    window,
    fallback: analysisClaimPresentation(null, fields, items),
    enrich: (claims) => ground(JSON.stringify({ claims: claims.map((claim) => ({
      text: claim.text,
      role: claim.role,
      confidence: claim.confidence ?? "high",
      sources: claim.evidence.map((pattern) => {
        const item = window.items.find((candidate) => pattern.test(candidate.text));
        if (!item) throw new Error(`Evidence not shortlisted for Analyze: ${pattern}`);
        return item.handle;
      }),
    })) })),
    enrichRaw: ground,
  };
}

/** Every text a user can read in the Analyze result. */
export function visibleTexts(presented: AnalysisClaimPresentation, metrics: readonly AnalysisMetric[] = []): string[] {
  return [
    ...presented.summary.map(claimDisplayText),
    ...presented.content.map((item) => item.text),
    ...metrics.map((metric) => `${metric.label} ${metric.value}`),
    ...presented.insights.map(claimDisplayText),
    ...presented.concerns.map(claimDisplayText),
  ];
}

/** Meaning coverage: each concept is one regex; wording may differ across formats. */
export function coverage(texts: readonly string[], concepts: Record<string, RegExp>): { hit: string[]; missed: string[] } {
  const joined = texts.map((text) => text.normalize("NFKC"));
  const hit: string[] = [];
  const missed: string[] = [];
  for (const [name, pattern] of Object.entries(concepts)) {
    (joined.some((text) => pattern.test(text)) ? hit : missed).push(name);
  }
  return { hit, missed };
}

export function expectCovers(texts: readonly string[], concepts: Record<string, RegExp>, label = "") {
  const { missed } = coverage(texts, concepts);
  expect(missed, `${label} missed concepts; visible:\n${texts.join("\n")}`).toEqual([]);
}

export function expectNoNoise(texts: readonly string[], noise: readonly RegExp[], label = "") {
  for (const pattern of noise) {
    expect(texts.filter((text) => pattern.test(text)), `${label} noise ${pattern}`).toEqual([]);
  }
}

/** The shortlisted evidence the model can see, for "can AI find it" checks. */
export function windowTexts(run: AnalyzeRun): string[] {
  return run.window.items.map((item) => item.text);
}

export function claimSources(claim: GroundedClaim): SourceRef[] {
  return claim.evidence.map((binding) => binding.source);
}

/** Canonical provenance: every displayed AI claim resolves to its own file's parsed source. */
export function expectGrounded(presented: AnalysisClaimPresentation, documents: readonly NormalizedDocument[]) {
  for (const claim of [...presented.summary, ...presented.insights, ...presented.concerns]) {
    expect(claim.evidence.length).toBeGreaterThan(0);
    for (const { source } of claim.evidence) {
      const document = documents.find((candidate) => candidate.fileId === source.fileId);
      expect(document, `claim source file ${source.fileId}`).toBeTruthy();
      expect(source.documentId).toBe(document!.id);
      expect(source.documentVersion).toBe(document!.version);
      expect(source.quote).toBeTruthy();
    }
  }
}

/** No text appears twice (after normalization) across summary, content and insight. */
export function expectNoExactRepeats(presented: AnalysisClaimPresentation) {
  const norm = (text: string) => text.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[\s.。,]+/gu, "");
  const all = [
    ...presented.summary.map(claimDisplayText),
    ...presented.content.map((item) => item.text),
    ...presented.insights.map(claimDisplayText),
  ].map(norm);
  expect(all.length - new Set(all).size, `repeated texts: ${all.join(" | ")}`).toBe(0);
}
