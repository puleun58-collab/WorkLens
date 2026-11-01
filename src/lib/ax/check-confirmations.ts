import type { AxDiagnosis, CheckConfirmation } from "./types";
import { hashSource } from "./hitl";

type TechnicalCheck = AxDiagnosis["technicalChecks"][number];

/** 업무 안에서 기술 확인 항목을 가리키는 안정 키: 주제 문자열을 정규화한 값.
 * 진단 카드도 같은 기준(주제 소문자·공백 정리)으로 중복을 합치므로 업무 안에서 유일하다. */
export const checkKey = (topic: string): string => topic.replace(/\s+/gu, " ").trim().toLowerCase();

/** 원본 항목 지문: 주제 + AI 확인 내용. 재진단으로 내용이 바뀌면 기존 확인 기록은 적용되지 않는다. */
export const checkSourceHash = (check: Pick<TechnicalCheck, "topic" | "note">): string => hashSource(`${check.topic.trim()}\n${check.note.trim()}`);

export type CheckConfirmationState =
  | { kind: "none" }
  /** 확인 내용만 기록됨(미확인) 또는 근거 없는 기록: 상태는 바뀌지 않는다. */
  | { kind: "recorded"; confirmation: CheckConfirmation }
  /** 원본 항목이 바뀌어 기록을 적용하지 않음: 다시 확인해야 한다. */
  | { kind: "stale"; confirmation: CheckConfirmation }
  /** 근거와 함께 확인 완료/사용 불가로 기록되어 상태에 반영됨. */
  | { kind: "applied"; confirmation: CheckConfirmation; status: "확인됨" | "불가" };

/** 한 항목의 확인 기록 상태. 화면 방문·입력만으로는 바뀌지 않고, 근거(note)가 있는
 * 확인 완료/사용 불가 기록이 현재 원본 지문과 일치할 때만 상태에 반영한다. */
export function checkConfirmationState(check: Pick<TechnicalCheck, "topic" | "note">, confirmations: readonly CheckConfirmation[] | undefined): CheckConfirmationState {
  const confirmation = confirmations?.find(entry => entry.key === checkKey(check.topic));
  if (!confirmation) return { kind: "none" };
  if (confirmation.sourceHash !== checkSourceHash(check)) return { kind: "stale", confirmation };
  if (confirmation.result === "미확인" || !confirmation.note.trim()) return { kind: "recorded", confirmation };
  return { kind: "applied", confirmation, status: confirmation.result === "확인 완료" ? "확인됨" : "불가" };
}

/** 확인 기록을 반영한 진단 보기. AI 진단 원본은 바꾸지 않고 새 객체를 돌려준다 (반영할 기록이
 * 없으면 같은 객체). 반영된 항목의 상태는 확인됨/불가가 되고, 확인 근거는 "담당자 확인"으로
 * 확인 내용 뒤에 덧붙여 Gate·선행 조건·구현 전 확인·올인원 지시문이 같은 근거를 본다.
 * 담당자 확인은 시스템 검증이 아니므로 지시문은 구현 시 실제 동작 검증을 계속 요구한다. */
export function applyCheckConfirmations(diagnosis: AxDiagnosis, confirmations: readonly CheckConfirmation[] | undefined): AxDiagnosis {
  if (!confirmations?.length) return diagnosis;
  let changed = false;
  const technicalChecks = diagnosis.technicalChecks.map(check => {
    if (check.status === "확인됨") return check;
    const state = checkConfirmationState(check, confirmations);
    if (state.kind !== "applied") return check;
    changed = true;
    const label = state.status === "확인됨" ? "담당자 확인" : "담당자 확인(사용 불가)";
    // 진단 스키마의 확인 내용 상한(500자)을 넘지 않게 자른다 (전체 기록은 checkConfirmations에 남는다).
    const merged = [check.note.trim(), `${label}: ${state.confirmation.note.trim()}`].filter(Boolean).join(" · ");
    return { ...check, status: state.status, note: merged.length > 500 ? `${merged.slice(0, 499)}…` : merged };
  });
  return changed ? { ...diagnosis, technicalChecks } : diagnosis;
}

/** 확인 기록 저장: 같은 키의 기록을 교체한다 (다른 항목·다른 업무의 기록은 그대로). */
export function upsertCheckConfirmation(list: readonly CheckConfirmation[] | undefined, check: Pick<TechnicalCheck, "topic" | "note">, input: { result: CheckConfirmation["result"]; note: string }, now: string): CheckConfirmation[] {
  const key = checkKey(check.topic);
  const next: CheckConfirmation = { key, topic: check.topic.trim(), sourceHash: checkSourceHash(check), result: input.result, note: input.note.trim(), updatedAt: now };
  return [...(list ?? []).filter(entry => entry.key !== key), next];
}
