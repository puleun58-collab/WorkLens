/**
 * HITL 예시 결과 (1차 MVP 개선).
 *
 * 저장: 업무 단위 optional 목록 `exampleResults`로, reviews와 같은 IndexedDB
 * AxStateV2 레코드·같은 저장 경로를 쓴다 (새 서버 저장소 없음, supplement와 별개 필드).
 * 상한: 20건 (schema.ts의 exampleResultSchema 참조).
 * 판정: 확정 예시가 3건 미만이면 기존 조건부 보류 체계에 "예시 결과 미확정"
 * 사유를 추가한다. 기존 보류 사유·판정 기준은 약화·변경하지 않는다.
 */
import type { ExampleResult } from "./types";

export const EXAMPLE_CONFIRMED_MINIMUM = 3;
export const EXAMPLE_HOLD_REASON = "예시 결과 미확정";

export function confirmedExampleCount(examples?: ExampleResult[] | null): number {
  return examples?.length ?? 0;
}

/** 확정 예시가 3건 미만일 때만 보류 사유를 반환한다 (그 외는 빈 배열). */
export function exampleHoldReasons(examples?: ExampleResult[] | null): string[] {
  return confirmedExampleCount(examples) < EXAMPLE_CONFIRMED_MINIMUM ? [EXAMPLE_HOLD_REASON] : [];
}

/** 예시 표 한 행: 입력 값 / 기대 결과(상태 + 선택 기대 값) / 메모. */
export function exampleResultRow(example: ExampleResult): string {
  const expected = example.expectedValue ? `${example.expectedState} (${example.expectedValue})` : example.expectedState;
  return `| ${example.input} | ${expected} | ${example.memo ?? ""} |`;
}
