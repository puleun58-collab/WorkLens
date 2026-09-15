import seed from "@/config/company-terms.json";
import { configDatabase, type D1DatabaseLike } from "./cf-env";

export interface CompanyTerm {
  id: number;
  term: string;
  description: string | null;
  active: boolean;
  updatedAt: string | null;
}

interface TermRow {
  id: number;
  term: string;
  description: string | null;
  active: number;
  updated_at: string | null;
}

/** Same normalization the Check dictionary uses, so duplicates collapse identically. */
export function normalizeTerm(term: string): string {
  return term
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .toLocaleLowerCase();
}

function toTerm(row: TermRow): CompanyTerm {
  return {
    id: row.id,
    term: row.term,
    description: row.description,
    active: row.active === 1,
    updatedAt: row.updated_at,
  };
}

async function requireDatabase(): Promise<D1DatabaseLike> {
  const database = configDatabase();
  if (!database) throw new Error("COMPANY_TERMS_UNAVAILABLE");
  return database;
}

export async function listCompanyTerms(includeInactive = false): Promise<CompanyTerm[]> {
  const database = await requireDatabase();
  const query = includeInactive
    ? "SELECT id, term, description, active, updated_at FROM company_terms ORDER BY term COLLATE NOCASE"
    : "SELECT id, term, description, active, updated_at FROM company_terms WHERE active = 1 ORDER BY term COLLATE NOCASE";
  const { results } = await database.prepare(query).all<TermRow>();
  return results.map(toTerm);
}

/** Static file used only as the offline seed and as the read-only fallback. */
export function seedTerms(): string[] {
  return seed.terms;
}

export async function createCompanyTerm(term: string, description: string | null): Promise<CompanyTerm> {
  const database = await requireDatabase();
  const display = term.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const normalized = normalizeTerm(display);
  if (!display || !normalized) throw new Error("INVALID_TERM");
  const existing = await database
    .prepare("SELECT id FROM company_terms WHERE normalized_term = ?")
    .bind(normalized)
    .first<{ id: number }>();
  if (existing) throw new Error("DUPLICATE_TERM");
  const inserted = await database
    .prepare("INSERT INTO company_terms (term, normalized_term, description) VALUES (?, ?, ?) RETURNING id, term, description, active, updated_at")
    .bind(display, normalized, description)
    .first<TermRow>();
  if (!inserted) throw new Error("COMPANY_TERMS_UNAVAILABLE");
  return toTerm(inserted);
}

export async function updateCompanyTerm(
  id: number,
  patch: { term?: string; description?: string | null; active?: boolean },
): Promise<CompanyTerm> {
  const database = await requireDatabase();
  const current = await database
    .prepare("SELECT id, term, description, active, updated_at FROM company_terms WHERE id = ?")
    .bind(id)
    .first<TermRow>();
  if (!current) throw new Error("TERM_NOT_FOUND");
  const display = patch.term === undefined
    ? current.term
    : patch.term.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const normalized = normalizeTerm(display);
  if (!display || !normalized) throw new Error("INVALID_TERM");
  if (normalized !== normalizeTerm(current.term)) {
    const clash = await database
      .prepare("SELECT id FROM company_terms WHERE normalized_term = ? AND id != ?")
      .bind(normalized, id)
      .first<{ id: number }>();
    if (clash) throw new Error("DUPLICATE_TERM");
  }
  const description = patch.description === undefined ? current.description : patch.description;
  const active = patch.active === undefined ? current.active : (patch.active ? 1 : 0);
  const updated = await database
    .prepare("UPDATE company_terms SET term = ?, normalized_term = ?, description = ?, active = ?, updated_at = datetime('now') WHERE id = ? RETURNING id, term, description, active, updated_at")
    .bind(display, normalized, description, active, id)
    .first<TermRow>();
  if (!updated) throw new Error("TERM_NOT_FOUND");
  return toTerm(updated);
}

export async function deleteCompanyTerm(id: number): Promise<void> {
  const database = await requireDatabase();
  const result = await database.prepare("DELETE FROM company_terms WHERE id = ?").bind(id).run();
  if (result.meta.changes === 0) throw new Error("TERM_NOT_FOUND");
}
