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
import type { IssueEvidence, LawResearchData } from "../src/lib/law-research";
import { researchResult } from "../src/lib/law-research-parse";
import { orderByRelevance } from "../src/lib/research-relevance";

const BASE = (process.env.WORKLENS_SMOKE_URL ?? "https://worklens.puleun58.workers.dev").replace(/\/+$/u, "");
const INTERNAL = /\b(?:search|get|find|compare|chain|legal|discover|execute)_[a-z0-9_]*(?:law|precedent|decision|appeal|interpretation|article|ordinance|annex|document|analysis|research|tribunal|treaty|ruling|tool|term)[a-z0-9_]*|\b(?:mst|lawId|jo|full|efYd|body_search)=|MST:?\s*\d|\/DRF\/|LLM|apikey|OC=/u;

/** Upstream outcomes are reported as such, not as WorkLens failures. */
const UPSTREAM: Record<string, string> = {
  LAW_AUTH_FAILED: "upstream authentication", LAW_RATE_LIMITED: "upstream rate limit", LAW_UPSTREAM_TIMEOUT: "upstream timeout",
  LAW_UPSTREAM_UNAVAILABLE: "upstream unavailable", LAW_UPSTREAM_NO_DATA: "upstream no data", OPERATION_CAPACITY: "WorkLens capacity (retry)",
};

/** The long and the contradictory question exercise issue splitting: several distinct issues, short searches, no added facts. */
const LONG_QUESTION = "5년 근무했는데 어제 팀장이 문자로 내일부터 나오지 말라고 했습니다. 두 달치 월급도 못 받았고 퇴직금도 받지 못했습니다. 해고가 적법한지, 밀린 임금과 퇴직금은 어떻게 해야 하는지 알고 싶습니다.";
const CONTRADICTORY = "해고 통보를 받은 건 아닌데 회사에서 내일부터 나오지 말라고 했습니다. 어떻게 해야 하나요?";

const CASES: Array<{ name: string; body: Record<string, unknown>; relevance?: boolean; issues?: "split" | "no-added-facts" }> = [
  { name: "full_research", body: { task: "full_research", query: "직장 내 괴롭힘 판단 기준" }, relevance: true },
  { name: "full_research:long", body: { task: "full_research", query: LONG_QUESTION }, issues: "split" },
  { name: "full_research:contra", body: { task: "full_research", query: CONTRADICTORY }, issues: "no-added-facts" },
  { name: "law_system", body: { task: "law_system", query: "개인정보 보호법" } },
  { name: "amendment_track", body: { task: "amendment_track", query: "근로기준법", scenario: "time_travel", fromDate: "2022-01-01", toDate: "2026-01-01" } },
  { name: "ordinance_compare", body: { task: "ordinance_compare", query: "주차장 설치 및 관리 조례", regions: ["인천광역시", "서울특별시"], parentLaw: "주차장법" } },
  { name: "procedure_detail", body: { task: "procedure_detail", query: "행정심판 청구 절차와 제출서류" } },
  { name: "action_basis", body: { task: "action_basis", query: "건축법상 이행강제금의 근거와 요건" } },
  { name: "dispute_prep", body: { task: "dispute_prep", query: "부당해고 구제 신청 관련 판례와 결정례", domain: "labor" } },
  { name: "document_review", body: { task: "document_review", text: "제1조(목적) 이 계약은 갑과 을 사이의 용역 수행에 관한 사항을 정한다.\n제2조(해지) 을은 어떠한 경우에도 계약을 해지할 수 없다.\n제3조(손해배상) 을은 갑에게 발생한 모든 손해를 제한 없이 배상한다." } },
];

type Outcome = { name: string; kind: "pass" | "regression" | "upstream" | "no_result"; detail: string; ms: number };

const ISSUE_STATUSES: ReadonlyArray<IssueEvidence["status"]> = ["found", "none", "failed", "timeout"];

/** 문서 검토 answers with a structured review instead of text: check its shape and its citations. */
function inspectReview(data: LawResearchData): string[] {
  const review = data.review!;
  const problems: string[] = [];
  if (!Array.isArray(review.clauses) || review.clauses.length === 0) problems.push("review has no clauses");
  const shown = JSON.stringify({ clauses: review.clauses, laws: review.laws, precedents: review.precedents, facts: review.facts });
  const leak = INTERNAL.exec(shown);
  if (leak) problems.push(`internal text in review: ${leak[0]}`);
  for (const clause of review.clauses ?? []) for (const issue of clause.issues) {
    // A cited source must exist; a failed lookup must not come with citations it could not have made.
    for (const key of issue.laws) if (!review.laws[key]) problems.push(`issue ${issue.id} cites missing law ${key}`);
    for (const key of issue.precedents) if (!review.precedents[key]) problems.push(`issue ${issue.id} cites missing precedent ${key}`);
    if (issue.lawStatus === "failed" && issue.laws.length) problems.push(`issue ${issue.id} cites laws after a failed lookup`);
  }
  return problems;
}

/** 종합 리서치: issue statuses are valid and agree with the overall status. */
function inspectIssues(data: LawResearchData, query: string, mode: "split" | "no-added-facts" | undefined): string[] {
  const problems: string[] = [];
  const issues = data.evidence?.issues ?? [];
  for (const issue of issues) if (!ISSUE_STATUSES.includes(issue.status)) problems.push(`unknown issue status ${issue.status}`);
  const found = issues.filter((issue) => issue.status === "found").length;
  if (data.evidence?.status === "matched" && issues.length && found === 0) problems.push("matched without any issue found");
  if (data.evidence?.status === "unverified" && found > 0 && (data.evidence.articles?.length || data.evidence.precedents?.length)) problems.push("unverified while an issue has sources");
  const interpretation = data.interpretation;
  if (mode === "split") {
    if (!interpretation) problems.push("long question was not interpreted");
    else {
      const labels = interpretation.issues.map((issue) => issue.label.replace(/\s+/gu, ""));
      if (interpretation.issues.length < 2) problems.push(`long question split into ${interpretation.issues.length} issue(s)`);
      if (new Set(labels).size !== labels.length) problems.push("duplicate issues");
      if (interpretation.issues.some((issue) => issue.query.length > Math.min(40, query.length / 2))) problems.push("an issue searches with a long sentence");
    }
  }
  if (mode === "no-added-facts" && interpretation?.facts.some((fact) => /해고(?:를|가)?\s?(?:당했|되었|됐|확정|통보를\s?받았)/u.test(fact) && !/아니|않/u.test(fact))) {
    problems.push("interpretation states a dismissal the user denied");
  }
  return problems;
}

function inspect(data: LawResearchData, relevance: boolean): string[] {
  if (data.review) return inspectReview(data);
  const problems: string[] = [];
  const document = researchResult(data.text);
  if (!document.sections.length) problems.push("no sections parsed");
  const shown = document.sections.map((section) => `${section.heading ?? ""}\n${lawDisplayText(section.lines.join("\n"))}`).join("\n");
  const leak = INTERNAL.exec(shown);
  if (leak) problems.push(`internal text on screen: ${leak[0]}`);
  // An empty search is a normal result and must never make the answer partial.
  const miscounted = document.sections.filter((section) => section.status === "not_found" && section.unavailable).length;
  if (miscounted) problems.push(`${miscounted} empty section(s) counted as partial`);
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
    const data = body.data as LawResearchData;
    // The AI reading needs the provider quota; when it was unavailable the splitting checks cannot run.
    if (testCase.issues && !data.interpretation && data.interpretationFailure) {
      return { name: testCase.name, kind: "upstream", detail: `AI interpretation ${data.interpretationFailure}`, ms: elapsed() };
    }
    const problems = [...inspect(data, Boolean(testCase.relevance)), ...(data.task === "full_research" ? inspectIssues(data, String(testCase.body.query), testCase.issues) : [])];
    return { name: testCase.name, kind: problems.length ? "regression" : "pass", detail: problems.join("; ") || "ok", ms: elapsed() };
  } catch (error) {
    return { name: testCase.name, kind: "regression", detail: `parser crash: ${(error as Error).message}`, ms: elapsed() };
  }
}

const outcomes: Outcome[] = [];
// Sequential: parallel chains trip the upstream's concurrency limit.
for (const testCase of CASES) outcomes.push(await run(testCase));
for (const outcome of outcomes) console.log(`${outcome.kind.padEnd(10)} ${outcome.name.padEnd(22)} ${String(outcome.ms).padStart(6)}ms  ${outcome.detail}`);
const regressions = outcomes.filter((outcome) => outcome.kind === "regression").length;
const upstream = outcomes.filter((outcome) => outcome.kind !== "pass" && outcome.kind !== "regression").length;
console.log(`\n${outcomes.length - regressions - upstream} passed, ${regressions} WorkLens regressions, ${upstream} upstream/no-result`);
// Upstream trouble is reported but does not fail the run; a WorkLens regression does.
process.exit(regressions ? 1 : 0);
