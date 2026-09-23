import type { SourceRef } from "@/domain/document";

export type AiOperation = "analyze" | "ask" | "semantic-check";
export type Scalar = string | number | boolean | null;
export type DirectPredicate =
  | "has_value"
  | "equals"
  | "contains"
  | "increased_from_to"
  | "decreased_from_to"
  | "unchanged"
  | "added"
  | "removed"
  | "structural_change"
  | "exposes"
  | "omits"
  | "conflicts_with"
  | "repeats";

export interface DirectProposition {
  subject: string;
  predicate: DirectPredicate;
  object: Scalar | { before?: Scalar; after?: Scalar };
  polarity: "affirmed" | "negated";
  qualifiers?: Record<string, Scalar>;
}

export interface EvidenceBinding {
  source: SourceRef;
  support: "direct" | "computed" | "context";
  derivation?: { op: string; inputs: SourceRef[] };
}

export interface DirectFact {
  id: string;
  kind: "fact";
  proposition: DirectProposition;
  text: string;
  evidence: [EvidenceBinding, ...EvidenceBinding[]];
}

export type AiConfidence = "high" | "medium" | "low";

export interface InferenceClaim {
  id: string;
  kind: "inference";
  text: string;
  /** Model-reported certainty. Absent means the caller must treat it as low. */
  confidence?: AiConfidence;
  /** Analyze display role only; never contributes facts or evidence. */
  presentation?: AnalyzeClaimPresentation;
  evidence: [EvidenceBinding, ...EvidenceBinding[]];
}

export type GroundedClaim = DirectFact | InferenceClaim;
export interface AnalyzeClaimPresentation {
  role: "summary" | "insight";
  section?: string;
}
export type AiClaim = GroundedClaim;
export interface ResultWarning { code: string; message: string; }
export interface GroundedResult { claims: GroundedClaim[]; warnings: ResultWarning[]; }

export interface AnalyzeRequest { operation: "analyze"; }
export interface AskRequest { operation: "ask"; question: string; }
/** `scope` distinguishes version comparison from writing review; both ground identically. */
export interface SemanticCheckRequest { operation: "semantic-check"; statement: string; scope?: "comparison" }
export type AiRequest = AnalyzeRequest | AskRequest | SemanticCheckRequest;

export interface AnalyzeResult extends GroundedResult { operation: "analyze"; rejectedClaimCount: number; }
export interface AskResult extends GroundedResult { operation: "ask"; answer: string; rejectedClaimCount: number; }
export interface SemanticCheckResult extends GroundedResult { operation: "semantic-check"; findings: GroundedClaim[]; rejectedClaimCount: number; }
export type AiAvailableResult = AnalyzeResult | AskResult | SemanticCheckResult;

