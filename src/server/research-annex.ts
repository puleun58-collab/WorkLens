import type { AnnexEvidence } from "@/lib/research-annex";
import { compactLaw, lawAnnexUrl } from "@/lib/research-scope";
import { questionTerms, isLawName } from "@/lib/research-relevance";
import type { FollowupArticle } from "@/server/research-followup";
import { callLawTool } from "@/server/law-mcp";

export type AnnexReader = (law: string, number: string, form: boolean) => Promise<{ text: string; isError: boolean }>;
export const mcpAnnexReader = (context: Parameters<typeof callLawTool>[2]): AnnexReader =>
  (law, number, form) => callLawTool("get_annexes", { lawName: law, annexNo: number, knd: form ? "2" : "1" }, context);

/** Follow numbered references in fetched article bodies, including references
 * beyond a truncated annex list. An internal list code is never a form number.
 * The API has no paging parameter: no speculative paging or fabricated codes.
 */
export async function retrieveAnnexes(query: string, articles: readonly FollowupArticle[], read: AnnexReader): Promise<AnnexEvidence[]> {
  const terms = questionTerms(query).filter((t) => !isLawName(t));
  const candidates = new Map<string, AnnexEvidence & { number: string; form: boolean; score: number }>();
  for (const article of articles) {
    for (const line of article.body.split(/\n/u)) {
      for (const match of line.matchAll(/(별표|별지)\s*(?:제\s*)?(\d+)(?:\s*호)?(?:\s*의\s*(\d+))?(?:\s*서식)?/gu)) {
        // An external quoted law or an explicit different tier makes the referent ambiguous.
        const before = line.slice(0, match.index);
        if (/「[^」]+」|시행령|시행규칙/u.test(before)) continue;
        const form = match[1] === "별지";
        const number = `${match[2]}${match[3] ? `의${match[3]}` : ""}`;
        const label = form ? `별지 제${match[2]}호${match[3] ? `의${match[3]}` : ""}서식` : `별표 ${number}`;
        const score = terms.reduce((n, term) => n + (compactLaw(line).includes(compactLaw(term)) ? 1 : 0), 0)
          + (compactLaw(query).includes(compactLaw(label)) ? 20 : 0);
        const key = `${compactLaw(article.law)}\0${label}`;
        const candidate = { law: article.law, label, number, form, score, sourceArticle: article.jo, citation: line.trim(), status: "identified" as const };
        if (!candidates.has(key) || candidates.get(key)!.score < score) candidates.set(key, candidate);
      }
    }
  }
  const selected = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, 3);
  return Promise.all(selected.map(async ({ number, form, score: _score, ...candidate }): Promise<AnnexEvidence> => {
    try {
      const result = await read(candidate.law, number, form);
      if (result.isError || !result.text.trim() || /\[(?:FAILED|EXTERNAL_API_ERROR|REQUEST_TIMEOUT)\]/u.test(result.text)) return { ...candidate, status: "failed" };
      if (/\[NOT_FOUND\]/u.test(result.text)) return { ...candidate, status: "not-found" };
      const first = result.text.split("\n")[0];
      const identity = /^(.+?)\s+-\s+(.+)$/u.exec(first);
      const label = compactLaw(candidate.label);
      if (!identity || compactLaw(identity[1]) !== compactLaw(candidate.law)
        || !compactLaw(result.text).includes(`[${label}]`) || !/파일 형식/u.test(result.text)) return candidate;
      const text = result.text.slice(0, 12_000);
      const truncated = result.text.length > text.length || /생략|일부만 표시|추출 실패/u.test(result.text);
      const url = lawAnnexUrl(candidate.law, form ? "서식" : "별표", number);
      return { ...candidate, status: truncated ? "identified" : "verified", title: identity[2], text,
        ...(truncated ? { truncated: true } : {}),
        ...(url ? { url } : {}) };
    } catch { return { ...candidate, status: "failed" }; }
  }));
}
