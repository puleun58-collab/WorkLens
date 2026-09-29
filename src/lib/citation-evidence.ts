/**
 * Evidence for a verified citation, taken only from official 법제처 text the
 * existing law/decision endpoints return. Nothing here summarizes, rewrites
 * or invents legal text: it selects whole lines of the returned article.
 */
import type { LawEntry } from "@/lib/law-search";

export interface LawCitationTarget {
  lawName: string;
  /** `제750조`, `제10조의2`. */
  jo: string;
  title?: string;
  hang?: number;
  ho?: number;
}

const CITATION_LABEL = /^(.+?)\s+(제[1-9]\d{0,3}조(?:의[1-9]\d?)?)(?:\(([^)]*)\))?(?:\s+제(\d+)항)?(?:\s+제(\d+)호)?$/u;

/** Reads the label the verifier printed for a law citation, e.g. `근로기준법 제60조(연차 유급휴가) 제6항`. */
export function lawCitationTarget(citation: string): LawCitationTarget | undefined {
  const match = CITATION_LABEL.exec(citation.trim());
  if (!match) return undefined;
  return {
    lawName: match[1],
    jo: match[2],
    ...(match[3] ? { title: match[3] } : {}),
    ...(match[4] ? { hang: Number(match[4]) } : {}),
    ...(match[5] ? { ho: Number(match[5]) } : {}),
  };
}

/** Same article pattern the verifier applies to the input, in document order. */
const INPUT_ARTICLE = /제\s*(\d+)\s*조(?:\s*의\s*(\d+))?(?:\s*제\s*(\d+)\s*항)?(?:\s*제\s*(\d+)\s*호)?/gu;

/**
 * The verifier checks 조 and 항 but drops a cited 호 from its label. Recovers
 * each law citation's 호 from the input: citations are reported in input order
 * with exact repeats removed, so the n-th label is the next unconsumed input
 * reference with the same 조·항. Returns one entry per target, `undefined`
 * when the input named no 호 or the reference could not be matched.
 */
export function citedHo(input: string, targets: readonly (LawCitationTarget | undefined)[]): (number | undefined)[] {
  const references = [...input.matchAll(INPUT_ARTICLE)].map((match) => ({
    jo: `제${Number(match[1])}조${match[2] ? `의${Number(match[2])}` : ""}`,
    hang: match[3] ? Number(match[3]) : undefined,
    ho: match[4] ? Number(match[4]) : undefined,
  }));
  const consumed = new Set<string>();
  let cursor = 0;
  return targets.map((target) => {
    if (!target) return undefined;
    for (let index = cursor; index < references.length; index++) {
      const reference = references[index];
      if (reference.jo !== target.jo || reference.hang !== target.hang) continue;
      const key = `${target.lawName}\0${reference.jo}\0${reference.hang ?? ""}\0${reference.ho ?? ""}`;
      if (consumed.has(key)) continue;
      consumed.add(key);
      cursor = index + 1;
      return reference.ho;
    }
    return undefined;
  });
}

/** The 현행 entry whose name is exactly the verified law; ambiguous or absent → undefined. */
export function currentLawEntry(laws: readonly LawEntry[], lawName: string): LawEntry | undefined {
  const matches = laws.filter((law) => law.name === lawName && law.status === "현행" && /^\d{6}$/u.test(law.mst ?? ""));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The verifier checks the law in force when it runs. A version that took
 * effect after that day is not the one it checked.
 */
export function versionMatchesVerification(effectiveDate: string | undefined, verifiedOn: string): boolean {
  return !effectiveDate || !/^\d{8}$/u.test(effectiveDate) || effectiveDate <= verifiedOn;
}

export function ymd(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * The article's own lines: the endpoint's metadata header and lookup notes are
 * not law text, and its `제60조 연차 유급휴가` heading repeats the official
 * `제60조(연차 유급휴가)` line when both are present.
 */
export function articleLines(text: string): string[] {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const start = lines.findIndex((line) => /^\s*제[1-9]\d{0,3}조/u.test(line));
  if (start < 0) return [];
  const body = lines.slice(start);
  while (body.length && !body[body.length - 1].trim()) body.pop();
  const jo = /^\s*(제[1-9]\d{0,3}조(?:의[1-9]\d?)?)/u.exec(body[0])?.[1];
  return jo && body[1]?.trim().startsWith(`${jo}(`) ? body.slice(1) : body;
}

const HANG_MARKS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚";
const hangNumber = (line: string): number | undefined => {
  const index = HANG_MARKS.indexOf(line.trim()[0] ?? "");
  return index < 0 ? undefined : index + 1;
};
const hoNumber = (line: string): number | undefined => {
  const match = /^\s*(\d+)\.\s/u.exec(line);
  return match ? Number(match[1]) : undefined;
};

export type ArticleEvidence =
  | { kind: "found"; scope: "article" | "hang" | "ho"; lines: string[] }
  /** The article came back but the cited 항/호 is not in it. */
  | { kind: "part-missing"; part: "항" | "호"; lines: string[] };

/**
 * Selects the cited range as whole official lines: the article, the 항, or the
 * 항's lead-in line followed by the 호. Lines are never shortened.
 */
export function articleEvidence(lines: readonly string[], hang?: number, ho?: number): ArticleEvidence {
  if (!hang && !ho) return { kind: "found", scope: "article", lines: [...lines] };
  let scope = [...lines];
  if (hang) {
    const start = scope.findIndex((line) => hangNumber(line) === hang);
    if (start < 0) return { kind: "part-missing", part: "항", lines: [...lines] };
    let end = start + 1;
    while (end < scope.length && hangNumber(scope[end]) === undefined) end++;
    scope = scope.slice(start, end);
    if (!ho) return { kind: "found", scope: "hang", lines: scope };
  }
  const index = scope.findIndex((line) => hoNumber(line) === ho);
  if (index < 0) return { kind: "part-missing", part: "호", lines: scope };
  let end = index + 1;
  while (end < scope.length && hoNumber(scope[end]) === undefined && hangNumber(scope[end]) === undefined) end++;
  const leadIn = hang ? [scope[0]] : [];
  return { kind: "found", scope: "ho", lines: [...leadIn, ...scope.slice(index, end)] };
}
