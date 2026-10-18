// Opt-in, expensive live implementation eval: bun eval/ax-live/agent-run.ts
// Each agent receives its own freshly created OS temp directory. Never targets WorkLens for edits/deployment.
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { extractReviewableItems, extractPlanReviewableItems, validateReviewForConfirm, getValidConfirmedReviews } from "../../src/lib/ax/hitl";
import { buildAllInOnePrompt } from "../../src/lib/ax/guide";
import { executionProfile, type ExecutionProfile } from "../../src/lib/ax/policy";
import { axDiagnosisOutputSchema, axPlanSchema, axTaskV2Schema, hitlReviewSchema, confirmedAxDiagnosis } from "../../src/lib/ax/schema";
import type { AxDiagnosis, AxPlan, AxTaskV2, HitlReview } from "../../src/lib/ax/types";
import { AGENT_SCENARIOS, type AgentScenario } from "./agent-scenarios";
import { runBrowserChecks } from "./agent-browser-checks";

type Tool = "codex" | "claude";
type Outcome = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
interface Check { command: string; pass: boolean; observed: string }
interface Result { scenario: string; tool: Tool; outcome: Outcome; reason: string; workspace?: string; command?: string[]; exitCode?: number | null; checks: Check[]; generatedFiles: string[]; promptSha256?: string; agentLog?: string; diagnosisFile?: string }
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(import.meta.dir, "results", `agent-${STAMP}`);
mkdirSync(OUT, { recursive: true });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const writeJson = (file: string, data: unknown) => writeFileSync(join(OUT, file), JSON.stringify(data, null, 2));
const safeEnv: Record<string, string> = {};
for (const key of ["PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "PROGRAMFILES", "PROGRAMFILES(X86)", "PATHEXT"]) {
  if (process.env[key]) safeEnv[key] = process.env[key]!;
}
safeEnv.NO_COLOR = "1";
safeEnv.CI = "1";

async function request(body: unknown): Promise<unknown> {
  const response = await fetch(`${BASE}/api/ai`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
  const payload = await response.json() as { data?: { diagnosis?: unknown; plan?: unknown }; error?: { code?: string; message?: string } };
  if (!response.ok) throw new Error(`WorkLens API HTTP ${response.status} ${payload.error?.code ?? "UNKNOWN"}: ${payload.error?.message ?? ""}`);
  return payload.data;
}
async function command(args: string[], cwd: string, ms: number, env = safeEnv): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, ms);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr, timedOut };
  } finally { clearTimeout(timeout); }
}
const json = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };
const same = isDeepStrictEqual;
async function checkRun(cwd: string, args: string[], expected: unknown, checks: Check[]) {
  const r = await command(["node", "main.mjs", ...args], cwd, 15_000);
  const pass = r.code === 0 && same(json(r.stdout.trim()), expected);
  checks.push({ command: `node main.mjs ${args.join(" ")}`, pass, observed: `${r.code === 0 ? "exit=0" : `exit=${r.code}`} stdout=${r.stdout.trim().slice(0, 350)} stderr=${r.stderr.trim().slice(0, 180)}` });
}
async function checkError(cwd: string, args: string[], checks: Check[]) {
  const r = await command(["node", "main.mjs", ...args], cwd, 15_000);
  checks.push({ command: `node main.mjs ${args.join(" ")}`, pass: r.code !== 0 && r.code !== null && !r.timedOut, observed: `exit=${r.code} stdout=${r.stdout.trim().slice(0, 200)} stderr=${r.stderr.trim().slice(0, 200)}` });
}
async function functionalChecks(s: AgentScenario, dir: string): Promise<Check[]> {
  const checks: Check[] = [];
  if (s.id === "csv" || s.id === "crud") {
    return runBrowserChecks(s.id, dir, safeEnv);
  } else if (s.id === "api") {
    // The fixture module path is generated per isolated run, so it cannot be a static import.
    const { startFixture } = await import(pathToFileURL(join(dir, "api-fixture.mjs")).href) as { startFixture: () => Promise<Server> };
    const server = await startFixture();
    try { return await runBrowserChecks("api", dir, safeEnv, server); }
    finally { server.close(); }
  } else if (s.id === "pipeline") {
    const file = join(dir, "result.json");
    await checkRun(dir, ["pipeline", "input-a.json", file], { approved: [{ id: "X", total: 12 }], held: [{ id: "Y", total: 14 }] }, checks);
    checks.push({ command: "read result.json after first process", pass: existsSync(file) && same(json(readFileSync(file, "utf8")), { approved: [{ id: "X", total: 12 }], held: [{ id: "Y", total: 14 }] }), observed: existsSync(file) ? readFileSync(file, "utf8").slice(0, 200) : "output absent" });
    await checkRun(dir, ["pipeline", "input-b.json", file], { approved: [{ id: "Z", total: 40 }], held: [] }, checks);
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    await checkError(dir, ["pipeline", "input-bad.json", file], checks);
    checks.push({ command: "read result.json after invalid process", pass: !!before && existsSync(file) && readFileSync(file, "utf8") === before, observed: existsSync(file) ? readFileSync(file, "utf8").slice(0, 200) : "output absent" });
  } else {
    await checkRun(dir, ["hitl", "input-a.json"], { candidates: [{ id: "K", amount: 10 }, { id: "A", amount: 45 }], held: [{ id: "H", amount: 20 }, { id: "U", amount: 50 }] }, checks);
    await checkRun(dir, ["hitl", "input-b.json"], { candidates: [{ id: "T", amount: 72 }, { id: "B", amount: 7 }], held: [] }, checks);
    await checkError(dir, ["hitl", "input-bad.json"], checks);
  }
  return checks;
}
const tools: Tool[] = ["codex", "claude"];
const results: Result[] = [];
const add = (r: Result) => { results.push(r); writeJson(`${r.scenario}-${r.tool}.json`, r); writeJson("agent-verification.json", { baseUrl: BASE, localOnly: true, deployment: "NOT_RUN", results }); console.log(`${r.scenario}/${r.tool}: ${r.outcome} ${r.reason}`); };
for (const s of AGENT_SCENARIOS) {
  let diagnosis: AxDiagnosis;
  let task: AxTaskV2;
  let profile: ExecutionProfile;
  try {
    const output = (await request({ kind: "ax-diagnosis", name: s.name, description: s.description, details: s.details })) as { diagnosis: unknown };
    diagnosis = { ...axDiagnosisOutputSchema.parse(output.diagnosis), sourceNote: "사용자 등록 정보 기반 진단" };
    // A schema-validated task record represents registration; browser registration is separately checked by the main agent.
    task = axTaskV2Schema.parse({ id: `eval-${s.id}`, name: s.name, description: s.description, ...s.details, status: diagnosis.informationSufficiency === "needs-check" ? "needs-info" : "diagnosed", diagnosis, reviews: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    profile = executionProfile(diagnosis);
    writeJson(`${s.id}-task-review.json`, { task, executionProfile: profile, registration: "schema-validated task equivalent, not observed browser registration" });
  } catch (e) {
    for (const tool of tools) add({ scenario: s.id, tool, outcome: "BLOCKED", reason: `Live WorkLens diagnosis/registration failed: ${String(e)}`, checks: [], generatedFiles: [] });
    continue;
  }
  if (!profile.planAllowed) {
    for (const tool of tools) add({ scenario: s.id, tool, outcome: "BLOCKED", reason: `WorkLens execution gate disallows plan (${profile.gate}); ${profile.blockReasons.join("; ")}`, checks: [], generatedFiles: [], diagnosisFile: `${s.id}-task-review.json` });
    continue;
  }
  for (const tool of tools) {
    const r: Result = { scenario: s.id, tool, outcome: "NOT_RUN", reason: "Not started", checks: [], generatedFiles: [], diagnosisFile: `${s.id}-task-review.json` };
    try {
      const body = (await request({ kind: "ax-plan", target: tool, task: { name: s.name, description: s.description, details: s.details }, diagnosis: confirmedAxDiagnosis(diagnosis) })) as { plan: unknown };
      const plan: AxPlan = axPlanSchema.parse(body.plan);
      task.diagnosis = { ...diagnosis, ...(tool === "codex" ? { planCodex: plan } : { planClaude: plan }) };
      const reviews: HitlReview[] = [];
      if (s.id === "hitl") {
        const items = [...extractReviewableItems(diagnosis), ...extractPlanReviewableItems(plan, tool)];
        const used = new Set<string>();
        for (const [action, find] of [
          ["keep", (text: string) => /후보|생성|목록|입력/u.test(text)],
          ["defer", (text: string) => /확인|보류|검토/u.test(text)],
          ["exclude", (text: string) => /자동|전송|반영/u.test(text)],
          ["supplement", (text: string) => /검증|처리|필수/u.test(text)],
        ] as const) {
          const item = items.find(candidate => !used.has(candidate.key) && find(candidate.text));
          if (!item) continue;
          used.add(item.key);
          const now = new Date().toISOString();
          const review = hitlReviewSchema.parse({ id: `${tool}-${action}`, target: { type: item.type, key: item.key, source: item.source, sourceText: item.text, sourceHash: item.sourceHash }, action, status: "confirmed", ...(action === "defer" || action === "exclude" ? { reason: "독립 평가 범위에서 담당자가 보류/제외" } : {}), ...(action === "supplement" ? { supplement: "확인된 입력만 처리하고 잘못된 값은 오류로 표시" } : {}), reviewedAt: now, updatedAt: now });
          const checked = validateReviewForConfirm(task, review.target);
          if (!checked.valid) throw new Error(`HITL target not confirmable: ${checked.reason}`);
          reviews.push(review);
        }
        if (reviews.length < 4) throw new Error(`HITL review targets insufficient: only ${reviews.length}/4 actions available`);
        const essential = items.find(item => !used.has(item.key));
        if (!essential) throw new Error("HITL unconfirmed essential target unavailable");
        const now = new Date().toISOString();
        reviews.push(hitlReviewSchema.parse({ id: `${tool}-unconfirmed-essential`, target: { type: essential.type, key: essential.key, source: essential.source, sourceText: essential.text, sourceHash: essential.sourceHash }, action: "keep", status: "pending", reviewedAt: now, updatedAt: now }));
        task.reviews = reviews;
        writeJson(`${s.id}-${tool}-review.json`, { reviews, validConfirmed: getValidConfirmedReviews(task, items).map(review => review.id), unconfirmedEssential: essential.key });
      }
      const prompt = buildAllInOnePrompt(plan, tool, { taskName: s.name, prerequisites: profile.prerequisites, diagnosis: task.diagnosis, context: [s.description, ...Object.entries(s.details).map(([key, value]) => `${key}: ${value}`)].join("\n"), hitlReviews: reviews, hitlTool: tool });
      const dir = mkdtempSync(join(tmpdir(), `worklens-${s.id}-${tool}-`));
      r.workspace = dir;
      for (const [file, content] of Object.entries(s.files)) writeFileSync(join(dir, file), content);
      r.promptSha256 = hash(prompt);
      writeFileSync(join(OUT, `${s.id}-${tool}-prompt.txt`), prompt);
      writeJson(`${s.id}-${tool}-plan.json`, plan);
      const bin = Bun.which(tool);
      if (!bin) { r.outcome = "BLOCKED"; r.reason = `${tool} executable unavailable`; add(r); continue; }
      const args = tool === "codex" ? [bin, "exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", "-C", dir, "-"] : [bin, "--print", "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--no-session-persistence", "--no-chrome"];
      // stdin is the original WorkLens instruction; no surrogate implementation prompt.
      r.command = args.map((arg, i) => i === 0 ? tool : arg);
      const child = Bun.spawn(args, { cwd: dir, env: safeEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.write(prompt);
      child.stdin.end();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 360_000);
      let stdout: string, stderr: string;
      try { [r.exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); }
      finally { clearTimeout(timer); }
      r.agentLog = `${s.id}-${tool}-agent.log`;
      writeFileSync(join(OUT, r.agentLog), `stdout:\n${stdout}\n\nstderr:\n${stderr}`);
      r.generatedFiles = readdirSync(dir).filter(file => !(file in s.files));
      const fixtureChanged = Object.entries(s.files).filter(([name, text]) => !existsSync(join(dir, name)) || readFileSync(join(dir, name), "utf8") !== text);
      // An expired or missing CLI login is an environment blocker, not an implementation failure.
      const authBlocked = /token_expired|refresh token was already used|OAuth session expired|Not logged in|Please log out and sign in again|401 Unauthorized/iu.test(`${stdout}\n${stderr}`);
      // Network connectivity issues are environment blockers, not implementation failures.
      const networkBlocked = /failed to refresh available models|Transport channel closed|http\/request failed|workspace routing discovery failed|Reconnecting\.\.\.|request timed out|error sending request for url/iu.test(`${stdout}\n${stderr}`);
      if (fixtureChanged.length) { r.outcome = "FAIL"; r.reason = `Agent modified provided independent fixtures: ${fixtureChanged.map(([name]) => name).join(", ")}`; }
      else if (authBlocked && r.exitCode !== 0) { r.outcome = "BLOCKED"; r.reason = `${tool} CLI authentication expired or missing; re-login required before implementation can run`; }
      else if (networkBlocked && r.exitCode !== 0) { r.outcome = "BLOCKED"; r.reason = `${tool} CLI network connectivity failure; check network/proxy before implementation can run`; }
      else if (timedOut) { r.outcome = "FAIL"; r.reason = "Agent execution timed out at 360s"; }
      else if (r.exitCode !== 0) { r.outcome = "FAIL"; r.reason = `Agent exited ${r.exitCode}; see agent log`; }
      else {
        r.checks = await functionalChecks(s, dir);
        r.outcome = r.checks.length && r.checks.every(c => c.pass) ? "PASS" : "FAIL";
        r.reason = `${r.checks.filter(c => c.pass).length}/${r.checks.length} functional assertions passed; local isolated implementation only`;
      }
    } catch (e) { r.outcome = "BLOCKED"; r.reason = `Unable to generate or invoke agent/test: ${String(e)}`; }
    add(r);
  }
}
console.log(`Agent eval results: ${join(OUT, "agent-verification.json")}`);
