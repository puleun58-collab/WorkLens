import type { DecisionDomain } from "@/lib/decision-domain";
import { ApiError } from "@/server/http";
import { callLawTool } from "@/server/law-mcp";

export interface DecisionEntry {
  domain: DecisionDomain;
  id: string;
  title?: string;
  caseNumber?: string;
  institution?: string;
  court?: string;
  date?: string;
  summary?: string;
}

export type DecisionSearchResult =
  | { found: true; entries: DecisionEntry[]; text: string; page: number; totalCount?: number; hasNext?: boolean }
  | { found: false; marker: "NOT_FOUND"; text: string };

export type DecisionTextResult =
  | { found: true; text: string; title?: string; sections?: Array<{ heading: string; text: string }>; expandable?: boolean }
  | { found: false; marker: "NOT_FOUND"; text: string };

const NOT_FOUND_PREFIX = /^[ \t]*\[NOT_FOUND\](?=\s|$)/u;
const SERIAL_ID = /^\d{1,32}$/u;
const compactMarker = /⋯ 중략 [\d,]+자 \(full=true로 전문 조회\) ⋯/u;
const failed = () => new ApiError("LAW_MCP_ERROR", "판례·결정례 서비스가 요청을 처리하지 못했습니다.", 502);

type EntryMetadata = keyof Pick<DecisionEntry, "caseNumber" | "institution" | "court" | "date">;
const committeeFields: Record<string, EntryMetadata> = { 사건번호: "caseNumber", 결정일: "date", 재결청: "institution" };
const specialAppealFields: Record<string, EntryMetadata> = { 청구번호: "caseNumber", 의결일: "date", 재결청: "institution" };
const metadataLabels: Record<DecisionDomain, Record<string, EntryMetadata>> = {
  precedent: { 사건번호: "caseNumber", 법원: "court", 선고일: "date" },
  constitutional: { 사건번호: "caseNumber", 종국일: "date" },
  admin_appeal: { 사건번호: "caseNumber", 의결일: "date", 재결청: "institution" },
  interpretation: { 해석례번호: "caseNumber", 회신일자: "date", 해석기관: "institution" },
  tax_tribunal: { 청구번호: "caseNumber", 의결일자: "date", 재결청: "institution" },
  customs: { 해석기관: "institution", 해석일자: "date" },
  nts: { 해석기관: "institution", 해석일자: "date" },
  ftc: committeeFields, pipc: committeeFields, nlrc: committeeFields, acr: committeeFields,
  appeal_review: specialAppealFields, acr_special: specialAppealFields,
};
const headings: Record<string, true> = {
  판시사항: true, 판결요지: true, 결정요지: true, 재결요지: true, 질의요지: true, 회신내용: true, 회답: true,
  주문: true, 청구취지: true, 이유: true, 전문: true, 참조조문: true, 참조판례: true, 관련법령: true,
  따른결정: true, 참조결정: true,
};

/** Parse only bracketed serial-number records. Unrecognized metadata stays in raw text. */
export function parseDecisionEntries(text: string, domain: DecisionDomain): DecisionEntry[] {
  const entries: DecisionEntry[] = [];
  let current: DecisionEntry | undefined;
  const fields = metadataLabels[domain];
  for (const line of text.split(/\r?\n/u)) {
    const head = /^\[([^\]\r\n]+)\](?:[ \t]+([^\r\n]*))?$/u.exec(line);
    if (head) {
      current = undefined;
      if (!SERIAL_ID.test(head[1])) continue;
      const title = head[2]?.trim();
      current = { domain, id: head[1],
        ...(title && title !== "(제목 없음)" && title !== "undefined" && title !== "null" && title !== "N/A" ? { title } : {}) };
      entries.push(current);
      continue;
    }
    if (!line.trim()) {
      current = undefined;
      continue;
    }
    if (!current) continue;
    const field = /^  ([^:\r\n]+):[ \t]*(.+?)[ \t]*$/u.exec(line);
    if (!field) continue;
    if (Object.hasOwn(fields, field[1]) && field[2] !== "N/A") current[fields[field[1]]] = field[2];
  }
  return entries;
}

/** Keep the complete MCP text; sections are optional navigation aids, not a transformed source. */
export function parseDecisionText(text: string): Pick<Extract<DecisionTextResult, { found: true }>, "text" | "title" | "sections" | "expandable"> {
  const titleMatch = /^=== ([^\r\n]+) ===(?:\r?\n|$)/u.exec(text);
  const matches: Array<{ heading: string; from: number; bodyStart: number }> = [];
  const pattern = /^([^:\r\n]+):\r?\n/gmu;
  for (const match of text.matchAll(pattern)) {
    if (Object.hasOwn(headings, match[1])) matches.push({ heading: match[1], from: match.index, bodyStart: match.index + match[0].length });
  }
  const sections = matches.map((match, index) => ({
    heading: match.heading,
    text: text.slice(match.bodyStart, matches[index + 1]?.from ?? text.length).trim(),
  })).filter((section) => section.text);
  return {
    text,
    ...(titleMatch ? { title: titleMatch[1] } : {}),
    ...(sections.length ? { sections } : {}),
    expandable: compactMarker.test(text),
  };
}

export async function searchDecisions(domain: DecisionDomain, query: string, page: number, context: { requestId: string; signal?: AbortSignal }): Promise<DecisionSearchResult> {
  const { text, isError } = await callLawTool("search_decisions", { domain, query, display: 20, page }, context);
  if (NOT_FOUND_PREFIX.test(text)) return { found: false, marker: "NOT_FOUND", text };
  if (isError || !text.trim()) throw failed();
  const header = /검색 결과 \(총 ([\d,]+)건, ([\d,]+)페이지\)/u.exec(text);
  if (!header) throw failed();
  const count = Number(header[1].replaceAll(",", ""));
  const returnedPage = Number(header[2].replaceAll(",", ""));
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(returnedPage) || returnedPage !== page) throw failed();
  const entries = parseDecisionEntries(text, domain);
  // A positive total without records on an out-of-range page is possible; an empty
  // first page or malformed bracketed IDs is not a successful search.
  if (!entries.length && (page === 1 || count > (page - 1) * 20)) throw failed();
  return { found: true, entries, text, page: returnedPage, totalCount: count,
    hasNext: entries.length > 0 && count > returnedPage * 20 };
}

export async function getDecisionText(domain: DecisionDomain, id: string, full: true | undefined, context: { requestId: string; signal?: AbortSignal }): Promise<DecisionTextResult> {
  // Law MCP explicitly reports that the NTS API offers search only, not detail.
  if (domain === "nts") throw new ApiError("LAW_DETAIL_NOT_SUPPORTED", "국세청 법령해석은 원문 조회를 지원하지 않습니다.", 422);
  const { text, isError } = await callLawTool("get_decision_text", full ? { domain, id, full } : { domain, id }, context);
  if (NOT_FOUND_PREFIX.test(text)) return { found: false, marker: "NOT_FOUND", text };
  if (isError || !text.trim()) throw failed();
  const parsed = parseDecisionText(text);
  // Interpretation's upstream handler does not use the full flag, even though
  // other domains may compact their long sections in the unified handler.
  return { found: true, ...parsed, expandable: domain !== "interpretation" && !full && parsed.expandable };
}
