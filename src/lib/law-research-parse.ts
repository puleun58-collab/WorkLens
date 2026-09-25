import { analysisMarkers, splitAnalysisText, type AnalysisSection } from "@/lib/law-analysis-parse";

/**
 * `legal_research` chains all emit `═══ title ═══` + `▶ section` blocks. Sections
 * are kept in order and verbatim; a section is only flagged, never dropped or
 * rewritten, when the MCP itself marked it failed or cut by the time limit.
 *
 * On top of that, each section gets a display `kind` recognised from its
 * content (the heading alone is not trusted): statute search hits, a law's
 * table of contents, decision search lists, detail dumps and 별표/서식 lists.
 * Anything not recognised stays `other` and is shown as before.
 */
export type ResearchSectionKind = "law_articles" | "law_toc" | "decision_search" | "annex" | "detail" | "other";

export interface ResearchArticle {
  law: string;
  jo: string;
  title?: string;
  /** Upstream search preview, verbatim; a trailing `...` means the upstream shortened it. */
  excerpt: string;
  effective?: string;
  ministry?: string;
}

export interface ResearchDecision {
  id: string;
  title?: string;
  caseNumber?: string;
  body?: string;
  date?: string;
}

export interface ResearchAnnexItem {
  title: string;
  law?: string;
}

export interface ResearchSection extends AnalysisSection {
  /** MCP marked this section `[NOT_FOUND / FAILED]`, `[FAILED]` or `⏱` time-limited — not the same as "no results". */
  unavailable: boolean;
  markers: string[];
  kind: ResearchSectionKind;
  articles?: ResearchArticle[];
  /** `총 N개 조문` as the MCP stated it. */
  toc?: { law?: string; count: number };
  /** `total` is the upstream search total; `entries` are only the hits this response contains. */
  decisions?: { total?: number; entries: ResearchDecision[] };
  annex?: { total?: number; entries: ResearchAnnexItem[] };
}

export interface ResearchDocument {
  title?: string;
  sections: ResearchSection[];
  /** Data sources evidenced by the text; the MCP relays 법제처 data unless another source is named. */
  sources: string[];
}

const UNAVAILABLE_HEADING = /\[(?:NOT_FOUND \/ FAILED|FAILED)\]/u;
const SEARCH_TOTAL = /검색\s*결과\s*\(총\s*([\d,]+)\s*건/gu;
const TOC_HEAD = /^\s*목차\s*\(총\s*([\d,]+)\s*개\s*조문\)\s*$/u;
const ANNEX_HEAD = /별표\/서식\s*목록\s*\(총\s*([\d,]+)\s*건\)/u;
const AI_SEARCH_HEAD = /지능형\s*법령검색\s*결과/u;
const ARTICLE_LINE = /^\s+제0*(\d+)조(의\d+)?\s*\((.+)\)\s*$/u;
const EFFECTIVE_LINE = /^\s*시행:\s*([\d.]+)(?:\s*\|\s*(.+))?\s*$/u;
const DECISION_HEAD = /^\[(\d{1,32})\](?:\s+(.*))?$/u;
const DECISION_FIELD = /^\s{2,}([^:]+):\s*(.+?)\s*$/u;
const CASE_NUMBER_FIELDS = new Set(["사건번호", "해석례번호", "청구번호"]);
const BODY_FIELDS = new Set(["법원", "재결청", "해석기관"]);
const DATE_FIELDS = new Set(["선고일", "회신일자", "의결일", "의결일자", "종국일", "결정일"]);

const toNumber = (value: string) => Number(value.replaceAll(",", ""));

function blocks(lines: readonly string[]): string[][] {
  const result: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim()) current.push(line);
    else if (current.length) { result.push(current); current = []; }
  }
  if (current.length) result.push(current);
  return result;
}

/** Statute hits: `법령명` / `   제0076조의2 (제목)` / excerpt / `   시행: 날짜 | 소관부처`. */
function parseArticles(lines: readonly string[]): ResearchArticle[] {
  const articles: ResearchArticle[] = [];
  for (const block of blocks(lines)) {
    const head = ARTICLE_LINE.exec(block[1] ?? "");
    if (!head || /^\s/u.test(block[0])) continue;
    const jo = `제${head[1]}조${head[2] ?? ""}`;
    let body = block.slice(2);
    // The upstream repeats the article heading as the first excerpt line: `제76조의2(제목)`.
    if (body[0] && body[0].trim().replace(/\s+/gu, "").startsWith(`${jo}(`)) body = body.slice(1);
    const effective = body.length ? EFFECTIVE_LINE.exec(body.at(-1)!) : null;
    if (effective) body = body.slice(0, -1);
    articles.push({
      law: block[0].trim(),
      jo,
      title: head[3].trim(),
      excerpt: body.map((line) => line.trim()).join("\n"),
      ...(effective ? { effective: effective[1] } : {}),
      ...(effective?.[2] ? { ministry: effective[2].trim() } : {}),
    });
  }
  return articles;
}

function parseDecisions(lines: readonly string[]): ResearchDecision[] {
  const entries: ResearchDecision[] = [];
  let current: ResearchDecision | undefined;
  for (const line of lines) {
    const head = DECISION_HEAD.exec(line.trim());
    if (head && !/^\s/u.test(line)) {
      current = { id: head[1], ...(head[2]?.trim() ? { title: head[2].trim() } : {}) };
      entries.push(current);
      continue;
    }
    if (!line.trim()) { current = undefined; continue; }
    const field = current ? DECISION_FIELD.exec(line) : null;
    if (!current || !field || field[2] === "N/A") continue;
    if (CASE_NUMBER_FIELDS.has(field[1])) current.caseNumber ??= field[2];
    else if (BODY_FIELDS.has(field[1])) current.body ??= field[2];
    else if (DATE_FIELDS.has(field[1])) current.date ??= field[2];
  }
  return entries;
}

function parseAnnex(lines: readonly string[]): ResearchAnnexItem[] {
  const items: ResearchAnnexItem[] = [];
  for (const line of lines) {
    const item = /^\s*\d+\.\s*(?:\[[^\]]+\]\s*)?(.+?)\s*$/u.exec(line);
    if (item && /^\s*\d+\./u.test(line)) { items.push({ title: item[1] }); continue; }
    const law = /^\s+관련법령:\s*(.+?)\s*$/u.exec(line);
    if (law && items.length) items.at(-1)!.law = law[1];
  }
  return items;
}

function classify(section: AnalysisSection): Pick<ResearchSection, "kind" | "articles" | "toc" | "decisions" | "annex"> {
  const heading = (section.heading ?? "").replace(/\[[^\]]*\]/gu, "").trim();
  const text = section.lines.join("\n");
  if (/상세$/u.test(heading) || /^\s*자동\s*상세조회:/mu.test(text)) return { kind: "detail" };
  const toc = section.lines.map((line) => TOC_HEAD.exec(line)).find(Boolean);
  if (toc) {
    const law = /^\s*(?:법령명|자치법규명):\s*(.+?)\s*$/mu.exec(text)?.[1];
    return { kind: "law_toc", toc: { count: toNumber(toc[1]), ...(law ? { law } : {}) } };
  }
  const annexHead = ANNEX_HEAD.exec(text);
  if (annexHead) {
    const entries = parseAnnex(section.lines);
    if (entries.length) return { kind: "annex", annex: { total: toNumber(annexHead[1]), entries } };
  }
  // One search list per section; several (e.g. one per contract risk) keep their own grouping as `other`.
  const totals = [...text.matchAll(SEARCH_TOTAL)];
  if (totals.length === 1) {
    const entries = parseDecisions(section.lines);
    if (entries.length) return { kind: "decision_search", decisions: { total: toNumber(totals[0][1]), entries } };
  }
  const articles = parseArticles(section.lines);
  if (articles.length && (AI_SEARCH_HEAD.test(text) || articles.every((article) => article.effective))) {
    return { kind: "law_articles", articles };
  }
  return { kind: "other" };
}

export function researchResult(text: string): ResearchDocument {
  const document = splitAnalysisText(text);
  const sections = document.sections.map((section): ResearchSection => {
    const all = [section.heading ?? "", ...section.lines];
    const unavailable = UNAVAILABLE_HEADING.test(section.heading ?? "") || section.lines.some((line) => line.trim().startsWith("⏱"));
    return {
      ...section,
      unavailable,
      markers: [...new Set(all.flatMap(analysisMarkers))],
      ...(unavailable ? { kind: "other" as const } : classify(section)),
    };
  });
  const sources = ["법제처 국가법령정보센터 OPEN API"];
  if (/국세법령정보|국세청\s*(?:법령)?해석/u.test(text)) sources.push("국세법령정보시스템");
  return { title: document.title, sections, sources };
}

/** Large reference material: shown collapsed under "상세 근거", after the primary results. */
export function isSupportingSection(section: ResearchSection): boolean {
  return section.kind === "law_toc" || section.kind === "detail";
}
