import type { AxDiagnosis, AxPlan } from "../../src/lib/ax/types";
import { FACTOR_KEYS, REPOSITORY_FIRST } from "../../src/lib/ax/schema";
import type { AxAgentCase } from "./ax-agent-cases";

type Factors = [repetition: number, regularity: number, dataStructure: number, systemAccess: number, humanJudgment: number, operationalRisk: number];
type Step = AxDiagnosis["stepAssessments"][number];

const step = (name: string, verdict: Step["verdict"], owner: Step["owner"], note: string): Step => ({ step: name, verdict, owner, note });
const factors = (values: Factors) => FACTOR_KEYS.map((key, index) => ({ key, aiValue: values[index], rationale: "등록된 업무 설명 근거" }));
const newPlan = (patch: Partial<AxPlan>): AxPlan => ({
  repositoryFirst: REPOSITORY_FIRST, goal: [], asIs: [], toBe: [], inScope: [], outOfScope: [], prerequisites: [], humanInLoop: [], poc: [],
  implementation: [], dataFlow: [], integrations: [], exceptions: [], fallback: [], security: [], operation: [], tests: [], acceptance: [], ...patch,
});

/** 주간 경유 가격 취합 및 보고 — Level 1 · AI 보조 (가치 4, 실현 3, 판단 4, 위험 3), 확인 후 진행.
 * 대표 회귀 사례: 핵심 계산·입력 단계가 향후 계획으로 밀리지 않아야 함. */
export const dieselCase: AxAgentCase = {
  name: "주간 경유 가격 취합 및 보고",
  description: "웹사이트에서 경유 가격을 확인해 Excel에 입력하고, 전주 대비 증감률과 월평균을 계산해 보고서 양식을 업데이트한 뒤 담당자가 최종 검토합니다.",
  diagnosis: {
    informationSufficiency: "partial", followUpQuestions: [],
    asIs: {
      purpose: "주간 경유 가격 변동 현황을 보고서로 취합", trigger: "매주 금요일 담당자가 가격을 확인",
      inputs: ["경유 가격 웹사이트 조회 결과", "기존 Excel 실적 파일"],
      steps: ["경유 가격 확인", "가격 입력", "전주 대비 증감률 계산", "월평균 계산", "보고서 업데이트", "담당자 최종 검토"],
      outputs: ["주간 경유 가격 보고서"], exceptions: ["가격 미공시일", "Excel 양식 변경"], humanDecisions: ["보고서 최종 검토"], systems: ["경유 가격 웹사이트", "Excel"],
    },
    factors: factors([4, 4, 3, 2, 4, 3]),
    stepAssessments: [
      step("경유 가격 확인", "사람 유지", "사용자", "웹사이트에서 담당자가 직접 확인"),
      step("가격 입력", "자동화", "시스템", "Excel에 가격 입력"),
      step("전주 대비 증감률 계산", "자동화", "시스템", "전주 가격과 현재 가격으로 증감률 계산"),
      step("월평균 계산", "자동화", "시스템", "해당 월의 경유 가격 평균 계산"),
      step("보고서 업데이트", "AI 보조", "AI", "보고용 양식에 계산 결과 입력 후보 제안"),
      step("담당자 최종 검토", "사람 유지", "사용자", "담당자가 보고서 최종 검토"),
    ],
    toBe: [
      { step: "가격 입력", owner: "시스템", description: "담당자가 입력한 가격을 시스템에 등록" },
      { step: "증감률 계산", owner: "시스템", description: "전주 대비 증감률 자동 계산" },
      { step: "월평균 계산", owner: "시스템", description: "월평균 가격 자동 계산" },
      { step: "보고서 업데이트", owner: "AI", description: "계산 결과를 보고서 양식에 입력 후보로 제안" },
      { step: "담당자 최종 검토", owner: "사용자", description: "담당자가 보고서 최종 검토" },
    ],
    humanInLoop: ["담당자 최종 검토"],
    technicalChecks: [
      { topic: "보고서 양식", status: "확인 필요", note: "현재 보고 양식 확인" },
      { topic: "전주 가격 데이터", status: "확인 필요", note: "전주 가격 기록 확인" },
    ],
    risks: ["잘못된 가격 입력으로 증감률 오류"],
    poc: { hypothesis: "증감률·월평균 계산을 자동화하면 보고 시간을 줄일 수 있다", inScope: [], outOfScope: ["가격 자동 수집"], inputs: ["최근 경유 가격 Excel 샘플"], outputs: ["주간 경유 가격 결과", "전주 대비 증감률", "월평균 가격"], evaluation: ["담당자가 수동 계산한 결과와 대조"], success: ["증감률 계산이 담당자 수동 계산과 일치", "월평균 계산이 담당자 수동 계산과 일치"], failure: ["가격 누락 건이 정상 결과에 섞임"] },
    decisionGate: { verdict: "conditional", reasons: ["보고서 양식과 전주 가격 기록 확인 후 진행"] },
    roadmap: [],
    operation: { owner: "업무 담당", failureOwner: "운영 담당", maintenanceBurden: "medium", fallback: "기존 수동 집계로 처리", notes: [] },
    nextAction: { label: "샘플 확인", detail: "" }, sourceNote: "사용자 등록 정보 기반 진단",
  },
  plan: newPlan({
    goal: ["경유 가격 데이터 입력·계산·보고서 초안을 확인할 수 있는 웹앱 구현"],
    inScope: ["가격 입력", "전주 대비 증감률 계산", "월평균 계산", "보고서 업데이트 후보 제안"],
    outOfScope: ["가격 자동 수집"],
    implementation: ["가격 입력", "전주 대비 증감률 계산", "월평균 계산", "보고서 업데이트 후보 제안"],
    dataFlow: ["경유 가격 데이터 → 입력값 검증 → 증감률·월평균 계산 → 오류·누락 구분 → 보고서 미리보기"],
    exceptions: ["가격 미공시일 분리", "누락 데이터 구분"],
    tests: ["증감률 계산 대조", "월평균 계산 대조", "오류 입력 처리"],
    acceptance: ["증감률 계산이 담당자 수동 계산과 일치", "월평균 계산이 담당자 수동 계산과 일치"],
    humanInLoop: ["담당자 최종 검토"],
  }),
};
