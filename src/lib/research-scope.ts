/** Identity comparisons never treat an arbitrary name prefix as a law family. */
export const compactLaw = (name: string) => name.replace(/\s+/gu, "");
export const lawRoot = (name: string) => compactLaw(name).replace(/(?:시행령|시행규칙)$/u, "");
export const sameLawFamily = (a: string, b: string) => lawRoot(a) === lawRoot(b);

/** Structural intent only; a bare '관계' in an ordinary dispute is insufficient. */
export function asksLawSystem(query: string): boolean {
  return /시행령|시행규칙|하위\s*법령|위임/u.test(query)
    && /관계|위임|체계|위계|연결|비교/u.test(query);
}

/** Official current-law route. It deliberately does not claim to link a historical version.
 * Contract: https://open.law.go.kr/LSO/lab/hangulAddr.do (법령, 3).
 */
export function lawSourceUrl(law: string, jo: string): string | undefined {
  if (!law.trim() || /[\r\n<>]/u.test(law) || !/^제[1-9]\d{0,3}조(?:의[1-9]\d*)?$/u.test(jo)) return undefined;
  return `https://www.law.go.kr/법령/${encodeURIComponent(compactLaw(law))}/${encodeURIComponent(jo)}`;
}

/** Official annex/form route for the same law: `법령별표서식/(법령명,별표N|서식N)`.
 * The single place that builds it, so the server annex reader and any UI
 * link can never drift apart; a malformed number yields no link rather
 * than a fabricated one. */
export function lawAnnexUrl(law: string, kind: "별표" | "서식", number: string): string | undefined {
  if (!law.trim() || /[\r\n<>]/u.test(law) || !/^\d+(?:의\d+)?$/u.test(number)) return undefined;
  return `https://www.law.go.kr/법령별표서식/(${encodeURIComponent(compactLaw(law))},${encodeURIComponent(`${kind}${number}`)})`;
}
