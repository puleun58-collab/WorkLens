/**
 * Summarises artifacts/regression/cases.jsonl (written by the Tier 2 suite)
 * and, when present, artifacts/law-regression.json (Tier 3) into
 * artifacts/regression/report.json and report.md.
 */
import { readFile, writeFile } from "node:fs/promises";

type Case = { id: string; category: string; input: string; format: string; structure: string; expected: string; actual: string; viewport: string; result: "PASS" | "FAIL"; classification?: string; durationMs: number; warnings: string[]; errors: string[] };

const lines = (await readFile("artifacts/regression/cases.jsonl", "utf8").catch(() => "")).split("\n").filter(Boolean);
// Keep the last run of each case/viewport (re-runs append).
const latest = new Map<string, Case>();
for (const line of lines) { const entry = JSON.parse(line) as Case; latest.set(`${entry.id}|${entry.viewport}`, entry); }
const cases = [...latest.values()].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }) || a.viewport.localeCompare(b.viewport));

const law = await readFile("artifacts/law-regression.json", "utf8").then((text) => JSON.parse(text) as { outcomes: Array<{ id: string; category: string; query: string; result: string; ms: number; reason?: string; actual?: string; resolved?: string }> }).catch(() => undefined);
for (const outcome of law?.outcomes ?? []) {
  cases.push({ id: `LAW-${outcome.id}`, category: "Law", input: outcome.query, format: "live", structure: outcome.category, expected: "live 법제처 via WorkLens API", actual: outcome.resolved ?? `${outcome.reason}: ${outcome.actual}`, viewport: "api", result: outcome.result === "FAIL" ? "FAIL" : "PASS", classification: outcome.result === "UPSTREAM" ? "Upstream" : outcome.result === "PASS" ? "PASS" : undefined, durationMs: outcome.ms, warnings: [], errors: [] });
}

const count = (predicate: (entry: Case) => boolean) => cases.filter(predicate).length;
const summary = {
  total: cases.length,
  pass: count((entry) => entry.result === "PASS" && entry.classification === "PASS"),
  expected: count((entry) => entry.classification === "Expected"),
  unsupported: count((entry) => entry.classification === "Unsupported"),
  upstream: count((entry) => entry.classification === "Upstream"),
  fail: count((entry) => entry.result === "FAIL"),
};
const byCategory: Record<string, { total: number; fail: number }> = {};
for (const entry of cases) { const bucket = byCategory[entry.category] ??= { total: 0, fail: 0 }; bucket.total += 1; if (entry.result === "FAIL") bucket.fail += 1; }
const slowest = [...cases].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10).map(({ id, viewport, input, durationMs }) => ({ id, viewport, input, durationMs }));

await writeFile("artifacts/regression/report.json", JSON.stringify({ at: new Date().toISOString(), summary, byCategory, slowest, cases }, null, 2));
const md = [
  `# WorkLens full regression — ${new Date().toISOString()}`,
  "", `Total ${summary.total} · PASS ${summary.pass} · FAIL ${summary.fail} · Expected ${summary.expected} · Unsupported ${summary.unsupported} · Upstream ${summary.upstream}`,
  "", "| Case | Viewport | Category | Format | Input | Result | ms | Actual |", "|---|---|---|---|---|---|---|---|",
  ...cases.map((entry) => `| ${entry.id} | ${entry.viewport} | ${entry.category} | ${entry.format} | ${entry.input} | ${entry.result === "FAIL" ? "**FAIL**" : entry.classification} | ${entry.durationMs} | ${entry.actual.replaceAll("|", "\\|").slice(0, 140)} |`),
].join("\n");
await writeFile("artifacts/regression/report.md", md);
console.log(`Total ${summary.total}  PASS ${summary.pass}  FAIL ${summary.fail}  Expected ${summary.expected}  Unsupported ${summary.unsupported}  Upstream ${summary.upstream}`);
for (const [category, bucket] of Object.entries(byCategory)) console.log(`  ${category.padEnd(11)} ${bucket.total - bucket.fail}/${bucket.total}`);
for (const entry of cases.filter((item) => item.result === "FAIL")) console.log(`FAIL ${entry.id} [${entry.viewport}] ${entry.input}: ${entry.actual}`);
