import type { LearnQuestion } from "./types";

/** 사전 진단 문제 (8문제, 영역별 2문제) */
export const DIAGNOSTIC_QUESTIONS: LearnQuestion[] = [
  // ── AI·AX 개념 이해 (2) ──
  {
    id: "diag-q1",
    level: 1,
    category: "AI·AX 개념 이해",
    type: "single",
    difficulty: "concept",
    prompt: "생성형 AI에 대한 설명으로 가장 적절한 것은 무엇인가?",
    choices: [
      { id: "a", text: "정해진 규칙대로만 계산하는 프로그램이다" },
      { id: "b", text: "학습한 데이터를 바탕으로 문장·이미지 같은 새로운 결과물을 만들어 내는 AI이다" },
      { id: "c", text: "인터넷 속도를 빠르게 해주는 기술이다" },
      { id: "d", text: "컴퓨터 바이러스를 막아주는 프로그램이다" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "생성형 AI는 학습한 데이터를 바탕으로 문장, 이미지, 코드 같은 새로운 결과물을 만들어 내는 AI이다.",
    wrongExplanations: {
      a: "정해진 규칙대로만 계산하는 것은 일반적인 프로그램의 설명이다.",
      c: "인터넷 속도와는 관련이 없다.",
      d: "바이러스 차단 프로그램의 설명이다.",
    },
    verified: true,
  },
  {
    id: "diag-q2",
    level: 1,
    category: "AI·AX 개념 이해",
    type: "single",
    difficulty: "concept",
    prompt: "AX(AI Transformation)에 대한 설명으로 가장 적절한 것은 무엇인가?",
    choices: [
      { id: "a", text: "AI를 업무 방식과 조직 운영에 적용해 일하는 방식을 바꾸는 것이다" },
      { id: "b", text: "AI 프로그램을 한 번 설치하는 것이다" },
      { id: "c", text: "엑셀을 더 빠르게 실행하는 기술이다" },
      { id: "d", text: "AI가 사람을 완전히 대체하는 것이다" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "AX는 AI를 업무 방식과 조직 운영 전반에 적용해 일하는 방식을 바꾸는 것을 말한다. " +
      "단순한 도구 설치가 아니라 업무 흐름의 변화가 핵심이다.",
    wrongExplanations: {
      b: "프로그램 설치 한 번으로 끝나는 일이 아니라 업무 방식의 변화가 핵심이다.",
      c: "엑셀 실행 속도와는 관련이 없다.",
      d: "AX는 사람의 역할을 바꾸는 것이지 완전히 없애는 것이 아니다.",
    },
    verified: true,
  },
  // ── 업무 자동화 판단 (2) ──
  {
    id: "diag-q3",
    level: 1,
    category: "업무 자동화 판단",
    type: "single",
    difficulty: "concept",
    prompt: "다음 중 자동화에 가장 적합한 업무는 무엇인가?",
    choices: [
      { id: "a", text: "매월 같은 양식으로 반복되고 규칙이 명확한 집계 업무" },
      { id: "b", text: "매번 기준이 달라 담당자 판단이 필요한 예외 처리" },
      { id: "c", text: "일 년에 한 번 하는 특별한 행사 기획" },
      { id: "d", text: "상대방과 협의하며 결론을 내야 하는 협상" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "반복되고 규칙이 명확한 업무가 자동화에 가장 적합하다. 판단이 필요하거나 빈도가 낮은 업무는 자동화 효과가 떨어진다.",
    wrongExplanations: {
      b: "기준이 매번 달라지는 예외 처리는 사람의 판단이 필요해 자동화에 부적합하다.",
      c: "빈도가 낮은 업무는 자동화 투자 대비 효과가 떨어진다.",
      d: "협상은 사람 사이의 판단과 소통이 핵심이라 자동화 대상이 아니다.",
    },
    verified: true,
  },
  {
    id: "diag-q4",
    level: 1,
    category: "업무 자동화 판단",
    type: "single",
    difficulty: "application",
    prompt:
      "월말 정산 업무를 자동화하려고 한다. 그런데 거래처별 정산 규칙이 문서로 정리되어 있지 않고 담당자 머릿속에만 있다. " +
      "가장 먼저 해야 할 일은 무엇인가?",
    choices: [
      { id: "a", text: "일단 자동화 프로그램을 만들고 규칙은 나중에 맞춘다" },
      { id: "b", text: "담당자에게 규칙을 확인해 문서(규칙표)로 정리한다" },
      { id: "c", text: "AI에게 규칙을 추측하게 한다" },
      { id: "d", text: "규칙이 없으므로 자동화를 포기한다" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "규칙이 확정되지 않은 상태에서는 자동화를 만들 수 없다. 먼저 규칙을 확인해 문서로 정리해야 한다. " +
      "추측으로 만든 자동화는 나중에 전부 고쳐야 한다.",
    wrongExplanations: {
      a: "규칙 없이 만든 자동화는 규칙이 나올 때마다 다시 만들어야 한다.",
      c: "추측된 규칙은 정산 근거가 될 수 없다.",
      d: "규칙을 정리하면 자동화할 수 있으므로 포기할 필요가 없다.",
    },
    verified: true,
  },
  // ── CLI·Git 기본 지식 (2) ──
  {
    id: "diag-q5",
    level: 1,
    category: "CLI·Git 기본 지식",
    type: "single",
    difficulty: "concept",
    prompt: "CLI(커맨드 라인 인터페이스)에 대한 설명으로 가장 적절한 것은 무엇인가?",
    choices: [
      { id: "a", text: "마우스로 아이콘을 클릭해 조작하는 화면이다" },
      { id: "b", text: "문자로 명령을 입력해 컴퓨터를 조작하는 방식이다" },
      { id: "c", text: "인터넷 브라우저의 한 종류이다" },
      { id: "d", text: "파일을 그림으로 보여주는 프로그램이다" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "CLI는 마우스 대신 문자로 명령을 입력해 컴퓨터를 조작하는 방식이다. Windows에서는 PowerShell 등이 있다.",
    wrongExplanations: {
      a: "마우스 클릭 조작은 GUI(그래픽 사용자 인터페이스)의 설명이다.",
      c: "브라우저와는 관련이 없다.",
      d: "파일을 그림으로 보여주는 것도 GUI 프로그램의 설명이다.",
    },
    verified: true,
  },
  {
    id: "diag-q6",
    level: 1,
    category: "CLI·Git 기본 지식",
    type: "single",
    difficulty: "concept",
    prompt: "Git의 '커밋(commit)'에 대한 설명으로 가장 적절한 것은 무엇인가?",
    choices: [
      { id: "a", text: "파일을 인터넷에 업로드하는 것이다" },
      { id: "b", text: "작업한 내용을 하나의 저장 시점으로 기록하는 것이다" },
      { id: "c", text: "파일을 삭제하는 것이다" },
      { id: "d", text: "컴퓨터를 종료하는 명령이다" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "커밋은 작업한 내용을 하나의 저장 시점으로 기록하는 것이다. 언제 무엇을 바꿨는지 이력으로 남는다.",
    wrongExplanations: {
      a: "인터넷 업로드는 푸시(push)의 설명이다.",
      c: "파일 삭제와는 관련이 없다.",
      d: "컴퓨터 종료 명령이 아니다.",
    },
    verified: true,
  },
  // ── 개발·배포 개념 (2) ──
  {
    id: "diag-q7",
    level: 1,
    category: "개발·배포 개념",
    type: "single",
    difficulty: "concept",
    prompt: "'배포(deploy)'에 대한 설명으로 가장 적절한 것은 무엇인가?",
    choices: [
      { id: "a", text: "만든 프로그램·웹사이트를 실제 사용자가 쓸 수 있게 공개하는 것이다" },
      { id: "b", text: "프로그램을 개발하는 첫 단계이다" },
      { id: "c", text: "컴퓨터에 프로그램을 설치하는 것이다" },
      { id: "d", text: "파일을 백업하는 것이다" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "배포는 만든 프로그램이나 웹사이트를 실제 사용자가 쓸 수 있게 공개하는 것이다.",
    wrongExplanations: {
      b: "개발의 첫 단계가 아니라 개발이 끝난 뒤 공개하는 단계이다.",
      c: "내 컴퓨터 설치가 아니라 사용자가 접근할 수 있게 공개하는 것이다.",
      d: "백업과는 다른 개념이다.",
    },
    verified: true,
  },
  {
    id: "diag-q8",
    level: 1,
    category: "개발·배포 개념",
    type: "single",
    difficulty: "application",
    prompt:
      "팀원이 만든 기능을 내 작업과 합치기 전에, 자동으로 오류 검사를 돌려 문제가 없는지 확인하고 싶다. " +
      "이런 자동 검사를 부르는 말로 가장 적절한 것은 무엇인가?",
    choices: [
      { id: "a", text: "CI(지속적 통합)" },
      { id: "b", text: "RPA" },
      { id: "c", text: "워크플로우 스케줄러" },
      { id: "d", text: "감사 추적" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "CI(지속적 통합)는 코드를 합치기 전에 자동으로 검사(테스트·빌드)를 돌려 문제를 빨리 찾는 방식이다.",
    wrongExplanations: {
      b: "RPA는 화면 반복 작업을 자동화하는 기술이다.",
      c: "워크플로우 스케줄러는 정기 실행·알림용 도구이다.",
      d: "감사 추적은 승인·수정 이력 기록이다.",
    },
    verified: true,
  },
];
