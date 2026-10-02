import type { SupplementDocType } from "@/domain/supplement";

/** Opt-in test/eval instrumentation. Never stores document text or quotes. */
export type SupplementRejectReason = "covered_elsewhere" | "not_applicable" | "duplicate" | "insufficient_evidence" | "ai_rejected" | "low_confidence" | "classification_mismatch" | "system_failure" | "deferred" | "unknown";
export interface SupplementDiagnostics {
  parsedUnits: number;
  classifications: SupplementDocType[];
  initialDeterministic: number;
  deterministicCandidates: number;
  /** The current model only reviews candidates; it never generates them. */
  aiCandidates: number;
  positionSearchTargets: number;
  rebutted: number;
  final: number;
  systemAffected: boolean;
  rejected: Record<SupplementRejectReason, number>;
}
export function createSupplementDiagnostics(): SupplementDiagnostics {
  return { parsedUnits: 0, classifications: [], initialDeterministic: 0, deterministicCandidates: 0, aiCandidates: 0, positionSearchTargets: 0, rebutted: 0, final: 0, systemAffected: false,
    rejected: { covered_elsewhere: 0, not_applicable: 0, duplicate: 0, insufficient_evidence: 0, ai_rejected: 0, low_confidence: 0, classification_mismatch: 0, system_failure: 0, deferred: 0, unknown: 0 } };
}
