import { LAW_ARTICLE_PATTERN } from "@/lib/law-search";

/**
 * Shared contract for `POST /api/law/analysis`, the fixed-tool bridge to the
 * Korean Law MCP `legal_analysis` modes. The browser and the server import the
 * same modes, limits and input formats so no bound is written twice.
 */
export const LAW_ANALYSIS_MODES = [
  { value: "verify_citations", label: "인용 검증" },
  { value: "cite_check", label: "판례 유효성" },
  { value: "applicable_law", label: "시점별 적용 법령" },
  { value: "impact_map", label: "조문 영향도" },
] as const;

export type LawAnalysisMode = (typeof LAW_ANALYSIS_MODES)[number]["value"];

/** Pasted text for citation checks. The MCP verifies at most 15 citations per call. */
export const LAW_ANALYSIS_TEXT_MAX_CHARS = 5000;
export const LAW_ANALYSIS_CASE_MAX_CHARS = 60;
export const LAW_ANALYSIS_LAW_NAME_MAX_CHARS = 100;
/** UTF-8 Korean is 3 bytes per char and JSON escapes line breaks; keep headroom for the envelope. */
export const LAW_ANALYSIS_BODY_MAX_BYTES = LAW_ANALYSIS_TEXT_MAX_CHARS * 4 + 1024;

/** Court case numbers such as `2013다61381`, including multi-number metadata like `2017다360, 2017다377`. */
export const LAW_ANALYSIS_CASE_PATTERN = /^(?=.*\d{2,4}\s*[가-힣]{1,3}\s*\d)[0-9가-힣\s,.·()-]+$/u;
export const LAW_ANALYSIS_JO_PATTERN = LAW_ARTICLE_PATTERN;

export type LawAnalysisRequest =
  | { mode: "verify_citations"; text: string }
  | { mode: "cite_check"; caseNumber: string }
  | { mode: "applicable_law"; lawName: string; date: string; jo?: string }
  | { mode: "impact_map"; lawName: string; jo: string };

/**
 * The user-chosen reference date (act/contract/disposition), never today's date.
 * Accepts `YYYY-MM-DD` (native date input) or `YYYYMMDD`; returns `YYYY-MM-DD`
 * only for a real calendar date in the MCP's supported 1900–2100 range.
 */
export function normalizeAnalysisDate(value: string): string | null {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1900 || year > 2100) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** Accepts `74`, `74조`, `제 74 조의2`; the server still validates the canonical form. */
export function normalizeAnalysisJo(value: string): string {
  const compact = value.replace(/\s+/gu, "");
  if (!compact) return "";
  const withPrefix = /^\d/u.test(compact) ? `제${compact}` : compact;
  return /^제\d+$/u.test(withPrefix) ? `${withPrefix}조` : withPrefix;
}

/** The form state of each mode; kept separately so switching modes never loses input. */
export interface LawAnalysisDraft {
  text: string;
  caseNumber: string;
  applicable: { lawName: string; date: string; jo: string };
  impact: { lawName: string; jo: string };
}

/** The exact request a mode's current input would send, or null while the input is incomplete or invalid. */
export function lawAnalysisRequestFor(mode: LawAnalysisMode, draft: LawAnalysisDraft): LawAnalysisRequest | null {
  if (mode === "verify_citations") {
    const text = draft.text.trim();
    return text && draft.text.length <= LAW_ANALYSIS_TEXT_MAX_CHARS ? { mode, text } : null;
  }
  if (mode === "cite_check") {
    const caseNumber = draft.caseNumber.trim();
    return caseNumber.length <= LAW_ANALYSIS_CASE_MAX_CHARS && LAW_ANALYSIS_CASE_PATTERN.test(caseNumber) ? { mode, caseNumber } : null;
  }
  if (mode === "applicable_law") {
    const lawName = draft.applicable.lawName.trim();
    const date = normalizeAnalysisDate(draft.applicable.date);
    const jo = normalizeAnalysisJo(draft.applicable.jo);
    if (!lawName || lawName.length > LAW_ANALYSIS_LAW_NAME_MAX_CHARS || !date || (jo && !LAW_ANALYSIS_JO_PATTERN.test(jo))) return null;
    return { mode, lawName, date, ...(jo ? { jo } : {}) };
  }
  const lawName = draft.impact.lawName.trim();
  const jo = normalizeAnalysisJo(draft.impact.jo);
  return lawName && lawName.length <= LAW_ANALYSIS_LAW_NAME_MAX_CHARS && LAW_ANALYSIS_JO_PATTERN.test(jo) ? { mode, lawName, jo } : null;
}

/** Successful analysis: the complete MCP text plus the machine markers it contained. */
export interface LawAnalysisData {
  found: true;
  mode: LawAnalysisMode;
  text: string;
  markers: string[];
}

/** The MCP explicitly reported absent data or an unusable argument; never an outage. */
export interface LawAnalysisAbsent {
  found: false;
  mode: LawAnalysisMode;
  marker: "NOT_FOUND" | "INVALID_ARGUMENT";
  text: string;
}

export type LawAnalysisOutcome =
  | { kind: "found"; data: LawAnalysisData }
  | { kind: "missing"; data: LawAnalysisAbsent }
  | { kind: "error"; message: string };

export const LAW_ANALYSIS_ERROR = "검증·분석을 완료하지 못했습니다. 잠시 후 다시 시도하세요.";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isMode(value: unknown): value is LawAnalysisMode {
  return LAW_ANALYSIS_MODES.some((mode) => mode.value === value);
}

/**
 * Only an explicit `found:false` with a known marker is absence. Non-2xx and
 * malformed bodies stay errors so an outage is never shown as "no result".
 */
export function lawAnalysisOutcome(ok: boolean, body: unknown): LawAnalysisOutcome {
  if (!ok) {
    const message = record(record(body)?.error)?.message;
    return { kind: "error", message: typeof message === "string" && message ? message : LAW_ANALYSIS_ERROR };
  }
  const data = record(record(body)?.data);
  if (!data || !isMode(data.mode) || typeof data.text !== "string") return { kind: "error", message: LAW_ANALYSIS_ERROR };
  if (data.found === false && (data.marker === "NOT_FOUND" || data.marker === "INVALID_ARGUMENT")) {
    return { kind: "missing", data: data as unknown as LawAnalysisAbsent };
  }
  if (data.found === true && Array.isArray(data.markers) && data.markers.every((marker) => typeof marker === "string")) {
    return { kind: "found", data: data as unknown as LawAnalysisData };
  }
  return { kind: "error", message: LAW_ANALYSIS_ERROR };
}
