import type { AiRequest } from "@/domain/ai";
import type { PolishMode, PolishProposal } from "@/domain/polish";
import type { ExtractProposal } from "@/lib/ai/extract-prompt";
import type { EvidenceItem, ModelClaim } from "@/lib/ai/prompt";

export const SERVER_AI_MAX_FILES = 5;
export const POLISH_BATCH_MAX_ITEMS = 4;
export const POLISH_BATCH_MAX_CHARS = 2_400;

export type AiApiRequest =
  | { kind: "claims"; request: AiRequest; items: EvidenceItem[] }
  | { kind: "polish"; text: string; mode: PolishMode }
  | { kind: "polish-batch"; mode: PolishMode; items: Array<{ id: string; text: string }> }
  | { kind: "extract"; field: string; items: EvidenceItem[] };

export type AiApiResult =
  | { kind: "claims"; claims: ModelClaim[] }
  | { kind: "polish"; proposal: PolishProposal }
  | { kind: "polish-batch"; proposals: Array<{ id: string; proposal: PolishProposal }> }
  | { kind: "extract"; proposal: ExtractProposal };

export type ServerAiErrorCode =
  | "BUSY"
  | "CANCELLED"
  | "TIMEOUT"
  | "CONFIGURATION"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_REJECTED"
  | "OPERATION_CAPACITY"
  | "INVALID_OUTPUT"
  | "INVALID_REQUEST"
  | "GROUNDING_REJECTED"
  | "NO_EVIDENCE";

export interface ServerAiFailure {
  code: ServerAiErrorCode;
  message: string;
  operation?: AiApiRequest["kind"];
  occurredAt?: string;
  requestId?: string;
  serverCode?: string;
  retryAfterMs?: number;
}
