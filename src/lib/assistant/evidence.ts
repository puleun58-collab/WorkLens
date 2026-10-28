import { FACTOR_LABELS } from "@/lib/ax/schema";
import { GATE_LABELS, LEVEL_LABELS } from "@/lib/ax/policy";

/**
 * Internal evidence bank for the WorkLens assistant.
 * Each entry is grounded in real product UI, the usage guide, or policy constants.
 * `screen` uses real screen/menu names only; never internal function names or code paths.
 */
export interface AssistantEvidence {
  id: string;
  /** Display path shown under "확인한 근거", "관련 안내", or "관련 화면". */
  screen: string;
  title: string;
  text: string;
  keywords: RegExp;
  /**
   * Evidence kind for conditional display:
   * - "policy": Level/Gate/policy explanations → show as "관련 안내"
   *   (system guidance, never as verified lookup evidence)
   * - "guide": general usage guides → hide sources (answer body only)
   * - "menu": menu location info → show as "관련 화면" (not as evidence)
   * - "diagnosis": task-specific diagnosis → show as "확인한 근거" with actual data
   */
  kind: "policy" | "guide" | "menu" | "diagnosis";
}

const LEVEL_TEXT = `자동화 수준은 Level 0~3으로 판정됩니다. ${LEVEL_LABELS.map((label, i) => `Level ${i}(${label.replace(/^L\d+ /, "")})`).join(", ")}. Level 0은 검토·검증만 허용하고 신규 운영 기능 구현을 강제하지 않습니다. Level 1은 담당자 요청 기반 보조 기능만 허용하고 무인 자동 실행을 금지합니다.`;
const GATE_TEXT = `실행 상태는 ${GATE_LABELS.ready}(구현 진행 가능), ${GATE_LABELS.conditional}(선행 조건 확인 후 진행), ${GATE_LABELS.blocked}(진행 보류, 운영 기능 구현·배포 금지)로 구분됩니다. 진행 보류는 차단 해제 전까지 신규 운영 기능·스캐폴딩·배포를 진행하지 않는 상태이고, 확인 후 진행은 선행 조건이 확인된 단계만 구현하는 상태입니다.`;

export const ASSISTANT_EVIDENCE: AssistantEvidence[] = [
  {
    id: "ax-level",
    screen: "업무 자동화 진단 > Level 기준",
    title: "자동화 Level 결정",
    text: `${LEVEL_TEXT} Level은 6종 Factor(반복성, 규칙성, 데이터 구조화, 시스템 접근성, 담당자 판단 필요도, 운영 위험) 평가와 업무 정보를 바탕으로 AI가 진단하고, 사용자가 Factor 값을 보정할 수 있습니다.`,
    keywords: /level|레벨|자동화\s*수준|판정/iu,
    kind: "policy",
  },
  {
    id: "ax-gate",
    screen: "업무 자동화 진단 > Gate 상태",
    title: "Gate 상태 의미",
    text: `${GATE_TEXT} Gate는 기술 확인·정보 충분성·진행 판정에 따라 정해지며, 사용자가 임의로 변경할 수 없습니다.`,
    keywords: /gate|게이트|진행\s*보류|확인\s*후\s*진행|진행\s*가능|차단/iu,
    kind: "policy",
  },
  {
    id: "ax-factor",
    screen: "업무 자동화 진단 > Factor 평가",
    title: "Factor 6종",
    text: `업무 진단은 6종 Factor로 평가합니다: ${Object.values(FACTOR_LABELS).join(", ")}. 각 항목은 1~5점으로 평가되며, 사용자는 AI 평가값을 보정할 수 있습니다. 보정값은 Level·매트릭스·우선순위에 반영됩니다.`,
    keywords: /factor|팩터|평가|보정/iu,
    kind: "policy",
  },
  {
    id: "ax-flow",
    screen: "사용 가이드 > 업무 자동화 진단",
    title: "업무 자동화 진단 흐름",
    text: "업무 등록 → 업무 진단(평가값·근거·AS-IS·TO-BE 확인과 단계별 사람 검토) → 자동화 매트릭스(가치·실현 가능성 비교) → 결과·로드맵(허용 범위·선행 조건·완료 기준 확인) 순서입니다. 올인원 지시문 생성은 구현 완료가 아닙니다. 확정된 이번 범위는 코딩 에이전트의 첫 MVP 구현과 실제 검증, 해당되는 GitHub·배포와 운영 확인까지 이어집니다.",
    keywords: /업무\s*등록|업무\s*진단|진단\s*방법|흐름|순서|단계/iu,
    kind: "guide",
  },
  {
    id: "ax-matrix",
    screen: "업무 자동화 진단 > 자동화 매트릭스",
    title: "자동화 매트릭스",
    text: "자동화 매트릭스는 업무를 자동화 가치와 기술 실현 가능성 축으로 비교합니다. 빠른 실행 후보·전략 과제·검토 후보·중복 검토 영역으로 나뉘며, Factor 보정은 축·Level·순위에 반영됩니다. Gate는 매트릭스 위치와 별개로 기술 확인·정보 충분성·진행 판정에 따라 유지됩니다.",
    keywords: /매트릭스|가치|실현\s*가능성|우선순위/iu,
    kind: "guide",
  },
  {
    id: "ax-result",
    screen: "결과·로드맵 > 완료 기준",
    title: "결과·로드맵과 완료 기준",
    text: "결과·로드맵은 01 구현 범위(이번 구현·담당자 수행 유지·현재 자동화 제외), 02 구현 전 확인사항(선행 조건·적용 범위), 03 완료 기준(검증 방법·통과 조건·실패 기준·최종 승인·주요 예외·위험 사항), 04 올인원 지시문으로 구성됩니다. 완료 기준의 수치는 사용자 입력이나 확정 진단 근거가 확인된 것만 사용합니다. 진단·계획·지시문 생성만으로 완료되지 않으며, 미실행 테스트·배포를 완료라고 보고하지 않습니다.",
    keywords: /결과|로드맵|완료\s*기준|검증\s*방법|통과\s*조건|실패\s*기준|최종\s*승인|예외|위험/iu,
    kind: "policy",
  },
  {
    id: "ax-prompt",
    screen: "결과·로드맵 > 04 올인원 지시문",
    title: "올인원 지시문 사용",
    text: "결과·로드맵에서 01 구현 범위·02 구현 전 확인사항·03 완료 기준을 확인하고 Codex 또는 Claude Code용 구현 계획을 생성하세요. '설치·시작 가이드'로 작업할 프로젝트에서 코딩 도구를 시작한 뒤 '04 올인원 지시문'의 Codex/Claude Code 탭에서 '전체 보기'로 펼쳐 읽거나 'Codex용 올인원 지시문 복사' 또는 'Claude Code용 올인원 지시문 복사'로 접힌 상태에서도 전체를 복사해 도구에 붙여넣으세요. 이 실행으로 허용된 범위의 실제 첫 MVP를 개발합니다. 별도의 사후 MVP 개발 단계를 기다리지 않습니다.",
    keywords: /올인원|지시문|codex|claude|복사|붙여넣|프롬프트/iu,
    kind: "guide",
  },
  {
    id: "ax-mvp",
    screen: "결과·로드맵 > 올인원 지시문 > 첫 MVP",
    title: "첫 MVP 구현과 코딩 에이전트",
    text: "올인원 지시문은 별도의 개발 전 안내물이 아니라 Codex 또는 Claude Code가 현재 저장소에서 실제 첫 MVP를 구현하도록 하는 실행 지시문입니다. 한 도구에서 실행해도 되지만 붙여넣기·에이전트 응답만으로 완료되지 않습니다. 구현된 동작, 실제 테스트·빌드 결과와 완료 기준을 확인하세요. 스캐폴딩·TODO·모의 구현은 완료가 아닙니다. Level·Gate와 확정된 사람 검토의 유지·보류·제외·보완을 지키며, 미해결 조건의 범위는 임의로 구현하지 않고 확인된 독립 작업을 일괄 차단하지 않습니다. 웹앱이 아닌 CLI·로컬 프로그램은 웹에 배포하지 않고 해당 실행 환경에서 동작을 검증합니다. 개별 업무의 구현·배포 결과는 실제 프로젝트에서 확인해야 하며, 특정 사례의 검증 결과가 모든 업무의 성공을 보장하지는 않습니다.",
    keywords: /mvp|엠브이피|첫\s*구현|별도\s*개발|별도로\s*개발|따로\s*개발|개발\s*단계|에이전트.*충분|에이전트.*끝|에이전트.*완료|실행.*충분|실행.*끝|실행.*완료|codex.*끝|claude.*끝|cli|로컬\s*프로그램|cloudflare|클라우드플레어|보장/iu,
    kind: "guide",
  },
  {
    id: "ax-release",
    screen: "설치·시작 가이드 > STEP 07 GitHub 저장과 배포",
    title: "GitHub와 배포 시점",
    text: "첫 MVP의 실제 구현·테스트·빌드 결과를 확인한 다음 변경 범위·민감정보와 Git 상태를 점검하고, 저장소의 기존 방식대로 커밋·GitHub 푸시·CI/PR을 확인하세요. 배포는 해당 작업에 필요한 경우 사용자 요청·권한 및 기존 플랫폼 설정을 확인하고 진행합니다. GitHub에 올리거나 Preview URL이 생겼다고 Production 완료는 아닙니다. 배포 뒤 실제 서비스에서 핵심 기능과 필요한 환경·요청을 확인하세요. 배포 대상이 아닌 작업은 해당 완료 기준의 실제 검증으로 마무리합니다.",
    keywords: /github|깃허브|git|푸시|push|배포|production|운영\s*환경|언제\s*올|언제\s*배포/iu,
    kind: "guide",
  },
  {
    id: "ax-gitflow",
    screen: "설치·시작 가이드 > Git·GitHub 작업 흐름",
    title: "Git·GitHub 작업 흐름",
    text: "설치·시작 가이드의 'Git·GitHub 작업 흐름' 기준 순서는 Git 준비 → git init(새 저장소 만들기) 또는 git clone(기존 저장소 복제하기) → Branch → git add → git commit → git push → PR → CI → Merge → Deploy → Production 검증입니다. git init과 clone은 프로젝트 상태에 따라 선택하며 기존 저장소를 다시 초기화하지 않습니다. CI는 Push 또는 PR 생성 시 실행될 수 있습니다. PR은 변경 내용을 검토하고 병합하도록 요청하는 단계이고 Merge는 대상 브랜치에 실제로 병합하는 단계로 서로 다릅니다. Merge와 Deploy도 서로 다른 작업이며, git push를 했다고 자동으로 운영 배포까지 완료되는 것은 아닙니다. 배포가 성공해도 배포된 기능이 실제로 정상 작동하는지는 Production 검증으로 따로 확인해야 합니다. 저장소에 이미 CI·배포 자동화가 있으면 그 방식을 우선하며, 모든 프로젝트에서 순서가 절대적으로 동일하거나 모든 단계가 필수인 것은 아닙니다.",
    keywords: /git|깃|push|푸시|pull\s*request|merge|머지|병합|clone|클론|브랜치|branch|커밋|commit/iu,
    kind: "guide",
  },
  {
    id: "ax-completion",
    screen: "결과·로드맵 > 03 완료 기준",
    title: "MVP 완료 판정",
    text: "지시문 생성이나 Codex/Claude Code 실행 자체는 완료가 아닙니다. 확정된 이번 구현 범위에서 실제 동작을 구현하고 완료 기준에 맞는 테스트·빌드를 실행해 결과를 확인해야 합니다. 배포 대상이면 허가된 기존 GitHub·배포 절차를 거쳐 Production의 실제 핵심 기능과 오류를 확인한 뒤 완료로 판단합니다. 비배포 작업도 해당 완료 기준을 실제로 검증해야 합니다. 미해결 승인·기술 조건, 미검증 기능과 실패 항목은 완료로 표기하지 않고 해당 범위의 후속 확인 사항으로 남깁니다.",
    keywords: /mvp.*완료|mvp.*끝|완료.*mvp|언제.*완료|언제.*끝|다\s*됐|끝난|끝났|마무리|성공\s*기준|완성/iu,
    kind: "guide",
  },
  {
    id: "ax-hitl-review",
    screen: "업무 자동화 진단 > 단계별 자동화 판단·위험·확인사항 검토",
    title: "HITL 검토 상태와 건수",
    text: "사람 검토(HITL) 상태는 검토 전, 보완 중, 검토 완료, 재확인 필요로 표시됩니다. 검토 완료는 확정(confirmed) 기록이 현재 원본 항목과 정확히 연결되고 출처·내용·해시가 현재 원본과 일치해 유효성 검증을 통과한 경우에만 인정됩니다. 이전에 확정했더라도 원본이 변경되거나 연결이 달라지면 재확인 필요가 되며 검토 완료로 세지 않습니다. 보완 중(editing)인 항목도 아직 유효한 완료가 아니어서 검토 필요에 포함됩니다. 화면 상단 건수는 전체 = 검토 완료 + 검토 필요로 계산하고, 검토 완료는 유효한 확정 기록 수, 검토 필요는 그 나머지입니다. 개별 업무의 실제 건수와 상태는 그 업무의 검토 기록에서 확인해야 하며, 제공된 정보에 없으면 추측할 수 없습니다.",
    keywords: /검토\s*완료|검토\s*필요|검토\s*상태|검토\s*건수|재확인|보완\s*중|hitl|사람\s*검토/iu,
    kind: "policy",
  },
  {
    id: "ax-hitl-actions",
    screen: "업무 자동화 진단 > 사람 검토 결정",
    title: "HITL 유지·보류·제외·보완",
    text: "사람 검토 결정은 유지·보류·제외·보완 네 가지입니다. 유지는 AI 판단을 그대로 적용하고, 보완은 담당자가 내용을 보완해 반영하는 것입니다. 보류는 조건이 충족될 때까지 해당 기능의 구현을 미루는 것으로, 보류된 기능은 현재 구현 대상·필수 산출물·완료 기준에서 빠지고 사유와 재개 조건만 안내됩니다. 제외는 이번 구현 범위에서 빼는 것으로, 제외된 기능은 올인원 지시문에 현재 구현 범위에서 제외라고 명시되고 구현 요구·필수 산출물·완료 조건에 포함되지 않습니다. 보류는 조건이 되면 다시 구현할 수 있지만 제외는 이번 범위 자체에서 빠진다는 점이 다릅니다. 이 보류는 실행 상태(Gate)의 진행 보류와는 다른, 개별 기능에 대한 결정입니다. 업무 원본이 변경되면 기존 결정은 현재 원본과 대조해 유효성을 다시 확인하며, 연결이 달라진 결정은 재확인 필요 상태가 됩니다.",
    keywords: /제외|보류는|보류란|보류와|보류된|검토\s*결정|hitl/iu,
    kind: "policy",
  },
  {
    id: "ax-human",
    screen: "업무 자동화 진단 > 담당자 수행",
    title: "담당자 수행 유지",
    text: "담당자 수행·검토·승인은 서로 다른 의미입니다. '담당자 수행 유지'는 AI가 자동화로 대체하지 않고 담당자가 직접 처리하도록 남겨두는 단계입니다. '담당자 검토'는 담당자가 결과나 판단을 확인하는 것이고, '담당자 승인'은 해당 업무에 명시된 승인 절차가 있는 경우에만 해당합니다. 담당자 수행 단계라는 이유만으로 최종 승인이 필요하다고 단정하지 않으며, 승인 요건은 업무에 명시된 조건으로 확인합니다. 명시적으로 담당자에게 남겨진 승인은 AI가 대신 확정할 수 없습니다. 승인 주체·권한이 제공된 정보에서 확인되지 않으면 임의로 지정하지 않습니다.",
    keywords: /담당자|사람\s*유지|승인|수행\s*유지/iu,
    kind: "policy",
  },
  {
    id: "ax-attach",
    screen: "업무 자동화 진단 > 업무 등록·첨부 파일",
    title: "참고 파일 다중 첨부",
    text: "업무 등록과 진단 화면에서 업무당 최대 10개까지 참고 파일을 첨부할 수 있습니다. 지원 형식은 CSV·XLSX·DOCX·PPTX·PDF이며 형식별 크기 제한이 있습니다. 같은 파일인지 여부는 파일명이 아니라 파일 내용의 지문(SHA-256)으로 판정하므로, 내용이 같은 파일은 중복으로 다시 추가되지 않고 이름이 같아도 내용이 다르면 별도 파일로 추가됩니다. 첨부한 파일은 파일별로 분석되어 요약이 만들어지고, 여러 파일의 요약은 파일별 출처를 구분해 하나로 통합되어 진단 입력에 반영됩니다. AI에 전달되는 것은 파일 원문 전체가 아니라 이 분석 요약입니다. 파일 원본은 저장되지 않고 파일 정보와 요약만 보존되므로, 새로고침한 뒤에는 같은 파일을 다시 선택해 지문이 일치하면 요약이 복원됩니다. 첨부 구성이 실제로 바뀌면 기존 진단은 무효화되어 다시 진단해야 하지만, 같은 파일을 다시 선택한 것만으로는 초기화되지 않습니다.",
    keywords: /첨부|재첨부|파일.*몇\s*개|파일.*개수|파일.*다시|다시\s*선택.*파일|다시\s*첨부.*파일/iu,
    kind: "guide",
  },
  {
    id: "ws-files",
    screen: "워크스페이스 > 파일 작업",
    title: "파일 업로드와 문서 처리",
    text: "워크스페이스에서 파일을 선택하고 실행 버튼으로 문서 처리(분석·비교·검수·추출·취합)를 수행합니다. 결과는 화면에서 확인하며, 오류가 있으면 해당 화면의 안내를 따릅니다.",
    keywords: /파일\s*업로드|문서\s*처리|실행\s*버튼|워크스페이스/iu,
    kind: "guide",
  },
  {
    id: "law-research",
    screen: "법령",
    title: "종합 리서치",
    text: "법령 조회는 왼쪽 메뉴 RESEARCH의 '법령'에서 할 수 있습니다. 법령 검색·종합 리서치 탭에서 법령·판례·결정례를 검색하고 조문을 확인할 수 있습니다. 도우미는 법률 해석이나 판례 검색을 직접 수행하지 않으며, 기능 사용 방법만 안내합니다.",
    keywords: /법령|리서치|판례|조문/iu,
    kind: "menu",
  },
  {
    id: "law-mcp-design",
    screen: "법령 > 종합 리서치",
    title: "법령 MCP 연동과 근거 확인 방식",
    text: "종합 리서치의 법령·판례 조회는 법령 MCP를 통해 실제 자료를 조회합니다. AI가 법령이나 판례를 기억만으로 새로 만들어 확정 근거로 제시하지 않습니다. 결과 상태는 채택된 근거를 기준으로 정해집니다: 관련 근거를 확인했습니다, 관련 근거를 일부 확인했습니다, 직접 관련된 근거가 충분하지 않습니다, 관련 근거를 확인하지 못했습니다. 확인된 근거와 참고 목록·미확인 항목은 구분해 표시합니다. 다만 법령 MCP를 사용해도 질문과 관계없는 실제 조문 선택, 조문 존재를 근거 확인으로 오판, 적용 시점 혼동, 검색 가능한 자료 누락, 복수 쟁점의 일부만 확인, 확보된 근거의 의미 오해 같은 오류 가능성은 남으므로 확정 보장은 하지 않습니다.",
    keywords: /법령|mcp|판례|조문|법령.*환각|환각.*법령|인용|내용\s*불일치/iu,
    kind: "policy",
  },
  {
    id: "law-error-types",
    screen: "법령 > 종합 리서치",
    title: "법령 오류 유형 구분",
    text: "법령 오류는 한 가지 '환각'으로 뭉뚱그릴 수 없습니다. 생성 환각은 존재하지 않는 법령·조문·판례를 만들어내는 오류로, 법령 MCP의 실제 자료 조회·확인으로 억제되지만 MCP 사용만으로 완전히 사라졌다고 단정하지는 않습니다. 원문에 없는 내용을 AI 설명에 덧붙인 경우 그 설명 자체의 오류 가능성도 인정합니다. 근거 매칭 오류는 실제 존재하지만 질문·쟁점과 직접 관련되지 않은 근거를 선택하는 오류입니다. 해석 오류는 실제 조문의 의미·요건·예외를 잘못 설명하는 오류입니다. 적용 시점 오류는 개정 전후 법령이나 시행일을 잘못 적용하는 오류로, 법제처 자료의 공포일·시행일·현행 여부를 확인하는 대상입니다. 근거 누락은 실제 관련 자료가 존재하지만 검색·채택되지 않은 오류입니다. 원문 조회 실패는 MCP 장애·응답 누락·시간 초과로 자료를 확보하지 못한 상태로, 검색 결과 없음과는 다릅니다. 검증은 네 단계로 구분합니다: 원문이 실제 존재하는지, 질문·쟁점과 관련 있는지, 원문을 정확하게 해석했는지, 실제 사건에 적용할 수 있는지. '직접 관련된 근거가 충분하지 않다'는 법령 자체가 없다는 뜻이 아니며, '자료 조회를 완료하지 못했다'는 자료가 없다는 뜻이 아닙니다.",
    // NOTE: relevanceScore splits keywords on "|", so no (|) groups here:
    // each alternative must be a standalone pattern.
    keywords: /법령.*환각|환각.*법령|mcp.*환각|환각.*mcp|근거\s*매칭|매칭\s*오류|해석\s*오류|적용\s*시점|시행일|근거\s*누락|조회\s*실패|오류\s*유형|법령.*틀|법령.*잘못|법령.*오류|근거\s*부족|자료\s*없음/iu,
    kind: "policy",
  },
  {
    id: "law-mcp-value",
    screen: "법령 > 종합 리서치",
    title: "법령 MCP 연동의 가치",
    text: "법령 MCP 연동의 차이는 공식 자료 기반 조회에 있습니다. 법제처 MCP를 통해 실제 법령·판례 자료를 조회하므로 AI가 기억만으로 법령을 제시하는 방식과 달리 실제 원문의 존재를 확인할 수 있습니다. WorkLens 검증 방식은 쟁점별로 근거가 해당 쟁점을 다루는지 확인하고, 채택된 근거를 기준으로 관련 근거 확인, 일부 확인, 직접 관련 충분하지 않음, 확인 못함, 조회 완료 못함 상태를 구분하는 것입니다. 확인된 근거와 참고 목록·미확인 항목은 구분해 표시합니다. 확인 경로는 종합 리서치 결과의 상세 근거이며, 발췌는 전문이 아니므로 조문 전문은 법령 검색에서 확인합니다. 렌즈봇은 이 기능을 설명할 뿐 법령 MCP를 직접 조회하지 않습니다. 남은 오류는 근거 매칭·해석·적용 시점 오류와 근거 누락·조회 실패이며, 완전히 제거됐다고 보장하지 않습니다. 검증된 정확도·오류 감소 수치는 근거에 없습니다.",
    // NOTE: relevanceScore splits keywords on "|", so no (|) groups here.
    keywords: /법령.*mcp|mcp.*법령|mcp.*의미|mcp.*연동|mcp.*연결|mcp.*가치|mcp.*왜|mcp.*뭐|법령.*의미|법령.*가치|법령.*믿|법령.*신뢰|신뢰.*법령|일반\s*ai.*다른|일반\s*ai.*달라|일반\s*ai.*차이|일반.*다른|일반.*달라|일반.*차이|원문/iu,
    kind: "policy",
  },
  {
    id: "law-lensbot-role",
    screen: "렌즈봇",
    title: "렌즈봇과 법령 기능의 역할",
    text: "렌즈봇은 WorkLens 기능과 사용 방법을 안내하는 읽기 전용 도우미입니다. 법령 MCP를 직접 조회하지 않으며, 법령·판례 자료 조회는 왼쪽 메뉴 RESEARCH의 '법령'에서 별도의 법령 MCP 연동 경로로 수행합니다. 렌즈봇이 실시간 법령 원문을 조회한 것처럼 설명하지 않으며, 법령 MCP의 실시간 정상 여부를 확인하지 않았으면 현재 연결이 정상이라고 단정하지 않습니다.",
    keywords: /렌즈봇.*(법령|mcp|판례|조문|조회)|법령.*(렌즈봇|도우미)|mcp.*(렌즈봇|도우미|조회)/iu,
    kind: "policy",
  },
  {
    id: "law-accuracy-limits",
    screen: "법령 > 종합 리서치",
    title: "법령 결과의 정확성 한계",
    text: "WorkLens 법령 기능의 정확도를 나타내는 검증된 수치는 제공된 근거에 없습니다. 따라서 '정확도 100%', '환각 0%' 같은 수치는 안내할 수 없으며, 구현된 근거 확인 장치(실제 자료 조회·쟁점별 관련성 확인·확인/미확인 구분)와 남은 오류 가능성을 구분해 설명해야 합니다.",
    keywords: /법령.*(정확도|보장)|정확도.*법령|법령.*100%/iu,
    kind: "policy",
  },
  {
    id: "law-evidence-check",
    screen: "법령 > 종합 리서치",
    title: "근거 확인 경로",
    text: "확인된 근거는 종합 리서치 결과의 상세 근거에서 확인합니다. 참고 목록은 확인 근거와 구분해 표시하며, 발췌는 전문이 아니므로 조문 전문은 법령 검색에서 확인합니다. 인용 검증의 내용 불일치는 조문 자체는 존재하지만 입력한 주장과 조문 내용이 맞지 않는 경우입니다. 조문 존재 여부와 내용 적합성은 구분합니다.",
    keywords: /법령.*근거|근거.*법령|인용|내용\s*불일치|불일치|원문\s*확인|원문/iu,
    kind: "policy",
  },
  {
    id: "ax-menu",
    screen: "AI·AX > 업무 자동화 진단",
    title: "업무 자동화 진단 위치",
    text: "업무 자동화 진단은 왼쪽 메뉴의 AI·AX 카테고리에서 '업무 자동화 진단'을 선택해 진행할 수 있습니다.",
    keywords: /자동화\s*진단|업무\s*자동화\s*진단|진단.*어디|어디.*진단/iu,
    kind: "menu",
  },
  {
    id: "assistant-self",
    screen: "렌즈봇",
    title: "도우미 사용 방법",
    text: "렌즈봇은 WorkLens 기능과 사용 방법만 안내합니다. '렌즈봇 사용법 알려줘'처럼 렌즈봇이나 AI 도우미를 직접 언급한 질문에도 답할 수 있습니다. 렌즈봇은 읽기 전용으로 동작하며 업무 데이터를 수정하거나 실행하지 않습니다.",
    keywords: /렌즈봇|도우미|예시\s*질문|AI\s*도우미/iu,
    kind: "guide",
  },
  {
    id: "doc-analyze",
    screen: "문서 작업 > 분석",
    title: "문서 분석",
    text: "문서 분석은 선택한 파일의 핵심 요약과 확인된 항목·수치를 보여줍니다. 파일을 선택한 뒤 분석 탭에서 실행하면 요약·수치와 근거 위치를 확인할 수 있습니다.",
    keywords: /문서\s*분석|분석\s*기능/iu,
    kind: "guide",
  },
  {
    id: "doc-ask",
    screen: "문서 작업 > 질문",
    title: "문서 질문",
    text: "문서 질문은 선택한 파일을 근거로 질문에 답변합니다. 확인할 내용을 입력하고 실행하면 답변과 근거 위치를 확인할 수 있습니다.",
    keywords: /문서\s*질문/iu,
    kind: "guide",
  },
  {
    id: "doc-compare",
    screen: "문서 작업 > 비교",
    title: "문서 비교",
    text: "문서 비교는 두 파일의 변경 사항 또는 여러 파일의 값 차이를 확인합니다. 기준/대상을 확인하고 버전 비교 또는 값 일치 확인 중 선택해 실행합니다.",
    keywords: /문서\s*비교|버전\s*비교|값\s*일치/iu,
    kind: "guide",
  },
  {
    id: "doc-check",
    screen: "문서 작업 > 검수",
    title: "문서 검수",
    text: "문서 검수는 문장·일관성·데이터·개인정보·보안정보를 검수합니다. 검수 탭에서 실행하면 문제와 수정 제안을 카드로 보여주고, 근거 보기에서 원문 위치를 확인할 수 있습니다.",
    keywords: /문서\s*검수|검수\s*기능|검토.*검수/iu,
    kind: "guide",
  },
  {
    id: "doc-review",
    screen: "법령 > 문서 검토",
    title: "문서 검토",
    text: "문서 검토는 법령 카테고리에서 작업 문서의 조항과 확인된 근거를 검토합니다. 조항별로 확인된 근거와 근거 미확인 상태를 구분해 표시하고, 근거 보기에서 원문 위치를 확인할 수 있습니다. 문서 검수와는 다릅니다. 문서 검수는 문장·일관성·데이터·개인정보·보안정보를 검수하는 기능입니다.",
    keywords: /문서\s*검토/iu,
    kind: "guide",
  },
  {
    id: "doc-supplement",
    screen: "문서 작업 > 보완",
    title: "문서 보완",
    text: "문서 보완은 문서에서 빠진 핵심 정보와 설명이 필요한 부분을 확인합니다. 보완 실행 후 각 항목에 확인 이유와 근거 보기가 함께 표시됩니다.",
    keywords: /문서\s*보완|보완\s*기능/iu,
    kind: "guide",
  },
  {
    id: "doc-polish",
    screen: "문서 작업 > 윤문",
    title: "문서 윤문",
    text: "윤문은 번역투와 중복 표현을 문장 단위로 다듬습니다. 파일 윤문과 텍스트 윤문을 선택할 수 있으며, 기본·간결하게·업무 문체 중 방식을 골라 실행합니다.",
    keywords: /윤문/iu,
    kind: "guide",
  },
  {
    id: "doc-extract",
    screen: "문서 작업 > 추출",
    title: "문서 추출",
    text: "추출은 필요한 항목과 값을 찾아 표로 정리합니다. 자동 추출 또는 항목 지정을 골라 실행하면 표를 확인하고 CSV·XLSX로 내려받을 수 있습니다.",
    keywords: /추출/iu,
    kind: "guide",
  },
  {
    id: "doc-aggregate",
    screen: "문서 작업 > 취합",
    title: "문서 취합",
    text: "취합은 첫 번째 파일의 서식을 기준으로 여러 Excel 표를 취합합니다. Excel 파일만 지원하며, 취합 탭에서 실행하면 결과 시트를 확인하고 내려받을 수 있습니다.",
    keywords: /취합/iu,
    kind: "guide",
  },
  {
    id: "tool-pdf",
    screen: "PDF 도구",
    title: "PDF 도구",
    text: "PDF 도구는 PDF 페이지를 정리하고 원하는 형식으로 내보냅니다. 여러 PDF를 추가한 뒤 끌어서 순서를 변경·회전·삭제하고, PDF·JPG·PNG 중 형식을 골라 저장합니다.",
    keywords: /pdf\s*도구/iu,
    kind: "menu",
  },
  {
    id: "tool-image",
    screen: "이미지 도구",
    title: "이미지 도구",
    text: "이미지 도구는 이미지를 편집하거나 여러 장을 결합한 뒤 내보냅니다. JPG·PNG·WebP 이미지를 추가하고 크기·회전 등 편집을 적용한 뒤 내보냅니다.",
    keywords: /이미지\s*도구/iu,
    kind: "menu",
  },
  {
    id: "guide-usage",
    screen: "사용 가이드",
    title: "사용 가이드",
    text: "사용 가이드는 WorkLens 각 기능의 사용 순서를 단계별로 안내합니다. 왼쪽 메뉴의 HELP에서 사용 가이드를 선택하면 기능별 단계와 팁을 확인할 수 있습니다.",
    keywords: /사용\s*가이드|가이드/iu,
    kind: "menu",
  },
  {
    id: "guide-dictionary",
    screen: "검수",
    title: "용어 사전",
    text: "용어 사전은 맞춤법·용어 오탐을 줄이는 사전입니다. 검수 화면 상단의 '용어 사전' 버튼을 선택해 확인할 수 있습니다.",
    keywords: /용어\s*사전|사전/iu,
    kind: "menu",
  },
  {
    id: "research-general",
    screen: "종합 리서치",
    title: "종합 리서치",
    text: "종합 리서치는 쟁점별 핵심 검토 결과·근거 상태·추가 확인을 보여줍니다. 자연어로 질문할 수 있으며, 관련 법령·판례는 쟁점별로 펼쳐 봅니다. 중복 질문 처리에 대한 별도 기능은 제공하지 않습니다.",
    keywords: /종합\s*리서치/iu,
    kind: "guide",
  },
];

const MAX_EVIDENCE = 3;

/**
 * Select up to 3 evidence entries matching the question, ranked by relevance.
 * Relevance prefers: more keyword matches, longer matched terms, and entries
 * whose id/title directly names the asked topic. Array order is only a tiebreak.
 */
export function selectEvidence(question: string): AssistantEvidence[] {
  const lowered = question.toLowerCase();
  const scored = ASSISTANT_EVIDENCE
    .map((entry) => ({ entry, score: relevanceScore(entry, lowered) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_EVIDENCE).map(({ entry }) => entry);
}

/** Evidence entries that describe the law category (menu, policy, or guide). */
export const LAW_EVIDENCE_IDS: ReadonlySet<string> = new Set([
  "law-research",
  "law-mcp-design",
  "law-error-types",
  "law-mcp-value",
  "law-lensbot-role",
  "law-accuracy-limits",
  "law-evidence-check",
  "research-general",
  "doc-review",
]);

/** Coding-agent execution entries: unrelated to a law-function question. */
const CODING_AGENT_EVIDENCE_IDS: ReadonlySet<string> = new Set([
  "ax-prompt",
  "ax-mvp",
]);

/**
 * Merge learn and stat evidence for one question intent.
 * - law: drop learn-unit evidence (a law-function question must not cite general
 *   AI-hallucination lessons as its basis) and coding-agent execution entries,
 *   and order law evidence first.
 * - learn: drop law-category stat evidence so a curriculum question is not
 *   answered with law-function guidance.
 * - general: keep the previous merge (learn first, stat after, cap 4).
 */
export function filterEvidenceByIntent(
  learn: AssistantEvidence[],
  stat: AssistantEvidence[],
  intent: "law" | "learn" | "general",
): AssistantEvidence[] {
  const learnPart = intent === "law" ? [] : learn;
  let statPart = stat;
  if (intent === "learn") {
    statPart = stat.filter((entry) => !LAW_EVIDENCE_IDS.has(entry.id));
  } else if (intent === "law") {
    // A law-function question must not drift into coding-agent execution
    // guidance (or learn lessons, dropped above): only law evidence first,
    // then other non-coding stat evidence the question actually matched.
    const nonCoding = stat.filter((entry) => !CODING_AGENT_EVIDENCE_IDS.has(entry.id));
    const lawFirst = nonCoding.filter((entry) => LAW_EVIDENCE_IDS.has(entry.id));
    const rest = nonCoding.filter((entry) => !LAW_EVIDENCE_IDS.has(entry.id));
    statPart = [...lawFirst, ...rest];
  }
  const merged: AssistantEvidence[] = [];
  for (const entry of [...learnPart, ...statPart]) {
    if (!merged.some((existing) => existing.id === entry.id)) merged.push(entry);
  }
  return merged.slice(0, 4);
}

/**
 * Deterministic post-processing: remove internal evidence identifiers from the
 * answer body while keeping citedIds and the sources/relatedScreens mapping
 * intact. The model is instructed not to write ids, but the server must not
 * rely on that alone. Strip every bank id, not just this turn's selection:
 * the model can echo an id from a previous answer (sent back as context) or
 * guess a plausible bank id from the bracket-id convention itself, and a
 * selection-scoped strip lets exactly those cases through (live 2026-10-28:
 * [law-error-types] survived a turn whose selection did not include it).
 */
export function stripInternalEvidenceIds(answer: string, evidence: AssistantEvidence[]): string {
  const ids = new Set<string>();
  for (const entry of ASSISTANT_EVIDENCE) ids.add(entry.id);
  for (const entry of evidence) ids.add(entry.id);
  let out = answer;
  for (const id of ids) {
    out = out.split(`[${id}]`).join("");
  }
  out = out.replace(/\[learn-(?:unit|question)-[^\]\s]+\]/gu, "");
  out = out.replace(/\[learn-overview\]/gu, "");
  out = out.replace(/\(\s*참고\s*:[·,\s]*\)/gu, "");
  out = out.replace(/\(\s*\)/gu, "");
  out = out.replace(/(\s[·,])+\s*([.,!?])/gu, "$2");
  out = out.replace(/\s{2,}/gu, " ");
  out = out.replace(/\s+([.,)])/gu, "$1");
  return out.trim();
}

/** Simple relevance score: count distinct keyword alternatives that match, weighted by length. */
function relevanceScore(entry: AssistantEvidence, lowered: string): number {
  let score = 0;
  const alternatives = entry.keywords.source.split("|");
  for (const alt of alternatives) {
    try {
      if (new RegExp(alt, "iu").test(lowered)) score += Math.min(alt.length, 12);
    } catch {
      // Ignore malformed alternatives.
    }
  }
  // Bonus when the entry title's core term appears in the question.
  const titleCore = entry.title.replace(/\s+/gu, "");
  if (titleCore.length >= 2 && lowered.replace(/\s+/gu, "").includes(titleCore)) score += 10;
  return score;
}

/** Server-side guard: cited ids must be a subset of the evidence provided to the model. */
export function validCitations(citedIds: string[], provided: AssistantEvidence[]): boolean {
  const allowed = new Set(provided.map((entry) => entry.id));
  return citedIds.every((id) => allowed.has(id));
}

/**
 * Split cited evidence into display buckets. Only "diagnosis" entries (real
 * user data provided for this question) may render as verified evidence
 * ("확인한 근거"). "policy" entries are system guidance and render as
 * "관련 안내", never as lookup evidence; "menu" entries render as "관련 화면".
 * "guide" entries stay in the answer body only.
 */
export function splitCitedByKind(cited: AssistantEvidence[]): {
  confirmed: AssistantEvidence[];
  relatedInfo: AssistantEvidence[];
  relatedScreens: AssistantEvidence[];
} {
  return {
    confirmed: cited.filter((entry) => entry.kind === "diagnosis"),
    relatedInfo: cited.filter((entry) => entry.kind === "policy"),
    relatedScreens: cited.filter((entry) => entry.kind === "menu"),
  };
}

// Metric word can precede or follow the number: "정확도가 95%" or "95% 향상"
const INVENTED_METRIC = /(단축|절감|향상|개선|달성|정확도|일치율|자동화율|오류율|처리\s*시간|소요\s*시간)\s*(이|가|은|는)?\s*\d+(?:\.\d+)?\s*(%|퍼센트|배)|\d+(?:\.\d+)?\s*(%|퍼센트|배)\s*(단축|절감|향상|개선|달성|정확도|일치율|자동화율|오류율|처리\s*시간|소요\s*시간)/u;

/** Additional patterns for invented quantitative claims without %/배 markers. */
const INVENTED_ABSOLUTE = /(정확도|오류율|일치율|자동화율)\s*\d+/u;

/**
 * Phrases indicating the number is a calculation from user-provided input,
 * not a WorkLens-measured performance claim. Such calculations are allowed.
 */
const USER_CALCULATION_MARKER = /(입력하신|말씀하신|가정|계산하면|계산\s*결과|단순\s*계산|예를\s*들어)/u;

/**
 * Server-side guard: the model must not invent quantitative performance claims.
 * A metric is grounded only when it appears in the evidence text or the question.
 * User-provided numbers are never treated as verified WorkLens policy/performance.
 *
 * User-input calculations (e.g. "10시간→7시간이면 30% 감소") are allowed ONLY when:
 * 1. The answer explicitly frames it as a user-input-based calculation, AND
 * 2. The calculated value is arithmetically derivable from numbers in the question.
 * Each metric is verified individually; marker words alone are not sufficient.
 */
export function hasInventedMetric(answer: string, evidence: AssistantEvidence[], question: string): boolean {
  const grounded = `${evidence.map((entry) => entry.text).join("\n")}\n${question}`;
  const normalized = (text: string) => text.replace(/\s+/gu, "");
  const groundedNorm = normalized(grounded);
  // Extract numbers from the question (user-provided input values).
  const questionNumbers = [...question.matchAll(/\d+(?:\.\d+)?/gu)].map(m => parseFloat(m[0]));
  const hasCalculationMarker = USER_CALCULATION_MARKER.test(answer);

  for (const match of answer.matchAll(/\d+(?:\.\d+)?\s*(?:%|퍼센트|배)/gu)) {
    const token = match[0].replace(/\s+/gu, "");
    if (!groundedNorm.includes(token) && !groundedNorm.includes(token.replace("퍼센트", "%"))) {
      const contextWindow = answer.slice(Math.max(0, (match.index ?? 0) - 12), (match.index ?? 0) + match[0].length + 12);
      if (!INVENTED_METRIC.test(contextWindow)) continue;
      // User calculation: verify the metric is arithmetically derivable from question numbers.
      if (hasCalculationMarker && isDerivableFromQuestion(parseFloat(match[0]), questionNumbers)) continue;
      return true;
    }
  }
  // Absolute claims like "정확도 95" without % marker.
  if (INVENTED_ABSOLUTE.test(answer)) {
    const claim = answer.match(INVENTED_ABSOLUTE)?.[0] ?? "";
    if (!groundedNorm.includes(normalized(claim))) {
      const claimNumber = parseFloat(claim.match(/\d+(?:\.\d+)?/)?.[0] ?? "NaN");
      if (hasCalculationMarker && !isNaN(claimNumber) && isDerivableFromQuestion(claimNumber, questionNumbers)) return false;
      return true;
    }
  }
  return false;
}

/**
 * Check if a metric value can be derived from question numbers via simple arithmetic.
 * Supports: percentage change ((a-b)/a*100), ratios, differences.
 */
function isDerivableFromQuestion(metricValue: number, questionNumbers: number[]): boolean {
  if (questionNumbers.length < 1) return false;
  // Direct match: the number appears in the question.
  if (questionNumbers.some(n => Math.abs(n - metricValue) < 0.01)) return true;
  // Percentage change: (a-b)/a*100 for any pair
  for (let i = 0; i < questionNumbers.length; i++) {
    for (let j = 0; j < questionNumbers.length; j++) {
      if (i === j) continue;
      const a = questionNumbers[i], b = questionNumbers[j];
      if (a !== 0) {
        const pctChange = Math.abs((a - b) / a * 100);
        if (Math.abs(pctChange - metricValue) < 0.5) return true;
      }
      // Simple ratio
      if (b !== 0 && Math.abs(a / b - metricValue) < 0.01) return true;
      // Difference
      if (Math.abs(Math.abs(a - b) - metricValue) < 0.01) return true;
    }
  }
  return false;
}
