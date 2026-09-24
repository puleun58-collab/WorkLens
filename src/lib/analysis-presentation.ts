import type { AiAvailableResult, GroundedClaim, ResultWarning } from "@/domain/ai";
import type { NormalizedDocument, SourceRef } from "@/domain/document";
import type { ExtractedField, ExtractValueType, FileExtraction } from "@/domain/extract";
import type { DocumentTopic } from "@/domain/operations";

const NARRATIVE_SIGNAL_PATTERN = /(관계|의미|특징|주의|증가|감소|변화|추세|상승|하락|비교|차이|영향|원인|위험|가능성|전망|불일치|초과|미달|대비|전년|전월|때문|따라)/u;
const CONFIRMED_METRIC_TYPES = new Set<ExtractValueType>(["Money", "Percent", "Number"]);
const GENERIC_TOPICS = new Set(["목차", "차례", "contents", "agenda", "chapter", "index", "개정이력"]);
const OUTLINE_NUMBER_ONLY = /^(?:(?:ch(?:apter)?|part|section)\.?\s*\d+|제?\s*\d+\s*[장절부]|\d+(?:\.\d+)*\.?)$/iu;
const TRAILING_PAGE_NUMBER = /\s\d{1,3}$/u;

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
  insights: GroundedClaim[];
  content: DocumentTopic[];
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

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;
function uniqueClaims(claims: readonly GroundedClaim[]): GroundedClaim[] {
  const unique: GroundedClaim[] = [];
  const indexByKey = new Map<string, number>();
  for (const claim of claims) {
    const text = claimDisplayText(claim).normalize("NFKC").toLocaleLowerCase();
    const key = `${claim.kind}\0${claim.kind === "inference" ? claim.presentation?.role : ""}\0${claim.evidence[0]?.source.fileId ?? ""}\0${text}`;
    if (!text) continue;
    const previousIndex = indexByKey.get(key);
    if (previousIndex === undefined) {
      indexByKey.set(key, unique.length);
      unique.push(claim);
      continue;
    }
    const previous = unique[previousIndex];
    const preferred = claim.kind === "inference" && previous.kind === "inference"
      && CONFIDENCE_RANK[claim.confidence ?? "low"] > CONFIDENCE_RANK[previous.confidence ?? "low"]
      ? claim : previous;
    const evidence = [...preferred.evidence];
    const seenSources = new Set(evidence.map((binding) => `${binding.source.fileId}\0${binding.source.nodeId}\0${binding.support}`));
    for (const binding of (preferred === claim ? previous : claim).evidence) {
      const sourceKey = `${binding.source.fileId}\0${binding.source.nodeId}\0${binding.support}`;
      if (seenSources.has(sourceKey)) continue;
      seenSources.add(sourceKey);
      evidence.push(binding);
    }
    unique[previousIndex] = { ...preferred, evidence: evidence as GroundedClaim["evidence"] } as GroundedClaim;
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
    if (!CONFIRMED_METRIC_TYPES.has(field.type) || !sharesSource(claim.evidence.map((binding) => binding.source), field.sources)) return false;
    const label = normalizedFactPart(field.field);
    const value = normalizedFactPart(field.displayValue);
    return label.length > 0 && value.length > 0 && normalizedText.includes(label) && normalizedText.includes(value);
  });
}

function sharesSource(left: readonly SourceRef[], right: readonly SourceRef[]): boolean {
  return left.some((a) => right.some((b) =>
    a.fileId === b.fileId && (
      a.nodeId === b.nodeId
      || (a.page !== undefined && a.page === b.page)
      || (a.sheet !== undefined && a.sheet === b.sheet && a.cellRange !== undefined && a.cellRange === b.cellRange)
    )));
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
 * Two claims citing the same evidence, one worded almost entirely inside the
 * other, say the same thing; the fuller one explains more and is kept.
 */
const NEAR_DUPLICATE = 0.7;

/** A similar sentence with a different value or direction is not a duplicate. */
function sameMeaningMarkers(left: string, right: string): boolean {
  const leftNumbers = (left.match(/\d+(?:[.,]\d+)*/gu) ?? []).sort().join("\0");
  const rightNumbers = (right.match(/\d+(?:[.,]\d+)*/gu) ?? []).sort().join("\0");
  const leftDirections = (left.match(/불일치|일치|증가|감소|상승|하락|초과|미달|개선|악화/gu) ?? []).sort().join("\0");
  const rightDirections = (right.match(/불일치|일치|증가|감소|상승|하락|초과|미달|개선|악화/gu) ?? []).sort().join("\0");
  return (!leftNumbers || !rightNumbers || leftNumbers === rightNumbers) && leftDirections === rightDirections;
}

function withoutNearDuplicates(claims: readonly GroundedClaim[]): GroundedClaim[] {
  const kept: Array<{ claim: GroundedClaim; grams: Set<string>; sources: SourceRef[] }> = [];
  for (const claim of claims) {
    const grams = bigrams(claimDisplayText(claim));
    const sources = claim.evidence.map((binding) => binding.source);
    const twin = kept.find((entry) => {
      if (!sharesSource(sources, entry.sources)) return false;
      const [shorter, longer] = grams.size <= entry.grams.size ? [grams, entry.grams] : [entry.grams, grams];
      return sameMeaningMarkers(claimDisplayText(claim), claimDisplayText(entry.claim))
        && containment(shorter, longer) >= NEAR_DUPLICATE;
    });
    if (!twin) {
      kept.push({ claim, grams, sources });
      continue;
    }
    const preferred = grams.size > twin.grams.size ? claim : twin.claim;
    const other = preferred === claim ? twin.claim : claim;
    const evidence = [...preferred.evidence];
    const seen = new Set(evidence.map((binding) => `${binding.source.fileId}\0${binding.source.nodeId}\0${binding.support}`));
    for (const binding of other.evidence) {
      const key = `${binding.source.fileId}\0${binding.source.nodeId}\0${binding.support}`;
      if (!seen.has(key)) { seen.add(key); evidence.push(binding); }
    }
    twin.claim = { ...preferred, evidence: evidence as GroundedClaim["evidence"] } as GroundedClaim;
    twin.grams = bigrams(claimDisplayText(preferred));
    twin.sources = evidence.map((binding) => binding.source);
  }
  return kept.map((entry) => entry.claim);
}

export function analysisClaimPresentation(
  result: AiAvailableResult | null,
  confirmedFields: readonly ExtractedField[] = [],
  topics: readonly DocumentTopic[] = [],
): AnalysisClaimPresentation {
  if (!result || result.operation !== "analyze") {
    return { summary: [], content: [...topics], insights: [], concerns: [], warnings: [] };
  }

  const claims = uniqueClaims(result.claims).filter((claim): claim is Extract<GroundedClaim, { kind: "inference" }> =>
    claim.kind === "inference" && Boolean(claim.presentation)
    && !repeatsConfirmedMetric(claim, confirmedFields));
  const concerns = claims.filter((claim) => (claim.confidence ?? "low") === "low");
  const confident = claims.filter((claim) => (claim.confidence ?? "low") !== "low");
  const summary = withoutNearDuplicates(confident.filter((claim) =>
    claim.presentation?.role === "summary")).slice(0, 4);
  const insights = withoutNearDuplicates(confident.filter((claim) =>
    claim.presentation?.role === "insight")).filter((claim) => {
      const text = claimDisplayText(claim);
      if (/[?？]$/u.test(text) || /(?:나요|습니까|인가요)$/u.test(text)
        || !/(?:하면|경우|없으면|때문|따라|반면|대비|비교|우선|대신|변화|증가|감소|상승|하락|재계산|전환|다시|보조적으로|→|->)/u.test(text)) return false;
      const grams = bigrams(text);
      return !summary.some((entry) => {
        if (!sharesSource(claim.evidence.map((binding) => binding.source), entry.evidence.map((binding) => binding.source))) return false;
        const entryGrams = bigrams(claimDisplayText(entry));
        const [shorter, longer] = grams.size <= entryGrams.size ? [grams, entryGrams] : [entryGrams, grams];
        return sameMeaningMarkers(claimDisplayText(claim), claimDisplayText(entry))
          && containment(shorter, longer) >= NEAR_DUPLICATE;
      });
    });
  const content = topics.filter((topic) => {
    const grams = bigrams(topic.text);
    return ![...summary, ...insights].some((claim) => {
      if (!sharesSource(topic.sources, claim.evidence.map((binding) => binding.source))) return false;
      const claimGrams = bigrams(claimDisplayText(claim));
      const [shorter, longer] = grams.size <= claimGrams.size ? [grams, claimGrams] : [claimGrams, grams];
      return sameMeaningMarkers(topic.text, claimDisplayText(claim))
        && containment(shorter, longer) >= NEAR_DUPLICATE;
    });
  });
  return { summary, content, insights, concerns, warnings: result.warnings };
}

function topicKey(text: string): string {
  return text.normalize("NFKC").trim().toLocaleLowerCase("ko-KR").replace(/\s+/gu, " ");
}


/** Select statements from the document body; headings only locate their source. */
export function documentAnalysisTopics(document: NormalizedDocument): DocumentTopic[] {
  const candidates: Array<{ item: DocumentTopic; score: number; order: number }> = [];
  const byText = new Map<string, number>();
  for (const [order, block] of document.blocks.entries()) {
    if (block.type !== "paragraph" || block.role === "heading") continue;
    const text = block.text.replace(/\s+/gu, " ").trim();
    if (text.length < 18 || text.length > 500 || /[?？]$/u.test(text)) continue;
    if (GENERIC_TOPICS.has(topicKey(text)) || OUTLINE_NUMBER_ONLY.test(text)
      || TRAILING_PAGE_NUMBER.test(text) || /(?:placeholder|lorem ipsum)/iu.test(text)) continue;
    const key = topicKey(text);
    const repeated = byText.get(key);
    if (repeated !== undefined) {
      const sources = candidates[repeated].item.sources;
      if (!sources.some((source) => source.nodeId === block.source.nodeId)) sources.push(block.source);
      continue;
    }
    byText.set(key, candidates.length);
    const score = (/(?:조건|기준|정의|적용|예외|우선|절차|결정|상태|필요|계산|산정|확인|변경|반영|없으면|경우|때문|따라)/u.test(text) ? 2 : 0)
      + (/\d/u.test(text) ? 1 : 0)
      + (/(?:다|니다|한다|된다|입니다|이다)[.!?]?$/u.test(text) ? 1 : 0)
      + Math.min(text.length, 160) / 160;
    candidates.push({ item: { id: `topic:${block.id}`, text, sources: [block.source] }, score, order });
  }
  const ranked = candidates.sort((left, right) => right.score - left.score || left.order - right.order);
  const selected: typeof candidates = [];
  const overflow: typeof candidates = [];
  const perSection = new Map<string, number>();
  for (const entry of ranked) {
    const source = entry.item.sources[0];
    const key = source.sheet ?? (source.page === undefined ? `part:${Math.floor(entry.order / 20)}` : `page:${source.page}`);
    const count = perSection.get(key) ?? 0;
    if (count >= 2) { overflow.push(entry); continue; }
    perSection.set(key, count + 1);
    selected.push(entry);
    if (selected.length === 7) break;
  }
  for (const entry of overflow) {
    if (selected.length === 7) break;
    selected.push(entry);
  }
  return selected.sort((left, right) => left.order - right.order).map(({ item }) => item);
}

export function confirmedAnalysisItems(
  entries: readonly AnalysisExtractionEntry[],
): DocumentTopic[] {
  const includeFileName = entries.length > 1;
  const items: DocumentTopic[] = [];
  for (let rank = 0; items.length < 7; rank += 1) {
    let added = false;
    for (const { file, topics } of entries) {
      const topic = topics[rank];
      if (!topic) continue;
      items.push({
        ...topic,
        id: `${file.id}:${topic.id}`,
        text: includeFileName ? `${file.name}: ${topic.text}` : topic.text,
      });
      added = true;
      if (items.length === 7) break;
    }
    if (!added) break;
  }
  return items;
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
