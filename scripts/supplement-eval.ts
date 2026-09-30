/**
 * 보완 quality evaluation with the live model.
 *
 *   bun scripts/supplement-eval.ts [--model openai/gpt-oss-20b] [--repeat 2] [--save-baseline]
 *
 * Runs the fixed case set in tests/eval/supplement-cases.ts through the real
 * pipeline, sending each re-check batch to Groq exactly as the server does
 * (same messages, schema, temperature and reasoning effort), then compares the
 * summary with tests/eval/supplement-baseline.json. A new critical failure or
 * a case that passed in the baseline and fails now exits non-zero.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SUPPLEMENT_EVAL_CASES } from "../tests/eval/supplement-cases";
import { FAILURE_SEVERITY, formatSummary, runSupplementCase, summarize, type EvalOutcome, type ReviewModel } from "../tests/eval/supplement-harness";
import { buildSupplementReviewMessages, parseSupplementReview, SUPPLEMENT_REVIEW_PROMPT_VERSION, SUPPLEMENT_REVIEW_RESPONSE_SCHEMA } from "../src/lib/ai/supplement-prompt";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const model = option("model", "openai/gpt-oss-20b");
const repeat = Number(option("repeat", "1"));
const baselinePath = "tests/eval/supplement-baseline.json";

function apiKey(): string {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  for (const file of [".env.local", ".dev.vars"]) {
    try {
      const line = readFileSync(file, "utf8").split(/\r?\n/u).find((entry) => entry.startsWith("GROQ_API_KEY="));
      if (line) return line.slice(line.indexOf("=") + 1).trim().replace(/^"|"$/gu, "");
    } catch { /* next file */ }
  }
  throw new Error("GROQ_API_KEY가 필요합니다.");
}

const usage = { calls: 0, promptTokens: 0, completionTokens: 0, retries: 0, errors: 0, latencyMs: 0 };
const key = apiKey();

const live: ReviewModel = async (batch) => {
  const checks = batch.checks.map(({ id, statement, requirement, handles }) => ({ id, statement, requirement, handles }));
  const body = JSON.stringify({
    model,
    messages: buildSupplementReviewMessages(checks, batch.items),
    temperature: 0,
    ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
    max_completion_tokens: 1_500,
    response_format: { type: "json_schema", json_schema: { name: "worklens_supplement_review", strict: true, schema: SUPPLEMENT_REVIEW_RESPONSE_SCHEMA } },
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const started = Date.now();
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
    });
    usage.latencyMs += Date.now() - started;
    if (response.status === 429) {
      usage.retries += 1;
      await Bun.sleep(4_000 * (attempt + 1));
      continue;
    }
    usage.calls += 1;
    if (!response.ok) { usage.errors += 1; return []; }
    const payload = await response.json() as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    usage.promptTokens += payload.usage?.prompt_tokens ?? 0;
    usage.completionTokens += payload.usage?.completion_tokens ?? 0;
    try {
      return parseSupplementReview(JSON.parse(payload.choices[0].message.content), checks);
    } catch {
      usage.errors += 1;
      return [];
    }
  }
  usage.errors += 1;
  return [];
};

const runs: EvalOutcome[][] = [];
const started = Date.now();
for (let round = 0; round < repeat; round += 1) {
  const outcomes: EvalOutcome[] = [];
  for (const entry of SUPPLEMENT_EVAL_CASES) {
    const outcome: EvalOutcome = await runSupplementCase(entry, live);
    outcomes.push({ ...outcome, findings: outcome.findings });
  }
  runs.push(outcomes);
}

// Stability: a case whose verdict or reported checks differ between rounds.
const unstable = SUPPLEMENT_EVAL_CASES.map((entry) => entry.id).filter((id) => {
  const signatures = runs.map((outcomes) => {
    const outcome = outcomes.find((item) => item.id === id)!;
    return `${outcome.passed}|${outcome.findings.map((finding) => `${finding.check}:${finding.scope}:${finding.severity}`).sort().join(",")}`;
  });
  return new Set(signatures).size > 1;
});

const summary = summarize(runs[0]);
const report = {
  model,
  promptVersion: SUPPLEMENT_REVIEW_PROMPT_VERSION,
  ranAt: new Date().toISOString(),
  repeat,
  durationMs: Date.now() - started,
  usage,
  unstable,
  summary,
  passedCases: runs[0].filter((outcome) => outcome.passed).map((outcome) => outcome.id),
};

console.log(formatSummary(`보완 eval · ${model} · prompt ${SUPPLEMENT_REVIEW_PROMPT_VERSION}`, summary));
console.log(`모델 호출 ${usage.calls}회 · 입력 ${usage.promptTokens} / 출력 ${usage.completionTokens} tokens · 재시도 ${usage.retries} · 오류 ${usage.errors} · 평균 ${usage.calls ? Math.round(usage.latencyMs / usage.calls) : 0}ms/회 · 전체 ${Math.round(report.durationMs / 1000)}s`);
if (repeat > 1) console.log(`반복 안정성: ${unstable.length ? `흔들린 Case ${unstable.join(", ")}` : "모든 Case 동일"}`);

mkdirSync("artifacts/supplement-eval", { recursive: true });
writeFileSync(`artifacts/supplement-eval/${model.replace(/\W+/gu, "_")}.json`, JSON.stringify(report, null, 2));

let regressed = false;
try {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as typeof report;
  const lost = baseline.passedCases.filter((id) => !report.passedCases.includes(id));
  const critical = summary.failures.filter((failure) => FAILURE_SEVERITY[failure.kind] === "critical");
  console.log(`기준선(${baseline.model}, prompt ${baseline.promptVersion}) 대비: Pass ${baseline.summary.passed} → ${summary.passed}, Precision ${baseline.summary.precision}% → ${summary.precision}%, Recall ${baseline.summary.recall}% → ${summary.recall}%`);
  if (lost.length) console.log(`회귀: ${lost.join(", ")}`);
  regressed = lost.length > 0 || critical.length > 0;
} catch {
  console.log("기준선 없음");
}
if (args.includes("--save-baseline")) {
  writeFileSync(baselinePath, `${JSON.stringify({ ...report, summary: { ...summary, failures: summary.failures } }, null, 2)}\n`);
  console.log(`기준선 저장: ${baselinePath}`);
}
process.exit(regressed ? 1 : 0);
