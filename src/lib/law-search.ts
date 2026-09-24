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
