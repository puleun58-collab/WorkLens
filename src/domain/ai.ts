import type { SourceRef } from "@/domain/document";

export type AiOperation = "analyze" | "ask" | "brief" | "semantic-check";
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
  /** Brief-only display hints. They never contribute facts or evidence. */
  presentation?: BriefClaimPresentation;
  evidence: [EvidenceBinding, ...EvidenceBinding[]];
}

export type GroundedClaim = DirectFact | InferenceClaim;
export type BriefPresentationMode = "bullets" | "lines" | "report" | "sections" | "actions";
export type BriefClaimRole = "summary" | "action";
export interface BriefClaimPresentation {
  section?: string;
  role: BriefClaimRole;
}
export type AiClaim = GroundedClaim;
export interface ResultWarning { code: string; message: string; }
export interface GroundedResult { claims: GroundedClaim[]; warnings: ResultWarning[]; }

export interface AnalyzeRequest { operation: "analyze"; }
export interface AskRequest { operation: "ask"; question: string; }
export interface BriefRequest { operation: "brief"; summaryInstruction?: string; }
export interface SemanticCheckRequest { operation: "semantic-check"; statement: string; }
export type AiRequest = AnalyzeRequest | AskRequest | BriefRequest | SemanticCheckRequest;

export interface AnalyzeResult extends GroundedResult { operation: "analyze"; rejectedClaimCount: number; }
export interface AskResult extends GroundedResult { operation: "ask"; answer: string; rejectedClaimCount: number; }
export interface BriefResult extends GroundedResult {
  operation: "brief";
  brief: string;
  presentation: { mode: BriefPresentationMode };
  rejectedClaimCount: number;
}
export interface SemanticCheckResult extends GroundedResult { operation: "semantic-check"; findings: GroundedClaim[]; rejectedClaimCount: number; }
export type AiAvailableResult = AnalyzeResult | AskResult | BriefResult | SemanticCheckResult;

