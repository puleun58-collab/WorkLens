import type { CheckFinding } from "@/domain/operations";
import { makeFinding, type RuleContext, type TextUnit } from "../types";

/** Sino-Korean action nouns that bind directly to 하다/되다 endings. */
const ACTION_NOUNS = [
  "적용", "진행", "확인", "검토", "반영", "변경", "완료", "처리", "개선", "공유",
  "승인", "요청", "등록", "삭제", "수정", "제출", "검수", "배포", "운영", "관리",
  "분석", "보고", "발생", "종료", "시작", "도입", "추진", "구축", "개발", "설정",
  "지원", "결정", "평가", "산출", "예측", "정리", "대응", "협의", "조치", "취소",
  "연기", "축소", "확대", "제공", "수집", "저장", "출력", "집계", "확정", "점검",
].join("|");
const PREDICATE_ENDINGS = "합니다|됩니다|했습니다|됐습니다|하였습니다|되었습니다|하였다|되었다|한다|된다|하고|되고|하며|되며|하기|되기";
const SPLIT_PREDICATE = new RegExp(`(?<![가-힣])(${ACTION_NOUNS})\\s+(${PREDICATE_ENDINGS})`, "gu");
const SPLIT_AUXILIARY = /(?<![가-힣])([가-힣]{2,4})\s+해\s*(주세요|주십시오|주시기|드립니다|드렸습니다)/gu;
const ATTACHED_AUXILIARY = /(?<![가-힣])([가-힣]{2,4})해(주세요|주십시오|주시기|드립니다)/gu;
/** Particles never stand alone; a leading space in front of one is a spacing slip. */
const DETACHED_PARTICLE = /(?<=[가-힣A-Za-z0-9])\s+(에서|에게|에게서|한테|으로|로서|로써|까지|부터|처럼|마다|조차|이라고|라고는)(?![가-힣])/gu;
const BOUND_NOUN_SU = /([가-힣])수\s*(있|없)/gu;
const ATTACHED_GEOT = /것같|거같/gu;
const ATTACHED_MIT = /(?<=[가-힣A-Za-z0-9])및(?=[가-힣A-Za-z0-9])/gu;
/** ㄹ 받침 nouns that legitimately end in 수 and must not be split. */
const SU_NOUNS: Record<string, true> = {
  실수: true, 탈수: true, 절수: true, 별수: true, 물수: true, 술수: true, 결수: true, 활수: true,
};

function finalConsonant(syllable: string): number {
  const code = syllable.codePointAt(0);
  if (code === undefined || code < 0xac00 || code > 0xd7a3) return -1;
  return (code - 0xac00) % 28;
}

interface SpacingHit {
  ruleId: string;
  issue: string;
  reason: string;
  matched: string;
  corrected: string;
}

function spacingHits(text: string): SpacingHit[] {
  const hits: SpacingHit[] = [];
  for (const match of text.matchAll(SPLIT_PREDICATE)) hits.push({
    ruleId: "writing/korean/spacing:predicate",
    issue: "서술어 띄어쓰기",
    reason: "명사와 '하다/되다' 계열 서술어는 붙여 씁니다.",
    matched: match[0],
    corrected: `${match[1]}${match[2]}`,
  });
  for (const match of text.matchAll(SPLIT_AUXILIARY)) hits.push({
    ruleId: "writing/korean/spacing:auxiliary",
    issue: "보조 용언 띄어쓰기",
    reason: "'-해' 뒤의 보조 용언만 띄어 쓰고 어간과 '-해'는 붙여 씁니다.",
    matched: match[0],
    corrected: `${match[1]}해 ${match[2]}`,
  });
  for (const match of text.matchAll(ATTACHED_AUXILIARY)) hits.push({
    ruleId: "writing/korean/spacing:auxiliary",
    issue: "보조 용언 띄어쓰기",
    reason: "본용언과 보조 용언 사이는 띄어 쓰는 것이 원칙입니다.",
    matched: match[0],
    corrected: `${match[1]}해 ${match[2]}`,
  });
  for (const match of text.matchAll(DETACHED_PARTICLE)) hits.push({
    ruleId: "writing/korean/spacing:particle",
    issue: "조사 띄어쓰기",
    reason: "조사는 앞말에 붙여 씁니다.",
    matched: match[0],
    corrected: match[1],
  });
  for (const match of text.matchAll(BOUND_NOUN_SU)) {
    if (finalConsonant(match[1]) !== 8) continue;
    if (SU_NOUNS[`${match[1]}수`]) continue;
    hits.push({
      ruleId: "writing/korean/spacing:bound-noun",
      issue: "의존명사 띄어쓰기",
      reason: "의존명사 '수'는 앞말과 띄어 씁니다.",
      matched: match[0],
      corrected: `${match[1]} 수 ${match[2]}`,
    });
  }
  for (const match of text.matchAll(ATTACHED_GEOT)) hits.push({
    ruleId: "writing/korean/spacing:bound-noun",
    issue: "의존명사 띄어쓰기",
    reason: "의존명사 '것'과 뒤의 용언은 띄어 씁니다.",
    matched: match[0],
    corrected: `${match[0][0]} ${match[0].slice(1)}`,
  });
  for (const match of text.matchAll(ATTACHED_MIT)) hits.push({
    ruleId: "writing/korean/spacing:conjunction",
    issue: "접속어 띄어쓰기",
    reason: "'및'은 앞말과 뒷말 모두와 띄어 씁니다.",
    matched: match[0],
    corrected: " 및 ",
  });
  return hits;
}

export function koreanSpacingFindings(unit: TextUnit, context: RuleContext): CheckFinding[] {
  const seen = new Set<string>();
  const findings: CheckFinding[] = [];
  for (const hit of spacingHits(unit.text)) {
    if (context.dictionary.has(hit.matched)) continue;
    const key = `${hit.ruleId}\0${hit.matched}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(makeFinding({
      code: "korean-spacing",
      ruleId: hit.ruleId,
      category: "grammar",
      severity: "suggestion",
      confidence: "medium",
      issue: hit.issue,
      message: `"${hit.matched.trim()}"의 띄어쓰기를 확인하세요.`,
      reason: hit.reason,
      recommendation: `"${hit.corrected.trim()}" 형태로 교정하는 것을 검토하세요.`,
      sources: [unit.source],
      originalText: unit.text,
      suggestedText: unit.text.replace(hit.matched, hit.corrected),
    }));
  }

  const punctuation = /([가-힣]),(?=[가-힣])|([가-힣])\.(?=[가-힣])/u.exec(unit.text);
  if (punctuation) findings.push(makeFinding({
    code: "punctuation-spacing",
    ruleId: "writing/korean/spacing:punctuation",
    category: "formatting",
    severity: "suggestion",
    confidence: "medium",
    issue: "문장부호 뒤 공백 누락",
    message: `"${punctuation[0]}" 뒤에 공백이 없습니다.`,
    reason: "쉼표와 마침표 뒤에는 한 칸을 띄우는 것이 표준입니다.",
    recommendation: "문장부호 뒤에 공백을 한 칸 넣으세요.",
    sources: [unit.source],
    originalText: unit.text,
    suggestedText: unit.text.replace(/([가-힣])([,.])(?=[가-힣])/gu, "$1$2 "),
  }));
  return findings;
}
