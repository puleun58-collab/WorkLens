# 학습센터 콘텐츠 작성 가이드

이 파일은 각 단계별 콘텐츠·문제은행을 작성하는 에이전트를 위한 지침이다.
반드시 아래 형식을 정확히 따른다.

## 파일 위치

- 콘텐츠: `~/workspace/WorkLens/src/lib/learn/content-lNN.ts` (NN = 01~10)
- 문제은행: `~/workspace/WorkLens/src/lib/learn/questions-lNN.ts`
- 사전 진단: `~/workspace/WorkLens/src/lib/learn/questions-diagnostic.ts` (LEVEL 10 담당이 작성)

## 콘텐츠 형식 (content-lNN.ts)

```ts
import type { LearnContent } from "./types";

export const CONTENT_L01: LearnContent = {
  level: 1,
  intro: "이 단계에서 배우는 내용에 대한 2~3문장 소개.",
  units: [
    {
      id: "l1-u1",
      title: "단위 제목",
      estimatedMinutes: 10,
      goal: "이 단위를 마치면 학습자가 할 수 있게 되는 것 한 문장.",
      concepts: [
        { term: "용어", definition: "초보자가 이해할 수 있는 쉬운 설명 1~2문장." },
      ],
      whyNeeded: "이 개념을 왜 알아야 하는지 2~3문장.",
      usageSituations: [
        "실제 업무 상황 예시 1",
        "실제 업무 상황 예시 2",
      ],
      comparisons: [
        { a: "개념 A", b: "개념 B", difference: "차이점 설명." },
      ],
      cases: [
        {
          title: "사례 제목 (예: 총무팀 월간 보고서)",
          situation: "상황 설명 2~3문장.",
          lesson: "이 사례에서 배우는 점 1~2문장.",
        },
      ],
      practice: {  // 해당되는 경우만
        title: "실습 제목",
        steps: ["1단계 설명", "2단계 설명"],
      },
      mistakes: [
        {
          mistake: "흔한 실수",
          why: "왜 발생하는지",
          fix: "올바른 방법",
        },
      ],
      summary: [
        "핵심 요약 1",
        "핵심 요약 2",
      ],
    },
    // 단계당 4~6개 단위
  ],
};
```

작성 원칙:
- 초보자가 이해할 수 있는 한국어. 전문 용어는 첫 등장 시 설명.
- 사무·총무·물류·영업·회계 등 일반 기업 업무 중심 사례.
- 단순 제목+두세 문장은 미완료. 각 단위는 충실하게 작성하되 불필요하게 긴 이론은 지양.
- 기술 도구·명령어·서비스는 버전·환경에 따라 달라질 수 있음을 고려. 확인되지 않은 최신 기능·명령어를 확정적으로 설명 금지.
- comparisons, practice는 해당 없으면 생략 가능. 나머지는 필수.

실습은 학습 목표와 입력 방식을 맞춘다. `commands`가 있는 CLI·Git 실습만 Windows PowerShell 가상 터미널을 사용하며, 명령 문자열은 복사 예시와 실행 안내에 동일하게 유지한다. 그 외 실습은 단계별 작성란을 제공하고, LEVEL 1의 반복 업무 실습은 세 업무를 비교해 후보 하나를 선택하는 전용 폼을 사용한다. 작성 실습은 단위 이동 시 초기화되며 저장·정답 판정·점수 반영을 하지 않는다. 명령 실습의 중간 상태 저장은 공식 퀴즈와 분리한다.

표시용 설명은 `<strong>라벨:</strong> 같은 행의 일반 설명` 형식을 사용한다. 실습 제목·실행 환경·연습 모드·실습 방법·학습 안내·힌트·정답/오답 피드백·해설·결과의 라벨만 굵게 표시하며, 긴 본문·목록·코드·표·독립 요약 항목은 합치지 않는다. 표시용 대시 구분은 콜론으로 바꾸되 명령·옵션·파일명·URL·범위는 보존한다. 문제은행의 저장 지문값은 바꾸지 않고 표시 단계에서 처리한다. 힌트만 터미널 아래 실행·확인 버튼과 같은 도구 행에 배치하며, 모바일에서는 힌트와 버튼을 두 줄로 나눈다. 핵심 요약의 배경은 실무 사례 헤더와 같은 `--learn-card-blue` 값을 재사용한다.

## 문제은행 형식 (questions-lNN.ts)

```ts
import type { LearnQuestion } from "./types";

export const QUESTIONS_L01: LearnQuestion[] = [
  {
    id: "l1-q001",
    level: 1,
    unitId: "l1-u1",  // 이 문제가 평가하는 학습 단위의 안정 식별자 (필수 — 단위별 균형 출제·오답 복습 연결의 기준)
    category: "AI와 생성형 AI의 차이",
    type: "single",  // single | multiple | ox | command-result | error-cause | case-judgment | terminal-task
    difficulty: "concept",  // concept | application | judgment
    prompt: "문제 내용. 명확하게 한 가지만 묻는다.",
    choices: [
      { id: "a", text: "선택지 1" },
      { id: "b", text: "선택지 2" },
      { id: "c", text: "선택지 3" },
      { id: "d", text: "선택지 4" },
    ],
    correctChoiceIds: ["b"],
    explanation: "정답인 이유 1~2문장.",
    wrongExplanations: { a: "a를 고른 경우 설명." },
    verified: true,
  },
  // OX 예시
  {
    id: "l1-q002",
    level: 1,
    category: "...",
    type: "ox",
    difficulty: "concept",
    prompt: "OX로 답할 수 있는 명제.",
    oxAnswer: true,
    explanation: "...",
    verified: true,
  },
  // 복수 선택 예시 (정답 2개 이상, correctChoiceIds에 전부)
  // terminal-task 예시 (LEVEL 4~5만)
  {
    id: "l4-q009",
    level: 4,
    category: "폴더 생성과 이동",
    type: "terminal-task",
    difficulty: "application",
    prompt: "가상 터미널에서 다음을 수행하세요: ...",
    terminalTask: {
      scenario: "folder-nav",  // folder-nav | git-basic | git-remote | failure
      instructions: ["mkdir WorkLens", "cd WorkLens", "현재 경로를 확인하세요"],
      successChecks: [
        { kind: "dir-exists", path: "C:\\Users\\학습자\\WorkLens" },
        { kind: "cwd-is", path: "C:\\Users\\학습자\\WorkLens" },
      ],
      hint: "막히면 help를 입력해 보세요.",
    },
    explanation: "과제 성공 조건 설명.",
    verified: true,
  },
];
```

문제 수:
- LEVEL 1~9: 단계당 최소 20문제 (출제 10문항의 2배)
- LEVEL 10: 최소 40문제 (출제 20문항의 2배)
- 난이도 비중: L1~3 = concept 60% / application 30% / judgment 10%
  L4~7 = concept 30% / application 40% / judgment 30%
  L8~10 = concept 10% / application 30% / judgment 60%

품질 규칙 (필수):
- 정답이 명확할 것. 여러 개로 해석되면 수정.
- 복수 선택은 정답 개수를 정확히 (correctChoiceIds에 전부).
- 모든 선택지가 그럴듯할 것 (명백한 오답 1개로 때우기 금지).
- 문제 ID는 "l{레벨}-q{001~}" 형식으로 중복 없이.
- unitId는 해당 개념을 실제로 가르치는 학습 단위의 ID로 정확히 연결한다. 학습 단위를 수정·삭제할 때는 연결된 문항의 정답·해설 유효성을 함께 검증하고, 검증 전 문항은 verified를 false로 둔다.
- category는 학습 목표·개념 분류명.
- explanation 필수. wrongExplanations는 권장.
- 학습 콘텐츠에 없는 내용을 근거 없이 평가 금지.
- 명령어 문제는 Windows PowerShell 기준임을 명시 (macOS/Linux 명령어와 혼동 금지).
- verified: true (작성자가 직접 검증한 문제만).
- 정답이 다른 문항의 선택지·본문에 노출되지 않도록.

## 주의

- `LearnQuestion`, `LearnContent` 타입은 `src/lib/learn/types.ts`에 정의됨. 반드시 import하여 사용.
- TypeScript가 컴파일되어야 함 (`bun x tsc --noEmit` 수준).
- 한국어 문장, 초보자 눈높이.
