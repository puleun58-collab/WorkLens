import type { AiAvailableResult, GroundedClaim, ResultWarning } from "@/domain/ai";
import type { NormalizedDocument, SourceRef, TableBlock } from "@/domain/document";
import type { ExtractedField, ExtractValueType, FileExtraction } from "@/domain/extract";
import type { DocumentTopic } from "@/domain/operations";

const RELATION_PATTERN = /(?:면\s+\S|되면|하면|경우|없으면|때문|따라|반면|대비|비교|대신|므로|증가|감소|상승|하락|초과|미달|상회|하회|다르|다릅|달라|다른|차이|상충|불일치|보조적으로|→|->|로 인해|에 의해|따라서|\b(?:if|when|once|after|before|unless|because|whereas|otherwise|instead|compared|versus|therefore|exceed(?:s|ed)?|below|above|differ(?:s|ent)?|conflict(?:s|ing)?)\b)/iu;
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

/** A shared node is required for claims; neighbouring prose in one document is not evidence of identity. */
function meaningfulTokens(text: string): string[] {
  return (text.normalize("NFKC").toLocaleLowerCase("ko-KR").match(/[가-힣]+|[a-z]+|\d+(?:[.,]\d+)*/gu) ?? [])
    .map((word) => {
      if (/^[가-힣]+$/u.test(word)) {
        return word.replace(/(?:입니다|이었다|합니다|됩니다|한다|된다|했다|하여|하며|하는|되는|되어|하고|하면|되면|된|한|를|을|은|는|이|가|에|의|로|과|와|도|만)$/u, "");
      }
      return word.replace(/(?:al|ing|ed|es|s)$/u, "");
    })
    // Korean light verbs ("검토를 진행한다" = "검토한다") carry no argument of their own.
    .filter((word) => word.length >= 2 && !/^(?:the|and|for|are|was|were|has|have|that|this|then|once|after|when|with|from|into|before|will|shall|may|must|is|of|to|a|an|by|at|in|on|as|진행|실시|수행)$/u.test(word));
}

/** "After X" in its common forms: 이후, 뒤, 후, 완료되면, 끝나면, 마치면, 종료 후. */
const PREREQUISITE_TIME = /(?:\b(?:after|once)\b|이후|뒤|완료(?:되면|된)?|끝나(?:면|고)|끝난|마치(?:면|고)|마친|종료(?:되면|된)?|(?:^|\s)후(?=\s|$))/iu;

/** Word order and grammatical voice can vary; every substantive argument still has to match. */
function comparableArguments(left: string, right: string): boolean {
  const temporal = PREREQUISITE_TIME.test(left) && PREREQUISITE_TIME.test(right);
  const words = (text: string) => new Set(meaningfulTokens(temporal
    ? text.replace(/(?:\bcomplete\b|이후에?|뒤에?|완료(?:되면|된|하고|한)?|끝나(?:면|고)|끝난|마치(?:면|고)|마친|종료(?:되면|된)?)/giu, "")
    : text));
  const a = words(left);
  const b = words(right);
  if (a.size < 2 || b.size < 2) return false;
  return a.size === b.size && [...a].every((word) => b.has(word));
}

/** Korean-aware character bigrams retain the existing close-wording path. */
function bigrams(text: string): Set<string> {
  const compact = normalizedFactPart(text);
  const grams = new Set<string>();
  for (let index = 0; index + 2 <= compact.length; index += 1) grams.add(compact.slice(index, index + 2));
  return grams;
}

function containment(inner: Set<string>, outer: Set<string>): number {
  if (inner.size === 0) return 0;
  let shared = 0;
  for (const gram of inner) if (outer.has(gram)) shared += 1;
  return shared / inner.size;
}

const NEAR_DUPLICATE = 0.78;
const STATUS = /(?:\b(?:pending|approved|rejected|draft|final|closed|open|complete|incomplete)\b|(?:대기|보류|승인|반려|거절|초안|최종|확정|완료|미완료))/giu;
const SCOPE = /(?:\b(?:only|except|unless|without|within|until|deadline|rounded?|rounding|ceil|floor|never|not|no|cannot|can't|don't|doesn't|isn't|aren't|won't)\b|(?:이외|제외|예외|없이|없|아니|않|안\s|못\s|금지|불가|기한|마감|반올림|올림|버림|이내|이상|이하|초과|미만|까지))/giu;
const DIRECTION = /(?:\b(?:increase|decrease|rise|fall|improve|worsen|above|below|before|after)\b|(?:증가|감소|상승|하락|개선|악화|초과|미달|이전|이후|뒤에?|(?:^|\s)전(?:\s|$)|(?:^|\s)후(?:\s|$)))/giu;

/** Exact differences in state, scope, value or direction cannot be flattened by lexical similarity. */
function sameMeaningMarkers(left: string, right: string): boolean {
  const markers = (text: string, pattern: RegExp) => (text.match(pattern) ?? [])
    .map((value) => value.normalize("NFKC").toLocaleLowerCase("ko-KR").trim()).sort().join("\0");
  const temporal = PREREQUISITE_TIME.test(left) && PREREQUISITE_TIME.test(right);
  const rightWords = new Set(meaningfulTokens(right));
  const common = new Set(meaningfulTokens(left).filter((word) => rightWords.has(word)));
  const states = (text: string) => (temporal ? (text.match(STATUS) ?? []).filter((state) =>
    !/^(?:완료|complete)$/iu.test(state) && !common.has(meaningfulTokens(state)[0])) : text.match(STATUS) ?? []).sort().join("\0");
  const numbers = (text: string) => (text.match(/\d+(?:[.,]\d+)*/gu) ?? []).join("\0");
  if (numbers(left) !== numbers(right)
    || states(left) !== states(right)
    || markers(left, SCOPE) !== markers(right, SCOPE)) return false;
  const direction = (text: string) => markers(text, DIRECTION).replace(/(?:이후|뒤|후|after)/giu, "later").replace(/(?:이전|전|before)/giu, "earlier");
  const leftDirection = direction(left);
  const rightDirection = direction(right);
  if (temporal ? leftDirection.replace(/later/gu, "") !== rightDirection.replace(/later/gu, "")
    : leftDirection !== rightDirection) return false;
  const condition = (text: string) =>
    text.match(/(?:^|[,;])\s*([^,;]{2,80}?)(?:하면|경우|없으면|때는|일 때|라면)/u)?.[1]
    ?? text.match(/^\s*(?:if|when|unless)\s+([^,;]{3,100})[,;]/iu)?.[1];
  const leftCondition = condition(left);
  const rightCondition = condition(right);
  if (Boolean(leftCondition) !== Boolean(rightCondition) && !temporal) return false;
  if (leftCondition && rightCondition && !comparableArguments(leftCondition, rightCondition)) {
    const a = bigrams(leftCondition);
    const b = bigrams(rightCondition);
    if (containment(a, b) < 0.75 || containment(b, a) < 0.75) return false;
  }
  // Subject particles (이/가) mark who acts; a topic (은/는) is often the object
  // of a passive restatement ("시스템 등록은 승인 후 진행"), so it is not compared.
  const koreanAgents = (text: string) => [...text.matchAll(/(?:^|[\s,;])([가-힣]{2,30}?)(?:이|가)\s/gu)]
    .map((match) => match[1]);
  const leftAgents = koreanAgents(left);
  const rightAgents = koreanAgents(right);
  if (leftAgents.length && rightAgents.length && !leftAgents.some((agent) => rightAgents.includes(agent))) return false;
  const englishAgent = (text: string) => {
    const clause = text.replace(/^\s*(?:after|once|if|when)\b[^,]*,\s*/iu, "");
    return clause.match(/\bby\s+(?:the\s+)?([a-z][\w-]*)/iu)?.[1]
      ?? clause.match(/^\s*(?:the\s+|an?\s+)?([a-z][\w-]*)\s+(?!is\b|are\b|was\b|were\b)[a-z]+/iu)?.[1];
  };
  const leftActor = englishAgent(left);
  const rightActor = englishAgent(right);
  return !leftActor || !rightActor || leftActor.toLowerCase() === rightActor.toLowerCase();
}

function sameSourcedMeaning(
  left: string, leftSources: readonly SourceRef[], right: string, rightSources: readonly SourceRef[],
): boolean {
  if (!sharesSource(leftSources, rightSources) || !sameMeaningMarkers(left, right)) return false;
  if (comparableArguments(left, right)) return true;
  const leftWords = new Set(meaningfulTokens(left));
  const rightWords = new Set(meaningfulTokens(right));
  if ([...leftWords].some((word) => !rightWords.has(word))
    || [...rightWords].some((word) => !leftWords.has(word))) return false;
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
    return ![...summary, ...insights, ...concerns].some((claim) => sameSourcedMeaning(
      topic.text, topic.sources, claimDisplayText(claim), claim.evidence.map((binding) => binding.source),
    ));
  });
  return { summary, content, insights, concerns, warnings: result.warnings };
}

function topicKey(text: string): string {
  return text.normalize("NFKC").trim().toLocaleLowerCase("ko-KR").replace(/\s+/gu, " ");
}


const cellText = (cell: TableBlock["rows"][number][number] | undefined) => cell?.display.replace(/\s+/gu, " ").trim() ?? "";

const isLabel = (value: string) => value.length <= 24 && !/^[\d\s.,%/-]+$/u.test(value) && !/\d{2,}/u.test(value);

/**
 * A sheet often holds a title row, blank spacer rows and several tables.
 * Blank rows separate tables; within one, rows with a single filled cell
 * are titles, and the first row with two or more filled cells is the
 * candidate header. A sparser label row directly above a fuller one is a
 * grouped (merged) header: 상반기 over 매출 · 비용 · 이익.
 */
function tableSegments(rows: TableBlock["rows"]): Array<{ headers: number[]; start: number; end: number }> {
  const filled = (index: number) => rows[index].filter((cell) => cellText(cell) !== "").length;
  const labelRow = (index: number) => {
    const values = rows[index].map(cellText).filter((value) => value !== "");
    return values.length >= 2 && values.every(isLabel);
  };
  const hasDigits = (from: number, to: number) => rows.slice(from, to).some((row) => row.some((cell) => /\d/u.test(cellText(cell))));
  const segments: Array<{ headers: number[]; start: number; end: number }> = [];
  let index = 0;
  while (index < rows.length) {
    while (index < rows.length && filled(index) === 0) index += 1;
    if (index >= rows.length) break;
    let end = index;
    while (end < rows.length && filled(end) > 0) end += 1;
    let top = index;
    while (top < end && filled(top) === 1) top += 1;
    if (top < end) {
      const first = rows[top].map(cellText);
      const labels = first.filter((value) => value !== "");
      const isHeader = end - top > 1 && (
        (/^(?:항목|구분|지역|이름|조건|상태|name|item|category|region|metric|year|condition|status)$/iu.test(first[0] ?? "")
          && (labels.length >= 3 || /^(?:값|내용|설명|금액|수량|조치|예외|value|description|amount|quantity|status|action|exception|response)$/iu.test(first[1] ?? "")))
        || (labelRow(top) && hasDigits(top + 1, Math.min(end, top + 4)))
      );
      const grouped = isHeader && top + 2 < end && labelRow(top + 1)
        && filled(top) < filled(top + 1) && hasDigits(top + 2, Math.min(end, top + 5));
      const headers = isHeader ? (grouped ? [top, top + 1] : [top]) : [];
      segments.push({ headers, start: top + headers.length, end });
    }
    index = end;
  }
  return segments;
}

/** Per-column header label and the header cells it came from. */
function columnHeaders(rows: TableBlock["rows"], headers: readonly number[]) {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const columns: Array<{ label: string; cells: TableBlock["rows"][number] }> = [];
  const [groupRow, leafRow] = headers.length === 2 ? headers : [undefined, headers[0]];
  let group: TableBlock["rows"][number][number] | undefined;
  for (let column = 0; column < width; column += 1) {
    const leaf = leafRow === undefined ? undefined : rows[leafRow][column];
    if (groupRow !== undefined) {
      const candidate = rows[groupRow][column];
      if (cellText(candidate)) group = candidate;
    }
    const leafText = cellText(leaf);
    const groupText = cellText(group);
    const label = leafText && groupText && groupText !== leafText ? `${groupText} ${leafText}` : leafText || groupText;
    columns.push({ label, cells: [group, leaf].filter((cell): cell is NonNullable<typeof cell> => Boolean(cell && cellText(cell))) });
  }
  return columns;
}

function tableTopics(table: TableBlock): DocumentTopic[] {
  const rows = table.rows;
  const topics: Array<{ item: DocumentTopic; score: number; index: number }> = [];
  for (const segment of tableSegments(rows)) {
    const header = columnHeaders(rows, segment.headers);
    const headerRow = segment.headers.length ? header : undefined;
    const first = header.map((column) => column.label);
    const segmentTopics: typeof topics = [];
    for (let index = segment.start; index < segment.end; index += 1) {
      const cells = rows[index].map((cell, column) => ({ cell, column, text: cellText(cell) }))
        .filter(({ text }) => text && text.length <= 140);
      if (cells.length < 2) continue;
      const descriptor = cells.find(({ text }) => /[A-Za-z가-힣]/u.test(text) && !/^\d[\d.,%/-]*$/u.test(text));
      if (!descriptor) continue;
      const facts = cells.filter(({ column }) => column !== descriptor.column)
        .filter(({ text }) => (text.length >= 2 || (text.length === 1 && /\d/u.test(text))) && !/^(?:-|n\/a|해당 없음)$/iu.test(text))
        .slice(0, 3);
      if (!facts.length) continue;
      const parts = facts.map(({ column, text }) => {
        const header = first[column] ?? "";
        return header && header !== text && header !== descriptor.text ? `${header}: ${text}` : text;
      });
      // A row whose value is a statement (항목 | 내용 tables) is content in its
      // own right; only rows of data are sampled down to two representatives.
      const statement = facts.some(({ text: value }) => value.length >= 12 && /\s/u.test(value) && /[가-힣A-Za-z]{2}/u.test(value));
      const meaningful = statement || parts.some((part) => /[가-힣A-Za-z]{3}/u.test(part))
        || (headerRow !== undefined && parts.some((part) => /\d/u.test(part)))
        || (/(?:금액|매출|비용|예산|단가|율|amount|revenue|cost|budget|price|rate)/iu.test(descriptor.text)
          && parts.some((part) => /[$€£₩%]|\d/u.test(part)));
      if (!meaningful) continue;
      const text = `${descriptor.text} — ${parts.join(" · ")}`;
      const score = (RELATION_PATTERN.test(text) ? 2 : 0)
        + (/(?:예외|조건|필수|금지|불가|\b(?:exception|condition|required|prohibited)\b)/iu.test(text) ? 1 : 0);

      if (statement) {
        const sources = [descriptor.cell.source, ...facts.flatMap(({ cell, column }) =>
          [...(headerRow?.[column]?.cells ?? []).map((headerCell) => headerCell.source), cell.source])];
        topics.push({
          item: {
            id: `topic:${table.id}:row:${index}`,
            text,
            sources: sources.filter((source, position) => sources.findIndex((other) =>
              other.fileId === source.fileId && other.nodeId === source.nodeId) === position),
          },
          score: score + 1,
          index,
        });
        continue;
      }
      if (segmentTopics.length === 2 && score <= segmentTopics[1].score) continue;
      const sources = [descriptor.cell.source, ...facts.flatMap(({ cell, column }) =>
        [...(headerRow?.[column]?.cells ?? []).map((headerCell) => headerCell.source), cell.source])];
      segmentTopics.push({
        item: {
          id: `topic:${table.id}:row:${index}`,
          text,
          sources: sources.filter((source, position) => sources.findIndex((other) =>
            other.fileId === source.fileId && other.nodeId === source.nodeId) === position),
        },
        score,
        index,
      });
      segmentTopics.sort((left, right) => right.score - left.score || left.index - right.index);
      if (segmentTopics.length > 2) segmentTopics.pop();
    }
    topics.push(...segmentTopics);
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
    // Short complete sentences ("B팀 처리기간은 15일입니다.") are facts; short
    // fragments without a predicate are labels.
    const sentence = /(?:다|니다|요)[.!?]?$|[.!?]$/u.test(text);
    // "접수 → 검토 → 승인" is a process however short it is.
    const chain = (text.match(/→|->/gu) ?? []).length >= 2;
    if ((text.length < 18 && !chain && !(sentence && text.length >= 8)) || text.length > 500 || /[?？]$/u.test(text)) continue;
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
    const score = (/(?:목적|정의|의미|범위|원칙|규칙|조건|기준|적용|예외|제외|우선|절차|과정|순서|결정|필요|계산|산정|확인|변경|반영|결론|결과|없으면|경우|때문|따라|(?:^|[\s(])(?:단|다만)\s*[,，]|\b(?:purpose|definition|scope|rule|process|condition|exception|change|conclusion|result|requirement|must|shall|unless|if|however|except)\b)/iu.test(text) ? 3 : 0)
      // An illustration explains a rule; it is not one.
      - (/^(?:예시|예를\s*들어|예\s*[:)])|\b(?:for example|e\.g\.|sample)\b/iu.test(text) ? 2 : 0)
      + (/\d/u.test(text) ? 0.5 : 0)
      + (/(?:다|니다|한다|된다|입니다|이다)[.!?]?$|[.!]$/u.test(text) ? 1 : 0)
      + Math.min(text.length, 160) / 160
      + (chain ? 3 : 0);
    candidates.push({ item: { id: `topic:${block.id}`, text, sources: [block.source] }, score, order });
  }
  // A later resolution of the same subject is part of the document's meaning,
  // even when its section contains fewer keyword-heavy sentences.
  for (let index = 0; index < candidates.length; index += 1) {
    const first = candidates[index];
    const states = (text: string): string[] => (text.match(STATUS) ?? []).map((state) => state.toLocaleLowerCase("ko-KR"));
    const firstStates = states(first.item.text);
    if (!firstStates.length) continue;
    for (let next = index + 1; next < candidates.length; next += 1) {
      const later = candidates[next];
      const laterStates = states(later.item.text);
      if (!laterStates.length || laterStates.every((state) => firstStates.includes(state))) continue;
      const earlierSubject = new Set(meaningfulTokens(first.item.text.replace(STATUS, "")));
      if (![...new Set(meaningfulTokens(later.item.text.replace(STATUS, "")))].some((word) => earlierSubject.has(word))) continue;
      first.score = Math.max(first.score, 6);
      later.score = Math.max(later.score, 6);
    }
  }
  // Drop equivalent wording before the seven-topic limit, retaining every source
  // and making room for a genuinely different fact farther down the document.
  const sourcePosition = new Map<string, number>();
  document.blocks.forEach((block, position) => {
    sourcePosition.set(`${block.source.fileId}\0${block.source.nodeId}`, position);
    if (block.type === "table") {
      block.rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => sourcePosition.set(
        `${cell.source.fileId}\0${cell.source.nodeId}`, position + (rowIndex * row.length + columnIndex + 1) / 1_000_000,
      )));
    }
  });
  const distinct: typeof candidates = [];
  for (const entry of candidates.sort((left, right) => right.score - left.score || left.order - right.order)) {
    const source = entry.item.sources[0];
    const nearby = distinct.find((prior) => {
      const other = prior.item.sources[0];
      const sameSection = source.fileId === other.fileId
        && (source.nodeId === other.nodeId
          || (source.page !== undefined && source.page === other.page)
          || (source.sheet !== undefined && source.sheet === other.sheet)
          || (source.locator?.kind === "pptx" && other.locator?.kind === "pptx"
            && source.locator.slide === other.locator.slide));
      return sameSection && sameMeaningMarkers(entry.item.text, prior.item.text)
        && comparableArguments(entry.item.text, prior.item.text);
    });
    if (nearby) {
      for (const evidence of entry.item.sources) {
        if (!nearby.item.sources.some((existing) => existing.fileId === evidence.fileId && existing.nodeId === evidence.nodeId)) {
          nearby.item.sources.push(evidence);
        }
      }
      nearby.item.sources.sort((left, right) =>
        (sourcePosition.get(`${left.fileId}\0${left.nodeId}`) ?? Number.MAX_SAFE_INTEGER)
        - (sourcePosition.get(`${right.fileId}\0${right.nodeId}`) ?? Number.MAX_SAFE_INTEGER));
    } else distinct.push(entry);
  }
  // Seven is a ceiling, not a quota: once a document has real statements,
  // illustrations and bare labels (score ≤ 0) are not used to fill space.
  const ranked = distinct.some((entry) => entry.score > 0) ? distinct.filter((entry) => entry.score > 0) : distinct;
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
