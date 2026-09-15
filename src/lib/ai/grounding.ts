import type {
  AiAvailableResult,
  AiConfidence,
  AiRequest,
  DirectProposition,
  EvidenceBinding,
  GroundedClaim,
  Scalar,
} from "@/domain/ai";
import type { NormalizedDocument, SourceRef } from "@/domain/document";
import { sha256Base64Url } from "@/domain/hash";
import { AI_SCHEMA_ID, type AiEvidenceNode, type AiProviderClaim, type AiProviderCompletion } from "@/lib/ai/contract";

type CanonicalEvidence = AiEvidenceNode;

export interface GroundedCompletion {
  claims: GroundedClaim[];
  rejectedClaimCount: number;
}

export function buildEvidenceNodes(documents: readonly NormalizedDocument[]): AiEvidenceNode[] {
  return collectEvidence(documents);
}

/**
 * Rebuilds every displayed fact from a one-request token index. Any invalid
 * candidate rejects the entire completion; callers must never release a subset.
 */
export function groundProviderCompletion(
  documents: readonly NormalizedDocument[],
  completion: AiProviderCompletion,
): GroundedCompletion {
  if (completion.schemaId !== AI_SCHEMA_ID || !Array.isArray(completion.claims)) {
    return { claims: [], rejectedClaimCount: 1 };
  }
  const evidence = collectEvidence(documents);
  const byToken = new Map(evidence.map((node) => [node.propositionToken, node]));
  const claims: GroundedClaim[] = [];

  for (const candidate of completion.claims) {
    const claim = groundClaim(candidate, byToken);
    if (!claim) return { claims: [], rejectedClaimCount: completion.claims.length || 1 };
    claims.push(claim);
  }
  return { claims, rejectedClaimCount: 0 };
}

export function groundAiResult(
  request: AiRequest,
  documents: readonly NormalizedDocument[],
  completion: AiProviderCompletion,
): AiAvailableResult {
  const grounded = groundProviderCompletion(documents, completion);
  const warnings = grounded.rejectedClaimCount ? [{ code: "EVIDENCE_VALIDATION_FAILED", message: "근거 검증에 실패했습니다." }] : [];
  switch (request.operation) {
    case "analyze":
      return { operation: "analyze", claims: grounded.claims, warnings, rejectedClaimCount: grounded.rejectedClaimCount };
    case "ask":
      return {
        operation: "ask",
        answer: grounded.claims.map((claim) => claim.text).join("\n"),
        claims: grounded.claims,
        warnings,
        rejectedClaimCount: grounded.rejectedClaimCount,
      };
    case "brief":
      return {
        operation: "brief",
        brief: grounded.claims.map((claim) => claim.text).join("\n").slice(0, 800),
        claims: grounded.claims,
        warnings,
        rejectedClaimCount: grounded.rejectedClaimCount,
      };
    case "semantic-check":
      return { operation: "semantic-check", findings: grounded.claims, claims: grounded.claims, warnings, rejectedClaimCount: grounded.rejectedClaimCount };
  }
}

function groundClaim(candidate: AiProviderClaim, evidence: ReadonlyMap<string, CanonicalEvidence>): GroundedClaim | undefined {
  if (!isProviderClaim(candidate)) return undefined;
  if (candidate.type === "direct") {
    const canonical = evidence.get(candidate.propositionToken);
    const proposed: DirectProposition = {
      subject: candidate.subject,
      predicate: candidate.predicate,
      object: candidate.object,
      polarity: candidate.polarity,
      ...(candidate.qualifiers ? { qualifiers: candidate.qualifiers } : {}),
    };
    if (!canonical || !sameProposition(proposed, canonical.proposition)) return undefined;
    const binding: EvidenceBinding = { source: { ...canonical.source }, support: "direct" };
    return {
      id: claimId("fact", canonical.propositionToken),
      kind: "fact",
      proposition: canonical.proposition,
      text: renderDirectFact(canonical.proposition),
      evidence: [binding],
    };
  }

  const text = cleanText(candidate.text);
  if (!text || candidate.sourceTokens.length === 0) return undefined;
  const bindings: EvidenceBinding[] = [];
  const seen = new Set<string>();
  for (const token of candidate.sourceTokens) {
    const canonical = evidence.get(token);
    if (!canonical || seen.has(token)) return undefined;
    seen.add(token);
    if (looksLikePromptInjection(canonical.text)) return undefined;
    bindings.push({ source: { ...canonical.source }, support: "context" });
  }
  return {
    id: claimId("inference", candidate.sourceTokens.join("|"), text),
    kind: "inference",
    text: `추론: ${text}`,
    ...(candidate.confidence ? { confidence: candidate.confidence } : {}),
    evidence: bindings as [EvidenceBinding, ...EvidenceBinding[]],
  };
}

function collectEvidence(documents: readonly NormalizedDocument[]): CanonicalEvidence[] {
  const evidence: CanonicalEvidence[] = [];
  let characters = 0;
  for (const document of documents) {
    for (const block of document.blocks) {
      if (evidence.length >= 5_000 || characters >= 200_000) return evidence;
      if (block.type === "paragraph") {
        const node = makeEvidence(document, block.id, block.text, block.source, propositionFromText(block.text, block.source));
        if (node) { evidence.push(node); characters += node.text.length; }
      } else {
        for (const row of block.rows) for (const cell of row) {
          if (evidence.length >= 5_000 || characters >= 200_000) return evidence;
          const nodeId = cell.source.nodeId || block.id;
          const node = makeEvidence(document, nodeId, cell.display, cell.source, {
            subject: cell.source.label,
            predicate: "has_value",
            object: cell.value,
            polarity: "affirmed",
          });
          if (node) { evidence.push(node); characters += node.text.length; }
        }
      }
    }
  }
  return evidence;
}

function makeEvidence(document: NormalizedDocument, nodeId: string, text: string, source: SourceRef, proposition: DirectProposition): CanonicalEvidence | undefined {
  const cleaned = cleanText(text);
  if (!cleaned || source.fileId !== document.fileId || source.nodeId !== nodeId || !isProposition(proposition)) return undefined;
  const quote = source.quote ?? text;
  const canonicalSource: SourceRef = {
    ...source,
    fileId: document.fileId,
    documentId: document.id,
    ...(document.version ? { documentVersion: document.version } : {}),
    nodeId,
    quote,
    quoteHash: quoteHash(quote),
  };
  const propositionToken = sha256Base64Url(JSON.stringify([document.fileId, document.id, document.version ?? "", nodeId, proposition, canonicalSource.quoteHash]));
  return { fileId: document.fileId, nodeId, source: canonicalSource, text: cleaned, propositionToken, proposition };
}

function propositionFromText(text: string, source: SourceRef): DirectProposition {
  const match = /^\s*(.+?)(?:은|는)\s+(-?\d+(?:\.\d+)?)에서\s+(-?\d+(?:\.\d+)?)으로\s+(증가|상승|감소|하락)(?:했습니다|했다|함)?\.?\s*$/u.exec(text);
  if (match) {
    return {
      subject: match[1].trim(),
      predicate: match[4] === "증가" || match[4] === "상승" ? "increased_from_to" : "decreased_from_to",
      object: { before: Number(match[2]), after: Number(match[3]) },
      polarity: "affirmed",
    };
  }
  return { subject: source.label, predicate: "contains", object: text, polarity: "affirmed" };
}

function isProviderClaim(value: unknown): value is AiProviderClaim {
  if (!isRecord(value)) return false;
  if (value.type === "direct") {
    const allowed = new Set(["type", "propositionToken", "subject", "predicate", "object", "polarity", "qualifiers"]);
    return Object.keys(value).every((key) => allowed.has(key)) && typeof value.propositionToken === "string" && isProposition({
      subject: value.subject,
      predicate: value.predicate,
      object: value.object,
      polarity: value.polarity,
      ...(value.qualifiers === undefined ? {} : { qualifiers: value.qualifiers }),
    });
  }
  if (value.type !== "inference") return false;
  const allowed = new Set(["type", "text", "sourceTokens", "confidence"]);
  return Object.keys(value).every((key) => allowed.has(key))
    && typeof value.text === "string"
    && Array.isArray(value.sourceTokens)
    && value.sourceTokens.every((token) => typeof token === "string")
    && (value.confidence === undefined || isConfidence(value.confidence));
}

function isProposition(value: unknown): value is DirectProposition {
  if (!isRecord(value) || typeof value.subject !== "string" || !value.subject.trim() || !isDirectPredicate(value.predicate) || (value.polarity !== "affirmed" && value.polarity !== "negated")) return false;
  if (!isDirectObject(value.object)) return false;
  if (value.qualifiers === undefined) return true;
  return isRecord(value.qualifiers) && Object.entries(value.qualifiers).every(([key, scalar]) => key.trim().length > 0 && isScalar(scalar));
}

function isDirectPredicate(value: unknown): value is DirectProposition["predicate"] {
  return typeof value === "string" && ["has_value", "equals", "contains", "increased_from_to", "decreased_from_to", "unchanged", "added", "removed", "structural_change", "exposes", "omits", "conflicts_with", "repeats"].includes(value);
}
function isDirectObject(value: unknown): boolean {
  if (isScalar(value)) return true;
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key === "before" || key === "after") && keys.every((key) => isScalar(value[key]));
}
function isScalar(value: unknown): value is Scalar { return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"; }
function sameProposition(left: DirectProposition, right: DirectProposition): boolean {
  return normalize(left.subject) === normalize(right.subject) && left.predicate === right.predicate && left.polarity === right.polarity && sameValue(left.object, right.object) && sameQualifiers(left.qualifiers, right.qualifiers);
}
function sameQualifiers(left: DirectProposition["qualifiers"], right: DirectProposition["qualifiers"]): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length && leftEntries.every(([key, value], index) => key === rightEntries[index][0] && sameValue(value, rightEntries[index][1]));
}
function sameValue(left: unknown, right: unknown): boolean {
  if (isScalar(left) && isScalar(right)) return typeof left === "string" && typeof right === "string" ? normalize(left) === normalize(right) : Object.is(left, right);
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort(); const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]));
}

function renderDirectFact(proposition: DirectProposition): string {
  const value = formatObject(proposition.object);
  switch (proposition.predicate) {
    case "has_value": case "equals": return `${proposition.subject}은 ${value}이다`;
    case "increased_from_to": return `${proposition.subject}은 ${formatTransition(proposition.object, "증가했다")}`;
    case "decreased_from_to": return `${proposition.subject}은 ${formatTransition(proposition.object, "감소했다")}`;
    case "unchanged": return `${proposition.subject}은 ${value}으로 변함없다`;
    case "contains": return `${proposition.subject}에 “${value}” 내용이 있다`;
    default: return `${proposition.subject}은 ${value} ${predicateLabel(proposition.predicate)}`;
  }
}
function formatTransition(value: DirectProposition["object"], verb: string): string {
  return isRecord(value) && "before" in value && "after" in value ? `${formatObject(value.before)}에서 ${formatObject(value.after)}으로 ${verb}` : `${formatObject(value)} ${verb}`;
}
function formatObject(value: unknown): string {
  if (value === null) return "비어 있음";
  if (isRecord(value)) return ["before", "after"].filter((key) => key in value).map((key) => `${key} ${formatObject(value[key])}`).join(", ");
  return String(value);
}
function predicateLabel(predicate: DirectProposition["predicate"]): string { return predicate.replaceAll("_", " "); }
function quoteHash(value: string): string { return sha256Base64Url(value); }
function claimId(...values: string[]): string { return sha256Base64Url(values.join("\0")); }
function cleanText(value: string | undefined): string { return typeof value === "string" ? value.trim().slice(0, 8_000) : ""; }
function normalize(value: string): string { return value.normalize("NFKC").replace(/\r\n?/g, "\n").replace(/\s+/gu, " ").trim(); }
function looksLikePromptInjection(value: string): boolean { return /ignore (?:all |the )?(?:previous|prior|above) instructions|system prompt|developer message|지시(?:를|사항을)? 무시|프롬프트/ui.test(normalize(value)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isConfidence(value: unknown): value is AiConfidence { return value === "high" || value === "medium" || value === "low"; }
