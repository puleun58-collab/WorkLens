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
      { id: "b", text: "컴퓨터 바탕화면에 있는 모든 파일" },
      { id: "c", text: "휴지통에 들어 있는 파일들" },
      { id: "d", text: "운영체제 설치 파일이 들어 있는 폴더" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "프로젝트 폴더 안에는 프로그램의 설계도(소스 코드), 부품 목록, 설정이 모두 들어 있습니다.",
    wrongExplanations: {
      b: "바탕화면의 파일들은 프로젝트와 무관한 경우가 많습니다.",
      c: "휴지통은 삭제된 파일이 임시로 보관되는 곳입니다.",
      d: "운영체제 설치 파일은 프로젝트 폴더와 무관합니다.",
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
      { id: "b", text: "컴퓨터 바이러스의 다른 이름" },
      { id: "c", text: "비밀번호를 암호화한 문자열" },
      { id: "d", text: "인터넷에서 복사해 온 글" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "소스 코드는 프로그램이 어떻게 동작해야 하는지를 프로그래밍 언어로 적은 것으로, 보통 src 같은 폴더에 모아 둡니다.",
    wrongExplanations: {
      b: "바이러스와 소스 코드는 무관합니다.",
      c: "암호화된 비밀번호는 소스 코드가 아닙니다.",
      d: "인터넷 글은 프로그램의 동작을 정의하지 않습니다.",
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
      { id: "b", text: "컴퓨터가 인터넷에 의존하는 정도" },
      { id: "c", text: "직원 간 업무 의존도" },
      { id: "d", text: "백업 파일의 개수" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "의존성은 이미 만들어진 외부 부품을 가져다 쓰는 것으로, 엑셀에서 복잡한 계산을 함수에 맡기는 것과 비슷합니다.",
    wrongExplanations: {
      b: "인터넷 의존도와는 무관한 용어입니다.",
      c: "조직 용어가 아니라 프로그램 용어입니다.",
      d: "백업 파일 개수와는 무관합니다.",
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
      { id: "b", text: "컴퓨터를 새로 산다" },
      { id: "c", text: "소스 코드를 전부 지운다" },
      { id: "d", text: "인터넷 연결을 끊는다" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "'모듈을 찾을 수 없습니다'는 의존성(node_modules)이 비어 있다는 뜻으로, 패키지 관리자 명령 한 번으로 해결되는 대표적인 경우입니다.",
    wrongExplanations: {
      b: "컴퓨터 문제가 아니라 의존성 미설치 문제입니다.",
      c: "소스 코드를 지우면 복구가 어렵습니다.",
      d: "인터넷을 끊으면 오히려 설치가 불가능해집니다.",
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
      { id: "b", text: "컴퓨터 주변 온도를 재는 센서의 값" },
      { id: "c", text: "에어컨 설정 온도" },
      { id: "d", text: "화면 밝기 조절 값" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "환경변수는 환경(내 PC, 회사 서버)에 따라 달라지는 값을 코드와 분리해 보관하는 방식으로, .env 파일에 적어 둡니다.",
    wrongExplanations: {
      b: "온도 센서 값과는 무관합니다.",
      c: "에어컨 설정과는 무관합니다.",
      d: "화면 밝기는 운영체제 설정입니다.",
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
      { id: "b", text: "원인: 모니터 해상도 문제 / 해결: 화면 해상도를 변경한다" },
      { id: "c", text: "원인: 키보드 고장 / 해결: 키보드를 교체한다" },
      { id: "d", text: "원인: 바이러스 감염 / 해결: 컴퓨터를 포맷한다" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "환경변수 오류는 '설정 값을 읽어올 파일·값이 없다'는 뜻입니다. .env 파일 존재 여부와 해당 변수 값을 먼저 확인합니다.",
    wrongExplanations: {
      b: "해상도는 환경변수 오류와 무관합니다.",
      c: "키보드 고장은 프로그램 실행 오류의 원인이 아닙니다.",
      d: "바이러스보다 .env 누락이 훨씬 흔한 원인입니다.",
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
      { id: "b", text: "택배 상자를 포장하는 기계" },
      { id: "c", text: "엑셀 파일을 압축하는 프로그램" },
      { id: "d", text: "바이러스를 삭제하는 도구" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "패키지 관리자는 package.json의 부품 목록을 보고 필요한 외부 코드를 자동으로 내려받아 설치해 줍니다.",
    wrongExplanations: {
      b: "택배 포장과는 무관합니다.",
      c: "엑셀 압축 프로그램이 아닙니다.",
      d: "보안 프로그램이 아닙니다.",
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
      { id: "b", text: "컴퓨터를 꾸미는 배경화면 파일" },
      { id: "c", text: "게임 저장 파일" },
      { id: "d", text: "프린터 사용 설명서" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "설정 파일 덕분에 코드를 고치지 않고 값만 바꾸어 프로그램 동작을 조정할 수 있습니다. .env 파일도 설정 파일의 일종입니다.",
    wrongExplanations: {
      b: "배경화면은 개인 취향 설정이지 프로그램 설정 파일이 아닙니다.",
      c: "게임 저장 파일은 프로그램 설정과 무관합니다.",
      d: "프린터 설명서는 문서이지 설정 파일이 아닙니다.",
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
      { id: "b", text: "컴퓨터 전원이 부족하다는 뜻이므로 충전기를 연결한다" },
      { id: "c", text: "인터넷 요금을 내지 않아서 생긴 문제이다" },
      { id: "d", text: "마우스를 바꾸면 해결된다" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "포트는 프로그램이 통신할 때 쓰는 문 번호입니다. 이미 켜져 있는 같은 프로그램이 있는지 확인하고 종료하거나, 다른 포트 번호를 지정합니다.",
    wrongExplanations: {
      b: "전원 문제와는 무관합니다.",
      c: "요금 문제와는 무관합니다.",
      d: "마우스와는 무관합니다.",
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
      { id: "c", text: "소스 코드를 전부 삭제한다" },
      { id: "d", text: "컴퓨터를 버리고 새로 산다" },
    ],
    correctChoiceIds: ["a"],
    explanation:
      "설치가 실패했다면 목록에 해당 모듈이 빠져 있거나 설치 중 오류가 났을 가능성이 큽니다. 메시지 대조와 설치 로그 확인이 올바른 순서입니다.",
    wrongExplanations: {
      b: "원인 파악 없는 반복은 해결에 도움이 되지 않습니다.",
      c: "소스 코드 삭제는 문제를 키울 뿐입니다.",
      d: "환경 문제이지 컴퓨터 고장이 아닙니다.",
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
