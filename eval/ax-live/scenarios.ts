// AI•AX Live Eval scenarios (opt-in, not part of CI).
// 14 real-work scenarios from the 2026-10-06 live quality evaluation plus
// boundary cases for the PR #102 prompt rules (needs-check threshold,
// systemAccess direction, API + human approval separation).
export interface AxLiveScenario {
  id: string;
  name: string;
  description: string;
  details: Record<string, unknown>;
  /** needs-check is expected (3+ of cycle/inputs/outputs/human steps missing). */
  expectNeedsCheck?: boolean;
  /** needs-check would be an over-correction for this input. */
  expectNotNeedsCheck?: boolean;
  /** systemAccess direction: manual-only work must score low, confirmed API access must not. */
  systemAccess?: "low" | "not-low";
  /** API access confirmed AND a human approval step exists: the two must stay separate factors. */
  apiPlusHumanApproval?: boolean;
}

export const SCENARIOS: AxLiveScenario[] = [
  { id: "c01-freight-settlement", name: "월간 운임 정산 자료 취합 및 계산",
    description: "매월 말 협력 운송사별 운임 정산 자료를 취합해 정산 금액을 계산합니다. 거래명세와 운송 내역을 대조해 구간·요율표 기준으로 운임을 산출하고, 누락·중복 건은 담당자가 확인합니다. 최종 정산표는 담당자 검토 후 확정합니다.",
    details: { cycle: "매월 말", minutesPerRun: 240, runsPerMonth: 1, systems: "Excel, 운송 내역 파일", inputs: "운송사별 거래명세, 운송 내역, 요율표", outputs: "월간 운임 정산표", humanSteps: "누락·중복 건 확인, 최종 정산 확정" } },
  { id: "c02-excel-merge", name: "여러 Excel 파일 월별 취합 통합 집계표 작성",
    description: "여러 담당자가 각자 제출한 Excel 파일의 데이터를 월별로 취합해 하나의 통합 집계표를 만듭니다. 파일마다 시트 구성과 항목 순서가 조금씩 다르고, 제출이 늦거나 빠진 파일이 있으면 담당자가 확인합니다.",
    details: { cycle: "매월", minutesPerRun: 180, runsPerMonth: 1, systems: "Excel", inputs: "담당자별 Excel 제출 파일 여러 개", outputs: "월별 통합 집계표", humanSteps: "미제출·형식 상이 파일 확인" } },
  { id: "c03-client-news", name: "고객사 뉴스 동향 보고자료 작성",
    description: "매주 주요 고객사 관련 뉴스를 수집하고 핵심 내용을 요약해 보고자료를 작성합니다. 기사 중복을 걸러내고 출처를 확인한 뒤, 보고에 포함할 내용의 최종 판단은 담당자가 합니다. 발송 전 담당자 검토를 거칩니다.",
    details: { cycle: "매주", minutesPerRun: 120, runsPerMonth: 4, systems: "뉴스 검색, 문서 작성 도구", inputs: "고객사 관련 뉴스 기사", outputs: "주간 고객사 동향 보고자료", humanSteps: "보고 포함 여부 최종 판단, 발송 승인" } },
  { id: "c04-internal-entry", name: "사내 관리 시스템 반복 데이터 등록",
    description: "정리된 업무 데이터를 사내 관리 시스템에 반복 등록합니다. 현재는 화면에서 한 건씩 입력하고 있으며, 시스템 연동 방식(API 제공 여부 등)은 확인되지 않았습니다. 입력값 오류가 있으면 담당자가 수정합니다.",
    details: { cycle: "매일", minutesPerRun: 60, runsPerMonth: 20, systems: "사내 관리 시스템(연동 방식 미확인)", inputs: "정리된 업무 데이터 목록", outputs: "시스템 등록 완료 건", humanSteps: "입력 오류 수정, 등록 결과 확인" },
    expectNotNeedsCheck: true },
  { id: "c05-tax-invoice", name: "협력업체 세금계산서 발행 확인 및 안내",
    description: "협력업체가 세금계산서를 발행했는지 확인하고 미발행 건은 담당자에게 안내합니다. 발행 여부 조회와 실제 발행 요청은 구분되며, 마감일을 넘긴 건은 우선 확인합니다.",
    details: { cycle: "매월", minutesPerRun: 90, runsPerMonth: 1, systems: "회계 시스템(조회 범위 미확인)", inputs: "협력업체 거래 내역, 발행 기한", outputs: "미발행 건 안내 목록", humanSteps: "미발행 사유 확인, 발행 요청 여부 판단" } },
  { id: "c06-contract-review", name: "계약서 위험 조항 검토",
    description: "계약서의 위험 조항과 수정 필요 사항을 검토합니다. 조항별 위험도를 표시하고 수정 방향을 제안하되, 계약 체결 여부와 최종 문안 확정은 담당자와 전문가 검토를 거칩니다.",
    details: { cycle: "필요 시", minutesPerRun: 150, runsPerMonth: 2, systems: "문서 파일", inputs: "계약서 초안", outputs: "위험 조항 검토 의견", humanSteps: "최종 문안 확정, 체결 여부 결정" } },
  { id: "c07-safety-risk", name: "물류센터 안전 위험요소 판단",
    description: "물류센터 작업 상황을 확인하고 안전 위험요소를 판단합니다. 현장 점검 기록과 작업 현황을 바탕으로 위험 신호를 표시하되, 최종 안전 판정과 작업 중지 여부는 담당자가 결정합니다.",
    details: { cycle: "매일", minutesPerRun: 45, runsPerMonth: 20, systems: "점검 기록 파일", inputs: "현장 점검 기록, 작업 현황", outputs: "위험요소 알림 목록", humanSteps: "최종 안전 판정, 작업 중지 결정" } },
  { id: "c08-purchase-approval", name: "구매 요청 검토 및 승인 지원",
    description: "구매 요청의 금액과 내용을 검토해 승인 여부를 결정합니다. 금액 기준과 요청 사유를 확인하고 예외 건은 별도로 표시하되, 실제 승인은 권한을 가진 담당자가 수행합니다.",
    details: { cycle: "필요 시", minutesPerRun: 30, runsPerMonth: 12, systems: "구매 요청 문서", inputs: "구매 요청서, 금액, 사유", outputs: "검토 의견 및 예외 건 목록", humanSteps: "승인 여부 최종 결정" } },
  { id: "c09-personal-docs", name: "개인정보 포함 문서 분류 정리",
    description: "직원 개인정보가 포함된 문서를 분류하고 필요한 항목만 정리합니다. 접근 권한이 있는 담당자만 처리하며, 정리 범위는 요청된 항목으로 한정합니다. 원본 삭제 여부는 담당자가 결정합니다.",
    details: { cycle: "필요 시", minutesPerRun: 100, runsPerMonth: 3, systems: "문서 파일", inputs: "개인정보 포함 문서", outputs: "항목별 정리본", humanSteps: "처리 범위 확정, 원본 삭제 여부 결정" } },
  { id: "c10-quarterly-report", name: "분기 비정형 경영지원 보고서 작성",
    description: "분기 또는 필요 시 경영지원 보고서를 작성합니다. 매번 구성과 강조점이 달라 담당자가 방향을 정하고, 자료 취합과 초안 작성 후 담당자 검토를 거쳐 완성합니다.",
    details: { cycle: "분기", minutesPerRun: 300, runsPerMonth: 0, systems: "문서 작성 도구, Excel", inputs: "부서별 현황 자료", outputs: "경영지원 보고서", humanSteps: "보고 방향 결정, 최종 검토" } },
  { id: "c11-file-organize", name: "월말 파일명 변경 및 폴더 정리",
    description: "월말에 정해진 규칙으로 파일명을 변경하고 폴더별로 정리합니다. 규칙은 날짜와 문서 유형 기준이며, 이름이 규칙과 다르면 담당자가 확인합니다.",
    details: { cycle: "매월 말", minutesPerRun: 40, runsPerMonth: 1, systems: "파일 탐색기, 공유 폴더", inputs: "월말 산출 파일들", outputs: "정리된 폴더 구조", humanSteps: "규칙 예외 파일 확인" } },
  { id: "c12-api-transfer", name: "시스템 간 반복 데이터 전송(API 연동 확인됨)",
    description: "공식 API와 인증 방식, 입력·출력 명세가 확인된 두 시스템 사이에서 정해진 주기로 데이터를 전송합니다. 전송 실패 시 재시도와 담당자 알림이 필요하고, 결과는 로그로 확인합니다.",
    details: { cycle: "매일", minutesPerRun: 20, runsPerMonth: 20, systems: "공식 API 제공 시스템(인증·명세 확인됨)", inputs: "전송 대상 데이터(API 명세 기준)", outputs: "전송 완료 로그", humanSteps: "전송 실패 건 확인 및 조치" },
    systemAccess: "not-low" },
  { id: "c13-sparse-info", name: "업무 인수인계 자료 정리",
    description: "업무 인수인계 자료를 정리합니다.",
    details: {},
    expectNeedsCheck: true },
  { id: "c14-no-system-access", name: "외부 포털 수기 조회 및 기록",
    description: "외부 포털에 담당자가 직접 로그인해 조회한 결과를 기록합니다. 포털은 자동화 연동을 제공하지 않고 계정 공유도 허용되지 않아, 조회 자체는 담당자가 수행합니다. 기록 양식만 정해져 있습니다.",
    details: { cycle: "매주", minutesPerRun: 50, runsPerMonth: 4, systems: "외부 포털(자동화 연동 불가)", inputs: "담당자 조회 결과", outputs: "조회 기록표", humanSteps: "포털 로그인 및 조회, 결과 이상 여부 판단" },
    systemAccess: "low" },
  // PR #102 boundary cases.
  { id: "c15-two-core-missing", name: "주간 재고 현황 취합",
    description: "매주 창고별 재고 현황을 취합합니다. 입력 자료는 창고별 재고 파일입니다.",
    details: { cycle: "매주", inputs: "창고별 재고 파일" },
    expectNotNeedsCheck: true },
  { id: "c16-three-core-missing", name: "정기 점검 결과 정리",
    description: "정기 점검 결과를 정리합니다. 수행 주기는 매월입니다.",
    details: { cycle: "매월" },
    expectNeedsCheck: true },
  { id: "c17-api-plus-approval", name: "시스템 간 주문 데이터 전송 및 승인",
    description: "공식 API와 인증 방식, 입력·출력 명세가 확인된 두 시스템 사이에서 주문 데이터를 전송합니다. 전송 전에 담당자가 최종 승인하고, 실패 시 담당자에게 알립니다.",
    details: { cycle: "매일", minutesPerRun: 15, runsPerMonth: 20, systems: "공식 API 제공 시스템(인증·명세 확인됨)", inputs: "주문 데이터(API 명세 기준)", outputs: "전송 완료 로그", humanSteps: "전송 전 최종 승인, 실패 건 조치" },
    systemAccess: "not-low", apiPlusHumanApproval: true },
];
