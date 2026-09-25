import type { AiConfidence, AiOperation, AnalyzeClaimPresentation, DirectProposition } from "@/domain/ai";
import type { SourceRef } from "@/domain/document";

export const AI_SCHEMA_ID = "worklens.grounded-claims.v1";

/**
 * Canonical evidence built in the browser from documents the worker already
 * parsed. Source locators stay here and are never handed to the model: the
 * model only ever sees the short handles produced by `src/lib/ai/prompt.ts`.
 */
export interface AiEvidenceNode {
  fileId: string;
  nodeId: string;
  source: SourceRef;
  text: string;
  propositionToken: string;
  proposition: DirectProposition;
  /** Structural role from the parser: a heading names a section, it is not prose. */
  role?: "heading";
  /** A number far outside its own table column; Analyze keeps it visible to the model. */
  outlier?: true;
}

export interface AiProviderDirectClaim {
  type: "direct";
  propositionToken: string;
  subject: string;
  predicate: DirectProposition["predicate"];
  object: DirectProposition["object"];
  polarity: DirectProposition["polarity"];
  qualifiers?: Record<string, string | number | boolean | null>;
}

export interface AiProviderInferenceClaim {
  type: "inference";
  text: string;
  sourceTokens: string[];
  confidence?: AiConfidence;
  presentation?: AnalyzeClaimPresentation;
}

export type AiProviderClaim = AiProviderDirectClaim | AiProviderInferenceClaim;
export interface AiProviderCompletion { schemaId: typeof AI_SCHEMA_ID; claims: AiProviderClaim[]; }

export const AI_OPERATIONS: readonly AiOperation[] = ["analyze", "ask", "semantic-check"];
