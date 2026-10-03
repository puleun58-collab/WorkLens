import type { ContractReview, FailureReason } from "../src/lib/contract-review";
import { holdingRelevance, issueDefinition, offDomain } from "../src/lib/contract-review";
import { reviewFileFor, reviewRequestFor } from "../src/lib/law-review-source";
import { DEVELOPMENT_CASES } from "../tests/eval/document-review-cases";
import { HOLDOUT_CASES } from "../tests/eval/document-review-holdout";
import { evalRun, evaluateCase, hasQualityFailure, qualityFailures, scoreCase, summarize, type CaseScore, type EvalSummary } from "../tests/eval/document-review-harness";

/** Infrastructure and incomplete runs take precedence over quality failures. */
export function liveGate(summary: EvalSummary, requested: number, completed: number, systemFailures = 0): 0 | 1 | 2 {
  if (completed !== requested || systemFailures > 0 || summary.sourceFailures > 0) return 2;
  return hasQualityFailure(summary) ? 1 : 0;
}

/** Calls the real server document_review pipeline. No deterministic sources or fixture judgments are sent. */
async function main(): Promise<0 | 1 | 2> {
  const args = process.argv.slice(2);
  const endpointIndex = args.indexOf("--endpoint");
  const endpoint = endpointIndex >= 0 ? args[endpointIndex + 1] : undefined;
  const holdout = args.includes("--holdout");
  const caseIndex = args.indexOf("--case");
  const chosen = caseIndex >= 0 ? args[caseIndex + 1] : undefined;
  if (!endpoint || !/^https?:\/\//u.test(endpoint) || args.some((arg, index) => !["--endpoint", "--holdout", "--case"].includes(arg) && index !== endpointIndex + 1 && index !== caseIndex + 1)) {
    console.error("Usage: bun run eval:document-review:live --endpoint https://configured-worklens [--holdout] [--case case-id]. A configured live server is required.");
    return 2;
  }
  const cases = (holdout ? HOLDOUT_CASES : DEVELOPMENT_CASES).filter((test) => !chosen || test.id === chosen);
  if (!cases.length) {
    console.error(`No case ${chosen} in ${holdout ? "holdout" : "development"} set.`);
    return 2;
  }
  const run = evalRun(holdout ? "holdout" : "development", "live", { development: DEVELOPMENT_CASES.length, holdout: HOLDOUT_CASES.length }, holdout ? "none (holdout is never baselined)" : "document-review-v4");
  const rows: CaseScore[] = [];
  let systemFailures = 0;
  for (const test of cases) {
    const file = reviewFileFor(test.document, `${test.id}.${test.kind}`);
    let row: CaseScore;
    let reasons: FailureReason[] = [];
    if (file.coverage.status === "excluded") {
      // The product does not send excluded files to the server: score this coverage-only case locally.
      row = await evaluateCase(test);
      console.log(`${test.id}: excluded from live review, coverage errors ${row.coverageErrors}`);
    } else {
      const base = endpoint.replace(/\/+$/u, "");
      let response: Response;
      const started = performance.now();
      try {
        response = await fetch(`${base}/api/law/research`, {
          method: "POST", headers: { "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin" },
          body: JSON.stringify(reviewRequestFor(file.document)), signal: AbortSignal.timeout(120_000),
        });
      } catch (error) {
        console.error(`${test.id}: live request failed: ${String(error)}`);
        systemFailures++;
        continue;
      }
      const payload = await response.json().catch(() => undefined) as { data?: { found?: boolean; review?: ContractReview }; error?: { code?: string } } | undefined;
      if (!response.ok || !payload?.data?.found || !payload.data.review) {
        console.error(`${test.id}: live source unavailable (${response.status}, ${payload?.error?.code ?? "invalid response"}); not scored as a pass`);
        systemFailures++;
        continue;
      }
      const review = payload.data.review;
      try {
        // Synthetic fixture citations are not expected of live MCP; score statute domain/article
        // against issue targets and precedents against the returned holding below.
        row = scoreCase(test, file, review, 0, true, Math.round(performance.now() - started));
        for (const clause of review.clauses) for (const issue of clause.issues) for (const key of issue.precedents) {
          const precedent = review.precedents[key];
          const definition = issueDefinition(issue.id);
          if (!precedent || !definition || offDomain(`${precedent.title ?? ""} ${precedent.holding}`, review.document)
            || !holdingRelevance(precedent.holding, definition, review.document)) row.wrongPrecedentLinks++;
        }
        // Any unfinished lookup, including cancellation, makes the live case unscorable.
        reasons = review.clauses.flatMap((clause) => clause.issues.flatMap((issue) => [issue.lawFailure, issue.precedentFailure]))
          .filter((reason): reason is FailureReason => reason !== undefined);
        if (reasons.length) row.sourceFailures++;
      } catch (error) {
        console.error(`${test.id}: invalid live response: ${String(error)}; not scored as a pass`);
        systemFailures++;
        continue;
      }
    }
    rows.push(row);
    console.log(`${test.id}: TP ${row.tp} FP ${row.fp} FN ${row.fn} (selector ${row.selectorFn}, review ${row.reviewFn}) evidence failures ${row.evidenceFailures} wrong laws ${row.wrongLawLinks} wrong precedents ${row.wrongPrecedentLinks} source failures ${row.sourceFailures}${reasons.length ? ` [${[...new Set(reasons)].join(", ")}]` : ""} ${row.latencyMs}ms`);
  }
  if (rows.length !== cases.length) console.error("Some live cases did not complete. No overall quality pass can be claimed.");
  const summary = summarize(rows);
  const exitCode = liveGate(summary, cases.length, rows.length, systemFailures);
  const failureCounts = { quality: qualityFailures(summary), sourceFailures: summary.sourceFailures, systemFailures, incompleteCases: cases.length - rows.length };
  console.log(JSON.stringify({ run: { ...run, requested: cases.length, completed: rows.length, failureCounts, exitCode },
    endpoint: endpoint.replace(/\/+$/u, ""), completed: rows.length, requested: cases.length, summary, rows }, null, 2));
  return exitCode;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`Live evaluation could not complete: ${String(error)}`);
    process.exitCode = 2;
  }
}
