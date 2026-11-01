import type { AxDiagnosis, DecisionPointId, GenericRule } from "../../src/lib/ax/types";
import { diagnosisFixture } from "./ax";

/** Hand-authored business expectations; deliberately independent of deriveUnifiedRules. */
export interface AxRuleDerivationFixture {
  id: string;
  label: string;
  taskName: string;
  diagnosis: AxDiagnosis;
  storedGenericRules?: readonly GenericRule[];
  expectedDecisionIds: readonly DecisionPointId[];
  excludedDecisionIds: readonly DecisionPointId[];
  /** Each inner list must occur together in a generic rule's name/detail. */
  requiredGenericRules: readonly (readonly string[])[];
  excludedGenericRules: readonly string[];
  boundaries: readonly string[];
}

export function ruleDerivationDiagnosis(patch: Partial<AxDiagnosis> = {}): AxDiagnosis {
  return {
    ...structuredClone(diagnosisFixture),
    informationSufficiency: "sufficient",
    followUpQuestions: [],
    asIs: { purpose: "", trigger: "", inputs: [], steps: [], outputs: [], exceptions: [], humanDecisions: [], systems: [] },
    stepAssessments: [],
    toBe: [],
    humanInLoop: [],
    technicalChecks: [],
    risks: [],
    poc: { hypothesis: "", inScope: [], outOfScope: [], inputs: [], outputs: [], evaluation: [], success: [], failure: [] },
    decisionGate: { verdict: "go", reasons: [] },
    roadmap: [],
    operation: { owner: "업무 담당자", failureOwner: "업무 담당자", maintenanceBurden: "low", fallback: "", notes: [] },
    nextAction: { label: "업무 규칙 검토", detail: "등록한 처리 조건을 검토한다" },
    sourceNote: "업무 담당자가 제공한 단계와 처리 조건",
    ...patch,
  };
}

export const excelComparisonFixture: AxRuleDerivationFixture = {
  id: "excel-comparison-aggregation",
  label: "Excel 대조·집계",
  taskName: "월간 업무 처리",
  diagnosis: ruleDerivationDiagnosis({
    asIs: {
      purpose: "수신한 매출 Excel 파일과 입금 Excel 파일을 주문번호로 대조하고 월별 금액을 합산한다",
      trigger: "월말 파일 수신",
      inputs: ["매출 Excel 파일", "입금 Excel 파일"],
      steps: ["두 파일을 수신한다", "주문번호로 매출 내역과 입금 내역을 대조한다", "월별 매출 금액을 합산한다", "일치·불일치·검토 필요 상태로 결과를 구분한다"],
      outputs: ["월별 대조 집계표"],
      exceptions: ["동일 주문번호가 중복 입력되면 담당자 검토로 보낸다", "금액 형식 오류는 오류 목록에 기록한다", "빈 파일 또는 누락된 파일이면 집계를 중단한다", "주문번호가 없어 판단 불가하면 검토 필요로 보낸다"],
      humanDecisions: ["불일치 금액은 담당자가 검토한 후 집계 결과를 승인한다"],
      systems: ["Excel"],
    },
    stepAssessments: [{ step: "주문번호 대조와 월별 금액 합산", verdict: "자동화", owner: "시스템", note: "대조 키와 합산 기준을 확인한다" }],
    toBe: [{ step: "대조 집계", owner: "시스템", description: "매출과 입금을 대조하고 월별 합계를 생성한다" }],
    humanInLoop: ["불일치 금액은 담당자가 검토한 후 집계 결과를 승인한다"],
    poc: { hypothesis: "월별 대조와 집계", inScope: ["주문번호 대조", "금액 합산"], outOfScope: ["자동 승인"], inputs: ["월별 원본 파일"], outputs: ["집계표"], evaluation: ["수작업 결과와 금액 대조"], success: ["일치·불일치·검토 필요로 구분"], failure: ["빈 파일 또는 누락 파일 수신"] },
  }),
  expectedDecisionIds: ["D1", "D2", "D3", "D4", "D5", "D6", "D7"],
  excludedDecisionIds: [],
  requiredGenericRules: [["불일치 금액", "담당자", "승인"]],
  excludedGenericRules: ["이메일 발송", "안전점검", "작업 허가"],
  boundaries: ["C"],
};

export const equipmentAggregationFixture: AxRuleDerivationFixture = {
  id: "equipment-run-aggregation",
  label: "장비 가동 실적 집계",
  taskName: "장비 실적 관리",
  diagnosis: ruleDerivationDiagnosis({
    asIs: {
      purpose: "수신한 장비 가동 기록 데이터를 일자별로 합산해 가동률을 계산한다",
      trigger: "매일 장비 기록 수신",
      inputs: ["설비 API에서 수신한 가동 기록 데이터"],
      steps: ["가동 기록 데이터를 수신한다", "장비 ID와 시작 시각이 같은 중복 기록을 검토한다", "일자별 가동 시간을 합산하고 전체 시간 대비 가동률을 계산한다", "정상·오류·검토 필요로 결과 상태를 구분한다"],
      outputs: ["일별 가동률 보고서"],
      exceptions: ["종료 시각이 시작 시각보다 빠르면 오류로 기록한다", "수신 데이터가 없으면 집계를 보류한다", "종료 시각 누락으로 가동 시간을 판단할 수 없으면 검토 필요로 보낸다"],
      humanDecisions: ["종료 시각 누락 기록은 현장 담당자가 확인한 후 집계에 포함한다"],
      systems: ["설비 기록 API", "사내 보고 화면"],
    },
    toBe: [{ step: "가동률 집계", owner: "시스템", description: "일자별 가동 시간 합산과 가동률 계산" }],
  }),
  expectedDecisionIds: ["D2", "D3", "D4", "D5", "D6", "D7"],
  excludedDecisionIds: ["D1"],
  requiredGenericRules: [["종료 시각 누락", "현장 담당자", "집계에 포함"]],
  excludedGenericRules: ["매출", "입금", "자동 승인"],
  boundaries: ["A", "C"],
};

export const facilitySafetyFixture: AxRuleDerivationFixture = {
  id: "facility-safety",
  label: "파일 없는 시설 안전점검",
  taskName: "현장 점검",
  diagnosis: ruleDerivationDiagnosis({
    asIs: {
      purpose: "현장 관찰을 통해 시설 위험 여부를 판정하고 필요한 조치를 정한다",
      trigger: "현장 순회",
      inputs: ["점검자의 현장 관찰", "안전 수칙"],
      steps: ["현장을 육안으로 점검한다", "안전·위험·판단 불가 상태로 구분한다", "위험 징후가 있으면 안전관리자가 위험 여부를 검토하고 작업을 중지한다"],
      outputs: ["현장 조치 안내"],
      exceptions: ["보호장치가 파손되면 작업을 중지한다", "접근 불가 구역은 판단 불가로 남기고 재점검한다"],
      humanDecisions: ["위험 징후가 있으면 안전관리자가 위험 여부를 검토하고 작업을 중지한다"],
      systems: [],
    },
    stepAssessments: [{ step: "위험 여부 판정", verdict: "사람 유지", owner: "사용자", note: "현장 안전관리자의 판단을 유지한다" }],
    humanInLoop: ["위험 징후가 있으면 안전관리자가 위험 여부를 검토하고 작업을 중지한다"],
    poc: { hypothesis: "현장 조치 안내", inScope: ["위험 분류 지원"], outOfScope: ["파일 수신", "위험 판정 자동 확정"], inputs: [], outputs: ["조치 안내"], evaluation: [], success: [], failure: [] },
  }),
  expectedDecisionIds: ["D3", "D4", "D5"],
  excludedDecisionIds: ["D1", "D2", "D6", "D7"],
  requiredGenericRules: [["위험 징후", "안전관리자", "작업을 중지"]],
  excludedGenericRules: ["빈 파일", "Excel", "금액 합산", "이메일 발송"],
  boundaries: ["B"],
};

export const customerRequestFixture: AxRuleDerivationFixture = {
  id: "customer-requests",
  label: "고객 문의 응대",
  taskName: "고객 문의 처리",
  diagnosis: ruleDerivationDiagnosis({
    asIs: {
      purpose: "전화로 들은 고객 문의를 분류하고 답변한다",
      trigger: "고객 전화",
      inputs: ["통화 중 고객의 문의 내용"],
      steps: ["고객 문의를 듣는다", "동일 고객의 중복 요청은 기존 응대 이력을 확인한다", "접수·답변 완료·검토 필요 상태로 구분한다", "고위험 문의는 담당자가 검토한 후 답변한다"],
      outputs: ["고객에게 전달한 답변"],
      exceptions: ["요청 조건이 맞지 않으면 담당자에게 전달한다", "고객 정보가 부족해 판단할 수 없으면 추가 내용을 문의한다"],
      humanDecisions: ["고위험 문의는 담당자가 검토한 후 답변한다"],
      systems: ["전화기", "상담 안내 화면"],
    },
    humanInLoop: ["고위험 문의는 담당자가 검토한 후 답변한다"],
  }),
  expectedDecisionIds: ["D2", "D3", "D4", "D5"],
  excludedDecisionIds: ["D1", "D6", "D7"],
  requiredGenericRules: [["고위험 문의", "담당자", "답변"]],
  excludedGenericRules: ["빈 파일", "합계", "반올림", "계약 승인"],
  boundaries: ["A"],
};

export const contractReviewFixture: AxRuleDerivationFixture = {
  id: "contract-review",
  label: "계약서 검토",
  taskName: "계약 검토",
  diagnosis: ruleDerivationDiagnosis({
    asIs: {
      purpose: "이미 열린 계약서의 조항을 검토하고 법무 검토가 필요한 내용을 표시한다",
      trigger: "계약 조항 검토 요청",
      inputs: ["화면에 열린 계약 조항", "내부 계약 검토 지침"],
      steps: ["계약 조항을 읽는다", "적합·수정 필요·판단 불가로 검토 상태를 구분한다", "책임 제한 조항은 법무 담당자가 검토한 후 승인한다"],
      outputs: ["조항별 검토 의견"],
      exceptions: ["필수 조항이 누락되면 수정 필요로 표시한다", "근거가 부족해 법적 판단을 할 수 없으면 법무 검토로 보낸다"],
      humanDecisions: ["책임 제한 조항은 법무 담당자가 검토한 후 승인한다"],
      systems: ["계약 열람 화면"],
    },
    stepAssessments: [{ step: "책임 제한 조항 검토", verdict: "사람 유지", owner: "사용자", note: "법무 담당자가 판단한다" }],
  }),
  expectedDecisionIds: ["D3", "D4", "D5"],
  excludedDecisionIds: ["D1", "D2", "D6", "D7"],
  requiredGenericRules: [["책임 제한 조항", "법무 담당자", "승인"]],
  excludedGenericRules: ["빈 파일", "금액 합산", "안전관리자", "이메일 발송"],
  boundaries: [],
};

export const workPermitFixture: AxRuleDerivationFixture = {
  id: "work-permit-approval",
  label: "작업 허가·승인",
  taskName: "현장 점검",
  diagnosis: ruleDerivationDiagnosis({
    asIs: {
      purpose: "현장에서 구두로 요청한 작업의 허가 여부를 판단한다",
      trigger: "작업자의 구두 허가 요청",
      inputs: ["현장에서 설명한 작업 내용"],
      steps: ["작업 요청을 듣는다", "동일 작업의 중복 허가 요청은 기존 승인 여부를 확인한다", "승인·반려·보류로 결과 상태를 구분한다", "위험 작업은 안전관리자가 검토한 후 작업을 승인한다"],
      outputs: ["작업 허가 안내"],
      exceptions: ["안전 조건이 불충족하면 작업을 반려한다", "작업 범위가 불명확해 판단할 수 없으면 보류한다"],
      humanDecisions: ["위험 작업은 안전관리자가 검토한 후 작업을 승인한다"],
      systems: [],
    },
    humanInLoop: ["위험 작업은 안전관리자가 검토한 후 작업을 승인한다"],
  }),
  expectedDecisionIds: ["D2", "D3", "D4", "D5"],
  excludedDecisionIds: ["D1", "D6", "D7"],
  requiredGenericRules: [["위험 작업", "안전관리자", "작업을 승인"]],
  excludedGenericRules: ["빈 파일", "가동률", "금액 합산", "이메일 발송"],
  boundaries: ["I"],
};

export const scheduleNotificationFixture: AxRuleDerivationFixture = {
  id: "schedule-notification",
  label: "일정·알림",
  taskName: "일정 알림",
  diagnosis: ruleDerivationDiagnosis({
    asIs: {
      purpose: "이미 등록된 일정의 시작 시각에 이메일 알림을 발송한다",
      trigger: "일정 시작 시각",
      inputs: ["화면에 등록된 일정"],
      steps: ["일정 시작 시각에 발송을 실행한다", "동일 일정의 알림 중복 실행을 차단한다", "발송 완료·발송 실패 상태로 구분한다"],
      outputs: ["이메일 알림"],
      exceptions: ["이메일 발송 실패 시 재시도 후 오류 기록"],
      humanDecisions: [],
      systems: ["일정 화면", "이메일 서비스"],
    },
    toBe: [{ step: "이메일 알림 발송", owner: "시스템", description: "이메일 발송 실패 시 재시도 후 오류 기록" }],
    technicalChecks: [{ topic: "이메일 API 제공 여부 확인", status: "확인 필요", note: "이메일 API 제공 여부 확인. 이메일 발송 실패 시 재시도 후 오류 기록" }],
  }),
  expectedDecisionIds: ["D2", "D3", "D4"],
  excludedDecisionIds: ["D1", "D5", "D6", "D7"],
  requiredGenericRules: [["이메일 발송 실패", "재시도", "오류 기록"]],
  excludedGenericRules: ["이메일 API 제공 여부 확인", "담당자 승인", "빈 파일", "반올림"],
  boundaries: ["A", "J"],
};

export const filelessWorkFixture: AxRuleDerivationFixture = {
  id: "fileless-reference-viewing",
  label: "파일 없는 단순 열람",
  taskName: "자료 확인",
  diagnosis: ruleDerivationDiagnosis({
    asIs: {
      purpose: "담당자가 이미 공개된 안내 문구를 화면에서 읽는다",
      trigger: "담당자가 안내 화면을 연다",
      inputs: [],
      steps: ["고정된 안내 화면을 연다", "공개 안내 문구를 읽고 화면을 닫는다"],
      outputs: [],
      exceptions: [],
      humanDecisions: [],
      systems: ["안내 열람 화면"],
    },
    stepAssessments: [{ step: "안내 문구 열람", verdict: "사람 유지", owner: "사용자", note: "내용을 읽기만 하는 단순 열람 단계" }],
    toBe: [{ step: "안내 문구 열람", owner: "사용자", description: "고정 안내 화면을 열어 읽는다" }],
    poc: { hypothesis: "고정 안내 문구 단순 열람", inScope: ["안내 문구 열람"], outOfScope: ["파일 수신", "데이터 수집", "대조", "계산", "승인", "알림 발송"], inputs: [], outputs: [], evaluation: [], success: [], failure: [] },
  }),
  expectedDecisionIds: [],
  excludedDecisionIds: ["D1", "D2", "D3", "D4", "D5", "D6", "D7"],
  requiredGenericRules: [],
  excludedGenericRules: ["승인", "검토 기준", "빈 파일", "계산", "완료 기준"],
  boundaries: ["H"],
};

export const compositeWorkFixture: AxRuleDerivationFixture = {
  id: "composite",
  label: "수집·대조·집계·승인·발송 복합 업무",
  taskName: "월간 업무 처리",
  diagnosis: ruleDerivationDiagnosis({
    asIs: {
      purpose: "작업 실적 파일을 수신해 작업계획과 대조하고 합산한 뒤 담당자 승인 후 보고한다",
      trigger: "일일 보고 시각",
      inputs: ["수신한 작업 실적 파일", "작업계획 데이터"],
      steps: ["실적 파일을 수신한다", "작업번호로 실적과 작업계획을 대조한다", "동일 작업번호의 중복 기록을 검토한다", "작업 시간 합계와 가동률을 계산한다", "정상·불일치·판단 불가로 결과를 구분한다", "계획과 불일치한 실적은 관리자가 검토한 후 보고를 승인한다", "승인 후 이메일 보고서를 발송한다"],
      outputs: ["승인된 실적 보고서"],
      exceptions: ["빈 파일 또는 누락된 파일은 집계를 보류한다", "작업 시간 형식이 잘못되면 오류로 기록한다", "근거가 부족해 판단할 수 없으면 관리자 검토로 보낸다", "이메일 발송 실패 시 재시도 후 오류 기록"],
      humanDecisions: ["계획과 불일치한 실적은 관리자가 검토한 후 보고를 승인한다"],
      systems: ["실적 수신 화면", "작업계획 화면", "이메일 서비스"],
    },
    toBe: [{ step: "승인 후 보고", owner: "시스템", description: "이메일 발송 실패 시 재시도 후 오류 기록" }],
    humanInLoop: ["계획과 불일치한 실적은 관리자가 검토한 후 보고를 승인한다"],
    technicalChecks: [{ topic: "이메일 API 제공 여부 확인", status: "확인 필요", note: "연동 권한과 API 지원 범위 확인" }],
  }),
  expectedDecisionIds: ["D1", "D2", "D3", "D4", "D5", "D6", "D7"],
  excludedDecisionIds: [],
  requiredGenericRules: [["계획과 불일치한 실적", "관리자", "보고를 승인"], ["이메일 발송 실패", "재시도", "오류 기록"]],
  excludedGenericRules: ["이메일 API 제공 여부 확인", "계약서 법무 검토", "고객 문의 답변"],
  boundaries: ["C", "I", "J"],
};

/** Shared by deterministic tests and screenshot/evidence tooling. */
export const axRuleDerivationFixtures: readonly AxRuleDerivationFixture[] = [
  excelComparisonFixture,
  equipmentAggregationFixture,
  facilitySafetyFixture,
  customerRequestFixture,
  contractReviewFixture,
  workPermitFixture,
  scheduleNotificationFixture,
  filelessWorkFixture,
  compositeWorkFixture,
];

/** Insufficient context must not be presented as a completed no-rule review. */
export const insufficientDerivationDiagnoses: readonly AxDiagnosis[] = [
  ruleDerivationDiagnosis({ informationSufficiency: "needs-check", followUpQuestions: ["어떤 순서로 업무를 처리하나요?"] }),
  ruleDerivationDiagnosis({ informationSufficiency: "partial", asIs: { purpose: "안전점검", trigger: "", inputs: [], steps: [], outputs: [], exceptions: [], humanDecisions: [], systems: [] } }),
  ruleDerivationDiagnosis({ informationSufficiency: "needs-check", asIs: { purpose: "", trigger: "", inputs: ["자료"], steps: [], outputs: [], exceptions: [], humanDecisions: [], systems: ["화면 A", "화면 B"] } }),
];

export function approvalConditionDiagnosis(items: readonly { topic: string; note: string }[]): AxDiagnosis {
  return ruleDerivationDiagnosis({
    asIs: { purpose: "현장 작업 조건에 따라 승인한다", trigger: "작업 요청", inputs: [], steps: ["작업 요청을 듣는다", "승인 또는 보류로 결과를 구분한다"], outputs: ["작업 허가 안내"], exceptions: [], humanDecisions: [], systems: [] },
    technicalChecks: items.map(item => ({ ...item, status: "확인 필요" as const })),
    poc: { hypothesis: "승인 조건별 결과 확인", inScope: ["등록한 작업 조건 확인"], outOfScope: [], inputs: [], outputs: ["작업 허가 안내"], evaluation: [], success: ["승인 또는 보류 상태 구분"], failure: [] },
  });
}

export const sameNameDifferentConditionsFixture: AxRuleDerivationFixture = {
  id: "boundary-d-same-name-different-conditions",
  label: "D: 같은 이름·다른 조건",
  taskName: "현장 작업 승인",
  diagnosis: approvalConditionDiagnosis([
    { topic: "담당자 검토", note: "위험 작업은 안전관리자가 검토한 후 승인한다" },
    { topic: "담당자 검토", note: "야간 작업은 현장책임자가 검토한 후 승인한다" },
  ]),
  expectedDecisionIds: ["D4"],
  excludedDecisionIds: ["D1", "D2", "D3", "D5", "D6", "D7"],
  requiredGenericRules: [["위험 작업", "안전관리자", "승인"], ["야간 작업", "현장책임자", "승인"]],
  excludedGenericRules: ["자동 승인", "빈 파일"],
  boundaries: ["D"],
};

export const differentNamesSameConditionFixture: AxRuleDerivationFixture = {
  id: "boundary-e-different-names-same-condition",
  label: "E: 다른 이름·같은 조건",
  taskName: "현장 작업 승인",
  diagnosis: approvalConditionDiagnosis([
    { topic: "담당자 검토", note: "위험 작업은 안전관리자가 검토한 후 승인한다" },
    { topic: "최종 확인", note: "위험 작업은 안전관리자가 검토한 후 승인한다" },
  ]),
  expectedDecisionIds: ["D4"],
  excludedDecisionIds: ["D1", "D2", "D3", "D5", "D6", "D7"],
  requiredGenericRules: [["위험 작업", "안전관리자", "승인"]],
  excludedGenericRules: ["야간 작업", "빈 파일"],
  boundaries: ["E"],
};

export const preservedSavedRulesFixture: AxRuleDerivationFixture = {
  id: "boundary-f-preserve-saved",
  label: "F: 새 진단에 없는 저장 규칙 보존",
  taskName: "자료 확인",
  diagnosis: {
    ...structuredClone(filelessWorkFixture.diagnosis),
    decisionPoints: [
      { id: "D1", status: "확정", detail: "사용자 지정 대조 기준" },
      { id: "D3", status: "미확정", detail: "작성 중 예외 메모" },
      { id: "D6", status: "해당 없음", detail: "파일을 수신하지 않는 업무" },
    ],
  },
  storedGenericRules: [
    { id: "R7", name: "기존 확정 규칙", category: "권한·검토 기준", applicability: "적용", status: "확정", detail: "팀장 승인 후 보고한다", source: "운영지침", step: "최종 보고", linkedDecisionId: "D4" },
    { id: "R11", name: "적용 제외 기록", category: "처리·판단 기준", applicability: "해당 없음", status: "미확정", detail: "담당자가 제외하기로 결정", source: "사용자 결정", step: "검토" },
  ],
  expectedDecisionIds: ["D1", "D3", "D6"],
  excludedDecisionIds: ["D2", "D4", "D5", "D7"],
  requiredGenericRules: [["팀장 승인 후 보고"], ["담당자가 제외하기로 결정"]],
  excludedGenericRules: ["이메일 발송", "금액 합산"],
  boundaries: ["F"],
};

export const insufficientContextFixture: AxRuleDerivationFixture = {
  id: "boundary-g-insufficient-context",
  label: "G: 진단 근거 부족",
  taskName: "안전점검",
  diagnosis: structuredClone(insufficientDerivationDiagnoses[0]),
  expectedDecisionIds: [],
  excludedDecisionIds: ["D1", "D2", "D3", "D4", "D5", "D6", "D7"],
  requiredGenericRules: [],
  excludedGenericRules: ["승인", "빈 파일", "계산"],
  boundaries: ["G", "H"],
};

/** Every A–J boundary is directly consumable by screenshot/comparison tooling. */
export const axRuleDerivationBoundaryFixtures: readonly AxRuleDerivationFixture[] = [
  equipmentAggregationFixture,
  facilitySafetyFixture,
  excelComparisonFixture,
  sameNameDifferentConditionsFixture,
  differentNamesSameConditionFixture,
  preservedSavedRulesFixture,
  insufficientContextFixture,
  filelessWorkFixture,
  workPermitFixture,
  scheduleNotificationFixture,
];
