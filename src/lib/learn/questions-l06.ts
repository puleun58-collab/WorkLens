import type { LearnQuestion } from "./types";

export const QUESTIONS_L06: LearnQuestion[] = [
  {
    id: "l6-q001",
    level: 6,
    unitId: "l6-u1",
    category: "AI 코딩 에이전트의 개념",
    type: "single",
    difficulty: "concept",
    prompt: "AI 코딩 에이전트에 대한 설명으로 가장 적절한 것은?",
    choices: [
      { id: "a", text: "채팅으로 질문하면 답변만 해주는 AI" },
      { id: "b", text: "사용자의 지시에 따라 소스 코드를 직접 읽고 수정하며, 필요한 명령을 실행하는 AI 도구" },
      { id: "c", text: "컴퓨터 바이러스를 검사하고 치료하는 보안 프로그램" },
      { id: "d", text: "엑셀 함수만 자동으로 만들어주는 플러그인" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "AI 코딩 에이전트는 말로 지시하면 실제 파일을 읽고·고치고·명령을 실행하는 '일하는' AI 도구입니다.",
    wrongExplanations: {
      a: "채팅으로 답변만 하는 것은 채팅형 AI의 특징으로, 코딩 에이전트와의 차이점입니다.",
      c: "바이러스 검사는 보안 프로그램의 역할로 에이전트와 무관합니다.",
      d: "엑셀 함수 생성은 에이전트가 할 수 있는 일 중 극히 일부에 불과합니다.",
    },
    verified: true,
  },
  {
    id: "l6-q002",
    level: 6,
    unitId: "l6-u1",
    category: "AI 코딩 에이전트의 개념",
    type: "single",
    difficulty: "concept",
    prompt: "채팅형 AI(예: ChatGPT)와 AI 코딩 에이전트의 가장 큰 차이는?",
    choices: [
      { id: "a", text: "코딩 에이전트는 인터넷 연결 없이도 동작한다" },
      { id: "b", text: "코딩 에이전트는 프로젝트 파일을 직접 읽고 수정하며 터미널 명령까지 실행할 수 있다" },
      { id: "c", text: "채팅형 AI는 코드를 전혀 다룰 수 없다" },
      { id: "d", text: "코딩 에이전트는 항상 무료이고 채팅형 AI는 항상 유료이다" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "채팅형 AI도 코드 작성을 돕지만, 코딩 에이전트는 실제 파일 수정과 명령 실행까지 직접 수행한다는 점이 가장 큰 차이입니다.",
    wrongExplanations: {
      a: "코딩 에이전트도 대부분 인터넷 연결이 필요합니다.",
      c: "채팅형 AI도 코드 작성과 설명을 잘합니다.",
      d: "요금제는 제품·시점에 따라 다르며 본질적인 차이가 아닙니다.",
    },
    verified: true,
  },
  {
    id: "l6-q003",
    level: 6,
    unitId: "l6-u2",
    category: "작업 지시 방법",
    type: "single",
    difficulty: "concept",
    prompt: "에이전트에게 작업을 지시할 때 포함하면 좋은 요소가 아닌 것은?",
    choices: [
      { id: "a", text: "작업의 배경과 목적" },
      { id: "b", text: "수행 범위와 제약 조건(하지 말아야 할 것)" },
      { id: "c", text: "기대하는 결과물의 형태나 예시" },
      { id: "d", text: "에이전트의 내부 동작 원리에 대한 설명" },
    ],
    correctChoiceIds: ["d"],
    explanation:
      "좋은 지시서는 배경·목적, 대상·범위, 결과 형태, 제약 조건을 담습니다. 에이전트의 내부 동작 원리는 지시에 필요하지 않습니다.",
    wrongExplanations: {
      a: "배경과 목적은 에이전트가 의도를 파악하는 데 도움이 됩니다.",
      b: "제약 조건은 원치 않는 변경을 막아 줍니다.",
      c: "결과물의 예시는 원하는 형태를 정확히 전달합니다.",
    },
    verified: true,
  },
  {
    id: "l6-q004",
    level: 6,
    unitId: "l6-u2",
    category: "작업 지시 방법",
    type: "single",
    difficulty: "application",
    prompt:
      "총무팀에서 매월 엑셀 근태 기록을 집계해야 합니다. 다음 중 에이전트에게 주는 지시로 가장 적절한 것은?",
    choices: [
      { id: "a", text: "엑셀 좀 정리해줘" },
      { id: "b", text: "근태.xlsx의 출근 시트를 읽어 월별 지각 횟수를 집계하고, 새 시트 '월간집계'에 표로 만들어줘. 원본 시트는 수정하지 마." },
      { id: "c", text: "파이썬으로 뭐든 만들어줘" },
      { id: "d", text: "최대한 빨리 끝내줘" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "b는 대상 파일, 할 일, 결과 형태, 제약(원본 수정 금지)이 모두 구체적이어서 의도대로 동작할 가능성이 가장 높습니다.",
    wrongExplanations: {
      a: "대상과 방법이 빠져 있어 에이전트가 멋대로 해석합니다.",
      c: "원하는 결과가 무엇인지 알 수 없습니다.",
      d: "속도만 강조할 뿐 작업 내용이 없습니다.",
    },
    verified: true,
  },
  {
    id: "l6-q005",
    level: 6,
    unitId: "l6-u3",
    category: "결과물 확인과 검증",
    type: "single",
    difficulty: "application",
    prompt: "에이전트가 작업을 마쳤다고 보고했을 때 가장 먼저 해야 할 일은?",
    choices: [
      { id: "a", text: "바로 실제 업무 파일에 반영한다" },
      { id: "b", text: "'어떤 파일을 어떻게 바꿨는지 설명해줘'라고 요청하고 변경 내용을 확인한다" },
      { id: "c", text: "에이전트에게 고맙다고 인사하고 종료한다" },
      { id: "d", text: "컴퓨터를 재시작한다" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "변경 내역을 먼저 파악해야 무엇이 바뀌었는지 알고 검증할 수 있습니다. 검증 없는 반영은 사고의 원인입니다.",
    wrongExplanations: {
      a: "검증 없는 반영은 잘못된 결과가 업무에 그대로 적용되는 위험이 있습니다.",
      c: "인사는 좋아도 확인을 대신할 수 없습니다.",
      d: "재시작은 결과 확인과 무관합니다.",
    },
    verified: true,
  },
  {
    id: "l6-q006",
    level: 6,
    unitId: "l6-u5",
    category: "잘못된 사용 사례 판단",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "영업팀 김 대리는 에이전트에게 '견적서 양식 좀 예쁘게 고쳐줘'라고 지시했습니다. " +
      "에이전트가 파일 10개를 수정했고, 김 대리는 확인 없이 공유 폴더에 올렸습니다. " +
      "다음 날 거래처에 금액 계산이 틀린 견적서가 발송된 뒤에야 문제를 알았습니다. " +
      "이 사례에서 가장 근본적인 잘못은?",
    choices: [
      { id: "a", text: "에이전트를 사용한 것 자체" },
      { id: "b", text: "지시가 모호했고, 결과를 검증하지 않고 업무에 반영한 것" },
      { id: "c", text: "견적서 양식을 고치려고 시도한 것" },
      { id: "d", text: "문제를 다음 날까지 방치한 것" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "'예쁘게'라는 모호한 지시와 무검증 반영이 겹쳐 사고가 났습니다. 지시는 구체적으로, 반영은 검증 후에 해야 합니다.",
    wrongExplanations: {
      a: "에이전트 사용 자체가 잘못은 아니며, 사용 방법이 문제였습니다.",
      c: "양식 개선 시도 자체는 정당한 업무입니다.",
      d: "늦은 발견보다 모호한 지시와 무검증 반영이 근본 원인입니다.",
    },
    verified: true,
  },
  {
    id: "l6-q007",
    level: 6,
    unitId: "l6-u4",
    category: "오류 원인과 해결",
    type: "error-cause",
    difficulty: "judgment",
    prompt:
      "엑셀 집계 스크립트를 만들어 달라고 했는데, 에이전트가 다른 폴더의 파일을 수정해 버렸습니다. " +
      "가장 가능성 높은 원인과 올바른 대응은?",
    choices: [
      { id: "a", text: "원인: 지시에 대상 파일의 위치·이름을 명확히 적지 않음 / 대응: 파일 경로를 명시해 다시 지시한다" },
      { id: "b", text: "원인: 컴퓨터 사양이 부족함 / 대응: 메모리를 추가한다" },
      { id: "c", text: "원인: 인터넷 연결이 끊김 / 대응: 인터넷에 다시 연결한다" },
      { id: "d", text: "원인: 에이전트 프로그램 고장 / 대응: 삭제 후 다시 설치한다" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "대상이 불분명하면 에이전트는 추측으로 파일을 고릅니다. 대상 파일의 경로·이름을 명시해 다시 지시하는 것이 올바른 대응입니다.",
    wrongExplanations: {
      b: "사양 부족은 엉뚱한 파일을 수정하는 원인이 아닙니다.",
      c: "인터넷 문제는 파일 선택 오류와 무관합니다.",
      d: "프로그램 고장보다 지시의 모호함이 훨씬 흔한 원인입니다.",
    },
    verified: true,
  },
  {
    id: "l6-q008",
    level: 6,
    unitId: "l6-u5",
    category: "에이전트의 한계",
    type: "single",
    difficulty: "concept",
    prompt: "AI 코딩 에이전트를 사용할 때 반드시 기억해야 할 한계는?",
    choices: [
      { id: "a", text: "실제로는 없는 기능이나 라이브러리를 있는 것처럼 지어내어 코드를 만들 수 있다(환각)" },
      { id: "b", text: "한 번에 한 줄의 코드만 만들 수 있다" },
      { id: "c", text: "한국어로 된 지시를 전혀 이해하지 못한다" },
      { id: "d", text: "파일을 읽을 수는 있지만 절대 수정하지 못한다" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "에이전트는 그럴듯하게 틀린 결과(환각)를 만들 수 있습니다. 낯선 함수나 수치는 출처를 확인하고 검증해야 합니다.",
    wrongExplanations: {
      b: "에이전트는 긴 코드도 한 번에 만들 수 있습니다.",
      c: "한국어 지시도 잘 이해합니다.",
      d: "파일 수정은 코딩 에이전트의 핵심 기능입니다.",
    },
    verified: true,
  },
  {
    id: "l6-q009",
    level: 6,
    unitId: "l6-u2",
    category: "작업 지시 방법",
    type: "multiple",
    difficulty: "application",
    prompt: "다음 중 에이전트에게 주는 좋은 작업 지시서에 포함되어야 할 것을 모두 고르시오.",
    choices: [
      { id: "a", text: "작업의 배경과 목적" },
      { id: "b", text: "하지 말아야 할 것(제약 조건)" },
      { id: "c", text: "에이전트에 대한 칭찬 인사말" },
      { id: "d", text: "기대하는 결과물의 형태나 예시" },
    ],
    correctChoiceIds: ["a", "b", "d"],
    explanation:
      "배경·목적, 제약 조건, 결과물의 형태·예시는 좋은 지시서의 핵심 요소입니다. 인사말은 결과 품질과 무관합니다.",
    wrongExplanations: {
      c: "칭찬 인사말은 예의일 뿐, 작업 결과를 좋게 만들지 않습니다.",
    },
    verified: true,
  },
  {
    id: "l6-q010",
    level: 6,
    unitId: "l6-u4",
    category: "오류 수정 요청",
    type: "single",
    difficulty: "application",
    prompt: "에이전트가 만든 프로그램 실행 중 오류가 났습니다. 수정 요청 시 함께 전달하면 가장 도움이 되는 것은?",
    choices: [
      { id: "a", text: "'안 돼요. 고쳐주세요'라는 말" },
      { id: "b", text: "오류 메시지 전문과 오류가 발생한 상황(무엇을 했을 때 났는지)" },
      { id: "c", text: "컴퓨터 구매 영수증" },
      { id: "d", text: "다른 프로그램의 추천 요청" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "오류 메시지 전문과 발생 상황(재현 조건)은 원인을 특정하는 가장 정확한 단서입니다.",
    wrongExplanations: {
      a: "정보가 없어 에이전트가 추측으로 고치게 됩니다.",
      c: "구매 영수증은 오류 해결과 무관합니다.",
      d: "다른 프로그램 추천은 현재 오류 해결에 도움이 되지 않습니다.",
    },
    verified: true,
  },
  {
    id: "l6-q011",
    level: 6,
    unitId: "l6-u2",
    category: "작업 지시 방법",
    type: "ox",
    difficulty: "application",
    prompt: "'엑셀 다운로드 기능을 만들어줘'라는 한 문장 지시만으로 원하는 결과를 얻을 수 있다.",
    oxAnswer: false,
    explanation:
      "대상 파일, 다운로드 형식, 제약 조건 등이 빠져 있어 에이전트가 의도와 다르게 만들 가능성이 높습니다. 구체적인 지시가 필요합니다.",
    verified: true,
  },
  {
    id: "l6-q012",
    level: 6,
    unitId: "l6-u2",
    category: "단계별 지시 판단",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "물류팀은 에이전트에게 '재고 관리 프로그램 전체를 새로 만들어줘'라고 한 번에 지시했습니다. " +
      "에이전트가 수백 줄의 코드를 한 번에 만들어 왔고, 어디가 잘못됐는지 파악할 수 없게 되었습니다. " +
      "이 상황에 대한 올바른 판단은?",
    choices: [
      { id: "a", text: "에이전트의 능력이 부족하므로 앞으로 사용하지 말아야 한다" },
      { id: "b", text: "작업을 작은 단계로 나누어(예: 데이터 입력 → 조회 → 저장) 단계마다 확인하며 진행해야 한다" },
      { id: "c", text: "더 긴 지시문을 한 번에 쓰는 것이 해결책이다" },
      { id: "d", text: "프로그램 개발은 전부 외주 업체에 맡겨야 한다" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "큰 작업을 한 번에 시키면 오류를 찾고 고치기 어렵습니다. 작은 단계로 나누어 단계마다 확인하는 것이 올바른 방법입니다.",
    wrongExplanations: {
      a: "능력 부족이 아니라 작업 분할 실패가 문제입니다.",
      c: "긴 지시문도 한 번에 처리하면 검증이 어렵습니다.",
      d: "외주 전환은 근본 해결책이 아닙니다.",
    },
    verified: true,
  },
  {
    id: "l6-q013",
    level: 6,
    unitId: "l6-u2",
    category: "작업 지시 방법",
    type: "single",
    difficulty: "application",
    prompt: "단계별 지시의 올바른 예는?",
    choices: [
      { id: "a", text: "'전부 다 해줘'" },
      { id: "b", text: "'1단계: 기존 엑셀 구조를 파악해 요약해줘. 2단계: 요약 확인 후 집계 스크립트를 만들어줘. 3단계: 테스트 실행 결과를 보여줘'" },
      { id: "c", text: "'빨리빨리 해줘'" },
      { id: "d", text: "'네가 알아서 해줘'" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "b는 작업을 단계로 나누고 각 단계마다 확인 과정을 넣어 오류를 조기에 발견할 수 있습니다.",
    wrongExplanations: {
      a: "범위도 순서도 없어 검증이 불가능합니다.",
      c: "속도만 강조할 뿐 단계 구분이 없습니다.",
      d: "전권을 맡기면 의도와 다른 결과가 나와도 알기 어렵습니다.",
    },
    verified: true,
  },
  {
    id: "l6-q014",
    level: 6,
    unitId: "l6-u2",
    category: "작업 지시 방법",
    type: "single",
    difficulty: "concept",
    prompt: "지시할 때 '원본 파일은 수정하지 마' 같은 제약 조건을 적는 이유는?",
    choices: [
      { id: "a", text: "에이전트의 작업 범위를 제한해 원치 않는 변경을 막기 위해서" },
      { id: "b", text: "에이전트의 작업 속도를 높이기 위해서" },
      { id: "c", text: "컴퓨터의 저장 용량을 아끼기 위해서" },
      { id: "d", text: "법적으로 의무이기 때문에" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "제약 조건은 '하지 말아야 할 것'을 미리 정해 원본 훼손 같은 원치 않는 변경을 막는 안전장치입니다.",
    wrongExplanations: {
      b: "제약 조건이 속도를 높여주지는 않습니다.",
      c: "용량 절약과는 무관합니다.",
      d: "법적 의무가 아니라 실무상 필요한 안전장치입니다.",
    },
    verified: true,
  },
  {
    id: "l6-q015",
    level: 6,
    unitId: "l6-u3",
    category: "결과물 확인과 검증",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "회계팀 이 과장은 에이전트에게 월말 정산표 자동화를 요청했습니다. " +
      "'완료됐습니다'라는 답변만 듣고 원본 파일에 바로 적용했더니, 며칠 뒤 합계 금액이 실제와 다르다는 것을 발견했습니다. " +
      "원인은 에이전트가 특정 부서 코드를 빠뜨리고 집계한 것이었습니다. 올바른 판단은?",
    choices: [
      { id: "a", text: "에이전트의 답변을 믿은 것이 잘못이므로 AI 사용을 중단해야 한다" },
      { id: "b", text: "적용 전에 테스트 데이터로 실행해 기존 방식의 결과와 대조하는 검증 단계를 거쳐야 했다" },
      { id: "c", text: "회계 업무에는 AI를 사용하면 안 된다" },
      { id: "d", text: "정산표를 만들지 말았어야 한다" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "문제는 AI 사용 자체가 아니라 검증 없는 반영입니다. 테스트 데이터 실행과 기존 결과 대조가 있었다면 사고를 막을 수 있었습니다.",
    wrongExplanations: {
      a: "중단이 아니라 검증 절차 도입이 올바른 대응입니다.",
      c: "회계 업무도 검증 절차를 갖추면 AI를 활용할 수 있습니다.",
      d: "정산표 작성은 필요한 업무입니다.",
    },
    verified: true,
  },
  {
    id: "l6-q016",
    level: 6,
    unitId: "l6-u3",
    category: "결과물 확인과 검증",
    type: "multiple",
    difficulty: "application",
    prompt: "에이전트 작업 결과를 검증할 때 확인할 항목으로 적절한 것을 모두 고르시오.",
    choices: [
      { id: "a", text: "어떤 파일이 새로 생기고 어떤 파일이 바뀌었는지" },
      { id: "b", text: "변경된 코드가 실제로 실행되는지(테스트)" },
      { id: "c", text: "에이전트의 답변이 친절했는지" },
      { id: "d", text: "기존에 잘 되던 기능이 깨지지 않았는지" },
    ],
    correctChoiceIds: ["a", "b", "d"],
    explanation:
      "변경 범위 파악, 실제 실행 테스트, 기존 기능 영향 확인이 검증의 핵심입니다. 답변의 친절함은 검증 항목이 아닙니다.",
    wrongExplanations: {
      c: "친절한 답변은 결과의 정확성을 보장하지 않습니다.",
    },
    verified: true,
  },
  {
    id: "l6-q017",
    level: 6,
    unitId: "l6-u4",
    category: "오류 원인과 해결",
    type: "error-cause",
    difficulty: "judgment",
    prompt:
      "에이전트에게 '보고서 양식을 정리해줘'라고 했더니 보고서의 본문 내용이 요약·삭제되어 버렸습니다. " +
      "가장 가능성 높은 원인과 올바른 대응은?",
    choices: [
      { id: "a", text: "원인: '정리'라는 말이 모호해서 에이전트가 내용 삭제로 이해함 / 대응: '서식은 바꾸되 본문 내용은 한 글자도 삭제하지 마'라고 명확히 다시 지시한다" },
      { id: "b", text: "원인: 보고서 파일이 손상됨 / 대응: 파일 복구 프로그램을 실행한다" },
      { id: "c", text: "원인: 바이러스 감염 / 대응: 백신 검사를 한다" },
      { id: "d", text: "원인: 디스크 공간 부족 / 대응: 저장 공간을 확보한다" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "'정리'는 서식 정리일 수도, 내용 삭제일 수도 있는 모호한 표현입니다. 무엇을 바꾸고 무엇을 건드리지 말지를 명확히 다시 지시해야 합니다.",
    wrongExplanations: {
      b: "파일 손상은 내용을 요약·삭제하는 원인이 아닙니다.",
      c: "바이러스는 이런 형태의 변경을 일으키지 않습니다.",
      d: "디스크 공간과 내용 삭제는 무관합니다.",
    },
    verified: true,
  },
  {
    id: "l6-q018",
    level: 6,
    unitId: "l6-u2",
    category: "작업 지시 방법",
    type: "ox",
    difficulty: "concept",
    prompt: "AI 코딩 에이전트는 사람처럼 의도를 추측하므로, 지시할 때 배경 설명을 생략해도 된다.",
    oxAnswer: false,
    explanation:
      "에이전트는 적힌 말을 그대로 해석하고 의도를 추측하지 않습니다. 배경·목적·제약을 명시해야 원하는 결과를 얻습니다.",
    verified: true,
  },
  {
    id: "l6-q019",
    level: 6,
    unitId: "l6-u5",
    category: "정보 보안 판단",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "영업팀 직원이 에이전트에게 '이 고객 명단 엑셀(주민번호·연락처 포함)을 분석해서 ...'라며 " +
      "실제 고객 개인정보 파일을 통째로 전달하려고 합니다. 올바른 판단은?",
    choices: [
      { id: "a", text: "업무 효율을 위해 그대로 전달해도 된다" },
      { id: "b", text: "개인정보는 가명 처리하거나 샘플 데이터로 바꾸어 전달하고, 꼭 필요한 경우가 아니면 실제 개인정보를 입력하지 않는다" },
      { id: "c", text: "에이전트는 안전하므로 어떤 정보든 입력해도 된다" },
      { id: "d", text: "고객에게 동의를 구하면 원본 그대로 입력해도 된다" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "입력한 정보는 AI 서비스로 전송될 수 있어 유출 위험이 있습니다. 개인정보·기밀은 가명·샘플로 대체하는 것이 원칙입니다.",
    wrongExplanations: {
      a: "효율보다 정보 보호가 우선이며, 원본 입력은 유출 위험이 있습니다.",
      c: "어떤 AI 도구도 입력 정보의 외부 전송 가능성을 완전히 배제할 수 없습니다.",
      d: "동의를 받았더라도 원본 개인정보 입력은 최소화하는 것이 안전합니다.",
    },
    verified: true,
  },
  {
    id: "l6-q020",
    level: 6,
    unitId: "l6-u3",
    category: "결과물 확인과 검증",
    type: "single",
    difficulty: "application",
    prompt: "에이전트가 여러 파일을 수정한 뒤, 변경 내용을 파악하기 위해 가장 적절한 요청은?",
    choices: [
      { id: "a", text: "'바뀐 내용을 파일별로 요약해서 보여줘'" },
      { id: "b", text: "'수고했어'" },
      { id: "c", text: "'이제 그만해'" },
      { id: "d", text: "'다른 것도 만들어줘'" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "변경 내역을 파일별로 요약해 달라고 요청하면 무엇이 바뀌었는지 파악하고 검증할 수 있습니다.",
    wrongExplanations: {
      b: "인사는 변경 내용 파악에 도움이 되지 않습니다.",
      c: "작업을 멈추는 것은 내용 파악이 아닙니다.",
      d: "추가 작업 요청 전에 현재 변경 내용부터 확인해야 합니다.",
    },
    verified: true,
  },
];
