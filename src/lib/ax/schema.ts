import { z } from "zod";

// Shared limits apply at AI, browser storage and transfer boundaries.
z.config({ jitless: true });
export const AX_LIMITS = { tasks: 100, name: 120, description: 3000, detail: 500, attachmentSummary: 2000, attachments: 10, requestBytes: 60 * 1024, transferBytes: 8 * 1024 * 1024 } as const;
export const FACTOR_KEYS = ["repetition", "regularity", "dataStructure", "systemAccess", "humanJudgment", "operationalRisk"] as const;
export const FACTOR_LABELS: Record<typeof FACTOR_KEYS[number], string> = {
  repetition: "반복성", regularity: "규칙성", dataStructure: "데이터 구조화", systemAccess: "시스템 접근성", humanJudgment: "담당자 판단 필요도", operationalRisk: "운영 위험",
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
/** 고정 결정 지점 D1~D7 (1차 MVP 개선): 진단 스키마의 optional 필드로 저장한다.
 * required로 두면 구버전 저장 데이터가 strict 검증에 실패해 저장 자체가 중단되므로 금지한다.
 * 상태 기본값은 "미확정"이며, "확정"/"해당 없음"은 사용자가 직접 선택·입력한 경우에만 저장한다.
 * AI가 채운 값은 진단 수신 시 제거하고 UI 저장 경로로만 들어간다 (AxDiagnosisView diagnose 참조). */
export const DECISION_POINT_IDS = ["D1", "D2", "D3", "D4", "D5", "D6", "D7"] as const;
export const DECISION_POINT_STATUSES = ["확정", "해당 없음", "미확정"] as const;
export const decisionPointSchema = z.object({
  id: z.enum(DECISION_POINT_IDS),
  status: z.enum(DECISION_POINT_STATUSES),
  /** 확정 내용. D4는 결과 상태 목록(쉼표·점 구분), D5는 판정 불가 행을 보낼 상태명이다. */
  detail: z.string().trim().max(2000).optional(),
}).strict();
/** HITL 예시 결과 1건: 입력 값 + 기대 결과(D4 상태 중 하나) + 선택 메모.
 * supplement(자유 텍스트 보완)와 필드명을 구분한다. 상한은 레코드 폭증 방지용이다
 * (항목 20건, 입력 2000자, 기대 상태 100자, 기대 값 500자, 메모 1000자).
 * 초안은 컴포넌트 상태에만 두고, 사용자가 확정한 값만 이 필드로 저장한다. */
export const exampleResultSchema = z.object({
  input: z.string().trim().min(1).max(2000),
  expectedState: z.string().trim().min(1).max(100),
  expectedValue: z.string().trim().max(500).optional(),
  memo: z.string().trim().max(1000).optional(),
}).strict();
export const axDiagnosisShape = {
  informationSufficiency: z.enum(["sufficient", "partial", "needs-check"]),
  followUpQuestions: z.array(text.min(1)).max(3),
  asIs: z.object({ purpose: text, trigger: text, inputs: list, steps: list, outputs: list, exceptions: list, humanDecisions: list, systems: list }).strict(),
  factors: z.array(factorSchema.strict()).length(6),
  stepAssessments: z.array(z.object({ step: text, verdict: z.enum(["자동화", "AI 보조", "사람 유지"]), owner, note: text }).strict()).max(10),
  toBe: z.array(z.object({ step: text, owner, description: text }).strict()).max(10),
  humanInLoop: list,
  technicalChecks: z.array(z.object({ topic: text, status: z.enum(["확인됨", "확인 필요", "불가"]), note: text, required: z.boolean().optional() }).strict()).max(10),
  risks: list,
  poc: z.object({ hypothesis: text, inScope: list, outOfScope: list, inputs: list, outputs: list, evaluation: list, success: list, failure: list }).strict(),
  decisionGate: z.object({ verdict: z.enum(["go", "conditional", "no-go"]), reasons: list }).strict(),
  decisionPoints: z.array(decisionPointSchema).max(7).optional(),
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
export const axAttachmentMetaSchema = z.object({ name: z.string().min(1).max(255), type: z.string().max(120), size: z.number().int().min(0), lastModified: z.number().int().min(0), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export const axTaskSchema = z.object({
  ...axDetailsSchema.shape, id: z.string().min(1).max(120), name: z.string().trim().min(1).max(AX_LIMITS.name),
  description: z.string().trim().min(1).max(AX_LIMITS.description),
  status: z.enum(["registered", "needs-info", "diagnosed", "adjusted"]),
  // attachmentMeta: 단일 첨부 시절의 대표 메타데이터 (기존 데이터·내보내기 호환용으로 유지)
  attachmentMeta: axAttachmentMetaSchema.optional(),
  // attachmentMetas: 다중 첨부 전체 목록. 읽을 때는 taskAttachments() 정규화를 거친다.
  attachmentMetas: z.array(axAttachmentMetaSchema).min(1).max(AX_LIMITS.attachments).optional(),
  diagnosis: axDiagnosisSchema.optional(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict().superRefine((task, ctx) => {
  const expected = !task.diagnosis ? "registered" : task.diagnosis.factors.some(f => f.finalValue !== undefined && f.finalValue !== f.aiValue) ? "adjusted" : task.diagnosis.informationSufficiency === "needs-check" ? "needs-info" : "diagnosed";
  const legacyAdjustment = task.status === "adjusted" && expected !== "adjusted" && task.diagnosis
    && task.diagnosis.factors.some(f => f.finalValue !== undefined && f.finalValue === f.aiValue);
  if (task.status !== expected && !legacyAdjustment) ctx.addIssue({ code: "custom", message: "업무 상태와 진단이 일치하지 않습니다." });
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

// HITL (Human-in-the-loop) review schema
// AI 진단 원본과 사람 검토 데이터를 분리하여 저장
export const HITL_TARGET_TYPES = ["step", "planItem", "criterion", "risk"] as const;
export const HITL_ACTIONS = ["keep", "defer", "exclude", "supplement"] as const;
export const HITL_STATUSES = ["pending", "editing", "confirmed", "stale"] as const;

const hitlTargetType = z.enum(HITL_TARGET_TYPES);
const hitlAction = z.enum(HITL_ACTIONS);
const hitlStatus = z.enum(HITL_STATUSES);

// 검토 대상 식별: 안정적인 ID 사용 (배열 인덱스 금지)
const hitlTargetRef = z.object({
  type: hitlTargetType,
  // 대상 식별자: 원본 내용 기반 해시 또는 안정 ID
  // step: stepAssessments의 step 텍스트 해시
  // planItem: plan 항목 텍스트 해시 + tool 구분 (codex/claude)
  // criterion: acceptance/tests 항목 텍스트 해시
  // risk: risks/technicalChecks 항목 텍스트 해시
  key: z.string().min(1).max(200),
  // 원본 출처 구분 (diagnosis vs planCodex vs planClaude)
  source: z.enum(["diagnosis", "planCodex", "planClaude"]),
  // 원본 텍스트 (변경 감지용)
  sourceText: z.string().min(1).max(2000),
  // 원본 해시 (실질 변경 감지용)
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export const hitlReviewSchema = z.object({
  id: z.string().min(1).max(120),
  target: hitlTargetRef,
  action: hitlAction,
  status: hitlStatus,
  // 검토 의견 (keep/defer/exclude용)
  comment: z.string().trim().max(2000).optional(),
  // 보완 내용 (supplement용, AI 원본과 분리 저장)
  supplement: z.string().trim().max(2000).optional(),
  // 보류/제외 사유
  reason: z.string().trim().max(2000).optional(),
  // 재개 조건 (defer용)
  resumeCondition: z.string().trim().max(2000).optional(),
  reviewedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict().superRefine((review, ctx) => {
  // supplement 액션은 supplement 필드 필수
  if (review.action === "supplement" && !review.supplement?.trim()) {
    ctx.addIssue({ code: "custom", message: "보완 액션에는 보완 내용을 입력해야 합니다." });
  }
  // defer/exclude는 reason 필수
  if ((review.action === "defer" || review.action === "exclude") && !review.reason?.trim()) {
    ctx.addIssue({ code: "custom", message: "보류/제외 액션에는 사유를 입력해야 합니다." });
  }
});

// 업무별 HITL 검토 컬렉션
export const hitlReviewCollectionSchema = z.object({
  taskId: z.string().min(1).max(120),
  reviews: z.array(hitlReviewSchema).max(100),
  updatedAt: z.iso.datetime(),
}).strict();

// v2: HITL 검토 데이터 포함
export const axTaskV2Schema = axTaskSchema.extend({
  // 사람 검토 데이터 (AI 진단 원본과 분리)
  reviews: z.array(hitlReviewSchema).max(100).optional(),
  // HITL 예시 결과 확인 기록: 업무 단위 목록으로, reviews와 같은 IndexedDB
  // AxStateV2 레코드·같은 저장 경로로 저장한다 (새 서버 저장소 없음).
  // 검토 항목별 필드가 아니라 업무 단위인 이유: 확정 예시 3건 기준은 업무
  // 단위 개수이며, 항목별로 나누면 기준 집계와 지시문 예시 표가 분산된다.
  exampleResults: z.array(exampleResultSchema).max(20).optional(),
});

export const axStateV2Schema = z.object({
  schemaVersion: z.literal(2),
  tasks: z.array(axTaskV2Schema).max(AX_LIMITS.tasks),
  selectedTaskId: z.string().max(120).nullable(),
  step: z.number().int().min(1).max(4),
}).strict().superRefine((state, ctx) => {
  if (new Set(state.tasks.map(t => t.id)).size !== state.tasks.length || (state.selectedTaskId !== null && !state.tasks.some(t => t.id === state.selectedTaskId))) ctx.addIssue({ code: "custom", message: "업무 식별자가 일치하지 않습니다." });
});

// v1 → v2 마이그레이션: reviews 필드 추가 (빈 배열로 초기화, 기존 검토 기록 생성 금지)
export function migrateV1ToV2(v1: z.infer<typeof axStateSchema>): z.infer<typeof axStateV2Schema> {
  return {
    schemaVersion: 2,
    tasks: v1.tasks.map(task => ({
      ...task,
      reviews: [], // 기존 데이터에 검토 기록을 임의로 생성하지 않음
    })),
    selectedTaskId: v1.selectedTaskId,
    step: v1.step,
  };
}
