import {
  classifyDocument, documentRisk, extractKeyFacts, holdingRelevance, issueDefinition, lawTargets, passesMetadataGate,
  precedentQueries, reviewClauses, segmentsOf, splitClauses,
  type Clause, type ClauseIssue, type ContractReview, type DocumentProfile, type FailureReason, type IssueDefinition, type LawReference,
  type LawTarget, type PrecedentReference, type ReviewDiagnostics, type ReviewedClause, type ReviewedIssue, type SourceStatus,
} from "@/lib/contract-review";
import { getDecisionText, searchDecisions, type DecisionEntry } from "@/server/decision-mcp";
import { ApiError } from "@/server/http";
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
  const content = lines.slice(head + 1).map((line) => line.trim()).filter(Boolean);
  if (content[0]?.startsWith(target.jo)
    && content[0].slice(target.jo.length).replace(/^\s*\(?|\)?\s*$/gu, "").trim() === title) content.shift();
  const body = content.join("\n");
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

/** Maps a lookup error to its diagnostic reason. `budget` is this module's own time limit. */
export function failureReason(error: unknown): FailureReason {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "LAW_UPSTREAM_TIMEOUT": return "timeout";
      case "LAW_RATE_LIMITED": case "OPERATION_CAPACITY": return "rate_limit";
      case "LAW_REQUEST_ABORTED": return "cancelled";
      case "LAW_MCP_ERROR": return "invalid_response";
      // A thrown fetch or body read keeps its cause; a non-OK upstream response has none.
      case "LAW_UPSTREAM_UNAVAILABLE": return error.cause === undefined ? "upstream_unavailable" : "network";
      default: return "upstream_unavailable";
    }
  }
  if (error instanceof Error && error.message === LOOKUP_BUDGET) return "budget";
  if (error instanceof DOMException) return error.name === "TimeoutError" ? "timeout" : error.name === "AbortError" ? "cancelled" : "network";
  if (error instanceof TypeError) return "network";
  return "upstream_unavailable";
}

const LOOKUP_BUDGET = "budget";
type Resolution = { keys: string[]; status: SourceStatus; failure?: FailureReason };

/**
 * One profile and lookup memo across every selected document range and semantic batch. The input
 * is only text (and its range boundaries): every issue, severity, fact and lookup below is decided
 * here from that text. Optional classification context is verbatim opening text, not a client judgment.
 */
export async function reviewContract(
  input: string | readonly string[] | readonly { text: string; batch?: number }[],
  sources: ReviewSources, now: () => number = Date.now, signal?: AbortSignal, classificationContext?: string,
): Promise<ContractReview> {
  const started = now();
  signal?.throwIfAborted();
  const texts = typeof input === "string" ? [input] : input.map((part) => typeof part === "string" ? part : part.text);
  const text = texts.join("\n");
  const profile: DocumentProfile = classifyDocument(classificationContext ? `${classificationContext}\n${text}` : text);
  const split: Clause[] = [];
  if (typeof input === "string") split.push(...splitClauses(input));
  else {
    const batchOf = (part: string | { text: string; batch?: number }) => typeof part === "string" ? 0 : part.batch ?? 0;
    for (let first = 0; first < input.length;) {
      const batch = batchOf(input[first]);
      let last = first + 1;
      while (last < input.length && batchOf(input[last]) === batch) last += 1;
      for (const clause of splitClauses(texts.slice(first, last))) {
        split.push({ ...clause, ...(clause.sources ? { sources: clause.sources.map((source) =>
          ({ ...source, segment: source.segment + first })) } : {}) });
      }
      first = last;
    }
  }
  const clauses: ReviewedClause[] = [];
  let section: Clause[] = [];
  let chars = 0;
  const flush = () => {
    if (section.length) clauses.push(...reviewClauses(section, profile));
    section = [];
    chars = 0;
  };
  for (const clause of split) {
    signal?.throwIfAborted();
    if (chars && chars + clause.text.length > 8_000) flush();
    section.push(clause);
    chars += clause.text.length;
  }
  flush();
  // A repeated boilerplate issue is one finding with all its source positions.
  const seen = new Map<string, ClauseIssue>();
  for (const clause of clauses) clause.issues = clause.issues.filter((issue) => {
    const key = `${issue.id}\0${issue.fact.replace(/\s+/gu, " ").trim()}`;
    const previous = seen.get(key);
    if (!previous) {
      seen.set(key, issue);
      return true;
    }
    if (issue.segments?.length) previous.segments = [...new Set([...(previous.segments ?? []), ...issue.segments])];
    return false;
  });
  const stats = { calls: 0, queries: 0, excludedPrecedents: 0, excludedLaws: 0 };
  const diagnostics: ReviewDiagnostics = { lookups: { law: 0, article: 0, search: 0, holding: 0 }, failures: {}, evidence: { issues: 0, completed: 0 } };

  // One promise per distinct lookup: the same statute, search or judgment is never requested twice.
  const memo = new Map<string, Promise<unknown>>();
  let active = 0;
  const waiting: Array<() => void> = [];
  const lookup = <T,>(key: string, run: () => Promise<T>): Promise<T> => {
    const existing = memo.get(key);
    if (existing) return existing as Promise<T>;
    const promise = (async () => {
      while (active >= CONCURRENCY) {
        signal?.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const resume = () => { signal?.removeEventListener("abort", abort); resolve(); };
          const abort = () => {
            const index = waiting.indexOf(resume);
            if (index >= 0) waiting.splice(index, 1);
            reject(signal?.reason ?? new DOMException("Review cancelled", "AbortError"));
          };
          waiting.push(resume);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
      signal?.throwIfAborted();
      if (now() - started > BUDGET_MS) throw new Error(LOOKUP_BUDGET);
      active += 1;
      stats.calls += 1;
      diagnostics.lookups[key.slice(0, key.indexOf(":")) as keyof ReviewDiagnostics["lookups"]] += 1;
      try {
        const result = await run();
        signal?.throwIfAborted();
        return result;
      } finally {
        active -= 1;
        waiting.shift()?.();
      }
    })();
    memo.set(key, promise);
    // Each distinct lookup that did not complete is counted once, by reason; cancellation is not a failure.
    promise.catch((error: unknown) => {
      if (signal?.aborted) return;
      const reason = failureReason(error);
      diagnostics.failures[reason] = (diagnostics.failures[reason] ?? 0) + 1;
    });
    return promise;
  };

  const laws: Record<string, LawReference> = {};
  const precedents: Record<string, PrecedentReference> = {};

  async function resolveLaws(issue: IssueDefinition): Promise<Resolution> {
    const targets = lawTargets(issue, profile);
    stats.excludedLaws += issue.laws.length - targets.length;
    if (!targets.length) return { keys: [], status: "not_searched" };
    let failure: FailureReason | undefined;
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
      } catch (error) {
        signal?.throwIfAborted();
        failure ??= failureReason(error);
      }
    }
    return { keys, status: keys.length ? failure ? "partial" : "found" : failure ? "failed" : "none", ...(failure ? { failure } : {}) };
  }

  async function resolvePrecedents(issue: IssueDefinition): Promise<Resolution> {
    // An issue can have an in-domain precedent question without an applicable
    // statute (e.g. renewal in an NDA). Never search a wholly excluded area.
    const domains = issue.precedentDomains ?? issue.laws.map((law) => law.domain);
    if (!domains.some((domain) => profile.domains.includes(domain))) return { keys: [], status: "not_searched" };
    const queries = precedentQueries(issue, profile);
    if (!queries.length || !issue.holdingTerms) return { keys: [], status: "not_searched" };
    let failure: FailureReason | undefined;
    let read = 0;
    // Staged search: the most specific query first, widened only while nothing relevant is found.
    for (const query of queries) {
      let entries: DecisionEntry[];
      try {
        stats.queries += 1;
        entries = await lookup(`search:${query}`, () => sources.searchPrecedents(query));
      } catch (error) {
        signal?.throwIfAborted();
        failure ??= failureReason(error);
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
        } catch (error) {
          signal?.throwIfAborted();
          failure ??= failureReason(error);
          continue;
        }
        const sentence = holding ? holdingRelevance(holding, issue, profile) : undefined;
        const baseKey = `precedent:${entry.id}`;
        const existing = precedents[baseKey];
        // One judgment may contain separate relevant holdings for separate issues.
        // Keep each issue's excerpt tied to the case actually read, rather than
        // letting the first issue's excerpt silently stand in for another.
        const key = existing && existing.holding !== sentence ? `${baseKey}:${issue.id}` : baseKey;
        // Companion cases often repeat one holding word for word; show it once
        // within this issue without hiding a relevant citation from another.
        const repeated = sentence !== undefined && keys.some((other) => precedents[other]?.holding === sentence);
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
      if (keys.length) return { keys, status: failure ? "partial" : "found", ...(failure ? { failure } : {}) };
    }
    return { keys: [], status: failure ? "failed" : "none", ...(failure ? { failure } : {}) };
  }

  // Resolve each issue against its own search terms and holding gate. Sharing a
  // group result could attach a price-change case to a service-suspension clause,
  // or skip the latter's query entirely. The lookup memo still reuses identical
  // statute, query and holding requests across issues and clauses.
  // Resolve all high-priority stages before lower-priority searches consume
  // the fixed time budget; identical lookups remain memoized and concurrency-bound.
  const resolved = new Map<string, Promise<[Resolution, Resolution]>>();
  const issueIds = [...new Set(clauses.flatMap((clause) => clause.issues.map((issue) => issue.id)))];
  for (const severity of ["high", "medium", "low"] as const) {
    const tier = issueIds.filter((id) => issueDefinition(id)!.severity === severity);
    for (const id of tier) {
      const issue = issueDefinition(id)!;
      resolved.set(id, Promise.all([resolveLaws(issue), resolvePrecedents(issue)]));
    }
    await Promise.all(tier.map((id) => resolved.get(id)!));
    signal?.throwIfAborted();
  }

  const reviewedClauses: ContractReview["clauses"] = [];
  for (const { sources: origin, ...clause } of clauses) {
    const issues: ReviewedIssue[] = [];
    for (const issue of clause.issues) {
      const [law, precedent] = await resolved.get(issue.id)!;
      issues.push({ ...issue, laws: law.keys, precedents: precedent.keys, lawStatus: law.status, precedentStatus: precedent.status,
        ...(law.failure ? { lawFailure: law.failure } : {}), ...(precedent.failure ? { precedentFailure: precedent.failure } : {}) });
    }
    reviewedClauses.push({ ...clause, ...(origin ? { segments: segmentsOf({ ...clause, sources: origin }) } : {}), issues });
  }
  signal?.throwIfAborted();
  for (const id of issueIds) {
    const [law, precedent] = await resolved.get(id)!;
    diagnostics.evidence.issues += 1;
    if (!law.failure && !precedent.failure) diagnostics.evidence.completed += 1;
  }

  return {
    document: profile,
    risk: documentRisk(clauses),
    facts: extractKeyFacts(clauses),
    clauses: reviewedClauses.filter((clause) => clause.issues.length),
    laws,
    precedents,
    stats,
    diagnostics,
  };
}
