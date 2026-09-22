import type { AiConfidence, AiOperation, BriefClaimPresentation, DirectProposition } from "@/domain/ai";
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
  presentation?: BriefClaimPresentation;
}

export type AiProviderClaim = AiProviderDirectClaim | AiProviderInferenceClaim;
export interface AiProviderCompletion { schemaId: typeof AI_SCHEMA_ID; claims: AiProviderClaim[]; }

export const AI_OPERATIONS: readonly AiOperation[] = ["analyze", "ask", "brief", "semantic-check"];
