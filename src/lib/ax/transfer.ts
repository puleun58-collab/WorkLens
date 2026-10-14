import { z } from "zod";
import { AX_LIMITS, axStateSchema, axStateV2Schema, migrateV1ToV2 } from "./schema";
import { taskStatus } from "./policy";
import type { AxState, AxStateV2 } from "./types";
// 내보내기 envelope: v1(레거시)·v2(HITL) 모두 허용. data는 버전별로 분기 검증한다.
const envelope = z.object({ format: z.literal("worklens-ax"), schemaVersion: z.union([z.literal(1), z.literal(2)]), exportedAt: z.iso.datetime(), data: z.unknown() }).strict();
export function validateAxState(input: unknown): AxState {
  const result = axStateSchema.safeParse(input);
  if (!result.success) throw new Error("AI•AX 데이터 필드·타입·업무 상태가 올바르지 않습니다.");
  // Interpret legacy equal-value corrections in memory without changing factor values.
  for (const task of result.data.tasks) task.status = taskStatus(task.diagnosis);
  // IndexedDB and JSON exports use the same canonical optional-field representation.
  return JSON.parse(JSON.stringify(result.data)) as AxState;
}
export function validateAxStateV2(input: unknown): AxStateV2 {
  const result = axStateV2Schema.safeParse(input);
  if (!result.success) throw new Error("AI•AX 데이터 필드·타입·업무 상태가 올바르지 않습니다.");
  // Interpret legacy equal-value corrections in memory without changing factor values.
  for (const task of result.data.tasks) task.status = taskStatus(task.diagnosis);
  // IndexedDB and JSON exports use the same canonical optional-field representation.
  return JSON.parse(JSON.stringify(result.data)) as AxStateV2;
}
// Explicit migration boundary: v1은 명시적 규칙으로 v2에 변환하고, v2는 검증만 수행한다.
// 알 수 없는 버전은 임의 변환하지 않는다.
export function migrateAxState(input: unknown): AxStateV2 {
  if (!input || typeof input !== "object" || !("schemaVersion" in input)) throw new Error("지원하지 않는 AI•AX 데이터 버전입니다.");
  if (input.schemaVersion === 1) return validateAxStateV2(migrateV1ToV2(validateAxState(input)));
  if (input.schemaVersion === 2) return validateAxStateV2(input);
  throw new Error("지원하지 않는 AI•AX 데이터 버전입니다.");
}
// v1 입력을 v2 정규형으로 변환한다. v2 입력은 검증만 수행한다.
export function toAxStateV2(state: AxState | AxStateV2): AxStateV2 {
  return state.schemaVersion === 1 ? migrateV1ToV2(validateAxState(state)) : validateAxStateV2(state);
}
export function exportAxState(state: AxState | AxStateV2): string {
  // Strict, allowlisted schema rejects bytes, summaries, secrets and raw provider fields.
  // 내보내기는 항상 최신(v2) 형식으로 생성한다.
  const json = JSON.stringify({ format: "worklens-ax", schemaVersion: 2, exportedAt: new Date().toISOString(), data: toAxStateV2(state) }, null, 2);
  if (new TextEncoder().encode(json).byteLength > AX_LIMITS.transferBytes) throw new Error("내보내기 데이터가 8MB를 초과했습니다. 업무 수나 설명을 줄여주세요.");
  return json;
}
export function importAxState(json: string): AxStateV2 {
  if (new TextEncoder().encode(json).byteLength > AX_LIMITS.transferBytes) throw new Error("가져오기 파일은 8MB 이하여야 합니다.");
  let input: unknown;
  try { input = JSON.parse(json); } catch { throw new Error("올바른 JSON 파일이 아닙니다."); }
  if (!input || typeof input !== "object" || !("format" in input) || input.format !== "worklens-ax") throw new Error("WorkLens AI•AX 내보내기 파일이 아닙니다.");
  if (!("schemaVersion" in input) || (input.schemaVersion !== 1 && input.schemaVersion !== 2)) throw new Error("지원하지 않는 AI•AX 데이터 버전입니다.");
  const result = envelope.safeParse(input);
  if (!result.success) throw new Error("파일의 필수 필드·타입·업무 상태가 올바르지 않습니다.");
  // v1 파일은 명시적 마이그레이션으로 v2에 변환한다. v2 파일은 검증 후 그대로 사용한다.
  return migrateAxState(result.data.data);
}
