import { z } from "zod";

// Shared limits apply at AI, browser storage and transfer boundaries.
z.config({ jitless: true });
export const AX_LIMITS = { tasks: 100, name: 120, description: 3000, detail: 500, attachmentSummary: 2000, requestBytes: 60 * 1024, transferBytes: 8 * 1024 * 1024 } as const;
export const FACTOR_KEYS = ["repetition", "regularity", "dataStructure", "systemAccess", "humanJudgment", "operationalRisk"] as const;
export const FACTOR_LABELS: Record<typeof FACTOR_KEYS[number], string> = {
  repetition: "반복성", regularity: "규칙성", dataStructure: "데이터 구조화", systemAccess: "시스템 접근성", humanJudgment: "담당자 판단 의존도", operationalRisk: "운영 위험",
};
const text = z.string().trim().max(500);
const list = z.array(text).max(10);
const rating = z.number().int().min(1).max(5);
const owner = z.enum(["시스템", "AI", "사용자"]);
export const axDetailsSchema = z.object({
  cycle: text.optional(), minutesPerRun: z.number().finite().min(0).max(100000).optional(),
  runsPerMonth: z.number().finite().min(0).max(100000).optional(), people: z.number().int().min(1).max(100000).optional(),
  systems: text.optional(), inputs: text.optional(), outputs: text.optional(), humanSteps: text.optional(), painPoints: text.optional(), goal: text.optional(),
}).strict();
const factorSchema = z.object({ key: z.enum(FACTOR_KEYS), aiValue: rating, rationale: text });
export const axDiagnosisShape = {
  informationSufficiency: z.enum(["sufficient", "partial", "needs-check"]),
  followUpQuestions: z.array(text.min(1)).max(3),
  asIs: z.object({ purpose: text, trigger: text, inputs: list, steps: list, outputs: list, exceptions: list, humanDecisions: list, systems: list }).strict(),
  factors: z.array(factorSchema.strict()).length(6),
  stepAssessments: z.array(z.object({ step: text, verdict: z.enum(["자동화", "AI 보조", "사람 유지"]), owner, note: text }).strict()).max(10),
  toBe: z.array(z.object({ step: text, owner, description: text }).strict()).max(10),
  humanInLoop: list,
  technicalChecks: z.array(z.object({ topic: text, status: z.enum(["확인됨", "확인 필요", "불가"]), note: text }).strict()).max(10),
  risks: list,
  poc: z.object({ hypothesis: text, inScope: list, outOfScope: list, inputs: list, outputs: list, evaluation: list, success: list, failure: list }).strict(),
  decisionGate: z.object({ verdict: z.enum(["go", "conditional", "no-go"]), reasons: list }).strict(),
  roadmap: z.array(z.object({ phase: text, title: text, items: list }).strict()).max(5),
  operation: z.object({ owner: text, failureOwner: text, maintenanceBurden: z.enum(["low", "medium", "high"]), fallback: text, notes: list }).strict(),
  nextAction: z.object({ label: text.min(1), detail: text }).strict(),
};
export const axDiagnosisJsonSchema = z.object(axDiagnosisShape).strict();
const uniqueFactors = (value: { factors: { key: string }[] }) => new Set(value.factors.map(f => f.key)).size === 6;
export const axDiagnosisOutputSchema = axDiagnosisJsonSchema.refine(uniqueFactors, "6종 Factor가 각각 필요합니다.");
export const REPOSITORY_FIRST = "Repository-first: 실제 저장소의 지침·구조·구현·테스트를 먼저 확인하고, 확인되지 않은 파일명·함수명·API를 추측하지 않는다.";
export const axPlanJsonSchema = z.object({
  repositoryFirst: text.min(1), goal: list, asIs: list, toBe: list, inScope: list, outOfScope: list, prerequisites: list,
  humanInLoop: list, poc: list, implementation: list, dataFlow: list, integrations: list, exceptions: list, fallback: list,
  security: list, operation: list, tests: list, acceptance: list,
}).strict();
export const axPlanSchema = axPlanJsonSchema.extend({ repositoryFirst: z.literal(REPOSITORY_FIRST) });
export const axConfirmedDiagnosisSchema = z.object({
  ...axDiagnosisShape, factors: z.array(factorSchema.extend({ finalValue: rating.optional() }).strict()).length(6),
}).strict().refine(uniqueFactors, "6종 Factor가 각각 필요합니다.");
export const axDiagnosisSchema = z.object({
  ...axConfirmedDiagnosisSchema.shape,
  sourceNote: text, planCodex: axPlanSchema.optional(), planClaude: axPlanSchema.optional(),
}).strict().refine(uniqueFactors, "6종 Factor가 각각 필요합니다.");
export const axTaskSchema = z.object({
  ...axDetailsSchema.shape, id: z.string().min(1).max(120), name: z.string().trim().min(1).max(AX_LIMITS.name),
  description: z.string().trim().min(1).max(AX_LIMITS.description),
  status: z.enum(["registered", "needs-info", "diagnosed", "adjusted"]),
  attachmentMeta: z.object({ name: z.string().min(1).max(255), type: z.string().max(120), size: z.number().int().min(0), lastModified: z.number().int().min(0), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().optional(),
  diagnosis: axDiagnosisSchema.optional(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict().superRefine((task, ctx) => {
  const expected = !task.diagnosis ? "registered" : task.diagnosis.factors.some(f => f.finalValue !== undefined) ? "adjusted" : task.diagnosis.informationSufficiency === "needs-check" ? "needs-info" : "diagnosed";
  if (task.status !== expected) ctx.addIssue({ code: "custom", message: "업무 상태와 진단이 일치하지 않습니다." });
});
export const axStateSchema = z.object({
  schemaVersion: z.literal(1), tasks: z.array(axTaskSchema).max(AX_LIMITS.tasks), selectedTaskId: z.string().max(120).nullable(), step: z.number().int().min(1).max(4),
}).strict().superRefine((state, ctx) => {
  if (new Set(state.tasks.map(t => t.id)).size !== state.tasks.length || (state.selectedTaskId !== null && !state.tasks.some(t => t.id === state.selectedTaskId))) ctx.addIssue({ code: "custom", message: "업무 식별자가 일치하지 않습니다." });
});
export const axDiagnosisRequestSchema = z.object({
  kind: z.literal("ax-diagnosis"), name: axTaskSchema.shape.name, description: axTaskSchema.shape.description,
  details: axDetailsSchema, attachmentSummary: z.string().trim().min(1).max(AX_LIMITS.attachmentSummary).optional(),
}).strict();
export const axPlanRequestSchema = z.object({
  kind: z.literal("ax-plan"), target: z.enum(["codex", "claude"]),
  task: z.object({ name: axTaskSchema.shape.name, description: axTaskSchema.shape.description, details: axDetailsSchema }).strict(),
  diagnosis: axConfirmedDiagnosisSchema,
}).strict();

/** Only confirmed diagnosis fields cross the plan boundary; no stored plans or source text. */
export function confirmedAxDiagnosis(value: z.infer<typeof axDiagnosisSchema>) {
  return axConfirmedDiagnosisSchema.parse(Object.fromEntries(Object.keys(axDiagnosisShape).map(key => [key, value[key as keyof typeof axDiagnosisShape]])));
}
