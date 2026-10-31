/** 자동화 구현 계획 화면의 그룹 표시 전용 분류.
 * 계획 원본(plan.implementation)의 항목·순서·검토 키·올인원 지시문은 바꾸지 않고, 각 단계를
 * 4개 업무 흐름 그룹 중 정확히 한 곳에 배치한다 (누락·중복 없음). 그룹 안에서는 원본 실행
 * 순서를 유지하고, 각 단계는 원본 순번(index)을 함께 가진다. */
export type PlanGroupId = "collect" | "process" | "report" | "operate";

export const PLAN_GROUPS: readonly { id: PlanGroupId; title: string; description: string }[] = [
  { id: "collect", title: "데이터 준비 및 수집", description: "입력 자료 수집·접근 권한·유효성 확인" },
  { id: "process", title: "데이터 처리 및 계산", description: "표준화·계산 규칙 적용·대조 및 검증" },
  { id: "report", title: "결과 생성 및 보고", description: "보고서·템플릿 반영·결과 저장 및 공유" },
  { id: "operate", title: "운영 및 관리", description: "오류·예외 처리, 품질 검증, 담당자 검토·승인" },
];

/** 분류 우선순위: 운영(검토·승인·오류 등 관리 행위) → 수집 → 보고 → 처리.
 * "입력 자료 유효성 검증"처럼 수집 맥락의 검증은 수집으로, 일반 대조·검증은 처리로 간다. */
const RULES: readonly [PlanGroupId, RegExp][] = [
  ["operate", /승인|검토|오류|예외|로그|모니터링|알림|운영|배포|롤백|품질|테스트|재시도|장애|백업/u],
  ["collect", /수집|접근|권한|업로드|다운로드|가져오|불러오|읽어|추출|연결|유효성|저장소|입력\s*(자료|데이터|파일)|원본\s*(파일|데이터)/u],
  ["report", /보고서|리포트|템플릿|출력|공유|발송|전송|대시보드|메일|저장(?!소)/u],
  ["process", /계산|집계|변환|표준화|매핑|대조|검증|분류|정제|규칙|산출|비교|판정|수식|병합|실험|샘플/u],
];

export interface PlanStepGroup {
  id: PlanGroupId;
  title: string;
  description: string;
  /** 원본 계획 순서의 단계 (index: plan.implementation의 0부터 시작하는 위치). */
  steps: { index: number; text: string }[];
}

/** 단계마다 하나의 그룹을 고른다. 어떤 규칙에도 맞지 않으면 바로 앞 단계의 그룹(업무 흐름
 * 연속성)에, 첫 단계면 처리 그룹에 둔다. 빈 그룹은 반환하지 않는다. */
export function groupPlanSteps(steps: readonly string[]): PlanStepGroup[] {
  const assigned: PlanGroupId[] = [];
  steps.forEach((text, index) => {
    const match = RULES.find(([, pattern]) => pattern.test(text))?.[0];
    assigned.push(match ?? (index ? assigned[index - 1] : "process"));
  });
  return PLAN_GROUPS
    .map(group => ({ ...group, steps: steps.flatMap((text, index) => assigned[index] === group.id ? [{ index, text }] : []) }))
    .filter(group => group.steps.length);
}
