import { researchResult } from "@/lib/law-research-parse";

/**
 * Shared, deterministic evidence vocabulary for the non-full-research tasks
 * that used to fall back to a blanket `weak` whenever material was retrieved.
 * A status here never claims more than the check behind it:
 * - `matched`: every required kind of evidence was confirmed from source text.
 * - `partial`: some required kinds were confirmed; the confirmed ones stay.
 * - `viewed`: material was retrieved, but no required kind was confirmed
 *   from its body — retrieval alone is never a confirmation.
 * - `none`: a normal empty search (nothing retrieved).
 * - `failed`: no usable section at all; a failed lookup is never read as
 *   "no law exists".
 * Per-task modules decide which kinds a question requires; this file only
 * supplies the shared MCP-text plumbing (detailed-format articles the shared
 * parser classifies as `other`, section failure detection, and the
 * matched → partial cap for partial failures). It never invents a relation,
 * a period, an effect, or a legal conclusion.
 */
export type TaskEvidenceStatus = "matched" | "partial" | "viewed" | "none" | "failed";

export type TaskEvidenceItemStatus = "found" | "viewed" | "none" | "failed";

export interface TaskEvidenceItem {
  label: string;
  status: TaskEvidenceItemStatus;
  /** Counts or citations behind the item, e.g. "시행령 4건 · 위임 연결 2건". */
  detail?: string;
}

export interface TaskEvidence {
  status: TaskEvidenceStatus;
  items: TaskEvidenceItem[];
}

/** A section that returned source content, as opposed to an empty or failed one. */
export function hasAvailableContent(text: string): boolean {
  if (!text.trim()) return false;
  return researchResult(text).sections.some((section) => section.status === "available" && section.lines.join("\n").trim());
}

/** Any section the MCP itself marked failed or time-limited. */
export function hasFailedSection(text: string): boolean {
  return researchResult(text).sections.some((section) => section.unavailable);
}

/** True when every section failed or timed out (or there is no text at all). */
export function hasNoUsableSection(text: string): boolean {
  if (!text.trim()) return true;
  const sections = researchResult(text).sections;
  return sections.length > 0 && sections.every((section) => section.unavailable);
}

/** A confirmed result survives a partial failure, but it is no longer "all confirmed". */
export function capForFailure(status: TaskEvidenceStatus, failed: boolean): TaskEvidenceStatus {
  return failed && status === "matched" ? "partial" : status;
}

export interface DetailArticle {
  tier: "law" | "decree" | "rule" | "other";
  law: string;
  jo: string;
  title: string;
  body: string;
}

const DETAIL_HEAD = /^\[(시행령|시행규칙)\]\s*(.+?)\s*제(\d+조(?:의\d+)?)\s*\((.+)\)\s*$/u;
const LAW_HEAD = /^제(\d+조(?:의\d+)?)\s+제\1\((.+)\)\s*$/u;

/**
 * Detailed-format articles the shared parser leaves as `other`: `[시행령] …
 * 제N조 (제목)` / `[시행규칙] …` blocks followed by their body, plus the
 * law-tier `제N조 제N조(제목)` lines of a 3단 비교 section. Only the MCP's
 * own text is read; a header alone yields an empty body and therefore never
 * counts as body-confirmed evidence in any caller.
 */
export function detailArticles(text: string): DetailArticle[] {
  const articles: DetailArticle[] = [];
  let current: DetailArticle | undefined;
  for (const line of text.split("\n")) {
    if (/^▶/u.test(line) || line.startsWith("═══")) { current = undefined; continue; }
    const detail = DETAIL_HEAD.exec(line.trim());
    if (detail) {
      current = { tier: detail[1] === "시행령" ? "decree" : "rule", law: detail[2].trim(),
        jo: `제${detail[3]}`, title: detail[4].trim(), body: "" };
      articles.push(current);
      continue;
    }
    const law = LAW_HEAD.exec(line.trim());
    if (law) {
      current = { tier: "law", law: "", jo: `제${law[1]}`, title: law[2].trim(), body: "" };
      articles.push(current);
      continue;
    }
    if (/^---\s*$/u.test(line.trim())) { current = undefined; continue; }
    if (current) current.body += `${current.body ? "\n" : ""}${line}`;
  }
  return articles.map((article) => ({ ...article, body: article.body.trim() }));
}

/** Content markers that prove a detail dump is a decision's substance, not its title. */
const DECISION_CONTENT = /판시사항|판결요지|결정요지|재결요지/u;

/**
 * Case numbers whose substance the MCP itself fetched into a detail section
 * (판시사항/판결요지/결정요지/재결요지 present). A search-list title or case
 * number alone never lands here.
 */
export function verifiedDecisionCaseNumbers(text: string): Set<string> {
  const verified = new Set<string>();
  for (const section of researchResult(text).sections) {
    if (section.kind !== "detail") continue;
    const body = section.lines.join("\n");
    if (!DECISION_CONTENT.test(body)) continue;
    for (const match of body.matchAll(/사건번호:\s*([^\s]+)/gu)) verified.add(match[1]);
  }
  return verified;
}
