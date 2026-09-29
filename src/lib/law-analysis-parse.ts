/**
 * Presentation parsers for `legal_analysis` text. Raw MCP text remains intact
 * for classification; applicable-law decisions and actual excerpts are shown
 * separately, while other modes preserve their established sections.
 */

export interface AnalysisSection {
  heading?: string;
  lines: string[];
}

export interface AnalysisDocument {
  title?: string;
  /** Leading `[MARKER]` on the title line, e.g. HALLUCINATION_DETECTED. */
  titleMarker?: string;
  sections: AnalysisSection[];
}

const TITLE_RE = /^(?:\[([A-Z][A-Z_]+)\]\s*)?(?:═══\s*(.+?)\s*═══|==\s*(.+?)\s*==)$/u;
const HEADING_RE = /^(?:▶\s*(.+)|━━━\s*(.+?)\s*━━━|⚖️\s*(.+))$/u;
/** Notes that follow a blank line start their own block instead of joining the list above. */
const NOTE_RE = /^(?:⚠️|💡|ℹ️|📊|⌛ \[|⟳ \[)/u;
const MARKER_RE = /\[([A-Z][A-Z_]+)\]/gu;

export function analysisMarkers(line: string): string[] {
  return [...line.matchAll(MARKER_RE)].map((match) => match[1]);
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
}

/** Generic split into title and ordered sections; every non-title line is kept. */
export function splitAnalysisText(text: string): AnalysisDocument {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trimEnd());
  const document: AnalysisDocument = { sections: [] };
  let index = 0;
  while (index < lines.length && !lines[index].trim()) index++;
  const title = TITLE_RE.exec(lines[index]?.trim() ?? "");
  if (title) {
    document.title = title[2] ?? title[3];
    if (title[1]) document.titleMarker = title[1];
    index++;
  }
  let current: AnalysisSection = { lines: [] };
  const push = () => {
    current.lines = trimBlankEdges(current.lines);
    if (current.heading || current.lines.length) document.sections.push(current);
  };
  let previousBlank = true;
  for (; index < lines.length; index++) {
    const line = lines[index];
    const heading = HEADING_RE.exec(line.trim());
    if (heading) {
      push();
      current = { heading: heading[1] ?? heading[2] ?? heading[3], lines: [] };
    } else if (previousBlank && NOTE_RE.test(line.trim())) {
      push();
      current = { lines: [line] };
    } else {
      current.lines.push(line);
    }
    previousBlank = !line.trim();
  }
  push();
  return document;
}

/** Separate the MCP's decision text from the statute excerpts it actually returned. */
export function applicableLawPresentation(text: string): {
  title?: string;
  sections: AnalysisSection[];
  excerpts: AnalysisSection[];
  mst?: string;
  jo?: string;
} {
  const parsed = splitAnalysisText(text);
  const sections: AnalysisSection[] = [];
  const excerpts: AnalysisSection[] = [];
  let mst: string | undefined;
  let jo: string | undefined;
  let hasTransition = false;
  for (const section of parsed.sections) {
    const heading = section.heading ?? "";
    if (heading.startsWith("기준일에 시행 중이던 버전")) {
      mst = /\(\s*MST\s+(\d{6})\s*\)/u.exec(section.lines.join("\n"))?.[1];
      sections.push({ heading, lines: section.lines.map((line) => line.replace(/\s*\(\s*MST\s+\d{6}\s*\)/gu, "")) });
    } else if (heading.startsWith("기준일 시점 조문")) {
      jo = /(제[1-9]\d{0,3}조(?:의[1-9]\d?)?)/u.exec(heading)?.[1];
      sections.push({ heading: jo ? `기준일 시행 조문: ${jo}` : "기준일 시행 조문", lines: [] });
      if (section.lines.length) excerpts.push({ heading: "조문 원문", lines: section.lines });
    } else if (heading.startsWith("적용례·경과조치")) {
      hasTransition = true;
      const status = `${heading}\n${section.lines.join("\n")}`;
      if (/\[(?:FAILED|REQUEST_TIMEOUT|UPSTREAM_NO_DATA|ERROR)\]|조회 실패|조회 오류/u.test(status)) {
        sections.push({ heading: "적용례·경과조치: 부칙 조회에 실패했습니다. 부칙 원문을 확인해 주세요.", lines: [] });
      } else if (/\[NOT_FOUND\]|관련 부칙 (?:없음|미제공|자료 없음)/u.test(status)) {
        sections.push({ heading: "적용례·경과조치: 관련 부칙을 찾지 못했습니다.", lines: [] });
      } else if (section.lines.some((line) => /^\s*(?:◆\s*부칙|제\d+조(?:의\d+)?(?:\(|\s))/u.test(line))) {
        sections.push({ heading: "적용례·경과조치: 관련 부칙 발췌를 원문에서 확인해 주세요.", lines: [] });
        excerpts.push({ heading: "부칙 원문", lines: section.lines });
      } else {
        sections.push({ heading: "적용례·경과조치: 관련 부칙에서 경과규정을 확인하지 못했습니다. 부칙 원문을 확인해 주세요.", lines: [] });
      }
    } else {
      sections.push(section);
    }
  }
  if (!hasTransition) sections.push({ heading: "적용례·경과조치: 관련 부칙에서 경과규정을 확인하지 못했습니다. 부칙 원문을 확인해 주세요.", lines: [] });
  return { title: parsed.title, sections, excerpts, mst, jo };
}

export type CitationTone = "verified" | "unknown" | "critical" | "repealed";

export interface CitationItem {
  group: "law" | "case" | "other";
  symbol: "✓" | "✗" | "⚠" | "⌛";
  /** User-facing status; faithful to the MCP symbol, so ⚠ is never upgraded to a failure. */
  label: string;
  tone: CitationTone;
  /** Raw MCP line after the symbol, kept for markers and debugging. */
  text: string;
  markers: string[];
  /** The cited law/article or case number as the lookup identified it. */
  citation: string;
  /** What the lookup found for it: the matched record or the reason it was not confirmed. */
  detail: string;
}

export interface CitationGroupSummary {
  group: "law" | "case";
  total: number;
  /** Non-zero statuses only, in a fixed order, e.g. `확인 1건`. */
  counts: string[];
}

export interface VerifyCitationsResult {
  overallMarker?: string;
  /** The input contained no law or case citation to verify — not a lookup failure. */
  empty: boolean;
  groups: CitationGroupSummary[];
  items: CitationItem[];
  notes: AnalysisSection[];
}

const CITATION_LINE_RE = /^\s*([✓✗⚠⌛])\s*(.*)$/u;
const GROUP_TOTAL_RE = /^\s*(법령|판례) 인용 (\d+)건\s*\|/u;

/** MCP wording that describes the lookup in implementation terms, mapped once to reader wording. */
const CITATION_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\[[A-Z][A-Z_]+\]\s*/gu, ""],
  [/실존할 수 없는 사건번호/gu, "유효하지 않은 사건번호"],
  [/실존했으나 현행 법령이 아님/gu, "현행 법령이 아님"],
  [/법제처 DB/gu, "법제처 자료"],
  [/API 응답 형식 이상/gu, "자료 응답 형식 이상"],
  [/API 일시 실패/gu, "자료 조회 일시 실패"],
  [/\s*\(법령ID [^)]*\)/gu, ""],
  [/ 실존(?=$|[,.])/gu, " 확인"],
];

function citationPhrase(text: string): string {
  return CITATION_PHRASES.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text).trim();
}

const STATUS_ORDER = ["확인됨", "찾을 수 없음", "내용 불일치", "확인할 수 없음", "확인되지 않음", "폐지 법령", "확인 필요", "호 확인 중", "호 확인 필요", "조회 실패", "검증하지 않음"];

function citationStatus(symbol: CitationItem["symbol"], text: string, group: CitationItem["group"]): Pick<CitationItem, "label" | "tone"> {
  if (symbol === "✓") return { label: "확인됨", tone: "verified" };
  if (symbol === "⌛") return { label: "폐지 법령", tone: "repealed" };
  if (symbol === "⚠") {
    if (/조회 실패/u.test(text)) return { label: "조회 실패", tone: "unknown" };
    if (/확인 상한/u.test(text)) return { label: "검증하지 않음", tone: "unknown" };
    // A case missing from the 법제처 collection may still exist (lower courts, unpublished decisions).
    return { label: group === "case" ? "확인되지 않음" : "확인 필요", tone: "unknown" };
  }
  if (text.includes("[CONTENT_MISMATCH]")) return { label: "내용 불일치", tone: "critical" };
  return { label: group === "case" ? "확인할 수 없음" : "찾을 수 없음", tone: "critical" };
}

/** Split `민법 제750조(…) 실존` / `2013다61381 실존 — 대법원 …` / `형법 제9999조 — [NOT_FOUND] …` into citation and finding. */
function citationParts(symbol: CitationItem["symbol"], text: string, group: CitationItem["group"]): Pick<CitationItem, "citation" | "detail"> {
  if (symbol === "✓") {
    const match = /^(.*?)\s+실존(?:\s*·\s*(제목 일치))?(?:\s+—\s+(.*))?$/u.exec(text);
    if (match) {
      const found = group === "case" ? match[3] ?? "법제처 판례 자료에서 확인" : "법제처 법령 자료에서 조문 확인";
      return { citation: match[1], detail: citationPhrase(match[2] ? `${found} · 인용 제목 일치` : found) };
    }
  }
  const partial = /^(.*?)\s+실존,\s*(.*)$/u.exec(text);
  if (partial) return { citation: partial[1], detail: citationPhrase(`조문은 확인, ${partial[2]}`) };
  const separator = text.indexOf(" — ");
  if (separator < 0) return { citation: citationPhrase(text), detail: "" };
  return { citation: text.slice(0, separator).trim(), detail: citationPhrase(text.slice(separator + 3)) };
}

/**
 * MCP notes addressed to the calling agent are either restated by the overall
 * verdict (hallucination/repealed banners) or rewritten for the reader; any
 * other note is kept as it is.
 */
function citationNote(section: AnalysisSection): AnalysisSection | undefined {
  const first = section.lines[0]?.trim() ?? "";
  const markers = analysisMarkers(first);
  if (!section.heading && (markers.includes("HALLUCINATION_DETECTED") || markers.includes("REPEALED_REFERENCE"))) return undefined;
  if (!section.heading && markers.includes("RENAMED_REFERENCE")) {
    return { lines: ["옛 법령명으로 인용한 항목이 있습니다. 현행 법령명으로 고치고, 조문 번호는 시점별 적용 법령에서 다시 확인해 주세요."] };
  }
  if (first.startsWith("💡 ⚠ 항목은")) {
    return { lines: ["확인 필요 항목은 법령명이 불명확하거나 일부만 일치했거나 자료 조회가 일시적으로 실패한 경우입니다. 법령명을 명시하거나 다시 시도해 주세요."] };
  }
  if (first.startsWith("💡 판례 '미확인'")) {
    return { lines: ["확인되지 않은 판례가 존재하지 않는다는 뜻은 아닙니다. 법제처 수록 판례는 대법원 중심이라 하급심·미수록 판례는 검색되지 않을 수 있으니 판례·결정례 검색에서 함께 확인해 주세요."] };
  }
  return section;
}

export function verifyCitationsResult(text: string): VerifyCitationsResult {
  const document = splitAnalysisText(text);
  const firstLine = document.sections[0]?.lines[0] ?? "";
  const result: VerifyCitationsResult = {
    overallMarker: document.titleMarker,
    empty: !document.titleMarker && analysisMarkers(firstLine).includes("NO_CITATIONS_FOUND"),
    groups: [],
    items: [],
    notes: [],
  };
  if (result.empty) return result;
  const totals = new Map<string, number>();
  for (const section of document.sections) {
    const group = section.heading === "법령 인용" ? "law" : section.heading === "판례 인용" ? "case" : undefined;
    if (!group) {
      const totalLines = section.lines.filter((line) => GROUP_TOTAL_RE.test(line));
      if (!section.heading && totalLines.length && !result.items.length) {
        for (const line of totalLines) {
          const match = GROUP_TOTAL_RE.exec(line)!;
          totals.set(match[1] === "법령" ? "law" : "case", Number(match[2]));
        }
        const rest = trimBlankEdges(section.lines.filter((line) => !GROUP_TOTAL_RE.test(line)));
        if (rest.length) result.notes.push({ lines: rest });
        continue;
      }
      const note = citationNote(section);
      if (note) result.notes.push(note);
      continue;
    }
    const leftover: string[] = [];
    for (const line of section.lines) {
      const match = CITATION_LINE_RE.exec(line);
      if (!match) {
        leftover.push(line);
        continue;
      }
      const symbol = match[1] as CitationItem["symbol"];
      result.items.push({
        group, symbol, text: match[2], markers: analysisMarkers(line),
        ...citationStatus(symbol, match[2], group),
        ...citationParts(symbol, match[2], group),
      });
    }
    if (trimBlankEdges(leftover).length) result.notes.push({ heading: section.heading, lines: trimBlankEdges(leftover) });
  }
  result.groups = (["law", "case"] as const).map((group) => {
    const items = result.items.filter((item) => item.group === group);
    return { group, total: Math.max(totals.get(group) ?? 0, items.length), counts: citationCounts(items) };
  });
  return result;
}

/** Non-zero statuses in a fixed order, e.g. `확인 1건 · 찾을 수 없음 1건`. */
export function citationCounts(items: readonly Pick<CitationItem, "label">[]): string[] {
  return STATUS_ORDER.flatMap((label) => {
    const count = items.filter((item) => item.label === label).length;
    return count ? [`${label === "확인됨" ? "확인" : label} ${count}건`] : [];
  });
}

/** One-line reading of a group summary, e.g. `법령 인용 1건 · 확인 1건` or `판례 인용 없음`. */
export function citationGroupLine(summary: CitationGroupSummary): string {
  const name = summary.group === "law" ? "법령 인용" : "판례 인용";
  return summary.total ? [`${name} ${summary.total}건`, ...summary.counts].join(" · ") : `${name} 없음`;
}

/** Overall verdict wording mirrors the MCP header marker without adding a stronger conclusion. */
export function citationOverallLabel(marker?: string): string | undefined {
  switch (marker) {
    case "VERIFIED": return "추출된 인용이 모두 확인되었습니다.";
    case "PARTIAL_VERIFIED": return "확인이 필요한 인용이 있습니다.";
    case "REPEALED_REFERENCE": return "폐지된 법령을 인용한 항목이 있습니다. 후속·대체 법령을 확인해 주세요.";
    case "HALLUCINATION_DETECTED": return "법제처 자료에서 확인되지 않거나 인용 내용이 실제와 다른 항목이 있습니다.";
    default: return undefined;
  }
}

export interface CiteCheckResult {
  title?: string;
  target: string[];
  /** `lines` is the reader's wording of the MCP verdict; the MCP's certainty level is kept as is. */
  verdict?: { symbol: string; text: string; lines: string[]; tone: "critical" | "unknown" | "neutral" | "muted" };
  sections: AnalysisSection[];
  limitation: string[];
}

const VERDICT_RE = /^📊\s*판정:\s*(❌|⚠️|✅|ℹ️)?\s*(.*)$/u;

export const CITATOR_LIMITATION = "후속 판례를 기준으로 자동 확인한 결과입니다. 법제처에 수록된 판례(대법원 중심)만 확인하며 하급심·미수록 판례의 인용은 포함되지 않습니다. 최종 판단이 필요한 경우 후속 판결 원문과 종합법률정보를 함께 확인해 주세요.";

/**
 * Reader wording for each verdict the citator produces. "Not detected" stays
 * "could not confirm" — never "none" or "still valid".
 */
function citatorVerdictLines(text: string): string[] {
  const [head, ...rest] = text.split("\n").map((line) => line.trim()).filter(Boolean);
  let match = /^후속 인용 (\d+)건, 변경·폐기 신호 미감지 — 계속 인용되는 것으로 추정\s*(?:\(전원합의체 (\d+)건 포함 정밀 스캔 완료\))?$/u.exec(head);
  if (match) {
    return [`후속 인용 ${match[1]}건에서 변경·폐기 정황을 확인하지 못했습니다. 현재까지 계속 인용되는 것으로 보입니다.${match[2] ? ` (후속 전원합의체 판결 ${match[2]}건 포함 본문 확인)` : ""}`];
  }
  match = /^변경·폐기 신호 감지 — (.+)$/u.exec(head);
  if (match) {
    return [`후속 판례에서 변경·폐기 정황이 발견되었습니다: ${match[1]}`, "이 판례를 현재 법리로 인용하기 전에 해당 후속 판결 원문을 반드시 확인해 주세요."];
  }
  match = /^미스캔 전원합의체 후속 판결 (\d+)건 존재 — 법리 변경 여부 본문 확인 권장 \((.+)\)$/u.exec(head);
  if (match) {
    return [`본문을 확인하지 못한 후속 전원합의체 판결이 ${match[1]}건 있습니다 (${match[2]}). 법리 변경 여부는 해당 판결 원문에서 확인해 주세요.`];
  }
  match = /^후속 인용 (\d+)건, 정밀 스캔 대상 (\d+)건 중 (\d+)건 본문 확인 불가: 변경·폐기 여부 미확정 \(([^)]+)\)/u.exec(head);
  if (match) {
    return [`후속 인용 ${match[1]}건 중 본문 확인 대상 ${match[2]}건에서 ${match[3]}건의 본문을 확인하지 못해 변경·폐기 여부를 확정하지 못했습니다 (${match[4]}). 해당 판결 원문을 확인해 주세요.`];
  }
  if (/^법제처 수록 범위 내 후속 인용 없음/u.test(head)) {
    return ["법제처 수록 범위에서 이 판례를 인용한 후속 판례를 찾지 못했습니다. 수록되지 않은 판례에서 인용되었을 가능성은 있습니다."];
  }
  return [head, ...rest.map((line) => line.replace(/^⚠️\s*/u, ""))].filter(Boolean);
}

/** Target lines whose MCP wording points the agent at a tool; reworded for the reader. */
function citatorTargetLine(line: string): string {
  return /^\s*⚠ 대상 판례 본문 조회 실패/u.test(line)
    ? "⚠ 대상 판례 본문을 조회하지 못해 판시사항·참조판례를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요."
    : line;
}

function citatorSection(section: AnalysisSection): AnalysisSection {
  return {
    heading: section.heading?.replace(/^본문 정밀 스캔/u, "후속 판결 본문 확인"),
    lines: section.lines
      .filter((line) => !/^\s*↳ .*cite_check\(/u.test(line))
      .map((line) => line.replace(/\s*\(조회 실패 또는 본문 미제공, 스캔 못 함\)/u, " (조회 실패 또는 본문 미제공)")),
  };
}

export function citeCheckResult(text: string): CiteCheckResult {
  const document = splitAnalysisText(text);
  const result: CiteCheckResult = { title: document.title, target: [], sections: [], limitation: [] };
  document.sections.forEach((section, index) => {
    const first = section.lines[0]?.trim() ?? "";
    const verdict = !section.heading && VERDICT_RE.exec(first);
    if (verdict) {
      const symbol = verdict[1] ?? "";
      const tone = symbol === "❌" ? "critical" : symbol === "⚠️" ? "unknown" : symbol === "✅" ? "neutral" : "muted";
      const raw = [verdict[2], ...section.lines.slice(1).map((line) => line.trim())].filter(Boolean).join("\n");
      result.verdict = { symbol, tone, text: raw, lines: citatorVerdictLines(raw) };
    } else if (!section.heading && first.startsWith("⚠️ 한계")) {
      result.limitation = [CITATOR_LIMITATION];
    } else if (!section.heading && index === 0) {
      result.target = section.lines.map(citatorTargetLine);
    } else {
      result.sections.push(citatorSection(section));
    }
  });
  return result;
}

export interface ImpactAxis {
  label: string;
  value: string;
  /** The MCP could not query this axis; its count is unknown, never zero. */
  failed: boolean;
  items: string[];
}

export interface ImpactMapResult {
  title?: string;
  sections: AnalysisSection[];
  /** Index into `sections` whose tree lines were parsed into `axes`. */
  graphIndex: number;
  axes: ImpactAxis[];
  graphNotes: string[];
}

const AXIS_RE = /^[├└]─\s*(.+?):\s*(.*)$/u;
const AXIS_ITEM_RE = /^[│\s]*•\s*(.+)$/u;

export function impactMapResult(text: string): ImpactMapResult {
  const document = splitAnalysisText(text);
  const graphIndex = document.sections.findIndex((section) => section.heading?.startsWith("영향 그래프"));
  const axes: ImpactAxis[] = [];
  const graphNotes: string[] = [];
  for (const line of graphIndex >= 0 ? document.sections[graphIndex].lines : []) {
    const axis = AXIS_RE.exec(line.trim());
    const item = AXIS_ITEM_RE.exec(line);
    if (axis) axes.push({ label: axis[1], value: axis[2], failed: /조회 실패/u.test(axis[2]), items: [] });
    else if (item && axes.length) axes[axes.length - 1].items.push(item[1]);
    else if (line.trim()) graphNotes.push(line.trim());
  }
  return { title: document.title, sections: document.sections, graphIndex, axes, graphNotes };
}
