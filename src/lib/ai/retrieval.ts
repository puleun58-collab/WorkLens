import type { AiRequest } from "@/domain/ai";
import type { AiEvidenceNode } from "@/lib/ai/contract";
import { evidenceCharBudget, evidenceItemText, MAX_EVIDENCE_ITEMS } from "@/lib/ai/prompt";

/**
 * Browser-local evidence retrieval.
 *
 * A BM25-lite lexical score plus document-shape signals (numbers, dates,
 * money, sheet/slide/page labels) beats taking the first N blocks. Ranking
 * covers the full candidate set before the prompt window cuts the winners.
 */
export interface RankedEvidence {
  node: AiEvidenceNode;
  /** Position in the original document order; the deterministic tiebreaker. */
  order: number;
  score: number;
}

const K1 = 1.2;
const B = 0.6;
const PER_GROUP_ROUND = 2;
/**
 * Weights sit above a single shared term's BM25 contribution and below an
 * exact full-question match, so a titled section outranks an adjacent
 * procedure without overruling a literal hit.
 */
const HEADING_TITLE_BOOST = 2.2;
const HEADING_BODY_BOOST = 1.8;
const HEADING_BODY_REACH = 3;
/** Live canonical candidates, regardless of document length or node count. */
export const MAX_EVIDENCE_CANDIDATES = 320;
/** Source position survives shortlist pruning for section-body adjacency. */
const sourceOrder = new WeakMap<AiEvidenceNode, number>();

interface StreamingCandidate {
  node: AiEvidenceNode;
  score: number;
  order: number;
  file: number;
}

function retainStrongest(pool: StreamingCandidate[], candidate: StreamingCandidate, limit: number): void {
  if (limit === 0) return;
  if (pool.length < limit) { pool.push(candidate); return; }
  let weakest = 0;
  for (let index = 1; index < pool.length; index += 1) {
    if (pool[index].score < pool[weakest].score
      || (pool[index].score === pool[weakest].score && pool[index].order > pool[weakest].order)) weakest = index;
  }
  if (candidate.score > pool[weakest].score) pool[weakest] = candidate;
}

/**
 * Global top-ranked shortlist with a modest per-file floor and a whole-run
 * Analyze reservoir. A dense, useful file competes for all remaining slots;
 * a tiny later file does not steal half the capacity merely by existing.
 * Documents of at most 320 nodes retain every node in exact source order.
 */
export function boundedEvidenceCandidates(
  files: readonly Iterable<AiEvidenceNode>[],
  request: AiRequest,
): AiEvidenceNode[] {
  const query = queryOf(request).trim();
  const queryTerms = [...new Set(evidenceTokens(query).filter((term) => term.length > 1 || /^[0-9]/u.test(term)))];
  const normalizedQuery = normalizeText(query);
  const sampleLimit = request.operation === "analyze" ? 64 : 0;
  const reserveEach = Math.min(3, Math.floor((MAX_EVIDENCE_CANDIDATES - sampleLimit) / Math.max(1, files.length)));
  const bestLimit = MAX_EVIDENCE_CANDIDATES - sampleLimit - reserveEach * files.length;
  const buffer: StreamingCandidate[] = [];
  const best: StreamingCandidate[] = [];
  const sample: StreamingCandidate[] = [];
  const reserved: StreamingCandidate[][] = files.map(() => []);
  let sampleSeen = 0;
  let overLimit = false;
  let order = 0;
  const offer = (entry: StreamingCandidate) => {
    retainStrongest(best, entry, bestLimit);
    retainStrongest(reserved[entry.file], entry, reserveEach);
    if (sampleLimit === 0) return;
    sampleSeen += 1;
    if (sample.length < sampleLimit) { sample.push(entry); return; }
    let hash = Math.imul(sampleSeen ^ 0x9e3779b9, 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
    const slot = (hash ^ (hash >>> 16)) >>> 0;
    if (slot % sampleSeen < sampleLimit) sample[slot % sampleLimit] = entry;
  };

  for (const [fileIndex, file] of files.entries()) {
    let headingScore = 0;
    let headingReach = 0;
    for (const node of file) {
      order += 1;
      const text = normalizeText(`${node.text} ${node.source.label}`);
      const terms = queryTerms.length ? new Set(evidenceTokens(text)) : undefined;
      let score = 0;
      if (terms) {
        const labelTerms = new Set(evidenceTokens(node.source.label));
        const withoutCommas = text.replaceAll(",", "");
        for (const term of queryTerms) {
          if (terms.has(term)) score += term.length >= 3 ? 1 : 0.45;
        }
        if (normalizedQuery.length > 3 && text.includes(normalizedQuery)) score += 5;
        for (const term of queryTerms) {
          if (/^[0-9]/u.test(term) && withoutCommas.includes(term)) score += 1.4;
          if (labelTerms.has(term)) score += 0.8;
        }
      }
      if (request.operation === "analyze") score += semanticImportance(node, text);
      else if (RULE_SIGNAL.test(text)) score += 0.2;
      if (node.role === "heading") {
        headingScore = queryTerms.length ? score : 0;
        headingReach = HEADING_BODY_REACH;
        score += request.operation === "analyze" ? 0.2 : 0.9;
      } else if (headingReach > 0) {
        if (queryTerms.length) score += Math.min(HEADING_BODY_BOOST, headingScore * 0.5);
        headingReach -= 1;
      }
      if (FRONT_MATTER.test(text) || TOC_LINE.test(text) || (request.operation === "analyze" && numericNoise(node, text))) score -= 1;
      const entry = { node, score, order, file: fileIndex };
      if (overLimit) offer(entry);
      else if (buffer.length < MAX_EVIDENCE_CANDIDATES) buffer.push(entry);
      else {
        overLimit = true;
        for (const buffered of buffer) offer(buffered);
        buffer.length = 0;
        offer(entry);
      }
    }
  }
  if (!overLimit) {
    for (const entry of buffer) sourceOrder.set(entry.node, entry.order);
    return buffer.map((entry) => entry.node);
  }
  const chosen = new Map<number, AiEvidenceNode>();
  for (const entry of best) chosen.set(entry.order, entry.node);
  for (const group of reserved) for (const entry of group) chosen.set(entry.order, entry.node);
  for (const entry of sample) chosen.set(entry.order, entry.node);
  for (const [position, node] of chosen) sourceOrder.set(node, position);
  return [...chosen].sort(([left], [right]) => left - right).map(([, node]) => node);
}

const TOKEN_PATTERN = /[0-9]+(?:[.,][0-9]+)*%?|[a-z]+|[가-힣]+/g;
const NUMERIC_PATTERN = /[0-9]+(?:[.,][0-9]+)*%?/g;
const DATE_PATTERN = /(?:[0-9]{4}[-./][0-9]{1,2}(?:[-./][0-9]{1,2})?|[0-9]{1,2}\s*월(?:\s*[0-9]{1,2}\s*일)?)/g;
const CURRENCY_PATTERN = /(?:₩|\$|€|¥|원|달러|만원|억원)/gu;
/** Same alternation without `g`, because a global regex keeps `lastIndex`. */
const HAS_CURRENCY = /(?:₩|\$|€|¥|원|달러|만원|억원)/u;

export function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/\s+/gu, " ").trim();
}

/**
 * Tokens plus Korean bigrams. Korean particles glue onto nouns ("경유가",
 * "매출은"), so a whole-token index alone would miss the noun the user typed.
 */
export function evidenceTokens(value: string): string[] {
  const tokens: string[] = [];
  for (const match of normalizeText(value).matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    if (/^[0-9]/.test(token)) {
      tokens.push(token.replaceAll(",", ""));
      continue;
    }
    tokens.push(token);
    if (/^[가-힣]+$/.test(token) && token.length > 2) {
      for (let index = 0; index + 2 <= token.length; index += 1) tokens.push(token.slice(index, index + 2));
    }
  }
  return tokens;
}


function queryOf(request: AiRequest): string {
  switch (request.operation) {
    case "ask":
      return request.question;
    case "semantic-check":
      return request.statement;
    case "analyze":
      return "";
  }
}

/** Sheet, slide, page or block bucket: whole-document coverage spans these. */
function groupKey(node: AiEvidenceNode, order: number): string {
  const { source } = node;
  // Long sheets balance by row range too, so a time series is not represented by its first rows.
  if (source.sheet) return `${node.fileId}|sheet:${source.sheet}|rows:${Math.floor((source.row ?? 0) / 100)}`;
  if (source.locator?.kind === "pptx") return `${node.fileId}|slide:${source.locator.slide}`;
  if (source.locator?.kind === "docx") return `${node.fileId}|part:${source.locator.part}:${Math.floor(source.locator.block / 20)}`;
  if (typeof source.page === "number") return `${node.fileId}|page:${source.page}`;
  return `${node.fileId}|block:${Math.floor((sourceOrder.get(node) ?? order) / 20)}`;
}

/**
 * The BM25 ceiling for this query: what a node would score if it matched
 * every query term once. Raw scores grow with corpus size, so the gate needs
 * this to express a match as a share of what the question could earn.
 */
function queryIdfCeiling(nodes: readonly AiEvidenceNode[], query: string): number {
  const queryTerms = [...new Set(evidenceTokens(query))].filter((term) => term.length > 1 || /^[0-9]/.test(term));
  const documentFrequency = new Map<string, number>();
  for (const node of nodes) {
    for (const term of new Set(evidenceTokens(`${node.text} ${node.source.label}`))) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  let ceiling = 0;
  for (const term of queryTerms) {
    const df = documentFrequency.get(term) ?? 0;
    ceiling += Math.log(1 + (nodes.length - df + 0.5) / (df + 0.5));
  }
  return ceiling;
}

function relevanceScores(nodes: readonly AiEvidenceNode[], query: string): number[] {
  const normalizedQuery = normalizeText(query);
  const queryTerms = [...new Set(evidenceTokens(query))].filter((term) => term.length > 1 || /^[0-9]/.test(term));
  const documentTerms = nodes.map((node) => evidenceTokens(`${node.text} ${node.source.label}`));
  const lengths = documentTerms.map((terms) => terms.length);
  const averageLength = lengths.reduce((sum, value) => sum + value, 0) / Math.max(1, lengths.length);
  const documentFrequency = new Map<string, number>();
  for (const terms of documentTerms) {
    for (const term of new Set(terms)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }

  const queryNumbers = new Set((normalizedQuery.match(NUMERIC_PATTERN) ?? []).map((value) => value.replaceAll(",", "")));
  const queryDates = normalizedQuery.match(DATE_PATTERN) ?? [];
  const queryCurrency = (normalizedQuery.match(CURRENCY_PATTERN) ?? []).length > 0;

  return nodes.map((node, index) => {
    if (queryTerms.length === 0) return 0;
    const terms = documentTerms[index];
    const frequency = new Map<string, number>();
    for (const term of terms) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    const normalizedNode = normalizeText(`${node.text} ${node.source.label}`);

    let score = 0;
    for (const term of queryTerms) {
      const tf = frequency.get(term) ?? 0;
      if (tf === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (nodes.length - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * terms.length) / Math.max(1, averageLength))));
    }

    // Shape signals: the same words in a label, a number or a date the user
    // actually typed are far stronger evidence than a generic term hit.
    if (normalizedQuery.length > 3 && normalizedNode.includes(normalizedQuery)) score += 2.5;
    for (const number of queryNumbers) if (normalizedNode.replaceAll(",", "").includes(number)) score += 1.4;
    for (const date of queryDates) if (normalizedNode.includes(date)) score += 1.2;
    if (queryCurrency && HAS_CURRENCY.test(normalizedNode)) score += 0.4;
    const labelTokens = new Set(evidenceTokens(node.source.label));
    for (const term of queryTerms) if (labelTokens.has(term)) score += 0.8;
    return score;
  });
}

const TOC_LINE = /\s\d{1,3}$/u;
const STRUCTURAL_LINE = /^[\s\d.,:;()[\]/·—–-]*$/u;
const FRONT_MATTER = /(?:지은이|펴낸곳|초판|\d+\s*쇄|조판|서체|목차|차례|contents|copyright|all rights reserved)/u;
const RULE_SIGNAL = /(?:목적|개요|기준|규칙|순서|절차|흐름|조건|예외|전환|재계산|산정|적용|주의|결론|요약|조치|계획|목표|리스크|이슈|정의|반영|선택|우선|\b(?:purpose|objective|scope|rule|criteria|process|procedure|requirement|exception|condition|policy|decision|risk|action|summary|priority)\b)/u;
/** Relation-bearing sentences can support an optional Analyze insight. */
const RELATION_SIGNAL = /(?:(?:이|가|하)?면\s|경우|따라|때문|없으면|없을\s*때|대신|순서로|순으로|우선|다시|재계산|재산출|전환|바뀌|변경되|반영되|기준으로|보정|조정|제한|이내|→|->|\b(?:then|if|unless|instead|because|therefore|before|after|depends on|subject to)\b)/u;
/** Numbered actions are content, unlike a numbered contents entry or sample value. */
const ORDERED_ACTION = /^(?:\d{1,2}[.)]|[①-⑳]|[-•])\s*.+(?:검토|확인|제출|승인|수행|처리|등록|완료|\b(?:review|verify|submit|approve|perform|record)\b)/u;
/** A change from an earlier state is document meaning, not a sample value. */
const TRANSITION_SIGNAL = /(?:\b(?:was|were|previously|initially|formerly)\b.{2,120}\b(?:but|whereas|now|currently)\b|\b(?:changed|moved|transitioned)\s+from\b.{2,80}\bto\b|(?:기존|이전|당초|초기|종전).{2,120}(?:현재|이제|최종|이후|반면)|(?:이었|였|이던|하던|했던|되던).{2,100}(?:이제|현재|최종|바뀌|변경|전환|되었))/iu;


function numericNoise(node: AiEvidenceNode, text: string): boolean {
  return node.proposition.predicate === "has_value"
    ? !RULE_SIGNAL.test(text) && /\d/u.test(text) && text.length <= 40
    : (text.match(NUMERIC_PATTERN) ?? []).length >= 2 && text.length <= 32;
}

function semanticImportance(node: AiEvidenceNode, text: string): number {
  let score = 0;
  if (RULE_SIGNAL.test(text)) score += 1.3;
  if (node.role !== "heading" && RELATION_SIGNAL.test(text)) score += 1.1;
  if (node.role !== "heading" && ORDERED_ACTION.test(text)) score += 0.6;
  if (/(?:예시|예를\s*들|표시\s*예|\b(?:example|sample|illustration)\b)/u.test(text)) score -= 0.8;
  // One value far outside its column is a finding the model should see; it
  // is not asserted as a conclusion, only kept in view.
  if (node.outlier) score += 2.5;
  if (node.role !== "heading" && TRANSITION_SIGNAL.test(text)) score += 2.8;
  if (numericNoise(node, text)) score -= 0.5;
  return score;
}

/**
 * Whole-document importance favours rules and process over cover text,
 * contents entries, running heads and example rows.
 */
function importanceScores(nodes: readonly AiEvidenceNode[], operation: AiRequest["operation"]): number[] {
  const frequency = new Map<string, number>();
  const textCount = new Map<string, number>();
  for (const node of nodes) {
    for (const term of new Set(evidenceTokens(node.text))) {
      if (term.length < 2) continue;
      frequency.set(term, (frequency.get(term) ?? 0) + 1);
    }
    const key = normalizeText(node.text).replace(/\d+/gu, "");
    textCount.set(key, (textCount.get(key) ?? 0) + 1);
  }
  return nodes.map((node) => {
    const text = normalizeText(node.text);
    let score = 0;
    const numericCount = (text.match(NUMERIC_PATTERN) ?? []).length;
    if (numericCount > 0) score += operation === "analyze" ? (numericCount === 1 ? 0.3 : 0.1) : (numericCount === 1 ? 0.7 : 0.45);
    if ((text.match(DATE_PATTERN) ?? []).length > 0) score += operation === "analyze" ? 0.2 : 0.45;
    if ((text.match(CURRENCY_PATTERN) ?? []).length > 0) score += operation === "analyze" ? 0.15 : 0.35;
    if (operation === "analyze") score += semanticImportance(node, text);
    else if (RULE_SIGNAL.test(text)) score += 1.3;
    // Titles carry context, but must not displace the rules beneath them.
    if (node.role === "heading") score += operation === "analyze" ? 0.2 : 0.9;
    else if (text.length <= 40) score += 0.2;
    if (node.proposition.predicate === "has_value") score += operation !== "analyze" ? 0.25 : numericNoise(node, text) ? 0 : 0.4;
    // Front matter, contents entries and running heads are not substantive evidence.
    if (STRUCTURAL_LINE.test(node.text)) score -= 1.2;
    if (TOC_LINE.test(node.text.trim())) score -= 1.0;
    if (FRONT_MATTER.test(text)) score -= 1.0;
    if ((textCount.get(text.replace(/\d+/gu, "")) ?? 0) >= 2) score -= 1.2;
    const repeats = [...new Set(evidenceTokens(node.text))]
      .filter((term) => term.length > 1 && (frequency.get(term) ?? 0) >= 3).length;
    return score + Math.min(repeats, 4) * 0.2;
  });
}

/**
 * Caps how much of the window any one sheet, slide, page or block range can
 * own, then fills the rest by score. A strict round-robin gave a cover page
 * and a table of contents the same share as the chapter that carries the
 * document; a cap keeps dense sections from taking over without promoting
 * pages that have nothing to say.
 */
function balanceBySource(ranked: readonly RankedEvidence[], limit: number, charBudget: number, ask: boolean): RankedEvidence[] {
  const groupCount = new Set(ranked.map((entry) => groupKey(entry.node, entry.order))).size;
  const cap = ask ? Math.max(3, Math.ceil(limit / 3)) : Math.max(PER_GROUP_ROUND, Math.ceil(limit / Math.max(1, groupCount)) + 1);
  const used = new Map<string, number>();
  const selected: RankedEvidence[] = [];
  const overflow: RankedEvidence[] = [];
  let characters = 0;
  for (const entry of ranked) {
    const size = evidenceItemText(entry.node).length;
    if (!size || characters + size > charBudget) continue;
    const key = groupKey(entry.node, entry.order);
    const count = used.get(key) ?? 0;
    if (selected.length >= limit || count >= cap || (!ask && entry.score <= 0)) { overflow.push(entry); continue; }
    used.set(key, count + 1);
    selected.push(entry);
    characters += size;
  }
  // Analyze fills the rest group by group: the next-best item of every
  // section before a second one of any, so ties never collapse to the top
  // rows. Ask keeps pure relevance order.
  const rank = new Map<string, number>();
  const interleaved = overflow
    .map((entry, index) => {
      const key = groupKey(entry.node, entry.order);
      const round = rank.get(key) ?? 0;
      rank.set(key, round + 1);
      return { entry, round, index };
    })
    .sort((left, right) => (ask ? 0 : left.round - right.round) || left.index - right.index)
    .map(({ entry }) => entry);
  for (const entry of interleaved) {
    if (selected.length >= limit) break;
    const size = evidenceItemText(entry.node).length;
    if (characters + size > charBudget) continue;
    selected.push(entry);
    characters += size;
  }
  return selected;
}

/**
 * A section heading names a topic; its following paragraph explains it.
 * It can displace the weakest non-heading pick when the window is full.
 */
function withSectionBodies(
  selected: readonly RankedEvidence[],
  ranked: readonly RankedEvidence[],
  limit: number,
  charBudget: number,
): RankedEvidence[] {
  const byOrder = new Map(ranked.map((entry) => [sourceOrder.get(entry.node) ?? entry.order, entry]));
  const chosen = new Map(selected.map((entry) => [entry.order, entry]));
  let characters = selected.reduce((sum, entry) => sum + evidenceItemText(entry.node).length, 0);
  /** Section bodies pulled in here: never given up to complete a weaker section. */
  const pinned = new Set<number>();
  const headings = selected
    .filter((entry) => entry.node.role === "heading")
    .sort((left, right) => right.score - left.score || left.order - right.order);
  for (const entry of headings) {
    if (!chosen.has(entry.order)) continue;
    const body = byOrder.get((sourceOrder.get(entry.node) ?? entry.order) + 1);
    if (!body || body.node.fileId !== entry.node.fileId || body.node.role === "heading" || chosen.has(body.order)) continue;
    const size = evidenceItemText(body.node).length;
    if (!size || size > charBudget) continue;
    while (chosen.size >= limit || characters + size > charBudget) {
      const loose = [...chosen.values()]
        .filter((candidate) => !pinned.has(candidate.order) && candidate.node.role !== "heading");
      const weakest = (loose.length > 0
        ? loose
        : [...chosen.values()].filter((candidate) => candidate.order !== entry.order
          && !pinned.has(candidate.order)
          && candidate.score < entry.score))
        .sort((left, right) => left.score - right.score || right.order - left.order)[0];
      if (!weakest) break;
      chosen.delete(weakest.order);
      characters -= evidenceItemText(weakest.node).length;
    }
    if (chosen.size >= limit || characters + size > charBudget) continue;
    chosen.set(body.order, body);
    characters += size;
    pinned.add(body.order);
  }
  return [...chosen.values()];
}
/**
 * Ask answers a question, and a document answers questions in its sections.
 * A short question ("산정 방식") shares vocabulary with several neighbouring
 * procedures, so the section whose own title scores best on the question wins
 * over a paragraph that merely reuses the words — and its body inherits that
 * standing, because the title asks and the body answers. The share is taken
 * from the lexical score so rare question words still decide, rather than
 * from raw token overlap, where a shared particle would count as a match.
 */
function headingAffinity(nodes: readonly AiEvidenceNode[], relevance: readonly number[]): number[] {
  const affinity = new Array<number>(nodes.length).fill(0);
  // A paginated file's first heading is its title: it names the whole
  // document, so sharing a word with it says nothing about which section
  // answers. Slides title every page, so the rule stays with pages.
  const titles = new Set<number>();
  const seenFiles = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    if (node.role !== "heading" || seenFiles.has(node.fileId)) continue;
    seenFiles.add(node.fileId);
    if (typeof node.source.page === "number") titles.add(index);
  }
  const best = nodes.reduce(
    (top, node, index) => (node.role === "heading" && !titles.has(index) ? Math.max(top, relevance[index]) : top),
    0,
  );
  if (best <= 0) return affinity;
  for (const [index, node] of nodes.entries()) {
    if (node.role !== "heading" || titles.has(index)) continue;
    const share = relevance[index] / best;
    if (share <= 0) continue;
    affinity[index] += HEADING_TITLE_BOOST * share;
    // Only this section's own text, never the next section's title.
    for (let body = index + 1; body < nodes.length
      && nodes[body].fileId === node.fileId
      && nodes[body].role !== "heading"
      && (sourceOrder.get(nodes[body]) ?? body) === (sourceOrder.get(nodes[body - 1]) ?? body - 1) + 1; body += 1) {
      affinity[body] += HEADING_BODY_BOOST * share;
      if (body - index >= HEADING_BODY_REACH) break;
    }
  }
  return affinity;
}



export interface SelectEvidenceOptions {
  /** Maximum item count; never exceeds the model's 40-item envelope. */
  limit?: number;
}

/**
 * Running heads, confidentiality marks and page numbers repeat on page after
 * page. They say nothing about the document, so whole-document Analyze never
 * spends evidence on them — even when a short document would fit entirely.
 * A repeated full sentence is content (a restated rule), not furniture.
 */
function withoutRunningFurniture(nodes: readonly AiEvidenceNode[]): readonly AiEvidenceNode[] {
  const key = (node: AiEvidenceNode) => normalizeText(node.text).replace(/\d+/gu, "#");
  const pages = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (node.source.page === undefined) continue;
    const text = node.text.trim();
    if (text.length > 40 || /(?:다|니다|요)[.!?]?$|[.!?]$/u.test(text)) continue;
    const seen = pages.get(key(node)) ?? new Set<string>();
    seen.add(`${node.fileId}:${node.source.page}`);
    pages.set(key(node), seen);
  }
  const furniture = new Set([...pages].filter(([, seen]) => seen.size >= 2).map(([text]) => text));
  return furniture.size === 0 ? nodes : nodes.filter((node) => node.source.page === undefined || !furniture.has(key(node)));
}

/**
 * Ranks every candidate, keeps the best `limit`, then restores document order
 * so the prompt still reads top to bottom. Equal scores always resolve by
 * document order, which keeps the selection deterministic.
 */
export function selectEvidence(
  nodes: readonly AiEvidenceNode[],
  request: AiRequest,
  options: SelectEvidenceOptions = {},
): AiEvidenceNode[] {
  const limit = Math.min(options.limit ?? MAX_EVIDENCE_ITEMS, MAX_EVIDENCE_ITEMS);
  const charBudget = evidenceCharBudget(request.operation);
  const candidates = request.operation === "analyze" ? withoutRunningFurniture(nodes) : nodes;
  const query = queryOf(request).trim();
  const scoreAsk = request.operation === "ask" && query.length > 0;
  if (candidates.length <= limit && !scoreAsk
    && candidates.reduce((sum, node) => sum + evidenceItemText(node).length, 0) <= charBudget) return [...candidates];
  const relevance = query ? relevanceScores(candidates, query) : undefined;
  const importance = importanceScores(candidates, request.operation);
  const affinity = scoreAsk && relevance ? headingAffinity(candidates, relevance) : undefined;
  const ranked: RankedEvidence[] = candidates.map((node, order) => ({
    node,
    order,
    score: (relevance ? relevance[order] + importance[order] * 0.15 : importance[order])
      + (affinity ? affinity[order] : 0),
  }));

  const sorted = [...ranked].sort((left, right) => right.score - left.score || left.order - right.order);

  // Analyze balances the entire document across source sections.
  if (request.operation === "analyze") {
    return withSectionBodies(balanceBySource(sorted, limit, charBudget, false), ranked, limit, charBudget)
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.node);
  }

  // Ask drops candidates the question does not touch at all, but only when
  // something clearly does: with no strong match the window is left intact so
  // a weak-wording question cannot lose its own answer.
  const askFloor = scoreAsk && relevance && relevance.some((value) => value >= ASK_MIN_MATCH);
  const considered = askFloor ? sorted.filter((entry) => relevance[entry.order] > 0) : sorted;
  // Score and source balance first, then spend the operation's character
  // budget while candidates are still ranked. Document order is presentation
  // only; it must never re-cut a later high-priority answer.
  return withSectionBodies(balanceBySource(considered, limit, charBudget, true), ranked, limit, charBudget)
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.node);
}
/**
 * Ask-only answerability gate.
 *
 * A question is not answerable merely because a document exists, so Ask
 * decides before the model runs.
 *
 *  - `match` is the best candidate's score divided by what this question
 *    could earn if every one of its terms hit. Raw BM25 grows with corpus
 *    size — a three-paragraph invoice can never reach the score a 5,000-cell
 *    workbook does — so only the normalized share is comparable, and it is
 *    what the threshold is set on.
 *  - `coverage`, the share of question tokens present anywhere, is reported
 *    for diagnosis but never gates: answerable title and date questions
 *    legitimately reach zero coverage.
 *
 * Document-level questions ("이 자료의 제목은?") share no wording with their
 * answer by nature. They ask about the document itself, so they bypass the
 * threshold as Analyze does.
 *
 * Threshold, measured over the fixed eval set plus the small-document cases
 * in `tests/eval-retrieval.test.ts`: the weakest answerable question scores
 * 0.052 and the strongest rejected unanswerable one 0.032, so 0.04 sits
 * between them. It abstains on 8 of the 9 unanswerable eval cases; the ninth
 * shares real wording with the document and is left for the model to refuse.
 */
export const ASK_MIN_MATCH = 0.04;

/** Asks about the document itself rather than a value inside it. */
const DOCUMENT_LEVEL_QUESTION = /(제목|타이틀|무슨\s*문서|어떤\s*문서|문서\s*종류|전체\s*요약|요약해|title|summary|summarize|what\s+is\s+this\s+document)/u;

export interface AskRelevance {
  /** Best single-candidate relevance score, in raw BM25-plus-shape points. */
  topScore: number;
  /** `topScore` as a share of this question's ceiling; the gated signal. */
  match: number;
  /** Share of question tokens found in the candidates; diagnostic only. */
  coverage: number;
  /** False means: answering from this evidence would be a guess. */
  supported: boolean;
}

export function askRelevance(nodes: readonly AiEvidenceNode[], question: string): AskRelevance {
  const query = question.trim();
  if (nodes.length === 0) return { topScore: 0, match: 0, coverage: 0, supported: false };
  // No question carries no claim to check; the window stays as it is.
  if (query.length === 0) return { topScore: 0, match: 1, coverage: 1, supported: true };

  const normalizedQuery = normalizeText(query);
  const topScore = relevanceScores(nodes, query).reduce((best, value) => Math.max(best, value), 0);
  const ceiling = queryIdfCeiling(nodes, query);
  const match = ceiling > 0 ? topScore / ceiling : 0;
  const terms = [...new Set((normalizedQuery.match(TOKEN_PATTERN) ?? [])
    .filter((term) => term.length > 1 || /^[0-9]/.test(term)))];
  const corpus = nodes.map((node) => normalizeText(`${node.text} ${node.source.label}`));
  const matched = terms.filter((term) => corpus.some((text) => text.includes(term))).length;
  const coverage = terms.length === 0 ? 1 : matched / terms.length;
  const documentLevel = DOCUMENT_LEVEL_QUESTION.test(normalizedQuery);
  return { topScore, match, coverage, supported: documentLevel || match >= ASK_MIN_MATCH };
}
