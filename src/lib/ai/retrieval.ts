import type { AiRequest } from "@/domain/ai";
import type { AiEvidenceNode } from "@/lib/ai/contract";

/**
 * Browser-local evidence retrieval.
 *
 * No embedding service and no vector store: a BM25-lite lexical score plus a
 * few document-shape signals (numbers, dates, money, sheet/slide/page labels)
 * is enough to beat "take the first N blocks", which is what Ask and Brief used
 * to do. Ranking always runs on the full candidate set and only the winners are
 * cut down to the prompt window, never the other way around.
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
    case "brief":
      return request.instruction ?? "";
    case "analyze":
      return "";
  }
}

/** Sheet, slide, page or block bucket: the unit Brief must spread across. */
function groupKey(node: AiEvidenceNode, order: number): string {
  const { source } = node;
  if (source.sheet) return `${node.fileId}|sheet:${source.sheet}`;
  if (source.locator?.kind === "pptx") return `${node.fileId}|slide:${source.locator.slide}`;
  if (source.locator?.kind === "docx") return `${node.fileId}|part:${source.locator.part}:${Math.floor(source.locator.block / 20)}`;
  if (typeof source.page === "number") return `${node.fileId}|page:${source.page}`;
  return `${node.fileId}|block:${Math.floor(order / 20)}`;
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

/**
 * Brief has no question, so importance stands in for relevance: structured
 * values, dates, money and short heading-like lines carry a document.
 */
function importanceScores(nodes: readonly AiEvidenceNode[]): number[] {
  const frequency = new Map<string, number>();
  for (const node of nodes) {
    for (const term of new Set(evidenceTokens(node.text))) {
      if (term.length < 2) continue;
      frequency.set(term, (frequency.get(term) ?? 0) + 1);
    }
  }
  return nodes.map((node) => {
    const text = normalizeText(node.text);
    let score = 0;
    if ((text.match(NUMERIC_PATTERN) ?? []).length > 0) score += 1.2;
    if ((text.match(DATE_PATTERN) ?? []).length > 0) score += 1;
    if ((text.match(CURRENCY_PATTERN) ?? []).length > 0) score += 0.8;
    if (/(?:결론|요약|조치|해야|예정|계획|목표|리스크|이슈|action|summary|todo)/u.test(text)) score += 1.1;
    if (text.length <= 40) score += 0.5;
    if (node.proposition.predicate === "has_value") score += 0.4;
    const repeats = [...new Set(evidenceTokens(node.text))]
      .filter((term) => term.length > 1 && (frequency.get(term) ?? 0) >= 3).length;
    return score + Math.min(repeats, 4) * 0.2;
  });
}

/**
 * Spreads the winners over sheets, slides, pages and block ranges so one dense
 * section cannot own the whole prompt window.
 */
function balanceBySource(ranked: readonly RankedEvidence[], limit: number): RankedEvidence[] {
  const groups = new Map<string, RankedEvidence[]>();
  for (const entry of ranked) {
    const key = groupKey(entry.node, entry.order);
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }
  const ordered = [...groups.values()].sort((left, right) =>
    right[0].score - left[0].score || left[0].order - right[0].order);
  const selected: RankedEvidence[] = [];
  const cursors = new Map<RankedEvidence[], number>();
  while (selected.length < limit) {
    let added = false;
    for (const bucket of ordered) {
      const cursor = cursors.get(bucket) ?? 0;
      for (let taken = 0; taken < PER_GROUP_ROUND && cursor + taken < bucket.length; taken += 1) {
        if (selected.length >= limit) break;
        selected.push(bucket[cursor + taken]);
        added = true;
      }
      cursors.set(bucket, cursor + PER_GROUP_ROUND);
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return selected;
}

export interface SelectEvidenceOptions {
  /** Ranked candidates kept before the prompt window trims by characters. */
  limit?: number;
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
  const limit = options.limit ?? 40;
  if (nodes.length <= limit) return [...nodes];
  const query = queryOf(request).trim();
  const relevance = query ? relevanceScores(nodes, query) : undefined;
  const importance = importanceScores(nodes);
  const ranked: RankedEvidence[] = nodes.map((node, order) => ({
    node,
    order,
    score: relevance ? relevance[order] + importance[order] * 0.15 : importance[order],
  }));
  const sorted = [...ranked].sort((left, right) => right.score - left.score || left.order - right.order);

  // A question is answered by the strongest matches, with a per-section cap so
  // one dense sheet cannot own the window; a whole-document task (Brief,
  // Analyze) is balanced across sections from the start.
  if (!query || request.operation === "brief" || request.operation === "analyze") {
    return balanceBySource(sorted, limit)
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.node);
  }
  const perGroupCap = Math.max(3, Math.ceil(limit / 3));
  const used = new Map<string, number>();
  const picked: RankedEvidence[] = [];
  const overflow: RankedEvidence[] = [];
  for (const entry of sorted) {
    if (picked.length >= limit) break;
    const key = groupKey(entry.node, entry.order);
    const count = used.get(key) ?? 0;
    if (count >= perGroupCap) { overflow.push(entry); continue; }
    used.set(key, count + 1);
    picked.push(entry);
  }
  for (const entry of overflow) {
    if (picked.length >= limit) break;
    picked.push(entry);
  }
  return picked
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.node);
}
