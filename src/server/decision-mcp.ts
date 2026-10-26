import type { DecisionDomain } from "@/lib/decision-domain";
import { ApiError } from "@/server/http";
import { callLawTool } from "@/server/law-mcp";
import { courtFromCaseNumber } from "@/lib/law-display";
import { decisionNumberAcceptableForVerification } from "@/lib/decision-identifier";

/** Type verification, computed server-side from the record's own metadata. Never a "verified" badge: only exclusion and "확인 필요" use it. */
export type DecisionTypeVerification = "matched" | "mismatched" | "not_provided";

export interface DecisionEntry {
  domain: DecisionDomain;
  id: string;
  title?: string;
  caseNumber?: string;
  institution?: string;
  court?: string;
  date?: string;
  summary?: string;
  typeVerification?: DecisionTypeVerification;
}

export type DecisionSearchResult =
  | { found: true; entries: DecisionEntry[]; text: string; page: number; totalCount?: number; hasNext?: boolean; excludedCount: number }
  | { found: false; marker: "NOT_FOUND"; text: string };

export type DecisionTextResult =
  | { found: true; text: string; title?: string; sections?: Array<{ heading: string; text: string }>; expandable?: boolean; fullUnavailable?: boolean; fullUnknown?: boolean }
  | { found: false; marker: "NOT_FOUND"; text: string };

const NOT_FOUND_PREFIX = /^[ \t]*\[NOT_FOUND\](?=\s|$)/u;
const SERIAL_ID = /^\d{1,32}$/u;
const compactMarker = /⋯ 중략 [\d,]+자 \(full=true로 전문 조회\) ⋯/u;
const failed = () => new ApiError("LAW_MCP_ERROR", "판례·결정례 서비스가 요청을 처리하지 못했습니다.", 502);

type EntryMetadata = keyof Pick<DecisionEntry, "caseNumber" | "institution" | "court" | "date">;
/**
 * Union of every domain's metadata labels, parsed with the label name kept:
 * the old per-domain table discarded any label outside the requested domain,
 * which destroyed exactly the signal that tells a mixed-in record apart
 * (e.g. a constitutional record's 종국일 inside a precedent search).
 * `N/A` still counts as no value, never as a contradiction.
 */
const ALL_LABELS: Record<string, EntryMetadata> = {
  사건번호: "caseNumber", 청구번호: "caseNumber", 해석례번호: "caseNumber",
  법원: "court", 선고일: "date", 종국일: "date", 의결일: "date", 의결일자: "date",
  결정일: "date", 회신일자: "date", 해석일자: "date", 재결청: "institution", 해석기관: "institution",
};
/** The label set each domain's own records carry (from the per-domain tables above). */
const DOMAIN_LABELS: Record<DecisionDomain, { numbers: string[]; dates: string[]; institutions: string[] }> = {
  precedent: { numbers: ["사건번호"], dates: ["선고일"], institutions: ["법원"] },
  constitutional: { numbers: ["사건번호"], dates: ["종국일"], institutions: [] },
  admin_appeal: { numbers: ["사건번호"], dates: ["의결일"], institutions: ["재결청"] },
  interpretation: { numbers: ["해석례번호"], dates: ["회신일자"], institutions: ["해석기관"] },
  tax_tribunal: { numbers: ["청구번호"], dates: ["의결일자"], institutions: ["재결청"] },
  customs: { numbers: [], dates: ["해석일자"], institutions: ["해석기관"] },
  nts: { numbers: [], dates: ["해석일자"], institutions: ["해석기관"] },
  ftc: { numbers: ["사건번호"], dates: ["결정일"], institutions: ["재결청"] },
  pipc: { numbers: ["사건번호"], dates: ["결정일"], institutions: ["재결청"] },
  nlrc: { numbers: ["사건번호"], dates: ["결정일"], institutions: ["재결청"] },
  acr: { numbers: ["사건번호"], dates: ["결정일"], institutions: ["재결청"] },
  appeal_review: { numbers: ["청구번호"], dates: ["의결일"], institutions: ["재결청"] },
  acr_special: { numbers: ["청구번호"], dates: ["의결일"], institutions: ["재결청"] },
};
/** Labels no other group uses: their presence alone identifies the group. */
const UNIQUE_LABELS = new Set(["선고일", "법원", "종국일", "회신일자", "해석례번호", "의결일자"]);
/** Institution strings actually observed in code fixtures. Unobserved domains are never judged by institution.
 * Admin appeals are deliberately absent: their deciding bodies vary by region (regional commissions and
 * 국민권익위원회), so no single observed string can judge them — requiring 중앙행정심판위원회 excluded every
 * real regional record. Labels and number shapes still discriminate, and another domain's observed institution
 * still mismatches. */
const OBSERVED_INSTITUTIONS: Partial<Record<DecisionDomain, string>> = {
  interpretation: "법제처",
  ftc: "공정거래위원회",
};
/** (number label, date label) pairs carried by exactly one domain. */
const UNIQUE_PAIRS: Set<string> = (() => {
  const counts = new Map<string, number>();
  for (const labels of Object.values(DOMAIN_LABELS)) {
    const key = `${labels.numbers[0] ?? ""}\0${labels.dates[0] ?? ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count === 1).map(([key]) => key));
})();

/**
 * Verifies one parsed record against the requested domain, from its own
 * labels, number and institution only — never title or body keywords.
 * - `mismatched`: a label outside the domain's set, a number that fails the
 *   domain's observed pattern, an institution contradicting an observed
 *   value, or a court-prefix naming another court family. Pattern matches
 *   and shared labels are never approval, so without a distinguishing
 *   positive signal the record stays `not_provided`, not `matched`.
 */
export function verifyDecisionEntry(domain: DecisionDomain, entry: DecisionEntry, labels: ReadonlySet<string>): DecisionTypeVerification {
  const expected = DOMAIN_LABELS[domain];
  if ([...labels].some((label) => {
    if (["사건번호", "청구번호", "해석례번호"].includes(label)) return !expected.numbers.includes(label);
    if (["선고일", "종국일", "의결일", "의결일자", "결정일", "회신일자", "해석일자"].includes(label)) return !expected.dates.includes(label);
    return !expected.institutions.includes(label);
  })) return "mismatched";
  const prefix = courtFromCaseNumber(entry.caseNumber);
  if (prefix) {
    // A court-prefixed number names its court family, so the digit-led
    // domain pattern — which a prefixed number can never satisfy — must not
    // screen it out before the prefix rule is reached.
    if (domain === "precedent" ? prefix === "헌법재판소" : domain === "constitutional" ? prefix !== "헌법재판소" : true) return "mismatched";
  } else if (entry.caseNumber && decisionNumberAcceptableForVerification(domain, entry.caseNumber) === false) return "mismatched";
  if (entry.institution) {
    const observed = OBSERVED_INSTITUTIONS[domain];
    if (observed ? entry.institution !== observed : Object.values(OBSERVED_INSTITUTIONS).includes(entry.institution)) return "mismatched";
  }
  if ([...labels].some((label) => UNIQUE_LABELS.has(label))) return "matched";
  const numberLabel = expected.numbers.find((label) => labels.has(label));
  const dateLabel = expected.dates.find((label) => labels.has(label));
  if (numberLabel && dateLabel && UNIQUE_PAIRS.has(`${numberLabel}\0${dateLabel}`)) return "matched";
  if (entry.institution && OBSERVED_INSTITUTIONS[domain] === entry.institution) return "matched";
  if (prefix && ((domain === "precedent" && prefix !== "헌법재판소") || (domain === "constitutional" && prefix === "헌법재판소"))) return "matched";
  return "not_provided";
}
const headings: Record<string, true> = {
  판시사항: true, 판결요지: true, 결정요지: true, 재결요지: true, 질의요지: true, 회신내용: true, 회답: true,
  주문: true, 청구취지: true, 이유: true, 전문: true, 참조조문: true, 참조판례: true, 관련법령: true,
  따른결정: true, 참조결정: true,
};

/** Parses bracketed serial-number records with the union label set; each entry carries its type verification. Exclusion happens in `searchDecisions`, not here. */
export function parseDecisionEntries(text: string, domain: DecisionDomain): DecisionEntry[] {
  const entries: DecisionEntry[] = [];
  const labelSets: Array<Set<string>> = [];
  let current: DecisionEntry | undefined;
  let currentLabels: Set<string> | undefined;
  for (const line of text.split(/\r?\n/u)) {
    const head = /^\[([^\]\r\n]+)\](?:[ \t]+([^\r\n]*))?$/u.exec(line);
    if (head) {
      current = undefined;
      currentLabels = undefined;
      if (!SERIAL_ID.test(head[1])) continue;
      const title = head[2]?.trim();
      current = { domain, id: head[1],
        ...(title && title !== "(제목 없음)" && title !== "undefined" && title !== "null" && title !== "N/A" ? { title } : {}) };
      currentLabels = new Set<string>();
      entries.push(current);
      labelSets.push(currentLabels);
      continue;
    }
    if (!line.trim()) {
      current = undefined;
      currentLabels = undefined;
      continue;
    }
    if (!current || !currentLabels) continue;
    const field = /^  ([^:\r\n]+):[ \t]*(.+?)[ \t]*$/u.exec(line);
    if (!field) continue;
    if (Object.hasOwn(ALL_LABELS, field[1]) && field[2] !== "N/A") {
      current[ALL_LABELS[field[1]]] = field[2];
      currentLabels.add(field[1]);
    }
  }
  // 법원: N/A beside `대법원-2023-다-302036`: the record's own case-number field names the court.
  for (const entry of entries) {
    const court = entry.court ? undefined : courtFromCaseNumber(entry.caseNumber);
    if (court) entry.court = court;
  }
  entries.forEach((entry, index) => { entry.typeVerification = verifyDecisionEntry(domain, entry, labelSets[index]); });
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
  // first page or malformed bracketed IDs is not a successful search. The
  // emptiness test uses the parsed records, before verification exclusion:
  // exclusion is a successful filter, not an upstream failure, so an
  // all-excluded first page is still `found: true`, never the 502 below.
  if (!entries.length && (page === 1 || count > (page - 1) * 20)) throw failed();
  const kept = entries.filter((entry) => entry.typeVerification !== "mismatched");
  return { found: true, entries: kept, text, page: returnedPage, totalCount: count, excludedCount: entries.length - kept.length,
    hasNext: count > returnedPage * 20 };
}

export async function getDecisionText(domain: DecisionDomain, id: string, full: true | undefined, context: { requestId: string; signal?: AbortSignal }): Promise<DecisionTextResult> {
  // Law MCP explicitly reports that the NTS API offers search only, not detail.
  if (domain === "nts") throw new ApiError("LAW_DETAIL_NOT_SUPPORTED", "국세청 법령해석은 원문 조회를 지원하지 않습니다.", 422);
  const { text, isError } = await callLawTool("get_decision_text", full ? { domain, id, full } : { domain, id }, context);
  if (NOT_FOUND_PREFIX.test(text)) return { found: false, marker: "NOT_FOUND", text };
  if (isError || !text.trim()) throw failed();
  const parsed = parseDecisionText(text);
  // Interpretation full status is a per-attempt fact, not a domain verdict:
  // without a full attempt the upstream handler's full support is unconfirmed,
  // so a truncated summary is `fullUnknown` with neutral wording. Only a
  // full attempt that still returns the truncation marker becomes
  // `fullUnavailable`. Other domains keep their expandable/fullError flow.
  return { found: true, ...parsed, expandable: domain !== "interpretation" && !full && parsed.expandable,
    ...(domain === "interpretation" && parsed.expandable ? (full ? { fullUnavailable: true } : { fullUnknown: true }) : {}) };
}
