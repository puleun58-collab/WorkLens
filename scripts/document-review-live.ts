import type { ContractReview } from "../src/lib/contract-review";
import { holdingRelevance, issueDefinition, offDomain } from "../src/lib/contract-review";
import { reviewFileFor } from "../src/lib/law-review-source";
import { DEVELOPMENT_CASES } from "../tests/eval/document-review-cases";
import { HOLDOUT_CASES } from "../tests/eval/document-review-holdout";
import { evaluateCase, scoreCase, summarize } from "../tests/eval/document-review-harness";

/** Calls the real server document_review pipeline. No deterministic sources or fixture judgments are sent. */
const args = process.argv.slice(2);
const endpointIndex = args.indexOf("--endpoint");
const endpoint = endpointIndex >= 0 ? args[endpointIndex + 1] : undefined;
const holdout = args.includes("--holdout");
const caseIndex = args.indexOf("--case");
const chosen = caseIndex >= 0 ? args[caseIndex + 1] : undefined;
if (!endpoint || !/^https?:\/\//u.test(endpoint) || args.some((arg, index) => !["--endpoint", "--holdout", "--case"].includes(arg) && index !== endpointIndex + 1 && index !== caseIndex + 1)) {
  throw new Error("Usage: bun run eval:document-review:live --endpoint https://configured-worklens [--holdout] [--case case-id]. A configured live server is required.");
}
const cases = (holdout ? HOLDOUT_CASES : DEVELOPMENT_CASES).filter((test) => !chosen || test.id === chosen);
if (!cases.length) throw new Error(`No case ${chosen} in ${holdout ? "holdout" : "development"} set.`);
const rows = [];
for (const test of cases) {
  const file = reviewFileFor(test.document, `${test.id}.${test.kind}`);
  if (file.coverage.status === "excluded") {
    // The product does not send excluded files to the server: score this coverage-only case locally.
    const row = await evaluateCase(test);
    rows.push(row);
    console.log(`${test.id}: excluded from live review, coverage errors ${row.coverageErrors}`);
    continue;
  }
  const base = endpoint.replace(/\/+$/u, "");
  let response: Response;
  try {
    response = await fetch(`${base}/api/law/research`, {
      method: "POST", headers: { "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ task: "document_review", document: file.document }), signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    console.error(`${test.id}: live request failed: ${String(error)}`);
    process.exitCode = 2;
    continue;
  }
  const payload = await response.json().catch(() => undefined) as { data?: { found?: boolean; review?: ContractReview }; error?: { code?: string } } | undefined;
  if (!response.ok || !payload?.data?.found || !payload.data.review) {
    console.error(`${test.id}: live source unavailable (${response.status}, ${payload?.error?.code ?? "invalid response"}); not scored as a pass`);
    process.exitCode = 2;
    continue;
  }
  const review = payload.data.review;
  // Synthetic fixture citations are not expected of live MCP; score statute domain/article
  // against issue targets and precedents against the returned holding below.
  const row = scoreCase(test, file, review, 0, true);
  for (const clause of review.clauses) for (const issue of clause.issues) for (const key of issue.precedents) {
    const precedent = review.precedents[key];
    const definition = issueDefinition(issue.id);
    if (!precedent || !definition || offDomain(`${precedent.title ?? ""} ${precedent.holding}`, review.document)
      || !holdingRelevance(precedent.holding, definition, review.document)) row.wrongPrecedentLinks++;
  }
  const failedSource = review.clauses.some((clause) => clause.issues.some((issue) =>
    issue.lawStatus === "failed" || issue.lawStatus === "partial" || issue.precedentStatus === "failed" || issue.precedentStatus === "partial"));
  if (failedSource) { row.sourceFailures++; process.exitCode = 2; }
  rows.push(row);
  console.log(`${test.id}: TP ${row.tp} FP ${row.fp} FN ${row.fn} wrong laws ${row.wrongLawLinks} wrong precedents ${row.wrongPrecedentLinks} source failures ${row.sourceFailures}`);
}
if (rows.length !== cases.length) { console.error("Some live cases did not complete. No overall quality pass can be claimed."); process.exitCode = 2; }
console.log(JSON.stringify({ mode: "live-mcp-via-worklens", baselineVersion: "document-review-v1", set: holdout ? "holdout" : "development", completed: rows.length, requested: cases.length, summary: summarize(rows), rows }, null, 2));
if (rows.length === cases.length && process.exitCode !== 2 && rows.some((row) => row.fp || row.fn || row.wrongLawLinks || row.wrongPrecedentLinks || row.unsupportedClaims || row.coverageErrors)) process.exitCode = 1;
