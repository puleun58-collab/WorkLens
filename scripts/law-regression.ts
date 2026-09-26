/**
 * Live 법제처 regression: 15 fixed cases through the deployed WorkLens API
 * (`bun run test:law-regression`). Each case checks, in order: the request
 * succeeded → the right law/task was resolved → the content is intact and the
 * status is right. Only stable facts are asserted (law name, 법령ID, article
 * numbers, structure marks, statuses), never full text or result counts.
 *
 * Results print per case and are written to artifacts/law-regression.json
 * (git-ignored). Upstream outages are reported apart from WorkLens failures;
 * only WorkLens failures make the run exit non-zero.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { lawDisplayText } from "../src/lib/law-display";
import type { LawResearchData } from "../src/lib/law-research";
import { researchResult } from "../src/lib/law-research-parse";
import { CASES, type RegressionCase } from "./law-regression.cases";

const BASE = (process.env.WORKLENS_SMOKE_URL ?? "https://worklens.puleun58.workers.dev").replace(/\/+$/u, "");
const INTERNAL = /\b(?:search|get|find|compare|chain|legal|discover|execute)_[a-z0-9_]*(?:law|precedent|decision|appeal|interpretation|article|ordinance|annex|document|analysis|research|tribunal|treaty|ruling|tool|term)[a-z0-9_]*|\b(?:mst|lawId|jo|full|efYd|body_search)=|MST:?\s*\d|\/DRF\/|LLM|apikey|OC=|\[NOT_FOUND\]/u;
const UPSTREAM_CODES = new Set(["LAW_AUTH_FAILED", "LAW_RATE_LIMITED", "LAW_UPSTREAM_TIMEOUT", "LAW_UPSTREAM_UNAVAILABLE", "LAW_UPSTREAM_NO_DATA", "OPERATION_CAPACITY"]);
/** Sequential with a pause: parallel chains trip the upstream's concurrency limit. */
const PAUSE_MS = 400;

type Stage = "request" | "identify" | "content" | "status";
type Reason = "network" | "timeout" | "upstream" | "no_result" | "wrong_law" | "malformed" | "article_missing" | "parsing" | "status_mismatch" | "internal_leak";
type Outcome = { id: string; category: string; query: string; result: "PASS" | "FAIL" | "UPSTREAM"; ms: number; resolved?: string; stage?: Stage; reason?: Reason; expected?: string; actual?: string };

class CaseFailure extends Error {
  constructor(readonly stage: Stage, readonly reason: Reason, readonly expected: string, readonly actual: string) { super(`${stage}:${reason}`); }
}
class Upstream extends Error {}

async function post<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: "POST", headers: { "content-type": "application/json", origin: BASE, "sec-fetch-site": "same-origin" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    throw new CaseFailure("request", (error as Error).name === "TimeoutError" ? "timeout" : "network", "response", (error as Error).name);
  }
  const json = await response.json().catch(() => undefined) as { data?: T; error?: { code?: string } } | undefined;
  if (!response.ok) {
    const code = json?.error?.code ?? `HTTP ${response.status}`;
    if (UPSTREAM_CODES.has(code)) throw new Upstream(code);
    throw new CaseFailure("request", "malformed", "2xx", code);
  }
  if (!json?.data) throw new CaseFailure("request", "malformed", "{ data }", "no data");
  return json.data;
}

type LawSearch = { found: true; laws: Array<{ name: string; status?: string; mst?: string; lawId?: string }> } | { found: false };
type LawText = { found: true; mode: string; text: string; name?: string } | { found: false };

async function runLaw(testCase: Extract<RegressionCase, { kind: "law" }>): Promise<string> {
  const search = await post<LawSearch>("/api/law", { query: testCase.query });
  if (!search.found) throw new CaseFailure("identify", "no_result", testCase.expect.name, "NOT_FOUND");
  // The UI and enrichment pick the exact current name, never merely the first hit.
  const law = search.laws.find((entry) => entry.name === testCase.expect.name && (!entry.status || entry.status === "현행"));
  if (!law) throw new CaseFailure("identify", "wrong_law", testCase.expect.name, search.laws.slice(0, 3).map((entry) => entry.name).join(", "));
  if (law.lawId !== testCase.expect.lawId) throw new CaseFailure("identify", "wrong_law", `법령ID ${testCase.expect.lawId}`, `법령ID ${law.lawId}`);
  for (const other of testCase.expect.alsoListed ?? []) {
    if (!search.laws.some((entry) => entry.name === other)) throw new CaseFailure("identify", "no_result", `also ${other}`, "missing");
  }
  if (!law.mst) throw new CaseFailure("identify", "malformed", "MST", "missing");
  const resolved = `${law.name} (법령ID ${law.lawId})`;
  if (!testCase.expect.article) return resolved;
  await pause();
  const text = await post<LawText>("/api/law/text", { mst: law.mst, jo: testCase.expect.article.jo });
  if (!text.found) throw new CaseFailure("content", "article_missing", testCase.expect.article.jo, "NOT_FOUND");
  // Upstream prints `제23조(해고 등의 제한)` or `제750조 불법행위의 내용`; the title must follow either way.
  const heading = new RegExp(`^\\s*${testCase.expect.article.jo}\\s*[( ]\\s*${testCase.expect.article.title ?? ""}`, "mu");
  if (!heading.test(text.text)) throw new CaseFailure("content", "article_missing", `${testCase.expect.article.jo}(${testCase.expect.article.title ?? "…"})`, text.text.slice(0, 80).replace(/\s+/gu, " "));
  for (const mark of testCase.expect.article.structure ?? []) {
    if (!new RegExp(mark, "mu").test(text.text)) throw new CaseFailure("content", "parsing", `structure ${mark}`, "absent");
  }
  return `${resolved} ${testCase.expect.article.jo}`;
}

async function runResearch(testCase: Extract<RegressionCase, { kind: "research" }>): Promise<string> {
  const data = await post<LawResearchData | { found: false }>("/api/law/research", testCase.body);
  if (!data.found) throw new CaseFailure("identify", "no_result", "found", "NOT_FOUND");
  if (data.task !== testCase.body.task) throw new CaseFailure("identify", "wrong_law", String(testCase.body.task), data.task);
  let document;
  try { document = researchResult(data.text); } catch (error) { throw new CaseFailure("content", "parsing", "parse", (error as Error).message); }
  if (!document.sections.length) throw new CaseFailure("content", "parsing", "sections", "0");
  const shown = document.sections
    .filter((section) => section.status === "available")
    .map((section) => `${section.heading ?? ""}\n${lawDisplayText(section.lines.join("\n"))}`).join("\n");
  const leak = INTERNAL.exec(shown);
  if (leak) throw new CaseFailure("content", "internal_leak", "no internal text", leak[0]);
  // An empty search must never count as partial; a partial must come only from failed/timeout sections.
  const miscounted = document.sections.filter((section) => section.status === "not_found" && section.unavailable).length;
  if (miscounted) throw new CaseFailure("status", "status_mismatch", "not_found ≠ partial", `${miscounted} counted`);
  for (const kind of testCase.expect.kinds ?? []) {
    if (!document.sections.some((section) => section.kind === kind)) throw new CaseFailure("content", "parsing", `section ${kind}`, "absent");
  }
  if (testCase.expect.supplementArticle) {
    const articles = data.enrichment?.supplement?.articles ?? [];
    const hit = articles.find((article) => article.law === testCase.expect.supplementArticle!.law && article.jo === testCase.expect.supplementArticle!.jo);
    if (!hit) throw new CaseFailure("content", "article_missing", `${testCase.expect.supplementArticle.law} ${testCase.expect.supplementArticle.jo}`, articles.map((article) => `${article.law} ${article.jo}`).join(", ") || "none");
    if (!hit.excerpt.trim() || hit.excerpt.startsWith(hit.title)) throw new CaseFailure("content", "parsing", "article body", hit.excerpt.slice(0, 40));
    const shownArticles = document.sections.flatMap((section) => section.articles ?? []);
    if (shownArticles.some((article) => article.law === hit.law && article.jo === hit.jo)) throw new CaseFailure("content", "parsing", "no duplicate", `${hit.law} ${hit.jo} twice`);
  }
  if (testCase.expect.precedentsRanked) {
    const ranks = data.enrichment?.precedents;
    if (!ranks || !Object.keys(ranks).length) throw new CaseFailure("status", "status_mismatch", "precedents ranked", "none");
  }
  const statuses = document.sections.filter((section) => section.status !== "available").map((section) => section.status);
  return `${data.task}${statuses.length ? ` [${statuses.join(",")}]` : ""}`;
}

async function runDecisions(testCase: Extract<RegressionCase, { kind: "decisions" }>): Promise<string> {
  const data = await post<{ found: true; entries: Array<{ id: string; title?: string; caseNumber?: string }> } | { found: false }>(
    "/api/law/decisions/search", { domain: testCase.domain, query: testCase.query, page: 1 });
  if (!data.found || !data.entries.length) throw new CaseFailure("identify", "no_result", "entries", "0");
  const broken = data.entries.find((entry) => !entry.id || !(entry.title || entry.caseNumber));
  if (broken) throw new CaseFailure("content", "parsing", "id + title/caseNumber", JSON.stringify(broken).slice(0, 60));
  return `${data.entries.length} entries`;
}

async function runEmpty(testCase: Extract<RegressionCase, { kind: "empty" }>): Promise<string> {
  const data = await post<LawSearch>("/api/law", { query: testCase.query });
  if (data.found) throw new CaseFailure("status", "status_mismatch", "NOT_FOUND (normal empty)", `${data.laws.length} laws`);
  return "NOT_FOUND (expected empty)";
}

function pause(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, PAUSE_MS);
  return promise;
}

async function run(testCase: RegressionCase): Promise<Outcome> {
  const started = Date.now();
  const base = { id: testCase.id, category: testCase.category, query: "query" in testCase ? testCase.query : String(testCase.body.query) };
  try {
    const resolved = testCase.kind === "law" ? await runLaw(testCase)
      : testCase.kind === "research" ? await runResearch(testCase)
        : testCase.kind === "decisions" ? await runDecisions(testCase)
          : await runEmpty(testCase);
    return { ...base, result: "PASS", ms: Date.now() - started, resolved };
  } catch (error) {
    if (error instanceof Upstream) return { ...base, result: "UPSTREAM", ms: Date.now() - started, reason: "upstream", actual: error.message };
    if (error instanceof CaseFailure) return { ...base, result: "FAIL", ms: Date.now() - started, stage: error.stage, reason: error.reason, expected: error.expected, actual: error.actual };
    return { ...base, result: "FAIL", ms: Date.now() - started, stage: "request", reason: "malformed", actual: (error as Error).message };
  }
}

const started = Date.now();
const outcomes: Outcome[] = [];
for (const testCase of CASES) {
  const outcome = await run(testCase);
  outcomes.push(outcome);
  const line = `${outcome.result.padEnd(8)} ${outcome.id}  [${outcome.category}] ${outcome.query}  ${outcome.ms}ms`;
  console.log(outcome.result === "PASS" ? `${line}  → ${outcome.resolved}` : `${line}\n         ${outcome.stage ?? ""}/${outcome.reason}: expected ${outcome.expected ?? "-"}, got ${outcome.actual ?? "-"}`);
  await pause();
}
const passed = outcomes.filter((outcome) => outcome.result === "PASS").length;
const failed = outcomes.filter((outcome) => outcome.result === "FAIL").length;
const upstream = outcomes.length - passed - failed;
console.log(`\nTotal: ${outcomes.length}  Passed: ${passed}  Failed: ${failed}  Upstream: ${upstream}  (${Math.round((Date.now() - started) / 1000)}s)`);
await mkdir("artifacts", { recursive: true });
await writeFile("artifacts/law-regression.json", JSON.stringify({ at: new Date().toISOString(), base: BASE, total: outcomes.length, passed, failed, upstream, outcomes }, null, 2));
process.exit(failed ? 1 : 0);
