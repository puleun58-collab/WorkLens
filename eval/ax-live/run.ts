// AI•AX Live Eval runner (opt-in, never in CI).
// Requires BASE_URL (the deployed WorkLens to evaluate). Without it the run
// is a no-op skip so unit CI is never affected. Results land in
// eval/ax-live/results/<timestamp>/ (gitignored): one JSON per scenario plus
// summary.md with PASS / PASS WITH ISSUE / FAIL verdicts from checks.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { axDiagnosisOutputSchema, confirmedAxDiagnosis } from "../../src/lib/ax/schema";
import { axes, automationLevel, executionGate, matrixPosition, executionProfile } from "../../src/lib/ax/policy";
import { buildAllInOnePrompt } from "../../src/lib/ax/guide";
import type { AxDiagnosis } from "../../src/lib/ax/types";
import { SCENARIOS } from "./scenarios";
import { runChecks, verdict, type EvalRecord } from "./checks";

if (!process.env.BASE_URL) {
  console.log("SKIP: BASE_URL is not set. AX Live Eval is opt-in; set BASE_URL to the deployed WorkLens URL.");
  process.exit(0);
}
const BASE: string = process.env.BASE_URL;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = new URL(`./results/${stamp}/`, import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

async function callAi(body: unknown): Promise<any> {
  const res = await fetch(`${BASE}/api/ai`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  });
  const payload: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(payload)?.slice(0, 300)}`);
  return payload.data;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const only = process.argv[2]?.split(",").filter(Boolean);
const rows: string[] = [];
const counts = { PASS: 0, "PASS WITH ISSUE": 0, FAIL: 0 };

for (const s of SCENARIOS) {
  if (only?.length && !only.includes(s.id)) continue;
  const rec: EvalRecord = { scenario: s };
  try {
    const output = (await callAi({ kind: "ax-diagnosis", name: s.name, description: s.description, details: s.details })).diagnosis;
    const parsed = axDiagnosisOutputSchema.parse(output);
    const diagnosis: AxDiagnosis = { ...parsed, sourceNote: "사용자 등록 정보 기반 진단" } as AxDiagnosis;
    rec.diagnosis = diagnosis;
    rec.computed = {
      axes: axes(diagnosis), level: automationLevel(diagnosis), gate: executionGate(diagnosis),
      matrix: matrixPosition(diagnosis), profile: executionProfile(diagnosis),
    };
    if (rec.computed.profile.planAllowed) {
      const confirmed = confirmedAxDiagnosis(diagnosis);
      const task = { name: s.name, description: s.description, details: s.details };
      rec.planCodex = (await callAi({ kind: "ax-plan", target: "codex", task, diagnosis: confirmed })).plan;
      await sleep(1000);
      rec.planClaude = (await callAi({ kind: "ax-plan", target: "claude", task, diagnosis: confirmed })).plan;
      const context = [s.description, ...Object.values(s.details).filter(v => v !== undefined).map(String)].join("\n");
      rec.promptCodex = buildAllInOnePrompt(rec.planCodex, "codex", { taskName: s.name, prerequisites: rec.computed.profile.prerequisites, diagnosis, context });
      rec.promptClaude = buildAllInOnePrompt(rec.planClaude, "claude", { taskName: s.name, prerequisites: rec.computed.profile.prerequisites, diagnosis, context });
    } else {
      rec.planBlocked = true;
    }
  } catch (e) {
    rec.error = e instanceof Error ? e.message.slice(0, 500) : String(e);
  }
  const issues = runChecks(rec);
  const v = verdict(issues);
  counts[v]++;
  const c = rec.computed;
  rows.push(`| ${s.id} | ${s.name} | ${rec.diagnosis?.informationSufficiency ?? "-"} | ${c ? `L${c.level.level}` : "-"} | ${c?.gate ?? "-"} | ${c?.matrix.region ?? "-"} | ${rec.planBlocked ? "blocked" : rec.planCodex ? "생성" : "-"} | ${issues.map(i => `${i.rule}(${i.severity})`).join(", ") || "-"} | ${v} |`);
  writeFileSync(`${OUT}/${s.id}.json`, JSON.stringify({ ...rec, issues, verdict: v }, null, 2));
  console.log(`${v} ${s.id}${issues.length ? ` [${issues.map(i => i.rule).join(",")}]` : ""}`);
  await sleep(1000);
}
writeFileSync(`${OUT}/summary.md`, `# AX Live Eval ${stamp}\n\nBASE_URL=${BASE}\n\n| id | 업무 | sufficiency | Level | Gate | Matrix | 계획 | 발견 | 판정 |\n|---|---|---|---|---|---|---|---|---|\n${rows.join("\n")}\n\nPASS ${counts.PASS} · PASS WITH ISSUE ${counts["PASS WITH ISSUE"]} · FAIL ${counts.FAIL}\n`);
console.log(`DONE PASS ${counts.PASS} / ISSUE ${counts["PASS WITH ISSUE"]} / FAIL ${counts.FAIL} -> ${OUT}summary.md`);
