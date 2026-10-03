import type { NormalizedDocument, SourceRef, TableCell } from "@/domain/document";
import { issueSignals, segmentsOf, splitClauses, triggeringSentence, type Severity } from "@/lib/contract-review";
import {
  LAW_RESEARCH_DOCUMENT_MIN_CHARS, LAW_REVIEW_FILE_MAX_CHARS, LAW_REVIEW_FILE_MAX_SEGMENTS, LAW_REVIEW_LOCATION_MAX_CHARS,
  LAW_REVIEW_SEGMENT_MAX_CHARS, type LawResearchRequest, type ReviewDocument,
} from "@/lib/law-research";

/**
 * Builds a bounded review request from a parsed workspace file. A file within the request bounds
 * is sent whole. A longer one is scanned locally, every unit of it, with the issue taxonomy's own
 * detection rules; the scan picks which text to send, with the clause context it needs, and a
 * distributed sample fills the rest of the budget so a scan that finds nothing still sends text
 * from across the file. The scan only selects: its issue and severity hints never leave this
 * module, and the server reviews the received text from scratch. SourceRefs stay in the worker/UI.
 */

/** Recorded with every evaluation run; bump when selection behavior changes. */
export const REVIEW_SELECTOR_VERSION = "candidate-scan-v3";

/** complete: every reviewable part was sent. partial: some was not (limits, textless pages, omitted parts). excluded: nothing to review. */
export type ReviewCoverageStatus = "complete" | "partial" | "excluded";

/** Detailed review coverage: units whose text was sent for review. Scanning is reported in `ReviewScan`. */
export interface ReviewCoverage {
  status: ReviewCoverageStatus;
  /** What a unit is for this format: 페이지, 슬라이드, 문단, 행. */
  unit: string;
  total: number;
  reviewed: number;
  /** Units set aside because they hold no clause text (data rows of a sheet). */
  excluded: number;
  /** Units with text that was not reviewed; `reasons` say why. */
  unreviewed: number;
  reasons: string[];
  /** For `excluded`: why the file could not be reviewed. */
  note?: string;
}

/**
 * How the sent text was chosen. Scan coverage (every reviewable unit is read locally) is distinct
 * from detailed review coverage (`ReviewCoverage`) and from evidence coverage (the review's lookups).
 */
export interface ReviewScan {
  /** whole: everything fit and was sent. candidate: local scan plus distributed fill. distributed: sampling only (evaluation baseline). */
  strategy: "whole" | "candidate" | "distributed";
  /** Reviewable units the local scan read: all of them. */
  scanned: number;
  /** Places the scan matched, before boilerplate was represented. */
  candidates: number;
  /** Candidates whose context was sent in full. */
  sent: number;
  /** Candidates repeating another's issue and sentence beyond the representatives kept for it. */
  repeated: number;
  /** Sent candidates by tenth of the document, front to back. */
  positions: number[];
}

export interface ReviewFile {
  fileId: string;
  document: ReviewDocument;
  /** Canonical source of each segment, in the same order as `document.segments`; never sent. */
  sources: SourceRef[];
  coverage: ReviewCoverage;
  /** Selector report; never sent. */
  scan: ReviewScan;
  /** The file places images whose text 문서 검토 does not read. */
  imagesUnread: boolean;
}

/**
 * Selector-only: one place the taxonomy's detection rules match, and the context sent with it.
 * Never serialized; `reviewRequestFor` builds the request from text and identity alone.
 */
export interface LocalCandidate {
  /** Reviewable-unit indices to send: the whole clause, or the matching unit and its neighbors. */
  units: number[];
  /** The reviewable unit holding the matching sentence. */
  anchor: number;
  /** Selection hints: they order the budget and nothing else. */
  issueHint: string;
  severityHint: Severity;
  /** Whitespace-free matching sentence: repeats of one boilerplate share it. */
  factKey: string;
}

export interface ReviewFileOptions {
  /** `distributed` reproduces sampling without the scan; it exists to compare the two on one evaluation set. */
  selection?: "candidate" | "distributed";
  /** Test seam: rewrite the scan's candidates (e.g. tamper with their hints) before selection. */
  candidates?: (found: LocalCandidate[]) => LocalCandidate[];
}

interface Unit {
  unit: string;
  text: string;
  location: string;
  source: SourceRef;
  /** False for sheet rows that hold no sentence (numbers, codes, names). */
  reviewable: boolean;
}

interface Reviewable extends Unit {
  /** Index among all units, reviewable or not: a gap here is a gap in the document. */
  index: number;
  parts: string[];
  chars: number;
}

const UNIT: Record<NormalizedDocument["kind"], string> = { pdf: "페이지", pptx: "슬라이드", docx: "문단", xlsx: "행", csv: "행" };
const CLAUSE_HEAD = /^(제\s*\d+\s*조(?:의\s*\d+)?)\s*(?:\(([^)]{1,30})\))?/u;
/** A cell that reads as a clause sentence, not a value: words, and a predicate or a sentence end. */
const PREDICATE = /(?:[.다요함음]\s*$)|(?:한다|된다|있다|없다|하여야|해야|할\s*수|하지|않는다|따른다|으로\s*한다)/u;

const LEGAL_CONTEXT = /계약|약관|규정|조건|특약|조항|인사|복무|근무|임대차|용역|위약|해지|개인정보/u;
const SHORT_TERM = /자동\s*(?:갱신|연장)|위약금|위약벌|중도\s*해지|해지\s*통지|전속\s*관할|원상\s*복구|청약\s*철회|환불|연차\s*휴가/u;
/** Row labels of contract conditions whose value is a period, amount, rate, notice or court. */
const CONDITION_LABEL = /^(?:(?:손해\s*)?(?:책임|배상)\s*한도|계약\s*기간|이용\s*기간|(?:개인정보\s*)?(?:보유|보관)(?:\s*기간)?|개인정보\s*(?:보유|보관)|해지\s*(?:통보|통지|예고)|관할(?:\s*법원)?)$/u;
/** A condition's value, not a bare number: it carries a unit, a date range or a court. */
const CONDITION_VALUE = /\d+\s*(?:년|개월|월|주|일|%|배|원|만\s*원)|\d{4}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2}|~|부터|까지|법원/u;
const DISTRIBUTED_BANDS = 20;
/** A clause longer than this sends its head and the matching units with their neighbors, not all of it. */
const CONTEXT_MAX_CHARS = 4_000;
/** Share of the request the scan's candidates may use; the rest is the distributed fallback. */
const CANDIDATE_SHARE = 0.7;
/** Positions kept per repeated sentence of one issue: front, back, middle. */
const REPRESENTATIVES = 3;
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/**
 * A short sheet row a contract reader would read: a legal term with a value, or a condition label
 * with a condition-shaped value, under a sheet/header/file that is about a contract. Reading a row
 * never makes it an issue; the review decides that from the text.
 */
function shortLegalRow(cells: TableCell[], context: string): boolean {
  if (!LEGAL_CONTEXT.test(context) || cells.length < 2) return false;
  if (cells.some((cell) => SHORT_TERM.test(cell.display))) return cells.some((cell) => cell.display.trim() && !SHORT_TERM.test(cell.display));
  return cells.some((cell, index) => CONDITION_LABEL.test(cell.display.trim())
    && cells.some((other, at) => at !== index && CONDITION_VALUE.test(other.display)));
}
function sentenceLike(cell: TableCell): boolean {
  if (cell.valueType && cell.valueType !== "text") return false;
  const text = cell.display.trim();
  return text.length >= 12 && /[가-힣]/u.test(text) && /\s/u.test(text) && PREDICATE.test(text);
}

function clip(location: string): string {
  const clean = location.replace(/[\p{Cc}]+/gu, " ").replace(/\s+/gu, " ").trim();
  return clean.length > LAW_REVIEW_LOCATION_MAX_CHARS ? `${clean.slice(0, LAW_REVIEW_LOCATION_MAX_CHARS - 1)}…` : clean;
}

/** `B12` + `F12` (or merged `B12:C13` + `F12`) → `B12:F12`. */
function spanRange(first: string, last: string): string {
  const start = first.split(":")[0];
  const end = last.split(":").at(-1)!;
  return start === end ? start : `${start}:${end}`;
}

/** A docx paragraph that opens a section: a heading, or an article head such as `제5조(보상 및 책임)`. */
function docxSection(text: string, heading: boolean): string | undefined {
  const head = CLAUSE_HEAD.exec(text);
  if (head) return head[2] ? `${head[1].replace(/\s+/gu, "")} ${head[2]}` : head[1].replace(/\s+/gu, "");
  return heading ? text.slice(0, 40) : undefined;
}

function units(document: NormalizedDocument): Unit[] {
  const out: Unit[] = [];
  let section: string | undefined;
  let paragraph = 0;
  const sheetHeaders = new Map<string, string>();
  document.blocks.forEach((block, blockIndex) => {
    if (block.type === "paragraph") {
      const text = block.text.trim();
      if (!text) return;
      const locator = block.source.locator;
      if (locator?.kind === "pdf") out.push({ unit: `p${locator.page}`, text, location: `${locator.page}페이지`, source: block.source, reviewable: true });
      else if (locator?.kind === "pptx") out.push({ unit: `s${locator.slide}`, text, location: `${locator.slide}P`, source: block.source, reviewable: true });
      else if (locator?.kind === "docx") {
        if (locator.part !== "body") {
          out.push({ unit: `b${blockIndex}`, text, location: locator.part === "header" ? "머리글" : "바닥글", source: block.source, reviewable: true });
          return;
        }
        paragraph += 1;
        section = docxSection(text, block.role === "heading") ?? section;
        out.push({ unit: `b${blockIndex}`, text, location: section ?? `${paragraph}번째 문단`, source: block.source, reviewable: true });
      } else out.push({ unit: `b${blockIndex}`, text, location: block.source.label, source: block.source, reviewable: true });
      return;
    }
    block.rows.forEach((row, rowIndex) => {
      const cells = row.filter((cell) => cell.display.trim());
      if (!cells.length) return;
      const first = cells[0].source;
      const locator = first.locator;
      const sheet = locator?.kind === "xlsx" ? locator.sheet : locator?.kind === "csv" ? "CSV" : undefined;
      const header = sheetHeaders.get(sheet ?? "") ?? "";
      const context = `${locator?.kind === "csv" ? document.metadata.fileName : ""} ${sheet ?? ""} ${header}`;
      const short = sheet !== undefined && shortLegalRow(cells, context);
      const rowText = cells.map((cell) => cell.display.trim()).join(" ");
      const text = short ? `계약 조항 ${context.trim()} ${rowText}` : rowText;
      if (sheet !== undefined && rowIndex === 0) sheetHeaders.set(sheet, rowText.slice(0, 120));
      if (locator?.kind === "xlsx") {
        const last = cells.at(-1)!.source.locator;
        const range = last?.kind === "xlsx" ? spanRange(locator.range, last.range) : locator.range;
        out.push({ unit: `${locator.sheet}\0${rowIndex}`, text, location: `${locator.sheet} / ${range}`, source: first, reviewable: short || cells.some(sentenceLike) });
      } else if (locator?.kind === "csv") {
        out.push({ unit: `r${locator.record}`, text, location: `${locator.record}행`, source: first, reviewable: short || cells.some(sentenceLike) });
      } else if (locator?.kind === "pptx") {
        out.push({ unit: `s${locator.slide}`, text, location: `${locator.slide}P 표`, source: first, reviewable: true });
      } else if (locator?.kind === "pdf") {
        out.push({ unit: `p${locator.page}`, text, location: `${locator.page}페이지 표`, source: first, reviewable: true });
      } else if (locator?.kind === "docx") {
        paragraph += 1;
        const place = locator.part === "header" ? "머리글 " : locator.part === "footer" ? "바닥글 " : section ? `${section} · ` : "";
        out.push({ unit: `t${blockIndex}:${rowIndex}`, text, location: `${place}표 ${rowIndex + 1}행`, source: first, reviewable: true });
      }
    });
  });
  return out;
}

/** Splits one long text at sentence ends into pieces the request accepts, keeping every character. */
function pieces(text: string): string[] {
  if (text.length <= LAW_REVIEW_SEGMENT_MAX_CHARS) return [text];
  const out: string[] = [];
  let current = "";
  for (const sentence of text.split(/(?<=[.다])\s+/u)) {
    for (let start = 0; start < sentence.length; start += LAW_REVIEW_SEGMENT_MAX_CHARS) {
      const part = sentence.slice(start, start + LAW_REVIEW_SEGMENT_MAX_CHARS);
      if (current && current.length + 1 + part.length > LAW_REVIEW_SEGMENT_MAX_CHARS) {
        out.push(current);
        current = part;
      } else current = current ? `${current} ${part}` : part;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Every place in the file the issue taxonomy's detection rules match, read clause by clause the way
 * the server splits text, and unit by unit for text outside any clause. Each candidate carries the
 * whole clause (heading, conditions and exceptions) as context, or for an oversized clause its head
 * and the matching units with their neighbors; a unit outside a clause carries its neighbors.
 */
export function scanCandidates(entries: readonly { parts: readonly string[] }[]): LocalCandidate[] {
  const texts: string[] = [];
  const unitOf: number[] = [];
  entries.forEach((entry, index) => entry.parts.forEach((part) => { texts.push(part); unitOf.push(index); }));
  const chars = entries.map((entry) => entry.parts.reduce((sum, part) => sum + part.length, 0));
  const near = (index: number) => [index - 1, index, index + 1].filter((at) => at >= 0 && at < entries.length);
  const out: LocalCandidate[] = [];
  const covered = new Set<string>();
  const add = (candidate: LocalCandidate) => {
    out.push(candidate);
    for (const unit of candidate.units) covered.add(`${candidate.issueHint}\0${unit}`);
  };
  for (const clause of splitClauses(texts)) {
    const sources = clause.sources ?? [];
    if (!sources.length) continue;
    const first = unitOf[sources[0].segment];
    const last = unitOf[Math.max(...sources.map((source) => source.segment))];
    let size = 0;
    for (let unit = first; unit <= last; unit += 1) size += chars[unit];
    for (const issue of issueSignals(clause.text)) {
      const fact = triggeringSentence(clause.text, issue.detect);
      const start = Math.max(0, clause.text.indexOf(fact));
      const anchors = segmentsOf(clause, start, start + fact.length).map((segment) => unitOf[segment]);
      const span = size <= CONTEXT_MAX_CHARS ? Array.from({ length: last - first + 1 }, (_, offset) => first + offset) : [first, ...anchors.flatMap(near)];
      // An unnumbered sentence reads with its neighbors: the condition or exception may sit next to it.
      const context = clause.number ? span : [...span, ...near(first), ...near(last)];
      add({ units: [...new Set(context)].sort((left, right) => left - right), anchor: anchors[0], issueHint: issue.id, severityHint: issue.severity,
        factKey: fact.replace(/\s+/gu, "") });
    }
  }
  // Text the clause split does not keep (e.g. a preamble before the first article) is still scanned.
  entries.forEach((entry, index) => {
    const text = entry.parts.join(" ");
    for (const issue of issueSignals(text)) {
      if (covered.has(`${issue.id}\0${index}`)) continue;
      add({ units: near(index), anchor: index, issueHint: issue.id, severityHint: issue.severity, factKey: triggeringSentence(text, issue.detect).replace(/\s+/gu, "") });
    }
  });
  return out;
}

/** Front, back, then the middles of the halves: any prefix of the result is spread across the list. */
function spread<T>(items: readonly T[]): T[] {
  if (items.length <= 2) return [...items];
  const order = [items[0], items.at(-1)!];
  const ranges: Array<[number, number]> = [[0, items.length - 1]];
  for (let next = ranges.shift(); next; next = ranges.shift()) {
    const [low, high] = next;
    if (high - low < 2) continue;
    const middle = (low + high) >> 1;
    order.push(items[middle]);
    ranges.push([low, middle], [middle, high]);
  }
  return order;
}

/**
 * Selection order: one candidate per issue per round, issues by severity, so no issue's repeats
 * can crowd out another issue. Within an issue, each distinct sentence comes before any repeat,
 * and a repeated sentence keeps at most front/back/middle representatives.
 */
function selectionOrder(candidates: readonly LocalCandidate[]): { order: LocalCandidate[]; repeated: number } {
  const byIssue = new Map<string, Map<string, LocalCandidate[]>>();
  for (const candidate of candidates) {
    const facts = byIssue.get(candidate.issueHint) ?? new Map<string, LocalCandidate[]>();
    byIssue.set(candidate.issueHint, facts);
    facts.set(candidate.factKey, [...(facts.get(candidate.factKey) ?? []), candidate]);
  }
  let kept = 0;
  const queues = [...byIssue.values()].map((facts) => {
    const representatives = [...facts.values()]
      .map((list) => spread([...list].sort((left, right) => left.anchor - right.anchor)).slice(0, REPRESENTATIVES))
      .sort((left, right) => left[0].anchor - right[0].anchor);
    const queue: LocalCandidate[] = [];
    for (let rank = 0; rank < REPRESENTATIVES; rank += 1) for (const list of spread(representatives)) if (list[rank]) queue.push(list[rank]);
    kept += queue.length;
    return { queue, severity: Math.min(...queue.map((candidate) => SEVERITY_RANK[candidate.severityHint])), first: queue[0].anchor };
  }).sort((left, right) => left.severity - right.severity || left.first - right.first);
  const order: LocalCandidate[] = [];
  for (let round = 0; queues.some((entry) => round < entry.queue.length); round += 1) {
    for (const entry of queues) if (round < entry.queue.length) order.push(entry.queue[round]);
  }
  return { order, repeated: candidates.length - kept };
}

/**
 * Contiguous, sentence-bounded windows from each of 20 bands, within the given budget. The last
 * window starts at the end; neither a long preamble nor a long appendix can hide the other.
 * Units already selected cost nothing and are passed over.
 */
function distribute(reviewable: readonly Reviewable[], selected: Set<number>, chars: number, segments: number): void {
  const bandChars = chars / DISTRIBUTED_BANDS;
  // Keep location representatives in every band; punctuation/spacing changes do not
  // let the same boilerplate consume the whole fallback. Numbers and their signs remain significant.
  const factKey = (entry: Reviewable) => entry.text.normalize("NFKC").replace(/\s+/gu, "").replace(/[.!?。]+$/u, "");
  const repeats = new Map<string, number>();
  for (const index of selected) {
    const key = `${Math.floor(index * DISTRIBUTED_BANDS / reviewable.length)}:${factKey(reviewable[index])}`;
    repeats.set(key, (repeats.get(key) ?? 0) + 1);
  }
  const bandSegments = segments / DISTRIBUTED_BANDS;
  const fill = (band: number, limitChars: number, limitSegments: number) => {
    const from = Math.floor(band * reviewable.length / DISTRIBUTED_BANDS);
    const to = Math.floor((band + 1) * reviewable.length / DISTRIBUTED_BANDS);
    const last = band === DISTRIBUTED_BANDS - 1;
    let used = 0;
    let count = 0;
    for (let index = last ? to - 1 : from; last ? index >= from : index < to; index += last ? -1 : 1) {
      if (selected.has(index)) continue;
      const entry = reviewable[index];
      const key = `${band}:${factKey(entry)}`;
      if ((repeats.get(key) ?? 0) >= REPRESENTATIVES) continue;
      // A large unit must not hide smaller units behind it. Never split a unit to fill a band.
      if (used + entry.chars > limitChars || count + entry.parts.length > limitSegments) continue;
      selected.add(index);
      repeats.set(key, (repeats.get(key) ?? 0) + 1);
      used += entry.chars;
      count += entry.parts.length;
    }
    chars -= used;
    segments -= count;
  };
  for (let band = 0; band < DISTRIBUTED_BANDS; band += 1) fill(band, Math.min(chars, bandChars), Math.min(segments, bandSegments));
  // Generic density only spends a quarter of the unused quota, after every band
  // had a turn. It is a text selector, never an issue or a server-side hint.
  const density = /의무|금지|제한|변경|책임|배상|해지|갱신|개인정보|통지|승인|동의/gu;
  const densityChars = chars * 0.25;
  const densitySegments = segments * 0.25;
  let denseChars = 0;
  let denseSegments = 0;
  const remaining = spread(Array.from({ length: DISTRIBUTED_BANDS }, (_, index) => index)).flatMap((band) => {
    const from = Math.floor(band * reviewable.length / DISTRIBUTED_BANDS);
    const to = Math.floor((band + 1) * reviewable.length / DISTRIBUTED_BANDS);
    return Array.from({ length: to - from }, (_, offset) => from + offset)
      .filter((index) => !selected.has(index))
      .sort((a, b) => (reviewable[b].text.match(density)?.length ?? 0) - (reviewable[a].text.match(density)?.length ?? 0))
      .slice(0, 1);
  });
  for (const index of remaining) {
    const entry = reviewable[index];
    const band = Math.min(DISTRIBUTED_BANDS - 1, Math.floor(index * DISTRIBUTED_BANDS / reviewable.length));
    const key = `${band}:${factKey(entry)}`;
    if (!entry.text.match(density) || (repeats.get(key) ?? 0) >= REPRESENTATIVES
      || denseChars + entry.chars > densityChars || denseSegments + entry.parts.length > densitySegments) continue;
    selected.add(index);
    repeats.set(key, (repeats.get(key) ?? 0) + 1);
    denseChars += entry.chars;
    denseSegments += entry.parts.length;
  }
  chars -= denseChars;
  segments -= denseSegments;
  // Reuse unspent shares only after every band, including the tail, had its reserved turn.
  for (const band of spread(Array.from({ length: DISTRIBUTED_BANDS }, (_, index) => index))) fill(band, chars, segments);
}

const READ_LIMITS: Record<string, string> = {
  DOCX_HEADER_FOOTER_OMITTED: "머리글·바닥글 일부를 읽지 못했습니다.",
  XLSX_HIDDEN_SHEET_OMITTED: "숨김 시트는 검토하지 않았습니다.",
  PPTX_SPEAKER_NOTES_OMITTED: "발표자 노트는 검토하지 않았습니다.",
};

export function reviewFileFor(document: NormalizedDocument, fileName: string, options: ReviewFileOptions = {}): ReviewFile {
  const all = units(document);
  const reviewable: Reviewable[] = all.map((entry, index) => {
    const parts = entry.reviewable ? pieces(entry.text) : [];
    return { ...entry, index, parts, chars: parts.reduce((sum, part) => sum + part.length, 0) };
  }).filter((entry) => entry.reviewable);
  const unitWord = UNIT[document.kind];
  const found = scanCandidates(reviewable);
  const candidates = options.candidates ? options.candidates(found) : found;
  const selected = new Set<number>();
  const totalChars = reviewable.reduce((sum, entry) => sum + entry.chars, 0);
  const totalParts = reviewable.reduce((sum, entry) => sum + entry.parts.length, 0);
  const whole = totalChars <= LAW_REVIEW_FILE_MAX_CHARS && totalParts <= LAW_REVIEW_FILE_MAX_SEGMENTS;
  const strategy: ReviewScan["strategy"] = whole ? "whole" : options.selection ?? "candidate";
  const { order, repeated } = selectionOrder(candidates);
  // Verbatim opening fragment, not an inferred profile. It consumes the same request budget.
  const classificationContext = whole ? undefined : reviewable[0]?.text.slice(0, LAW_REVIEW_SEGMENT_MAX_CHARS);
  const charBudget = LAW_REVIEW_FILE_MAX_CHARS - (classificationContext?.length ?? 0);
  const segmentBudget = LAW_REVIEW_FILE_MAX_SEGMENTS - (classificationContext ? 1 : 0);
  if (whole) {
    for (let index = 0; index < reviewable.length; index += 1) selected.add(index);
  } else if (strategy === "distributed") {
    distribute(reviewable, selected, charBudget, segmentBudget);
  } else {
    let chars = 0;
    let count = 0;
    for (const candidate of order) {
      const added = candidate.units.filter((unit) => !selected.has(unit));
      const size = added.reduce((sum, unit) => sum + reviewable[unit].chars, 0);
      const parts = added.reduce((sum, unit) => sum + reviewable[unit].parts.length, 0);
      if (chars + size > charBudget * CANDIDATE_SHARE || count + parts > segmentBudget * CANDIDATE_SHARE) continue;
      for (const unit of added) selected.add(unit);
      chars += size;
      count += parts;
    }
    // Fallback: zero or few candidates never mean "nothing to see"; the rest of the budget samples the whole file.
    distribute(reviewable, selected, charBudget - chars, segmentBudget - count);
  }
  const sentCandidates = candidates.filter((candidate) => candidate.units.every((unit) => selected.has(unit)));
  const positions = Array.from({ length: 10 }, () => 0);
  for (const candidate of sentCandidates) positions[Math.min(9, Math.floor(candidate.anchor * 10 / Math.max(1, reviewable.length)))] += 1;
  const scan: ReviewScan = { strategy, scanned: reviewable.length, candidates: candidates.length, sent: sentCandidates.length, repeated, positions };

  const segments: ReviewDocument["segments"] = [];
  const sources: SourceRef[] = [];
  const reviewedParts = new Map<string, number>();
  const allParts = new Map<string, number>();
  let batch = -1;
  let previous = -2;
  // Consecutive selected units (not merely consecutive reviewable rows)
  // belong to the same source range. A skipped row or selection gap starts a new range.
  for (let index = 0; index < reviewable.length; index += 1) {
    const entry = reviewable[index];
    allParts.set(entry.unit, (allParts.get(entry.unit) ?? 0) + entry.parts.length);
    if (!selected.has(index)) continue;
    if (entry.index !== previous + 1) batch += 1;
    previous = entry.index;
    reviewedParts.set(entry.unit, (reviewedParts.get(entry.unit) ?? 0) + entry.parts.length);
    for (const part of entry.parts) {
      segments.push({ text: part, location: clip(entry.location), batch });
      sources.push(entry.source);
    }
  }
  const reviewed = new Set([...allParts].filter(([unit, count]) => reviewedParts.get(unit) === count).map(([unit]) => unit));
  const leftOver = new Set([...allParts.keys()].filter((unit) => !reviewed.has(unit)));
  const unitIds = new Set(all.map((entry) => entry.unit));
  const pages = document.kind === "pdf" ? Math.max(document.metadata.pageCount ?? 0, ...[...unitIds].map((unit) => Number(unit.slice(1)))) : 0;
  const textless = document.kind === "pdf" ? pages - unitIds.size : 0;
  const excluded = [...unitIds].filter((unit) => !reviewed.has(unit) && !leftOver.has(unit)).length;
  const total = unitIds.size + textless;
  const formatted = (value: number) => value.toLocaleString("ko-KR");
  const reasons: string[] = [];
  if (leftOver.size) {
    reasons.push(strategy === "candidate"
      ? `처리 한도(${formatted(LAW_REVIEW_FILE_MAX_CHARS)}자)로 전체 ${unitWord}에서 찾은 검토 후보와 고르게 선택한 범위만 상세 검토했으며 ${formatted(leftOver.size)}개 ${unitWord}의 전부 또는 일부는 상세 검토하지 않았습니다.`
      : `처리 한도(${formatted(LAW_REVIEW_FILE_MAX_CHARS)}자)로 분산 검토했으며 ${formatted(leftOver.size)}개 ${unitWord}의 전부 또는 일부는 검토하지 않았습니다.`);
    if (strategy === "candidate" && candidates.length === 0) reasons.push("검토 후보 조항을 찾지 못해 문서 전체에서 고르게 선택한 범위를 상세 검토했습니다. 위험 항목이 없다는 뜻은 아닙니다.");
    if (strategy === "candidate" && repeated > 0 && sentCandidates.length < candidates.length) reasons.push("같은 내용이 반복된 조항은 대표 위치만 상세 검토했습니다.");
  }
  if (textless > 0) reasons.push(`글자를 추출하지 못한 ${formatted(textless)}개 페이지는 검토하지 않았습니다. 스캔하거나 이미지로 된 페이지일 수 있습니다.`);
  for (const warning of document.warnings) if (READ_LIMITS[warning]) reasons.push(READ_LIMITS[warning]);

  const words = segments.reduce((sum, segment) => sum + segment.text.trim().length, 0);
  const tooLittle = words < LAW_RESEARCH_DOCUMENT_MIN_CHARS;
  const coverage: ReviewCoverage = {
    status: tooLittle ? "excluded" : leftOver.size || textless > 0 || reasons.length ? "partial" : "complete",
    unit: unitWord,
    total,
    reviewed: reviewed.size,
    excluded,
    unreviewed: total - reviewed.size - excluded,
    reasons,
    ...(tooLittle ? {
      note: document.kind === "xlsx" || document.kind === "csv"
        ? "현재 문서에서 법령 문서 검토에 필요한 계약·규정 성격의 문장을 찾지 못했습니다. 숫자·코드 위주의 데이터는 조항으로 검토하지 않습니다."
        : document.kind === "pdf" && textless > 0
          ? "검토할 수 있는 텍스트를 충분히 확인하지 못했습니다. 스캔하거나 이미지로 된 PDF의 글자는 읽지 않습니다."
          : "검토할 수 있는 텍스트를 충분히 확인하지 못했습니다.",
    } : {}),
  };
  const version = document.version ?? document.blocks[0]?.source.documentVersion;
  return {
    fileId: document.fileId,
    document: reviewRequestFor({ name: fileName.slice(0, 255), kind: document.kind, id: document.id, ...(version ? { version } : {}), ...(classificationContext ? { classificationContext } : {}), segments }).document,
    sources,
    coverage,
    scan,
    imagesUnread: (document.media?.length ?? 0) > 0 || document.warnings.some((warning) => warning.endsWith("_IMAGE_OMITTED")),
  };
}

/**
 * The only way a file review reaches the network: a fresh object holding exactly the fields the
 * API accepts. Selector state (hints, scores, SourceRefs) cannot ride along, whatever is added to
 * `ReviewFile` or to the objects passed in.
 */
export function reviewRequestFor(document: ReviewDocument): Extract<LawResearchRequest, { document: ReviewDocument }> {
  return {
    task: "document_review",
    document: {
      name: document.name,
      kind: document.kind,
      id: document.id,
      ...(document.version ? { version: document.version } : {}),
      ...(document.classificationContext ? { classificationContext: document.classificationContext } : {}),
      segments: document.segments.map(({ text, location, batch }) => ({ text, location, ...(batch === undefined ? {} : { batch }) })),
    },
  };
}
