/**
 * HITL 업무 처리 예시 (1차 MVP 개선).
 *
 * 저장: 업무 단위 optional 목록 `exampleResults`로, reviews와 같은 IndexedDB
 * AxStateV2 레코드·같은 저장 경로를 쓴다 (새 서버 저장소 없음, supplement와 별개 필드).
 * 상한: 20건 (schema.ts의 exampleResultSchema 참조).
 * 판정 (보완 6항 1번 — 일괄 3건 강제를 유형별 차등으로 변경):
 * - 필수 대상(아래 exampleRequirement가 required): 확정 예시가 3건 미만이면
 *   기존 조건부 보류 체계에 "업무 처리 예시 미확정" 사유를 추가한다.
 * - 권장 대상(recommended): 보류 사유를 붙이지 않는다.
 * - 확인 필요 대상(needs-confirmation): "업무 처리 예시 확인 필요"로 처리하며,
 *   자동 면제하지 않는다.
 * 기존 보류 사유·판정 기준은 약화·변경하지 않는다.
 */
import type { ExampleResult } from "./types";

export const EXAMPLE_CONFIRMED_MINIMUM = 3;
export const EXAMPLE_HOLD_REASON = "업무 처리 예시 미확정";
export const EXAMPLE_CONFIRM_REASON = "업무 처리 예시 확인 필요";

export type ExampleRequirement = "required" | "recommended" | "needs-confirmation";

/**
 * 업무 처리 예시 필수 여부 (보완 6항 1번).
 *
 * 기존 진단 정보만 재사용한다: 사용자가 이미 확정한 결정 지점 상태만 본다.
 * 새 분류기를 만들지 않고, 업무명·기술명 키워드로 판정하지 않는다.
 * - required: 결과에 영향을 주는 규칙 지점(D1 기준·매칭, D2 중복, D3 특이값,
 *   D7 계산 기준) 중 하나라도 확정된 경우. 규칙에 따라 처리 결과가 달라진다.
 * - recommended: D1·D2·D3·D7이 전부 해당 없음인 경우. D4(결과 상태 목록)·D5(판단 불가
 *   처리)·D6(빈 입력)은 처리 방식·어휘에 가깝고 결과 변동 규칙이 아니므로 단독으로는
 *   필수 판정을 만들지 않는다.
 * - needs-confirmation: 그 외 (D1·D2·D3·D7 중 미확정이 남아 있는 경우).
 *   기존 정보만으로 판단이 불가능하면 담당자 확인을 요청하는 상태이며, 자동 면제하지 않는다.
 */
export function exampleRequirement(points: readonly { id: string; status: string }[]): ExampleRequirement {
  const byId = new Map(points.map(point => [point.id, point.status]));
  const outcomeIds = ["D1", "D2", "D3", "D7"];
  if (outcomeIds.some(id => byId.get(id) === "확정")) return "required";
  if (outcomeIds.every(id => byId.get(id) === "해당 없음")) return "recommended";
  return "needs-confirmation";
}

/**
 * D4 결과 상태가 확정된 경우 기대 결과가 D4 목록에 있는 예시만 확정 예시로 센다.
 * D4가 미확정(stateNames 없음)이면 검증을 적용하지 않고 저장된 예시를 그대로 쓴다.
 */
export function partitionExamples(examples?: ExampleResult[] | null, stateNames?: string[] | null): { valid: ExampleResult[]; invalid: ExampleResult[] } {
  const list = examples ?? [];
  if (!stateNames?.length) return { valid: list, invalid: [] };
  const allowed = new Set(stateNames);
  return {
    valid: list.filter(example => allowed.has(example.expectedState.trim())),
    invalid: list.filter(example => !allowed.has(example.expectedState.trim())),
  };
}

export function confirmedExampleCount(examples?: ExampleResult[] | null, stateNames?: string[] | null): number {
  return partitionExamples(examples, stateNames).valid.length;
}

/** 필수 여부에 따른 보류 사유를 반환한다 (그 외는 빈 배열).
 * 기본값 required는 기존 호출의 안전 방향(보류 유지)이다. 권장 대상은 사유가 없고,
 * 확인 필요 대상은 예시 건수와 무관하게 확인 필요 사유를 반환한다 (자동 면제 금지). */
export function exampleHoldReasons(examples?: ExampleResult[] | null, stateNames?: string[] | null, requirement: ExampleRequirement = "required"): string[] {
  if (requirement === "recommended") return [];
  if (requirement === "needs-confirmation") return [EXAMPLE_CONFIRM_REASON];
  return confirmedExampleCount(examples, stateNames) < EXAMPLE_CONFIRMED_MINIMUM ? [EXAMPLE_HOLD_REASON] : [];
}

/** 표 셀 안의 `|`·줄바꿈이 Markdown 표 열을 깨지 않도록 정리한다. */
function tableCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\s*\r?\n\s*/gu, " ");
}

/** 예시 표 한 행: 입력 값 / 기대 결과(상태 + 선택 기대 값) / 메모. */
export function exampleResultRow(example: ExampleResult): string {
  const expected = example.expectedValue ? `${example.expectedState} (${example.expectedValue})` : example.expectedState;
  return `| ${tableCell(example.input)} | ${tableCell(expected)} | ${tableCell(example.memo ?? "")} |`;
}
