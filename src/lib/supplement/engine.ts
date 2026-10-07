import type { NormalizedDocument, SourceRef, TableBlock } from "@/domain/document";
import {
  type SupplementCandidate,
  type SupplementFileRole,
  type SupplementCheck,
  type SupplementCoverage,
  type SupplementDocType,
  type SupplementDraft,
  type SupplementFileSummary,
  type SupplementNecessity,
  type SupplementReviewBatch,
  type SupplementSeverity,
} from "@/domain/supplement";
import { SUPPLEMENT_REVIEW_MAX_CHECKS } from "@/lib/ai/api";
import { MAX_EVIDENCE_CHARS, MAX_EVIDENCE_ITEMS } from "@/lib/ai/prompt";
import {
  ACTION_DONE,
  ACTION_HEADING,
  ACTION_WORD,
  ATTAINMENT_HEADER,
  EXPLANATION_FIELD,
  MONEY_LABEL,
  PERIOD_EXPR,
  TARGET_HEADER,
  UNIT_EXPR,
  BASELINE_CUE,
  BENEFIT_LIKE,
  CAUSE_CUE,
  clip,
  CONCLUSION_HEADING,
  CONCLUSION_MARKER,
  contentTokens,
  COST_LIKE,
  DOWN_WORD,
  familyOf,
  IMPACT_CUE,
  ISSUE_OCCURRENCE,
  ISSUE_RESOLVED,
  ISSUE_WORD,
  josa,
  JUDGEMENT,
  KPI_TERM,
  KPI_VALUE,
  normalize,
  OWNER_CUE,
  PERCENT,
  PERIOD_BASELINE,
  REASON_CUE,
  RESPONSE_CUE,
  SCHEDULE_CUE,
  tokensRelate,
  amountsInWon,
  differentParties,
  periodLabel,
  periodOf,
  periodsCompatible,
  sameAmount,
  type Period,
  UP_WORD,
} from "./text";
import { outlineWorkbook, type SheetTable } from "./workbook";
import type { SupplementDiagnostics } from "./diagnostics";
import { suppliesImplementationCheck, unresolvedImplementationChecks } from "./sufficiency";

/**
 * 보완 pipeline, deterministic part:
 *   structure → document type → candidates → document-wide rebuttal →
 *   grouping → review batches for the meaning-level re-check.
 * Nothing here invents a value; every message is built from the document's
 * own words plus fixed, hedged templates.
 */

const REVIEW_ITEMS_PER_CHECK = 5;
const REVIEW_ITEM_CHARS = 300;
const MAX_STATEMENTS_PER_FILE = 3_000;

// ── Structure ────────────────────────────────────────────────────────────

export interface Statement {
  index: number;
  fileId: string;
  text: string;
  tokens: string[];
  source: SourceRef;
  unit: number;
  unitLabel: string;
  unitTitle: string;
  heading: boolean;
  /** A worksheet table row; generic sentence checks do not apply to it. */
  tableRow?: boolean;
  /** A significant change read from a workbook change column. */
  change?: Change;
  /** Reporting period the line belongs to: its own, its section's, or its file's. */
  period?: Period;
  /** Evidence-only line (raw data, lookup, hidden sheet): never a gap source or cross-file rebuttal. */
  reference?: boolean;
}

interface FileOutline {
  document: NormalizedDocument;
  fileName: string;
  statements: Statement[];
  /** Searched as evidence only (raw data, lookup, hidden sheets …); never a gap source. */
  references: Statement[];
  tables: SheetTable[];
  coverage: SupplementCoverage;
}
const unitLabelOf = (kind: NormalizedDocument["kind"], unit: number): string => kind === "pptx" ? `${unit}P` : `${unit}페이지`;

function unitOf(source: SourceRef): number {
  const locator = source.locator;
  if (locator?.kind === "pptx") return locator.slide;
  if (locator?.kind === "pdf") return locator.page;
  return source.page ?? 0;
}

/** Letters and digits must dominate; replacement characters mean a broken text layer. */
function readable(text: string): boolean {
  const compact = text.replace(/\s+/gu, "");
  if (compact.length === 0 || compact.includes("\uFFFD")) return false;
  const letters = compact.match(/[가-힣A-Za-z0-9]/gu)?.length ?? 0;
  return letters / compact.length >= 0.55;
}

function tableRowTexts(table: TableBlock): Array<{ text: string; source: SourceRef }> {
  const [header, ...body] = table.rows;
  if (!header) return [];
  const headerTexts = header.map((cell) => normalize(cell.display));
  const rows = body.length > 0 && headerTexts.some(Boolean) ? body : table.rows;
  const labelled = rows !== table.rows;
  return rows.flatMap((row) => {
    const parts = row
      .map((cell, column) => {
        const value = normalize(cell.display);
        if (!value) return "";
        const label = labelled ? headerTexts[column] : "";
        return label && column > 0 ? `${label} ${value}` : value;
      })
      .filter(Boolean);
    if (parts.length === 0) return [];
    const first = row.find((cell) => normalize(cell.display)) ?? row[0];
    const text = parts.join(" · ");
    return [{ text, source: { ...first.source, quote: text } }];
  });
}

const SENTENCE_END = /([.。!?]|다|요|음|함|됨|임|:)$/u;

/** A title line in a document without heading styles: numbered or marked, short, not a sentence. */
const DOCX_TITLE = /^([0-9]{1,2}(\.[0-9]{1,2})*[.)]\s|[IVXⅠ-Ⅹ]+\.\s?|[가-하]\.\s|[■□▶●◆]\s?|제\s?\d+\s?[장절]\s?)/u;

/**
 * Word documents have no reliable page numbers, so the unit is the section:
 * a heading (style or numbered title) opens one, and every paragraph and
 * table row below it belongs to it. Locations name the section path and the
 * table number — never a page.
 */
function outlineDocx(document: NormalizedDocument, fileName: string): FileOutline {
  const statements: Statement[] = [];
  const path: Array<{ level: number; text: string }> = [];
  let unit = 0;
  let tableNumber = 0;
  let blockNumber = 0;
  const sectionLabel = () => path.map((entry) => entry.text).join(" > ");
  const unitsWithText = new Set<number>();
  for (const block of document.blocks) {
    if (block.source.locator?.kind === "docx" && block.source.locator.part !== "body") continue;
    blockNumber += 1;
    if (block.type === "paragraph") {
      const text = normalize(block.text);
      if (!text) continue;
      const heading = block.role === "heading" || (text.length <= 40 && DOCX_TITLE.test(text) && !/[.다]$/u.test(text));
      if (heading) {
        const level = block.headingLevel ?? (/^[0-9]+\.[0-9]/u.test(text) ? 2 : 1);
        while (path.length && path.at(-1)!.level >= level) path.pop();
        path.push({ level, text: clip(text.replace(DOCX_TITLE, "").trim() || text, 30) });
        unit += 1;
      }
      const label = sectionLabel() || `문단 ${blockNumber}`;
      statements.push({ index: statements.length, fileId: document.fileId, text, tokens: contentTokens(text), source: { ...block.source, quote: text }, unit, unitLabel: label, unitTitle: sectionLabel(), heading });
      unitsWithText.add(unit);
    } else {
      tableNumber += 1;
      const label = `${sectionLabel() ? `${sectionLabel()} · ` : ""}표 ${tableNumber}`;
      for (const row of tableRowTexts(block)) {
        statements.push({ index: statements.length, fileId: document.fileId, text: row.text, tokens: contentTokens(row.text), source: row.source, unit, unitLabel: label, unitTitle: sectionLabel() || `표 ${tableNumber}`, heading: false });
        unitsWithText.add(unit);
      }
    }
    if (statements.length >= MAX_STATEMENTS_PER_FILE) break;
  }
  const notes: string[] = [];
  let complete = true;
  if (document.warnings.includes("DOCX_CHART_OMITTED")) { complete = false; notes.push("차트 안의 값과 설명은 읽지 않았습니다."); }
  if (document.warnings.includes("DOCX_NESTED_TABLE_OMITTED")) { complete = false; notes.push("표 안에 들어 있는 표는 읽지 않았습니다."); }
  if (statements.length >= MAX_STATEMENTS_PER_FILE) { complete = false; notes.push(`분량이 많아 앞부분 ${MAX_STATEMENTS_PER_FILE.toLocaleString("ko-KR")}개 문장까지만 분석했습니다.`); }
  if (document.warnings.includes("DOCX_IMAGE_OMITTED")) notes.push("이미지 안의 글자는 읽지 않습니다.");
  if (document.warnings.includes("DOCX_HEADER_FOOTER_OMITTED")) notes.push("머리글·바닥글 일부는 읽지 못했습니다.");
  if (statements.length === 0) { complete = false; notes.push("읽을 수 있는 본문이 없습니다."); }
  return {
    document,
    fileName,
    statements,
    references: [],
    tables: [],
    coverage: { fileId: document.fileId, fileName, kind: "docx", unit: "섹션", total: unitsWithText.size, analyzed: unitsWithText.size, complete, notes },
  };
}

function outline(document: NormalizedDocument, fileName: string): FileOutline {
  if (document.kind === "xlsx") return { document, fileName, ...outlineWorkbook(document, fileName) };
  if (document.kind === "docx") return outlineDocx(document, fileName);
  const raw: Array<{ text: string; source: SourceRef; heading: boolean }> = [];
  for (const block of document.blocks) {
    if (block.type === "paragraph") {
      const text = normalize(block.text);
      if (!text) continue;
      const heading = block.role === "heading";
      // PDF lines break mid-sentence; join them back within one page.
      const previous = raw.at(-1);
      if (document.kind === "pdf" && previous && !heading && !previous.heading
        && unitOf(previous.source) === unitOf(block.source)
        && !SENTENCE_END.test(previous.text) && previous.text.length + text.length < 400) {
        previous.text = `${previous.text} ${text}`;
        previous.source = { ...previous.source, quote: previous.text };
        continue;
      }
      raw.push({ text, source: { ...block.source, quote: text }, heading });
    } else {
      for (const row of tableRowTexts(block)) raw.push({ ...row, heading: false });
    }
  }

  const total = document.metadata.pageCount ?? 0;
  const byUnit = new Map<number, typeof raw>();
  for (const entry of raw) {
    const unit = unitOf(entry.source);
    byUnit.set(unit, [...(byUnit.get(unit) ?? []), entry]);
  }
  const unitWord = document.kind === "pptx" ? "슬라이드" : "페이지";
  const unreadUnits: number[] = [];
  const statements: Statement[] = [];
  for (let unit = 1; unit <= Math.max(total, ...byUnit.keys()); unit += 1) {
    const entries = byUnit.get(unit) ?? [];
    if (entries.length === 0 || !readable(entries.map((entry) => entry.text).join(" "))) {
      unreadUnits.push(unit);
      continue;
    }
    const unitTitle = entries.find((entry) => entry.heading)?.text ?? "";
    for (const entry of entries) {
      if (statements.length >= MAX_STATEMENTS_PER_FILE) break;
      statements.push({
        index: statements.length,
        fileId: document.fileId,
        text: entry.text,
        tokens: contentTokens(entry.text),
        source: entry.source,
        unit,
        unitLabel: unitLabelOf(document.kind, unit),
        unitTitle,
        heading: entry.heading,
      });
    }
  }

  const notes: string[] = [];
  let complete = true;
  if (unreadUnits.length > 0) {
    complete = false;
    const listed = unreadUnits.slice(0, 8).map((unit) => unitLabelOf(document.kind, unit)).join(", ");
    notes.push(`읽을 수 있는 텍스트가 없어 분석하지 못한 ${unitWord}: ${listed}${unreadUnits.length > 8 ? ` 외 ${unreadUnits.length - 8}곳` : ""} (${document.kind === "pdf" ? "스캔 이미지 등" : "이미지·도형만 있는 경우 등"})`);
  }
  if (statements.length >= MAX_STATEMENTS_PER_FILE) {
    complete = false;
    notes.push(`분량이 많아 앞부분 ${MAX_STATEMENTS_PER_FILE.toLocaleString("ko-KR")}개 문장까지만 분석했습니다.`);
  }
  if (document.warnings.includes("PPTX_CHART_OMITTED")) {
    complete = false;
    notes.push("차트 안의 값과 설명은 읽지 않았습니다.");
  }
  // Supplement reads no image text, so the note applies to any picture actually on a slide, and only then.
  if (document.kind === "pptx" && ((document.media?.length ?? 0) > 0 || document.warnings.includes("PPTX_IMAGE_OMITTED"))) notes.push("이미지 안의 글자는 읽지 않습니다.");
  const readUnits = new Set(statements.map((statement) => statement.unit)).size;
  return {
    document,
    fileName,
    statements,
    references: [],
    tables: [],
    coverage: {
      fileId: document.fileId,
      fileName,
      kind: document.kind,
      unit: unitWord,
      total: Math.max(total, readUnits + unreadUnits.length),
      analyzed: readUnits,
      complete,
      notes,
    },
  };
}

// ── Document type and necessity ──────────────────────────────────────────

const TYPE_KEYWORDS: Record<Exclude<SupplementDocType, "general">, RegExp> = {
  performance: /(실적|매출|판매|달성|영업이익|영업\s?(보고|현황|실적)|성과|KPI|수주)/giu,
  cost: /(비용|원가|예산|지출|경비|물류비|운송비|인건비|집행)/giu,
  project: /(프로젝트|진행률|진척|마일스톤|착수|구축|WBS|오픈\s?일정)/giu,
  operation: /(운영\s?(현황|보고|실적)|가동|처리량|서비스\s?수준|SLA)/giu,
  issue: /(이슈|장애|사고|불량|클레임|민원|결함|재발)/giu,
  improvement: /(개선안|개선\s?방안|개선\s?과제|개선\s?제안|As-Is|To-Be|기대\s?효과)/giu,
  plan: /(추진\s?계획|실행\s?계획|로드맵|추진\s?일정|사업\s?계획|계획서)/giu,
  management: /(경영\s?(보고|현황|회의)|이사회|경영진)/giu,
};

function classify(fileName: string, statements: readonly Statement[]): SupplementDocType {
  const first = statements[0];
  const primaryTitle = first && !first.tableRow && first.text.length <= 90 && !SENTENCE_END.test(first.text)
    ? first.text : statements.find((statement) => statement.heading)?.text ?? fileName.replace(/\.[^.]+$/u, "");
  // A budget subsection is supporting information, not the document's purpose.
  if (/개선.*(검토안|계획|방안|제안|과제)/u.test(primaryTitle) && !/(비용|원가|예산|지출)/u.test(primaryTitle)) return "improvement";
  if (/(추진|실행|사업)\s?계획|로드맵/u.test(primaryTitle) && !/(비용|원가|예산|지출)/u.test(primaryTitle)) return "plan";
  const titles = [fileName.replace(/\.[^.]+$/u, ""), ...new Set(statements.filter((statement) => statement.heading).map((statement) => statement.text))].join(" ");
  const body = statements.map((statement) => statement.text).join(" ");
  // Cost words are open-ended (판관비, 외주비, 보관비 …): the metric family decides, as it does for linking.
  const costWords = (text: string) => contentTokens(text).filter((token) => familyOf(token)?.key === "cost").length;
  const scores = (Object.keys(TYPE_KEYWORDS) as Array<keyof typeof TYPE_KEYWORDS>).map((type) => {
    const title = Math.max(titles.match(TYPE_KEYWORDS[type])?.length ?? 0, type === "cost" ? costWords(titles) : 0);
    const text = Math.max(body.match(TYPE_KEYWORDS[type])?.length ?? 0, type === "cost" ? costWords(body) : 0);
    return { type, score: title * 3 + Math.min(text, 6) };
  }).sort((a, b) => b.score - a.score);
  const [best, second] = scores;
  // Low or contested evidence: treat as a general business document.
  if (best.score < 4 || best.score < second.score * 1.25) return "general";
  return best.type;
}

type NecessityRow = Record<SupplementDocType, SupplementNecessity>;
const row = (values: Partial<NecessityRow>, fallback: SupplementNecessity): NecessityRow => ({
  performance: fallback, cost: fallback, project: fallback, operation: fallback, issue: fallback,
  improvement: fallback, plan: fallback, management: fallback, general: fallback, ...values,
});

/** Which checks a document type needs; `conditional` requires a strong trigger in context. */
export const NECESSITY: Record<SupplementCheck, NecessityRow> = {
  baseline: row({ performance: "required", cost: "required", operation: "required", management: "required" }, "conditional"),
  cause: row({ performance: "required", cost: "required", operation: "required", management: "required", issue: "required" }, "conditional"),
  impact: row({ issue: "required", plan: "none" }, "conditional"),
  response: row({ issue: "required", project: "required", plan: "none" }, "conditional"),
  owner: row({ project: "required", issue: "required", improvement: "required", plan: "required" }, "conditional"),
  schedule: row({ project: "required", issue: "required", improvement: "required", plan: "required" }, "conditional"),
  scope: row({}, "conditional"),
  budget: row({}, "conditional"),
  conclusion: row({}, "conditional"),
  // Workbook-only: a report table needs its target, period and unit in KPI-centred reports; elsewhere only on a summary sheet.
  target: row({ performance: "required", cost: "required", operation: "required", management: "required" }, "conditional"),
  period: row({ performance: "required", cost: "required", operation: "required", management: "required" }, "conditional"),
  unit: row({ performance: "required", cost: "required", operation: "required", management: "required" }, "conditional"),
};

// ── Triggers ─────────────────────────────────────────────────────────────

export interface Change {
  subject: string;
  subjectTokens: string[];
  percent?: number;
  percentText?: string;
  direction: "up" | "down";
  adverse: boolean | undefined;
  baselinePhrase?: string;
}

const META = /^(증감률|증감율|증감|변동률|변동|비율|대비|전월|당월|전년|금년|전분기|당분기|분기|누계|실적|계획|목표|합계|구분|항목)$/u;

function subjectBefore(text: string, end: number): { subject: string; tokens: string[] } | undefined {
  const tokens = contentTokens(text.slice(0, end)).filter((token) => !META.test(token) && !/^\d/u.test(token));
  if (tokens.length === 0) return undefined;
  const metric = tokens.find((token) => familyOf(token) || COST_LIKE.test(token) || BENEFIT_LIKE.test(token) || KPI_TERM.test(token));
  const subject = metric ?? tokens.at(-1)!;
  return { subject, tokens: [subject] };
}

function detectChange(statement: Statement): Change | undefined {
  const text = statement.text;
  const percent = PERCENT.exec(text);
  const up = UP_WORD.test(text);
  const down = !up && DOWN_WORD.test(text);
  const signed = percent?.[1]?.trim();
  const direction = signed === "+" || signed === "▲" ? "up" : signed === "-" || signed === "−" || signed === "▼" || signed === "△" ? "down" : up ? "up" : down ? "down" : undefined;
  if (!direction) return undefined;
  if (!percent && !/(급증|급감|급등|급락|대폭)/u.test(text)) return undefined;
  // A share of a target is an attainment, not a change.
  if (percent && /(달성률|달성율|목표\s?대비|계획\s?대비|예산\s?대비)/u.test(text.slice(Math.max(0, percent.index - 12), percent.index))) return undefined;
  const subject = subjectBefore(text, percent?.index ?? text.search(/(급증|급감|급등|급락|대폭)/u));
  if (!subject) return undefined;
  const value = percent ? Number(percent[2].replace(",", ".")) : undefined;
  const costLike = COST_LIKE.test(subject.subject);
  const benefitLike = BENEFIT_LIKE.test(subject.subject);
  const adverse = /(악화|미달|초과)/u.test(text) ? true
    : costLike ? direction === "up"
      : benefitLike ? direction === "down"
        : undefined;
  return {
    subject: subject.subject,
    subjectTokens: subject.tokens,
    ...(value !== undefined ? { percent: value, percentText: `${percent![2]}${percent![3] === "퍼센트" ? "%" : percent![3]}` } : {}),
    direction,
    adverse,
    ...(PERIOD_BASELINE.exec(text)?.[0] ? { baselinePhrase: normalize(PERIOD_BASELINE.exec(text)![0]).replace(/보다$/u, "대비").replace(/(전년|전월|전분기|전기|전주)$/u, "$1 대비") } : {}),
  };
}

/**
 * How large a change is on the relative-% scale the thresholds use. A move in
 * percentage points is a move of a rate (원가율, 이익률), where 2%p is already
 * material, so it weighs five times its face value. Unknown size counts as large.
 */
function changeSize(change: Change): number {
  if (change.percent === undefined) return 100;
  return /(%p|포인트)$/u.test(change.percentText ?? "") ? change.percent * 5 : change.percent;
}

interface Issue { phrase: string; tokens: string[] }

function detectIssue(statement: Statement): Issue | undefined {
  if (statement.heading) return undefined;
  const text = statement.text;
  const match = ISSUE_WORD.exec(text);
  if (!match || !ISSUE_OCCURRENCE.test(text) || ISSUE_RESOLVED.test(text)) return undefined;
  // "원인: …", "영향: …" lines explain a problem already stated; they are not a new one.
  if (/^[\s•\-–·▶■□○●]*(원인|영향|배경|사유|대응|조치|대책|결과|비고|요인)\s?[:：]/u.test(text)) return undefined;
  // Lines under a 원인 / 영향 / 대응 section explain a problem the report already raised.
  if (/(원인|영향|배경|사유|대응|조치|대책|요인)[^>]*$/u.test(statement.unitTitle.split(" > ").at(-1) ?? "")) return undefined;
  // Hypothetical wording ("~ 시", "방지를 위해") is not an occurrence.
  if (/(방지|예방|대비하여|대비해|최소화|없도록)/u.test(text)) return undefined;
  // The problem as a short noun phrase: up to three words before it plus its count.
  const lead = text.slice(0, match.index).replace(/^[\s•\-–·▶■□○●]+/u, "").trim().split(/\s+/u).filter(Boolean).slice(-3);
  const count = /^\s?\d[\d,]*\s?(건|회|명|일|시간|개|%)/u.exec(text.slice(match.index + match[0].length))?.[0] ?? "";
  const phrase = clip([...lead, `${match[0]}${count}`].join(" "), 32);
  const tokens = contentTokens(text.split(/[,.·;]|\s-\s/u).find((part) => ISSUE_WORD.test(part)) ?? text);
  return phrase && tokens.length ? { phrase, tokens } : undefined;
}

function detectKpi(statement: Statement): { phrase: string; subject: string; tokens: string[] } | undefined {
  const text = statement.text;
  const term = KPI_TERM.exec(text);
  if (!term) return undefined;
  const value = KPI_VALUE.exec(text.slice(term.index));
  if (!value || text.length > 90 || BASELINE_CUE.test(text) || /(단축|절감|향상|개선|감축|증가|감소|상승|하락)/u.test(text) || PERCENT.exec(text)?.[1] || UP_WORD.test(text.replace(/\d+\s?%/gu, "")) || DOWN_WORD.test(text.replace(/[-−]\s?\d/gu, ""))) return undefined;
  const before = contentTokens(text.slice(0, term.index + term[0].length));
  const subject = normalize(text.slice(0, term.index + term[0].length)).split(" ").slice(-2).join(" ").replace(/^[•\-–·▶■□○●:]+/u, "").trim();
  const phrase = clip(normalize(text.slice(0, term.index + value.index + value[0].length)).replace(/[:：]\s?/gu, " "), 32);
  return { phrase, subject, tokens: before.length ? before.slice(-2) : [term[0]] };
}

function isAction(statement: Statement): boolean {
  if (statement.heading) return false;
  const text = statement.text;
  if (ACTION_DONE.test(text) && !/예정/u.test(text)) return false;
  if (ACTION_WORD.test(text)) return true;
  if (/(공유|보고|정리)(합니다|한다|드립니다)/u.test(text)) return false;
  // Bullets under an action heading are actions even without a verb.
  return ACTION_HEADING.test(statement.unitTitle) && text.length >= 6 && !/^[\s•\-–·]*(담당|일정|기한|완료\s?(목표|예정)|책임)\s?[:：]/u.test(text) && !/^(구분|항목|내용)$/u.test(text);
}

function isConclusion(statement: Statement): boolean {
  if (statement.heading || !JUDGEMENT.test(statement.text)) return false;
  return CONCLUSION_HEADING.test(statement.unitTitle) || CONCLUSION_MARKER.test(statement.text) || /(향후|앞으로|전망)/u.test(statement.text);
}

// ── Candidates ───────────────────────────────────────────────────────────

interface Member {
  statement: Statement;
  /** Lines the gap is about; a table-level gap owns its rows, so they never count as their own rebuttal. */
  own?: Statement[];
  check: SupplementCheck;
  severity: SupplementSeverity;
  groupKey: string;
  subject: string;
  subjectTokens: string[];
  /** Text of the gap in the reader's words. */
  phrase: string;
  change?: Change;
  /** The precise field level, shared by deterministic and semantic rebuttal. */
  requirement?: string;
}

const SEVERITY_RANK: Record<SupplementSeverity, number> = { critical: 0, warning: 1, suggestion: 2 };

function inUnit(all: readonly Statement[], statement: Statement): Statement[] {
  return all.filter((other) => other.fileId === statement.fileId && other.unit === statement.unit);
}

/**
 * The document-wide rebuttal: does any other readable location supply the
 * missing information for this subject? Same-unit statements count without a
 * subject match — a slide is one argument — but its title does not: "점검 결과"
 * names the slide, it does not answer it.
 */
function rebut(all: readonly Statement[], origin: Statement, cue: RegExp, subjectTokens: readonly string[], options: { sameUnit?: boolean; needSubject?: boolean; analysisSection?: boolean } = {}): Statement | undefined {
  return all.find((other) => {
    if (other === origin || other.heading || !cue.test(other.text) || differentParties(origin.text, other.text)
      || !periodsCompatible(origin.period, other.period)) return false;
    if (cue === CAUSE_CUE && pricedMetricMismatch(subjectTokens, other, amountsInWon(origin.text))) return false;
    const sameUnit = other.fileId === origin.fileId && other.unit === origin.unit;
    if (sameUnit && !other.heading && options.sameUnit !== false && !options.needSubject) return true;
    const titleRelates = tokensRelate(subjectTokens, contentTokens(other.unitTitle));
    // A report's own analysis section (원인 분석 · Analysis sheet) explains its figures.
    const analysisSection = options.analysisSection === true && other.fileId === origin.fileId && ANALYSIS_TITLE.test(other.unitTitle);
    return tokensRelate(subjectTokens, other.tokens) || (titleRelates && !other.heading) || (analysisSection && !other.heading);
  });
}

const FIELD_LABELS = {
  baseline: /기준|비교|전(?:월|분기|년)/u,
  target: /(?:확정\s?)?목표/u,
  owner: /(?:정식\s?)?(?:담당|책임자)|주관/u,
  schedule: /일정|기한|시기|완료일/u,
  scope: /범위|대상|수량/u,
  budget: /예산|비용|견적|집행|정산/u,
  conclusion: /근거|전제|결론/u,
} satisfies Partial<Record<SupplementCheck, RegExp>>;

function fieldRequirement(check: SupplementCheck, text: string, subject: string): string {
  const prefix = `${subject}의 `;
  switch (check) {
    case "baseline": return `${prefix}실제 비교 기준값 또는 이전 기간 값`;
    case "target": return `${prefix}측정 가능한 확정 목표값`;
    case "owner": return `${prefix}${/정식|임시|책임자/u.test(text) ? "정식 책임자" : "확정된 담당 주체"}`;
    case "schedule": return `${prefix}구체적인 실행 시점 또는 기간`;
    case "scope": return `${prefix}확정된 적용 대상과 범위`;
    case "budget": return `${prefix}${/실제|집행액|정산/u.test(text) ? "실제 집행액" : /승인/u.test(text) ? "승인 예산 금액" : "예상 비용 규모 또는 산정 근거"}`;
    default: return `${prefix}판단을 직접 뒷받침하는 사실 또는 이유`;
  }
}

function fieldSubject(statement: Statement, check: SupplementCheck): string {
  const parts = statement.text.split(" · ");
  const lead = contentTokens(parts[0]).length > 0 ? parts[0] : parts.slice(1).join(" ");
  const cue = FIELD_LABELS[check as keyof typeof FIELD_LABELS]?.exec(lead);
  const prefix = lead.slice(0, cue?.index ?? lead.length).replace(/^(?:메모|내용|참고)\s*/u, "").trim();
  const subject = check === "target" ? prefix : prefix.split(/(?:은|는)\s|의\s/u)[0].trim();
  if (check === "target" && contentTokens(subject).length === 0) return "목표";
  return subject.length >= 2 && subject.length <= 36 ? subject : check === "target" ? "목표" : statement.unitTitle || "추진 계획";
}

const FIELD_META = /^(운영|교체|추진|설치|도입|적용|세부|추가|지원|계획|목표|비용|예산|담당|책임자|일정|범위|실제|승인|정식|최종|비교|기준)$/u;

/** An unset field starts a search; only a concrete answer for the same subject resolves it. */
function explicitFieldCandidates(statements: readonly Statement[], all: readonly Statement[]): { members: Member[]; resolved: number; checks: SupplementCheck[] } {
  const members: Member[] = [];
  const checks: SupplementCheck[] = [];
  let resolved = 0;
  for (const original of statements) {
    if (original.heading || original.reference) continue;
    for (const check of unresolvedImplementationChecks(original.text)) {
      const sentence = original.text.split(/(?<=[.!?])\s+/u).find(part => unresolvedImplementationChecks(part).includes(check)) ?? original.text;
      const statement = original;
      const field = fieldSubject({ ...original, text: sentence }, check);
      const subject = FIELD_META.test(field) && sentence !== original.text ? fieldSubject(original, check) : field;
      const requirement = fieldRequirement(check, sentence, subject);
      checks.push(check);
      const subjectTokens = contentTokens(subject).filter(token => !FIELD_META.test(token));
      const evidence = all.find(other => other !== original && other.fileId === original.fileId && !other.heading && !other.reference
        && !differentParties(original.text, other.text) && periodsCompatible(original.period, other.period)
        && (subjectTokens.length === 0 || tokensRelate(subjectTokens, other.tokens)
          || (!other.tableRow && !(other.source.locator?.kind === "docx" && other.source.locator.tableCell) && tokensRelate(subjectTokens, contentTokens(other.unitTitle))))
        && suppliesImplementationCheck(check, other.text, requirement));
      if (evidence) { resolved += 1; continue; }
      const level = check === "budget" ? /실제|집행액|정산/u.test(requirement) ? "actual" : /승인/u.test(requirement) ? "approved" : "estimate" : "";
      const groupKey = check === "owner" || check === "schedule" ? check : `explicit:${check}:${level}:${subject}`;
      members.push({ statement, check, severity: "warning", groupKey, subject, subjectTokens, phrase: subject, requirement });
    }
  }
  return { members, resolved, checks };
}

/**
 * A proposed implementation has tracking requirements even when a cost section
 * makes its classifier uncertain. Only concrete answers rebut these gaps;
 * promises to decide after consultation do not supply an owner/date/amount.
 */
function implementationCandidates(statements: readonly Statement[], all: readonly Statement[], explicitChecks: readonly SupplementCheck[]): { members: Member[]; resolved: number } {
  const actions = statements.filter((line) => !line.heading && !line.tableRow && isAction(line));
  if (!statements.some(line => line.heading && /(개선|추진|실행|구축|도입).*(안|계획|방법|방향)|추진\s?방법/u.test(line.text)) || actions.length === 0) return { members: [], resolved: 0 };
  const costLine = (line: Statement) => /(예산|비용|견적|산정|집행)/u.test(`${line.unitTitle} ${line.text}`);
  const execution = statements.filter((line) => !line.heading && !line.tableRow && !costLine(line)
    && /(추진|진행|설치|제작|적용|교체|시행|도입)/u.test(line.text));
  const origin = [...execution].sort((left, right) =>
    Number(/(추진\s?방법|실행|추진\s?계획)/u.test(right.unitTitle)) - Number(/(추진\s?방법|실행|추진\s?계획)/u.test(left.unitTitle))
    || left.index - right.index)[0];
  // A budget promise alone is not an execution commitment.
  if (!origin) return { members: [], resolved: 0 };
  const scopeOrigin = statements.find((line) => !line.heading && !line.tableRow && !costLine(line)
    && /(범위|대상).*(협의|조정|미정|추후)/u.test(line.text));
  const budgetOrigin = statements.find((line) => !line.heading && !line.tableRow && costLine(line));
  const relevant = all.filter((line) => !line.heading && !differentParties(origin.text, line.text));
  const members: Member[] = [];
  let resolved = 0;
  for (const check of ["owner", "schedule", "scope", "budget"] as const) {
    if (explicitChecks.includes(check)) continue;
    // Scope/cost gaps need an explicit decision requirement, not a universal form.
    if (check === "scope" && !scopeOrigin) continue;
    if (check === "budget" && !budgetOrigin) continue;
    const anchor = check === "scope" ? scopeOrigin! : check === "budget" ? budgetOrigin! : origin;
    const requirement = fieldRequirement(check, anchor.text, "추진 계획");
    if (relevant.some(line => suppliesImplementationCheck(check, line.text, requirement))) { resolved += 1; continue; }
    members.push({ statement: anchor, check, severity: "warning", groupKey: `implementation:${check}`, subject: "추진 계획", subjectTokens: origin.tokens, phrase: "추진 계획", requirement });
  }
  return { members, resolved };
}

function candidatesFor(outline: FileOutline, docType: SupplementDocType, all: readonly Statement[]): { members: Member[]; resolved: number } {
  const members: Member[] = [];
  let resolved = 0;
  const need = (check: SupplementCheck) => NECESSITY[check][docType];
  const statements = outline.statements;
  const explicit = explicitFieldCandidates(statements, all);
  members.push(...explicit.members);
  resolved += explicit.resolved;
  const implementation = implementationCandidates(statements, all, explicit.checks);
  members.push(...implementation.members);
  resolved += implementation.resolved;
  const implementationPlan = implementation.members.length > 0 || implementation.resolved > 0;

  const changes = new Map<Statement, Change>();
  const issues = new Map<Statement, Issue>();
  for (const statement of statements) {
    if (statement.tableRow && !statement.change) continue;
    const change = statement.change ?? detectChange(statement);
    if (change) changes.set(statement, change);
    if (statement.tableRow) continue;
    const issue = detectIssue(statement);
    if (issue && !(change && change.adverse === false)) issues.set(statement, issue);
  }
  const isProblem = (other: Statement) => issues.has(other) || (changes.get(other)?.adverse === true && changeSize(changes.get(other)!) >= 10);
  const unitHasProblem = (statement: Statement) => inUnit(statements, statement).some(isProblem);
  const fileHasProblem = statements.some(isProblem);

  // 원인: significant changes, adverse ones first.
  for (const [statement, change] of changes) {
    const necessity = need("cause");
    if (necessity === "none" || statement.heading) continue;
    const size = changeSize(change);
    let severity: SupplementSeverity | undefined;
    if (change.adverse === true && size >= 10) severity = necessity === "required" ? "critical" : size >= 15 ? "warning" : undefined;
    // A large swing either way needs its driver where figures are the point of the report.
    else if (change.adverse !== true && size >= 15 && necessity === "required") severity = "warning";
    if (!severity || necessity === "recommended") continue;
    if (CAUSE_CUE.test(statement.text) || EXPLANATION_FIELD.test(statement.text) || rebut(all, statement, CAUSE_CUE, change.subjectTokens, { needSubject: false, analysisSection: true })) { resolved += 1; continue; }
    const family = familyOf(change.subject);
    members.push({ statement, check: "cause", severity, groupKey: `cause:${family?.key ?? change.subject}:${change.direction}`, subject: change.subject, subjectTokens: change.subjectTokens, phrase: change.subject, change });
  }

  // 비교 기준: KPI levels shown without any reference.
  for (const statement of statements) {
    const necessity = need("baseline");
    if (necessity === "none" || necessity === "recommended" || changes.has(statement)) continue;
    if (statement.tableRow) continue;
    const kpi = detectKpi(statement);
    // Outside KPI-centred reports only a headline figure standing alone needs a reference.
    if (!kpi || (necessity === "conditional" && statement.text.length > 40)) continue;
    if (rebut(all, statement, BASELINE_CUE, kpi.tokens, { needSubject: true })) { resolved += 1; continue; }
    members.push({ statement, check: "baseline", severity: "warning", groupKey: `baseline:${kpi.subject}`, subject: kpi.subject, subjectTokens: kpi.tokens, phrase: kpi.phrase });
  }

  // 영향 · 대응: problems and adverse changes.
  for (const [statement, issue] of issues) {
    const impactNeed = need("impact");
    if (impactNeed === "required") {
      if (IMPACT_CUE.test(statement.text) || rebut(all, statement, IMPACT_CUE, issue.tokens)) resolved += 1;
      else members.push({ statement, check: "impact", severity: "warning", groupKey: `impact:${familyOf(issue.tokens[0])?.key ?? issue.tokens[0]}`, subject: issue.phrase, subjectTokens: issue.tokens, phrase: issue.phrase });
    }
    const responseNeed = need("response");
    if (responseNeed === "none" || responseNeed === "recommended") continue;
    if (RESPONSE_CUE.test(statement.text.replace(ISSUE_WORD, "")) || rebut(all, statement, RESPONSE_CUE, issue.tokens) || hasActionFor(all, statement, issue.tokens)) { resolved += 1; continue; }
    members.push({ statement, check: "response", severity: responseNeed === "required" ? "critical" : "warning", groupKey: `response:${familyOf(issue.tokens[0])?.key ?? issue.tokens[0]}`, subject: issue.phrase, subjectTokens: issue.tokens, phrase: issue.phrase });
  }
  for (const [statement, change] of changes) {
    if (issues.has(statement) || statement.heading || change.adverse !== true || changeSize(change) < 15) continue;
    // A cost or sales swing needs its cause everywhere, but a follow-up plan only
    // where the report exists to drive action (issue, project reports).
    if (need("response") !== "required") continue;
    if (rebut(all, statement, RESPONSE_CUE, change.subjectTokens) || hasActionFor(all, statement, change.subjectTokens)) { resolved += 1; continue; }
    const phrase = `${change.subject}${change.percentText ? ` ${change.percentText}` : ""} ${change.direction === "up" ? "증가" : "감소"}`;
    members.push({ statement, check: "response", severity: "warning", groupKey: `response:${familyOf(change.subject)?.key ?? change.subject}`, subject: phrase, subjectTokens: change.subjectTokens, phrase, change });
  }

  // 담당 · 일정: commitments that cannot be tracked.
  for (const statement of statements) {
    if (implementationPlan) continue;
    if (statement.tableRow || !isAction(statement) || issues.has(statement)) continue;
    const ownerNeed = need("owner");
    const strong = ownerNeed === "required"
      || (ownerNeed === "conditional" && (unitHasProblem(statement) || (fileHasProblem && ACTION_HEADING.test(statement.unitTitle))));
    if (!strong) continue;
    const action = clip(statement.text.replace(/^[\s•\-–·▶■□○●\d.)]+/u, ""), 30);
    const unitStatements = inUnit(statements, statement);
    const actionTokens = statement.tokens;
    const covered = (check: "owner" | "schedule") => suppliesImplementationCheck(check, statement.text)
      || unitStatements.some(other => other !== statement && suppliesImplementationCheck(check, other.text))
      || all.some(other => other !== statement && other.unit !== statement.unit && periodsCompatible(statement.period, other.period)
        && suppliesImplementationCheck(check, other.text) && tokensRelate(actionTokens, other.tokens)
        && (ACTION_HEADING.test(other.unitTitle) || /(담당|일정|기한|책임|R&R)/u.test(other.unitTitle) || actionTokens.filter(token => other.tokens.includes(token)).length >= 2));
    const noOwner = !covered("owner");
    const noSchedule = !covered("schedule");
    if (!noOwner && !noSchedule) { resolved += 1; continue; }
    for (const check of ["owner", "schedule"] as const) {
      if (check === "owner" ? !noOwner : !noSchedule) continue;
      members.push({ statement, check, severity: "warning", groupKey: check, subject: action, subjectTokens: actionTokens, phrase: action });
    }
  }

  // 결론 근거: judgements with nothing related that argues for them.
  for (const statement of statements) {
    if (statement.tableRow || !isConclusion(statement)) continue;
    const keys = statement.tokens.filter((token) => !/^(향후|앞으로|부담|수준|영향|효과|상황|측면)$/u.test(token));
    if (keys.length === 0) continue;
    const support = all.find((other) => other !== statement && !isConclusion(other) && REASON_CUE.test(other.text) && tokensRelate(keys, other.tokens));
    if (support) { resolved += 1; continue; }
    members.push({ statement, check: "conclusion", severity: "critical", groupKey: `conclusion:${statement.index}`, subject: clip(statement.text, 40), subjectTokens: keys, phrase: clip(statement.text, 40) });
  }
  if (outline.tables.length > 0) resolved += workbookCandidates(outline, need, all, members);
  return { members, resolved };
}

/**
 * A follow-up exists when an action sits on the same slide/page, names the
 * same subject, or the file has a dedicated response section (대응·조치·향후
 * 계획) — a report's action section answers the problems it raised.
 */
function hasActionFor(all: readonly Statement[], origin: Statement, tokens: readonly string[]): boolean {
  return all.some((other) => other !== origin && isAction(other)
    && ((other.fileId === origin.fileId && (other.unit === origin.unit || ACTION_HEADING.test(other.unitTitle))) || tokensRelate(tokens, other.tokens)));
}

const ANALYSIS_TITLE = /(원인|요인|분석|배경|breakdown|analysis|driver)/iu;

/**
 * Workbook report tables: a reference for the figures, a target behind an
 * attainment rate, the period and unit of the numbers, and a follow-up for
 * open issues in an issue register. Only report tables are checked; every
 * check first searches the whole workbook for what would cancel it.
 * Returns how many candidates the search cancelled.
 */
function workbookCandidates(
  outline: FileOutline,
  need: (check: SupplementCheck) => SupplementNecessity,
  all: readonly Statement[],
  members: Member[],
): number {
  let resolved = 0;
  const tables = outline.tables.filter((table) => table.rows.length > 0);
  const applies = (check: SupplementCheck, table: SheetTable) => need(check) === "required" || (need(check) === "conditional" && table.summary);
  const labelTokens = (table: SheetTable) => table.rows.flatMap((entry) => contentTokens(entry.label));
  const pseudo = (table: SheetTable): Statement => ({
    ...table.rows[0].statement,
    text: `${table.title} · ${table.headers.filter(Boolean).join(" · ")}`,
    source: { ...table.source, quote: table.rows.slice(0, 3).map((entry) => entry.statement.text).join("\n") },
    unitLabel: `${table.sheet} / ${table.range}`,
  });
  const sheetText = (table: SheetTable) => [table.title, ...outline.tables.filter((other) => other.sheet === table.sheet).map((other) => `${other.title} ${other.headers.join(" ")}`)].join(" ");
  const metricRows = (table: SheetTable) => table.rows.filter((entry) => entry.label && entry.cells.some((cell) => typeof cell.value === "number"));
  const push = (table: SheetTable, check: SupplementCheck, groupKey: string, subject: string, phrase: string, severity: SupplementSeverity = "warning") =>
    members.push({ statement: pseudo(table), own: table.rows.map((entry) => entry.statement), check, severity, groupKey, subject, subjectTokens: contentTokens(subject), phrase });

  for (const table of tables) {
    const headerText = table.headers.join(" ");
    const metrics = metricRows(table);
    if (metrics.length === 0) continue;
    const labels = labelTokens(table);
    const lead = metrics[0].label;
    const related = (pattern: RegExp) => outline.tables.some((other) => other !== table && pattern.test(other.headers.join(" ")) && tokensRelate(labels, labelTokens(other)));

    // 목표/예산 기준: an attainment rate with no target beside it.
    if (applies("target", table) && ATTAINMENT_HEADER.test(headerText)) {
      if (TARGET_HEADER.test(headerText.replace(ATTAINMENT_HEADER, "")) || related(TARGET_HEADER)) resolved += 1;
      else push(table, "target", `target:${table.sheet}`, lead, `${table.sheet} 시트의 ${lead}`);
    }

    // 비교 기준: figures with no target, budget or prior period anywhere near them.
    if (applies("baseline", table) && metrics.length >= 2 && !ATTAINMENT_HEADER.test(headerText)
      && !table.rows.some((entry) => entry.statement.change) && !table.headers.some((header) => /(증감|대비|변동|YoY|MoM|QoQ)/iu.test(header))) {
      if (BASELINE_CUE.test(`${table.title} ${headerText}`) || related(BASELINE_CUE)) resolved += 1;
      else push(table, "baseline", `baseline:${table.sheet}`, lead, `${table.sheet} 시트의 ${metrics.slice(0, 2).map((entry) => entry.label).join("·")} 수치`);
    }

    // 기준 기간: figures that do not say which month, quarter or cut-off they cover.
    if (applies("period", table)) {
      const periodStated = PERIOD_EXPR.test(outline.fileName) || PERIOD_EXPR.test(sheetText(table)) || table.rows.some((entry) => PERIOD_EXPR.test(entry.label))
        || table.rows.some((entry) => entry.cells.some((cell) => cell.valueType === "date"));
      if (periodStated) resolved += 1;
      else push(table, "period", "period", table.sheet, table.sheet);
    }

    // 단위: money figures whose unit is stated nowhere on the sheet or in their format.
    if (applies("unit", table) && (MONEY_LABEL.test(headerText) || metrics.some((entry) => MONEY_LABEL.test(entry.label)))) {
      const unitStated = UNIT_EXPR.test(sheetText(table)) || UNIT_EXPR.test(outline.fileName)
        || metrics.some((entry) => entry.cells.some((cell) => /[₩$€]|원|"|%/u.test(cell.numberFormat ?? "") || UNIT_EXPR.test(normalize(cell.display))));
      if (unitStated) resolved += 1;
      else push(table, "unit", "unit", table.sheet, table.sheet);
    }
  }

  // 대응: open items in an issue or risk register with no action recorded.
  for (const table of tables) {
    if (need("response") === "none" || !/(이슈|리스크|문제|위험|issue|risk)/iu.test(`${table.title} ${table.headers.join(" ")}`)) continue;
    const actionColumn = table.headers.findIndex((header) => /(조치|대응|대책|개선|action|계획|mitigation)/iu.test(header));
    const statusColumn = table.headers.findIndex((header) => /(상태|status|진행)/iu.test(header));
    for (const entry of table.rows) {
      const status = statusColumn >= 0 ? normalize(entry.cells[statusColumn]?.display ?? "") : "";
      if (/(완료|종결|해결|closed|done)/iu.test(status)) continue;
      if (actionColumn >= 0 && normalize(entry.cells[actionColumn]?.display ?? "")) { resolved += 1; continue; }
      if (rebut(all, entry.statement, RESPONSE_CUE, contentTokens(entry.label), { needSubject: true })) { resolved += 1; continue; }
      const phrase = clip(entry.label, 30);
      members.push({ statement: entry.statement, check: "response", severity: need("response") === "required" ? "critical" : "warning", groupKey: `response:register:${table.sheet}`, subject: phrase, subjectTokens: contentTokens(entry.label), phrase });
    }
  }
  return resolved;
}

// ── Grouping and wording ─────────────────────────────────────────────────

const TITLES: Record<string, string> = {
  baseline: "비교 기준 확인 필요",
  cause: "원인 설명 확인 필요",
  impact: "영향 설명 확인 필요",
  response: "대응 확인 필요",
  owner: "담당 확인 필요",
  schedule: "일정 확인 필요",
  scope: "구체 대상·범위 확인 필요",
  budget: "비용 정보 확인 필요",
  conclusion: "결론 근거 확인 필요",
  target: "목표/예산 기준 확인 필요",
  period: "기준 기간 확인 필요",
  unit: "단위 확인 필요",
};

const REASONS: Record<string, string> = {
  baseline: "기준이 없으면 이 수치가 좋은지 나쁜지 판단하기 어렵습니다.",
  cause: "변화 폭이 커서 보고받는 사람이 먼저 원인을 물을 가능성이 높습니다.",
  impact: "영향 범위를 알아야 우선순위와 대응 수준을 정할 수 있습니다.",
  response: "문제가 제시되면 보고받는 사람은 후속 조치를 먼저 확인합니다.",
  owner: "책임 주체가 없으면 실행 여부를 추적하기 어렵습니다.",
  schedule: "완료 시점이 없으면 진행 상황을 점검하기 어렵습니다.",
  scope: "구체 대상과 범위가 없으면 실행 규모를 판단하기 어렵습니다.",
  budget: "비용 규모와 산정 근거가 없으면 실행 가능성을 판단하기 어렵습니다.",
  conclusion: "근거가 드러나지 않은 판단은 의사결정에 그대로 쓰기 어렵습니다.",
  target: "목표가 없으면 달성률이 무엇을 기준으로 계산됐는지 알 수 없습니다.",
  period: "기간이 불분명하면 다른 자료와 비교하거나 보고할 때 오해가 생깁니다.",
  unit: "단위가 없으면 같은 숫자도 천 배 이상 다르게 읽힐 수 있습니다.",
};

function wording(kind: string, members: readonly Member[]): { title: string; message: string; additions: string[]; question?: string; requirement: string } {
  const [lead] = members;
  const title = TITLES[kind];
  const distinct = [...new Set(members.map((member) => member.subject))];
  switch (kind) {
    case "scope":
    case "budget":
      return {
        title,
        message: kind === "scope" ? "현재 자료에서 추진 대상과 구체 범위를 확인하지 못했습니다." : "현재 자료에서 비용 규모 또는 산정 근거를 확인하지 못했습니다.",
        additions: kind === "scope" ? ["구체 대상과 수량 또는 적용 범위"] : ["예상 비용 규모", "견적 또는 산정 근거"],
        question: kind === "scope" ? "어떤 대상에 어느 범위까지 적용합니까?" : "예상 비용과 산정 근거는 무엇입니까?",
        requirement: kind === "scope" ? "추진 대상과 구체 수량 또는 적용 범위" : "예상 비용 규모 또는 산정 근거",
      };
    case "cause": {
      const change = lead.change!;
      const verb = change.direction === "up" ? "증가" : "감소";
      const family = familyOf(change.subject);
      const subject = distinct.length > 1 && family ? family.label : change.subject;
      const amount = distinct.length === 1 && change.percentText ? `${change.baselinePhrase ? `${change.baselinePhrase} ` : ""}${change.percentText} ` : "";
      return {
        title: distinct.length > 1 && family ? `${family.label} ${verb} 원인 설명 확인 필요` : title,
        message: `${subject}${josa(subject, "이/가")} ${amount}${verb}했다고 제시되어 있지만 현재 자료에서 주요 ${verb} 원인 설명을 확인하지 못했습니다.`,
        additions: [`주요 ${verb} 요인`, "요인별 영향 규모", "일회성 여부"],
        question: `왜 ${subject}${josa(subject, "이/가")} ${distinct.length === 1 && change.percentText ? `${change.percentText} ` : ""}${verb}했습니까?`,
        requirement: `${subject} ${verb}의 원인이나 요인 설명`,
      };
    }
    case "baseline":
      return {
        title,
        message: `${lead.phrase}${josa(lead.phrase, "이/가")} 제시되어 있지만 현재 자료에서 판단할 비교 기준(목표·이전 기간·기준값)을 확인하지 못했습니다.`,
        additions: ["목표값 또는 기준값", "이전 기간 값"],
        question: `${lead.subject}${josa(lead.subject, "은/는")} 목표 대비 어느 수준입니까?`,
        requirement: `${lead.subject}의 목표·이전 기간·기준값 등 비교 기준`,
      };
    case "impact":
      return {
        title,
        message: `${lead.phrase}${josa(lead.phrase, "이/가")} 제시되어 있지만 현재 자료에서 고객·비용·운영에 미치는 영향 설명을 확인하지 못했습니다.`,
        additions: ["영향 범위(고객·제품·공정)", "비용·매출 영향 규모", "일정 영향"],
        question: `${lead.phrase}의 영향은 어느 정도입니까?`,
        requirement: `${lead.phrase}의 영향(고객·비용·운영·일정)`,
      };
    case "response":
      return {
        title,
        message: `${lead.phrase}${josa(lead.phrase, "이/가")} 제시되어 있지만 현재 자료에서 후속 대응 내용을 확인하지 못했습니다.`,
        additions: ["대응 조치 내용", "담당", "완료 목표 시점"],
        question: `${lead.phrase}에 어떻게 대응합니까?`,
        requirement: `${lead.phrase}에 대한 후속 대응이나 조치`,
      };
    case "conclusion":
      return {
        title,
        message: "현재 자료에서 이 결론을 직접 뒷받침하는 근거를 충분히 확인하지 못했습니다.",
        additions: ["결론을 뒷받침하는 수치·사실", "판단 기준 또는 전제"],
        question: "이 판단의 근거는 무엇입니까?",
        requirement: "이 판단을 직접 뒷받침하는 수치, 사실 또는 이유",
      };
    case "target":
      return {
        title,
        message: `${lead.phrase} 달성률이 제시되어 있지만 현재 자료에서 목표값 또는 예산 기준을 확인하지 못했습니다.`,
        additions: ["목표값 또는 예산", "달성률 산정 기준"],
        question: `${lead.subject}의 목표값은 얼마입니까?`,
        requirement: `${lead.subject}의 목표값이나 예산`,
      };
    case "period":
    case "unit": {
      const sheets = distinct.join(", ");
      return kind === "period"
        ? {
          title,
          message: `${sheets} 시트의 수치가 어느 기간(월·분기·누계·기준일) 기준인지 현재 자료에서 확인하지 못했습니다.`,
          additions: ["기준 기간(월·분기·누계)", "기준일"],
          question: "이 수치는 어느 기간 기준입니까?",
          requirement: `${sheets} 시트 수치의 기준 기간이나 기준일`,
        }
        : {
          title,
          message: `${sheets} 시트의 금액이 어떤 단위(원·천원·백만원 등)인지 현재 자료에서 확인하지 못했습니다.`,
          additions: ["금액 단위(원·천원·백만원 등)"],
          question: "금액 단위는 무엇입니까?",
          requirement: `${sheets} 시트 금액의 단위`,
        };
    }
    default: {
      const what = kind === "owner" ? "담당" : "완료 시점";
      const single = members.length === 1;
      const action = `'${lead.phrase}'`;
      return {
        title,
        message: single
          ? `${action} 실행 항목의 ${what}${josa(what, "을/를")} 현재 자료에서 확인하지 못했습니다.`
          : `제시된 실행 항목의 ${what}${josa(what, "을/를")} 현재 자료에서 확인하지 못했습니다.`,
        additions: kind === "owner" ? ["담당 부서 또는 담당자"] : ["완료 목표 시점", "중간 점검 시점"],
        question: `${single ? `${action}${josa(lead.phrase, "은/는")} ` : ""}${kind === "owner" ? "누가 담당합니까?" : "언제까지 완료합니까?"}`,
        requirement: `이 실행 항목의 ${kind === "owner" ? "담당 부서나 담당자" : "완료 시점이나 기한"}`,
      };
    }
  }
}

// ── Draft ────────────────────────────────────────────────────────────────

export interface SupplementInput { document: NormalizedDocument; fileName: string }

/** The kind of line that would supply each check's missing information. */
const CHECK_CUES: Partial<Record<SupplementCheck, RegExp>> = {
  cause: CAUSE_CUE,
  baseline: BASELINE_CUE,
  target: TARGET_HEADER,
  impact: IMPACT_CUE,
  response: RESPONSE_CUE,
  owner: OWNER_CUE,
  schedule: SCHEDULE_CUE,
  scope: FIELD_LABELS.scope,
  budget: FIELD_LABELS.budget,
  conclusion: REASON_CUE,
};

/**
 * Decision information worth carrying into a report when another file has it.
 * Owner, schedule, period and unit stay where they are managed.
 */
const REPORT_TITLES: Partial<Record<SupplementCheck, string>> = {
  cause: "원인 설명을 보고자료에 추가하면 좋습니다",
  baseline: "비교 기준을 보고자료에 추가하면 좋습니다",
  target: "목표·예산 기준을 보고자료에 추가하면 좋습니다",
  impact: "영향 설명을 보고자료에 추가하면 좋습니다",
  response: "대응 내용을 보고자료에 추가하면 좋습니다",
  conclusion: "결론 근거를 보고자료에 추가하면 좋습니다",
};

/**
 * A file's part in the set, from its name, format and structure. A deck is a
 * presentation unless it is named as analysis or reference; a PDF is a report
 * only when it reads like one. Anything unclear stays `unknown`.
 */
function roleOfFile(entry: FileOutline): SupplementFileRole {
  const name = entry.fileName.replace(/\.[^.]+$/u, "");
  const titles = [...new Set(entry.statements.filter((statement) => statement.heading).map((statement) => statement.text))];
  if (/(회의|공문|참고|가이드|매뉴얼|안내|규정)/u.test(name)) return "reference";
  if (/(분석|원인|요인|세부|analysis|detail)/iu.test(name) || (titles.length >= 2 && titles.filter((title) => ANALYSIS_TITLE.test(title)).length * 2 > titles.length)) return "analysis";
  if (entry.document.kind === "xlsx") return "data";
  if (entry.document.kind === "pptx") return "report";
  const reportName = /(보고|결과|report|요약|브리핑|임원|경영|고객|제출|최종)/iu.test(name);
  const reportShape = entry.statements.some((statement) => CONCLUSION_HEADING.test(statement.unitTitle) || ACTION_HEADING.test(statement.unitTitle));
  return reportName || reportShape ? "report" : "unknown";
}

/** Equal amounts cannot join two explicitly different priced metrics. */
function pricedMetricMismatch(subjectTokens: readonly string[], other: Statement, ownAmounts: readonly number[]): boolean {
  const ownMetrics = subjectTokens.filter((token) => familyOf(token));
  const otherMetrics = other.tokens.filter((token) => familyOf(token));
  return ownAmounts.length > 0 && amountsInWon(other.text, other.unitTitle).length > 0
    && ownMetrics.length > 0 && otherMetrics.length > 0 && !tokensRelate(ownMetrics, otherMetrics);
}

/**
 * A line of another file may speak about the same thing only when it names the
 * same subject (or the same amount after unit normalization) and no other
 * party. An amount below 1% of the reported one cannot explain it, however
 * close the wording (₩1.2M against ₩1.2B). The deterministic search and the
 * model's evidence both use this test, so a merely nearby line from another
 * upload is never offered as evidence.
 */
function linkable(own: readonly Statement[], subjectTokens: readonly string[], other: Statement, ownAmounts: readonly number[], check: SupplementCheck): boolean {
  if (other.reference || other.heading || own.some((statement) => differentParties(statement.text, other.text))
    || pricedMetricMismatch(subjectTokens, other, ownAmounts)) return false;
  if (Object.hasOwn(FIELD_LABELS, check) && subjectTokens.length > 0
    && !tokensRelate(subjectTokens, other.tokens) && !tokensRelate(subjectTokens, contentTokens(other.unitTitle))) return false;
  const otherAmounts = amountsInWon(other.text, other.unitTitle);
  if (ownAmounts.length > 0 && otherAmounts.length > 0 && Math.max(...otherAmounts) < Math.min(...ownAmounts) * 0.01) return false;
  return tokensRelate(subjectTokens, other.tokens)
    || tokensRelate(subjectTokens, contentTokens(other.unitTitle))
    || (ownAmounts.length > 0 && sameAmount(ownAmounts, otherAmounts));
}

/**
 * Where another file supplies the same information: the check's cue, the same
 * subject (or the same money amount after unit normalization), the same party
 * and a compatible period. A match that fails only on period is kept as a
 * weak link and never used as a rebuttal.
 */
function crossEvidence(own: readonly Statement[], subjectTokens: readonly string[], check: SupplementCheck, others: readonly Statement[], requirement: string): { direct: Statement[]; weak?: Statement } {
  const cue = CHECK_CUES[check];
  const lead = own[0];
  if (!cue || !lead) return { direct: [] };
  const ownAmounts = own.flatMap((statement) => amountsInWon(statement.text, statement.unitTitle));
  const direct: Statement[] = [];
  let weak: Statement | undefined;
  for (const other of others) {
    // An explanation column of an analysis table (증감 분석 · 요인 분석) states causes without the word 원인.
    const cued = cue.test(other.text) || (check === "cause" && other.tableRow === true && EXPLANATION_FIELD.test(other.text) && ANALYSIS_TITLE.test(other.unitTitle));
    if (!cued || (Object.hasOwn(FIELD_LABELS, check) && !suppliesImplementationCheck(check, other.text, requirement)) || !linkable(own, subjectTokens, other, ownAmounts, check)) continue;
    if (!periodsCompatible(lead.period, other.period)) { weak ??= other; continue; }
    direct.push(other);
  }
  return { direct: direct.slice(0, 3), ...(weak ? { weak } : {}) };
}

const CAUSE_FILLER = /^(원인|요인|주요|주된|영향|증가|감소|상승|하락|확대|축소|가장|핵심|기인|때문|이유|배경|분석|설명)$/u;

/**
 * Explanation conflicts: two files give a main cause for the same change and
 * name no factor in common. Reported for review, never resolved by choosing one.
 */
function conflictCandidates(outlines: readonly FileOutline[], label: (statement: Statement) => string): SupplementCandidate[] {
  const changes: Array<{ statement: Statement; change: Change }> = [];
  for (const entry of outlines) {
    for (const statement of entry.statements) {
      const change = statement.change ?? (statement.tableRow ? undefined : detectChange(statement));
      if (change && changeSize(change) >= 10 && !changes.some((seen) => seen.change.subject === change.subject)) changes.push({ statement, change });
    }
  }
  const found: SupplementCandidate[] = [];
  for (const { statement, change } of changes) {
    const subject = [change.subject];
    const byFile = outlines.map((entry) => entry.statements.filter((line) => line !== statement && CAUSE_CUE.test(line.text)
      && (tokensRelate(subject, line.tokens) || tokensRelate(subject, contentTokens(line.unitTitle)))
      && periodsCompatible(statement.period, line.period) && !differentParties(statement.text, line.text))).filter((lines) => lines.length > 0);
    if (byFile.length < 2) continue;
    const factors = byFile.map((lines) => new Set(lines.flatMap((line) => line.tokens).filter((token) => !CAUSE_FILLER.test(token) && !tokensRelate(subject, [token]))));
    const main = byFile.map((lines) => lines.some((line) => /(주요|주된|가장\s?큰|핵심)/u.test(line.text)));
    const pair = byFile.findIndex((_, left) => byFile.some((__, right) => right > left && (main[left] || main[right])
      && factors[left].size > 0 && factors[right].size > 0 && ![...factors[left]].some((token) => factors[right].has(token))));
    if (pair < 0) continue;
    const lines = byFile.map((entries) => entries[0]);
    found.push({
      id: `conflict:${change.subject}`,
      fileId: statement.fileId,
      check: "cause",
      severity: "warning",
      status: "missing",
      scope: "conflict",
      title: "원인 설명이 자료별로 다릅니다",
      message: `${change.subject} 변화의 주요 원인을 자료마다 다르게 설명하고 있습니다. 어느 설명이 맞는지 자료 간 확인이 필요합니다.`,
      reason: "같은 변화에 대해 자료마다 설명이 다르면 보고받는 사람이 어느 쪽을 기준으로 판단할지 알 수 없습니다.",
      current: clip(statement.text, 160),
      sources: [statement.source],
      locations: [label(statement)],
      additions: ["자료 간 원인 설명 정리", "요인별 영향 규모"],
      question: `${change.subject} 변화의 주요 원인은 무엇입니까? 자료마다 설명이 다릅니다.`,
      evidence: lines.map((line) => line.source),
      evidenceLocations: lines.map(label),
      requirement: "",
      topic: `conflict:${change.subject}`,
      reportEligible: false,
      reportTitle: "",
    });
  }
  return found;
}

export function buildSupplementDraft(inputs: readonly SupplementInput[], diagnostics?: SupplementDiagnostics): SupplementDraft {
  const outlines = inputs.map((input) => outline(input.document, input.fileName));
  if (diagnostics) diagnostics.parsedUnits = outlines.reduce((sum, entry) => sum + entry.coverage.analyzed, 0);
  const multi = outlines.length > 1;
  const fileNameOf = new Map(outlines.map((entry) => [entry.document.fileId, entry.fileName]));
  const label = (statement: Statement) => multi ? `${fileNameOf.get(statement.fileId)} / ${statement.unitLabel}` : statement.unitLabel;

  // Periods: the line's own, else its slide/page/sheet title, else the file's.
  const filePeriods = new Map<string, Period | undefined>();
  for (const entry of outlines) {
    const titles = entry.statements.filter((statement) => statement.heading).slice(0, 2).map((statement) => statement.text).join(" ");
    const filePeriod = periodOf(entry.fileName) ?? periodOf(titles || entry.statements.slice(0, 2).map((statement) => statement.text).join(" "));
    filePeriods.set(entry.document.fileId, filePeriod);
    for (const statement of entry.statements) statement.period = periodOf(statement.text) ?? periodOf(statement.unitTitle) ?? filePeriod;
    for (const statement of entry.references) {
      statement.reference = true;
      statement.period = periodOf(statement.text) ?? periodOf(statement.unitTitle) ?? filePeriod;
    }
  }

  const files: SupplementFileSummary[] = [];
  const candidates: SupplementCandidate[] = [];
  const origins = new Map<string, Statement[]>();
  const pools = new Map<string, Statement[]>();
  const incomplete = outlines.filter((entry) => !entry.coverage.complete);
  let resolvedCount = 0;

  for (const entry of outlines) {
    const docType = classify(entry.fileName, entry.statements);
    const role = roleOfFile(entry);
    const period = periodLabel(filePeriods.get(entry.document.fileId));
    files.push({ fileId: entry.document.fileId, fileName: entry.fileName, docType, role, ...(period ? { period } : {}) });
    // File first: its own lines, including its evidence-only sheets.
    const own = [...entry.statements, ...entry.references];
    const { members, resolved } = candidatesFor(entry, docType, own);
    resolvedCount += resolved;
    if (diagnostics) {
      diagnostics.classifications.push(docType);
      diagnostics.initialDeterministic += members.length + resolved;
      diagnostics.rejected.covered_elsewhere += resolved;
      diagnostics.rebutted += resolved;
    }
    // Then the other files: their report and analysis lines, never raw data rows.
    const others = outlines.filter((other) => other !== entry).flatMap((other) => other.statements);
    const groups = new Map<string, Member[]>();
    for (const member of members) groups.set(member.groupKey, [...(groups.get(member.groupKey) ?? []), member]);
    // Absence is only proven when every file of the set was read in full.
    const unread = entry.coverage.complete
      ? multi && incomplete.length > 0 ? incomplete.map((other) => `${other.fileName}: ${other.coverage.notes.join(" ")}`).join(" ") : undefined
      : `${multi ? `${entry.fileName}: ` : ""}${entry.coverage.notes.join(" ")}`;
    for (const [key, group] of groups) {
      const ordered = [...group].sort((a, b) => a.statement.index - b.statement.index);
      const kind = ordered[0].check;
      const text = wording(kind, ordered);
      if (ordered[0].requirement) text.requirement = ordered[0].requirement;
      if (kind === "target" && ordered[0].requirement) {
        text.title = "목표 정의 확인 필요";
        text.message = `${ordered[0].subject === "목표" ? "" : `${ordered[0].subject}에 대해 `}현재 자료에서 측정 가능한 확정 목표값을 확인하지 못했습니다.`;
        text.additions = ["목표 지표", "목표값과 측정 기준"];
        text.question = "확정된 목표 지표와 목표값은 무엇입니까?";
      }
      if (kind === "budget" && /실제 집행액/u.test(text.requirement)) {
        text.message = `${ordered[0].subject}에 대해 견적과 구분되는 실제 집행액을 확인하지 못했습니다.`;
        text.additions = ["실제 집행액 또는 정산 결과"];
        text.question = "실제 집행액과 정산 결과는 무엇입니까?";
      }
      const severity = ordered.reduce<SupplementSeverity>((best, member) => SEVERITY_RANK[member.severity] < SEVERITY_RANK[best] ? member.severity : best, "suggestion");
      const id = `${entry.document.fileId}:${key}`;
      origins.set(id, ordered.flatMap((member) => member.own ?? [member.statement]));
      const subjectTokens = [...new Set(ordered.flatMap((member) => member.subjectTokens))].filter(token => !Object.hasOwn(FIELD_LABELS, kind) || !FIELD_META.test(token));
      const ownAmounts = ordered.flatMap((member) => amountsInWon(member.statement.text, member.statement.unitTitle));
      pools.set(id, [...own.filter(other => !Object.hasOwn(FIELD_LABELS, kind) || subjectTokens.length === 0 || tokensRelate(subjectTokens, other.tokens)
        || (!(other.source.locator?.kind === "docx" && other.source.locator.tableCell) && !other.tableRow && tokensRelate(subjectTokens, contentTokens(other.unitTitle)))),
        ...others.filter(other => periodsCompatible(ordered[0].statement.period, other.period)
          && linkable(ordered.map(member => member.statement), subjectTokens, other, ownAmounts, kind))]);
      const cross = multi ? crossEvidence(ordered.map((member) => member.statement), subjectTokens, ordered[0].check, others, text.requirement) : { direct: [] };
      const message = multi ? text.message.replace(/현재 자료에서/u, "업로드된 자료 전체에서") : text.message;
      const family = familyOf(ordered[0].subject);
      candidates.push({
        id,
        fileId: entry.document.fileId,
        check: ordered[0].check,
        severity,
        status: unread ? "unverified" : "missing",
        scope: "all",
        title: text.title,
        message: unread ? message.replace(/(현재 자료에서|업로드된 자료 전체에서)/u, "현재 읽은 범위에서") : message,
        reason: REASONS[kind],
        current: clip(ordered[0].statement.text, 160),
        sources: ordered.map((member) => member.statement.source),
        locations: [...new Set(ordered.map((member) => label(member.statement)))],
        additions: text.additions,
        ...(severity !== "suggestion" && text.question ? { question: text.question } : {}),
        ...(unread ? { limitation: `읽지 못한 영역에 관련 내용이 있을 수 있어 확정하지 않았습니다. ${unread}` } : {}),
        ...(cross.direct.length ? { evidence: cross.direct.map((line) => line.source), evidenceLocations: cross.direct.map(label) } : {}),
        ...(cross.weak ? { linkNote: `${label(cross.weak)}에 관련 가능성이 있는 설명이 있으나 기간(${periodLabel(cross.weak.period) ?? "다름"})이 달라 직접 근거로 연결하지 않았습니다.` } : {}),
        requirement: text.requirement,
        topic: `${kind}:${family?.key ?? ordered[0].subject}:${ordered[0].change?.direction ?? ""}`,
        reportEligible: role === "report" && REPORT_TITLES[ordered[0].check] !== undefined && severity !== "suggestion",
        reportTitle: REPORT_TITLES[ordered[0].check] ?? "",
      });
    }
  }

  if (multi) candidates.push(...conflictCandidates(outlines, label));
  const reviews = reviewBatches(candidates.filter((candidate) => candidate.scope === "all"), origins, pools);
  if (diagnostics) {
    diagnostics.deterministicCandidates = candidates.length;
    diagnostics.positionSearchTargets = reviews.reduce((sum, batch) => sum + batch.checks.length, 0);
    diagnostics.rejected.duplicate = Math.max(0, diagnostics.initialDeterministic - diagnostics.rejected.covered_elsewhere - candidates.length);
  }

  return {
    files,
    coverage: outlines.map((entry) => entry.coverage),
    candidates,
    reviews,
    resolvedCount,
  };
}

/**
 * Related evidence for the meaning-level rebuttal: the same subject, the
 * same metric family, the same slide/page, or a section titled for the
 * subject — never the candidate's own lines, never another party's.
 */
function relatedEvidence(own: readonly Statement[], pool: readonly Statement[]): Statement[] {
  const origins = new Set(own);
  const originTexts = new Set(own.map((statement) => statement.text));
  const originUnits = new Set([...origins].map((statement) => `${statement.fileId}:${statement.unit}`));
  const subjectTokens = [...origins].flatMap((statement) => statement.tokens);
  return pool
    .filter((statement) => !origins.has(statement) && !originTexts.has(statement.text) && !statement.heading
      && !own.some((origin) => differentParties(origin.text, statement.text) || !periodsCompatible(origin.period, statement.period))
      && !pricedMetricMismatch(subjectTokens, statement, own.flatMap((origin) => amountsInWon(origin.text, origin.unitTitle))))
    .map((statement) => {
      const shared = statement.tokens.filter((token) => subjectTokens.includes(token)).length;
      const family = tokensRelate(subjectTokens, statement.tokens) ? 2 : 0;
      const titled = tokensRelate(subjectTokens, contentTokens(statement.unitTitle)) ? 2 : 0;
      const unit = originUnits.has(`${statement.fileId}:${statement.unit}`) ? 1 : 0;
      return { statement, score: shared * 2 + family + titled + unit };
    })
    .filter((entry) => entry.score >= 2)
    .sort((a, b) => b.score - a.score || a.statement.index - b.statement.index)
    .slice(0, REVIEW_ITEMS_PER_CHECK)
    .map((entry) => entry.statement);
}

function reviewBatches(candidates: readonly SupplementCandidate[], origins: ReadonlyMap<string, Statement[]>, pools: ReadonlyMap<string, Statement[]>): SupplementReviewBatch[] {
  const batches: SupplementReviewBatch[] = [];
  let batch: SupplementReviewBatch | undefined;
  let handleOf = new Map<Statement, string>();
  let chars = 0;
  for (const candidate of candidates) {
    const statements = origins.get(candidate.id) ?? [];
    const evidence = relatedEvidence(statements, pools.get(candidate.id) ?? []);
    // Nothing related anywhere: there is nothing a re-check could find.
    if (evidence.length === 0) continue;
    const newItems = evidence.filter((statement) => !handleOf.has(statement));
    const newChars = newItems.reduce((sum, statement) => sum + Math.min(statement.text.length + 9, REVIEW_ITEM_CHARS), 0);
    if (!batch || batch.checks.length >= SUPPLEMENT_REVIEW_MAX_CHECKS || batch.items.length + newItems.length > MAX_EVIDENCE_ITEMS || chars + newChars > MAX_EVIDENCE_CHARS) {
      batch = { checks: [], items: [], sources: {} };
      batches.push(batch);
      handleOf = new Map();
      chars = 0;
    }
    const handles = evidence.map((statement) => {
      let handle = handleOf.get(statement);
      if (!handle) {
        handle = `E${batch!.items.length + 1}`;
        handleOf.set(statement, handle);
        // Lines from another upload are marked so the model weighs them as outside evidence.
        const text = clip(`${statement.fileId !== candidate.fileId ? "[다른 자료] " : ""}${statement.text}`, REVIEW_ITEM_CHARS);
        batch!.items.push({ handle, text });
        batch!.sources[handle] = statement.source;
        chars += text.length;
      }
      return handle;
    });
    batch.checks.push({
      id: `C${batch.checks.length + 1}`,
      candidateId: candidate.id,
      statement: clip(statements.map((statement) => statement.text).join(" / ") || candidate.current, 300),
      requirement: clip(candidate.requirement, 120),
      handles,
    });
  }
  return batches;
}
