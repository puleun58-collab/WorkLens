/**
 * Presentation parsers for `legal_analysis` text. Each mode keeps only the
 * structure its MCP output reliably has; every other line stays in an ordered
 * section so nothing the MCP said is dropped. The complete text is always
 * rendered separately as the source fallback.
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
const NOTE_RE = /^(?:⚠️|💡|ℹ️|📊|⌛ \[)/u;
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

export type CitationTone = "verified" | "unknown" | "critical" | "repealed";

export interface CitationItem {
  group: "law" | "case" | "other";
  symbol: "✓" | "✗" | "⚠" | "⌛";
  /** Faithful to the MCP symbol: ⚠ is never upgraded to a failure. */
  label: string;
  tone: CitationTone;
  text: string;
  markers: string[];
}

export interface VerifyCitationsResult {
  overallMarker?: string;
  summary: string[];
  items: CitationItem[];
  notes: AnalysisSection[];
}

const CITATION_LINE_RE = /^\s*([✓✗⚠⌛])\s*(.*)$/u;

function citationStatus(symbol: CitationItem["symbol"], text: string, group: CitationItem["group"]): Pick<CitationItem, "label" | "tone"> {
  if (symbol === "✓") return { label: "실존 확인", tone: "verified" };
  if (symbol === "⌛") return { label: "폐지 법령", tone: "repealed" };
  if (symbol === "⚠") return { label: group === "case" ? "미확인" : "확인 필요", tone: "unknown" };
  if (text.includes("[CONTENT_MISMATCH]")) return { label: "내용 불일치", tone: "critical" };
  return { label: group === "case" ? "실존 불가" : "찾을 수 없음", tone: "critical" };
}

export function verifyCitationsResult(text: string): VerifyCitationsResult {
  const document = splitAnalysisText(text);
  const result: VerifyCitationsResult = { overallMarker: document.titleMarker, summary: [], items: [], notes: [] };
  for (const section of document.sections) {
    const group = section.heading === "법령 인용" ? "law" : section.heading === "판례 인용" ? "case" : undefined;
    if (!group) {
      if (!section.heading && !result.items.length && !result.notes.length && !result.summary.length) result.summary = section.lines;
      else result.notes.push(section);
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
      result.items.push({ group, symbol, text: match[2], markers: analysisMarkers(line), ...citationStatus(symbol, match[2], group) });
    }
    if (trimBlankEdges(leftover).length) result.notes.push({ heading: section.heading, lines: trimBlankEdges(leftover) });
  }
  return result;
}

/** Overall verdict wording mirrors the MCP header marker without adding a stronger conclusion. */
export function citationOverallLabel(marker?: string): string | undefined {
  switch (marker) {
    case "VERIFIED": return "추출된 인용이 모두 실존으로 확인되었습니다.";
    case "PARTIAL_VERIFIED": return "확인이 필요한 인용이 있습니다.";
    case "REPEALED_REFERENCE": return "폐지된 법령을 인용한 항목이 있습니다.";
    case "HALLUCINATION_DETECTED": return "실존하지 않거나 인용 내용이 실제와 다른 항목이 있습니다.";
    default: return undefined;
  }
}

export interface CiteCheckResult {
  title?: string;
  target: string[];
  verdict?: { symbol: string; text: string; tone: "critical" | "unknown" | "neutral" | "muted" };
  sections: AnalysisSection[];
  limitation: string[];
}

const VERDICT_RE = /^📊\s*판정:\s*(❌|⚠️|✅|ℹ️)?\s*(.*)$/u;

export function citeCheckResult(text: string): CiteCheckResult {
  const document = splitAnalysisText(text);
  const result: CiteCheckResult = { title: document.title, target: [], sections: [], limitation: [] };
  document.sections.forEach((section, index) => {
    const first = section.lines[0]?.trim() ?? "";
    const verdict = !section.heading && VERDICT_RE.exec(first);
    if (verdict) {
      const symbol = verdict[1] ?? "";
      const tone = symbol === "❌" ? "critical" : symbol === "⚠️" ? "unknown" : symbol === "✅" ? "neutral" : "muted";
      result.verdict = { symbol, tone, text: [verdict[2], ...section.lines.slice(1).map((line) => line.trim())].filter(Boolean).join("\n") };
    } else if (!section.heading && first.startsWith("⚠️ 한계")) {
      result.limitation = section.lines.map((line) => line.trim());
    } else if (!section.heading && index === 0) {
      result.target = section.lines;
    } else {
      result.sections.push(section);
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
