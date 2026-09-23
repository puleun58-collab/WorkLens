import { z } from "zod";
import type { AiApiRequest } from "@/lib/ai/api";
import { MAX_EVIDENCE_CHARS, MAX_EVIDENCE_ITEM_CHARS, MAX_EVIDENCE_ITEMS } from "@/lib/ai/prompt";
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
  z.object({ kind: z.literal("claims"), request: taskSchema, items: evidenceItemsSchema }).strict(),
  z.object({
    kind: z.literal("polish"),
    text: boundedText(POLISH_SEGMENT_MAX_CHARS),
    mode: z.enum(["default", "concise", "business"]),
  }).strict(),
  z.object({
    kind: z.literal("extract"),
    field: boundedText(MAX_FIELD_CHARS),
    items: evidenceItemsSchema,
  }).strict(),
]);

export function parseAiApiRequest(value: unknown): AiApiRequest {
  const parsed = aiApiRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError("INVALID_AI_REQUEST", "AI 요청 형식이 올바르지 않습니다.", 400);
  }
  return parsed.data;
}
