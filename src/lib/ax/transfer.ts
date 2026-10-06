import { z } from "zod";
import { AX_LIMITS, axStateSchema } from "./schema";
import { taskStatus } from "./policy";
import type { AxState } from "./types";
const envelope = z.object({ format: z.literal("worklens-ax"), schemaVersion: z.literal(1), exportedAt: z.iso.datetime(), data: axStateSchema }).strict();
export function validateAxState(input: unknown): AxState {
  const result = axStateSchema.safeParse(input);
  if (!result.success) throw new Error("AI•AX 데이터 필드·타입·업무 상태가 올바르지 않습니다.");
  // Interpret legacy equal-value corrections in memory without changing factor values.
  for (const task of result.data.tasks) task.status = taskStatus(task.diagnosis);
  // IndexedDB and JSON exports use the same canonical optional-field representation.
  return JSON.parse(JSON.stringify(result.data)) as AxState;
}
// Explicit migration boundary: only v1 is supported, never guess future formats.
export function migrateAxState(input: unknown): AxState {
  if (!input || typeof input !== "object" || !("schemaVersion" in input) || input.schemaVersion !== 1) throw new Error("지원하지 않는 AI•AX 데이터 버전입니다.");
  return validateAxState(input);
}
export function exportAxState(state: AxState): string {
  // Strict, allowlisted schema rejects bytes, summaries, secrets and raw provider fields.
  const json = JSON.stringify({ format: "worklens-ax", schemaVersion: 1, exportedAt: new Date().toISOString(), data: validateAxState(state) }, null, 2);
  if (new TextEncoder().encode(json).byteLength > AX_LIMITS.transferBytes) throw new Error("내보내기 데이터가 8MB를 초과했습니다. 업무 수나 설명을 줄여주세요.");
  return json;
}
export function importAxState(json: string): AxState {
  if (new TextEncoder().encode(json).byteLength > AX_LIMITS.transferBytes) throw new Error("가져오기 파일은 8MB 이하여야 합니다.");
  let input: unknown;
  try { input = JSON.parse(json); } catch { throw new Error("올바른 JSON 파일이 아닙니다."); }
  if (!input || typeof input !== "object" || !("format" in input) || input.format !== "worklens-ax") throw new Error("WorkLens AI•AX 내보내기 파일이 아닙니다.");
  if (!("schemaVersion" in input) || input.schemaVersion !== 1) throw new Error("지원하지 않는 AI•AX 데이터 버전입니다.");
  const result = envelope.safeParse(input);
  if (!result.success) throw new Error("파일의 필수 필드·타입·업무 상태가 올바르지 않습니다.");
  return migrateAxState(result.data.data);
}
