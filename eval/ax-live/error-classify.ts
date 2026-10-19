// Error classification for the isolated coding-agent implementation eval (agent-run.ts).
//
// Pure logic, no I/O: the outcome of a scenario×tool run is derived from the
// thrown error (final-catch path) or from run observations (in-try path) plus
// the pipeline stage that was active when the failure surfaced.
//
// The shared classifier exists so the rules below stay consistent between the
// live eval script and the isolated unit tests:
//
//   bun test eval/ax-live/agent-run-classify.test.ts
//
// Classification policy (see eval/ax-live/README.md for the rationale):
// - PASS: every functional assertion passed (decided by the caller, not here).
// - FAIL: implementation or functional-verification failure, including
//   WorkLens API HTTP errors (the WorkLens server itself is the system under
//   validation) and evaluator-internal errors (kept as outcome FAIL but
//   distinguished via causeCode "evaluator-error", never mixed with BLOCKED).
// - BLOCKED: only with real evidence — expired/missing CLI auth (auth log
//   patterns), unreachable network (network log patterns or a fetch-level
//   failure), or a missing CLI binary.
// - NOT_RUN: verification never started (initial state).

export type Outcome = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";

export type FailureStage =
  | "diagnosis-request"   // WorkLens diagnosis request (/api/ai ax-diagnosis)
  | "plan-generation"     // implementation plan generation (/api/ai ax-plan)
  | "prompt-generation"   // all-in-one instruction prompt generation
  | "agent-env-prep"      // agent workspace setup + CLI availability check
  | "agent-auth-network"  // CLI authentication / network connectivity layer
  | "agent-exec"          // coding agent execution (timeout, exit code, fixtures)
  | "functional-test"     // functional verification of the generated implementation
  | "result-recording";   // result files and report generation

export type CauseCode =
  | "worklens-api-error"      // WorkLens API HTTP error / request timeout
  | "schema-validation-error" // zod schema parse failure
  | "agent-exec-failed"       // agent exited non-zero without auth/network evidence
  | "agent-timeout"           // agent execution exceeded its time budget
  | "functional-check-failed" // functional checks ran but did not all pass
  | "fixture-modified"        // agent modified the evaluator-provided fixtures
  | "evaluator-error"         // evaluator-internal error (distinct from implementation failure)
  | "auth-expired"            // CLI auth expired/missing, proven by log patterns
  | "network-blocked"         // network unreachable, proven by log patterns or fetch failure
  | "cli-missing";            // CLI executable not installed

export interface ClassifyInput {
  /** Pipeline stage that was active when the failure surfaced. */
  stage: FailureStage;
  /**
   * Thrown error (final-catch path). Leave absent when the outcome was
   * determined from run observations (in-try path).
   */
  error?: unknown;
  /** `Bun.which(tool)` returned null. */
  cliMissing?: boolean;
  /** Auth-failure patterns matched in agent stdout/stderr. */
  authBlockedLog?: boolean;
  /** Network-failure patterns matched in agent stdout/stderr. */
  networkBlockedLog?: boolean;
  /** Agent process exit code (null = killed / unknown). */
  exitCode?: number | null;
  /** Agent execution hit its time budget and was killed. */
  agentTimedOut?: boolean;
  /** Agent modified the evaluator-provided fixture files. */
  fixtureModified?: boolean;
  /** Functional checks ran but did not all pass (or produced no checks). */
  functionalFailed?: boolean;
}

export interface Classification {
  outcome: Outcome;
  /** Absent when there is no failure to report (caller decides PASS). */
  causeCode?: CauseCode;
  failureStage: FailureStage;
}

/** Log evidence that the CLI could not authenticate (expired/missing login). */
export const AUTH_BLOCKED_RE =
  /token_expired|refresh token was already used|OAuth session expired|Not logged in|Please log out and sign in again|401 Unauthorized/iu;

/** Log evidence that the CLI could not reach the network. */
export const NETWORK_BLOCKED_RE =
  /failed to refresh available models|Transport channel closed|http\/request failed|workspace routing discovery failed|Reconnecting\.\.\.|request timed out|error sending request for url|Unable to connect to API|EPROTO|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/iu;

/** WorkLens API request failures: HTTP responses and request timeouts. */
export function isWorklensApiError(e: unknown): boolean {
  if (!e || (typeof e !== "object" && typeof e !== "string")) return false;
  const name = (e as { name?: unknown }).name;
  if (name === "TimeoutError" || name === "AbortError") return true; // AbortSignal.timeout on request()
  return errorText(e).includes("WorkLens API HTTP");
}

/** Fetch-level failures: the request never got an HTTP response (refused/DNS). */
const FETCH_NETWORK_RE =
  /fetch failed|Failed to fetch|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|network unreachable|connection refused|socket hang up|getaddrinfo|DNS/i;
export function isFetchNetworkError(e: unknown): boolean {
  if (!e || (typeof e !== "object" && typeof e !== "string")) return false;
  return FETCH_NETWORK_RE.test(errorText(e));
}

/** zod (or zod-shaped) schema validation failures. */
export function isSchemaValidationError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const o = e as { name?: unknown; issues?: unknown };
  return o.name === "ZodError" || Array.isArray(o.issues);
}

function errorText(e: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && !seen.has(cur) && parts.length < 5) {
    seen.add(cur);
    parts.push(String(cur));
    cur = (cur as { cause?: unknown })?.cause;
  }
  return parts.join("\n");
}

/**
 * Classifies a scenario×tool failure into { outcome, causeCode, failureStage }.
 *
 * Thrown-error path (input.error set): WorkLens API HTTP/timeout errors are
 * FAIL (the server is part of the validated pipeline); fetch-level network
 * failures are BLOCKED only with real connection evidence; zod failures are
 * FAIL + schema-validation-error; everything else is FAIL + evaluator-error.
 *
 * Observation path (no error): mirrors the in-try decision order of
 * agent-run.ts — fixture modification outranks auth/network evidence, which
 * outranks timeout, which outranks a plain non-zero exit, which outranks
 * functional-check failures. Auth/network BLOCKED requires the log evidence
 * flags; a bare non-zero exit is never BLOCKED.
 */
export function classifyError(input: ClassifyInput): Classification {
  const { stage } = input;
  const fail = (causeCode: CauseCode): Classification => ({ outcome: "FAIL", causeCode, failureStage: stage });
  const blocked = (causeCode: CauseCode): Classification => ({ outcome: "BLOCKED", causeCode, failureStage: stage });

  if (input.error !== undefined) {
    const e = input.error;
    if (isWorklensApiError(e)) return fail("worklens-api-error");
    if (isFetchNetworkError(e)) return blocked("network-blocked");
    if (isSchemaValidationError(e)) return fail("schema-validation-error");
    if (input.cliMissing) return blocked("cli-missing");
    return fail("evaluator-error");
  }

  if (input.cliMissing) return blocked("cli-missing");
  if (input.fixtureModified) return fail("fixture-modified");
  if (input.authBlockedLog && input.exitCode !== 0) return blocked("auth-expired");
  if (input.networkBlockedLog && input.exitCode !== 0) return blocked("network-blocked");
  if (input.agentTimedOut) return fail("agent-timeout");
  if (input.exitCode !== 0) return fail("agent-exec-failed");
  if (input.functionalFailed) return fail("functional-check-failed");
  return { outcome: "NOT_RUN", failureStage: stage };
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED]"], // OpenAI / Anthropic style keys (covers sk-ant-…)
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[REDACTED]"], // GitHub tokens
  [/\bxox[abpras]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"], // Slack tokens
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"], // AWS access key id
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]"], // Google API key
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [REDACTED]"],
  // key=value / key: value style secrets ("api_key=…", `"password": "…"`)
  [/((?:api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|secret|passwd|password)\s*[:=]\s*["']?)([^\s"'`;,}]{8,})/gi, "$1[REDACTED]"],
];

/**
 * Masks API-key/token-like values in log text before it is written to disk.
 * Detection patterns used for classification (e.g. "token_expired",
 * "refresh token was already used") contain no key=value shape and survive
 * redaction — but classify on the raw text first anyway.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}
