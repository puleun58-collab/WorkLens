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
import { briefPresentationMode } from "@/lib/ai/brief";

type CanonicalEvidence = AiEvidenceNode;

export interface GroundedCompletion {
  claims: GroundedClaim[];
  rejectedClaimCount: number;
}

export function buildEvidenceNodes(documents: readonly NormalizedDocument[]): AiEvidenceNode[] {
  return collectEvidence(documents);
}

/**
 * Rebuilds each displayed fact from a one-request token index. Invalid
 * candidates are counted and omitted; valid candidates keep their canonical
 * evidence bindings.
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
  let rejectedClaimCount = 0;

  for (const candidate of completion.claims) {
    const claim = groundClaim(candidate, byToken);
    if (!claim) {
      rejectedClaimCount += 1;
      continue;
    }
    claims.push(claim);
  }
  return { claims, rejectedClaimCount };
}

export function groundAiResult(
  request: AiRequest,
  documents: readonly NormalizedDocument[],
  completion: AiProviderCompletion,
): AiAvailableResult {
  const grounded = groundProviderCompletion(documents, completion);
  const warnings = grounded.rejectedClaimCount ? [{ code: "EVIDENCE_VALIDATION_FAILED", message: "일부 내용은 문서 근거와 연결되지 않아 결과에서 제외했습니다." }] : [];
  switch (request.operation) {
    case "analyze":
      return { operation: "analyze", claims: grounded.claims, warnings, rejectedClaimCount: grounded.rejectedClaimCount };
    case "ask":
      return {
        operation: "ask",
        answer: grounded.claims.map((claim) => claim.text.replace(/^추론:\s*/u, "")).join("\n"),
        claims: grounded.claims,
        warnings,
        rejectedClaimCount: grounded.rejectedClaimCount,
      };
    case "brief": {
      const accepted = grounded.claims.filter((claim) => !unsupportedBriefDirective(claim));
      const unsupported = grounded.claims.length - accepted.length;
      const rejectedClaimCount = grounded.rejectedClaimCount + unsupported;
      const briefWarnings = rejectedClaimCount
        ? [{ code: "EVIDENCE_VALIDATION_FAILED", message: "일부 내용은 문서 근거와 연결되지 않아 결과에서 제외했습니다." }]
        : [];
      return {
        operation: "brief",
        brief: accepted.map((claim) => claim.text.replace(/^추론:\s*/u, "")).join("\n").slice(0, 800),
        presentation: { mode: briefPresentationMode(request.summaryInstruction) },
        claims: accepted,
        warnings: briefWarnings,
        rejectedClaimCount,
      };
    }
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
  const evidenceText: string[] = [];
  const seen = new Set<string>();
  for (const token of candidate.sourceTokens) {
    const canonical = evidence.get(token);
    if (!canonical || seen.has(token)) return undefined;
    seen.add(token);
    if (looksLikePromptInjection(canonical.text)) return undefined;
    evidenceText.push(canonical.text);
    bindings.push({ source: { ...canonical.source }, support: "context" });
  }
  if (!claimLiteralsAppearInEvidence(text, evidenceText)) return undefined;
  return {
    id: claimId("inference", candidate.sourceTokens.join("|"), text),
    kind: "inference",
    text: `추론: ${text}`,
    ...(candidate.confidence ? { confidence: candidate.confidence } : {}),
    ...(candidate.presentation ? { presentation: candidate.presentation } : {}),
    evidence: bindings as [EvidenceBinding, ...EvidenceBinding[]],
  };
}

const DIRECTIVE_PATTERN = /(?:해야\\s*한다|하여야\\s*한다|마련해야|검토해야|추진해야|관리해야|확인해야|필요하다|권고한다|요구한다)/u;
const SOURCE_DIRECTIVE_PATTERN = /(?:해야|하여야|필요|권고|요구|조치|계획|예정|바랍니다|하도록)/u;

/** Brief may quote a directive, but it may not turn a neutral mechanism into one. */
function unsupportedBriefDirective(claim: GroundedClaim): boolean {
  if (claim.kind !== "inference" || !DIRECTIVE_PATTERN.test(claim.text)) return false;
  return !claim.evidence.some((binding) => SOURCE_DIRECTIVE_PATTERN.test(binding.source.quote ?? ""));
}

/**
 * Evidence text carries the context a reader needs to recognise the value:
 * a table cell without its row and column header, or a slide line without its
 * slide title, is unsearchable and unreadable on its own. The canonical quote,
 * proposition and token stay bound to the raw cell so grounding is unchanged.
 */
function collectEvidence(documents: readonly NormalizedDocument[]): CanonicalEvidence[] {
  const evidence: CanonicalEvidence[] = [];
  let characters = 0;
  for (const document of documents) {
    let slideTitle = "";
    let slideKey = "";
    for (const block of document.blocks) {
      if (evidence.length >= 5_000 || characters >= 200_000) return evidence;
      if (block.type === "paragraph") {
        const locator = block.source.locator;
        const key = locator?.kind === "pptx" ? `slide:${locator.slide}` : "";
        if (key && key !== slideKey) {
          slideKey = key;
          slideTitle = cleanText(block.text).slice(0, 60);
        }
        const context = key && cleanText(block.text) !== slideTitle ? slideTitle : "";
        const node = makeEvidence(
          document,
          block.id,
          withContext(context, block.text),
          block.source,
          propositionFromText(block.text, block.source),
          block.source.quote ?? block.text,
        );
        if (node) { evidence.push(node); characters += node.text.length; }
      } else {
        const header = block.rows[0] ?? [];
        for (const [rowIndex, row] of block.rows.entries()) {
          const rowLabel = cleanText(row[0]?.display).slice(0, 40);
          // A row's own date identifies the record far better than its first
          // column alone, which repeats across every month of a log table.
          const rowDate = rowIndex === 0
            ? ""
            : row.map((entry) => cleanText(entry.display)).find((value) => ROW_DATE_PATTERN.test(value)) ?? "";
          for (const [columnIndex, cell] of row.entries()) {
            if (evidence.length >= 5_000 || characters >= 200_000) return evidence;
            const nodeId = cell.source.nodeId || block.id;
            const columnHeader = rowIndex === 0 ? "" : cleanText(header[columnIndex]?.display).slice(0, 40);
            const context = [rowLabel, rowDate, columnHeader]
              .filter((part, index, parts) => part && part !== cell.display && parts.indexOf(part) === index)
              .join(" ");
            const node = makeEvidence(document, nodeId, withContext(context, cell.display), cell.source, {
              subject: cell.source.label,
              predicate: "has_value",
              object: cell.value,
              polarity: "affirmed",
            }, cell.source.quote ?? cell.display);
            if (node) { evidence.push(node); characters += node.text.length; }
          }
        }
      }
    }
  }
  return evidence;
}

function withContext(context: string, text: string): string {
  const value = cleanText(text);
  return context && value ? `${context} · ${value}` : value;
}

const ROW_DATE_PATTERN = /^\s*(?:[0-9]{4}[-./][0-9]{1,2}(?:[-./][0-9]{1,2})?|[0-9]{1,2}\s*월(?:\s*[0-9]{1,2}\s*일)?)\s*$/u;

function makeEvidence(
  document: NormalizedDocument,
  nodeId: string,
  text: string,
  source: SourceRef,
  proposition: DirectProposition,
  rawQuote: string,
): CanonicalEvidence | undefined {
  const cleaned = cleanText(text);
  if (!cleaned || source.fileId !== document.fileId || source.nodeId !== nodeId || !isProposition(proposition)) return undefined;
  const quote = source.quote ?? rawQuote;
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
  const allowed = new Set(["type", "text", "sourceTokens", "confidence", "presentation"]);
  return Object.keys(value).every((key) => allowed.has(key))
    && typeof value.text === "string"
    && Array.isArray(value.sourceTokens)
    && value.sourceTokens.every((token) => typeof token === "string")
    && (value.confidence === undefined || isConfidence(value.confidence))
    && (value.presentation === undefined || (
      isRecord(value.presentation)
      && Object.keys(value.presentation).every((key) => key === "section" || key === "role")
      && (value.presentation.role === "summary" || value.presentation.role === "action")
      && (value.presentation.section === undefined || typeof value.presentation.section === "string")
    ));
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
const CHECKED_LITERAL_PATTERN = /(?:[A-Za-z가-힣]{1,12}[-_/])?\d[\dA-Za-z가-힣.,:/%+\-₩$]*/gu;

/**
 * A claim may only repeat literals the evidence states. Digit grouping and a
 * space before a unit are typography, not different values, so both sides are
 * compacted the same way; anything that changes a digit, a unit or a date
 * still fails.
 */
function claimLiteralsAppearInEvidence(claim: string, evidence: readonly string[]): boolean {
  const joined = normalize(evidence.join(" ")).toLocaleLowerCase("ko-KR");
  const source = compactNumerics(joined);
  const literals = claim.match(CHECKED_LITERAL_PATTERN) ?? [];
  return literals.every((literal) => {
    const normalized = normalize(literal)
      .toLocaleLowerCase("ko-KR")
      .replace(/[.,:;!?]+$/u, "");
    if (normalized.length === 0 || joined.includes(normalized)) return true;
    return source.includes(compactNumerics(normalized));
  });
}

/** `1,843.33` → `1843.33`, `75 명` → `75명`, `95 %` → `95%`. Nothing else changes. */
function compactNumerics(value: string): string {
  return value
    .replace(/(\d),(?=\d{3}(?!\d))/gu, "$1")
    .replace(/(\d)\s+(?=[%℃가-힣$₩])/gu, "$1");
}
function normalize(value: string): string { return value.normalize("NFKC").replace(/\r\n?/g, "\n").replace(/\s+/gu, " ").trim(); }
function looksLikePromptInjection(value: string): boolean { return /ignore (?:all |the )?(?:previous|prior|above) instructions|system prompt|developer message|지시(?:를|사항을)? 무시|프롬프트/ui.test(normalize(value)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isConfidence(value: unknown): value is AiConfidence { return value === "high" || value === "medium" || value === "low"; }
