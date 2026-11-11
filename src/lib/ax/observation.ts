import type { z } from "zod";
import type { axDiagnosisOutputSchema } from "./schema";
import type { AxDiagnosisRequest } from "./types";

/**
 * Read-only measurement helpers for AX diagnosis logs. Nothing here changes a diagnosis, a verdict
 * or a retry: every function returns counts, schema paths or fixed labels only — never task text,
 * provider content or the numeric values themselves.
 */
type AxDiagnosisOutput = z.infer<typeof axDiagnosisOutputSchema>;

/** A json_validate_failed whose error body reports this share of the completion budget is "truncated". */
export const JVF_TRUNCATION_RATIO = 0.95;
export type JvfClass = "truncated" | "format" | "unclassified";

/** Without the provider's completion token count the cause stays unclassified; it is never guessed. */
export function classifyJsonValidateFailure(completionTokens: number | undefined, maxCompletionTokens: number): { jvf: JvfClass; completionRatio?: number } {
  if (completionTokens === undefined || !Number.isFinite(completionTokens) || maxCompletionTokens <= 0) return { jvf: "unclassified" };
  const ratio = completionTokens / maxCompletionTokens;
  return { jvf: ratio >= JVF_TRUNCATION_RATIO ? "truncated" : "format", completionRatio: Math.round(ratio * 100) / 100 };
}

export interface ProviderErrorBodySignals { completionTokens?: number; failedGenerationChars?: number; failedGenerationParses?: boolean }

/**
 * Size signals of a provider error body. The rejected generation itself is never kept: only its length and
 * whether it was complete JSON, which separates a cut-off answer from a complete answer the schema refused.
 */
export function providerErrorBodySignals(payload: unknown): ProviderErrorBodySignals {
  if (!payload || typeof payload !== "object") return {};
  const signals: ProviderErrorBodySignals = {};
  const usage = (payload as { usage?: unknown }).usage;
  const completionTokens = usage && typeof usage === "object" ? (usage as { completion_tokens?: unknown }).completion_tokens : undefined;
  if (typeof completionTokens === "number" && Number.isFinite(completionTokens)) signals.completionTokens = completionTokens;
  const error = (payload as { error?: unknown }).error;
  const generation = error && typeof error === "object" ? (error as { failed_generation?: unknown }).failed_generation : undefined;
  if (typeof generation === "string") {
    signals.failedGenerationChars = generation.length;
    try { JSON.parse(generation); signals.failedGenerationParses = true; } catch { signals.failedGenerationParses = false; }
  }
  return signals;
}

/** Observation must never change an outcome: a measurement that throws is recorded as absent. */
export function observed<T>(measure: () => T): T | undefined {
  try { return measure(); } catch { return undefined; }
}

const MAX_LOGGED_ISSUES = 20;
/** Schema keys are ASCII identifiers; anything else in a path is replaced so generated text cannot reach a log. */
const SCHEMA_KEY = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

/** `path:code` per issue (e.g. `poc.success.2:too_big`). Messages, received values and unknown key names are dropped. */
export function zodIssueSummary(error: unknown): { zodIssues: string; zodIssueCount: number } | undefined {
  if (!error || typeof error !== "object" || !("issues" in error) || !Array.isArray(error.issues)) return undefined;
  const entries = (error.issues as unknown[]).map(issue => {
    const record = issue && typeof issue === "object" ? issue as { path?: unknown; code?: unknown } : {};
    const path = Array.isArray(record.path)
      ? record.path.map(part => typeof part === "number" ? String(part) : typeof part === "string" && SCHEMA_KEY.test(part) ? part : "?").join(".")
      : "";
    const code = typeof record.code === "string" && /^[a-z_]{1,40}$/.test(record.code) ? record.code : "unknown";
    return `${path || "(root)"}:${code}`;
  });
  return { zodIssues: entries.slice(0, MAX_LOGGED_ISSUES).join(","), zodIssueCount: entries.length };
}

// Longer units come first so "개월" is not read as "개" and "만원" not as "원".
const USER_NUMBER = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(퍼센트|개월|시간|만원|천원|억원|%|배|분(?!기)|초|회|번|명|인|건|개|일|주|달|년|원)/g;
const UNIT_ALIAS: Record<string, string> = { 퍼센트: "%", 번: "회", 인: "명", 달: "개월" };
const numberToken = (value: number, unit: string) => `${value}|${UNIT_ALIAS[unit] ?? unit}`;

/** Number+unit tokens of a text, e.g. "월 1,000건" → `1000|건`. */
export function userNumberTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.matchAll(USER_NUMBER)) tokens.add(numberToken(Number(`${match[1].replace(/,/g, "")}${match[2] ?? ""}`), match[3]));
  return tokens;
}

export const USER_NUMBER_GROUPS = ["runs", "cycle", "minutes", "goal", "other"] as const;
export type UserNumberGroup = typeof USER_NUMBER_GROUPS[number];

/** One user-supplied number. `accepted` lists the equivalent tokens that count as the same value in an output. */
export interface UserNumber { group: UserNumberGroup; accepted: string[] }

/**
 * User number set U (C-0). A value stated in several places is one element, owned by the first group in
 * this order: runs (details.runsPerMonth), minutes (details.minutesPerRun), cycle (details.cycle tokens),
 * goal (details.goal tokens), other (details.people, details.painPoints tokens, description tokens).
 */
export function userNumbers(request: AxDiagnosisRequest): UserNumber[] {
  const { details } = request;
  const seen = new Set<string>();
  const numbers: UserNumber[] = [];
  const add = (group: UserNumberGroup, accepted: string[]) => {
    const fresh = accepted.filter(token => !seen.has(token));
    if (fresh.length !== accepted.length) return;
    fresh.forEach(token => seen.add(token));
    numbers.push({ group, accepted });
  };
  // A count of runs is written as 회 or 건; whole or fractional hours are the same duration as the minutes.
  if (details.runsPerMonth !== undefined) add("runs", [numberToken(details.runsPerMonth, "회"), numberToken(details.runsPerMonth, "건")]);
  if (details.minutesPerRun !== undefined) add("minutes", [numberToken(details.minutesPerRun, "분"),
    ...(details.minutesPerRun >= 60 && Number.isInteger(details.minutesPerRun / 30) ? [numberToken(details.minutesPerRun / 60, "시간")] : [])]);
  for (const token of userNumberTokens(details.cycle ?? "")) add("cycle", [token]);
  for (const token of userNumberTokens(details.goal ?? "")) add("goal", [token]);
  if (details.people !== undefined) add("other", [numberToken(details.people, "명")]);
  for (const token of userNumberTokens(`${details.painPoints ?? ""}\n${request.description}`)) add("other", [token]);
  return numbers;
}

export interface UserNumberRetention {
  /** |U|: every distinct user number. */
  uTotal: number;
  /** Elements of U that have a designated output position (runs, cycle, minutes, goal). */
  uPositioned?: number;
  /** Positioned elements found at their designated position. */
  uRetainedPositioned?: number;
  /** Elements of U found in any model-written narrative field (AS-IS excluded: the server quotes it from the input). */
  uRetainedAnywhere?: number;
  /** `group:retainedAtPosition/total` for positioned groups, `other:retainedAnywhere/total` for the rest. */
  uGroups?: string;
}

/**
 * User number retention (C-0). Designated positions:
 * - runs, cycle → the repetition factor's rationale
 * - minutes     → one item of poc.evaluation or poc.inputs
 * - goal        → one item of poc.success that also says "사용자 목표"
 * `other` has no designated position and is only counted under "anywhere".
 * Primary rate = uRetainedPositioned / uPositioned. The result carries counts only.
 */
export function userNumberRetention(diagnosis: AxDiagnosisOutput, numbers: UserNumber[]): UserNumberRetention {
  if (!numbers.length) return { uTotal: 0 };
  const tokensOf = (texts: string[]) => userNumberTokens(texts.join("\n"));
  const positions: Record<Exclude<UserNumberGroup, "other">, Set<string>> = {
    runs: tokensOf(diagnosis.factors.filter(factor => factor.key === "repetition").map(factor => factor.rationale)),
    cycle: new Set(),
    minutes: tokensOf([...diagnosis.poc.evaluation, ...diagnosis.poc.inputs]),
    goal: tokensOf(diagnosis.poc.success.filter(item => item.includes("사용자 목표"))),
  };
  positions.cycle = positions.runs;
  const anywhere = tokensOf([
    ...diagnosis.followUpQuestions, ...diagnosis.factors.map(factor => factor.rationale),
    ...diagnosis.stepAssessments.flatMap(step => [step.step, step.note]), ...diagnosis.toBe.flatMap(step => [step.step, step.description]),
    ...diagnosis.humanInLoop, ...diagnosis.technicalChecks.flatMap(check => [check.topic, check.note]), ...diagnosis.risks,
    diagnosis.poc.hypothesis, ...diagnosis.poc.inScope, ...diagnosis.poc.outOfScope, ...diagnosis.poc.inputs, ...diagnosis.poc.outputs,
    ...diagnosis.poc.evaluation, ...diagnosis.poc.success, ...diagnosis.poc.failure, ...diagnosis.decisionGate.reasons,
    ...diagnosis.roadmap.flatMap(phase => [phase.phase, phase.title, ...phase.items]),
    diagnosis.operation.owner, diagnosis.operation.failureOwner, diagnosis.operation.fallback, ...diagnosis.operation.notes,
    diagnosis.nextAction.label, diagnosis.nextAction.detail,
  ]);
  const found = (number: UserNumber, tokens: Set<string>) => number.accepted.some(token => tokens.has(token));
  const groups = new Map<UserNumberGroup, { retained: number; total: number }>();
  let positioned = 0, retainedPositioned = 0, retainedAnywhere = 0;
  for (const number of numbers) {
    const group = groups.get(number.group) ?? { retained: 0, total: 0 };
    groups.set(number.group, group);
    group.total += 1;
    const any = found(number, anywhere);
    if (any) retainedAnywhere += 1;
    if (number.group === "other") {
      if (any) group.retained += 1;
      continue;
    }
    positioned += 1;
    if (found(number, positions[number.group])) { retainedPositioned += 1; group.retained += 1; }
  }
  return {
    uTotal: numbers.length, uPositioned: positioned, uRetainedPositioned: retainedPositioned, uRetainedAnywhere: retainedAnywhere,
    uGroups: USER_NUMBER_GROUPS.filter(name => groups.has(name)).map(name => `${name}:${groups.get(name)!.retained}/${groups.get(name)!.total}`).join(","),
  };
}

/**
 * Official user number metrics (stage 3 PR-2). The PR-1 counters above keep their meaning; these are added.
 * - Primary   — positioned reflection rate = uPositionedOk / uPositioned.
 * - Auxiliary — overall preservation rate  = uPreserved / uTotal.
 * - Auxiliary — evaluated share            = uPositioned / uTotal.
 * Both denominators come from the request alone (`userNumberTargets`), before any answer exists, so a failed
 * or number-free answer can only lower a numerator. A zero denominator is "not applicable", never 0% or 100%.
 */
export type UserNumberNa = "no-user-numbers" | "no-positioned-numbers" | "measurement-error";

/** Evaluation targets fixed from the request. `numbers` is undefined when U itself could not be measured. */
export function userNumberTargets(numbers: UserNumber[] | undefined): { uTotal?: number; uPositioned?: number; uNa?: UserNumberNa } {
  if (!numbers) return { uNa: "measurement-error" };
  const uPositioned = numbers.filter(number => number.group !== "other").length;
  const uNa: UserNumberNa | undefined = !numbers.length ? "no-user-numbers" : !uPositioned ? "no-positioned-numbers" : undefined;
  return { uTotal: numbers.length, uPositioned, ...(uNa ? { uNa } : {}) };
}

/** Why a positioned number was not reflected. One category per number: the first that applies in this order. */
export const USER_NUMBER_FAILURES = ["context", "unit", "elsewhere", "absent"] as const;
export type UserNumberFailure = typeof USER_NUMBER_FAILURES[number];

export interface UserNumberMetric {
  /** Positioned numbers written at their designated position with the same unit, in a text the Semantic Guard accepts. */
  uPositionedOk: number;
  /** Numbers of U written with the same unit in any model-written narrative text the Semantic Guard accepts. */
  uPreserved: number;
  /** `category:count` of positioned numbers that were not reflected; absent when every one was. */
  uFailures?: string;
}

/**
 * Judges one answer against the targets. `fields` are the answer's narrative texts by field path and
 * `violatedFields` the paths the Semantic Guard refused (both from semantic.ts, so meaning is judged by the
 * existing contract). A number counts only as number+unit; the AS-IS is server-quoted and never counts.
 * - context:   at the position, but in a refused text (e.g. restated as a prediction) or, for a goal, without "사용자 목표"
 * - unit:      the same figure stands at the position with a different unit
 * - elsewhere: preserved in another field only, which is not a success of the primary metric
 * - absent:    preserved nowhere
 */
export function userNumberMetric(diagnosis: AxDiagnosisOutput, numbers: UserNumber[], fields: [string, string][], violatedFields: ReadonlySet<string>): UserNumberMetric {
  const repetition = new Set(diagnosis.factors.flatMap((factor, index) => factor.key === "repetition" ? [`factors[${index}].rationale`] : []));
  const atPosition = (group: UserNumberGroup, path: string) => group === "runs" || group === "cycle" ? repetition.has(path)
    : group === "minutes" ? /^poc\.(?:evaluation|inputs)\[\d+\]$/.test(path) : group === "goal" ? /^poc\.success\[\d+\]$/.test(path) : false;
  const texts = fields.filter(([path]) => !path.startsWith("asIs.")).map(([path, text]) => ({ path, text, tokens: userNumberTokens(text), accepted: !violatedFields.has(path) }));
  const failures = new Map<UserNumberFailure, number>();
  let uPositionedOk = 0, uPreserved = 0;
  for (const number of numbers) {
    const holding = texts.filter(entry => number.accepted.some(token => entry.tokens.has(token)));
    const preserved = holding.some(entry => entry.accepted);
    if (preserved) uPreserved += 1;
    if (number.group === "other") continue;
    const placed = holding.filter(entry => atPosition(number.group, entry.path));
    if (placed.some(entry => entry.accepted && (number.group !== "goal" || entry.text.includes("사용자 목표")))) { uPositionedOk += 1; continue; }
    const figures = number.accepted.map(token => `${token.split("|")[0]}|`);
    const otherUnit = texts.some(entry => atPosition(number.group, entry.path) && [...entry.tokens].some(token => figures.some(figure => token.startsWith(figure))));
    const failure: UserNumberFailure = placed.length ? "context" : otherUnit ? "unit" : preserved ? "elsewhere" : "absent";
    failures.set(failure, (failures.get(failure) ?? 0) + 1);
  }
  const uFailures = USER_NUMBER_FAILURES.filter(name => failures.has(name)).map(name => `${name}:${failures.get(name)}`).join(",");
  return { uPositionedOk, uPreserved, ...(uFailures ? { uFailures } : {}) };
}

/** Per-request counts: targets from the request, numerators from its final answer (absent when none was returned). */
export interface UserNumberRequestCounts { uTotal: number; uPositioned: number; uPositionedOk?: number; uPreserved?: number }

/**
 * Sums requests and derives the three rates in percent (one decimal). A request without a returned answer
 * keeps its denominators and adds nothing to the numerators. `null` is N/A (zero denominator).
 */
export function userNumberRates(requests: UserNumberRequestCounts[]) {
  const sum = (pick: (request: UserNumberRequestCounts) => number | undefined) => requests.reduce((total, request) => total + (pick(request) ?? 0), 0);
  const uTotal = sum(request => request.uTotal), uPositioned = sum(request => request.uPositioned);
  const uPositionedOk = sum(request => request.uPositionedOk), uPreserved = sum(request => request.uPreserved);
  const percent = (numerator: number, denominator: number) => denominator > 0 ? Math.round(numerator / denominator * 1000) / 10 : null;
  return { uTotal, uPositioned, uPositionedOk, uPreserved,
    positionedReflectionRate: percent(uPositionedOk, uPositioned), preservationRate: percent(uPreserved, uTotal), evaluatedShare: percent(uPositioned, uTotal) };
}
