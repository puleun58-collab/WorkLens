import type { AiAvailableResult, GroundedClaim, ResultWarning } from "@/domain/ai";
import type { NormalizedDocument, SourceRef, TableBlock } from "@/domain/document";
import type { ExtractedField, ExtractValueType, FileExtraction } from "@/domain/extract";
import type { DocumentTopic } from "@/domain/operations";

const RELATION_PATTERN = /(?:면\s+\S|되면|하면|경우|없으면|때문|따라|반면|대비|비교|대신|증가|감소|상승|하락|보조적으로|→|->|로 인해|에 의해|따라서|\b(?:if|when|unless|because|whereas|otherwise|instead|compared|versus|therefore)\b)/iu;
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
  const text = normalizedFactPart(claimDisplayText(claim));
  if (NARRATIVE_SIGNAL_PATTERN.test(text)) return false;
  return fields.some((field) => {
    if (!CONFIRMED_METRIC_TYPES.has(field.type) || !sharesSource(claim.evidence.map((binding) => binding.source), field.sources)) return false;
    const label = normalizedFactPart(field.field);
    const value = normalizedFactPart(field.displayValue);
    if (!label || !value || !text.startsWith(label)) return false;
    const rest = text.slice(label.length).replace(/^(?:은|는|이|가|의)?/u, "");
    return rest === value || (rest.startsWith(value) && /^(?:이다|입니다|임)$/u.test(rest.slice(value.length)));
  });
}

function sharesSource(left: readonly SourceRef[], right: readonly SourceRef[]): boolean {
  return left.some((a) => right.some((b) =>
    a.fileId === b.fileId && a.nodeId === b.nodeId));
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
const NEAR_DUPLICATE = 0.78;

/** Preserve changes in value, polarity, direction, subject and conditional scope. */
function sameMeaningMarkers(left: string, right: string): boolean {
  const numbers = (text: string) => (text.match(/\d+(?:[.,]\d+)*/gu) ?? []).sort().join("\0");
  if (numbers(left) !== numbers(right)) return false;
  const directions = (text: string) => (text.match(/불일치|일치|증가|감소|상승|하락|초과|미달|개선|악화|없음|없는|없으면|아님|아닌|제외|예외|단서|단,/gu) ?? []).sort().join("\0");
  if (directions(left) !== directions(right)) return false;
  const condition = (text: string) =>
    text.match(/(?:^|[,;])\s*([^,;]{2,80}?)(?:하면|경우|없으면|때는|일 때|라면)/u)?.[1]
    ?? text.match(/^\s*(?:if|when|unless)\s+([^,;]{3,100})[,;]/iu)?.[1];
  const leftCondition = condition(left);
  const rightCondition = condition(right);
  if (Boolean(leftCondition) !== Boolean(rightCondition)) return false;
  if (leftCondition && rightCondition) {
    const a = bigrams(leftCondition);
    const b = bigrams(rightCondition);
    if (containment(a, b) < 0.75 || containment(b, a) < 0.75) return false;
  }
  const subject = (text: string) => text.match(/^\s*([^\s,;:]{2,40}?)(?:은|는|이|가)\s/u)?.[1];
  const leftSubject = subject(left);
  const rightSubject = subject(right);
  return !leftSubject || !rightSubject || normalizedFactPart(leftSubject) === normalizedFactPart(rightSubject);
}

function sameSourcedMeaning(
  left: string, leftSources: readonly SourceRef[], right: string, rightSources: readonly SourceRef[],
): boolean {
  if (!sharesSource(leftSources, rightSources) || !sameMeaningMarkers(left, right)) return false;
  const a = bigrams(left);
  const b = bigrams(right);
  const [shorter, longer] = a.size <= b.size ? [a, b] : [b, a];
  return containment(shorter, longer) >= NEAR_DUPLICATE;
}

function withoutNearDuplicates(claims: readonly GroundedClaim[]): GroundedClaim[] {
  const kept: Array<{ claim: GroundedClaim; grams: Set<string>; sources: SourceRef[] }> = [];
  for (const claim of claims) {
    const grams = bigrams(claimDisplayText(claim));
    const sources = claim.evidence.map((binding) => binding.source);
    const twin = kept.find((entry) => sameSourcedMeaning(
      claimDisplayText(claim), sources, claimDisplayText(entry.claim), entry.sources,
    ));
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
    claim.presentation?.role === "summary"
    && !/[?？]$/u.test(claimDisplayText(claim))
    && claimDisplayText(claim).length >= 12)).slice(0, 4);
  const insights = withoutNearDuplicates(confident.filter((claim) =>
    claim.presentation?.role === "insight")).filter((claim) => {
      const text = claimDisplayText(claim);
      if (/[?？]$/u.test(text) || /(?:나요|습니까|인가요)$/u.test(text)
        || !RELATION_PATTERN.test(text)
        || (/증가|감소|상승|하락/u.test(text)
          && !/(?:하면|경우|때문|따라|반면|대비|전년|전월|보다|에서|로 인해|에 의해|→|->)/u.test(text)
          && (text.match(/\d+(?:[.,]\d+)*/gu) ?? []).length < 2)) return false;
      return !summary.some((entry) => sameSourcedMeaning(
        text, claim.evidence.map((binding) => binding.source),
        claimDisplayText(entry), entry.evidence.map((binding) => binding.source),
      ));
    });
  const content = topics.filter((topic) => {
    return ![...summary, ...insights].some((claim) => sameSourcedMeaning(
      topic.text, topic.sources, claimDisplayText(claim), claim.evidence.map((binding) => binding.source),
    ));
  });
  return { summary, content, insights, concerns, warnings: result.warnings };
}

function topicKey(text: string): string {
  return text.normalize("NFKC").trim().toLocaleLowerCase("ko-KR").replace(/\s+/gu, " ");
}


function tableTopics(table: TableBlock): DocumentTopic[] {
  const rows = table.rows;
  const first = rows[0]?.map((cell) => cell.display.replace(/\s+/gu, " ").trim()) ?? [];
  const hasHeader = rows.length > 1 && (
    (/^(?:항목|구분|지역|이름|조건|상태|name|item|category|region|metric|year|condition|status)$/iu.test(first[0] ?? "")
      && (first.length >= 3 || /^(?:값|내용|설명|금액|수량|조치|예외|value|description|amount|quantity|status|action|exception|response)$/iu.test(first[1] ?? "")))
    || (first.length >= 2 && first.every((value) => value.length > 0 && value.length <= 24 && !/\d/u.test(value))
      && rows.slice(1, 4).some((row) =>
        row[0] && /[A-Za-z가-힣]{2}/u.test(row[0].display) && row.slice(1).some((cell) => /\d/u.test(cell.display))))
  );
  const topics: Array<{ item: DocumentTopic; score: number; index: number }> = [];
  for (let index = hasHeader ? 1 : 0; index < rows.length; index += 1) {
    const cells = rows[index].map((cell, column) => ({ cell, column, text: cell.display.replace(/\s+/gu, " ").trim() }))
      .filter(({ text }) => text && text.length <= 140);
    if (cells.length < 2) continue;
    const descriptor = cells.find(({ text }) => /[A-Za-z가-힣]{2}/u.test(text) && !/^\d[\d.,%/-]*$/u.test(text));
    if (!descriptor) continue;
    const facts = cells.filter(({ column }) => column !== descriptor.column)
      .filter(({ text }) => (text.length >= 2 || (text.length === 1 && /\d/u.test(text))) && !/^(?:-|n\/a|해당 없음)$/iu.test(text))
      .slice(0, 3);
    if (!facts.length) continue;
    const parts = facts.map(({ column, text }) => {
      const header = hasHeader ? first[column] : "";
      return header && header !== text && header !== descriptor.text ? `${header}: ${text}` : text;
    });
    const meaningful = parts.some((part) => /[가-힣A-Za-z]{3}/u.test(part))
      || (hasHeader && parts.some((part) => /\d/u.test(part)))
      || (/(?:금액|매출|비용|예산|단가|율|amount|revenue|cost|budget|price|rate)/iu.test(descriptor.text)
        && parts.some((part) => /[$€£₩%]|\d/u.test(part)));
    if (!meaningful) continue;
    const text = `${descriptor.text} — ${parts.join(" · ")}`;
    const score = (RELATION_PATTERN.test(text) ? 2 : 0)
      + (/(?:예외|조건|필수|금지|불가|\b(?:exception|condition|required|prohibited)\b)/iu.test(text) ? 1 : 0);
    if (topics.length === 2 && score <= topics[1].score) continue;
    const sources = [descriptor.cell.source, ...facts.flatMap(({ cell, column }) =>
      hasHeader && rows[0][column] ? [rows[0][column].source, cell.source] : [cell.source])];
    topics.push({
      item: {
        id: `topic:${table.id}:row:${index}`,
        text,
        sources: sources.filter((source, position) => sources.findIndex((other) =>
          other.fileId === source.fileId && other.nodeId === source.nodeId) === position),
      },
      score,
      index,
    });
    topics.sort((left, right) => right.score - left.score || left.index - right.index);
    if (topics.length > 2) topics.pop();
  }
  return topics.sort((left, right) => left.index - right.index).map(({ item }) => item);
}

/** Select statements from the document body; headings only locate their source. */
export function documentAnalysisTopics(document: NormalizedDocument): DocumentTopic[] {
  const candidates: Array<{ item: DocumentTopic; score: number; order: number }> = [];
  const repeatedText = new Map<string, number>();
  for (const block of document.blocks) {
    if (block.type === "paragraph" && block.role !== "heading") {
      const key = topicKey(block.text);
      repeatedText.set(key, (repeatedText.get(key) ?? 0) + 1);
    }
  }
  const byText = new Map<string, number>();
  for (let order = 0; order < document.blocks.length; order += 1) {
    const block = document.blocks[order];
    if (block.type === "table") {
      for (const [index, item] of tableTopics(block).entries()) {
        candidates.push({ item, score: 3 + Math.min(item.text.length, 120) / 120, order: order + index / 100 });
      }
      continue;
    }
    if (block.role === "heading") continue;
    const text = block.text.replace(/\s+/gu, " ").trim();
    const step = text.match(/^(?:단계\s*)?(\d{1,2})[.)]\s+(.{3,100})$/u);
    if (step && Number(step[1]) === 1) {
      const steps = [{ text: step[2], source: block.source }];
      for (let next = order + 1; next < document.blocks.length && steps.length < 5; next += 1) {
        const following = document.blocks[next];
        if (following.type !== "paragraph" || following.role === "heading") break;
        const match = following.text.trim().match(/^(?:단계\s*)?(\d{1,2})[.)]\s+(.{3,100})$/u);
        if (!match || Number(match[1]) !== steps.length + 1 || TRAILING_PAGE_NUMBER.test(match[2])) break;
        steps.push({ text: match[2], source: following.source });
      }
      if (steps.length >= 2 && steps.some((item) =>
        /(?:한다|합니다|된다|됩니다|검토|승인|처리|확인|적용|제출|작성|변경|\b(?:review|approve|submit|verify|process|apply|issue)\b)/iu.test(item.text))) {
        candidates.push({
          item: {
            id: `topic:${block.id}:sequence`,
            text: steps.map((item, index) => `${index + 1}. ${item.text}`).join(" → "),
            sources: steps.map((item) => item.source),
          },
          score: 4, order,
        });
        order += steps.length - 1;
        continue;
      }
    }
    if (text.length < 18 || text.length > 500 || /[?？]$/u.test(text)) continue;
    if (GENERIC_TOPICS.has(topicKey(text)) || OUTLINE_NUMBER_ONLY.test(text)
      || TRAILING_PAGE_NUMBER.test(text) || /(?:placeholder|lorem ipsum)/iu.test(text)
      || ((repeatedText.get(topicKey(text)) ?? 0) > 1 && text.length < 100
        && !/(?:다|니다|한다|된다|입니다|이다)[.!?]?$|[.!]$|\b(?:is|are|must|shall|will|should|requires?|applies?|includes?)\b/iu.test(text))) continue;
    const key = topicKey(text);
    const repeated = byText.get(key);
    if (repeated !== undefined) {
      const sources = candidates[repeated].item.sources;
      if (!sources.some((source) => source.fileId === block.source.fileId && source.nodeId === block.source.nodeId)) sources.push(block.source);
      continue;
    }
    byText.set(key, candidates.length);
    const score = (/(?:목적|정의|의미|범위|원칙|규칙|조건|기준|적용|예외|제외|우선|절차|과정|순서|결정|필요|계산|산정|확인|변경|반영|결론|결과|없으면|경우|때문|따라|\b(?:purpose|definition|scope|rule|process|condition|exception|change|conclusion|result|requirement|must|shall|unless|if)\b)/iu.test(text) ? 3 : 0)
      + (/\d/u.test(text) ? 0.5 : 0)
      + (/(?:다|니다|한다|된다|입니다|이다)[.!?]?$|[.!]$/u.test(text) ? 1 : 0)
      + Math.min(text.length, 160) / 160;
    candidates.push({ item: { id: `topic:${block.id}`, text, sources: [block.source] }, score, order });
  }
  const ranked = candidates.sort((left, right) => right.score - left.score || left.order - right.order);
  const selected: typeof candidates = [];
  const overflow: typeof candidates = [];
  const perSection = new Map<string, number>();
  for (const entry of ranked) {
    const source = entry.item.sources[0];
    const key = `${source.fileId}:${source.sheet ?? (source.page === undefined ? `part:${Math.floor(entry.order / 20)}` : `page:${source.page}`)}`;
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
