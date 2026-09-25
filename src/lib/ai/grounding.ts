import type {
  AiAvailableResult,
  AiConfidence,
  AiRequest,
  DirectProposition,
  EvidenceBinding,
  GroundedClaim,
  Scalar,
} from "@/domain/ai";
import type { NormalizedDocument, SourceRef, TableBlock, TableCell } from "@/domain/document";
import { sha256Base64Url } from "@/domain/hash";
import { boundedEvidenceCandidates } from "@/lib/ai/retrieval";
import { AI_SCHEMA_ID, type AiEvidenceNode, type AiProviderClaim, type AiProviderCompletion } from "@/lib/ai/contract";

type CanonicalEvidence = AiEvidenceNode;

export interface GroundedCompletion {
  claims: GroundedClaim[];
  rejectedClaimCount: number;
}

export function buildEvidenceNodes(documents: readonly NormalizedDocument[], request: AiRequest = { operation: "analyze" }): AiEvidenceNode[] {
  return boundedEvidenceCandidates(documents.map((document) => evidenceNodes(document)), request);
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
  const requiredTokens = new Set<string>();
  for (const claim of completion.claims) {
    if (claim.type === "direct") requiredTokens.add(claim.propositionToken);
    else if (claim.type === "inference" && Array.isArray(claim.sourceTokens)) {
      for (const token of claim.sourceTokens) if (typeof token === "string") requiredTokens.add(token);
    }
  }
  const byToken = new Map<string, CanonicalEvidence>();
  if (requiredTokens.size > 0) {
    scan: for (const document of documents) {
      for (const node of evidenceNodes(document)) {
        if (requiredTokens.has(node.propositionToken)) byToken.set(node.propositionToken, node);
        if (byToken.size === requiredTokens.size) break scan;
      }
    }
  }
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
  if (request.operation === "analyze") {
    let summaries = 0;
    let insights = 0;
    const accepted = grounded.claims.filter((claim) => {
      if (claim.kind !== "inference" || !claim.presentation || unsupportedDirective(claim) || unsupportedCause(claim)
        || unsupportedCondition(claim) || unsupportedOmission(claim) || unsupportedEffect(claim)) return false;
      if (claim.presentation.role === "summary") return ++summaries <= 4;
      return ++insights <= 3;
    });
    const rejectedClaimCount = grounded.rejectedClaimCount + grounded.claims.length - accepted.length;
    return { operation: "analyze", claims: accepted, warnings: evidenceWarnings(rejectedClaimCount), rejectedClaimCount };
  }
  const warnings = evidenceWarnings(grounded.rejectedClaimCount);
  switch (request.operation) {
    case "ask":
      return {
        operation: "ask",
        answer: grounded.claims.map((claim) => claim.text.replace(/^추론:\s*/u, "")).join("\n"),
        claims: grounded.claims,
        warnings,
        rejectedClaimCount: grounded.rejectedClaimCount,
      };
    case "semantic-check":
      return { operation: "semantic-check", findings: grounded.claims, claims: grounded.claims, warnings, rejectedClaimCount: grounded.rejectedClaimCount };
  }
}

function evidenceWarnings(rejectedClaimCount: number): { code: string; message: string }[] {
  return rejectedClaimCount ? [{ code: "EVIDENCE_VALIDATION_FAILED", message: "일부 내용은 문서 근거와 연결되지 않아 결과에서 제외했습니다." }] : [];
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

const DIRECTIVE_PATTERN = /(?:해야|하여야|필요(?:합니다|하다|함)|필수(?:입니다|이다)|의무(?:입니다|이다)|권(?:고|장)(?:합니다|한다)|요구(?:합니다|한다)|금지(?:합니다|한다)|하(?:세|십시(?:오|요))|\b(?:should|must|need(?:s)? to|required to|recommend(?:ed)?(?: to)?)\b)/iu;
const SOURCE_DIRECTIVE_PATTERN = /(?:해야|하여야|필수|의무|권고|권장|요구|금지|필요(?:합니다|하다|함)|하도록|바랍니다|하(?:세|십시(?:오|요))|\b(?:shall|should|must|need(?:s)? to|required|recommend(?:ed)?)\b)/iu;

/** A summary may report an explicit instruction, but not prescribe one from neutral evidence. */
function unsupportedDirective(claim: GroundedClaim): boolean {
  if (claim.kind !== "inference" || !DIRECTIVE_PATTERN.test(claim.text)) return false;
  return !claim.evidence.some((binding) => SOURCE_DIRECTIVE_PATTERN.test(binding.source.quote ?? ""));
}

const CAUSE_PATTERN = /(?:때문|로\s*인해|으로\s*인해|탓에?|원인(?:은|이|으로)?|덕분|영향으로|\b(?:because|due to|caused by|as a result of|owing to)\b)/iu;
const SOURCE_CAUSE_PATTERN = /(?:때문|인해|탓|원인|덕분|영향|따라|따른|결과|\b(?:because|due to|caused|result|owing|since|therefore)\b)/iu;

/**
 * A cause is a claim of its own. Numbers moving together do not say why, so
 * a "because" survives only when a cited source itself states a reason.
 */
function unsupportedCause(claim: GroundedClaim): boolean {
  if (claim.kind !== "inference" || !CAUSE_PATTERN.test(claim.text)) return false;
  return !claim.evidence.some((binding) => SOURCE_CAUSE_PATTERN.test(binding.source.quote ?? ""));
}

const CONDITION_PATTERN = /(?:(?:하|되|이|으|지|나|라|다|없으|있으|않으)면[\s,]|경우(?:에는|에)?\s|\b(?:if|when|unless|once)\b)/iu;
const SOURCE_RELATION_PATTERN = /(?:면(?:[\s,.]|$)|경우|때|(?:^|\s)단[,\s]|다만|예외|제외|대신|후|뒤|이후|전에|까지|→|->|따라|때문|인해|므로|\b(?:if|when|unless|once|after|before|except|until|otherwise|then)\b)/iu;

/**
 * "If X, then Y" is a rule, and rules come from the document. A conditional
 * survives only when a cited source itself states a condition, sequence or
 * exception; a model joining two unrelated facts with "되면" does not.
 */
function unsupportedCondition(claim: GroundedClaim): boolean {
  if (claim.kind !== "inference" || !CONDITION_PATTERN.test(claim.text)) return false;
  return !claim.evidence.some((binding) => SOURCE_RELATION_PATTERN.test(binding.source.quote ?? ""));
}

const OMISSION_PATTERN = /(?:생략|없이|불필요|필요\s*없|면제|건너뛰|하지\s*않|되지\s*않|않(?:는다|습니다|아도)|(?:^|\s)안\s|(?:^|\s)못\s|\b(?:skip(?:s|ped)?|omit(?:s|ted)?|without|not|never|no longer|exempt(?:ed)?|waive[sd]?)\b)/iu;
const SOURCE_NEGATION_PATTERN = /(?:생략|없|불필요|면제|건너뛰|않|안\s|못\s|아니|제외|금지|불가|\b(?:skip|omit|without|not|no|never|exempt|waive|except)\b)/iu;
const EFFECT_PATTERN = /(단축|증가|감소|개선|악화|향상|절감|하락|상승|확대|축소)(?:될|할|시킬|되어|돼)\s*수\s*있/u;

/**
 * Saying a step is skipped, not needed or not done reverses a source that
 * only states the step ("선처리 후 사후 승인" is not "사후 승인 생략"). An
 * omission survives only when a cited source itself negates or exempts.
 */
function unsupportedOmission(claim: GroundedClaim): boolean {
  if (claim.kind !== "inference" || !OMISSION_PATTERN.test(claim.text)) return false;
  return !claim.evidence.some((binding) => SOURCE_NEGATION_PATTERN.test(binding.source.quote ?? ""));
}

/** "…이 단축될 수 있습니다" predicts an effect; it needs a source that names that change. */
function unsupportedEffect(claim: GroundedClaim): boolean {
  const effect = claim.kind === "inference" ? EFFECT_PATTERN.exec(claim.text)?.[1] : undefined;
  if (!effect) return false;
  return !claim.evidence.some((binding) => (binding.source.quote ?? "").includes(effect));
}

/**
 * Stream all canonical locations. Retrieval retains only a bounded selection;
 * grounding independently rebuilds only tokens the provider actually cited.
 */
function* evidenceNodes(document: NormalizedDocument): Generator<CanonicalEvidence> {
  let slideTitle = "";
  let slideKey = "";
  for (const block of document.blocks) {
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
      if (node) yield block.role === "heading" ? { ...node, role: "heading" } : node;
    } else {
      // Real sheets often open with a one-cell title and blank spacer rows, so
      // the column header is the first row with more than one populated cell.
      const found = block.rows.findIndex((row) => row.filter((cell) => cleanText(cell.display)).length > 1);
      const headerIndex = found === -1 ? 0 : found;
      const header = block.rows[headerIndex] ?? [];
      const outliers = columnOutliers(block.rows, headerIndex);
      for (const [rowIndex, row] of block.rows.entries()) {
        // The record's name is its first textual cell: a leading blank or a bare
        // sequence/month number ("8") does not identify the row.
        const rowLabel = row.map((entry) => cleanText(entry.display)).find((value) => value && !BARE_NUMBER_PATTERN.test(value))?.slice(0, 40) ?? "";
        // A row's own date identifies the record far better than its first
        // column alone, which repeats across every month of a log table.
        const rowDate = rowIndex <= headerIndex
          ? ""
          : row.map((entry) => cleanText(entry.display)).find((value) => ROW_DATE_PATTERN.test(value)) ?? "";
        for (const [columnIndex, cell] of row.entries()) {
          const nodeId = cell.source.nodeId || block.id;
          const columnHeader = rowIndex <= headerIndex ? "" : cleanText(header[columnIndex]?.display).slice(0, 40);
          const context = [rowLabel, rowDate, columnHeader]
            .filter((part, index, parts) => part && part !== cell.display && parts.indexOf(part) === index)
            .join(" ");
          const node = makeEvidence(document, nodeId, withContext(context, cell.display), cell.source, {
            subject: cell.source.label,
            predicate: "has_value",
            object: cell.value,
            polarity: "affirmed",
          }, cell.source.quote ?? cell.display);
          if (node) yield outliers.has(cell) ? { ...node, outlier: true } : node;
        }
      }
    }
  }
}

function withContext(context: string, text: string): string {
  const value = cleanText(text);
  return context && value ? `${context} · ${value}` : value;
}

/**
 * Cells whose number sits far outside the rest of its column, by median and
 * median absolute deviation (robust to the outlier itself). Needs enough
 * values that "the rest" is a pattern; flags at most one in a hundred.
 */
function columnOutliers(rows: TableBlock["rows"], headerIndex: number): Set<TableCell> {
  const flagged = new Set<TableCell>();
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  for (let column = 0; column < width; column += 1) {
    const cells: TableCell[] = [];
    for (let row = headerIndex + 1; row < rows.length; row += 1) {
      const cell = rows[row][column];
      if (cell && typeof cell.value === "number" && Number.isFinite(cell.value)) cells.push(cell);
    }
    if (cells.length < 12) continue;
    const values = cells.map((cell) => cell.value as number).sort((left, right) => left - right);
    const median = values[Math.floor(values.length / 2)];
    const deviations = values.map((value) => Math.abs(value - median)).sort((left, right) => left - right);
    const mad = deviations[Math.floor(deviations.length / 2)];
    if (mad === 0) continue;
    const extreme = cells.filter((cell) => Math.abs((cell.value as number) - median) / mad >= 10);
    if (extreme.length > 0 && extreme.length <= Math.max(1, Math.floor(cells.length / 100))) for (const cell of extreme) flagged.add(cell);
  }
  return flagged;
}

const ROW_DATE_PATTERN = /^\s*(?:[0-9]{4}[-./][0-9]{1,2}(?:[-./][0-9]{1,2})?|[0-9]{1,2}\s*월(?:\s*[0-9]{1,2}\s*일)?)\s*$/u;
const BARE_NUMBER_PATTERN = /^[0-9.,\s]+$/u;

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
      && (value.presentation.role === "summary" || value.presentation.role === "insight")
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
/** Josa and copula endings a sentence attaches to a quoted value ("67%이다", "BP-08-01은"). */
const TRAILING_PARTICLE_PATTERN = /(?:이었다|였다|입니다|이다|이며|이고|으로|에서|까지|부터|로|은|는|이|가|을|를|의|에|와|과|도|만)$/u;

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
      .replace(/[.,:;!?]+$/u, "")
      // "2025년" names the year the evidence labels "2025"; other units stay checked.
      .replace(/^((?:19|20)\d{2})년(?=$|[가-힣])/u, "$1");
    if (normalized.length === 0 || joined.includes(normalized) || source.includes(compactNumerics(normalized))) return true;
    // Only grammatical endings are dropped; a unit such as 원 or 명 stays checked.
    const value = normalized.replace(TRAILING_PARTICLE_PATTERN, "");
    if (value !== normalized && /\d/u.test(value) && (joined.includes(value) || source.includes(compactNumerics(value)))) return true;
    return unitFromColumnHeader(value, joined, source);
  });
}

/**
 * "9일" is what a cell showing 9 under the header "평균 처리시간(일)" means.
 * The unit is accepted only when a cited cell holds exactly that number and
 * a cited header declares exactly that unit; a different unit still fails.
 */
function unitFromColumnHeader(candidate: string, joined: string, source: string): boolean {
  const match = /^(-?\d[\d.,]*)([가-힣a-z%]{1,3})$/u.exec(candidate);
  if (!match) return false;
  const number = compactNumerics(match[1]).replace(/[.,]$/u, "");
  const unit = match[2];
  const escaped = number.replace(/[.]/gu, "\\.");
  const cellValue = new RegExp(`·\\s*${escaped}(?![\\d.,])`, "u").test(source);
  const declared = joined.includes(`(${unit})`) || new RegExp(`단위\\s*[:：]?\\s*${unit}(?![가-힣])`, "u").test(joined);
  return cellValue && declared;
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
