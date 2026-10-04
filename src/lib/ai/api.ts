import type { AxDiagnosisRequest, AxPlanRequest, AxDiagnosis, AxPlan } from "@/lib/ax/types";
import type { AiRequest } from "@/domain/ai";
import type { PolishMode, PolishProposal } from "@/domain/polish";
import type { SupplementReviewVerdict } from "@/domain/supplement";
import type { ExtractProposal } from "@/lib/ai/extract-prompt";
import type { EvidenceItem, ModelClaim } from "@/lib/ai/prompt";
import type { SupplementReviewCheck } from "@/lib/ai/supplement-prompt";

export const SERVER_AI_MAX_FILES = 5;
/** Candidates re-checked per request; each brings its own few evidence lines. */
export const SUPPLEMENT_REVIEW_MAX_CHECKS = 6;
export const POLISH_BATCH_MAX_ITEMS = 8;
export const POLISH_BATCH_MAX_CHARS = 2_400;

export type AiApiRequest =
  | AxDiagnosisRequest
  | AxPlanRequest
  | { kind: "claims"; request: AiRequest; items: EvidenceItem[] }
  | { kind: "polish"; text: string; mode: PolishMode }
  | { kind: "polish-batch"; mode: PolishMode; items: Array<{ id: string; text: string }> }
  | { kind: "extract"; field: string; items: EvidenceItem[] }
  | { kind: "supplement-review"; checks: SupplementReviewCheck[]; items: EvidenceItem[] };

export type AiApiResult =
  | { kind: "ax-diagnosis"; diagnosis: Omit<AxDiagnosis, "sourceNote" | "planCodex" | "planClaude"> }
  | { kind: "ax-plan"; plan: AxPlan }
  | { kind: "claims"; claims: ModelClaim[] }
  | { kind: "polish"; proposal: PolishProposal }
  | { kind: "polish-batch"; proposals: Array<{ id: string; proposal: PolishProposal }> }
  | { kind: "extract"; proposal: ExtractProposal }
  | { kind: "supplement-review"; verdicts: SupplementReviewVerdict[] };

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
