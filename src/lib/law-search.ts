/** Mirrors the normalized `/api/law` entry; lawId/mst are kept for the later text lookup. */
export interface LawEntry {
  name: string;
  status?: string;
  lawId?: string;
  mst?: string;
  promulgationDate?: string;
  effectiveDate?: string;
  kind?: string;
}

export type LawOutcome =
  | { kind: "found"; laws: LawEntry[] }
  | { kind: "empty" }
  | { kind: "error"; message: string };

export const LAW_FALLBACK_ERROR = "법령 검색을 완료하지 못했습니다. 잠시 후 다시 시도하세요.";
export const LAW_TEXT_FALLBACK_ERROR = "법령 원문을 불러오지 못했습니다. 잠시 후 다시 시도하세요.";
export const LAW_ARTICLE_PATTERN = /^제[1-9]\d{0,3}조(?:의[1-9]\d?)?$/u;

export interface LawText {
  found: true;
  mode: "toc" | "article" | "full";
  text: string;
  name?: string;
  promulgationDate?: string;
  effectiveDate?: string;
  articles?: { jo: string; title: string }[];
}

export type LawTextOutcome =
  | { kind: "found"; data: LawText }
  | { kind: "missing" }
  | { kind: "error"; message: string };

/** Only identifiers accepted by the text endpoint can open a detail. */
export function lawTextIdentifier(law: LawEntry): { mst: string } | { lawId: string } | null {
  if (law.mst && /^\d{6}$/.test(law.mst)) return { mst: law.mst };
  if (law.lawId && /^\d{6}$/.test(law.lawId)) return { lawId: law.lawId };
  return null;
}

/**
 * `민법 제750조`, `근로기준법 제60조 제6항 제3호`, `근로기준법 제74조 내용 알려줘`:
 * the article number is the structural boundary. What precedes it is only a
 * law-name candidate, confirmed later against the real search results; what
 * follows may be a 항/호 (the detail view opens the 조) and a short request
 * without further numbers. Anything else is a plain keyword search.
 */
const LAW_ARTICLE_QUERY = /^(\S(?:.*?\S)?)\s*제\s*([1-9]\d{0,3})\s*조(?:\s*의\s*([1-9]\d?))?(?:\s*제\s*\d+\s*항)?(?:\s*제\s*\d+\s*호)?(?:\s+([^\d]{1,20}))?$/u;

export function parseLawArticleQuery(query: string): { lawName: string; jo: string } | null {
  const match = LAW_ARTICLE_QUERY.exec(query.trim());
  if (!match) return null;
  const lawName = match[1].trim();
  // A second article reference or a digit in the name means the input is not one law and one article.
  if (/\d|제\s*\d/u.test(lawName)) return null;
  const jo = `제${match[2]}조${match[3] ? `의${match[3]}` : ""}`;
  return LAW_ARTICLE_PATTERN.test(jo) ? { lawName, jo } : null;
}

/** The one 현행 entry whose name is exactly `lawName` and can open its text; ambiguous or absent → undefined. */
export function exactCurrentLaw(laws: readonly LawEntry[], lawName: string): LawEntry | undefined {
  const matches = laws.filter((law) => law.name === lawName && law.status === "현행" && lawTextIdentifier(law));
  return matches.length === 1 ? matches[0] : undefined;
}

export function lawTextOutcome(ok: boolean, body: unknown): LawTextOutcome {
  if (!body || typeof body !== "object") return { kind: "error", message: LAW_TEXT_FALLBACK_ERROR };
  const envelope = body as { data?: unknown; error?: { message?: unknown } };
  if (!ok) {
    const message = envelope.error?.message;
    return { kind: "error", message: typeof message === "string" && message ? message : LAW_TEXT_FALLBACK_ERROR };
  }
  const data = envelope.data;
  if (!data || typeof data !== "object") return { kind: "error", message: LAW_TEXT_FALLBACK_ERROR };
  const result = data as { found?: unknown; marker?: unknown; mode?: unknown; text?: unknown; name?: unknown; promulgationDate?: unknown; effectiveDate?: unknown; articles?: unknown };
  if (result.found === false && result.marker === "NOT_FOUND") return { kind: "missing" };
  if (result.found !== true || !["toc", "article", "full"].includes(result.mode as string) || typeof result.text !== "string") {
    return { kind: "error", message: LAW_TEXT_FALLBACK_ERROR };
  }
  if (
    [result.name, result.promulgationDate, result.effectiveDate].some((value) => value !== undefined && typeof value !== "string")
    || (result.articles !== undefined && (!Array.isArray(result.articles)
      || !result.articles.every((article) => article && typeof article.jo === "string" && LAW_ARTICLE_PATTERN.test(article.jo) && typeof article.title === "string")))
  ) return { kind: "error", message: LAW_TEXT_FALLBACK_ERROR };
  return { kind: "found", data: result as LawText };
}

/**
 * Only an explicit `found:false` from a successful response means "no result";
 * any non-2xx or unreadable body is an outage and keeps the server's safe message.
 */
export function lawOutcome(ok: boolean, body: unknown): LawOutcome {
  const parsed = body as { data?: { found?: boolean; laws?: LawEntry[] }; error?: { message?: unknown } } | null;
  if (!ok || !parsed?.data) {
    const message = parsed?.error?.message;
    return { kind: "error", message: typeof message === "string" && message ? message : LAW_FALLBACK_ERROR };
  }
  if (parsed.data.found === false) return { kind: "empty" };
  if (parsed.data.found === true && parsed.data.laws?.length) return { kind: "found", laws: parsed.data.laws };
  return { kind: "error", message: LAW_FALLBACK_ERROR };
}

export function formatLawDate(value?: string): string | undefined {
  const match = value && /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : value;
}

export function lawStatusTone(status?: string): "current" | "upcoming" | "muted" | undefined {
  if (!status) return undefined;
  if (status.includes("현행")) return "current";
  if (status.includes("예정")) return "upcoming";
  return "muted";
}
