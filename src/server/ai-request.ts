import { AX_LIMITS, axDiagnosisRequestSchema, axPlanRequestSchema } from "@/lib/ax/schema";
import { z } from "zod";
import { POLISH_BATCH_MAX_CHARS, POLISH_BATCH_MAX_ITEMS, SUPPLEMENT_REVIEW_MAX_CHECKS, type AiApiRequest } from "@/lib/ai/api";
import { evidenceCharBudget, MAX_EVIDENCE_CHARS, MAX_EVIDENCE_ITEM_CHARS, MAX_EVIDENCE_ITEMS } from "@/lib/ai/prompt";
import { POLISH_SEGMENT_MAX_CHARS } from "@/lib/polish/candidates";
import { ApiError } from "@/server/http";

const MAX_INSTRUCTION_CHARS = 1_000;
const MAX_FIELD_CHARS = 120;
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

const evidenceItemsSchema = z.array(z.object({
  handle: z.string().trim().toUpperCase().regex(/^E[1-9][0-9]?$/u),
  text: boundedText(MAX_EVIDENCE_ITEM_CHARS),
  role: z.enum(["base", "target"]).optional(),
}).strict()).min(1).max(MAX_EVIDENCE_ITEMS).superRefine((items, context) => {
  const handles = new Set(items.map((item) => item.handle));
  if (handles.size !== items.length) {
    context.addIssue({ code: "custom", message: "근거 식별자는 중복될 수 없습니다." });
  }
});

const extractEvidenceSchema = evidenceItemsSchema.superRefine((items, context) => {
  if (items.reduce((total, item) => total + item.text.length, 0) > MAX_EVIDENCE_CHARS) {
    context.addIssue({ code: "custom", message: "근거 텍스트가 허용 길이를 초과했습니다." });
  }
});

const taskSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("analyze") }).strict(),
  z.object({ operation: z.literal("ask"), question: boundedText(MAX_INSTRUCTION_CHARS) }).strict(),
  z.object({ operation: z.literal("semantic-check"), statement: boundedText(MAX_INSTRUCTION_CHARS), scope: z.literal("comparison").optional() }).strict(),
]);

const aiApiRequestSchema = z.discriminatedUnion("kind", [
  axDiagnosisRequestSchema, axPlanRequestSchema,
  z.object({ kind: z.literal("claims"), request: taskSchema, items: evidenceItemsSchema }).strict(),
  z.object({
    kind: z.literal("polish"),
    text: boundedText(POLISH_SEGMENT_MAX_CHARS),
    mode: z.enum(["default", "concise", "business"]),
  }).strict(),
  z.object({
    kind: z.literal("polish-batch"),
    mode: z.enum(["default", "concise", "business"]),
    items: z.array(z.object({
      id: boundedText(120),
      text: boundedText(POLISH_SEGMENT_MAX_CHARS),
    }).strict()).min(1).max(POLISH_BATCH_MAX_ITEMS).superRefine((items, context) => {
      if (new Set(items.map((item) => item.id)).size !== items.length) {
        context.addIssue({ code: "custom", message: "윤문 문장 식별자는 중복될 수 없습니다." });
      }
      if (items.reduce((total, item) => total + item.text.length, 0) > POLISH_BATCH_MAX_CHARS) {
        context.addIssue({ code: "custom", message: "윤문 텍스트가 허용 길이를 초과했습니다." });
      }
    }),
  }).strict(),
  z.object({
    kind: z.literal("extract"),
    field: boundedText(MAX_FIELD_CHARS),
    items: extractEvidenceSchema,
  }).strict(),
  z.object({
    kind: z.literal("supplement-review"),
    checks: z.array(z.object({
      id: z.string().trim().toUpperCase().regex(/^C[1-9]$/u),
      statement: boundedText(MAX_EVIDENCE_ITEM_CHARS),
      requirement: boundedText(MAX_FIELD_CHARS),
      handles: z.array(z.string().trim().toUpperCase().regex(/^E[1-9][0-9]?$/u)).min(1).max(MAX_EVIDENCE_ITEMS),
    }).strict()).min(1).max(SUPPLEMENT_REVIEW_MAX_CHECKS),
    items: extractEvidenceSchema,
  }).strict().superRefine((value, context) => {
    const handles = new Set(value.items.map((item) => item.handle));
    if (new Set(value.checks.map((check) => check.id)).size !== value.checks.length
      || value.checks.some((check) => check.handles.some((handle) => !handles.has(handle)))) {
      context.addIssue({ code: "custom", message: "점검 항목과 근거가 일치하지 않습니다." });
    }
  }),
]).superRefine((value, context) => {
  if (value.kind === "claims"
    && value.items.reduce((total, item) => total + item.text.length, 0) > evidenceCharBudget(value.request.operation)) {
    context.addIssue({ code: "custom", message: "근거 텍스트가 허용 길이를 초과했습니다." });
  }
});

export function parseAiApiRequest(value: unknown): AiApiRequest {
  const parsed = aiApiRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError("INVALID_AI_REQUEST", "AI 요청 형식이 올바르지 않습니다.", 400);
  }
  if ((parsed.data.kind === "ax-diagnosis" || parsed.data.kind === "ax-plan")
    && new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > AX_LIMITS.requestBytes) {
    throw new ApiError("INVALID_AI_REQUEST", "AX 요청이 허용 크기를 초과했습니다.", 400);
  }
  return parsed.data;
}
