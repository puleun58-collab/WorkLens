// Run only after blind scoring is complete. No network calls.
import { readFile, readdir } from "node:fs/promises";

const outDir = (process.env.OUT_DIR ?? "./results").replace(/\/$/, "");
const mapping = JSON.parse(await readFile(`${outDir}/sealed/mapping.json`, "utf8")) as Record<string, string>;
interface Metric {
  anonymousId: string;
  scenarioId: string;
  run: number;
  effort: string;
  httpStatus: number | null;
  durationMsClient: number;
  requestId: string | null;
  timeout: boolean;
  errorCode: string | null;
  schemaOk: boolean;
  serverUsage: Record<string, unknown> | null;
}
interface Score { scores: number[]; total: number; flags: string[]; hardFail: boolean; note: string }
const metrics = JSON.parse(await readFile(`${outDir}/sealed/metrics-partial.json`, "utf8")) as Metric[];
const scores: Record<string, Score> = {};
const scoreFiles = (await readdir(`${outDir}/sealed`)).filter(file => /^scores-.*\.json$/.test(file)).sort();
if (!scoreFiles.length) throw new Error("Blind 채점 후 sealed/scores-*.json을 작성하세요. README.md를 참조하세요.");
for (const file of scoreFiles) {
  const batch = JSON.parse(await readFile(`${outDir}/sealed/${file}`, "utf8")) as Record<string, Score>;
  for (const [id, score] of Object.entries(batch)) {
    if (scores[id]) throw new Error(`중복 채점: ${id}`);
    if (!metrics.some(metric => metric.anonymousId === id && metric.schemaOk)) throw new Error(`스키마 유효 결과만 채점할 수 있습니다: ${id}`);
    if (score.scores.length !== 10 || score.scores.some(value => !Number.isInteger(value) || value < 0 || value > 2)
      || score.total !== score.scores.reduce((sum, value) => sum + value, 0)
      || !Array.isArray(score.flags) || score.flags.some(flag => typeof flag !== "string")
      || typeof score.hardFail !== "boolean" || typeof score.note !== "string") throw new Error(`채점 형식을 확인하세요: ${id}`);
    scores[id] = score;
  }
}
for (const metric of metrics) {
  if (mapping[metric.anonymousId] !== metric.effort) throw new Error(`effort 매핑 불일치: ${metric.anonymousId}`);
}

const categoryOf = (id: string) => id.startsWith("S") ? "단순" : id.startsWith("M") ? "중간" : id.startsWith("T") ? "기술제약" : "고위험";
const efforts = ["low", "medium", "high"].filter(effort => metrics.some(metric => metric.effort === effort));
function pct(values: number[], percentile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((percentile / 100) * sorted.length))];
}
const avg = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const roundedAvg = (values: number[]) => { const value = avg(values); return value === null ? null : Math.round(value); };
const meanQuality = (values: number[]) => { const value = avg(values); return value === null ? null : +value.toFixed(2); };
const numeric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const modelFailure = (metric: Metric) => metric.errorCode === "INVALID_PROVIDER_OUTPUT"
  || metric.errorCode === "AI_PROVIDER_REJECTED" || metric.serverUsage?.providerCode === "json_validate_failed"
  || (metric.httpStatus === 200 && !metric.schemaOk);

const out: Record<string, unknown> = {};
for (const effort of efforts) {
  const calls = metrics.filter(metric => metric.effort === effort);
  const valid = calls.filter(metric => metric.schemaOk);
  const scoredMetrics = valid.filter(metric => scores[metric.anonymousId]);
  const scored = scoredMetrics.map(metric => scores[metric.anonymousId]);
  const usage = calls.flatMap(metric => metric.serverUsage ? [metric.serverUsage] : []);
  const durations = usage.map(value => value.durationMs).filter(numeric);
  const failures = calls.filter(metric => !metric.schemaOk);
  const modelFailures = failures.filter(modelFailure);
  const infraFailures = failures.filter(metric => !modelFailure(metric));
  const flagCounts: Record<string, number> = {};
  for (const score of scored) for (const flag of score.flags) flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
  const hardFails = scoredMetrics.filter(metric => scores[metric.anonymousId].hardFail);
  const tokens = (cumulative: string, last: string) => usage.map(value => value[cumulative] ?? value[last]).filter(numeric);
  out[effort] = {
    calls: calls.length, valid: valid.length, scored: scored.length, unscored: valid.length - scored.length,
    structuredRate: +(valid.length / calls.length).toFixed(3),
    modelOutputFailures: modelFailures.length, infraFailures: infraFailures.length,
    infraDetail: infraFailures.map(metric => `${metric.anonymousId}:${metric.errorCode ?? metric.httpStatus}`),
    retryRate: +(calls.filter(metric => Number(metric.serverUsage?.attempt ?? 1) >= 2).length / calls.length).toFixed(3),
    timeouts: calls.filter(metric => metric.timeout).length,
    latencyServerMs: { avg: roundedAvg(durations), p50: pct(durations, 50), p95: pct(durations, 95) },
    latencyClientMs: { avg: roundedAvg(calls.map(metric => metric.durationMsClient)), p50: pct(calls.map(metric => metric.durationMsClient), 50), p95: pct(calls.map(metric => metric.durationMsClient), 95) },
    // Prefer cumulative counters so corrections/provider retries are included in cost comparisons.
    tokensAvg: { prompt: roundedAvg(tokens("cumulativePromptTokens", "promptTokens")), completion: roundedAvg(tokens("cumulativeCompletionTokens", "completionTokens")), total: roundedAvg(tokens("cumulativeTotalTokens", "totalTokens")) },
    usageObservedCalls: usage.length,
    qualityMean: meanQuality(scored.map(score => score.total)), qualityMedian: pct(scored.map(score => score.total), 50),
    hardFails: hardFails.length, hardFailScenarios: new Set(hardFails.map(metric => metric.scenarioId)).size,
    flags: flagCounts,
  };
}
console.log(JSON.stringify(out, null, 2));
console.log("\n== 그룹별 평균 품질 (scored만) ==");
for (const group of ["단순", "중간", "기술제약", "고위험"]) {
  const row: Record<string, unknown> = {};
  for (const effort of efforts) {
    const items = metrics.filter(metric => metric.effort === effort && categoryOf(metric.scenarioId) === group && scores[metric.anonymousId]);
    row[effort] = { qualityMean: meanQuality(items.map(metric => scores[metric.anonymousId].total)), scored: items.length };
  }
  console.log(group, JSON.stringify(row));
}
console.log("\n== 시나리오×effort valid 분포 ==");
for (const scenarioId of [...new Set(metrics.map(metric => metric.scenarioId))]) {
  const row = Object.fromEntries(efforts.map(effort => [effort, metrics.filter(metric => metric.scenarioId === scenarioId && metric.effort === effort && metric.schemaOk).length]));
  console.log(scenarioId, JSON.stringify(row));
}
