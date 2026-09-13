import type { AiOperation, AiUnavailableReason, DirectProposition } from "@/domain/ai";
import type { SourceRef } from "@/domain/document";

export const AI_SCHEMA_ID = "worklens.grounded-claims.v1";

/** Canonical server-only evidence. Never send source locators to the provider. */
export interface AiEvidenceNode {
  fileId: string;
  nodeId: string;
  source: SourceRef;
  text: string;
  propositionToken: string;
  proposition: DirectProposition;
}

export interface AiProviderRequest {
  requestId: string;
  sessionKey: string;
  task: AiOperation;
  schemaId: typeof AI_SCHEMA_ID;
  locale: "ko-KR";
  sourceTokens: string[];
  context: Array<{ propositionToken: string; text: string; proposition: DirectProposition }>;
  maxOutputTokens: number;
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
}

export type AiProviderClaim = AiProviderDirectClaim | AiProviderInferenceClaim;
export interface AiProviderCompletion { schemaId: typeof AI_SCHEMA_ID; claims: AiProviderClaim[]; }

export interface AiProviderCapabilities {
  available: boolean;
  operations: AiOperation[];
  contextWindowTokens: number;
  maxOutputTokens: number;
}
export interface AiProviderHealth {
  available: boolean;
  reason?: AiUnavailableReason;
  capabilities?: AiProviderCapabilities;
}
export type AiProviderResponse =
  | { status: "ok"; completion: AiProviderCompletion }
  | { status: "unavailable"; reason: AiUnavailableReason };

export interface LocalAiProvider {
  health(signal?: AbortSignal): Promise<AiProviderHealth>;
  complete(request: AiProviderRequest, signal?: AbortSignal): Promise<AiProviderResponse>;
}
