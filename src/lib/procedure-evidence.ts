import type { ResearchDocument } from "@/lib/law-research-parse";

/**
 * Server-side, deterministic evidence assessment for the 절차·서식
 * (procedure_detail) task. No AI interpretation, no new lookup: it judges
 * only the MCP text the chain already returned, requirement by requirement.
 *
 * Status vocabulary (per requirement, then overall):
 * - `found`: an article body actually supports the requirement (title alone
 *   never counts, an annex list alone never counts as a filing duty).
 * - `viewed`: related material was retrieved (a matching title, an annex
 *   entry, or unparsed section text) but no supporting body was confirmed.
 * - `none`: searched, nothing related was found.
 * - `failed`: no material for the requirement and a section failed or timed
 *   out, so absence is unknown — never "no such law".
 *
 * Overall: all found → `matched`; some found → `partial`; no found but some
 * viewed → `viewed`; no material but a failure → `failed`; else `none`.
 * A would-be `matched` with any failed section is demoted to `partial`:
 * confirmed facts stay, but completeness is not claimed.
 */

export type ProcedureRequirementKind = "procedure" | "forms" | "cost" | "general";
export type ProcedureRequirementStatus = "found" | "viewed" | "none" | "failed";
export type ProcedureOverall = "matched" | "partial" | "viewed" | "none" | "failed";
export type ProcedureFormNature = "required" | "conditional" | "optional" | "unconfirmed";

export interface ProcedureArticleRef {
  law: string;
  jo: string;
  title?: string;
  /** Forms only: what the article body itself says about the filing duty. */
  nature?: ProcedureFormNature;
}

export interface ProcedureRequirementEvidence {
  label: string;
  kind: ProcedureRequirementKind;
  status: ProcedureRequirementStatus;
  /** Directly supporting articles; empty for viewed/none/failed. */
  articles: ProcedureArticleRef[];
  /** Title-only or otherwise related articles (viewed, never direct). */
  related?: ProcedureArticleRef[];
  /** Distinct matching annex entries (titles only — never direct evidence). */
  annexCount: number;
  annexTotal?: number;
  /** No parsed article matched, but section text mentions the requirement. */
  unparsed?: true;
}

export interface ProcedureEvidence {
  requirements: ProcedureRequirementEvidence[];
  overall: ProcedureOverall;
  /** A section failed/timed out or a requirement failed: completeness is open. */
  incomplete: boolean;
  /** An annex list was cut (entries < the stated total): originals not held. */
  annexTruncated: boolean;
  failedSections: number;
}

export interface ProcedureRequirement {
  label: string;
  kind: ProcedureRequirementKind;
}

const PROCEDURE_STEMS = ["절차", "진행", "방법", "방식", "단계", "접수", "처리"];
const FORMS_STEMS = ["서식", "서류", "신청서", "청구서", "첨부서류", "구비서류", "양식"];
const COST_STEMS = ["비용", "수수료", "부담금", "송달료"];
const KIND_STEMS = [...PROCEDURE_STEMS, ...FORMS_STEMS, ...COST_STEMS, "신청", "청구", "제출", "안내", "확인"];
const FRAME_WORDS = new Set(["알려줘", "알려주세요", "궁금해", "궁금해요", "대해", "대한", "관해", "관련", "기준", "경우", "때", "확인해", "줘", "주세요"]);
const PARTICLE = /(?:와|과|은|는|이|가|을|를|의|에|로|도|만)$/u;

const compact = (value: string) => value.replace(/\s+/gu, "");

/** Subject stems of a phrase: words left after kind stems and particles are stripped. */
function subjectStems(text: string): string[] {
  const stems: string[] = [];
  for (const raw of text.split(/[\s,·]+/u)) {
    if (!raw || FRAME_WORDS.has(raw)) continue;
    let token = raw.replace(PARTICLE, "");
    for (const stem of KIND_STEMS) token = token.split(stem).join("");
    token = token.replace(/^(?:법령|법률)$/u, "");
    if (token.length >= 2 && !stems.includes(token)) stems.push(token);
  }
  return stems;
}

function tokensWith(text: string, stems: readonly string[]): string[] {
  return text.split(/[\s,·]+/u).filter((token) => stems.some((stem) => token.includes(stem)));
}

/** Split a question on 와/과/및/그리고/콤마; a segment without a subject inherits the first segment's. */
export function identifyProcedureRequirements(query: string): ProcedureRequirement[] {
  const cleaned = query.trim().replace(/[?\uFF1F\u3002\s]+$/u, "");
  const tokens = cleaned.split(/\s+/u).flatMap((token) => token.split(/(?<=,)/u)).filter(Boolean);
  const segments: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const segment = current.join(" ").replace(/,\s*$/u, "").trim();
    if (segment) segments.push(segment);
    current = [];
  };
  for (const token of tokens) {
    if (/^(?:와|과|및|그리고|,)$/u.test(token)) { flush(); continue; }
    const connective = /^(.*?)(와|과|및|그리고)$/u.exec(token);
    if (connective && connective[1].length >= 2) { current.push(connective[1]); flush(); continue; }
    const comma = /^(.*?),$/u.exec(token);
    if (comma && comma[1]) { current.push(comma[1]); flush(); continue; }
    current.push(token);
  }
  flush();
  if (segments.length > 6) return [{ label: cleaned, kind: "general" }];
  const firstSubjects = segments.length ? subjectStems(segments[0]) : [];
  const requirements: ProcedureRequirement[] = [];
  for (const segment of segments) {
    const subjects = subjectStems(segment);
    const subjectPrefix = subjects.length ? "" : firstSubjects.length ? `${firstSubjects.join(" ")} ` : "";
    const labelled = `${subjectPrefix}${segment}`;
    const hasForms = FORMS_STEMS.some((stem) => segment.includes(stem));
    const hasCost = COST_STEMS.some((stem) => segment.includes(stem));
    const hasProcedure = PROCEDURE_STEMS.some((stem) => segment.includes(stem))
      || /신청|청구/u.test(segment);
    const kinds: ProcedureRequirementKind[] = [];
    if (hasProcedure) kinds.push("procedure");
    if (hasForms) kinds.push("forms");
    if (hasCost) kinds.push("cost");
    if (!kinds.length) {
      requirements.push({ label: labelled, kind: "general" });
      continue;
    }
    for (const kind of kinds) {
      const stems = kind === "procedure" ? [...PROCEDURE_STEMS, "신청", "청구"]
        : kind === "forms" ? FORMS_STEMS : COST_STEMS;
      const phrase = tokensWith(segment, stems).join(" ");
      const subject = subjects.length ? subjects.join(" ") : firstSubjects.join(" ");
      const finalLabel = kinds.length > 1
        ? `${subject ? `${subject} ` : ""}${phrase || segment}`.trim()
        : labelled;
      if (!requirements.some((item) => item.kind === kind && item.label === finalLabel)) {
        requirements.push({ label: finalLabel, kind });
      }
    }
  }
  return requirements.length ? requirements : [{ label: cleaned, kind: "general" }];
}

interface ArticleCandidate {
  law: string;
  jo: string;
  title: string;
  body: string;
  truncated: boolean;
}

/** `[시행령] 행정심판법 시행령 제13조 (제목)` + body lines: the format the shared parser leaves as `other`. */
const DETAIL_LINE = /^\[(시행령|시행규칙|법률|대통령령|총리령|부령|규칙)\]\s*(.+?)\s+제(\d+)조(의\d+)?\s*\((.+)\)\s*$/u;
const TRUNCATION_LINE = /위임 내용 .*일부만 표시|외 \d+개 .*\(생략\)/u;

function extractDetailArticles(text: string): ArticleCandidate[] {
  const lines = text.split("\n");
  const found = new Map<string, ArticleCandidate>();
  for (let i = 0; i < lines.length; i++) {
    const match = DETAIL_LINE.exec(lines[i].trim());
    if (!match) continue;
    const law = match[2].trim();
    const jo = `제${match[3]}조${match[4] ?? ""}`;
    const title = match[5].trim();
    const bodyLines: string[] = [];
    let truncated = false;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim() || line.startsWith("▶") || line.startsWith("═══") || line.trim() === "---"
        || DETAIL_LINE.test(line.trim()) || /^\s*\[/u.test(line) && !/^\s*①/u.test(line)) break;
      if (TRUNCATION_LINE.test(line)) { truncated = true; continue; }
      bodyLines.push(line.trim());
    }
    const key = `${law}\0${jo}`;
    if (!found.has(key)) found.set(key, { law, jo, title, body: bodyLines.join(" "), truncated });
  }
  return [...found.values()];
}

function chainLaws(text: string): string[] {
  const laws: string[] = [];
  for (const match of text.matchAll(/^\s*법령명:\s*(.+?)\s*$/gmu)) {
    const law = match[1].trim();
    if (law && !laws.includes(law)) laws.push(law);
  }
  const header = /^\s*법령:\s*([^|(]+?)\s*(?:\(|\|)/mu.exec(text)?.[1]?.trim();
  if (header && !laws.includes(header)) laws.unshift(header);
  return laws.slice(0, 3);
}

function chainRoot(law: string): string {
  let root = compact(law);
  for (const suffix of ["시행규칙", "시행령", "법률", "규칙", "법"]) {
    if (root.endsWith(suffix) && root.length > suffix.length) root = root.slice(0, -suffix.length);
  }
  return root;
}

function anchored(candidate: { law: string; title: string; body: string }, subjects: string[], chains: string[]): boolean {
  const law = compact(candidate.law);
  const title = compact(candidate.title);
  const body = compact(candidate.body);
  if (subjects.length) {
    return subjects.some((subject) => {
      const needle = compact(subject);
      return needle.length >= 2 && (law.includes(needle) || title.includes(needle) || body.includes(needle));
    });
  }
  return chains.some((chain) => {
    const root = chainRoot(chain);
    return root.length >= 2 && law.includes(root);
  });
}

const PROCEDURE_TITLE_TERMS = ["절차", "진행", "방법", "방식", "단계", "접수", "처리", "신청", "청구", "심리", "통지", "송달", "기한", "보정"];
const PROCEDURE_BODY_TERMS = [...PROCEDURE_TITLE_TERMS, "제출", "서면", "결정", "기간"];
const FORM_NOUNS = ["청구서", "신청서", "서식", "첨부서류", "구비서류", "별지"];
const FORM_CONTENT_TERMS = ["제출", "작성", "포함", "첨부", "기재", "서면"];
const COST_BODY_TERMS = ["비용", "수수료"];

function distinctTerms(body: string, terms: readonly string[]): number {
  return terms.filter((term) => body.includes(term)).length;
}

function formNature(body: string): ProcedureFormNature {
  if (/(하여야 한다|해야 한다|제출하여야|포함되어야|서면으로 하여야)/u.test(body)) return "required";
  if (/(인 경우|경우에는|해당하는)/u.test(body) && /(하여야|해야|제출|첨부)/u.test(body)) return "conditional";
  if (/할 수 있다/u.test(body)) return "optional";
  return "unconfirmed";
}

export function assessProcedureEvidence(query: string, document: ResearchDocument, text: string): ProcedureEvidence {
  const requirements = identifyProcedureRequirements(query);
  const chains = chainLaws(text);
  const parsed: ArticleCandidate[] = document.sections
    .filter((section) => section.status === "available")
    .flatMap((section) => (section.articles ?? []).map((article) => ({
      law: article.law, jo: article.jo, title: article.title ?? "", body: article.excerpt ?? "",
      truncated: article.excerpt.trim().endsWith("..."),
    })));
  const detail = extractDetailArticles(text);
  const candidates = [...parsed];
  for (const article of detail) {
    if (!candidates.some((item) => item.law === article.law && item.jo === article.jo)) candidates.push(article);
  }
  const annexEntries = new Map<string, { title: string; law: string }>();
  let annexTotal: number | undefined;
  let annexTruncated = false;
  for (const section of document.sections.filter((section) => section.status === "available" && section.kind === "annex" && section.annex)) {
    annexTotal = Math.max(annexTotal ?? 0, section.annex!.total ?? 0);
    for (const entry of section.annex!.entries) {
      annexEntries.set(`${entry.title}\0${entry.law ?? ""}`, { title: entry.title, law: entry.law ?? "" });
    }
  }
  if (annexTotal !== undefined && annexEntries.size < annexTotal) annexTruncated = true;
  const failedSections = document.sections.filter((section) => section.unavailable).length;

  const assessed: ProcedureRequirementEvidence[] = requirements.map((requirement) => {
    const subjects = requirement.kind === "general"
      ? subjectStems(query)
      : subjectStems(requirement.label);
    const articles: ProcedureArticleRef[] = [];
    const related: ProcedureArticleRef[] = [];
    const seen = new Set<string>();
    const push = (list: ProcedureArticleRef[], candidate: ArticleCandidate, nature?: ProcedureFormNature) => {
      const key = `${candidate.law}\0${candidate.jo}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ law: candidate.law, jo: candidate.jo, ...(candidate.title ? { title: candidate.title } : {}),
        ...(nature ? { nature } : {}) });
    };
    for (const candidate of candidates) {
      if (!anchored(candidate, subjects, chains)) continue;
      const body = candidate.body.trim();
      const bodyLen = body.length;
      if (requirement.kind === "procedure") {
        const titleHit = PROCEDURE_TITLE_TERMS.some((term) => candidate.title.includes(term));
        const bodyHits = distinctTerms(body, PROCEDURE_BODY_TERMS);
        if (bodyLen >= 20 && bodyHits >= 1 && (titleHit || bodyHits >= 2)) {
          push(articles, candidate);
        } else if (titleHit) {
          push(related, candidate);
        }
      } else if (requirement.kind === "forms") {
        const formHit = FORM_NOUNS.some((term) => candidate.title.includes(term) || body.includes(term));
        const contentHit = FORM_CONTENT_TERMS.some((term) => body.includes(term));
        if (bodyLen >= 20 && formHit && contentHit) {
          push(articles, candidate, formNature(body));
        } else if (formHit) {
          push(related, candidate);
        }
      } else if (requirement.kind === "cost") {
        const costHit = COST_BODY_TERMS.some((term) => body.includes(term));
        const amountHit = /(원|금액|부담|납부|면제)/u.test(body);
        if (bodyLen >= 20 && costHit && amountHit) push(articles, candidate);
        else if (costHit) push(related, candidate);
      } else {
        if (bodyLen >= 20) push(articles, candidate);
        else if (candidate.title) push(related, candidate);
      }
    }
    let annexCount = 0;
    if (requirement.kind === "forms" || requirement.kind === "general") {
      for (const entry of annexEntries.values()) {
        const entrySubjects = subjects.length ? subjects : chains.map(chainRoot);
        const lawHit = entrySubjects.some((subject) => compact(entry.law).includes(compact(subject)))
          || chains.some((chain) => compact(entry.law).includes(chainRoot(chain)));
        if (lawHit) annexCount++;
      }
    }
    let status: ProcedureRequirementStatus;
    let unparsed: true | undefined;
    if (articles.length) {
      status = "found";
    } else if (related.length || annexCount > 0) {
      status = "viewed";
    } else {
      // Unparsed section prose that names the subject and the requirement's
      // kind is related material, never direct evidence.
      const kindTerms = requirement.kind === "procedure" ? PROCEDURE_TITLE_TERMS
        : requirement.kind === "forms" ? FORM_NOUNS
        : requirement.kind === "cost" ? COST_BODY_TERMS : [];
      const prose = document.sections.some((section) => section.status === "available"
        && (section.kind === "other" || section.kind === "detail")
        && (subjects.length
          ? subjects.some((subject) => compact(section.lines.join("\n")).includes(compact(subject)))
          : chains.some((chain) => compact(section.lines.join("\n")).includes(chainRoot(chain))))
        && (requirement.kind === "general" || kindTerms.some((term) => section.lines.join("\n").includes(term))));
      if (prose) { status = "viewed"; unparsed = true; }
      else status = failedSections > 0 ? "failed" : "none";
    }
    return {
      label: requirement.label, kind: requirement.kind, status, articles,
      ...(related.length ? { related } : {}),
      annexCount, ...(annexTotal !== undefined ? { annexTotal } : {}),
      ...(unparsed ? { unparsed } : {}),
    };
  });

  const foundCount = assessed.filter((item) => item.status === "found").length;
  const viewedCount = assessed.filter((item) => item.status === "viewed").length;
  const failedCount = assessed.filter((item) => item.status === "failed").length;
  const incomplete = failedSections > 0 || failedCount > 0;
  let overall: ProcedureOverall = foundCount === assessed.length ? "matched"
    : foundCount > 0 ? "partial"
    : viewedCount > 0 ? "viewed"
    : failedCount > 0 ? "failed" : "none";
  if (overall === "matched" && incomplete) overall = "partial";
  return { requirements: assessed, overall, incomplete, annexTruncated, failedSections };
}
