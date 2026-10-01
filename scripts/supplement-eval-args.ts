/**
 * Command line of scripts/supplement-eval.ts. Every option is declared here;
 * anything else — a typo, an option from an older version — stops the run
 * before a single call is made, so a misspelled flag can never silently
 * evaluate a different set or skip a guard.
 */
export const EVAL_SETS = ["fixed", "realistic", "development", "holdout"] as const;
export type EvalSetName = (typeof EVAL_SETS)[number];

export interface EvalArgs {
  set: EvalSetName;
  repeat: number;
  model: string;
  /** Deployed WorkLens origin whose /api/ai makes the call; empty means Groq directly. */
  endpoint: string;
  /** Wall-clock seconds for the whole run; past it, remaining cases are not run. */
  budgetSeconds: number;
  offline: boolean;
  saveBaseline: boolean;
  /** Print the plan and exit without running anything. */
  planOnly: boolean;
  /** Allow the production GROQ_API_KEY when no GROQ_EVAL_API_KEY is set; both draw on one daily token quota. */
  sharedKey: boolean;
}

const VALUE_OPTIONS = ["set", "repeat", "model", "endpoint", "budget"] as const;
const FLAG_OPTIONS = ["offline", "save-baseline", "plan", "shared-key"] as const;

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const values: Partial<Record<(typeof VALUE_OPTIONS)[number], string>> = {};
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--")) throw new Error(`알 수 없는 인자: ${raw}`);
    const name = raw.slice(2);
    if ((FLAG_OPTIONS as readonly string[]).includes(name)) { flags.add(name); continue; }
    if (!(VALUE_OPTIONS as readonly string[]).includes(name)) {
      throw new Error(`지원하지 않는 옵션: ${raw} (사용 가능: ${[...VALUE_OPTIONS, ...FLAG_OPTIONS].map((option) => `--${option}`).join(", ")})`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${raw}에 값이 필요합니다.`);
    values[name as (typeof VALUE_OPTIONS)[number]] = value;
    index += 1;
  }
  const set = (values.set ?? "fixed") as EvalSetName;
  if (!EVAL_SETS.includes(set)) throw new Error(`--set은 ${EVAL_SETS.join(", ")} 중 하나입니다.`);
  const repeat = Number(values.repeat ?? "1");
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) throw new Error("--repeat는 1~5 사이 정수입니다.");
  const budgetSeconds = Number(values.budget ?? "1200");
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) throw new Error("--budget은 양수(초)입니다.");
  if (flags.has("offline") && values.endpoint) throw new Error("--offline과 --endpoint는 함께 쓸 수 없습니다.");
  if (flags.has("save-baseline") && set !== "fixed") throw new Error("--save-baseline은 --set fixed에서만 쓸 수 있습니다.");
  return {
    set,
    repeat,
    model: values.model ?? "openai/gpt-oss-120b",
    endpoint: (values.endpoint ?? "").replace(/\/+$/u, ""),
    budgetSeconds,
    offline: flags.has("offline"),
    saveBaseline: flags.has("save-baseline"),
    planOnly: flags.has("plan"),
    sharedKey: flags.has("shared-key"),
  };
}
