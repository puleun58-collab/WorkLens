import type { AiRequest } from "@/domain/ai";
import type { PolishMode, PolishProposal } from "@/domain/polish";
import type { ExtractProposal } from "@/lib/ai/extract-prompt";
import type { EvidenceItem, ModelClaim } from "@/lib/ai/prompt";

export const SERVER_AI_MAX_FILES = 5;

export type AiApiRequest =
  | { kind: "claims"; request: AiRequest; items: EvidenceItem[] }
  | { kind: "polish"; text: string; mode: PolishMode }
  | { kind: "extract"; field: string; items: EvidenceItem[] };

export type AiApiResult =
  | { kind: "claims"; claims: ModelClaim[] }
  | { kind: "polish"; proposal: PolishProposal }
  | { kind: "extract"; proposal: ExtractProposal };

export type ServerAiErrorCode =
  | "BUSY"
  | "CANCELLED"
  | "TIMEOUT"
  | "CONFIGURATION"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_OUTPUT"
  | "INVALID_REQUEST"
  | "GROUNDING_REJECTED"
  | "NO_EVIDENCE";

export interface ServerAiFailure {
  code: ServerAiErrorCode;
  message: string;
}
