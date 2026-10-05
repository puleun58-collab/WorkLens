// Reasoning Effort A/B/C 평가 — 시나리오 입력 (스펙 §9의 15개: 단순 4 / 중간 4 / 기술제약 3 / 고위험 4).
// 입력 형태는 운영 ax-diagnosis 호출과 동일하다(name, description, details).
// 기대값·Hard Constraint는 expectations.ts에 분리 보관하고, 채점 전까지 결과 파일과 함께 열지 않는다.

export type ScenarioCategory = "단순" | "중간" | "기술제약" | "고위험";

export interface EvalScenario {
  id: string;
  category: ScenarioCategory;
  name: string;
  description: string;
  details: Record<string, string>;
}

const D = (name: string, description: string): Pick<EvalScenario, "name" | "description" | "details"> => ({
  name,
  description,
  details: {},
});

export const SCENARIOS: EvalScenario[] = [
  // 단순 / 저위험 (§9-1~4)
  { id: "S1", category: "단순", ...D("Excel 월간 자료 취합", "매월 여러 부서에서 받은 Excel 파일을 하나로 취합해 검토용 표를 만들고 담당자 승인을 받습니다.") },
  { id: "S2", category: "단순", ...D("정형 데이터 형식 변환", "정해진 양식의 CSV 파일을 다른 시스템에 올릴 수 있는 형식으로 변환해 저장합니다.") },
  { id: "S3", category: "단순", ...D("반복 보고서 초안 작성", "월간 실적 표를 바탕으로 정해진 템플릿의 PPT 보고서 초안을 만듭니다.") },
  { id: "S4", category: "단순", ...D("이메일 분류", "공용 메일함으로 들어오는 문의를 유형별로 분류하고 담당자에게 배정합니다.") },
  // 중간 복잡도 (§9-5~8)
  { id: "M1", category: "중간", ...D("부서 자료 취합·최종 승인", "여러 부서의 실적 자료를 취합해 요약본을 만들고, 배포 전 팀장의 최종 승인을 받습니다.") },
  { id: "M2", category: "중간", ...D("뉴스 수집·분류·보고 자료화", "매주 지정 키워드로 뉴스를 수집하고 중복을 제거해 분류한 뒤, 중요한 기사를 사람이 선별해 PPT 보고 자료로 만듭니다.") },
  { id: "M3", category: "중간", ...D("ERP 입력·예외 검토", "주문 정보를 ERP에 입력하고, 금액 불일치 같은 예외 건은 담당자가 따로 확인합니다.") },
  { id: "M4", category: "중간", ...D("비정형 PDF 업무 정리", "거래처에서 받은 서로 다른 양식의 PDF 문서를 읽어 항목별로 정리합니다.") },
  // 기술 제약 (§9-9~11)
  { id: "T1", category: "기술제약", ...D("API 미확인 시스템 연동", "사내 시스템에서 데이터를 가져와 표로 정리합니다. 해당 시스템의 API 제공 여부는 아직 확인되지 않았습니다.") },
  { id: "T2", category: "기술제약", ...D("MFA 필수 시스템 입력", "매일 포털에 로그인해 전날 수치를 입력합니다. 로그인에는 MFA 인증이 필요합니다.") },
  { id: "T3", category: "기술제약", ...D("시스템 접근 권한 없음", "폐쇄망 시스템에서만 조회되는 자료를 수기로 옮겨 적습니다. 외부 시스템 접근 권한은 아직 없습니다.") },
  // 고위험 / 사람 판단 (§9-12~15)
  { id: "H1", category: "고위험", ...D("개인정보 포함 HR 자료 취합", "인사 평가 시즌에 평가 자료를 취합합니다. 자료에는 개인정보가 포함돼 있고, 최종 평가는 사람이 결정합니다.") },
  { id: "H2", category: "고위험", ...D("안전 점검 최종판단", "설비 안전 점검 결과를 모아 이상 여부를 최종 판단합니다.") },
  { id: "H3", category: "고위험", ...D("법률 계약 검토 보조", "계약서 초안의 주요 조항을 정리합니다. 최종 법률 판단은 법무 담당이 합니다.") },
  { id: "H4", category: "고위험", ...D("예외·승인자 복합 정산", "거래처마다 정산 기준과 예외 처리가 다르고, 금액이 다르면 승인자의 확인을 받아 조정합니다.") },
];
