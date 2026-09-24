import { analysisMarkers, splitAnalysisText, type AnalysisSection } from "@/lib/law-analysis-parse";

/**
 * `legal_research` chains all emit `═══ title ═══` + `▶ section` blocks. Sections
 * are kept in order and verbatim; a section is only flagged, never dropped or
 * rewritten, when the MCP itself marked it failed or cut by the time limit.
 */
export interface ResearchSection extends AnalysisSection {
  /** MCP marked this section `[NOT_FOUND / FAILED]`, `[FAILED]` or `⏱` time-limited — not the same as "no results". */
  unavailable: boolean;
  markers: string[];
}

export interface ResearchDocument {
  title?: string;
  sections: ResearchSection[];
  /** Data sources evidenced by the text; the MCP relays 법제처 data unless another source is named. */
  sources: string[];
}

const UNAVAILABLE_HEADING = /\[(?:NOT_FOUND \/ FAILED|FAILED)\]/u;

export function researchResult(text: string): ResearchDocument {
  const document = splitAnalysisText(text);
  const sections = document.sections.map((section) => {
    const all = [section.heading ?? "", ...section.lines];
    return {
      ...section,
      unavailable: UNAVAILABLE_HEADING.test(section.heading ?? "") || section.lines.some((line) => line.trim().startsWith("⏱")),
      markers: [...new Set(all.flatMap(analysisMarkers))],
    };
  });
  const sources = ["법제처 국가법령정보센터 OPEN API"];
  if (/국세법령정보|국세청\s*(?:법령)?해석/u.test(text)) sources.push("국세법령정보시스템");
  return { title: document.title, sections, sources };
}
