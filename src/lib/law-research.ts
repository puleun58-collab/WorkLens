import { LAW_ARTICLE_PATTERN } from "@/lib/law-search";
import { normalizeAnalysisDate, normalizeAnalysisJo } from "@/lib/law-analysis";

/**
 * Shared contract for `POST /api/law/research`, the fixed-tool bridge to the
 * Korean Law MCP `legal_research` chains. Browser and server import the same
 * tasks, limits and input normalization.
 */
export const LAW_RESEARCH_TASKS = [
  { value: "full_research", label: "종합 리서치" },
  { value: "law_system", label: "법체계 확인" },
  { value: "action_basis", label: "처분·허가 근거" },
  { value: "dispute_prep", label: "분쟁·불복 자료" },
  { value: "amendment_track", label: "개정 추적" },
  { value: "ordinance_compare", label: "조례 비교" },
  { value: "procedure_detail", label: "절차·서식" },
  { value: "document_review", label: "문서 검토" },
] as const;

export type LawResearchTask = (typeof LAW_RESEARCH_TASKS)[number]["value"];

export const DISPUTE_DOMAINS = [
  { value: "", label: "자동/일반" },
  { value: "tax", label: "조세" },
  { value: "labor", label: "노동" },
  { value: "privacy", label: "개인정보" },
  { value: "competition", label: "공정거래" },
] as const;
/** The MCP enum; the UI's "자동/일반" leaves it unset so the MCP detects the field. */
export type DisputeDomain = "tax" | "labor" | "privacy" | "competition" | "general";

export const AMENDMENT_SCENARIOS = [
  { value: "timeline", label: "개정 이력" },
  { value: "time_travel", label: "시점 비교" },
] as const;
export type AmendmentScenario = (typeof AMENDMENT_SCENARIOS)[number]["value"];

/** Same cap as the MCP `legal_research.query` schema (MAX_CHAIN_QUERY). */
export const LAW_RESEARCH_QUERY_MAX_CHARS = 2000;
/** The MCP document analysis rejects shorter text as "too short". */
export const LAW_RESEARCH_DOCUMENT_MIN_CHARS = 20;
/** Keeps the forwarded JSON-RPC body well inside the MCP's 100 KB request limit (Korean text is 3 bytes/char). */
export const LAW_RESEARCH_DOCUMENT_MAX_CHARS = 20_000;
export const LAW_RESEARCH_NAME_MAX_CHARS = 100;
export const LAW_RESEARCH_MAX_ARTICLES = 10;
export const LAW_RESEARCH_BODY_MAX_BYTES = LAW_RESEARCH_DOCUMENT_MAX_CHARS * 4 + 2048;
export const LAW_RESEARCH_ARTICLE_PATTERN = LAW_ARTICLE_PATTERN;

export type LawResearchRequest =
  | { task: "full_research"; query: string }
  | { task: "law_system"; query: string; articles?: string[] }
  | { task: "action_basis"; query: string }
  | { task: "dispute_prep"; query: string; domain?: DisputeDomain }
  | { task: "amendment_track"; query: string; scenario?: AmendmentScenario; mst?: string; lawId?: string;
    fromDate?: string; toDate?: string; includeHistory?: boolean }
  | { task: "ordinance_compare"; query: string; parentLaw?: string }
  | { task: "procedure_detail"; query: string }
  | { task: "document_review"; text: string; maxClauses?: number };

/** Form state; kept per field so switching tasks never loses what was typed. */
export interface LawResearchDraft {
  query: string;
  text: string;
  articles: string;
  domain: DisputeDomain | "";
  scenario: AmendmentScenario | "";
  fromDate: string;
  toDate: string;
  includeHistory: boolean;
  parentLaw: string;
}

export const EMPTY_RESEARCH_DRAFT: LawResearchDraft = {
  query: "", text: "", articles: "", domain: "", scenario: "", fromDate: "", toDate: "", includeHistory: false, parentLaw: "",
};

/** `제38조, 39조` → `["제38조","제39조"]`; null when any entry is not a real article number. */
export function parseResearchArticles(value: string): string[] | null {
  const items = value.split(/[,\s]+/u).map(normalizeAnalysisJo).filter(Boolean);
  if (items.length > LAW_RESEARCH_MAX_ARTICLES || !items.every((item) => LAW_RESEARCH_ARTICLE_PATTERN.test(item))) return null;
  return [...new Set(items)];
}

/** The exact request a task's current input would send, or null while it is incomplete or invalid. */
export function lawResearchRequestFor(task: LawResearchTask, draft: LawResearchDraft): LawResearchRequest | null {
  if (task === "document_review") {
    const text = draft.text.trim();
    return text.length >= LAW_RESEARCH_DOCUMENT_MIN_CHARS && draft.text.length <= LAW_RESEARCH_DOCUMENT_MAX_CHARS ? { task, text } : null;
  }
  const query = draft.query.trim();
  if (!query || draft.query.length > LAW_RESEARCH_QUERY_MAX_CHARS) return null;
  switch (task) {
    case "law_system": {
      const articles = parseResearchArticles(draft.articles);
      if (!articles) return null;
      return { task, query, ...(articles.length ? { articles } : {}) };
    }
    case "dispute_prep":
      return { task, query, ...(draft.domain ? { domain: draft.domain } : {}) };
    case "amendment_track": {
      if (draft.scenario !== "time_travel") {
        return { task, query, ...(draft.scenario ? { scenario: draft.scenario } : {}), ...(draft.includeHistory ? { includeHistory: true } : {}) };
      }
      const fromDate = normalizeAnalysisDate(draft.fromDate);
      const toDate = normalizeAnalysisDate(draft.toDate);
      if (!fromDate || !toDate || fromDate > toDate) return null;
      return { task, query, scenario: "time_travel", fromDate, toDate, ...(draft.includeHistory ? { includeHistory: true } : {}) };
    }
    case "ordinance_compare": {
      const parentLaw = draft.parentLaw.trim();
      if (parentLaw.length > LAW_RESEARCH_NAME_MAX_CHARS) return null;
      return { task, query, ...(parentLaw ? { parentLaw } : {}) };
    }
    default:
      return { task, query };
  }
}

export interface LawResearchData {
  found: true;
  task: LawResearchTask;
  text: string;
  markers: string[];
}

export interface LawResearchAbsent {
  found: false;
  task: LawResearchTask;
  marker: "NOT_FOUND";
  text: string;
}

export type LawResearchOutcome =
  | { kind: "found"; data: LawResearchData }
  | { kind: "missing"; data: LawResearchAbsent }
  | { kind: "error"; message: string };

export const LAW_RESEARCH_ERROR = "리서치를 완료하지 못했습니다. 잠시 후 다시 시도하세요.";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isTask(value: unknown): value is LawResearchTask {
  return LAW_RESEARCH_TASKS.some((task) => task.value === value);
}

/** Only an explicit `found:false` NOT_FOUND is absence; non-2xx and malformed bodies stay errors. */
export function lawResearchOutcome(ok: boolean, body: unknown): LawResearchOutcome {
  if (!ok) {
    const message = record(record(body)?.error)?.message;
    return { kind: "error", message: typeof message === "string" && message ? message : LAW_RESEARCH_ERROR };
  }
  const data = record(record(body)?.data);
  if (!data || !isTask(data.task) || typeof data.text !== "string") return { kind: "error", message: LAW_RESEARCH_ERROR };
  if (data.found === false && data.marker === "NOT_FOUND") return { kind: "missing", data: data as unknown as LawResearchAbsent };
  if (data.found === true && Array.isArray(data.markers) && data.markers.every((marker) => typeof marker === "string")) {
    return { kind: "found", data: data as unknown as LawResearchData };
  }
  return { kind: "error", message: LAW_RESEARCH_ERROR };
}
