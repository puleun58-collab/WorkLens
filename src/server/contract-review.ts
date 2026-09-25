import {
  classifyDocument, documentRisk, extractKeyFacts, holdingRelevance, issueDefinition, lawTargets, passesMetadataGate,
  precedentQueries, reviewClauses, splitClauses,
  type ContractReview, type DocumentProfile, type IssueDefinition, type LawReference, type LawTarget,
  type PrecedentReference, type ReviewedIssue, type SourceStatus,
} from "@/lib/contract-review";
import { getDecisionText, searchDecisions, type DecisionEntry } from "@/server/decision-mcp";
import { getLawText, searchLaw } from "@/server/law-mcp";
import { lawDisplayText } from "@/lib/law-display";

type Context = { requestId: string; signal?: AbortSignal };

/** The four 법제처 lookups the review uses; injectable so the pipeline is testable offline. */
export interface ReviewSources {
  findLaw(name: string): Promise<{ mst: string } | undefined>;
  article(mst: string, jo: string): Promise<string | undefined>;
  searchPrecedents(query: string): Promise<DecisionEntry[]>;
  /** The compact 판시사항 view of a precedent; the full judgment is never fetched here. */
  holding(id: string): Promise<string | undefined>;
}

export function mcpReviewSources(context: Context): ReviewSources {
  return {
    async findLaw(name) {
      const result = await searchLaw(name, context);
      if (!result.found) return undefined;
      const law = result.laws.find((entry) => entry.name === name && (!entry.status || entry.status === "현행"));
      return law?.mst ? { mst: law.mst } : undefined;
    },
    async article(mst, jo) {
      const result = await getLawText({ mst }, jo, context);
      return result.found ? result.text : undefined;
    },
    async searchPrecedents(query) {
      const result = await searchDecisions("precedent", query, 1, context);
      return result.found ? result.entries : [];
    },
    async holding(id) {
      const result = await getDecisionText("precedent", id, undefined, context);
      if (!result.found) return undefined;
      const holding = result.sections?.find((section) => section.heading === "판시사항")?.text;
      return holding ? lawDisplayText(holding) : undefined;
    },
  };
}

/** Parallel lookups stay polite to the upstream and inside the request's time budget. */
const CONCURRENCY = 4;
const BUDGET_MS = 50_000;
/** Candidates whose 판시사항 is read per search step, and per issue group in total; the rest are never fetched. */
const HOLDINGS_PER_STEP = 5;
const HOLDINGS_PER_GROUP = 8;

function articleReference(target: LawTarget, text: string, effectiveDate?: string): LawReference | undefined {
  const lines = text.split(/\r?\n/u);
  const head = lines.findIndex((line) => new RegExp(`^${target.jo}(?:\\s|\\(|$)`, "u").test(line.trim()));
  if (head < 0) return undefined;
  const title = lines[head].trim().slice(target.jo.length).replace(/^\s*\(?|\)?\s*$/gu, "").trim();
  const body = lines.slice(head + 1).map((line) => line.trim()).filter(Boolean).join("\n");
  if (!body) return undefined;
  return {
    key: `${target.law}\0${target.jo}`,
    law: target.law,
    jo: target.jo,
    title,
    excerpt: body.length > 700 ? `${body.slice(0, 700).trimEnd()}…` : body,
    ...(effectiveDate ? { effectiveDate } : {}),
    ...(target.condition ? { condition: target.condition } : {}),
  };
}

/** Case subjects about contracts and their terms; property, criminal and tax titles score 0. */
const CONTRACT_SUBJECT = /약관|약정|계약|손해배상|위약|해지|해제|부당이득|정산금|대금|이용료|요금|수수료|채무부존재|관할|개인정보|보험금/u;

function caseSubjectScore(entry: DecisionEntry, issue: IssueDefinition): number {
  const title = entry.title ?? "";
  const direct = issue.titleTerms?.test(title) || issue.holdingTerms?.test(title);
  return (direct ? 2 : 0) + (CONTRACT_SUBJECT.test(title) ? 1 : 0);
}

export async function reviewContract(text: string, sources: ReviewSources, now: () => number = Date.now): Promise<ContractReview> {
  const started = now();
  const profile: DocumentProfile = classifyDocument(text);
  const clauses = reviewClauses(splitClauses(text), profile);
  const stats = { calls: 0, queries: 0, excludedPrecedents: 0, excludedLaws: 0 };

  // One promise per distinct lookup: the same statute, search or judgment is never requested twice.
  const memo = new Map<string, Promise<unknown>>();
  let active = 0;
  const waiting: Array<() => void> = [];
  const lookup = <T,>(key: string, run: () => Promise<T>): Promise<T> => {
    const existing = memo.get(key);
    if (existing) return existing as Promise<T>;
    const promise = (async () => {
      while (active >= CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
      if (now() - started > BUDGET_MS) {
        // Out of time: skip this lookup but wake the next one, so the whole queue drains.
        waiting.shift()?.();
        throw new Error("budget");
      }
      active += 1;
      stats.calls += 1;
      try {
        return await run();
      } finally {
        active -= 1;
        waiting.shift()?.();
      }
    })();
    memo.set(key, promise);
    return promise;
  };

  const laws: Record<string, LawReference> = {};
  const precedents: Record<string, PrecedentReference> = {};

  async function resolveLaws(issue: IssueDefinition): Promise<{ keys: string[]; status: SourceStatus }> {
    const targets = lawTargets(issue, profile);
    stats.excludedLaws += issue.laws.length - targets.length;
    if (!targets.length) return { keys: [], status: "not_searched" };
    let failed = 0;
    const keys: string[] = [];
    for (const target of targets) {
      try {
        const law = await lookup(`law:${target.law}`, () => sources.findLaw(target.law));
        if (!law) continue;
        const article = await lookup(`article:${law.mst}:${target.jo}`, () => sources.article(law.mst, target.jo));
        const effective = article && /^시행일:\s*(\d{8})/mu.exec(article)?.[1];
        const reference = article ? articleReference(target, article, effective) : undefined;
        if (!reference) continue;
        laws[reference.key] ??= reference;
        keys.push(reference.key);
      } catch {
        failed += 1;
      }
    }
    return { keys, status: keys.length ? "found" : failed === targets.length ? "failed" : "none" };
  }

  async function resolvePrecedents(issue: IssueDefinition): Promise<{ keys: string[]; status: SourceStatus }> {
    const queries = precedentQueries(issue, profile);
    if (!queries.length || !issue.holdingTerms) return { keys: [], status: "not_searched" };
    let failed = 0;
    let read = 0;
    // Staged search: the most specific query first, widened only while nothing relevant is found.
    for (const query of queries) {
      let entries: DecisionEntry[];
      try {
        stats.queries += 1;
        entries = await lookup(`search:${query}`, () => sources.searchPrecedents(query));
      } catch {
        failed += 1;
        continue;
      }
      // Metadata gate: excluded areas out; then only case subjects that can bear on
      // a contract term are read, most on-point first. Search rank alone decides nothing.
      const candidates = entries.filter((entry) => {
        const pass = passesMetadataGate(entry, profile);
        if (!pass) stats.excludedPrecedents += 1;
        return pass;
      })
        .map((entry, index) => ({ entry, index, score: caseSubjectScore(entry, issue) }))
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, Math.min(HOLDINGS_PER_STEP, HOLDINGS_PER_GROUP - read))
        .map(({ entry }) => entry);
      const keys: string[] = [];
      for (const entry of candidates) {
        let holding: string | undefined;
        read += 1;
        try {
          holding = await lookup(`holding:${entry.id}`, () => sources.holding(entry.id));
        } catch {
          continue;
        }
        const sentence = holding ? holdingRelevance(holding, issue, profile) : undefined;
        const key = `precedent:${entry.id}`;
        // Companion cases often repeat one holding word for word; it is shown once.
        const repeated = sentence !== undefined && Object.values(precedents).some((other) => other.key !== key && other.holding === sentence);
        if (!sentence || repeated) {
          stats.excludedPrecedents += 1;
          continue;
        }
        precedents[key] ??= {
          key, id: entry.id, holding: sentence, scope: "판시사항",
          ...(entry.title ? { title: entry.title } : {}),
          ...(entry.caseNumber ? { caseNumber: entry.caseNumber } : {}),
          ...(entry.court ? { court: entry.court } : {}),
          ...(entry.date ? { date: entry.date } : {}),
        };
        keys.push(key);
      }
      if (keys.length) return { keys, status: "found" };
    }
    return { keys: [], status: failed === queries.length ? "failed" : "none" };
  }

  // Issues that share a legal question reuse one precedent search per group.
  const issueIds = [...new Set(clauses.flatMap((clause) => clause.issues.map((issue) => issue.id)))];
  const groupResults = new Map<string, Promise<{ keys: string[]; status: SourceStatus }>>();
  const resolved = new Map<string, Promise<[{ keys: string[]; status: SourceStatus }, { keys: string[]; status: SourceStatus }]>>();
  for (const id of issueIds) {
    const issue = issueDefinition(id)!;
    const group = issue.group ?? issue.id;
    if (!groupResults.has(group)) {
      const representative = issueIds.map((other) => issueDefinition(other)!)
        .find((other) => (other.group ?? other.id) === group && other.queries?.length) ?? issue;
      groupResults.set(group, resolvePrecedents(representative));
    }
    resolved.set(id, Promise.all([resolveLaws(issue), groupResults.get(group)!]));
  }

  const reviewedClauses: ContractReview["clauses"] = [];
  for (const clause of clauses) {
    const issues: ReviewedIssue[] = [];
    for (const issue of clause.issues) {
      const [law, precedent] = await resolved.get(issue.id)!;
      issues.push({ ...issue, laws: law.keys, precedents: precedent.keys, lawStatus: law.status, precedentStatus: precedent.status });
    }
    reviewedClauses.push({ ...clause, issues });
  }

  return {
    document: profile,
    risk: documentRisk(clauses),
    facts: extractKeyFacts(clauses),
    clauses: reviewedClauses.filter((clause) => clause.issues.length),
    laws,
    precedents,
    stats,
  };
}
