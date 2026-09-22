/**
 * One CSV writer for every export.
 *
 * Spreadsheets evaluate a field that begins with `=`, `@`, `+` or `-` as a
 * formula, which is how CSV injection works. A sign followed by digits is just
 * a number — escaping those too would print `'+5,000원` in the cell and make
 * every signed value unreadable — so only the genuinely executable shapes are
 * neutralised.
 */
const EXECUTABLE = /^\s*(?:[=@]|[+-](?![\d.,]))/u;

export function csvField(value: string | number | boolean | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = EXECUTABLE.test(text) ? `'${text}` : text;
  return /[",\r\n]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe;
}

/** The same guard for values written into a worksheet cell. */
export function safeCellText(value: string): string {
  return EXECUTABLE.test(value) ? `'${value}` : value;
}
