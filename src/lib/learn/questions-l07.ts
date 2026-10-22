import type { LearnQuestion } from "./types";

export const QUESTIONS_L07: LearnQuestion[] = [
  {
    id: "l7-q001",
    level: 7,
    unitId: "l7-u1",
    category: "프로젝트 폴더 구조",
    type: "single",
    difficulty: "concept",
    prompt: "프로젝트 폴더에 대한 설명으로 가장 적절한 것은?",
    choices: [
      { id: "a", text: "하나의 프로그램(앱, 웹사이트 등)을 만드는 데 필요한 파일들을 모아둔 폴더" },
      { id: "b", text: "프로그램을 실행할 때만 임시로 만들어졌다가 종료하면 사라지는 작업 폴더" },
      { id: "c", text: "프로그램의 백업 파일을 날짜별로 모아 두는 보관용 폴더" },
      { id: "d", text: "여러 프로그램이 함께 내려받는 공용 다운로드 폴더" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "프로젝트 폴더 안에는 프로그램의 설계도(소스 코드), 부품 목록, 설정이 모두 들어 있습니다.",
    wrongExplanations: {
      b: "프로젝트 폴더는 실행 중 임시로 생기는 폴더가 아니라 개발의 기준이 되는 상시 폴더입니다.",
      c: "백업 보관 폴더와 달리, 프로젝트 폴더에는 현재 작업 중인 소스 코드와 설정이 들어 있습니다.",
      d: "공용 다운로드 폴더는 특정 프로그램 하나를 만들기 위한 파일 모음이 아닙니다.",
    },
    verified: true,
  },
  {
    id: "l7-q002",
    level: 7,
    unitId: "l7-u1",
    category: "프로젝트 폴더 구조",
    type: "single",
    difficulty: "concept",
    prompt: "소스 코드에 대한 설명으로 가장 적절한 것은?",
    choices: [
      { id: "a", text: "프로그램의 동작을 사람이 읽을 수 있는 말(프로그래밍 언어)로 적은 설계도이자 지시서" },
      { id: "b", text: "프로그램을 실행한 기록을 날짜와 오류별로 남긴 로그 파일" },
      { id: "c", text: "프로그램 설치 순서를 처음 사용하는 사람에게 알려주는 설명서" },
      { id: "d", text: "컴퓨터가 소스 코드를 번역해 기계가 바로 실행할 수 있게 만든 파일" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "소스 코드는 프로그램이 어떻게 동작해야 하는지를 프로그래밍 언어로 적은 것으로, 보통 src 같은 폴더에 모아 둡니다.",
    wrongExplanations: {
      b: "로그는 실행 결과의 기록이지, 동작을 정의하는 지시서가 아닙니다.",
      c: "설치 설명서는 사람을 위한 문서로, 프로그램의 동작을 정의하지 않습니다.",
      d: "번역된 실행 파일은 소스 코드의 결과물이며, 사람이 읽는 설계도인 소스 코드와 반대쪽 개념입니다.",
    },
    verified: true,
  },
  {
    id: "l7-q003",
    level: 7,
    unitId: "l7-u1",
    category: "프로젝트 폴더 구조",
    type: "single",
    difficulty: "application",
    prompt:
      "프로젝트 폴더 구조가 다음과 같습니다.\n" +
      "my-app/ 아래에 src/(pages/report.tsx, components/Header.tsx), package.json, README.md가 있습니다.\n" +
      "'월간 보고서 화면'의 코드를 찾아보려면 어느 파일을 열어야 할까요?",
    choices: [
      { id: "a", text: "README.md" },
      { id: "b", text: "src/pages/report.tsx" },
      { id: "c", text: "package.json" },
      { id: "d", text: "src/components/Header.tsx" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "pages는 화면들을 모아두는 폴더이고 report는 보고서라는 뜻이므로, 보고서 화면 코드는 src/pages/report.tsx일 가능성이 가장 높습니다.",
    wrongExplanations: {
      a: "README.md는 프로젝트 설명 문서입니다.",
      c: "package.json은 의존성 목록표입니다.",
      d: "Header.tsx는 화면 상단 메뉴 부품입니다.",
    },
    verified: true,
  },
  {
    id: "l7-q004",
    level: 7,
    unitId: "l7-u4",
    category: "API 키 보안 판단",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "신입 사원이 'API 키가 뭐예요? 제 거 카톡으로 보내드릴게요'라며 팀 단체 카톡방에 자신의 API 키를 올렸습니다. " +
      "올바른 판단은?",
    choices: [
      { id: "a", text: "팀원끼리 공유하는 것이니 괜찮다" },
      { id: "b", text: "API 키는 비밀번호와 같아서 채팅방·메일에 올리면 안 되며, 이미 올렸다면 해당 키를 폐기하고 새로 발급받아야 한다" },
      { id: "c", text: "카톡방을 나가면 문제가 해결된다" },
      { id: "d", text: "키를 이미지로 바꿔 올리면 안전하다" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "채팅방에 올린 키는 복사·전달되기 쉬워 이미 유출된 것으로 봐야 합니다. 해당 키는 폐기·재발급하고, 앞으로 키는 .env 파일로만 관리합니다.",
    wrongExplanations: {
      a: "팀원이라도 채팅방 공유는 유출 위험이 큽니다.",
      c: "방을 나가도 이미 올라간 키는 사라지지 않습니다.",
      d: "이미지 형태라도 키 값은 그대로 노출됩니다.",
    },
    verified: true,
  },
  {
    id: "l7-q005",
    level: 7,
    unitId: "l7-u2",
    category: "의존성의 개념",
    type: "single",
    difficulty: "concept",
    prompt: "의존성(dependency)에 대한 설명으로 가장 적절한 것은?",
    choices: [
      { id: "a", text: "내 프로그램이 동작하기 위해 빌려 쓰는 외부 코드(라이브러리·패키지)" },
      { id: "b", text: "내 프로그램이 실행될 때 자동으로 만들어지는 임시 저장 공간" },
      { id: "c", text: "내가 직접 작성한 소스 코드를 복사해 둔 백업본" },
      { id: "d", text: "프로그램끼리 데이터를 주고받을 때 따르는 통신 규칙" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "의존성은 이미 만들어진 외부 부품을 가져다 쓰는 것으로, 엑셀에서 복잡한 계산을 함수에 맡기는 것과 비슷합니다.",
    wrongExplanations: {
      b: "임시 저장 공간은 실행 환경의 개념으로, 빌려 쓰는 외부 코드가 아닙니다.",
      c: "백업본은 내 코드의 복사본이며 '외부' 코드가 아니라는 점에서 다릅니다.",
      d: "통신 규칙(프로토콜)은 코드 자체가 아니라 데이터 교환 방식의 약속입니다.",
    },
    verified: true,
  },
  {
    id: "l7-q006",
    level: 7,
    unitId: "l7-u2",
    category: "패키지 관리자 활용",
    type: "single",
    difficulty: "application",
    prompt:
      "동료에게 받은 프로젝트(Node.js 기반)를 처음 실행했는데 '모듈을 찾을 수 없습니다'라는 오류가 났습니다. " +
      "가장 먼저 해볼 일은?",
    choices: [
      { id: "a", text: "패키지 관리자 명령으로 의존성을 설치한다(예: npm install)" },
      { id: "b", text: "프로젝트 폴더를 바탕화면으로 옮긴 뒤 다시 실행한다" },
      { id: "c", text: "package.json 파일을 삭제하고 다시 실행한다" },
      { id: "d", text: "오류 메시지를 무시하고 실행을 반복해서 눌러 본다" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "'모듈을 찾을 수 없습니다'는 의존성(node_modules)이 비어 있다는 뜻으로, 패키지 관리자 명령 한 번으로 해결되는 대표적인 경우입니다.",
    wrongExplanations: {
      b: "폴더 위치는 모듈을 찾지 못하는 원인과 무관합니다.",
      c: "package.json은 설치의 기준이 되는 부품 목록표라, 지우면 오히려 설치할 수 없게 됩니다.",
      d: "의존성이 설치되지 않은 상태에서는 몇 번을 실행해도 같은 오류가 반복됩니다.",
    },
    verified: true,
  },
  {
    id: "l7-q007",
    level: 7,
    unitId: "l7-u3",
    category: "환경변수의 개념",
    type: "single",
    difficulty: "concept",
    prompt: "환경변수에 대한 설명으로 가장 적절한 것은?",
    choices: [
      { id: "a", text: "프로그램이 실행될 때 읽어들이는, 코드 밖에 보관하는 설정 값(API 주소·키 등)" },
      { id: "b", text: "프로그램 안에서 계산 도중에만 쓰이고 끝나면 사라지는 임시 값" },
      { id: "c", text: "소스 코드 파일이 몇 번째 버전인지 표시하는 번호" },
      { id: "d", text: "사용자가 프로그램 화면에서 그때그때 입력하는 검색어" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "환경변수는 환경(내 PC, 회사 서버)에 따라 달라지는 값을 코드와 분리해 보관하는 방식으로, .env 파일에 적어 둡니다.",
    wrongExplanations: {
      b: "실행 중 임시 값은 코드 안의 변수로, 코드 밖에 보관한다는 환경변수의 핵심과 다릅니다.",
      c: "버전 번호는 파일·프로그램 식별용 표시이지 실행 시 읽는 설정 값이 아닙니다.",
      d: "사용자 입력값은 실행할 때마다 사람이 넣는 값으로, 미리 보관해 두는 설정 값과 다릅니다.",
    },
    verified: true,
  },
  {
    id: "l7-q008",
    level: 7,
    unitId: "l7-u3",
    category: "환경변수 오류 해결",
    type: "error-cause",
    difficulty: "application",
    prompt:
      "프로그램 실행 시 '환경 변수 API_KEY를 찾을 수 없습니다'라는 오류가 났습니다. " +
      "가장 가능성 높은 원인과 올바른 해결책은?",
    choices: [
      { id: "a", text: "원인: .env 파일이 없거나 API_KEY 항목이 비어 있음 / 해결: .env 파일을 확인하고 키 값을 올바르게 채운 뒤 다시 실행한다" },
      { id: "b", text: "원인: API 키의 사용 기간이 만료됨 / 해결: 새 키를 발급받아 .env 파일에 교체한다" },
      { id: "c", text: "원인: 인터넷 연결이 끊겨 키 값을 내려받지 못함 / 해결: 인터넷에 다시 연결한 뒤 실행한다" },
      { id: "d", text: "원인: package.json에 API_KEY가 의존성으로 등록되어 있지 않음 / 해결: 패키지 관리자 명령으로 설치한다" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "환경변수 오류는 '설정 값을 읽어올 파일·값이 없다'는 뜻입니다. .env 파일 존재 여부와 해당 변수 값을 먼저 확인합니다.",
    wrongExplanations: {
      b: "키가 만료되면 '찾을 수 없습니다'가 아니라 인증 실패 오류가 납니다. 증상이 다릅니다.",
      c: "환경변수는 내 컴퓨터의 파일에서 읽는 값이라 인터넷 연결과 무관합니다.",
      d: "API_KEY는 설치할 패키지(의존성)가 아니라 .env에 적는 설정 값입니다. 두 개념의 혼동입니다.",
    },
    verified: true,
  },
  {
    id: "l7-q009",
    level: 7,
    unitId: "l7-u2",
    category: "패키지 관리자의 역할",
    type: "single",
    difficulty: "concept",
    prompt: "패키지 관리자(예: npm)의 역할에 대한 설명으로 가장 적절한 것은?",
    choices: [
      { id: "a", text: "필요한 외부 코드(패키지)를 내려받아 설치·관리해 주는 도구" },
      { id: "b", text: "프로그램의 실행 기록과 오류를 모아 자동으로 정리해 주는 도구" },
      { id: "c", text: "소스 코드를 컴퓨터가 실행할 수 있는 형태로 번역해 주는 도구" },
      { id: "d", text: "프로젝트 파일을 압축해 백업본을 만들어 주는 도구" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "패키지 관리자는 package.json의 부품 목록을 보고 필요한 외부 코드를 자동으로 내려받아 설치해 줍니다.",
    wrongExplanations: {
      b: "실행 기록 정리는 로그 관리의 영역으로, 패키지 설치와 무관합니다.",
      c: "번역(컴파일·빌드)은 빌드 도구의 역할로, 패키지를 내려받아 설치하는 일과 다릅니다.",
      d: "압축·백업은 패키지 관리자의 역할이 아닙니다.",
    },
    verified: true,
  },
  {
    id: "l7-q010",
    level: 7,
    unitId: "l7-u4",
    category: "민감정보 구분",
    type: "multiple",
    difficulty: "application",
    prompt: "다음 중 소스 코드나 채팅방에 그대로 적어두면 안 되는 민감정보를 모두 고르시오.",
    choices: [
      { id: "a", text: "API 키" },
      { id: "b", text: "데이터베이스 비밀번호" },
      { id: "c", text: "회사 로고 이미지의 파일명" },
      { id: "d", text: "관리자 계정의 토큰 값" },
    ],
    correctChoiceIds: ["a", "b", "d"],
    explanation:
      "API 키·비밀번호·토큰은 본인 확인에 쓰이는 열쇠이므로 외부에 새나가면 악용될 수 있습니다. 로고 파일명은 민감정보가 아닙니다.",
    wrongExplanations: {
      c: "로고 이미지 파일명은 공개되어도 문제없는 정보입니다.",
    },
    verified: true,
  },
  {
    id: "l7-q011",
    level: 7,
    unitId: "l7-u4",
    category: "API 키 관리 방법",
    type: "single",
    difficulty: "application",
    prompt: "API 키를 안전하게 관리하는 방법으로 가장 적절한 것은?",
    choices: [
      { id: "a", text: "소스 코드에 직접 적어둔다" },
      { id: "b", text: "환경변수(.env 파일)로 분리하고, .env 파일은 Git에 올리지 않는다" },
      { id: "c", text: "회사 게시판에 붙여둔다" },
      { id: "d", text: "파일명을 '비밀번호.txt'로 만들어 저장해둔다" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "키는 코드와 분리해 .env로 관리하고, .gitignore에 등록해 Git 공유에서 제외하는 것이 기본 원칙입니다.",
    wrongExplanations: {
      a: "코드에 직접 적으면(하드코딩) 공유·공개 시 키도 함께 새나갑니다.",
      c: "게시판은 누구나 볼 수 있어 가장 위험합니다.",
      d: "파일명과 무관하게 키 값 자체가 노출되면 위험합니다.",
    },
    verified: true,
  },
  {
    id: "l7-q012",
    level: 7,
    unitId: "l7-u4",
    category: "API 키 유출 대응",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "직원이 실수로 .env 파일을 GitHub 공개 저장소에 올렸습니다. " +
      "며칠 뒤 API 사용 요금이 평소의 수십 배로 청구되었습니다. 올바른 판단과 대응은?",
    choices: [
      { id: "a", text: "빨리 파일을 지웠으니 키는 그대로 써도 된다" },
      { id: "b", text: "키가 이미 노출된 것으로 보고 해당 키를 즉시 폐기·재발급하고, .env가 Git에 올라가지 않도록 설정(.gitignore)한다" },
      { id: "c", text: "저장소를 비공개로 바꾸면 키를 계속 써도 된다" },
      { id: "d", text: "아무도 안 봤을 것이니 무시한다" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "한 번 공개된 키는 이미 복사되었을 수 있으므로 '지웠으니 괜찮다'는 기대는 위험합니다. 즉시 폐기·재발급하고 재발 방지 조치를 합니다.",
    wrongExplanations: {
      a: "파일을 지워도 이미 키를 가져간 사람이 있을 수 있습니다.",
      c: "비공개 전환은 이미 노출된 키를 안전하게 만들지 못합니다.",
      d: "요금 폭증은 이미 악용되고 있다는 증거이므로 무시하면 안 됩니다.",
    },
    verified: true,
  },
  {
    id: "l7-q013",
    level: 7,
    unitId: "l7-u3",
    category: "설정 파일의 역할",
    type: "single",
    difficulty: "concept",
    prompt: "설정 파일의 역할에 대한 설명으로 가장 적절한 것은?",
    choices: [
      { id: "a", text: "프로그램의 동작 방식(연결 주소·옵션 값 등)을 코드 수정 없이 바꿀 수 있게 해주는 파일" },
      { id: "b", text: "프로그램의 실행 결과를 표와 그래프로 정리해 보여주는 보고서 파일" },
      { id: "c", text: "사용자가 입력한 업무 데이터를 계속 쌓아 두는 데이터 저장 파일" },
      { id: "d", text: "프로그램의 사용 방법을 순서대로 설명해 주는 도움말 문서" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "설정 파일 덕분에 코드를 고치지 않고 값만 바꾸어 프로그램 동작을 조정할 수 있습니다. .env 파일도 설정 파일의 일종입니다.",
    wrongExplanations: {
      b: "보고서 파일은 실행의 결과물이지 동작 방식을 정하는 파일이 아닙니다.",
      c: "데이터 저장 파일은 입력된 내용을 담을 뿐, 프로그램의 동작 방식을 바꾸지 않습니다.",
      d: "도움말 문서는 사람을 위한 설명으로, 프로그램이 실행 시 읽어 동작을 바꾸지 않습니다.",
    },
    verified: true,
  },
  {
    id: "l7-q014",
    level: 7,
    unitId: "l7-u4",
    category: "환경변수와 Git",
    type: "ox",
    difficulty: "application",
    prompt: "API 키가 들어 있는 .env 파일은 팀원과 공유하기 위해 Git에 함께 올리는 것이 좋다.",
    oxAnswer: false,
    explanation:
      ".env 파일은 Git에 올리지 않는 것이 원칙입니다. .gitignore에 등록해 공유에서 제외하고, 키는 별도의 안전한 경로로 전달합니다.",
    verified: true,
  },
  {
    id: "l7-q015",
    level: 7,
    unitId: "l7-u3",
    category: "설정 파일 변경 판단",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "영업 지원 직원이 '프로그램이 느려서' 설정 파일의 값을 임의로 바꾸고 공유 폴더에 덮어썼습니다. " +
      "이후 다른 동료들의 프로그램까지 이상하게 동작하기 시작했습니다. 올바른 판단은?",
    choices: [
      { id: "a", text: "빨라졌으니 잘한 일이다" },
      { id: "b", text: "설정 변경은 영향 범위를 확인하고 담당자와 협의해야 하며, 변경 전 원본을 백업해야 했다" },
      { id: "c", text: "설정 파일은 아무나 바꿔도 된다" },
      { id: "d", text: "느리면 무조건 설정 값을 크게 바꾸면 된다" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "설정 파일은 여러 사람에게 영향을 줄 수 있으므로 임의 변경은 금물입니다. 협의·백업 후 변경하는 것이 원칙입니다.",
    wrongExplanations: {
      a: "빨라졌다는 느낌과 무관하게 다른 사람에게 피해를 주었습니다.",
      c: "설정 파일은 함부로 바꿔서는 안 됩니다.",
      d: "값을 크게 바꾼다고 빨라지는 것이 아닙니다.",
    },
    verified: true,
  },
  {
    id: "l7-q016",
    level: 7,
    unitId: "l7-u5",
    category: "포트 충돌 해결",
    type: "single",
    difficulty: "application",
    prompt: "'포트가 이미 사용 중입니다'라는 오류가 났습니다. 올바른 이해와 대응은?",
    choices: [
      { id: "a", text: "같은 번호의 문(포트)을 두 프로그램이 동시에 쓰려 해서 생긴 문제이므로, 기존 프로그램을 종료하거나 다른 포트를 지정한다" },
      { id: "b", text: "프로그램이 오래 실행되어 지친 상태이므로, 컴퓨터를 쉬게 한 뒤 다시 실행한다" },
      { id: "c", text: "인터넷 회선이 느려서 생긴 문제이므로, 회선 속도가 회복될 때까지 기다린다" },
      { id: "d", text: "포트 번호가 보안 위험으로 차단된 것이므로, 보안 프로그램을 끄고 다시 실행한다" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "포트는 프로그램이 통신할 때 쓰는 문 번호입니다. 이미 켜져 있는 같은 프로그램이 있는지 확인하고 종료하거나, 다른 포트 번호를 지정합니다.",
    wrongExplanations: {
      b: "실행 시간과 무관하게, 같은 포트를 쓰는 프로그램이 이미 켜져 있는 것이 원인입니다.",
      c: "회선 속도와 무관한 로컬 충돌 문제라 기다려도 해결되지 않습니다.",
      d: "오류 문구는 '차단'이 아니라 '이미 사용 중'이며, 보안 프로그램을 끄는 것은 위험하고 원인에도 맞지 않습니다.",
    },
    verified: true,
  },
  {
    id: "l7-q017",
    level: 7,
    unitId: "l7-u5",
    category: "의존성 오류 해결",
    type: "error-cause",
    difficulty: "judgment",
    prompt:
      "패키지 관리자 명령(npm install)을 실행했는데도 '모듈을 찾을 수 없습니다' 오류가 계속 납니다. " +
      "올바른 판단은?",
    choices: [
      { id: "a", text: "오류 메시지에 나온 모듈 이름과 package.json의 의존성 목록을 대조하고, 설치 과정의 오류 메시지를 확인한다" },
      { id: "b", text: "같은 명령을 의미 없이 10번 반복한다" },
      { id: "c", text: "오류가 난 모듈 이름을 package.json의 의존성 목록에서 삭제한다" },
      { id: "d", text: "오류가 난 모듈을 불러오는 소스 코드 줄을 삭제해서 실행되게 한다" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "설치가 실패했다면 목록에 해당 모듈이 빠져 있거나 설치 중 오류가 났을 가능성이 큽니다. 메시지 대조와 설치 로그 확인이 올바른 순서입니다.",
    wrongExplanations: {
      b: "원인 파악 없는 반복은 해결에 도움이 되지 않습니다.",
      c: "목록에서 지우면 그 모듈이 필요한 기능은 앞으로도 영영 동작하지 않습니다.",
      d: "불러오는 줄을 지우면 오류는 사라질 수 있어도 해당 기능 자체가 사라집니다. 해결이 아니라 우회입니다.",
    },
    verified: true,
  },
  {
    id: "l7-q018",
    level: 7,
    unitId: "l7-u2",
    category: "node_modules 취급",
    type: "single",
    difficulty: "application",
    prompt: "node_modules 폴더에 대한 올바른 설명과 취급 방법은?",
    choices: [
      { id: "a", text: "용량이 크고 언제든 다시 설치할 수 있으므로 보통 Git에 올리지 않는다" },
      { id: "b", text: "꼭 Git에 올려야 프로그램이 실행된다" },
      { id: "c", text: "매일 수동으로 백업해야 한다" },
      { id: "d", text: "삭제하면 컴퓨터가 고장 난다" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "node_modules는 내려받은 의존성의 저장소로, package.json만 있으면 다시 설치할 수 있어 보통 Git 공유에서 제외합니다.",
    wrongExplanations: {
      b: "Git에 올리지 않아도 받는 쪽에서 설치하면 실행됩니다.",
      c: "수동 백업 대상이 아닙니다.",
      d: "삭제해도 다시 설치하면 되며 컴퓨터 고장과 무관합니다.",
    },
    verified: true,
  },
  {
    id: "l7-q019",
    level: 7,
    unitId: "l7-u4",
    category: "외부 전달 시 보안 판단",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "외주 개발사에 프로그램 소스를 넘기면서 .env 파일(실제 운영 API 키 포함)을 함께 압축해 보냈습니다. " +
      "올바른 판단은?",
    choices: [
      { id: "a", text: "개발에 필요하니 실제 운영 키를 그대로 주는 것이 맞다" },
      { id: "b", text: "실제 운영 키 대신 테스트용 키를 발급해 전달하고, 운영 키는 절대 외부에 전달하지 않는다" },
      { id: "c", text: "키를 메모장에 적어 같이 보내면 된다" },
      { id: "d", text: "압축 파일에 비밀번호를 걸었으니 안전하다" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "외부에는 테스트용 키를 발급해 주고, 실제 운영 키는 외부에 전달하지 않는 것이 원칙입니다. 압축 비밀번호는 키 노출을 막아주지 않습니다.",
    wrongExplanations: {
      a: "운영 키를 외부에 주면 악용·유출 위험이 큽니다.",
      c: "메모장 전달도 키 노출이며 안전한 방법이 아닙니다.",
      d: "압축 비밀번호는 전달 과정의 노출을 막지 못합니다.",
    },
    verified: true,
  },
  {
    id: "l7-q020",
    level: 7,
    unitId: "l7-u5",
    category: "오류 대응 태도",
    type: "case-judgment",
    difficulty: "judgment",
    prompt:
      "회계팀 직원은 프로그램 오류가 날 때마다 오류 메시지를 읽지 않고 컴퓨터만 재시작했습니다. " +
      "같은 오류가 일주일째 반복됩니다. 올바른 판단은?",
    choices: [
      { id: "a", text: "재시작을 더 자주 하면 해결된다" },
      { id: "b", text: "오류 메시지를 읽고(어떤 파일·어떤 항목이 문제인지 파악) 원인에 맞는 조치를 해야 한다" },
      { id: "c", text: "오류 메시지는 개발자만 보는 것이므로 무시해도 된다" },
      { id: "d", text: "프로그램을 삭제한다" },
    ],
    correctChoiceIds: ["b"],
    explanation:
      "오류 메시지는 해결책의 지도입니다. 핵심 단어(변수 이름, 파일 이름)를 파악해 원인에 맞는 조치를 하는 것이 가장 빠른 해결책입니다.",
    wrongExplanations: {
      a: "원인과 무관한 재시작 반복은 같은 오류를 되풀이합니다.",
      c: "오류 메시지는 누구나 읽고 단서를 찾을 수 있습니다.",
      d: "삭제는 해결책이 아닙니다.",
    },
    verified: true,
  },
];
