import type { AiAvailableResult, GroundedClaim, ResultWarning } from "@/domain/ai";
import type { NormalizedDocument, SourceRef } from "@/domain/document";
import type { ExtractedField, ExtractValueType, FileExtraction } from "@/domain/extract";
import type { DocumentTopic } from "@/domain/operations";

const NARRATIVE_SIGNAL_PATTERN = /(관계|의미|특징|주의|증가|감소|변화|추세|상승|하락|비교|차이|영향|원인|위험|가능성|전망|불일치|초과|미달|대비|전년|전월|때문|따라)/u;
const CONFIRMED_METRIC_TYPES = new Set<ExtractValueType>(["Money", "Percent", "Number"]);
/**
 * A short outline is read in full; only a long one folds, and the fold is a
 * control in the view, never a pretend topic in the data.
 */
export const TOPIC_FOLD_THRESHOLD = 12;
export const TOPIC_FOLDED_COUNT = 8;
const GENERIC_TOPICS = new Set(["목차", "차례", "contents", "agenda", "chapter", "index", "개정이력"]);
/** "CH 01", "Chapter 2", "제3장", "4.1": a position in the outline, not a subject. */
const OUTLINE_NUMBER_ONLY = /^(?:(?:ch(?:apter)?|part|section)\.?\s*\d+|제?\s*\d+\s*[장절부]|\d+(?:\.\d+)*\.?)$/iu;
/** A table-of-contents entry or a running head carries its page number with it. */
const TRAILING_PAGE_NUMBER = /\s\d{1,3}$/u;
const COVER_PAGE = 1;
const COVER_SKIP_THRESHOLD = 3;

export interface AnalysisMetric {
  id: string;
  fileId: string;
  fileName: string;
  label: string;
  value: string;
  sources: SourceRef[];
}


export interface AnalysisClaimPresentation {
  summary: GroundedClaim[];
  concerns: GroundedClaim[];
  warnings: ResultWarning[];
}

interface AnalysisExtractionEntry {
  file: { id: string; name: string };
  extraction: FileExtraction;
  topics: readonly DocumentTopic[];
}

export function claimDisplayText(claim: GroundedClaim): string {
  return claim.text.replace(/^추론:\s*/u, "").trim();
}

function uniqueClaims(claims: readonly GroundedClaim[]): GroundedClaim[] {
  const unique: GroundedClaim[] = [];
  const indexByKey = new Map<string, number>();
  for (const claim of claims) {
    const text = claimDisplayText(claim).normalize("NFKC").toLocaleLowerCase();
    const key = `${claim.kind}\0${text}`;
    if (!text) continue;
    const previousIndex = indexByKey.get(key);
    if (previousIndex === undefined) {
      indexByKey.set(key, unique.length);
      unique.push(claim);
      continue;
    }
    const previous = unique[previousIndex];
    const evidence = [...previous.evidence];
    const seenSources = new Set(evidence.map((binding) => `${binding.source.fileId}\0${binding.source.nodeId}\0${binding.support}`));
    for (const binding of claim.evidence) {
      const sourceKey = `${binding.source.fileId}\0${binding.source.nodeId}\0${binding.support}`;
      if (seenSources.has(sourceKey)) continue;
      seenSources.add(sourceKey);
      evidence.push(binding);
    }
    unique[previousIndex] = { ...previous, evidence: evidence as GroundedClaim["evidence"] };
  }
  return unique;
}

function normalizedFactPart(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[\s,.:：·()[\]{}'"“”‘’_-]+/gu, "");
}

function repeatsConfirmedMetric(claim: GroundedClaim, fields: readonly ExtractedField[]): boolean {
  const text = claimDisplayText(claim);
  if (NARRATIVE_SIGNAL_PATTERN.test(text)) return false;
  const normalizedText = normalizedFactPart(text);
  return fields.some((field) => {
    if (!CONFIRMED_METRIC_TYPES.has(field.type)) return false;
    const label = normalizedFactPart(field.field);
    const value = normalizedFactPart(field.displayValue);
    return label.length > 0 && value.length > 0 && normalizedText.includes(label) && normalizedText.includes(value);
  });
}

/** Korean-aware character bigrams: particles and spacing differ, the wording does not. */
function bigrams(text: string): Set<string> {
  const compact = normalizedFactPart(text);
  const grams = new Set<string>();
  for (let index = 0; index + 2 <= compact.length; index += 1) grams.add(compact.slice(index, index + 2));
  return grams;
}

/** Share of `inner`'s bigrams that also appear in `outer`. */
function containment(inner: Set<string>, outer: Set<string>): number {
  if (inner.size === 0) return 0;
  let shared = 0;
  for (const gram of inner) if (outer.has(gram)) shared += 1;
  return shared / inner.size;
}

/**
 * An insight explains how parts of the document relate. A claim whose wording
 * is essentially one of the document's own section titles restates the outline
 * the reader already sees under 문서 주요 내용.
 */
const RESTATES_HEADING = 0.8;
/**
 * Two claims citing the same evidence, one worded almost entirely inside the
 * other, say the same thing; the fuller one explains more and is kept.
 */
const NEAR_DUPLICATE = 0.7;

function withoutNearDuplicates(claims: readonly GroundedClaim[]): GroundedClaim[] {
  const kept: Array<{ claim: GroundedClaim; grams: Set<string>; nodes: Set<string> }> = [];
  for (const claim of claims) {
    const grams = bigrams(claimDisplayText(claim));
    const nodes = new Set(claim.evidence.map((binding) => `${binding.source.fileId}\0${binding.source.nodeId}`));
    const twin = kept.find((entry) => {
      if (![...nodes].some((node) => entry.nodes.has(node))) return false;
      const [shorter, longer] = grams.size <= entry.grams.size ? [grams, entry.grams] : [entry.grams, grams];
      return containment(shorter, longer) >= NEAR_DUPLICATE;
    });
    if (!twin) {
      kept.push({ claim, grams, nodes });
      continue;
    }
    if (grams.size > twin.grams.size) {
      twin.claim = claim;
      twin.grams = grams;
    }
    for (const node of nodes) twin.nodes.add(node);
  }
  return kept.map((entry) => entry.claim);
}

export function analysisClaimPresentation(
  result: AiAvailableResult | null,
  confirmedFields: readonly ExtractedField[] = [],
  topics: readonly DocumentTopic[] = [],
): AnalysisClaimPresentation {
  if (!result || result.operation !== "analyze") {
    return { summary: [], concerns: [], warnings: [] };
  }

  const headingGrams = topics.map((topic) => bigrams(topic.text));
  const restatesHeading = (claim: GroundedClaim) => {
    const grams = bigrams(claimDisplayText(claim));
    return headingGrams.some((heading) => heading.size > 0 && containment(grams, heading) >= RESTATES_HEADING);
  };
  const claims = withoutNearDuplicates(uniqueClaims(result.claims)).filter((claim) => !restatesHeading(claim));
  const concerns = claims.filter((claim) => claim.kind === "inference" && (claim.confidence ?? "low") === "low");
  const concernIds = new Set(concerns.map((claim) => claim.id));
  const summary = claims.filter((claim) =>
    !concernIds.has(claim.id) && !repeatsConfirmedMetric(claim, confirmedFields));
  return { summary, concerns, warnings: result.warnings };
}

function topicKey(text: string): string {
  return text.normalize("NFKC").trim().toLocaleLowerCase("ko-KR").replace(/\s+/gu, " ");
}

const compactKey = (text: string): string => topicKey(text).replace(/\s+/gu, "");

const pageOf = (source: { page?: number }): number | undefined => source.page;

/**
 * The document's own section headings, minus the parts of a document that
 * describe the file rather than its content: a cover, a table of contents,
 * running heads and a colophon repeat the title instead of adding a subject.
 * Slides have no cover page — every slide titles itself — so that rule
 * applies only to paginated documents.
 */
export function documentAnalysisTopics(document: NormalizedDocument): DocumentTopic[] {
  const headings = document.blocks.flatMap((block) =>
    block.type === "paragraph" && block.role === "heading" && block.text.trim() ? [block] : []);
  const paginated = document.kind === "pdf" || document.kind === "docx";
  const titleKey = paginated ? compactKey(headings[0]?.text ?? "") : "";
  const beyondCover = headings.filter((block) => pageOf(block.source) !== COVER_PAGE).length;
  const skipCover = paginated && beyondCover >= COVER_SKIP_THRESHOLD;

  const topics: DocumentTopic[] = [];
  const indexByKey = new Map<string, number>();
  for (const block of headings) {
    const text = block.text.replace(/\s+/gu, " ").trim();
    const key = topicKey(text);
    const compact = compactKey(text);
    if (!key || GENERIC_TOPICS.has(key) || GENERIC_TOPICS.has(compact)) continue;
    if (TRAILING_PAGE_NUMBER.test(text) || OUTLINE_NUMBER_ONLY.test(text)) continue;
    if (skipCover && pageOf(block.source) === COVER_PAGE) continue;
    // The colophon and the cover restate the title; the title identifies the
    // document, it is not one of its subjects.
    if (titleKey && compact !== titleKey && (compact.includes(titleKey) || titleKey.includes(compact))) continue;
    if (titleKey && compact === titleKey && skipCover) continue;
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, topics.length);
      topics.push({ id: `topic:${block.id}`, text, sources: [block.source] });
      continue;
    }
    const existing = topics[existingIndex];
    if (!existing.sources.some((source) => source.nodeId === block.source.nodeId)) {
      existing.sources.push(block.source);
    }
  }
  return topics;
}

export function confirmedAnalysisItems(
  entries: readonly AnalysisExtractionEntry[],
): DocumentTopic[] {
  const includeFileName = entries.length > 1;
  return entries.flatMap(({ file, topics }) => topics.map((topic) => ({
    ...topic,
    id: `${file.id}:${topic.id}`,
    text: includeFileName ? `${file.name}: ${topic.text}` : topic.text,
  })));
}

export function confirmedAnalysisMetrics(
  entries: readonly AnalysisExtractionEntry[],
): AnalysisMetric[] {
  return entries.flatMap(({ file, extraction }) =>
    extraction.fields.flatMap((field, index) =>
      CONFIRMED_METRIC_TYPES.has(field.type)
        ? [{
          id: `${file.id}:${field.sources[0]?.nodeId ?? index}:${index}`,
          fileId: file.id,
          fileName: file.name,
          label: field.field,
          value: field.displayValue,
          sources: field.sources,
        }]
        : []));
}
