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
import { executionProfile, automationLevel, type ExecutionProfile } from "../../src/lib/ax/policy";
import { axDiagnosisOutputSchema, axPlanSchema, axTaskV2Schema, hitlReviewSchema, confirmedAxDiagnosis } from "../../src/lib/ax/schema";
import type { AxDiagnosis, AxPlan, AxTaskV2, HitlReview } from "../../src/lib/ax/types";
import { AGENT_SCENARIOS, type AgentScenario } from "./agent-scenarios";
import { runBrowserChecks } from "./agent-browser-checks";
import { classifyError, redactSecrets, AUTH_BLOCKED_RE, NETWORK_BLOCKED_RE, type Outcome, type FailureStage, type CauseCode, type ClassifyInput } from "./error-classify";
import { deriveDimensions, summarizeResults, type EvalDimensions } from "./eval-dimensions";

type Tool = "codex" | "claude";
interface Check { command: string; pass: boolean; observed: string }
interface Result { scenario: string; tool: Tool; outcome: Outcome; reason: string; failureStage?: FailureStage; causeCode?: CauseCode; workspace?: string; command?: string[]; exitCode?: number | null; checks: Check[]; generatedFiles: string[]; promptSha256?: string; agentLog?: string; diagnosisFile?: string; dimensions?: EvalDimensions }
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(import.meta.dir, "results", `agent-${STAMP}`);
mkdirSync(OUT, { recursive: true });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const writeJson = (file: string, data: unknown) => writeFileSync(join(OUT, file), JSON.stringify(data, null, 2));
const safeEnv: Record<string, string> = {};
for (const key of ["PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "PROGRAMFILES", "PROGRAMFILES(X86)", "PATHEXT",
  // Network egress: the sandbox VM reaches external APIs through a proxy; without these the agent CLIs cannot connect.
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
  // TLS trust: custom CA bundle paths required by the proxy chain.
  "SSL_CERT_FILE", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"]) {
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
  checks.push({ command: `node main.mjs ${args.join(" ")}`, pass, observed: redactSecrets(`${r.code === 0 ? "exit=0" : `exit=${r.code}`} stdout=${r.stdout.trim().slice(0, 350)} stderr=${r.stderr.trim().slice(0, 180)}`) });
}
async function checkError(cwd: string, args: string[], checks: Check[]) {
  const r = await command(["node", "main.mjs", ...args], cwd, 15_000);
  checks.push({ command: `node main.mjs ${args.join(" ")}`, pass: r.code !== 0 && r.code !== null && !r.timedOut, observed: redactSecrets(`exit=${r.code} stdout=${r.stdout.trim().slice(0, 200)} stderr=${r.stderr.trim().slice(0, 200)}`) });
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
    checks.push({ command: "read result.json after first process", pass: existsSync(file) && same(json(readFileSync(file, "utf8")), { approved: [{ id: "X", total: 12 }], held: [{ id: "Y", total: 14 }] }), observed: existsSync(file) ? redactSecrets(readFileSync(file, "utf8").slice(0, 200)) : "output absent" });
    await checkRun(dir, ["pipeline", "input-b.json", file], { approved: [{ id: "Z", total: 40 }], held: [] }, checks);
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    await checkError(dir, ["pipeline", "input-bad.json", file], checks);
    checks.push({ command: "read result.json after invalid process", pass: !!before && existsSync(file) && readFileSync(file, "utf8") === before, observed: existsSync(file) ? redactSecrets(readFileSync(file, "utf8").slice(0, 200)) : "output absent" });
  } else {
    await checkRun(dir, ["hitl", "input-a.json"], { candidates: [{ id: "K", amount: 10 }, { id: "A", amount: 45 }], held: [{ id: "H", amount: 20 }, { id: "U", amount: 50 }] }, checks);
    await checkRun(dir, ["hitl", "input-b.json"], { candidates: [{ id: "T", amount: 72 }, { id: "B", amount: 7 }], held: [] }, checks);
    await checkError(dir, ["hitl", "input-bad.json"], checks);
  }
  return checks;
}
const tools: Tool[] = ["codex", "claude"];
const results: Result[] = [];
const add = (r: Result) => {
  // Three independent evaluation dimensions (policy / implementation /
  // deployment) are derived from the recorded outcome at every recording
  // point. The overall outcome stays PASS/FAIL/BLOCKED/NOT_RUN compatible;
  // the dimensions carry the finer distinction (e.g. Level 0 abstention is
  // policy=pass but implementation=not-applicable, excluded from the MVP
  // implementation success rate).
  r.dimensions = deriveDimensions({ outcome: r.outcome, causeCode: r.causeCode, checksPassed: r.checks.filter(c => c.pass).length, checksTotal: r.checks.length });
  results.push(r);
  writeJson(`${r.scenario}-${r.tool}.json`, r);
  writeJson("agent-verification.json", { baseUrl: BASE, localOnly: true, deployment: "NOT_RUN", summary: summarizeResults(results), results });
  console.log(`${r.scenario}/${r.tool}: ${r.outcome} ${r.reason}`);
};
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
    // Diagnosis/registration failures are classified, not blanket-BLOCKED:
    // WorkLens API HTTP errors are FAIL (the server is part of the validated
    // pipeline); only fetch-level network failures are BLOCKED.
    const c = classifyError({ error: e, stage: "diagnosis-request" });
    const reason = `Live WorkLens diagnosis/registration failed: ${redactSecrets(String(e))}`;
    for (const tool of tools) add({ scenario: s.id, tool, outcome: c.outcome, causeCode: c.causeCode, failureStage: c.failureStage, reason, checks: [], generatedFiles: [] });
    continue;
  }
  if (!profile.planAllowed) {
    for (const tool of tools) add({ scenario: s.id, tool, outcome: "BLOCKED", reason: `WorkLens execution gate disallows plan (${profile.gate}); ${profile.blockReasons.join("; ")}`, checks: [], generatedFiles: [], diagnosisFile: `${s.id}-task-review.json` });
    continue;
  }
  for (const tool of tools) {
    const r: Result = { scenario: s.id, tool, outcome: "NOT_RUN", reason: "Not started", checks: [], generatedFiles: [], diagnosisFile: `${s.id}-task-review.json` };
    // Current pipeline stage; recorded into failureStage when a failure surfaces.
    let stage: FailureStage = "plan-generation";
    // Classified failure recording: outcome/causeCode/failureStage always come
    // from the shared, unit-tested classifier (error-classify.ts).
    const record = (input: Omit<ClassifyInput, "stage"> & { stage?: FailureStage }, reason: string) => {
      const c = classifyError({ ...input, stage: input.stage ?? stage });
      r.outcome = c.outcome;
      if (c.causeCode) r.causeCode = c.causeCode;
      r.failureStage = c.failureStage;
      r.reason = reason;
    };
    try {
      const body = (await request({ kind: "ax-plan", target: tool, task: { name: s.name, description: s.description, details: s.details }, diagnosis: confirmedAxDiagnosis(diagnosis) })) as { plan: unknown };
      const plan: AxPlan = axPlanSchema.parse(body.plan);
      task.diagnosis = { ...diagnosis, ...(tool === "codex" ? { planCodex: plan } : { planClaude: plan }) };
      stage = "prompt-generation";
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
      stage = "agent-env-prep";
      const dir = mkdtempSync(join(tmpdir(), `worklens-${s.id}-${tool}-`));
      r.workspace = dir;
      for (const [file, content] of Object.entries(s.files)) writeFileSync(join(dir, file), content);
      r.promptSha256 = hash(prompt);
      writeFileSync(join(OUT, `${s.id}-${tool}-prompt.txt`), prompt);
      writeJson(`${s.id}-${tool}-plan.json`, plan);
      const bin = Bun.which(tool);
      if (!bin) {
        record({ cliMissing: true }, `${tool} executable unavailable`);
        stage = "result-recording";
        add(r);
        continue;
      }
      stage = "agent-auth-network";
      const args = tool === "codex" ? [bin, "exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", "-C", dir, "-"] : [bin, "--print", "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--no-session-persistence", "--no-chrome"];
      // stdin is the original WorkLens instruction; no surrogate implementation prompt.
      r.command = args.map((arg, i) => i === 0 ? tool : arg);
      const child = Bun.spawn(args, { cwd: dir, env: safeEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.write(prompt);
      child.stdin.end();
      stage = "agent-exec";
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 360_000);
      let stdout: string, stderr: string;
      try { [r.exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); }
      finally { clearTimeout(timer); }
      r.agentLog = `${s.id}-${tool}-agent.log`;
      // Mask API keys/tokens before the raw agent output is written to disk.
      writeFileSync(join(OUT, r.agentLog), redactSecrets(`stdout:\n${stdout}\n\nstderr:\n${stderr}`));
      r.generatedFiles = readdirSync(dir).filter(file => !(file in s.files));
      const fixtureChanged = Object.entries(s.files).filter(([name, text]) => !existsSync(join(dir, name)) || readFileSync(join(dir, name), "utf8") !== text);
      // Log evidence decides BLOCKED vs FAIL: an expired/missing CLI login or a
      // network failure is an environment blocker, not an implementation failure.
      const authBlocked = AUTH_BLOCKED_RE.test(`${stdout}\n${stderr}`);
      const networkBlocked = NETWORK_BLOCKED_RE.test(`${stdout}\n${stderr}`);
      if (fixtureChanged.length) {
        record({ fixtureModified: true, exitCode: r.exitCode }, `Agent modified provided independent fixtures: ${fixtureChanged.map(([name]) => name).join(", ")}`);
      } else if (authBlocked && r.exitCode !== 0) {
        record({ authBlockedLog: true, exitCode: r.exitCode, stage: "agent-auth-network" }, `${tool} CLI authentication expired or missing; re-login required before implementation can run`);
      } else if (networkBlocked && r.exitCode !== 0) {
        record({ networkBlockedLog: true, exitCode: r.exitCode, stage: "agent-auth-network" }, `${tool} CLI network connectivity failure; check network/proxy before implementation can run`);
      } else if (timedOut) {
        record({ agentTimedOut: true, exitCode: r.exitCode }, "Agent execution timed out at 360s");
      } else if (r.exitCode !== 0) {
        record({ exitCode: r.exitCode }, `Agent exited ${r.exitCode}; see agent log`);
      } else if (automationLevel(diagnosis).level === 0) {
        // Level 0 instructs review-only: the agent must NOT implement. Verify
        // abstention instead of running functional checks.
        stage = "functional-test";
        const implFiles = r.generatedFiles.filter(f => !/\.md$/i.test(f));
        if (implFiles.length === 0) {
          r.outcome = "PASS";
          r.causeCode = "level-zero-abstention";
          r.failureStage = "functional-test";
          r.reason = "Level 0: agent correctly abstained from implementation per Gate policy (review-only); implementation NOT_RUN by instruction";
        } else {
          record({ exitCode: 0, functionalFailed: true }, `Level 0 violation: agent implemented ${implFiles.join(", ")} despite review-only instruction`);
          // Keep the Level 0 violation distinguishable from an ordinary
          // functional failure: it is a policy-compliance FAIL and must never
          // count as an implementation success.
          r.causeCode = "level-zero-abstention";
        }
      } else {
        stage = "functional-test";
        r.checks = await functionalChecks(s, dir);
        const passedCount = r.checks.filter(c => c.pass).length;
        // A partial pass — or zero checks — is never a PASS.
        if (r.checks.length > 0 && passedCount === r.checks.length) {
          r.outcome = "PASS";
          r.reason = `${passedCount}/${r.checks.length} functional assertions passed; local isolated implementation only`;
        } else {
          record({ exitCode: 0, functionalFailed: true }, `${passedCount}/${r.checks.length} functional assertions passed; local isolated implementation only`);
        }
      }
    } catch (e) {
      if (r.outcome === "NOT_RUN") {
        // Unclassified interruption: separate evaluator-internal errors from
        // real environment blocks instead of blanket-BLOCKED.
        const c = classifyError({ error: e, stage });
        r.outcome = c.outcome;
        if (c.causeCode) r.causeCode = c.causeCode;
        r.failureStage = c.failureStage;
        r.reason = `Unable to generate or invoke agent/test: ${redactSecrets(String(e))}`;
      } else {
        // The outcome was already determined from run observations above;
        // only fill in the failure stage.
        r.failureStage = r.failureStage ?? stage;
      }
    }
    stage = "result-recording";
    add(r);
  }
}
console.log(`Agent eval results: ${join(OUT, "agent-verification.json")}`);
