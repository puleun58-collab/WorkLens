import type { IssueEvidence, StructureShadowDecision, StructureShadowRecord } from "@/lib/law-research";
import type { ResearchAdoptionCandidate, ResearchAdoptionVerdict } from "@/lib/research-relevance";
import {
  decideStructure, structureFollowUp, structureIssueStatus, structureRawCounts, validateAdoptionStructure,
  type FactFrame, type StructureCandidate, type StructureState,
} from "@/lib/research-structure";
import { workerEnv } from "@/server/cf-env";

/**
 * Structural shadow mode (DESIGN §5-1 ①): staging only, enabled by
 * `LAW_STRUCTURE_SHADOW=1`. It computes the structural decision for every
 * (issue, candidate) the existing gates judged and records the differences.
 * It never changes adoption, issue status or the overall status.
 */
export function structureShadowEnabled(): boolean {
  return workerEnv().LAW_STRUCTURE_SHADOW === "1";
}

type LegacyOutcome = { adopted: boolean; role?: "direct" | "supporting" | "identity"; identity: boolean };
type Klass = "direct" | "supporting" | "rejected";

const legacyClass = (outcome: LegacyOutcome | undefined): Klass => !outcome?.adopted ? "rejected"
  : outcome.role === "supporting" ? "supporting" : "direct";
const shadowClass = (state: StructureState, identity: boolean): Klass => identity || state === "direct" ? "direct"
  : state === "supporting" ? "supporting" : "rejected";

export function buildStructureShadow(input: {
  query: string;
  issues: ReadonlyArray<{ label?: string; query: string }>;
  candidates: readonly ResearchAdoptionCandidate[];
  /** Model-visible originals (W1); undefined when the verifier was never reached. */
  evaluated: ReadonlyMap<string, ResearchAdoptionVerdict["window"]> | undefined;
  verification: "verified" | "unavailable";
  structureRaw: unknown;
  factFrame: { frame?: FactFrame; dropped: number } | undefined;
  legacyOutcomes: ReadonlyMap<string, LegacyOutcome>;
  issueStates: ReadonlyArray<{ status: IssueEvidence["status"]; lookup?: "found" | "none" | "failed" | "timeout"; chainFailed: boolean }>;
}): StructureShadowRecord {
  const { query, issues, candidates, evaluated, verification, structureRaw, factFrame, legacyOutcomes, issueStates } = input;
  const frame = factFrame?.frame;
  const structural = new Map<string, StructureCandidate>(candidates.map((candidate) => {
    const window = evaluated?.get(candidate.id);
    const visibleText = window ? candidate.text.slice(window.start, window.end) : candidate.text;
    return [candidate.id, { id: candidate.id, kind: candidate.kind, law: candidate.law, title: candidate.title,
      text: candidate.text, visibleText, partial: candidate.partial, ...(window ? { window } : {}) }];
  }));
  const validated = verification === "verified" && candidates.length
    ? validateAdoptionStructure(structureRaw, frame, structural, issues.length) : undefined;
  const adoption: StructureShadowRecord["adoption"] = !candidates.length ? "not_run"
    : verification === "unavailable" ? "unavailable" : validated ? "verified" : "malformed";
  const decisions: StructureShadowDecision[] = [];
  for (let issueIndex = 0; issueIndex < issues.length; issueIndex++) {
    for (const candidate of candidates) {
      const shaped = structural.get(candidate.id)!;
      const key = `${issueIndex}\0${candidate.id}`;
      const comparison = validated?.comparisons.get(key);
      const screen = comparison ? undefined : validated?.screens.get(key);
      const profile = validated?.profiles.get(candidate.id);
      const decision = decideStructure({
        candidate: shaped,
        evidence: { verification: adoption === "unavailable" ? "unavailable" : adoption === "malformed" ? "malformed" : "verified",
          shown: Boolean(evaluated?.has(candidate.id)) },
        comparison, screen, profile, frame, originalQuery: query,
      });
      const legacy = legacyOutcomes.get(key) ?? { adopted: false, identity: false };
      // §4.4: identity needs a complete official original; its comparison is still shown.
      const identity = legacy.identity && !candidate.partial;
      decisions.push({
        issueIndex, candidateId: candidate.id, kind: candidate.kind,
        ...(candidate.law ? { law: candidate.law } : {}), ...(candidate.jo ? { jo: candidate.jo } : {}),
        ...(candidate.decisionKey ? { decisionKey: candidate.decisionKey } : {}),
        ...(shaped.window ? { window: shaped.window } : {}),
        complete: !candidate.partial && !shaped.window,
        identity,
        ...(identity && decision.state === "not_relevant" ? { identityMismatch: true as const } : {}),
        state: decision.state,
        ...(decision.subReason ? { subReason: decision.subReason } : {}),
        rule: decision.rule, signals: decision.signals, unconfirmed: decision.unconfirmed,
        ...(comparison ? { comparison } : {}),
        ...(screen ? { screen } : {}),
        ...(profile ? { effectType: profile.effectType } : {}),
        legacy: { adopted: legacy.adopted, ...(legacy.role ? { role: legacy.role } : {}) },
        differs: legacyClass(legacy) !== shadowClass(decision.state, identity),
      });
    }
  }
  const issueRecords = issues.map((issue, issueIndex) => {
    const own = decisions.filter((decision) => decision.issueIndex === issueIndex);
    const state = issueStates[issueIndex];
    const lookup = state?.lookup ?? (state?.chainFailed ? "failed" : undefined);
    const { status, unconfirmed } = structureIssueStatus(own, lookup);
    const followUp = status === "needs_confirmation" ? structureFollowUp(unconfirmed) : undefined;
    return { issueIndex, ...(issue.label ? { label: issue.label } : {}), legacyStatus: state?.status ?? "none", status, unconfirmed,
      ...(followUp ? { followUp } : {}), differs: (state?.status ?? "none") !== status };
  });
  const articles = new Map<string, { law: string; jo: string; state: "direct" | "supporting" }>();
  for (const decision of decisions) {
    if (decision.kind !== "article" || !decision.law || !decision.jo) continue;
    const klass = shadowClass(decision.state, decision.identity);
    if (klass === "rejected") continue;
    const key = `${decision.law}\0${decision.jo}`;
    if (articles.get(key)?.state !== "direct") articles.set(key, { law: decision.law, jo: decision.jo, state: klass });
  }
  return {
    mode: "shadow",
    ...(frame ? { factFrame: frame } : {}),
    factFrameDropped: factFrame?.dropped ?? 0,
    adoption, decisions, issues: issueRecords, articles: [...articles.values()],
    differences: decisions.filter((decision) => decision.differs).length + issueRecords.filter((issue) => issue.differs).length,
    ...(verification === "verified" && candidates.length
      ? { recording: { raw: structureRawCounts(structureRaw), ...(validated ? { ignored: validated.ignored, copied: validated.copied } : {}) } } : {}),
  };
}

/** Counts only: no user text, quotes or spans in logs. */
export function logStructureShadow(requestId: string, record: StructureShadowRecord): void {
  const byState: Record<string, number> = {};
  for (const decision of record.decisions) {
    const key = decision.subReason ? `${decision.state}:${decision.subReason}` : decision.state;
    byState[key] = (byState[key] ?? 0) + 1;
  }
  // §9 fix2: pre-validation row counts and discarded rows by reason (never the samples, which carry quotes).
  const ignored = record.recording?.ignored;
  const recording = record.recording ? { raw: record.recording.raw,
    ...(ignored ? { ignored: { profiles: ignored.profiles, comparisons: ignored.comparisons, screens: ignored.screens,
      requirementQuotesUnverified: ignored.requirementQuotesUnverified, comparisonQuotesUnverified: ignored.comparisonQuotesUnverified,
      quoteForms: ignored.quoteForms } } : {}),
    ...(record.recording.copied !== undefined ? { copied: record.recording.copied } : {}) } : undefined;
  console.info("[law][structure-shadow]", {
    requestId, adoption: record.adoption, factFrameDropped: record.factFrameDropped,
    decisions: record.decisions.length, byState, differences: record.differences,
    ...(recording ? { recording } : {}),
    issues: record.issues.map(({ issueIndex, legacyStatus, status }) => ({ issueIndex, legacyStatus, status })),
  });
}
