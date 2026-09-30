import type { NormalizedDocument, SourceRef, TableBlock } from "@/domain/document";
import {
  type SupplementCandidate,
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
  UP_WORD,
} from "./text";

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
}

interface FileOutline {
  document: NormalizedDocument;
  fileName: string;
  statements: Statement[];
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

function outline(document: NormalizedDocument, fileName: string): FileOutline {
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
  if (document.warnings.includes("PPTX_IMAGE_OMITTED")) notes.push("이미지 안의 글자는 읽지 않습니다.");
  const readUnits = new Set(statements.map((statement) => statement.unit)).size;
  return {
    document,
    fileName,
    statements,
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
  performance: /(실적|매출|판매|달성|영업이익|성과|KPI|수주)/giu,
  cost: /(비용|원가|예산|지출|경비|물류비|운송비|인건비|집행)/giu,
  project: /(프로젝트|진행률|진척|마일스톤|착수|구축|WBS|오픈\s?일정)/giu,
  operation: /(운영\s?(현황|보고|실적)|가동|처리량|서비스\s?수준|SLA)/giu,
  issue: /(이슈|장애|사고|불량|클레임|민원|결함|재발)/giu,
  improvement: /(개선안|개선\s?방안|개선\s?과제|개선\s?제안|As-Is|To-Be|기대\s?효과)/giu,
  plan: /(추진\s?계획|실행\s?계획|로드맵|추진\s?일정|사업\s?계획|계획서)/giu,
  management: /(경영\s?(보고|현황|회의)|이사회|경영진)/giu,
};

function classify(fileName: string, statements: readonly Statement[]): SupplementDocType {
  const titles = [fileName.replace(/\.[^.]+$/u, ""), ...new Set(statements.filter((statement) => statement.heading).map((statement) => statement.text))].join(" ");
  const body = statements.map((statement) => statement.text).join(" ");
  const scores = (Object.keys(TYPE_KEYWORDS) as Array<keyof typeof TYPE_KEYWORDS>).map((type) => {
    const title = titles.match(TYPE_KEYWORDS[type])?.length ?? 0;
    const text = body.match(TYPE_KEYWORDS[type])?.length ?? 0;
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
  conclusion: row({}, "conditional"),
};

// ── Triggers ─────────────────────────────────────────────────────────────

interface Change {
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

interface Issue { phrase: string; tokens: string[] }

function detectIssue(statement: Statement): Issue | undefined {
  if (statement.heading) return undefined;
  const text = statement.text;
  const match = ISSUE_WORD.exec(text);
  if (!match || !ISSUE_OCCURRENCE.test(text) || ISSUE_RESOLVED.test(text)) return undefined;
  // "원인: …", "영향: …" lines explain a problem already stated; they are not a new one.
  if (/^[\s•\-–·▶■□○●]*(원인|영향|배경|사유|대응|조치|대책|결과|비고|요인)\s?[:：]/u.test(text)) return undefined;
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
  // Bullets under an action heading are actions even without a verb.
  return ACTION_HEADING.test(statement.unitTitle) && text.length >= 6 && !OWNER_CUE.test(text) && !SCHEDULE_CUE.test(text) && !/^(구분|항목|내용)$/u.test(text);
}

function isConclusion(statement: Statement): boolean {
  if (statement.heading || !JUDGEMENT.test(statement.text)) return false;
  return CONCLUSION_HEADING.test(statement.unitTitle) || CONCLUSION_MARKER.test(statement.text) || /(향후|앞으로|전망)/u.test(statement.text);
}

// ── Candidates ───────────────────────────────────────────────────────────

interface Member {
  statement: Statement;
  check: SupplementCheck;
  severity: SupplementSeverity;
  groupKey: string;
  subject: string;
  subjectTokens: string[];
  /** Text of the gap in the reader's words. */
  phrase: string;
  change?: Change;
  combined?: boolean;
}

const SEVERITY_RANK: Record<SupplementSeverity, number> = { critical: 0, warning: 1, suggestion: 2 };

function inUnit(all: readonly Statement[], statement: Statement): Statement[] {
  return all.filter((other) => other.fileId === statement.fileId && other.unit === statement.unit);
}

/**
 * The document-wide rebuttal: does any other readable location supply the
 * missing information for this subject? Same-unit statements count without a
 * subject match — a slide is one argument.
 */
function rebut(all: readonly Statement[], origin: Statement, cue: RegExp, subjectTokens: readonly string[], options: { sameUnit?: boolean; needSubject?: boolean } = {}): Statement | undefined {
  return all.find((other) => {
    if (other === origin || !cue.test(other.text)) return false;
    const sameUnit = other.fileId === origin.fileId && other.unit === origin.unit;
    if (sameUnit && options.sameUnit !== false && !options.needSubject) return true;
    const titleRelates = tokensRelate(subjectTokens, contentTokens(other.unitTitle));
    return tokensRelate(subjectTokens, other.tokens) || (titleRelates && !other.heading);
  });
}

function candidatesFor(outline: FileOutline, docType: SupplementDocType, all: readonly Statement[]): { members: Member[]; resolved: number } {
  const members: Member[] = [];
  let resolved = 0;
  const need = (check: SupplementCheck) => NECESSITY[check][docType];
  const statements = outline.statements;

  const changes = new Map<Statement, Change>();
  const issues = new Map<Statement, Issue>();
  for (const statement of statements) {
    const change = detectChange(statement);
    if (change) changes.set(statement, change);
    const issue = detectIssue(statement);
    if (issue && !(change && change.adverse === false)) issues.set(statement, issue);
  }
  const isProblem = (other: Statement) => issues.has(other) || (changes.get(other)?.adverse === true && (changes.get(other)?.percent ?? 100) >= 10);
  const unitHasProblem = (statement: Statement) => inUnit(statements, statement).some(isProblem);
  const fileHasProblem = statements.some(isProblem);

  // 원인: significant changes, adverse ones first.
  for (const [statement, change] of changes) {
    const necessity = need("cause");
    if (necessity === "none" || statement.heading) continue;
    const size = change.percent ?? 100;
    let severity: SupplementSeverity | undefined;
    if (change.adverse === true && size >= 10) severity = necessity === "required" ? "critical" : size >= 15 ? "warning" : undefined;
    else if (change.adverse === undefined && size >= 15 && necessity === "required") severity = "warning";
    if (!severity || necessity === "recommended") continue;
    if (CAUSE_CUE.test(statement.text) || rebut(all, statement, CAUSE_CUE, change.subjectTokens, { needSubject: false })) { resolved += 1; continue; }
    const family = familyOf(change.subject);
    members.push({ statement, check: "cause", severity, groupKey: `cause:${family?.key ?? change.subject}:${change.direction}`, subject: change.subject, subjectTokens: change.subjectTokens, phrase: change.subject, change });
  }

  // 비교 기준: KPI levels shown without any reference.
  for (const statement of statements) {
    const necessity = need("baseline");
    if (necessity === "none" || necessity === "recommended" || changes.has(statement)) continue;
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
    if (issues.has(statement) || statement.heading || change.adverse !== true || (change.percent ?? 100) < 15) continue;
    // A cost or sales swing needs its cause everywhere, but a follow-up plan only
    // where the report exists to drive action (issue, project reports).
    if (need("response") !== "required") continue;
    if (rebut(all, statement, RESPONSE_CUE, change.subjectTokens) || hasActionFor(all, statement, change.subjectTokens)) { resolved += 1; continue; }
    const phrase = `${change.subject}${change.percentText ? ` ${change.percentText}` : ""} ${change.direction === "up" ? "증가" : "감소"}`;
    members.push({ statement, check: "response", severity: "warning", groupKey: `response:${familyOf(change.subject)?.key ?? change.subject}`, subject: phrase, subjectTokens: change.subjectTokens, phrase, change });
  }

  // 담당 · 일정: commitments that cannot be tracked.
  for (const statement of statements) {
    if (!isAction(statement) || issues.has(statement)) continue;
    const ownerNeed = need("owner");
    const strong = ownerNeed === "required"
      || (ownerNeed === "conditional" && (unitHasProblem(statement) || (fileHasProblem && ACTION_HEADING.test(statement.unitTitle))));
    if (!strong) continue;
    const action = clip(statement.text.replace(/^[\s•\-–·▶■□○●\d.)]+/u, ""), 30);
    const unitStatements = inUnit(statements, statement);
    const actionTokens = statement.tokens;
    const covered = (cue: RegExp) => cue.test(statement.text)
      || unitStatements.some((other) => other !== statement && cue.test(other.text))
      || all.some((other) => other !== statement && other.unit !== statement.unit && cue.test(other.text) && tokensRelate(actionTokens, other.tokens) && (ACTION_HEADING.test(other.unitTitle) || /(담당|일정|기한|책임|R&R)/u.test(other.unitTitle) || actionTokens.filter((token) => other.tokens.includes(token)).length >= 2));
    const noOwner = !covered(OWNER_CUE);
    const noSchedule = !covered(SCHEDULE_CUE);
    if (!noOwner && !noSchedule) { resolved += 1; continue; }
    const check: SupplementCheck = noOwner ? "owner" : "schedule";
    members.push({ statement, check, severity: "warning", groupKey: noOwner && noSchedule ? "owner+schedule" : check, subject: action, subjectTokens: actionTokens, phrase: action, combined: noOwner && noSchedule });
  }

  // 결론 근거: judgements with nothing related that argues for them.
  for (const statement of statements) {
    if (!isConclusion(statement)) continue;
    const keys = statement.tokens.filter((token) => !/^(향후|앞으로|부담|수준|영향|효과|상황|측면)$/u.test(token));
    if (keys.length === 0) continue;
    const support = all.find((other) => other !== statement && !isConclusion(other) && REASON_CUE.test(other.text) && tokensRelate(keys, other.tokens));
    if (support) { resolved += 1; continue; }
    members.push({ statement, check: "conclusion", severity: "critical", groupKey: `conclusion:${statement.index}`, subject: clip(statement.text, 40), subjectTokens: keys, phrase: clip(statement.text, 40) });
  }
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

// ── Grouping and wording ─────────────────────────────────────────────────

const TITLES: Record<string, string> = {
  baseline: "비교 기준 확인 필요",
  cause: "원인 설명 확인 필요",
  impact: "영향 설명 확인 필요",
  response: "대응 확인 필요",
  owner: "담당 확인 필요",
  schedule: "일정 확인 필요",
  "owner+schedule": "담당 및 일정 확인 필요",
  conclusion: "결론 근거 확인 필요",
};

const REASONS: Record<string, string> = {
  baseline: "기준이 없으면 이 수치가 좋은지 나쁜지 판단하기 어렵습니다.",
  cause: "변화 폭이 커서 보고받는 사람이 먼저 원인을 물을 가능성이 높습니다.",
  impact: "영향 범위를 알아야 우선순위와 대응 수준을 정할 수 있습니다.",
  response: "문제가 제시되면 보고받는 사람은 후속 조치를 먼저 확인합니다.",
  owner: "책임 주체가 없으면 실행 여부를 추적하기 어렵습니다.",
  schedule: "완료 시점이 없으면 진행 상황을 점검하기 어렵습니다.",
  "owner+schedule": "책임 주체와 완료 시점이 없으면 실행 여부를 추적하기 어렵습니다.",
  conclusion: "근거가 드러나지 않은 판단은 의사결정에 그대로 쓰기 어렵습니다.",
};

function wording(kind: string, members: readonly Member[]): { title: string; message: string; additions: string[]; question?: string; requirement: string } {
  const [lead] = members;
  const title = TITLES[kind];
  const distinct = [...new Set(members.map((member) => member.subject))];
  switch (kind) {
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
    default: {
      const what = kind === "owner" ? "담당" : kind === "schedule" ? "완료 시점" : "담당과 완료 시점";
      const single = members.length === 1;
      const action = `'${lead.phrase}'`;
      return {
        title,
        message: single
          ? `${action} 실행 항목의 ${what}${josa(what, "을/를")} 현재 자료에서 확인하지 못했습니다.`
          : `실행 항목 ${members.length}건의 ${what}${josa(what, "을/를")} 현재 자료에서 확인하지 못했습니다.`,
        additions: kind === "owner" ? ["담당 부서 또는 담당자"] : kind === "schedule" ? ["완료 목표 시점", "중간 점검 시점"] : ["담당 부서 또는 담당자", "완료 목표 시점"],
        question: `${single ? `${action}${josa(lead.phrase, "은/는")} ` : ""}${kind === "owner" ? "누가 담당합니까?" : kind === "schedule" ? "언제까지 완료합니까?" : "누가 언제까지 완료합니까?"}`,
        requirement: `이 실행 항목의 ${kind === "owner" ? "담당 부서나 담당자" : kind === "schedule" ? "완료 시점이나 기한" : "담당 부서·담당자와 완료 시점"}`,
      };
    }
  }
}

// ── Draft ────────────────────────────────────────────────────────────────

export interface SupplementInput { document: NormalizedDocument; fileName: string }

export function buildSupplementDraft(inputs: readonly SupplementInput[]): SupplementDraft {
  const outlines = inputs.map((input) => outline(input.document, input.fileName));
  const all = outlines.flatMap((entry) => entry.statements);
  const files: SupplementFileSummary[] = [];
  const candidates: SupplementCandidate[] = [];
  const origins = new Map<string, Statement[]>();
  let resolvedCount = 0;

  for (const entry of outlines) {
    const docType = classify(entry.fileName, entry.statements);
    files.push({ fileId: entry.document.fileId, fileName: entry.fileName, docType });
    const { members, resolved } = candidatesFor(entry, docType, all);
    resolvedCount += resolved;
    const groups = new Map<string, Member[]>();
    for (const member of members) groups.set(member.groupKey, [...(groups.get(member.groupKey) ?? []), member]);
    const limitation = entry.coverage.complete ? undefined : entry.coverage.notes.join(" ");
    for (const [key, group] of groups) {
      const ordered = [...group].sort((a, b) => a.statement.index - b.statement.index);
      const kind = key === "owner+schedule" ? key : ordered[0].check;
      const text = wording(kind, ordered);
      const severity = ordered.reduce<SupplementSeverity>((best, member) => SEVERITY_RANK[member.severity] < SEVERITY_RANK[best] ? member.severity : best, "suggestion");
      const locations = [...new Set(ordered.map((member) => member.statement.unitLabel))];
      const id = `${entry.document.fileId}:${key}`;
      origins.set(id, ordered.slice(0, 2).map((member) => member.statement));
      candidates.push({
        id,
        fileId: entry.document.fileId,
        check: ordered[0].check,
        severity,
        status: limitation ? "unverified" : "missing",
        title: text.title,
        message: limitation ? `${text.message.replace(/ 현재 자료에서 /u, " 현재 읽은 범위에서 ")}` : text.message,
        reason: REASONS[kind],
        current: clip(ordered[0].statement.text, 160),
        sources: ordered.map((member) => member.statement.source),
        locations,
        additions: text.additions,
        ...(severity !== "suggestion" && text.question ? { question: text.question } : {}),
        ...(limitation ? { limitation: `읽지 못한 영역에 관련 내용이 있을 수 있어 확정하지 않았습니다. ${limitation}` } : {}),
        requirement: text.requirement,
      });
    }
  }

  return {
    files,
    coverage: outlines.map((entry) => entry.coverage),
    candidates,
    reviews: reviewBatches(candidates, origins, all),
    resolvedCount,
  };
}

/**
 * Related evidence for the meaning-level rebuttal: the same subject, the
 * same metric family, or the same slide/page, never the candidate's own lines.
 */
function relatedEvidence(own: readonly Statement[], all: readonly Statement[]): Statement[] {
  const origins = new Set(own);
  const originUnits = new Set([...origins].map((statement) => `${statement.fileId}:${statement.unit}`));
  const subjectTokens = [...origins].flatMap((statement) => statement.tokens);
  return all
    .filter((statement) => !origins.has(statement) && !statement.heading)
    .map((statement) => {
      const shared = statement.tokens.filter((token) => subjectTokens.includes(token)).length;
      const family = tokensRelate(subjectTokens, statement.tokens) ? 2 : 0;
      const unit = originUnits.has(`${statement.fileId}:${statement.unit}`) ? 1 : 0;
      return { statement, score: shared * 2 + family + unit };
    })
    .filter((entry) => entry.score >= 2)
    .sort((a, b) => b.score - a.score || a.statement.index - b.statement.index)
    .slice(0, REVIEW_ITEMS_PER_CHECK)
    .map((entry) => entry.statement);
}

function reviewBatches(candidates: readonly SupplementCandidate[], origins: ReadonlyMap<string, Statement[]>, all: readonly Statement[]): SupplementReviewBatch[] {
  const batches: SupplementReviewBatch[] = [];
  let batch: SupplementReviewBatch | undefined;
  let handleOf = new Map<Statement, string>();
  let chars = 0;
  for (const candidate of candidates) {
    const statements = origins.get(candidate.id) ?? [];
    const evidence = relatedEvidence(statements, all);
    // Nothing related anywhere: there is nothing a re-check could find.
    if (evidence.length === 0) continue;
    const newItems = evidence.filter((statement) => !handleOf.has(statement));
    const newChars = newItems.reduce((sum, statement) => sum + Math.min(statement.text.length, REVIEW_ITEM_CHARS), 0);
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
        const text = clip(statement.text, REVIEW_ITEM_CHARS);
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
