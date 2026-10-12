import type { AxDiagnosis, AxPlan } from "../../src/lib/ax/types";
import { FACTOR_KEYS, REPOSITORY_FIRST } from "../../src/lib/ax/schema";

type Factors = [repetition: number, regularity: number, dataStructure: number, systemAccess: number, humanJudgment: number, operationalRisk: number];
type Step = AxDiagnosis["stepAssessments"][number];

export interface AxAgentCase { name: string; description: string; diagnosis: AxDiagnosis; plan: AxPlan }

function diagnosis(values: Factors, patch: Omit<Partial<AxDiagnosis>, "factors">): AxDiagnosis {
  return {
    informationSufficiency: "partial", followUpQuestions: [],
    asIs: { purpose: "", trigger: "", inputs: [], steps: [], outputs: [], exceptions: [], humanDecisions: [], systems: [] },
    factors: FACTOR_KEYS.map((key, index) => ({ key, aiValue: values[index], rationale: "등록된 업무 설명 근거" })),
    stepAssessments: [], toBe: [], humanInLoop: [], technicalChecks: [], risks: [],
    poc: { hypothesis: "", inScope: [], outOfScope: [], inputs: [], outputs: [], evaluation: [], success: [], failure: [] },
    decisionGate: { verdict: "go", reasons: [] }, roadmap: [],
    operation: { owner: "업무 담당", failureOwner: "운영 담당", maintenanceBurden: "medium", fallback: "기존 수동 절차로 처리", notes: [] },
    nextAction: { label: "샘플 확인", detail: "" }, sourceNote: "사용자 등록 정보 기반 진단",
    ...patch,
  };
}
function plan(patch: Partial<AxPlan>): AxPlan {
  return {
    repositoryFirst: REPOSITORY_FIRST, goal: [], asIs: [], toBe: [], inScope: [], outOfScope: [], prerequisites: [], humanInLoop: [], poc: [],
    implementation: [], dataFlow: [], integrations: [], exceptions: [], fallback: [], security: [], operation: [], tests: [], acceptance: [], ...patch,
  };
}
const step = (name: string, verdict: Step["verdict"], owner: Step["owner"], note: string): Step => ({ step: name, verdict, owner, note });

/** Level 1 · AI 보조 (가치 4, 실현 3, 판단 4, 위험 3), 확인 후 진행. The plan carries the conflicts a raw model plan can contain. */
export const equipmentCase: AxAgentCase = {
  name: "일일 장비 가동 실적 집계",
  description: "현장별 장비 가동 실적 Excel을 공유 폴더에서 모아 표준 양식으로 정리하고, 가동률을 계산해 일일 보고서 초안을 만든 뒤 담당자가 검토·승인합니다.",
  diagnosis: diagnosis([4, 4, 3, 2, 4, 3], {
    asIs: {
      purpose: "현장별 장비 가동 실적을 하루 단위로 집계해 보고", trigger: "매일 오전 현장 실적 제출 후",
      inputs: ["현장별 장비 가동 실적 Excel"], steps: ["공유 폴더 파일 수집", "컬럼 매핑", "데이터 표준화", "누락·중복 검증", "가동률 계산", "보고서 초안 작성", "최종 승인"],
      outputs: ["일일 장비 가동 보고서"], exceptions: ["현장별 Excel 양식 차이", "실적 누락·중복 제출"], humanDecisions: ["보고서 최종 승인"], systems: ["공유 폴더", "Excel"],
    },
    stepAssessments: [
      step("공유 폴더 파일 수집", "자동화", "시스템", "공유 폴더 접근 권한 미확인"),
      step("AI 컬럼 매핑", "AI 보조", "AI", "매핑 결과는 담당자 검증 필요"),
      step("데이터 표준화", "자동화", "시스템", "실제 Excel 구조 확인 필요"),
      step("누락·중복 검증", "자동화", "시스템", "검증 기준 확인 필요"),
      step("가동률 계산", "자동화", "시스템", "계산식 미확정"),
      step("보고서 초안 작성", "AI 보조", "AI", "보고서 템플릿 미확정"),
      step("최종 승인", "사람 유지", "사용자", "담당자가 검토·승인"),
    ],
    toBe: [
      { step: "파일 수집", owner: "시스템", description: "공유 폴더의 당일 실적 파일을 자동 수집" },
      { step: "컬럼 매핑", owner: "AI", description: "현장별 컬럼을 표준 항목 후보로 매핑" },
      { step: "가동률 계산·보고서", owner: "시스템", description: "가동률을 계산해 보고서 초안 생성" },
      { step: "최종 승인", owner: "사용자", description: "담당자가 초안을 검토·승인" },
    ],
    humanInLoop: ["담당자 최종 검토·승인"],
    technicalChecks: [
      { topic: "공유 폴더 접근 권한", status: "확인 필요", note: "읽기 권한과 경로 확인" },
      { topic: "AI 매핑 연동", status: "확인 필요", note: "사용 가능한 AI 서비스와 보안 조건 확인" },
      { topic: "보고서 템플릿", status: "확인 필요", note: "현재 보고 양식 확인" },
    ],
    risks: ["잘못된 매핑으로 실적이 다른 장비에 합산"],
    poc: { hypothesis: "컬럼 매핑 후보 제안으로 정리 시간을 줄일 수 있다", inScope: [], outOfScope: ["보고서 자동 승인"], inputs: ["최근 실적 샘플 Excel"], outputs: ["매핑 후보 표"], evaluation: ["담당자가 매핑 후보를 확인한 결과와 대조"], success: ["확정된 샘플에서 매핑 후보가 담당자 확정 결과와 일치"], failure: ["매핑할 수 없는 컬럼이 정상 결과에 섞임"] },
    decisionGate: { verdict: "conditional", reasons: ["공유 폴더 권한과 보고서 템플릿 확인 후 진행"] },
    operation: { owner: "업무 담당", failureOwner: "운영 담당", maintenanceBurden: "medium", fallback: "기존 수동 집계로 처리", notes: [] },
  }),
  plan: plan({
    goal: ["일일 장비 가동 실적 집계를 자동화해 보고서를 자동 생성"],
    toBe: ["공유 폴더 자동 수집 후 보고서까지 무인 생성"],
    inScope: ["공유 폴더 자동 수집", "가동률 자동 계산", "AI 컬럼 매핑 후보 제안"],
    outOfScope: ["최종 승인 자동화"],
    prerequisites: ["공유 폴더 접근 권한 확인", "공유 폴더 접근 권한 확인", "보고서 템플릿 확인"],
    humanInLoop: ["담당자 최종 승인"],
    implementation: ["공유 폴더 자동 수집", "AI 컬럼 매핑 후보 제안", "가동률 자동 계산", "최종 승인 자동화"],
    dataFlow: ["실적 Excel → 매핑 후보 → 담당자 확인"],
    integrations: ["공유 폴더 연동 (확인 필요)"],
    exceptions: ["매핑 실패 컬럼 분리", "파일 형식 변동"],
    fallback: ["수동 집계로 전환"],
    security: ["실적 파일 외부 전송 전 보안 조건 확인"],
    tests: ["샘플 실적으로 매핑 후보 확인"],
    acceptance: ["누락·중복 건수가 수동 검토와 동일하거나 감소", "매핑 후보를 담당자가 확정한 뒤에만 결과 반영"],
  }),
};

/** The AI-assisted draft and rule-based validation remain permitted; unattended report publication is future work. */
export const equipmentRuleCase: AxAgentCase = {
  ...equipmentCase,
  diagnosis: {
    ...equipmentCase.diagnosis,
    asIs: { ...equipmentCase.diagnosis.asIs, steps: [...equipmentCase.diagnosis.asIs.steps.filter(s => s !== "데이터 표준화"), "일일 보고서 자동 발행"] },
    stepAssessments: [
      ...equipmentCase.diagnosis.stepAssessments.slice(0, -1).filter(s => s.step !== "데이터 표준화").map(s => s.step === "누락·중복 검증"
        ? step(s.step, "AI 보조", "AI", "확정된 필수값·중복 식별 기준을 적용하는 규칙 기반 검증, 담당자 예외 검토")
        : s.step === "AI 컬럼 매핑" ? step("컬럼 매핑 및 표준화", "AI 보조", "AI", "표준 항목 후보와 변환 결과를 담당자가 검토") : s),
      step("일일 보고서 자동 발행", "자동화", "시스템", "승인 후 발행 조건 미확정"),
      equipmentCase.diagnosis.stepAssessments.at(-1)!,
    ],
    poc: {
      ...equipmentCase.diagnosis.poc,
      outputs: [...equipmentCase.diagnosis.poc.outputs, "일일 보고서 자동 발행 결과"],
      evaluation: [...equipmentCase.diagnosis.poc.evaluation, "일일 보고서 자동 발행 결과 대조"],
      success: [...equipmentCase.diagnosis.poc.success, "일일 보고서 자동 발행 성공"],
    },
  },
  plan: plan({
    ...equipmentCase.plan,
    inScope: [...equipmentCase.plan.inScope.filter(s => s !== "AI 컬럼 매핑 후보 제안"), "컬럼 매핑 및 표준화 후보 제안", "일일 보고서 자동 발행"],
    implementation: [...equipmentCase.plan.implementation.filter(s => s !== "AI 컬럼 매핑 후보 제안"), "컬럼 매핑 및 표준화 후보 제안", "일일 보고서 자동 발행", "테스트: 일일 보고서 자동 발행 결과 파일 재열기"],
    tests: ["일일 보고서 자동 발행 결과 파일 재열기", "보고서 초안 작성 후 담당자 검토 확인"],
    acceptance: ["일일 보고서 자동 발행 완료", "보고서 초안 작성 후 담당자가 확인"],
  }),
};

/** Level 2 · 부분 자동화 (가치 4, 실현 4, 판단 3, 위험 2), 진행 가능. */
export const contractCase: AxAgentCase = {
  name: "계약 갱신 일정 관리",
  description: "계약 관리 대장의 만료일을 확인해 갱신 대상 계약을 정리하고, 갱신 안내 초안을 만들면 담당자가 갱신 여부를 판단합니다.",
  diagnosis: diagnosis([5, 4, 4, 4, 3, 2], {
    asIs: {
      purpose: "계약 만료 전 갱신 여부를 판단할 시간을 확보", trigger: "매주 월요일",
      inputs: ["계약 관리 대장"], steps: ["만료 예정 계약 추출", "갱신 안내 초안 작성", "갱신 여부 판단"], outputs: ["갱신 대상 목록", "갱신 안내 초안"],
      exceptions: ["만료일 누락", "자동 연장 조항이 있는 계약"], humanDecisions: ["갱신 여부 판단"], systems: ["계약 관리 대장"],
    },
    stepAssessments: [
      step("만료 예정 계약 추출", "자동화", "시스템", "만료일 기준 정해진 기간 안의 계약"),
      step("갱신 안내 초안 작성", "AI 보조", "AI", "담당자가 문구 확정"),
      step("갱신 여부 판단", "사람 유지", "사용자", "계약 조건 판단"),
    ],
    toBe: [{ step: "만료 대상 추출", owner: "시스템", description: "대장에서 만료 예정 계약 목록 생성" }, { step: "갱신 판단", owner: "사용자", description: "담당자가 갱신 여부 결정" }],
    humanInLoop: ["갱신 여부 판단"],
    technicalChecks: [{ topic: "계약 관리 대장 접근", status: "확인됨", note: "읽기 가능한 대장 사용" }],
    risks: ["만료일이 잘못 입력된 계약 누락"],
    poc: { hypothesis: "만료 예정 계약을 빠짐없이 추출할 수 있다", inScope: [], outOfScope: ["갱신 계약 자동 체결"], inputs: ["계약 관리 대장 샘플"], outputs: ["갱신 대상 목록"], evaluation: ["샘플 대장에서 만료 예정 계약 목록 대조"], success: ["샘플의 만료 예정 계약이 모두 목록에 포함"], failure: ["만료일 누락 계약이 정상 목록에 섞임"] },
    decisionGate: { verdict: "go", reasons: [] },
  }),
  plan: plan({ goal: ["만료 예정 계약 목록과 갱신 안내 초안 제공"], inScope: ["만료 예정 계약 추출", "갱신 안내 초안"], outOfScope: ["갱신 계약 자동 체결"], implementation: ["대장 읽기", "만료 예정 계약 추출", "갱신 안내 초안 생성"], tests: ["만료일 누락 계약 분리"], acceptance: ["샘플 대장의 만료 예정 계약이 모두 목록에 포함"] }),
};

/** Level 1 · AI 보조 (가치 4, 실현 3, 판단 4, 위험 3), 확인 후 진행 (개인정보·외부 AI 전송 조건). */
export const inquiryCase: AxAgentCase = {
  name: "고객 문의 분류 및 답변 초안",
  description: "접수된 고객 문의를 유형별로 분류하고 답변 초안을 만든 뒤, 담당자가 내용을 확인해 발송합니다.",
  diagnosis: diagnosis([5, 3, 3, 3, 4, 3], {
    asIs: {
      purpose: "고객 문의에 빠르고 일관되게 답변", trigger: "문의 접수 시",
      inputs: ["고객 문의 내용"], steps: ["문의 유형 분류", "답변 초안 작성", "답변 발송"], outputs: ["답변 초안"],
      exceptions: ["분류할 수 없는 문의", "개인정보가 포함된 문의"], humanDecisions: ["답변 발송 여부"], systems: ["문의 접수 화면"],
    },
    stepAssessments: [
      step("문의 유형 분류", "AI 보조", "AI", "분류 후보 제시"),
      step("답변 초안 작성", "AI 보조", "AI", "초안만 제시"),
      step("답변 발송", "사람 유지", "사용자", "담당자 확인 후 발송"),
    ],
    toBe: [{ step: "분류·초안", owner: "AI", description: "문의 유형 후보와 답변 초안 제시" }, { step: "발송", owner: "사용자", description: "담당자가 수정 후 발송" }],
    humanInLoop: ["답변 발송 전 담당자 확인"],
    technicalChecks: [{ topic: "외부 AI 전송", status: "확인 필요", note: "개인정보 포함 문의의 외부 전송 가능 여부" }],
    risks: ["부정확한 답변 발송"],
    poc: { hypothesis: "분류 후보와 초안이 담당자 작성 시간을 줄인다", inScope: [], outOfScope: ["답변 자동 발송"], inputs: ["익명화된 문의 샘플"], outputs: ["분류 후보와 답변 초안"], evaluation: ["담당자가 분류한 결과와 대조"], success: ["샘플 문의의 분류 후보가 담당자 분류와 일치"], failure: ["분류 불가 문의가 임의 유형으로 표시"] },
    decisionGate: { verdict: "conditional", reasons: ["개인정보 처리 조건 확인 후 진행"] },
  }),
  plan: plan({ goal: ["분류 후보와 답변 초안 제공"], inScope: ["문의 분류 후보", "답변 초안"], outOfScope: ["답변 자동 발송"], implementation: ["문의 입력", "분류 후보 제시", "답변 초안 제시"], tests: ["분류 불가 문의 분리"], acceptance: ["샘플 문의의 분류 후보가 담당자 분류와 일치"] }),
};

/** Level 3 · 고도 자동화 (가치 5, 실현 5, 판단 2, 위험 2), 진행 가능. */
export const facilityCase: AxAgentCase = {
  name: "시설 보수 요청 접수·우선순위 검토",
  description: "시설 보수 요청을 접수해 필수 정보를 확인하고 우선순위 후보를 정리하면, 담당자가 업체를 선정합니다.",
  diagnosis: diagnosis([5, 5, 5, 4, 2, 2], {
    asIs: {
      purpose: "보수 요청을 빠짐없이 접수하고 처리 순서를 정함", trigger: "요청 접수 시",
      inputs: ["보수 요청서"], steps: ["요청 접수", "필수 정보 확인", "우선순위 후보 산정", "업체 선정"], outputs: ["접수 목록", "우선순위 후보"],
      exceptions: ["위치·내용이 빠진 요청", "중복 접수"], humanDecisions: ["업체 선정"], systems: ["요청 접수 양식"],
    },
    stepAssessments: [
      step("요청 접수", "자동화", "시스템", "접수 양식 기준"),
      step("필수 정보 확인", "자동화", "시스템", "필수 항목 누락 표시"),
      step("우선순위 후보 산정", "AI 보조", "AI", "담당자가 최종 순서 확정"),
      step("업체 선정", "사람 유지", "사용자", "계약·비용 판단"),
    ],
    toBe: [{ step: "접수·확인", owner: "시스템", description: "요청 접수와 필수 정보 확인" }, { step: "업체 선정", owner: "사용자", description: "담당자가 업체 선정" }],
    humanInLoop: ["업체 선정"],
    technicalChecks: [{ topic: "요청 접수 양식", status: "확인됨", note: "필수 항목 정의됨" }],
    risks: ["긴급 요청이 낮은 순위로 분류"],
    poc: { hypothesis: "필수 정보 누락 요청을 즉시 분리할 수 있다", inScope: [], outOfScope: ["업체 자동 발주"], inputs: ["보수 요청 샘플"], outputs: ["접수 목록"], evaluation: ["샘플 요청의 누락 항목 대조"], success: ["누락 요청이 모두 검토 필요로 분리"], failure: ["누락 요청이 정상 접수로 처리"] },
    decisionGate: { verdict: "go", reasons: [] },
    operation: { owner: "시설 담당", failureOwner: "운영 담당", maintenanceBurden: "low", fallback: "기존 접수 대장으로 처리", notes: ["접수 양식 변경 시 규칙 점검"] },
  }),
  plan: plan({ goal: ["보수 요청 접수와 필수 정보 확인 자동화"], inScope: ["요청 접수", "필수 정보 확인", "우선순위 후보"], outOfScope: ["업체 자동 발주"], implementation: ["요청 접수", "필수 정보 확인", "우선순위 후보 산정"], tests: ["중복 접수 처리"], acceptance: ["누락 요청이 모두 검토 필요로 분리"] }),
};

/** Level 0 · 수동 유지 (판단 5, 위험 5), 진행 보류 (no-go). */
export const permitCase: AxAgentCase = {
  name: "작업 허가 및 안전조치 승인",
  description: "작업 허가 신청을 받아 안전조치 이행을 확인하고 허가를 승인합니다.",
  diagnosis: diagnosis([3, 3, 2, 2, 5, 5], {
    asIs: {
      purpose: "위험 작업 전 안전조치 이행 확인", trigger: "작업 허가 신청 시",
      inputs: ["작업 허가 신청서"], steps: ["허가 신청 접수", "안전조치 확인", "허가 승인"], outputs: ["작업 허가서"],
      exceptions: ["안전조치 미이행"], humanDecisions: ["안전조치 확인", "허가 승인"], systems: [],
    },
    stepAssessments: [
      step("허가 신청 접수", "자동화", "시스템", "신청서 형식 확인"),
      step("안전조치 확인", "사람 유지", "사용자", "현장 확인 필요"),
      step("허가 승인", "사람 유지", "사용자", "법적 책임"),
    ],
    toBe: [{ step: "접수", owner: "시스템", description: "신청서 접수" }, { step: "승인", owner: "사용자", description: "담당자 승인" }],
    humanInLoop: ["안전조치 확인", "허가 승인"],
    technicalChecks: [{ topic: "허가 승인 자동화", status: "불가", note: "법적 책임이 담당자에게 있음" }],
    risks: ["안전조치 미이행 상태의 작업 허가"],
    poc: { hypothesis: "", inScope: [], outOfScope: ["허가 자동 승인"], inputs: [], outputs: [], evaluation: [], success: [], failure: [] },
    decisionGate: { verdict: "no-go", reasons: ["안전 승인은 담당자의 법적 책임"] },
  }),
  plan: plan({ goal: ["작업 허가 자동 승인"], inScope: ["허가 자동 승인", "신청서 접수"], implementation: ["허가 자동 승인"], acceptance: ["허가 처리 시간 단축"] }),
};


/** Level 1 conditional freight work keeps local assistance separate from settlement automation. */
export const freightCase: AxAgentCase = {
  name: "월간 운임 정산",
  description: "운송 실적 파일을 합치고 누락·중복을 검증한 뒤 정산표를 생성해 담당자가 승인합니다. 월말 일정은 담당자가 실행 시점을 정하는 기준입니다.",
  diagnosis: diagnosis([4, 4, 3, 2, 4, 3], {
    asIs: {
      purpose: "월간 운임 정산 검토", trigger: "매월 말 담당자 실행",
      inputs: ["운송 실적 Excel", "운임표"], steps: ["실적 파일 병합", "누락·중복 검증", "정산표 생성", "정산 승인"],
      outputs: ["정산표 생성 결과"], exceptions: ["운임표 미매칭", "운송장 중복"],
      humanDecisions: ["정산 승인"], systems: ["Excel", "ERP"],
    },
    stepAssessments: [
      step("실적 파일 병합", "AI 보조", "AI", "로컬 스크립트로 Excel 파일을 병합하고 담당자가 결과를 확인"),
      step("누락·중복 검증", "AI 보조", "AI", "필수 항목 누락과 운송장 번호 중복 여부를 검사하는 규칙 기반 알고리즘"),
      step("정산표 생성", "자동화", "시스템", "확정 운임표에 따라 금액 계산 후 정산표 생성"),
      step("정산 승인", "사람 유지", "사용자", "담당자가 금액 검토 후 승인"),
    ],
    toBe: [
      { step: "실적 파일 병합", owner: "시스템", description: "로컬 스크립트로 병합" },
      { step: "누락·중복 검증", owner: "시스템", description: "확정 규칙으로 누락·중복 검사" },
      { step: "정산 승인", owner: "사용자", description: "담당자가 승인" },
    ],
    humanInLoop: ["정산 승인"],
    technicalChecks: [
      { topic: "실적 파일 병합", status: "확인 필요", note: "Excel 샘플 확보" },
      { topic: "ERP", status: "확인 필요", note: "읽기 권한 확인" },
      { topic: "Excel", status: "확인됨", note: "로컬 파일 사용 가능" },
    ],
    poc: {
      hypothesis: "검토할 누락·중복을 표시할 수 있다", inScope: [], outOfScope: ["정산 자동 승인", "ERP 자동 전송"],
      inputs: ["운송 실적 샘플"], outputs: ["실적 파일 병합 — 병합 검토 파일", "정산표 생성 결과"],
      evaluation: ["누락·중복 검증 — 샘플 누락·중복 검사", "정산표 생성 결과 대조"],
      success: ["누락·중복 검증 — 누락 건이 모두 검토 대상으로 표시", "누락·중복 검증 — 정확도 95% 이상", "누락·중복 검증 — 수동 결과와 대조하고 차이 기록", "정산표 생성 완료"],
      failure: ["누락 건이 정상 결과로 표시"],
    },
    decisionGate: { verdict: "conditional", reasons: ["Excel 샘플과 운임표 확인 후 진행"] },
  }),
  plan: plan({
    inScope: ["실적 파일 병합", "누락·중복 검증", "정산표 생성"],
    implementation: ["실적 파일 병합", "누락·중복 검증", "정산표 생성"],
    prerequisites: ["실적 파일 병합 — Excel 샘플 확보", "정산표 생성 — 운임표 확정", "ERP — 읽기 권한 확인"],
    tests: ["누락·중복 검증 — 샘플 누락·중복 검사", "정산표 생성 결과 대조"],
    acceptance: ["누락·중복 검증 — 누락 건이 모두 검토 대상으로 표시", "정산표 생성 완료"],
    outOfScope: ["정산 자동 승인", "ERP 자동 전송"], humanInLoop: ["정산 승인"],
  }),
};
export const agentCases = [equipmentCase, contractCase, inquiryCase, facilityCase, permitCase] as const;
