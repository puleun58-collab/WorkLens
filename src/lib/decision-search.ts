import { DECISION_DOMAINS, type DecisionDomain } from "@/lib/decision-domain";

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

export interface DecisionSearchData {
  found: true;
  entries: DecisionEntry[];
  text: string;
  page: number;
  totalCount?: number;
  hasNext?: boolean;
}

export interface DecisionTextData {
  found: true;
  text: string;
  title?: string;
  sections?: { heading: string; text: string }[];
  expandable?: boolean;
}

export type DecisionSearchOutcome =
  | { kind: "found"; data: DecisionSearchData }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export type DecisionTextOutcome =
  | { kind: "found"; data: DecisionTextData }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export const DECISION_SEARCH_ERROR = "판례·결정례 검색을 완료하지 못했습니다. 잠시 후 다시 시도하세요.";
export const DECISION_TEXT_ERROR = "판례·결정례 원문을 불러오지 못했습니다. 잠시 후 다시 시도하세요.";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function errorMessage(body: unknown, fallback: string): string {
  const message = record(record(body)?.error)?.message;
  return typeof message === "string" && message ? message : fallback;
}

function optionalStrings(data: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => data[key] === undefined || typeof data[key] === "string");
}

export function decisionSearchOutcome(ok: boolean, body: unknown): DecisionSearchOutcome {
  if (!ok) return { kind: "error", message: errorMessage(body, DECISION_SEARCH_ERROR) };
  const data = record(record(body)?.data);
  if (data?.found === false && data.marker === "NOT_FOUND" && typeof data.text === "string") return { kind: "missing" };
  if (data?.found !== true || typeof data.text !== "string" || !Array.isArray(data.entries)
    || !Number.isSafeInteger(data.page) || (data.page as number) < 1
    || (data.totalCount !== undefined && (!Number.isSafeInteger(data.totalCount) || (data.totalCount as number) < 0))
    || (data.hasNext !== undefined && typeof data.hasNext !== "boolean")) {
    return { kind: "error", message: DECISION_SEARCH_ERROR };
  }
  const keys = ["title", "caseNumber", "institution", "court", "date", "summary"];
  if (!data.entries.every((item: unknown) => {
    const entry = record(item);
    return entry && DECISION_DOMAINS.some((domain) => domain.value === entry.domain)
      && typeof entry.id === "string" && entry.id.length > 0 && optionalStrings(entry, keys);
  })) return { kind: "error", message: DECISION_SEARCH_ERROR };
  return { kind: "found", data: data as unknown as DecisionSearchData };
}

export function decisionTextOutcome(ok: boolean, body: unknown): DecisionTextOutcome {
  if (!ok) return { kind: "error", message: errorMessage(body, DECISION_TEXT_ERROR) };
  const data = record(record(body)?.data);
  if (data?.found === false && data.marker === "NOT_FOUND" && typeof data.text === "string") return { kind: "missing" };
  if (data?.found !== true || typeof data.text !== "string"
    || !optionalStrings(data, ["title"])
    || (data.expandable !== undefined && typeof data.expandable !== "boolean")
    || (data.sections !== undefined && (!Array.isArray(data.sections)
      || !data.sections.every((section: unknown) => {
        const value = record(section);
        return value && typeof value.heading === "string" && typeof value.text === "string";
      })))) return { kind: "error", message: DECISION_TEXT_ERROR };
  return { kind: "found", data: data as unknown as DecisionTextData };
}
