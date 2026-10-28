/** Only citations with a statutory referent and operative wording qualify.
 * Ranges are tested numerically without creating articles from their numbers.
 */
export function citesParent(body: string, jo: string): boolean {
  const wanted = /^제(\d+)조(?:의(\d+))?$/u.exec(jo);
  if (!wanted) return false;
  for (const match of body.matchAll(/(?:^|[\s①-⑳.,])법\s+((?:제\d+조(?:의\d+)?[^.\n]{0,160}?))(?:에 따라|에 따른|에서|으로 정하는|정하는|의 기준)/gu)) {
    const clause = match[1];
    if ([...clause.matchAll(/제(\d+)조(?:의(\d+))?/gu)].some((m) => m[1] === wanted[1] && m[2] === wanted[2])) return true;
    if (!wanted[2]) for (const range of clause.matchAll(/제(\d+)조부터\s*제(\d+)조까지/gu)) {
      if (+wanted[1] >= +range[1] && +wanted[1] <= +range[2]) return true;
    }
  }
  return false;
}

