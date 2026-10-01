import type { NormalizedDocument, SourceRef, TableCell } from "@/domain/document";
import { classifyDocument } from "@/lib/contract-review";
import {
  LAW_RESEARCH_DOCUMENT_MIN_CHARS, LAW_REVIEW_FILE_MAX_CHARS, LAW_REVIEW_FILE_MAX_SEGMENTS, LAW_REVIEW_LOCATION_MAX_CHARS,
  LAW_REVIEW_SEGMENT_MAX_CHARS, type ReviewDocument,
} from "@/lib/law-research";

/**
 * Builds a bounded, distributed review request from a parsed workspace file. SourceRefs
 * stay in the worker/UI; gaps between selected ranges are explicit batch boundaries.
 */

/** complete: every reviewable part was sent. partial: some was not (limits, textless pages, omitted parts). excluded: nothing to review. */
export type ReviewCoverageStatus = "complete" | "partial" | "excluded";

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

export interface ReviewFile {
  fileId: string;
  document: ReviewDocument;
  /** Canonical source of each segment, in the same order as `document.segments`; never sent. */
  sources: SourceRef[];
  coverage: ReviewCoverage;
  /** The file places images whose text 문서 검토 does not read. */
  imagesUnread: boolean;
}

interface Candidate {
  unit: string;
  text: string;
  location: string;
  source: SourceRef;
  /** False for sheet rows that hold no sentence (numbers, codes, names). */
  reviewable: boolean;
}

const UNIT: Record<NormalizedDocument["kind"], string> = { pdf: "페이지", pptx: "슬라이드", docx: "문단", xlsx: "행", csv: "행" };
const CLAUSE_HEAD = /^(제\s*\d+\s*조(?:의\s*\d+)?)\s*(?:\(([^)]{1,30})\))?/u;
/** A cell that reads as a clause sentence, not a value: words, and a predicate or a sentence end. */
const PREDICATE = /(?:[.다요함음]\s*$)|(?:한다|된다|있다|없다|하여야|해야|할\s*수|하지|않는다|따른다|으로\s*한다)/u;

const LEGAL_CONTEXT = /계약|약관|규정|조건|특약|조항|인사|복무|근무|임대차|용역|위약|해지/u;
const SHORT_TERM = /자동\s*(?:갱신|연장)|위약금|위약벌|중도\s*해지|해지\s*통지|전속\s*관할|원상\s*복구|청약\s*철회|환불|연차\s*휴가/u;
const DISTRIBUTED_BANDS = 20;

function shortLegalRow(cells: TableCell[], context: string): boolean {
  if (!LEGAL_CONTEXT.test(context) || cells.length < 2 || !cells.some((cell) => SHORT_TERM.test(cell.display))) return false;
  return cells.some((cell) => cell.display.trim() && !SHORT_TERM.test(cell.display));
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

function candidates(document: NormalizedDocument): Candidate[] {
  const out: Candidate[] = [];
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

const READ_LIMITS: Record<string, string> = {
  DOCX_HEADER_FOOTER_OMITTED: "머리글·바닥글 일부를 읽지 못했습니다.",
  XLSX_HIDDEN_SHEET_OMITTED: "숨김 시트는 검토하지 않았습니다.",
  PPTX_SPEAKER_NOTES_OMITTED: "발표자 노트는 검토하지 않았습니다.",
};

export function reviewFileFor(document: NormalizedDocument, fileName: string): ReviewFile {
  const all = candidates(document);
  // Classify every parsed text unit once; bounded review windows reuse this
  // profile even when a defining clause lies outside the selected ranges.
  const profile = classifyDocument(all.map((entry) => entry.text).join("\n"));
  const reviewable = all.map((entry, index) => ({ ...entry, index, parts: entry.reviewable ? pieces(entry.text) : [] }))
    .filter((entry) => entry.reviewable);
  const unitWord = UNIT[document.kind];
  const segments: ReviewDocument["segments"] = [];
  const sources: SourceRef[] = [];
  const selected = new Set<number>();
  const totalChars = reviewable.reduce((sum, entry) => sum + entry.parts.reduce((count, part) => count + part.length, 0), 0);
  const totalParts = reviewable.reduce((sum, entry) => sum + entry.parts.length, 0);
  if (totalChars <= LAW_REVIEW_FILE_MAX_CHARS && totalParts <= LAW_REVIEW_FILE_MAX_SEGMENTS) {
    for (let index = 0; index < reviewable.length; index += 1) selected.add(index);
  } else {
    // Each band gets a contiguous, sentence-bounded window. The last window starts
    // at the end; neither a long preamble nor a long appendix can hide the other.
    for (let band = 0; band < DISTRIBUTED_BANDS; band += 1) {
      const from = Math.floor(band * reviewable.length / DISTRIBUTED_BANDS);
      const to = Math.floor((band + 1) * reviewable.length / DISTRIBUTED_BANDS);
      let chars = 0;
      let count = 0;
      for (let index = band === DISTRIBUTED_BANDS - 1 ? to - 1 : from;
        band === DISTRIBUTED_BANDS - 1 ? index >= from : index < to;
        index += band === DISTRIBUTED_BANDS - 1 ? -1 : 1) {
        const entry = reviewable[index];
        const length = entry.parts.reduce((sum, part) => sum + part.length, 0);
        if (chars + length > LAW_REVIEW_FILE_MAX_CHARS / DISTRIBUTED_BANDS
          || count + entry.parts.length > LAW_REVIEW_FILE_MAX_SEGMENTS / DISTRIBUTED_BANDS) break;
        selected.add(index);
        chars += length;
        count += entry.parts.length;
      }
    }
  }
  const reviewedParts = new Map<string, number>();
  const allParts = new Map<string, number>();
  let batch = -1;
  let previous = -2;
  // Consecutive selected candidates (not merely consecutive reviewable rows)
  // belong to the same source range. A skipped row or sample gap starts a new range.
  for (let index = 0; index < reviewable.length; index += 1) {
    const entry = reviewable[index];
    allParts.set(entry.unit, (allParts.get(entry.unit) ?? 0) + 1);
    if (!selected.has(index)) continue;
    if (entry.index !== previous + 1) batch += 1;
    previous = entry.index;
    reviewedParts.set(entry.unit, (reviewedParts.get(entry.unit) ?? 0) + 1);
    for (const part of entry.parts) {
      segments.push({ text: part, location: clip(entry.location), batch });
      sources.push(entry.source);
    }
  }
  const reviewed = new Set([...allParts].filter(([unit, count]) => reviewedParts.get(unit) === count).map(([unit]) => unit));
  const leftOver = new Set([...allParts.keys()].filter((unit) => !reviewed.has(unit)));
  const units = new Set(all.map((entry) => entry.unit));
  const pages = document.kind === "pdf" ? Math.max(document.metadata.pageCount ?? 0, ...[...units].map((unit) => Number(unit.slice(1)))) : 0;
  const textless = document.kind === "pdf" ? pages - units.size : 0;
  const excluded = [...units].filter((unit) => !reviewed.has(unit) && !leftOver.has(unit)).length;
  const total = units.size + textless;
  const reasons: string[] = [];
  if (leftOver.size) reasons.push(`처리 한도(${LAW_REVIEW_FILE_MAX_CHARS.toLocaleString("ko-KR")}자)로 분산 검토했으며 ${leftOver.size.toLocaleString("ko-KR")}개 ${unitWord}의 전부 또는 일부는 검토하지 않았습니다.`);
  if (textless > 0) reasons.push(`글자를 추출하지 못한 ${textless.toLocaleString("ko-KR")}개 페이지는 검토하지 않았습니다. 스캔하거나 이미지로 된 페이지일 수 있습니다.`);
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
    document: { name: fileName.slice(0, 255), kind: document.kind, id: document.id, ...(version ? { version } : {}), profile, segments },
    sources,
    coverage,
    imagesUnread: (document.media?.length ?? 0) > 0 || document.warnings.some((warning) => warning.endsWith("_IMAGE_OMITTED")),
  };
}
