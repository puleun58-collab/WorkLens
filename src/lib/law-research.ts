import type { FileKind } from "@/domain/document";
import { LAW_ARTICLE_PATTERN } from "@/lib/law-search";
import { normalizeAnalysisDate, normalizeAnalysisJo } from "@/lib/law-analysis";
import type { ContractReview } from "@/lib/contract-review";
import type { ResearchEnrichment } from "@/lib/research-relevance";

/**
 * Shared contract for `POST /api/law/research`, the fixed-tool bridge to the
 * Korean Law MCP `legal_research` chains. Browser and server import the same
 * tasks, limits and input normalization.
 */
export const LAW_RESEARCH_TASKS = [
  { value: "full_research", label: "통합 조사" },
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
/** Pasted text: kept from when the text was forwarded to the MCP (100 KB request limit; Korean text is 3 bytes/char). */
export const LAW_RESEARCH_DOCUMENT_MAX_CHARS = 20_000;
/**
 * A workspace file is reviewed by WorkLens itself (no text goes to the MCP).
 * Requests are bounded; longer files contribute windows distributed across
 * the document, with omitted units explicitly counted in coverage.
 */
export const LAW_REVIEW_FILE_MAX_CHARS = 100_000;
export const LAW_REVIEW_FILE_MAX_SEGMENTS = 2_000;
export const LAW_REVIEW_SEGMENT_MAX_CHARS = 2_000;
export const LAW_REVIEW_LOCATION_MAX_CHARS = 80;
export const LAW_RESEARCH_NAME_MAX_CHARS = 100;
export const LAW_RESEARCH_MAX_ARTICLES = 10;
/** Large enough for the biggest file review request (worst case 4 bytes/char); the route's schema bounds each field. */
export const LAW_RESEARCH_BODY_MAX_BYTES = LAW_REVIEW_FILE_MAX_CHARS * 4 + LAW_REVIEW_FILE_MAX_SEGMENTS * (LAW_REVIEW_LOCATION_MAX_CHARS * 4 + 64) + 4096;
export const LAW_RESEARCH_ARTICLE_PATTERN = LAW_ARTICLE_PATTERN;

export type LawResearchRequest =
  | { task: "full_research"; query: string }
  | { task: "law_system"; query: string; articles?: string[] }
  | { task: "action_basis"; query: string }
  | { task: "dispute_prep"; query: string; domain?: DisputeDomain }
  | { task: "amendment_track"; query: string; scenario?: AmendmentScenario; mst?: string; lawId?: string;
    fromDate?: string; toDate?: string; includeHistory?: boolean }
  | { task: "ordinance_compare"; query: string; regions: [string, string]; parentLaw?: string }
  | { task: "procedure_detail"; query: string }
  | { task: "document_review"; text: string }
  | { task: "document_review"; document: ReviewDocument };

/**
 * File identity and bounded text segments in document order. A new `batch`
 * marks a gap between selected ranges; neighboring segments within a batch may form one article.
 * No bytes, styles, media, other files, or any selector judgment (issue, severity, risk, law or
 * precedent hints): the server decides those from `text` alone. Built only by `reviewRequestFor`.
 */
export interface ReviewDocument {
  name: string;
  kind: FileKind;
  /** Parser document id and content-bound version: which file and which version was reviewed. */
  id: string;
  version?: string;
  /** Optional verbatim opening text, used only for classification; shares the file/segment budget. */
  classificationContext?: string;
  segments: Array<{ text: string; location: string; batch?: number }>;
}

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
  /** 조례 비교: two distinct regions, kept apart from the topic so each is searched on its own. */
  region1: string;
  region2: string;
}

export const EMPTY_RESEARCH_DRAFT: LawResearchDraft = {
  query: "", text: "", articles: "", domain: "", scenario: "", fromDate: "", toDate: "", includeHistory: false, parentLaw: "", region1: "", region2: "",
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
      const regions: [string, string] = [draft.region1.trim(), draft.region2.trim()];
      if (parentLaw.length > LAW_RESEARCH_NAME_MAX_CHARS || regions.some((region) => !region || region.length > LAW_RESEARCH_NAME_MAX_CHARS)
        || regions[0] === regions[1]) return null;
      return { task, query, regions, ...(parentLaw ? { parentLaw } : {}) };
    }
    default:
      return { task, query };
  }
}

/** The AI reading was skipped: the provider quota ("rate-limited") or anything else ("unavailable"). */
export type InterpretationFailure = "rate-limited" | "unavailable";

/** One legal question: a short label to show and a short phrase to search with (never the user's whole sentence). */
export interface ResearchIssue {
  label: string;
  query: string;
}

/** A tentative reading of the user's own words, never a finding about the law or facts. */
export interface ResearchInterpretation {
  original: string;
  /** One short sentence; a long account is summarized, not repeated. */
  situation: string;
  /** What the user actually stated, apart from what they ask; contradictory statements are not settled here. */
  facts: string[];
  /** Distinct issues in the user's order of concern; same-meaning repeats are merged. */
  issues: ResearchIssue[];
  confidence: "high" | "medium" | "low";
  uncertainty?: string;
  followUp?: string;
}

/**
 * Which sources support which issue. `none`: searched, nothing addressed it; `failed`/`timeout`: its
 * lookups could not finish, so absence is unknown. An article/case shared by issues is listed under each.
 */
export interface IssueEvidence {
  /** Absent when the question could not be interpreted and was searched as written. */
  label?: string;
  status: "found" | "none" | "failed" | "timeout";
  articles: Array<{ law: string; jo: string }>;
  precedents: string[];
}

export interface LawResearchData {
  found: true;
  task: LawResearchTask;
  text: string;
  markers: string[];
  /** 문서 검토 only: the structured clause-by-clause review; `text` is then empty. */
  review?: ContractReview;
  /** 종합 리서치 / 처분 근거: WorkLens's own relevance ranking and title-matched articles; `text` is unchanged. */
  enrichment?: ResearchEnrichment;
  /** 종합 리서치 only: interpretation is tentative; source evidence is assessed separately. */
  interpretation?: ResearchInterpretation;
  /** 종합 리서치 only: why the question could not be split into issues, so weak evidence is not read as "no law". */
  interpretationFailure?: InterpretationFailure;
  /** `matched` requires source content to address an issue, not just a search hit. */
  evidence?: {
    status: "matched" | "partial" | "unverified";
    articles?: EvidenceArticle[];
    precedents?: string[];
    precedentExcerpts?: Record<string, string>;
    /** 종합 리서치: per-issue attribution of the adopted sources above. */
    issues?: IssueEvidence[];
    /** Precedents found by an issue's own search rather than listed in `text`. */
    precedentEntries?: Record<string, { title?: string; caseNumber?: string; body?: string; date?: string }>;
    /** The combined 법제처 research search failed; issue lookups alone supplied what is shown. */
    searchFailed?: true;
  };
  /** 조례 비교 only: each region's ordinance and the topic articles fetched from 법제처. */
  comparison?: OrdinanceComparison;
}

/**
 * `current`: the law is listed 현행 and this text is already in force; `upcoming`: its 시행일 is still ahead;
 * `not_current`: 법제처 lists the law as not in force; `unconfirmed`: the status lookup gave no answer.
 */
export type LawCurrency = "current" | "upcoming" | "not_current" | "unconfirmed";
export interface EvidenceArticle { law: string; jo: string; currency?: LawCurrency }

export interface OrdinanceRegionResult {
  region: string;
  /** `none`: searched and no ordinance of this region matched; `failed`: the lookup itself failed. */
  status: "found" | "none" | "failed";
  /** Ordinances of this region the search returned. */
  candidates: number;
  ordinance?: { id: string; name: string; body?: string; effective?: string };
  /** Articles whose returned number and title were verified against the table of contents. */
  articles: Array<{ jo: string; title: string; body: string; topic: string }>;
}

export interface OrdinanceComparison {
  topic: string;
  /** Article titles carrying a topic term; the comparison's rows. */
  topics: string[];
  regions: OrdinanceRegionResult[];
}

export interface LawResearchAbsent {
  found: false;
  task: LawResearchTask;
  marker: "NOT_FOUND";
  /** Available when semantic interpretation succeeded but official search returned no material. */
  interpretation?: ResearchInterpretation;
  /** Why the question could not be split into issues, when it could not. */
  interpretationFailure?: InterpretationFailure;
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
