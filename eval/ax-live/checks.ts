// Meaning-based checks for AX Live Eval results. These are review signals with
// FAIL/ISSUE severities, not exact-string snapshots: each check looks at what
// the output asserts in context (e.g. a technology named inside a
// "확인 필요" item is a question to verify, not an invention).
import type { AxLiveScenario } from "./scenarios";
import type { AxDiagnosis, AxPlan } from "../../src/lib/ax/types";
import type { axes, automationLevel, executionGate, matrixPosition, executionProfile } from "../../src/lib/ax/policy";

export interface CheckIssue { severity: "fail" | "issue"; rule: string; detail: string }
export interface ComputedSummary {
  axes: ReturnType<typeof axes>;
  level: ReturnType<typeof automationLevel>;
  gate: ReturnType<typeof executionGate>;
  matrix: ReturnType<typeof matrixPosition>;
  profile: ReturnType<typeof executionProfile>;
}
export interface EvalRecord {
  scenario: AxLiveScenario;
  diagnosis?: AxDiagnosis;
  computed?: ComputedSummary;
  planCodex?: AxPlan;
  planClaude?: AxPlan;
  promptCodex?: string;
  promptClaude?: string;
  planBlocked?: boolean;
  error?: string;
}

const SPECIFIC_TECH = [
  /OAuth\s?2?/i, /SAML/i, /LDAP/i, /SSO/, /SMTP/i, /Bearer/i, /REST/i,
  /\/v\d+\/[a-z]/i, /PowerShell/i, /Task Scheduler/i, /작업 스케줄러/, /Webhook/i, /GraphQL/i,
];
const ORG = /[가-힣A-Za-z]{2,}(?:팀|부서|본부)/g;

function inputText(s: AxLiveScenario): string {
  return [s.name, s.description, ...Object.values(s.details).map(String)].join("\n");
}

export function runChecks(rec: EvalRecord): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const s = rec.scenario;
  if (rec.error || !rec.diagnosis || !rec.computed) {
    return [{ severity: "fail", rule: "run-error", detail: rec.error ?? "no diagnosis" }];
  }
  const d = rec.diagnosis, input = inputText(s);
  const factor = (k: string) => d.factors.find(f => f.key === k)?.aiValue;

  // "확인됨" technical checks must not assert specific technologies absent from the input.
  for (const t of d.technicalChecks ?? []) {
    if (t.status !== "확인됨") continue;
    const text = `${t.topic} ${t.note}`;
    for (const re of SPECIFIC_TECH) {
      if (re.test(text) && !re.test(input)) {
        issues.push({ severity: "fail", rule: "confirmed-tech-invention", detail: `${t.topic}: ${text}` });
      }
    }
  }
  // Organizations named in the diagnosis must come from the input.
  const inputOrgs = new Set(input.match(ORG) ?? []);
  for (const name of new Set(JSON.stringify(d).match(ORG) ?? [])) {
    if (!inputOrgs.has(name)) issues.push({ severity: "issue", rule: "org-not-in-input", detail: name });
  }
  // No invented quantitative performance metrics in the final prompts.
  for (const [label, prompt] of [["codex", rec.promptCodex], ["claude", rec.promptClaude]] as const) {
    if (prompt && /\d+(?:\.\d+)?\s?%/.test(prompt)) {
      issues.push({ severity: "fail", rule: "metric-in-prompt", detail: label });
    }
  }
  // Human-maintained steps must survive into the plan stage.
  const humanSteps = (d.stepAssessments ?? []).filter(x => x.verdict === "사람 유지");
  if (humanSteps.length === 0) {
    issues.push({ severity: "issue", rule: "no-human-step", detail: "diagnosis has no 사람 유지 step" });
  }
  if (rec.promptCodex && !rec.promptCodex.includes("담당자")) {
    issues.push({ severity: "fail", rule: "human-step-dropped", detail: "prompt has no 담당자 step" });
  }
  // Scope chain: plans only when the profile allows them; conditional work
  // must surface its prerequisites in the prompt instead of jumping to rollout.
  if (!rec.computed.profile.planAllowed && !rec.planBlocked) {
    issues.push({ severity: "fail", rule: "plan-despite-blocked", detail: "plan generated while planAllowed=false" });
  }
  if (rec.computed.gate === "conditional" && rec.promptCodex
    && !rec.promptCodex.includes("구현 전 확인사항") && !rec.promptCodex.includes("선행 확인")) {
    issues.push({ severity: "issue", rule: "conditional-without-prerequisite", detail: "conditional prompt lacks a prerequisites-first section" });
  }
  if (rec.computed.level.level === 0 && rec.promptCodex && /전체 자동화|전면 자동화/.test(rec.promptCodex)) {
    issues.push({ severity: "fail", rule: "level0-full-automation", detail: "Level 0 prompt claims full automation" });
  }
  // informationSufficiency boundaries (PR #102).
  if (s.expectNeedsCheck) {
    if (d.informationSufficiency === "sufficient") issues.push({ severity: "fail", rule: "sparse-but-sufficient", detail: d.informationSufficiency });
    else if (d.informationSufficiency !== "needs-check") issues.push({ severity: "issue", rule: "sparse-not-needs-check", detail: d.informationSufficiency });
    if ((d.followUpQuestions ?? []).length === 0) issues.push({ severity: "issue", rule: "needs-check-without-questions", detail: "no follow-up questions" });
  }
  if (s.expectNotNeedsCheck && d.informationSufficiency === "needs-check") {
    issues.push({ severity: "issue", rule: "needs-check-overcorrection", detail: "needs-check despite enough core info" });
  }
  // systemAccess direction (PR #102).
  const sa = factor("systemAccess");
  if (s.systemAccess === "low" && typeof sa === "number") {
    if (sa > 3) issues.push({ severity: "fail", rule: "system-access-direction", detail: `manual-only scored ${sa}` });
    else if (sa === 3) issues.push({ severity: "issue", rule: "system-access-direction", detail: `manual-only scored ${sa}` });
  }
  if (s.systemAccess === "not-low" && typeof sa === "number" && sa <= 2) {
    issues.push({ severity: "fail", rule: "system-access-undervalued", detail: `confirmed API scored ${sa}` });
  }
  if (s.apiPlusHumanApproval) {
    const hj = factor("humanJudgment");
    if (!(typeof sa === "number" && sa >= 3)) issues.push({ severity: "fail", rule: "api-human-separation", detail: `systemAccess=${sa}` });
    if (!((typeof hj === "number" && hj >= 3) || (d.humanInLoop ?? []).length > 0)) {
      issues.push({ severity: "issue", rule: "api-human-separation", detail: `humanJudgment=${hj}, humanInLoop=${(d.humanInLoop ?? []).length}` });
    }
  }
  return issues;
}

export function verdict(issues: CheckIssue[]): "PASS" | "PASS WITH ISSUE" | "FAIL" {
  if (issues.some(i => i.severity === "fail")) return "FAIL";
  return issues.length ? "PASS WITH ISSUE" : "PASS";
}
