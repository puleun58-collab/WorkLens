/**
 * Live 법제처 smoke for the deployed research API — run by hand
 * (`bun run test:law-live`) or from the manual "Law live smoke" workflow,
 * never on push/PR: results depend on the Korean Law MCP and 법제처 data.
 *
 * It calls the deployed WorkLens route, so no MCP URL or key is needed here;
 * those stay in the Cloudflare deployment. Only stable properties are checked
 * (success, parseable structure, nothing internal on screen, partial counts,
 * relevance ordering), never case titles or ranks, which change with the data.
 */
import { lawDisplayText } from "../src/lib/law-display";
import type { LawResearchData } from "../src/lib/law-research";
import { researchResult } from "../src/lib/law-research-parse";
import { orderByRelevance } from "../src/lib/research-relevance";

const BASE = (process.env.WORKLENS_SMOKE_URL ?? "https://worklens.puleun58.workers.dev").replace(/\/+$/u, "");
const INTERNAL = /\b(?:search|get|find|compare|chain|legal|discover|execute)_[a-z0-9_]*(?:law|precedent|decision|appeal|interpretation|article|ordinance|annex|document|analysis|research|tribunal|treaty|ruling|tool|term)[a-z0-9_]*|\b(?:mst|lawId|jo|full|efYd|body_search)=|MST:?\s*\d|\/DRF\/|LLM|apikey|OC=/u;

/** Upstream outcomes are reported as such, not as WorkLens failures. */
const UPSTREAM: Record<string, string> = {
  LAW_AUTH_FAILED: "upstream authentication", LAW_RATE_LIMITED: "upstream rate limit", LAW_UPSTREAM_TIMEOUT: "upstream timeout",
  LAW_UPSTREAM_UNAVAILABLE: "upstream unavailable", LAW_UPSTREAM_NO_DATA: "upstream no data", OPERATION_CAPACITY: "WorkLens capacity (retry)",
};

const CASES: Array<{ name: string; body: Record<string, unknown>; relevance?: boolean }> = [
  { name: "full_research", body: { task: "full_research", query: "직장 내 괴롭힘 판단 기준" }, relevance: true },
  { name: "law_system", body: { task: "law_system", query: "개인정보 보호법" } },
  { name: "amendment_track", body: { task: "amendment_track", query: "근로기준법", scenario: "time_travel", fromDate: "2022-01-01", toDate: "2026-01-01" } },
  { name: "ordinance_compare", body: { task: "ordinance_compare", query: "주차장 설치 및 관리 조례", parentLaw: "주차장법" } },
  { name: "procedure_detail", body: { task: "procedure_detail", query: "행정심판 청구 절차와 제출서류" } },
];

type Outcome = { name: string; kind: "pass" | "regression" | "upstream" | "no_result"; detail: string; ms: number };

function inspect(data: LawResearchData, relevance: boolean): string[] {
  const problems: string[] = [];
  const document = researchResult(data.text);
  if (!document.sections.length) problems.push("no sections parsed");
  const shown = document.sections.map((section) => `${section.heading ?? ""}\n${lawDisplayText(section.lines.join("\n"))}`).join("\n");
  const leak = INTERNAL.exec(shown);
  if (leak) problems.push(`internal text on screen: ${leak[0]}`);
  const unavailable = document.sections.filter((section) => section.unavailable).length;
  const failedMarkers = document.sections.filter((section) => /\[(?:NOT_FOUND \/ FAILED|FAILED)\]/u.test(section.heading ?? "")).length;
  if (unavailable < failedMarkers) problems.push(`partial count ${unavailable} below failed sections ${failedMarkers}`);
  if (relevance) {
    const precedents = document.sections.filter((section) => section.kind === "decision_search" && /판례/u.test(section.heading ?? ""));
    const ranks = data.enrichment?.precedents;
    if (precedents.length && !ranks) problems.push("precedents listed but not ranked");
    for (const section of precedents) {
      const ordered = orderByRelevance(section.decisions!.entries, ranks).map((entry) => ranks?.[entry.id]?.rank ?? "unknown");
      // Low-relevance cases must never sit above an unknown or relevant one in the preview.
      const firstLow = ordered.indexOf("low");
      if (firstLow >= 0 && ordered.slice(firstLow).some((rank) => rank !== "low")) problems.push(`relevance order broken: ${ordered.join(",")}`);
    }
  }
  return problems;
}

async function run(testCase: (typeof CASES)[number]): Promise<Outcome> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  let response: Response;
  try {
    response = await fetch(`${BASE}/api/law/research`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "sec-fetch-site": "same-origin" },
      body: JSON.stringify(testCase.body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    return { name: testCase.name, kind: "upstream", detail: `network: ${(error as Error).name}`, ms: elapsed() };
  }
  const body = await response.json().catch(() => undefined) as { data?: LawResearchData | { found: false }; error?: { code?: string } } | undefined;
  if (!response.ok) {
    const code = body?.error?.code ?? `HTTP ${response.status}`;
    return { name: testCase.name, kind: UPSTREAM[code] ? "upstream" : "regression", detail: UPSTREAM[code] ?? code, ms: elapsed() };
  }
  if (!body?.data) return { name: testCase.name, kind: "regression", detail: "malformed response body", ms: elapsed() };
  if (!body.data.found) return { name: testCase.name, kind: "no_result", detail: "NOT_FOUND from upstream", ms: elapsed() };
  try {
    const problems = inspect(body.data as LawResearchData, Boolean(testCase.relevance));
    return { name: testCase.name, kind: problems.length ? "regression" : "pass", detail: problems.join("; ") || "ok", ms: elapsed() };
  } catch (error) {
    return { name: testCase.name, kind: "regression", detail: `parser crash: ${(error as Error).message}`, ms: elapsed() };
  }
}

const outcomes: Outcome[] = [];
// Sequential: parallel chains trip the upstream's concurrency limit.
for (const testCase of CASES) outcomes.push(await run(testCase));
for (const outcome of outcomes) console.log(`${outcome.kind.padEnd(10)} ${outcome.name.padEnd(18)} ${String(outcome.ms).padStart(6)}ms  ${outcome.detail}`);
const regressions = outcomes.filter((outcome) => outcome.kind === "regression").length;
const upstream = outcomes.filter((outcome) => outcome.kind !== "pass" && outcome.kind !== "regression").length;
console.log(`\n${outcomes.length - regressions - upstream} passed, ${regressions} WorkLens regressions, ${upstream} upstream/no-result`);
// Upstream trouble is reported but does not fail the run; a WorkLens regression does.
process.exit(regressions ? 1 : 0);
