import type { AnnexEvidence } from "@/lib/research-annex";
import { actionTerms, asksSubstituteFine, concernsAction, isDispositionAct } from "@/lib/action-basis-evidence";
import type { LawResearchTask } from "@/lib/law-research";
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
 *
 * 처분·허가 근거 (`task === "action_basis"`): a citation is followed only when
 * it concerns the question's legal act — the citing line names the act (or
 * both its parts), a disposition question's line sets the 행정처분 기준, or
 * the question names the annex itself. A substitute-fine (과징금) or 과태료
 * table is a different institution and is read only when the question asks
 * about it. Being cited by some article, or sharing a word, is not relevance.
 * Other tasks keep lexical ranking (relevance "related").
 */
export async function retrieveAnnexes(query: string, articles: readonly FollowupArticle[], read: AnnexReader, task?: LawResearchTask): Promise<AnnexEvidence[]> {
  const terms = questionTerms(query).filter((t) => !isLawName(t));
  const acts = task === "action_basis" ? actionTerms(query) : [];
  const disposition = isDispositionAct(acts);
  const asksFine = asksSubstituteFine(query);
  const asksPenalty = /과태료/u.test(query);
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
        const named = compactLaw(query).includes(compactLaw(label));
        let relevance: AnnexEvidence["relevance"] = "related";
        if (task === "action_basis" && acts.length && !named) {
          // Another institution (과징금·과태료) or an ancillary step (신청서 서식·수수료)
          // is not the act's criteria unless the question names it.
          const otherInstitution = (!asksFine && /과징금/u.test(line)) || (!asksPenalty && /과태료/u.test(line));
          const ancillary = form || /수수료|신청서|서식/u.test(line);
          const concerns = concernsAction(line, acts) || (disposition && /행정처분/u.test(line) && /기준/u.test(line));
          if (otherInstitution || ancillary || !concerns) continue;
          relevance = "direct";
        } else if (task === "action_basis" && named) relevance = "direct";
        const score = terms.reduce((n, term) => n + (compactLaw(line).includes(compactLaw(term)) ? 1 : 0), 0)
          + (named ? 20 : 0);
        const key = `${compactLaw(article.law)}\0${label}`;
        const candidate = { law: article.law, label, number, form, score, sourceArticle: article.jo, citation: line.trim(), status: "identified" as const, relevance };
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
      const text = result.text.slice(0, 200_000);
      // The preservation cap must cover a complete annex table, not cut
      // it: a 44,000-character table the upstream returned whole (identity
      // checked, no omission marker) is a verified original, not a
      // truncated one. The cap stays as a bound — anything longer, or
      // carrying an omission marker, still reports identified, never
      // verified on a partial text.
      const truncated = result.text.length > text.length || /생략|일부만 표시|추출 실패/u.test(result.text);
      const url = lawAnnexUrl(candidate.law, form ? "서식" : "별표", number);
      return { ...candidate, status: truncated ? "identified" : "verified", title: identity[2], text,
        ...(truncated ? { truncated: true } : {}),
        ...(url ? { url } : {}) };
    } catch { return { ...candidate, status: "failed" }; }
  }));
}
