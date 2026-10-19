import type { LearnQuestion } from "./types";

export const QUESTIONS_L08: LearnQuestion[] = [
  {
    id: "l8-q001",
    level: 8,
    category: "자동화 방식 선택 기준",
    type: "single",
    difficulty: "concept",
    prompt: "자동화 방식을 고를 때 함께 고려해야 할 기준이 아닌 것은?",
    choices: [
      { id: "a", text: "처리 규칙이 명확하게 정해져 있는가" },
      { id: "b", text: "규칙으로 처리할 수 없는 예외가 자주 생기는가" },
      { id: "c", text: "자동화가 실수했을 때 피해가 얼마나 큰가" },
      { id: "d", text: "최근에 유행하는 기술인가" },
    ],
    correctChoiceIds: ["d"],
    explanation:
      "방식 선택의 기준은 규칙 명확성, 예외 빈도, 실수 시 피해 크기이다. 유행 여부는 선택 기준이 아니다.",
    wrongExplanations: {
      a: "규칙이 명확하면 규칙 기반 자동화가 적합한지 판단하는 핵심 기준이다.",
      b: "예외가 잦으면 AI 판단이나 사람 검토를 설계에 포함해야 한다.",
      c: "피해가 크면 사람 검토(HITL)를 두어야 하는지 판단하는 기준이다.",
    },
    verified: true,
  },
  {
    id: "l8-q002",
    level: 8,
    category: "HITL 개념",
    type: "single",
    difficulty: "concept",
    prompt: "HITL(Human-in-the-Loop)에 대한 설명으로 옳은 것은?",
    choices: [
      { id: "a", text: "자동화의 모든 단계를 사람이 직접 처리하는 방식이다" },
      { id: "b", text: "자동화 흐름 중간에 사람이 검토·승인하는 단계를 넣는 설계 방식이다" },
      { id: "c", text: "사람의 개입을 완전히 없애는 완전 자동화 방식이다" },
      { id: "d", text: "AI에게 모든 판단과 실행 권한을 맡기는 방식이다" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "HITL은 자동화 흐름의 중간에 사람 검토·승인 단계를 끼워 넣는 설계이다. 전 단계 검토도, 완전 무인도 아니다.",
    wrongExplanations: {
      a: "모든 단계를 사람이 하면 자동화의 의미가 사라진다. HITL은 검토가 필요한 지점에만 사람을 둔다.",
      c: "사람 개입을 없애는 것은 완전 자동화이지 HITL이 아니다.",
      d: "AI에게 무제한 권한을 주는 것은 HITL과 반대되는 위험한 설계이다.",
    },
    verified: true,
  },
  {
    id: "l8-q003",
    level: 8,
    category: "규칙 기반 자동화 적용",
    type: "multiple",
    difficulty: "application",
    prompt: "다음 중 규칙 기반 자동화에 적합한 업무를 모두 고르시오.",
    choices: [
      { id: "a", text: "정해진 규정에 따라 경비 정산을 승인·반려하는 업무" },
      { id: "b", text: "계약서의 독소 조항 여부를 문맥으로 판단하는 업무" },
      { id: "c", text: "재고가 기준 이하로 떨어지면 담당자에게 알림을 보내는 업무" },
      { id: "d", text: "고객 불만 글의 감정과 심각도를 파악하는 업무" },
    ],
    correctChoiceIds: ["a", "c"],
    explanation:
      "조건과 결과가 명확한 a와 c는 규칙 기반 자동화에 적합하다. b와 d는 문맥 판단이 필요해 AI + 사람 검토가 적합하다.",
    wrongExplanations: {
      b: "독소 조항 판단은 계약 문맥을 읽어야 하므로 규칙만으로 처리하기 어렵다.",
      d: "감정·심각도 파악은 문맥 판단이 필요해 규칙 기반에 부적합하다.",
    },
    verified: true,
  },
  {
    id: "l8-q004",
    level: 8,
    category: "API 연동과 RPA 구분",
    type: "single",
    difficulty: "application",
    prompt:
      "영업 시스템과 회계 시스템이 모두 API를 제공하고, 전달할 주문 항목도 정해져 있다. 두 시스템 간 데이터 전달에 가장 적합한 방식은?",
    choices: [
      { id: "a", text: "API 연동" },
      { id: "b", text: "RPA" },
      { id: "c", text: "AI 에이전트" },
      { id: "d", text: "수동 복사·붙여넣기" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "양쪽 시스템이 API를 제공하고 전달 항목이 정해져 있으면 API 연동이 가장 빠르고 안정적이다. RPA는 API가 없을 때의 차선책이다.",
    wrongExplanations: {
      b: "RPA는 API가 없는 시스템에서 화면을 조작하는 방식이다. API가 있으면 API 연동이 우선이다.",
      c: "판단이 필요 없는 정형 데이터 전달에 AI 에이전트는 과도하다.",
      d: "정형·반복 전달을 수동으로 하면 이중 입력의 비효율이 그대로 남는다.",
    },
    verified: true,
  },
  {
    id: "l8-q005",
    level: 8,
    category: "RPA 장애 원인",
    type: "error-cause",
    difficulty: "application",
    prompt:
      "RPA 봇이 매일 아침 세금계산서 사이트에서 자료를 내려받았는데, 오늘 갑자기 엉뚱한 메뉴를 클릭하고 실패했다. 가장 유력한 원인은?",
    choices: [
      { id: "a", text: "사이트 화면의 버튼 위치나 메뉴 구성이 바뀌었다" },
      { id: "b", text: "봇이 실행되는 컴퓨터의 전원이 꺼져 있었다" },
      { id: "c", text: "세금계산서 발행 건수가 어제보다 늘었다" },
      { id: "d", text: "담당자가 엑셀 파일을 열어 두었다" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "RPA는 화면에 의존하므로 화면 구성 변경이 가장 흔한 실패 원인이다. 엉뚱한 곳을 클릭했다는 증상과 일치한다.",
    wrongExplanations: {
      b: "전원이 꺼져 있으면 실행 자체가 안 되지, 엉뚱한 메뉴를 클릭하지는 않는다.",
      c: "건수 증가는 속도에 영향을 줄 수 있지만 클릭 위치 오류의 원인이 아니다.",
      d: "엑셀을 열어 둔 것은 봇의 화면 조작과 직접 관련이 없다.",
    },
    verified: true,
  },
  {
    id: "l8-q006",
    level: 8,
    category: "워크플로 개념 적용",
    type: "single",
    difficulty: "application",
    prompt: "워크플로에 대한 설명으로 옳은 것은?",
    choices: [
      { id: "a", text: "목표를 주면 AI가 스스로 판단해 도구를 골라 쓰는 방식이다" },
      { id: "b", text: "업무의 여러 단계를 정해진 순서대로 연결한 흐름이다" },
      { id: "c", text: "사람이 화면을 클릭하듯 조작하는 소프트웨어 로봇이다" },
      { id: "d", text: "조건-행동 규칙(if-then)으로만 처리하는 방식이다" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "워크플로는 단계·담당자·순서가 정해진 절차(예: 신청 → 승인 → 처리 → 통보)를 흐름으로 만든 것이다. a는 AI 에이전트, c는 RPA, d는 규칙 기반 자동화이다.",
    wrongExplanations: {
      a: "이것은 AI 에이전트의 설명이다.",
      c: "이것은 RPA(봇)의 설명이다.",
      d: "이것은 규칙 기반 자동화의 설명이다.",
    },
    verified: true,
  },
  {
    id: "l8-q007",
    level: 8,
    category: "AI 에이전트 운영 주의점",
    type: "multiple",
    difficulty: "application",
    prompt: "AI 에이전트를 업무에 도입할 때 지켜야 할 사항을 모두 고르시오.",
    choices: [
      { id: "a", text: "에이전트가 쓸 수 있는 도구와 데이터 범위를 정한다" },
      { id: "b", text: "삭제·발송·결제 같은 되돌리기 어려운 행동은 사람 승인을 거치게 한다" },
      { id: "c", text: "AI의 답변은 그럴듯해 보이므로 사실 확인 없이 바로 반영한다" },
      { id: "d", text: "편의를 위해 모든 시스템의 관리자 권한을 부여한다" },
    ],
    correctChoiceIds: ["a", "b"],
    explanation:
      "AI 에이전트는 권한 범위를 제한하고, 되돌리기 어려운 행동에는 사람 승인(HITL)을 두어야 한다. c와 d는 환각·오남용 사고로 이어지는 위험한 방식이다.",
    wrongExplanations: {
      c: "AI는 사실이 아닌 내용을 그럴듯하게 만들 수 있어(환각) 검증 없이 반영하면 안 된다.",
      d: "무제한 권한은 오작동 시 피해를 키운다. 최소 권한이 원칙이다.",
    },
    verified: true,
  },
  {
    id: "l8-q008",
    level: 8,
    category: "API 연동 장애 대응",
    type: "error-cause",
    difficulty: "application",
    prompt:
      "어제까지 정상이던 주문 데이터 API 연동이 오늘 아침부터 실패한다. 우리 쪽 코드는 바뀐 것이 없다. 가장 먼저 확인할 것은?",
    choices: [
      { id: "a", text: "상대 시스템의 점검 공지와 API 키의 유효 상태" },
      { id: "b", text: "우리 회사 인터넷 회선의 속도" },
      { id: "c", text: "담당자 컴퓨터의 바탕화면 정리 상태" },
      { id: "d", text: "연동과 무관한 다른 시스템의 업데이트 내역" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "우리 쪽 변경이 없는데 갑자기 실패하면 상대 시스템 점검·장애나 API 키 만료·변경이 가장 유력하다. 연동 설계 시 실패 대응을 포함해야 하는 이유이다.",
    wrongExplanations: {
      b: "회선 속도는 연동 실패의 직접 원인으로 보기 어렵고, 갑작스러운 전체 실패와도 맞지 않는다.",
      c: "바탕화면 상태는 API 연동과 무관하다.",
      d: "무관한 시스템의 업데이트는 원인 후보에서 뒤로 미룬다.",
    },
    verified: true,
  },
  {
    id: "l8-q009",
    level: 8,
    category: "방식 선택: RPA",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "총무팀은 세금계산서 발행 사이트에서 매월 300건의 계산서를 내려받는다. 이 사이트는 API를 제공하지 않으며, 작업 순서(로그인 → 조회 → 내려받기)는 매번 동일하다. 가장 적합한 자동화 방식은?",
    choices: [
      { id: "a", text: "RPA" },
      { id: "b", text: "API 연동" },
      { id: "c", text: "AI 에이전트" },
      { id: "d", text: "워크플로" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "API가 없고 화면 조작 순서가 매번 같은 반복 작업은 RPA의 대표적 적용 사례이다.",
    wrongExplanations: {
      b: "사이트가 API를 제공하지 않아 API 연동은 불가능하다.",
      c: "판단이 필요 없는 정형 반복 작업에 AI 에이전트는 과도하다.",
      d: "워크플로는 승인·협업 절차의 흐름을 다루는 개념으로, 화면 조작 자동화와는 다르다.",
    },
    verified: true,
  },
  {
    id: "l8-q010",
    level: 8,
    category: "방식 선택: API 연동",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "물류팀은 창고관리 시스템의 출고 데이터를 매일 자정에 회계 시스템으로 넘긴다. 두 시스템 모두 API를 제공하고 전달 항목(출고번호, 수량, 금액)이 고정되어 있다. 가장 적합한 방식은?",
    choices: [
      { id: "a", text: "API 연동" },
      { id: "b", text: "RPA" },
      { id: "c", text: "AI 에이전트" },
      { id: "d", text: "사람이 매일 엑셀로 옮기기" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "API가 있고 항목이 고정된 정기 전달은 API 연동이 가장 빠르고 안정적이다.",
    wrongExplanations: {
      b: "API가 있는데 굳이 화면 조작 방식인 RPA를 쓸 이유가 없다.",
      c: "정형 데이터 전달에 판단이 필요 없으므로 AI 에이전트는 과도하다.",
      d: "매일 반복되는 정형 전달을 수동으로 하면 오류와 수작업이 계속된다.",
    },
    verified: true,
  },
  {
    id: "l8-q011",
    level: 8,
    category: "방식 선택: AI + HITL",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "고객지원팀은 하루 수백 건의 문의 메일을 받는다. '배송 지연', '제품 불량', '단순 문의'로 나누려면 문맥을 읽어야 한다. 분류 후에는 담당자가 고객에게 답변을 발송한다. 가장 적합한 설계는?",
    choices: [
      { id: "a", text: "AI 에이전트가 분류하고, 발송 전 담당자가 확인한다" },
      { id: "b", text: "키워드 규칙만으로 분류하고 자동으로 답변까지 발송한다" },
      { id: "c", text: "RPA 봇이 메일 화면을 클릭해 분류한다" },
      { id: "d", text: "분류 없이 도착 순서대로 담당자가 모두 읽는다" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "문맥 판단이 필요한 분류는 AI 에이전트가 적합하고, 대외 발송처럼 책임이 따르는 단계에는 사람 확인(HITL)을 둔다.",
    wrongExplanations: {
      b: "키워드 규칙만으로는 문맥을 놓쳐 오분류가 생기고, 자동 발송은 사고 위험이 크다.",
      c: "RPA는 화면 조작 방식이라 내용 판단에는 맞지 않다.",
      d: "자동화 없이 두면 분류工수가 그대로 남는다.",
    },
    verified: true,
  },
  {
    id: "l8-q012",
    level: 8,
    category: "HITL 설계 판단",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "구매팀이 발주서 작성을 자동화하려 한다. 발주 금액은 건당 50만 원부터 2천만 원까지 다양하다. 안전과 효율을 함께 잡는 설계로 가장 적절한 것은?",
    choices: [
      { id: "a", text: "모든 발주를 자동으로 발송하고 사후에 로그만 확인한다" },
      { id: "b", text: "발주서는 자동으로 작성하되, 일정 금액 이상은 팀장 승인 후 발송한다" },
      { id: "c", text: "자동화를 포기하고 모든 발주를 수기로 작성한다" },
      { id: "d", text: "발주서 작성부터 발송까지 전 단계를 팀장이 검토한다" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "금액 기준으로 검토 지점을 나누는 것이 HITL의 정석이다. 소액은 자동 처리로 효율을, 고액은 사람 승인으로 안전을 확보한다.",
    wrongExplanations: {
      a: "고액 발주의 자동 발송은 실수 시 피해가 커서 위험하다.",
      c: "전부 수기는 자동화 효과를 포기하는 것이다.",
      d: "전 단계 검토는 사람이 병목이 되어 자동화 의미가 사라진다.",
    },
    verified: true,
  },
  {
    id: "l8-q013",
    level: 8,
    category: "방식 선택: 워크플로",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "인사팀의 휴가 신청은 '사원 신청 → 팀장 승인 → 인사 기록 반영 → 신청자 통보'라는 정해진 순서가 있다. 메신저 구두 승인 시절에는 누락이 잦았다. 가장 적합한 방식은?",
    choices: [
      { id: "a", text: "워크플로" },
      { id: "b", text: "AI 에이전트" },
      { id: "c", text: "RPA" },
      { id: "d", text: "규칙 기반 자동화 단독" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "단계와 담당자가 정해진 절차는 워크플로로 만드는 것이 정답이다. AI 판단이 필요한 부분이 없으면 AI를 끼울 이유도 없다.",
    wrongExplanations: {
      b: "판단이 필요 없는 정형 절차에 AI 에이전트는 과도하다.",
      c: "RPA는 화면 조작 자동화로, 승인 흐름의 누락 문제와 직접 관련이 없다.",
      d: "규칙 기반만으로는 승인 대기·통보 같은 단계 흐름을 표현하기 어렵다.",
    },
    verified: true,
  },
  {
    id: "l8-q014",
    level: 8,
    category: "RPA 부적합 판단",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "어떤 팀이 분기마다 화면이 크게 개편되는 포털 사이트의 자료 수집에 RPA 도입을 검토한다. 이 판단에 대한 평가로 옳은 것은?",
    choices: [
      { id: "a", text: "적합하다. RPA는 어떤 화면에서도 잘 동작하므로" },
      { id: "b", text: "부적합하다. 화면이 자주 바뀌면 봇 유지보수 비용이 커진다" },
      { id: "c", text: "적합하다. 화면이 바뀔수록 RPA 효과가 커지므로" },
      { id: "d", text: "부적합하다. RPA는 API가 있는 시스템에서만 동작하므로" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "RPA는 화면에 의존하므로 화면 변경이 잦으면 봇을 계속 고쳐야 한다. 도입 전 화면 변경 주기를 확인해야 한다.",
    wrongExplanations: {
      a: "RPA는 화면 변경에 취약하다는 태생적 약점이 있다.",
      c: "화면 변경은 RPA의 실패 원인이지 효과를 키우는 요소가 아니다.",
      d: "RPA는 오히려 API가 없는 시스템에서 쓰는 방식이다.",
    },
    verified: true,
  },
  {
    id: "l8-q015",
    level: 8,
    category: "AI 에이전트 권한 설계",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "영업팀이 AI 에이전트에게 '견적서 초안을 만들고 고객에게 바로 발송'하도록 결제·발송 권한까지 주려 한다. 이 설계에 대한 평가로 옳은 것은?",
    choices: [
      { id: "a", text: "적절하다. AI가 알아서 잘 처리할 것이므로" },
      { id: "b", text: "위험하다. 발송 같은 되돌리기 어려운 행동은 사람 승인을 거치게 해야 한다" },
      { id: "c", text: "적절하다. 권한이 많을수록 에이전트 성능이 좋아지므로" },
      { id: "d", text: "위험하다. AI 에이전트는 견적서 작성에 쓸 수 없으므로" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "대외 발송은 되돌리기 어려워 오류 비용이 크다. AI가 초안을 만들고 사람이 확인·발송하는 HITL 설계가 필요하다.",
    wrongExplanations: {
      a: "AI의 실수(환각·계산 오류)가 그대로 고객에게 전달되는 사고로 이어질 수 있다.",
      c: "권한이 많을수록 오작동 시 피해가 커진다. 최소 권한이 원칙이다.",
      d: "견적서 초안 작성 자체는 AI가 잘하는 영역이다. 문제는 무인 발송이다.",
    },
    verified: true,
  },
  {
    id: "l8-q016",
    level: 8,
    category: "방식 선택: 규칙 기반",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "관리팀의 경비 정산 규정은 명확하다. '식대 1인당 3만 원 이하, 영수증 필수, 조건을 모두 만족하면 승인, 하나라도 어기면 반려'이다. 월 200건을 처리한다. 가장 적합한 방식은?",
    choices: [
      { id: "a", text: "규칙 기반 자동화" },
      { id: "b", text: "AI 에이전트" },
      { id: "c", text: "RPA" },
      { id: "d", text: "워크플로" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "조건과 결과가 명확히 정해져 있으면 규칙 기반 자동화가 가장 빠르고 정확하다. AI에게 맡길 이유가 없는 대표 사례이다.",
    wrongExplanations: {
      b: "판단이 필요 없는 명확한 조건 심사에 AI는 과도하고 비용만 든다.",
      c: "시스템 화면 조작이 아니라 조건 판정이므로 RPA와는 맞지 않다.",
      d: "승인 흐름 자체보다 조건 판정이 핵심이므로 규칙 기반이 직접적이다.",
    },
    verified: true,
  },
  {
    id: "l8-q017",
    level: 8,
    category: "HITL 설계 평가",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "인사팀이 AI로 이력서를 1차로 걸러내고, 최종 면접 대상은 사람이 정하는 방식을 도입했다. 이 설계에 대한 평가로 옳은 것은?",
    choices: [
      { id: "a", text: "적절한 HITL이다. 효율과 공정성 판단을 함께 잡았다" },
      { id: "b", text: "잘못되었다. AI가 1차로 거르는 것 자체가 문제이다" },
      { id: "c", text: "잘못되었다. 최종 결정까지 AI가 해야 효율적이다" },
      { id: "d", text: "잘못되었다. 이력서 검토는 전부 사람이 해야 한다" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "대량 1차 선별은 AI가 맡아 효율을 내고, 최종 판단은 사람이 해 책임과 공정성을 지키는 전형적인 HITL이다.",
    wrongExplanations: {
      b: "1차 선별을 AI가 돕는 것 자체는 문제없다. 최종 판단을 사람이 하는지가 핵심이다.",
      c: "채용 최종 결정까지 AI에 맡기면 오류 비용(잘못된 채용·탈락)이 크고 책임 소재도 불분명하다.",
      d: "전부 수기는 대량 이력서 앞에서 비효율적이다.",
    },
    verified: true,
  },
  {
    id: "l8-q018",
    level: 8,
    category: "RPA 용량 한계 판단",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "물류팀이 하루 수만 건의 운송장 데이터를 처리해야 한다. 업체가 RPA 도입을 제안했다. 이 제안에 대한 평가로 옳은 것은?",
    choices: [
      { id: "a", text: "적절하다. RPA는 대용량 처리에 가장 빠르므로" },
      { id: "b", text: "재검토가 필요하다. RPA는 사람 속도로 화면을 조작해 대용량에 느리다" },
      { id: "c", text: "적절하다. 건수가 많을수록 RPA 단가가 낮아지므로" },
      { id: "d", text: "재검토가 필요하다. RPA는 소량 데이터에서만 동작하므로" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "RPA는 화면 조작 방식이라 대용량·고속 처리에 부적합하다. 수만 건 처리는 API 연동이나 시스템 개선을 검토해야 한다.",
    wrongExplanations: {
      a: "RPA는 사람 속도로 동작하므로 대용량에 느리다.",
      c: "단가 문제가 아니라 처리 방식의 한계 문제이다.",
      d: "RPA가 소량에서만 동작한다는 것은 사실이 아니다. 대용량에 느리다는 것이 핵심이다.",
    },
    verified: true,
  },
  {
    id: "l8-q019",
    level: 8,
    category: "API 키 보안 판단",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "담당자가 API 연동을 빨리 끝내려고 API 키를 팀 메신저 단체방에 올렸다. 이 행동에 대한 평가로 옳은 것은?",
    choices: [
      { id: "a", text: "문제없다. 팀 내부 공유는 안전하므로" },
      { id: "b", text: "문제없다. API 키는 공개되어도 되는 값이므로" },
      { id: "c", text: "위험하다. API 키는 비밀번호처럼 관리해야 하며 유출 시 재발급해야 한다" },
      { id: "d", text: "문제없다. 메신저는 암호화되므로" },
    ],
    correctChoiceIds: ["c"],
    explanation:
      "API 키는 본인 인증 수단이므로 유출되면 다른 사람이 내 권한으로 데이터를 가져갈 수 있다. 안전하게 전달·보관하고 유출이 의심되면 재발급한다.",
    wrongExplanations: {
      a: "팀 내부라도 메신저 기록은 유출·노출 경로가 될 수 있어 안전하지 않다.",
      b: "API 키는 절대 공개하면 안 되는 비밀값이다.",
      d: "메신저 암호화와 별개로, 키를 평문으로 올리는 행위 자체가 보안 수칙 위반이다.",
    },
    verified: true,
  },
  {
    id: "l8-q020",
    level: 8,
    category: "방식 종합 선택",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "회계팀 업무를 정리했더니 세 가지가 나왔다. (1) 매일 같은 형식의 입금 내역 집계 (2) 세무서 사이트(API 없음)에서 고지서 내려받기 (3) 1천만 원 이상 지출의 최종 승인. 각 업무에 맞는 방식을 순서대로 고른 것은?",
    choices: [
      { id: "a", text: "(1) 규칙 기반 자동화, (2) RPA, (3) 사람 승인(HITL)" },
      { id: "b", text: "(1) AI 에이전트, (2) API 연동, (3) 규칙 기반 자동화" },
      { id: "c", text: "(1) RPA, (2) AI 에이전트, (3) 완전 자동 승인" },
      { id: "d", text: "(1) 워크플로, (2) 규칙 기반 자동화, (3) AI 에이전트" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "(1)은 조건이 명확한 정형 집계이므로 규칙 기반, (2)는 API가 없는 화면 반복 작업이므로 RPA, (3)은 고액 지출이라 사람 승인(HITL)이 맞다.",
    wrongExplanations: {
      b: "(2)는 API가 없어 API 연동이 불가능하고, (3)을 규칙만으로 자동 승인하면 위험하다.",
      c: "(1)에 화면 조작 방식은 맞지 않고, (3) 완전 자동 승인은 고액 지출에 위험하다.",
      d: "(2)는 화면 조작이 필요해 규칙 기반으로 안 되고, (3)에 AI 단독 결정은 책임 소재가 불분명하다.",
    },
    verified: true,
  },
];
