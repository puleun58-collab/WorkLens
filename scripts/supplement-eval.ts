/**
 * 보완 quality evaluation with the live model.
 *
 *   bun scripts/supplement-eval.ts [--set fixed|realistic|holdout] [--repeat 3] [--offline]
 *     [--endpoint https://worklens.example] [--model openai/gpt-oss-20b] [--budget 900] [--save-baseline]
 *
 * Runs a case set through the real pipeline. Each re-check batch goes either
 * straight to Groq exactly as the server sends it (needs GROQ_API_KEY), or with
 * --endpoint to a deployed WorkLens's /api/ai, where the server makes that same
 * call with its own key. The fixed set is compared with
 * tests/eval/supplement-baseline.json: a new critical failure or a case that
 * passed in the baseline and fails now exits non-zero.
 *
 * Call failures are classified (429, timeout, provider, invalid output, network,
 * budget) so a case that changed because a call failed is reported as
 * inconclusive (exit 2), never as a quality regression (exit 1). Progress per
 * round and case goes to stderr. The holdout set is for final verification only.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SUPPLEMENT_EVAL_CASES, type SupplementEvalCase } from "../tests/eval/supplement-cases";
import { SUPPLEMENT_REALISTIC_CASES } from "../tests/eval/supplement-realistic";
import { SUPPLEMENT_HOLDOUT_CASES } from "../tests/eval/supplement-holdout";
import { FAILURE_SEVERITY, formatSummary, runSupplementCase, summarize, type EvalOutcome, type ReviewModel } from "../tests/eval/supplement-harness";
import { buildSupplementReviewMessages, parseSupplementReview, SUPPLEMENT_REVIEW_PROMPT_VERSION, SUPPLEMENT_REVIEW_RESPONSE_SCHEMA } from "../src/lib/ai/supplement-prompt";
import type { SupplementReviewVerdict } from "../src/domain/supplement";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const model = option("model", "openai/gpt-oss-20b");
const repeat = Number(option("repeat", "1"));
const endpoint = option("endpoint", "").replace(/\/+$/u, "");
const set = option("set", "fixed");
const SETS: Record<string, SupplementEvalCase[]> = {
  fixed: SUPPLEMENT_EVAL_CASES,
  realistic: SUPPLEMENT_REALISTIC_CASES,
  holdout: SUPPLEMENT_HOLDOUT_CASES,
};
const cases = SETS[set];
if (!cases) throw new Error(`--set은 ${Object.keys(SETS).join(", ")} 중 하나입니다.`);
const baselinePath = "tests/eval/supplement-baseline.json";

function apiKey(): string {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  for (const file of [".env.local", ".dev.vars"]) {
    try {
      const line = readFileSync(file, "utf8").split(/\r?\n/u).find((entry) => entry.startsWith("GROQ_API_KEY="));
      if (line) return line.slice(line.indexOf("=") + 1).trim().replace(/^"|"$/gu, "");
    } catch { /* next file */ }
  }
  throw new Error("GROQ_API_KEY가 필요합니다. 배포된 서버로 평가하려면 --endpoint를 지정하세요.");
}

/** System (call) failures, kept apart from the model's own verdicts. */
type CallFailure = "rate-limited" | "timeout" | "provider" | "invalid-output" | "network" | "rejected" | "budget";
const usage = {
  calls: 0, promptTokens: 0, completionTokens: 0, retries: 0, recoveredAfterRetry: 0, latencyMs: 0,
  failures: { "rate-limited": 0, timeout: 0, provider: 0, "invalid-output": 0, network: 0, rejected: 0, budget: 0 } as Record<CallFailure, number>,
};
/**
 * Live-call bounds. One call: at most 3 attempts of 45s, retried only when the
 * provider asks for a short wait (Retry-After ≤ 30s); a longer window is recorded
 * as rate-limited and the call ends. The whole run: `--budget` seconds of live
 * calls (default 900); past it, calls are not made and count as `budget`.
 */
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_S = 30;
const budgetMs = Number(option("budget", "900")) * 1_000;
const runStarted = Date.now();
const overBudget = () => Date.now() - runStarted > budgetMs;
/** Seconds to wait before the next attempt, or undefined to give up on this call. */
function retryDelay(response: Response, attempt: number): number | undefined {
  if (attempt + 1 >= MAX_ATTEMPTS) return undefined;
  const stated = Number(response.headers.get("retry-after"));
  const seconds = Number.isFinite(stated) && stated > 0 ? stated : 2 * (attempt + 1);
  return seconds <= MAX_RETRY_AFTER_S ? seconds : undefined;
}
/** Case whose calls are being made, so a failed call marks the case it affected. */
let currentCase = "";
const affected = new Map<number, Set<string>>();
let round = 0;
function failed(kind: CallFailure): [] {
  usage.failures[kind] += 1;
  if (!affected.has(round)) affected.set(round, new Set());
  affected.get(round)!.add(currentCase);
  return [];
}
async function rateLimited(response: Response, attempt: number): Promise<boolean> {
  const seconds = retryDelay(response, attempt);
  console.error(`  429 on ${currentCase} (attempt ${attempt + 1}/${MAX_ATTEMPTS}, Retry-After ${response.headers.get("retry-after") ?? "-"}s): ${seconds === undefined ? "giving up on this call" : `retrying in ${seconds}s`}`);
  if (seconds === undefined) return false;
  usage.retries += 1;
  await Bun.sleep(seconds * 1_000);
  return true;
}

const checksOf = (batch: Parameters<ReviewModel>[0]) => batch.checks.map(({ id, statement, requirement, handles }) => ({ id, statement, requirement, handles }));

const groq: ReviewModel = async (batch) => {
  const key = apiKey();
  const checks = checksOf(batch);
  const body = JSON.stringify({
    model,
    messages: buildSupplementReviewMessages(checks, batch.items),
    temperature: 0,
    ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
    max_completion_tokens: 1_500,
    response_format: { type: "json_schema", json_schema: { name: "worklens_supplement_review", strict: true, schema: SUPPLEMENT_REVIEW_RESPONSE_SCHEMA } },
  });
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (overBudget()) return failed("budget");
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return failed(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network");
    } finally {
      usage.latencyMs += Date.now() - started;
    }
    if (response.status === 429) {
      if (await rateLimited(response, attempt)) continue;
      return failed("rate-limited");
    }
    usage.calls += 1;
    if (attempt > 0) usage.recoveredAfterRetry += 1;
    if (!response.ok) return failed(response.status >= 500 ? "provider" : "rejected");
    const payload = await response.json() as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    usage.promptTokens += payload.usage?.prompt_tokens ?? 0;
    usage.completionTokens += payload.usage?.completion_tokens ?? 0;
    try {
      return parseSupplementReview(JSON.parse(payload.choices[0].message.content), checks);
    } catch {
      return failed("invalid-output");
    }
  }
  return failed("rate-limited");
};

/** The deployed server's /api/ai: same messages, schema and budget, the server's own key and retry. */
const deployed: ReviewModel = async (batch) => {
  const checks = checksOf(batch);
  const body = JSON.stringify({ kind: "supplement-review", checks, items: batch.items });
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (overBudget()) return failed("budget");
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(`${endpoint}/api/ai`, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: endpoint }, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return failed(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network");
    } finally {
      usage.latencyMs += Date.now() - started;
    }
    const payload = await response.json().catch(() => undefined) as
      { data?: { kind: string; verdicts: SupplementReviewVerdict[] }; error?: { code: string } } | undefined;
    const code = payload?.error?.code;
    if (response.status === 429 || code === "AI_RATE_LIMITED" || code === "OPERATION_CAPACITY") {
      if (await rateLimited(response, attempt)) continue;
      return failed("rate-limited");
    }
    usage.calls += 1;
    if (attempt > 0) usage.recoveredAfterRetry += 1;
    if (response.ok && payload?.data?.kind === "supplement-review") return payload.data.verdicts;
    if (code === "AI_TIMEOUT" || response.status === 504) return failed("timeout");
    if (code === "INVALID_PROVIDER_OUTPUT") return failed("invalid-output");
    return failed(response.status >= 500 ? "provider" : "rejected");
  }
  return failed("rate-limited");
};

// Recorded before the run, with uncommitted changes flagged, so a report names the code it actually ran.
const commit = (() => {
  try {
    const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    return execSync("git status --porcelain", { encoding: "utf8" }).trim() ? `${sha}-dirty` : sha;
  } catch { return "unknown"; }
})();
// --offline: the deterministic pipeline alone (the model can only cancel candidates), as the CI gate runs it.
const live = args.includes("--offline") ? undefined : endpoint ? deployed : groq;
const runs: EvalOutcome[][] = [];
const started = Date.now();
const caseMs: Record<string, number[]> = {};
for (round = 0; round < repeat; round += 1) {
  const outcomes: EvalOutcome[] = [];
  for (const entry of cases) {
    currentCase = entry.id;
    const caseStarted = Date.now();
    const outcome: EvalOutcome = await runSupplementCase(entry, live);
    (caseMs[entry.id] ??= []).push(Date.now() - caseStarted);
    outcomes.push({ ...outcome, findings: outcome.findings });
    // Progress on stderr: the report on stdout stays machine-comparable.
    console.error(`[${set}] round ${round + 1}/${repeat} · case ${outcomes.length}/${cases.length} ${entry.id} ${outcome.passed ? "pass" : "FAIL"} · ${Date.now() - caseStarted}ms`);
  }
  runs.push(outcomes);
}

// Stability: a case whose verdict or reported findings differ between rounds,
// split by whether a failed call touched that case in any round.
const signature = (outcome: EvalOutcome) => `${outcome.passed}|${outcome.findings.map((finding) => `${finding.check}:${finding.scope}:${finding.severity}:${finding.status}`).sort().join(",")}`;
const unstable = cases.map((entry) => entry.id).filter((id) => new Set(runs.map((outcomes) => signature(outcomes.find((item) => item.id === id)!))).size > 1);
const systemAffected = unstable.filter((id) => [...affected.values()].some((ids) => ids.has(id)));
const modelUnstable = unstable.filter((id) => !systemAffected.includes(id));
const passedInEvery = cases.map((entry) => entry.id).filter((id) => runs.every((outcomes) => outcomes.find((item) => item.id === id)!.passed));

const fingerprint = createHash("sha256").update(JSON.stringify(cases, (_key, value) => value)).digest("hex").slice(0, 12);
const summary = summarize(runs[0]);
const durations = Object.values(caseMs).flat();
const report = {
  model,
  promptVersion: SUPPLEMENT_REVIEW_PROMPT_VERSION,
  ranAt: new Date().toISOString(),
  commit,
  evalSet: { name: set, cases: cases.length, fingerprint },
  via: endpoint || "groq",
  repeat,
  durationMs: Date.now() - started,
  caseDurationMs: { average: Math.round(durations.reduce((sum, value) => sum + value, 0) / Math.max(durations.length, 1)), max: Math.max(0, ...durations) },
  usage,
  unstable,
  stability: { modelUnstable, systemAffected, passedInEveryRound: passedInEvery.length },
  rounds: runs.map((outcomes) => ({ passed: outcomes.filter((outcome) => outcome.passed).length, summary: summarize(outcomes) })),
  summary,
  passedCases: runs[0].filter((outcome) => outcome.passed).map((outcome) => outcome.id),
};

console.log(formatSummary(`보완 eval · ${set} · ${model} · prompt ${SUPPLEMENT_REVIEW_PROMPT_VERSION} · ${commit} · set ${fingerprint}`, summary));
console.log(`호출 ${usage.calls}회 · 입력 ${usage.promptTokens} / 출력 ${usage.completionTokens} tokens (배포 서버 경유 시 미집계) · 429 재시도 ${usage.retries} (재시도 후 성공 ${usage.recoveredAfterRetry}) · 호출 실패 ${JSON.stringify(usage.failures)} · 평균 ${usage.calls ? Math.round(usage.latencyMs / usage.calls) : 0}ms/회 · Case 평균 ${report.caseDurationMs.average}ms, 최대 ${report.caseDurationMs.max}ms · 전체 ${Math.round(report.durationMs / 1000)}s`);
// A case a failed call touched (rate limit, timeout, budget …) says nothing about quality.
const touched = new Set([...affected.values()].flatMap((ids) => [...ids]));
const failedIds = cases.map((entry) => entry.id).filter((id) => !passedInEvery.includes(id));
const qualityFailed = failedIds.filter((id) => !touched.has(id));
const systemFailed = failedIds.filter((id) => touched.has(id));
console.log(`판정: 품질 실패 ${qualityFailed.join(", ") || "없음"} · 호출 실패로 판정 불가 ${systemFailed.join(", ") || "없음"}`);
if (repeat > 1) {
  console.log(`반복 ${repeat}회: 매회 Pass ${report.rounds.map((entry) => entry.passed).join(" / ")} · 모든 회차 Pass ${passedInEvery.length}/${cases.length}`);
  console.log(`  모델 판정 불안정: ${modelUnstable.join(", ") || "없음"} · 호출 실패로 달라짐: ${systemAffected.join(", ") || "없음"}`);
}

mkdirSync("artifacts/supplement-eval", { recursive: true });
writeFileSync(`artifacts/supplement-eval/${set}-${model.replace(/\W+/gu, "_")}-${report.ranAt.replace(/\W+/gu, "")}.json`, JSON.stringify({ ...report, verdict: { qualityFailed, systemFailed } }, null, 2));

let regressed = runs.some((outcomes) => outcomes.some((outcome) => !touched.has(outcome.id) && outcome.failures.some((failure) => FAILURE_SEVERITY[failure.kind] === "critical"))) || modelUnstable.length > 0;
if (set === "fixed") {
  try {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as typeof report;
    const lost = baseline.passedCases.filter((id) => !passedInEvery.includes(id));
    console.log(`기준선(${baseline.model}, prompt ${baseline.promptVersion}) 대비: Pass ${baseline.summary.passed} → ${summary.passed}, Precision ${baseline.summary.precision}% → ${summary.precision}%, Recall ${baseline.summary.recall}% → ${summary.recall}%`);
    const qualityLost = lost.filter((id) => !touched.has(id));
    if (qualityLost.length) console.log(`회귀: ${qualityLost.join(", ")}`);
    if (lost.length > qualityLost.length) console.log(`판정 불가(호출 실패): ${lost.filter((id) => touched.has(id)).join(", ")}`);
    regressed ||= qualityLost.length > 0;
  } catch {
    console.log("기준선 없음");
  }
  if (args.includes("--save-baseline")) {
    if (touched.size > 0) console.log("호출 실패가 있어 기준선을 저장하지 않습니다.");
    else {
      writeFileSync(baselinePath, `${JSON.stringify({ ...report, summary: { ...summary, failures: summary.failures } }, null, 2)}\n`);
      console.log(`기준선 저장: ${baselinePath}`);
    }
  }
}
// 1: quality regression · 2: inconclusive (calls failed) · 0: pass.
process.exit(regressed ? 1 : systemFailed.length > 0 ? 2 : 0);
