-- Company-wide protected terms. Configuration data only: no documents,
-- no parsed content, no findings, no personal data.
CREATE TABLE IF NOT EXISTS company_terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL,
  normalized_term TEXT NOT NULL UNIQUE,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS company_terms_active_idx ON company_terms (active);
