import { FACTOR_LABELS } from "@/lib/ax/schema";
import { GATE_LABELS, LEVEL_LABELS } from "@/lib/ax/policy";

/**
 * Internal evidence bank for the WorkLens assistant.
 * Each entry is grounded in real product UI, the usage guide, or policy constants.
 * `screen` uses real screen/menu names only; never internal function names or code paths.
 */
export interface AssistantEvidence {
  id: string;
  /** Display path shown under "참고 근거" or "관련 화면". */
  screen: string;
  title: string;
  text: string;
  keywords: RegExp;
  /**
   * Evidence kind for conditional display:
   * - "policy": Level/Gate/policy explanations → show as "참고 근거"
   * - "guide": general usage guides → hide sources (answer body only)
   * - "menu": menu location info → show as "관련 화면" (not as evidence)
   * - "diagnosis": task-specific diagnosis → show as "참고 근거" with actual data
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
    text: "업무 자동화 진단은 업무 등록 → 업무 진단 → 자동화 매트릭스 → 결과·로드맵 순서로 진행됩니다. 업무 설명을 입력하고 필요하면 자료를 추가한 뒤, 진단에서 평가값과 근거·AS-IS·TO-BE를 확인하고, 매트릭스에서 업무별 가치와 실현 가능성을 비교한 뒤, 결과·로드맵에서 실행 범위와 완료 기준을 검토하고 올인원 지시문을 생성합니다.",
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
    text: "결과·로드맵은 01 구현 범위(이번 구현·담당자 수행 유지·현재 자동화 제외), 02 시작 전 확인(선행 조건·적용 범위), 03 완료 기준(검증 방법·통과 조건·실패 기준·최종 승인·주요 예외·위험 사항), 04 올인원 지시문으로 구성됩니다. 완료 기준의 수치는 사용자 입력이나 확정 진단 근거가 확인된 것만 사용합니다.",
    keywords: /결과|로드맵|완료\s*기준|검증\s*방법|통과\s*조건|실패\s*기준|최종\s*승인|예외|위험/iu,
    kind: "policy",
  },
  {
    id: "ax-prompt",
    screen: "결과·로드맵 > 올인원 지시문",
    title: "올인원 지시문 사용",
    text: "올인원 지시문은 Codex 또는 Claude Code에 전달하는 실행 지시문입니다. 결과·로드맵의 04 올인원 지시문에서 도구를 선택하고 전체 보기·복사를 사용할 수 있습니다. 지시문은 현재 Level·Gate가 허용한 범위에서만 구현을 지시하며, 스캐폴딩·TODO·모의 구현만으로는 완료로 인정하지 않고 실제 동작하는 1차 MVP 구현을 요구합니다. 배포는 사용자 요청과 권한이 확인된 경우에만 기존 방식으로 수행합니다.",
    keywords: /올인원|지시문|codex|claude|복사/iu,
    kind: "guide",
  },
  {
    id: "ax-human",
    screen: "업무 자동화 진단 > 담당자 수행",
    title: "담당자 수행 유지",
    text: "담당자 판단이 필요한 단계는 '담당자 수행 유지'로 남으며 자동화로 대체하지 않습니다. 최종 승인은 담당자 검토·승인 후 확정되며, 승인 주체·권한이 확인되지 않았으면 임의로 지정하지 않습니다.",
    keywords: /담당자|사람\s*유지|승인/iu,
    kind: "policy",
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
    screen: "종합 리서치 > 법령 리서치",
    title: "법령 리서치 위치",
    text: "법령 리서치는 종합 리서치 메뉴에서 접근할 수 있습니다. 법령·판례·결정례를 검색하고 조문을 확인할 수 있습니다. 도우미는 법률 해석이나 판례 검색을 직접 수행하지 않으며, 기능 사용 방법만 안내합니다.",
    keywords: /법령|리서치|판례|조문/iu,
    kind: "menu",
  },
  {
    id: "assistant-self",
    screen: "렌즈봇",
    title: "도우미 사용 방법",
    text: "렌즈봇은 WorkLens 기능과 사용 방법만 안내합니다. 도우미는 읽기 전용으로 동작하며 업무 데이터를 수정하거나 실행하지 않습니다.",
    keywords: /도우미|예시\s*질문/iu,
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
    keywords: /문서\s*검수|검수\s*기능/iu,
    kind: "guide",
  },
  {
    id: "doc-supplement",
    screen: "문서 작업 > 보완",
    title: "문서 보완",
    text: "문서 보완은 문서에서 빠진 핵심 정보와 설명이 필요한 부분을 확인합니다. 보완 실행 후 항목을 펼쳐 확인 이유와 근거 보기를 확인할 수 있습니다.",
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
    screen: "용어 사전",
    title: "용어 사전",
    text: "용어 사전은 맞춤법·용어 오탐을 줄이는 사전입니다. 왼쪽 메뉴의 HELP에서 용어 사전을 선택해 확인할 수 있습니다.",
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

const INVENTED_METRIC = /\d+(?:\.\d+)?\s*(%|퍼센트|배)\s*(단축|절감|향상|개선|달성|정확도|일치율|자동화율|오류율|처리\s*시간|소요\s*시간)/u;

/** Additional patterns for invented quantitative claims without %/배 markers. */
const INVENTED_ABSOLUTE = /(정확도|오류율|일치율|자동화율)\s*\d+/u;

/**
 * Server-side guard: the model must not invent quantitative performance claims.
 * A metric is grounded only when it appears in the evidence text or the question.
 * User-provided numbers are never treated as verified WorkLens policy/performance.
 */
export function hasInventedMetric(answer: string, evidence: AssistantEvidence[], question: string): boolean {
  const grounded = `${evidence.map((entry) => entry.text).join("\n")}\n${question}`;
  const normalized = (text: string) => text.replace(/\s+/gu, "");
  const groundedNorm = normalized(grounded);
  for (const match of answer.matchAll(/\d+(?:\.\d+)?\s*(?:%|퍼센트|배)/gu)) {
    const token = match[0].replace(/\s+/gu, "");
    if (!groundedNorm.includes(token) && !groundedNorm.includes(token.replace("퍼센트", "%"))) {
      if (INVENTED_METRIC.test(answer.slice(Math.max(0, (match.index ?? 0) - 12), (match.index ?? 0) + match[0].length + 12))) return true;
    }
  }
  // Absolute claims like "정확도 95" without % marker.
  if (INVENTED_ABSOLUTE.test(answer)) {
    const claim = answer.match(INVENTED_ABSOLUTE)?.[0] ?? "";
    if (!groundedNorm.includes(normalized(claim))) return true;
  }
  return false;
}
