/**
 * 고정 결정 지점 D1~D7 (1차 MVP 개선).
 *
 * 원칙:
 * - 고정 목록은 AI가 자유롭게 만드는 질문에 의존하지 않는다. 항상 7개가 표시되고
 *   기본값은 "미확정"이다. "확정"/"해당 없음"은 사용자가 직접 선택·입력한 경우에만
 *   저장되며, AI가 근거 없이 미리 채우지 않는다 (진단 수신 시 AI 값은 제거한다).
 * - 미확정 항목의 detail은 확정 규칙으로 취급하지 않는다. resolve 단계에서 버린다.
 * - 저장된 진단 원문은 절대 고치지 않는다. D4 상태 단일 정의의 교체·제거는
 *   지시문 생성 시점의 출력에만 적용한다 (applyStateDefinition).
 */
import { DECISION_POINT_IDS } from "./schema";
import type { AxDiagnosis, DecisionPoint, DecisionPointId, DecisionPointStatus } from "./types";

export interface DecisionPointDef {
  id: DecisionPointId;
  title: string;
  question: string;
  /** D4·D5 편집 안내 (상세 입력란 placeholder). */
  detailHint: string;
}

export const DECISION_POINT_DEFS: readonly DecisionPointDef[] = [
  { id: "D1", title: "기준과 매칭", question: "기준과 매칭(기준 파일·시트, 대조 키, 누락·초과 판단 방향)", detailHint: "기준 파일·시트, 대조 키, 누락·초과 판단 방향을 적으세요." },
  { id: "D2", title: "중복", question: "중복(같은 키 여러 번 처리)", detailHint: "같은 키가 여러 번 나타날 때 처리 방식을 적으세요." },
  { id: "D3", title: "특이값", question: "특이값(음수, 0, 빈칸, 형식 불일치 처리)", detailHint: "음수·0·빈칸·형식 불일치의 처리 방식을 적으세요." },
  { id: "D4", title: "결과 상태", question: "결과 상태(상태 이름 목록과 각 상태 판정 조건)", detailHint: "결과 상태 이름을 쉼표·점·빗금(/)으로 구분해 적으세요. '상태 정확히 N개(...)' 형태도 정리됩니다. (예: 정상, 오류(확정), 확인 필요)" },
  { id: "D5", title: "판단 불가", question: "판단 불가(확정 규칙으로 판정 불가한 행을 보낼 상태와 사유 표시 방법)", detailHint: "판정 불가 행을 보낼 상태명(결과 상태 (D4) 중 하나)을 적으세요." },
  { id: "D6", title: "빈 입력", question: "빈 입력(데이터 행 없는 파일·헤더만 있는 파일·빈 파일 처리)", detailHint: "데이터 행 없는 파일·헤더만 있는 파일·빈 파일의 처리 방식을 적으세요." },
  { id: "D7", title: "계산 기준", question: "계산 기준(합계·반올림·단위 기준)", detailHint: "합계·반올림·단위 기준을 적으세요." },
] as const;

export interface ResolvedDecisionPoint {
  id: DecisionPointId;
  title: string;
  question: string;
  status: DecisionPointStatus;
  /** 확정/해당 없음일 때만 있다. 미확정 항목의 detail은 버려진다. */
  detail?: string;
}

/** 저장된 진단(없을 수도 있음)을 항상 7개 고정 목록으로 펼친다. */
export function resolveDecisionPoints(diagnosis?: Pick<AxDiagnosis, "decisionPoints"> | null): ResolvedDecisionPoint[] {
  const stored = new Map<string, DecisionPoint>();
  for (const point of diagnosis?.decisionPoints ?? []) {
    if ((DECISION_POINT_IDS as readonly string[]).includes(point.id) && !stored.has(point.id)) stored.set(point.id, point);
  }
  return DECISION_POINT_DEFS.map(def => {
    const found = stored.get(def.id);
    if (!found || found.status === "미확정") return { id: def.id, title: def.title, question: def.question, status: "미확정" as const };
    const detail = found.detail?.trim();
    return { id: def.id, title: def.title, question: def.question, status: found.status, ...(detail ? { detail } : {}) };
  });
}

export function undecidedDecisionIds(points: ResolvedDecisionPoint[]): DecisionPointId[] {
  return points.filter(point => point.status === "미확정").map(point => point.id);
}

/** D4 상세 입력을 상태 이름 목록으로 정리한다. 쉼표·가운뎃점·점·빗금(/)·줄바꿈 구분을 모두 받고 중복은 하나로 합친다.
 * 숫자 사이의 점(예: 1.5)은 구분자로 보지 않는다.
 * "상태 정확히 N개(...)" 래퍼와 "만 사용한다" 접미사는 목록이 아니므로 제거하고 괄호 안 내용만 파싱한다.
 * 빈 토큰과 개수만 남은 토큰(예: "3개")은 상태명이 아니므로 버리고, 앞의 번호 매김(예: "1. ")은 떼어낸다. */
export function parseStateNames(detail: string): string[] {
  let text = detail.trim();
  const wrapped = /상태\s*정확히\s*\d+\s*개\s*[（(]([^）)]*)[）)]/u.exec(text);
  if (wrapped) text = wrapped[1];
  else {
    const whole = /^\s*[（(]([^）)]*)[）)]\s*$/u.exec(text);
    if (whole) text = whole[1];
  }
  text = text.replace(/^상태\s*정확히\s*\d+\s*개\s*[:：]?\s*/u, "");
  text = text.replace(/\s*만\s*사용한다\s*[.。]?\s*$/u, "");
  return [...new Set(text.split(/[,，·ㆍ・•、。;\n\/／]|(?<!\d)\.(?!\d)/u)
    .map(name => name.trim().replace(/^(?:\d+[.)]|[①-⑳])\s+/u, "").replace(/^상태\s*정확히\s*\d+\s*개\s*/u, "").trim())
    .filter(name => Boolean(name) && !/^\d+\s*개?$/u.test(name)))].slice(0, 10);
}

/** "상태 정확히 N개(...)" 표기에 적힌 N. 래퍼가 없으면 null이다. */
export function declaredStateCount(detail: string): number | null {
  const match = /상태\s*정확히\s*(\d+)\s*개/u.exec(detail);
  return match ? Number(match[1]) : null;
}

/** D4가 확정이고 상태 목록이 적혀 있을 때만 상태 이름 목록을 반환한다. */
export function confirmedStateNames(points: ResolvedDecisionPoint[]): string[] | null {
  const d4 = points.find(point => point.id === "D4");
  if (!d4 || d4.status !== "확정" || !d4.detail) return null;
  const names = parseStateNames(d4.detail);
  return names.length ? names : null;
}

/** D5가 확정일 때 판정 불가 행을 보낼 상태명. D5 detail은 상태명 그 자체로 입력받는다. */
export function confirmedUndecidableState(points: ResolvedDecisionPoint[]): string | null {
  const d5 = points.find(point => point.id === "D5");
  if (!d5 || d5.status !== "확정" || !d5.detail) return null;
  return d5.detail.trim();
}

/**
 * D4 목록으로 검증된 D5 상태명. D4가 확정되지 않았으면 기존 동작대로 D5 detail을
 * 그대로 인용한다(검증할 목록이 없음). D4가 확정됐는데 D5 detail이 D4 목록에 속한
 * 단일 상태명이 아니면 null을 반환한다 — 덩어리·복수 상태·목록 외 상태명은 인용하지 않는다.
 */
export function validatedUndecidableState(points: ResolvedDecisionPoint[]): string | null {
  const d5 = points.find(point => point.id === "D5");
  if (!d5 || d5.status !== "확정" || !d5.detail) return null;
  const states = confirmedStateNames(points);
  if (!states) return d5.detail.trim();
  const parsed = parseStateNames(d5.detail);
  return parsed.length === 1 && states.includes(parsed[0]) ? parsed[0] : null;
}

/** D4가 확정됐는데 D5 상태명이 D4 목록에 속한 단일 상태명이 아닌 경우 true. */
export function isUndecidableStateInvalid(points: ResolvedDecisionPoint[]): boolean {
  const d5 = points.find(point => point.id === "D5");
  if (!d5 || d5.status !== "확정" || !d5.detail) return false;
  if (!confirmedStateNames(points)) return false;
  return validatedUndecidableState(points) === null;
}

/**
 * 지시문 생성 출력에만 적용하는 D4 단일 정의 강제 (저장 원문은 건드리지 않는다).
 * - "정상·오류" / "정상/오류" 같은 2분법 표현을 D4 목록으로 바꾼다.
 * - "정상 데이터와 오류 데이터", "정상과 오류" 같은 2분법 분리 표현을 D4 목록으로 바꾼다.
 * - 사용자가 직접 입력한 블록(결정 지점·확정 예시)은 호출 측에서 보호한 뒤 호출한다
 *   (D4 정의 행 자체가 다시 치환되어 상태가 중복되는 것을 막는다).
 * - D4 목록에 "정상"이 없을 때만 고정 문구 "정상 케이스"/"정상 결과"를
 *   상태명을 하드코딩하지 않는 중립 문구로 바꾼다 ("정상"이 D4 이름이면 그대로 둔다).
 */
export function applyStateDefinition(prompt: string, stateNames: string[] | null): string {
  if (!stateNames) return prompt;
  const joined = stateNames.join(" · ");
  let out = prompt
    .replace(/정상·오류/gu, joined)
    .replace(/정상\/오류/gu, joined)
    .replace(/정상 데이터와 오류 데이터/gu, `${joined} 데이터`)
    .replace(/정상(?:과|와) 오류/gu, joined);
  if (!stateNames.includes("정상")) {
    out = out.replace(/정상 케이스/gu, "예시 케이스").replace(/정상 결과/gu, "확정된 결과 상태");
  }
  return out;
}
