/**
 * 업무 유형별 검증 계약 (P2).
 *
 * 10개 업무 유형마다 2~4개의 짧은 검증 계약 문장을 둔다. 각 계약은
 * "무엇을 실제 동작으로 확인해야 완료로 인정되는지"만 정하고, 특정
 * 업무·컬럼·도메인 값을 하드코딩하지 않는다. id는 P4 평가 매핑용으로
 * 고정한다 (REPORT §7 매핑: S01~S12 → 아래 p4Scenarios).
 * 지시문 본문에는 이 테이블을 그대로 복사하지 않고, 유형 공통의
 * "완료 불인정 기준" 블록으로만 반영한다 (guide.ts §05 참조).
 */
export interface VerificationContract {
  /** P4 평가 매핑용 고정 id. */
  id: string;
  /** 업무 유형명. */
  name: string;
  /** 2~4개의 짧은 계약 문장. */
  contracts: string[];
  /** REPORT §7의 P4 시나리오 매핑. */
  p4Scenarios: string[];
}

export const VERIFICATION_CONTRACTS: VerificationContract[] = [
  {
    id: "data-processing",
    name: "데이터 처리",
    contracts: [
      "실제 입력 자료로 처리하고 결과를 확정된 기대 결과와 대조한다.",
      "입력을 바꿨을 때 출력이 규칙대로 달라지는지 확인한다.",
      "고정 결과·더미 데이터를 완료로 인정하지 않는다.",
    ],
    p4Scenarios: ["S01", "S04"],
  },
  {
    id: "web-ui",
    name: "웹 UI",
    contracts: [
      "실제 브라우저에서 버튼·입력·제출이 동작하는지 확인한다.",
      "정적 예시 화면만으로는 완료로 인정하지 않는다.",
      "주요 화면을 Desktop과 Mobile에서 확인한다.",
    ],
    p4Scenarios: ["S07"],
  },
  {
    id: "crud",
    name: "CRUD",
    contracts: [
      "생성·조회·수정·삭제가 저장·재조회로 확인된다.",
      "저장되지 않은 변경을 완료로 인정하지 않는다.",
    ],
    p4Scenarios: ["S02"],
  },
  {
    id: "api",
    name: "API",
    contracts: [
      "실제 HTTP 요청·응답으로 동작을 확인한다.",
      "통신 없는 스텁 응답을 완료로 인정하지 않는다.",
      "오류·권한 거부 응답이 정상 결과로 표시되지 않는지 확인한다.",
    ],
    p4Scenarios: ["S03"],
  },
  {
    id: "permissions",
    name: "권한 관리",
    contracts: [
      "권한별 접근 통제를 화면과 API 양쪽에서 확인한다.",
      "거부된 권한에 의존하는 처리가 실행되지 않는지 확인한다.",
    ],
    p4Scenarios: ["S09"],
  },
  {
    id: "approval-workflow",
    name: "승인 워크플로",
    contracts: [
      "담당자 확인·승인 전 결과가 확정·전송되지 않는지 확인한다.",
      "승인 없는 외부 전송을 완료로 인정하지 않는다.",
    ],
    p4Scenarios: ["S04", "S06"],
  },
  {
    id: "browser-automation",
    name: "브라우저 자동화",
    contracts: [
      "격리 대상 시스템에서 조회·입력·확인을 실제 브라우저 조작으로 검증한다.",
      "실제 대상이 아닌 모의 화면 결과만으로 완료로 인정하지 않는다.",
    ],
    p4Scenarios: ["S08"],
  },
  {
    id: "document-processing",
    name: "문서 처리",
    contracts: [
      "원본 문서와 처리 결과를 대조한다.",
      "원본과 무관한 생성 문서를 완료로 인정하지 않는다.",
      "변경 제안·확정 결과가 원본 이력과 연결되는지 확인한다.",
    ],
    p4Scenarios: ["S05", "S11"],
  },
  {
    id: "notification-delivery",
    name: "알림·전송",
    contracts: [
      "조건 충족 시 격리 수신처에 도달하는지 확인한다.",
      "중복 전송이 방지되는지 확인한다.",
      "실수신자에게 발송하지 않는다.",
    ],
    p4Scenarios: ["S10"],
  },
  {
    id: "schedule-dashboard",
    name: "일정·대시보드",
    contracts: [
      "이벤트·상태 변경이 저장·새로고침·재접속 후에도 유지되는지 확인한다.",
      "화면에만 표시되고 저장되지 않은 상태를 완료로 인정하지 않는다.",
    ],
    p4Scenarios: ["S12"],
  },
];

export function verificationContractById(id: string): VerificationContract | undefined {
  return VERIFICATION_CONTRACTS.find(contract => contract.id === id);
}
