/** Only citations with a statutory referent and operative wording qualify.
 * Ranges are tested numerically without creating articles from their numbers.
 * A range's repeated `법` prefix ("법 제74조부터 법 제76조까지") is
 * normalized away before the numeric check: each endpoint still has to
 * carry its own number, and the wanted number has to fall inside the
 * closed interval. A range never proves a 조의N article, and a quoted
 * other-law citation never reaches this check at all — the anchor below
 * only matches an unquoted `법` reference.
 */
export function citesParent(body: string, jo: string): boolean {
  const wanted = /^제(\d+)조(?:의(\d+))?$/u.exec(jo);
  if (!wanted) return false;
  for (const match of body.matchAll(/(?:^|[\s①-⑳.,])법\s+((?:제\d+조(?:의\d+)?[^.\n]{0,160}?))(?:에 따라|에 따른|에서|으로 정하는|정하는|의 기준)/gu)) {
    const clause = match[1];
    if ([...clause.matchAll(/제(\d+)조(?:의(\d+))?/gu)].some((m) => m[1] === wanted[1] && m[2] === wanted[2])) return true;
    if (!wanted[2]) {
      // Drop a repeated `법` prefix before each endpoint ("법 제76조")
      // and collapse the space it leaves, so the range pattern sees the
      // same endpoints as the unrepeated form. Nothing else is stripped:
      // the numbers themselves are untouched.
      const normalized = clause.replace(/(^|[\s])법\s*(?=제\d+조)/gu, "$1");
      for (const range of normalized.matchAll(/제(\d+)조부터\s*제(\d+)조까지/gu)) {
        if (+wanted[1] >= +range[1] && +wanted[1] <= +range[2]) return true;
      }
    }
  }
  return false;
}
