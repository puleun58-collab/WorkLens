import type { CheckConfidence, CheckFinding } from "@/domain/operations";
import { makeFinding, type RuleContext, type TextUnit } from "../types";

export interface KoreanSpellingRule {
  /** Stable rule key; also the dedupe identity carried in `ruleId`. */
  id: string;
  pattern: RegExp;
  replacement: string;
  confidence: CheckConfidence;
}

/**
 * Hand-verified Korean misspellings. Every entry is a form that is wrong in all
 * contexts; ambiguous pairs (결재/결제, 지양/지향, 다르다/틀리다) are deliberately absent
 * because a deterministic layer cannot resolve them.
 */
export const KOREAN_SPELLING_RULES: readonly KoreanSpellingRule[] = [
  { id: "전먕", pattern: /전먕/gu, replacement: "전망", confidence: "high" },
  { id: "됬", pattern: /됬/gu, replacement: "됐", confidence: "high" },
  { id: "되여", pattern: /되여/gu, replacement: "되어", confidence: "high" },
  { id: "되요", pattern: /(?<![가-힣])되요/gu, replacement: "돼요", confidence: "high" },
  { id: "되서", pattern: /되서(?![가-힣])/gu, replacement: "돼서", confidence: "high" },
  { id: "뵈요", pattern: /뵈요/gu, replacement: "봬요", confidence: "high" },
  { id: "읍니다", pattern: /(?<=[가-힣])읍니다/gu, replacement: "습니다", confidence: "high" },
  { id: "웬지", pattern: /(?<![가-힣])웬지(?![가-힣])/gu, replacement: "왠지", confidence: "high" },
  { id: "왠만", pattern: /왠만/gu, replacement: "웬만", confidence: "high" },
  { id: "왠일", pattern: /왠일/gu, replacement: "웬일", confidence: "high" },
  { id: "금새", pattern: /(?<![가-힣])금새(?![가-힣])/gu, replacement: "금세", confidence: "high" },
  { id: "오랫만", pattern: /오랫만/gu, replacement: "오랜만", confidence: "high" },
  { id: "몇일", pattern: /몇일/gu, replacement: "며칠", confidence: "high" },
  { id: "역활", pattern: /역활/gu, replacement: "역할", confidence: "high" },
  { id: "회손", pattern: /회손/gu, replacement: "훼손", confidence: "high" },
  { id: "희안", pattern: /희안/gu, replacement: "희한", confidence: "high" },
  { id: "구지", pattern: /(?<![가-힣])구지(?=\s)/gu, replacement: "굳이", confidence: "medium" },
  { id: "들어나", pattern: /(?<![가-힣])들어나(?=[다는며서])/gu, replacement: "드러나", confidence: "medium" },
  { id: "곤난", pattern: /곤난/gu, replacement: "곤란", confidence: "high" },
  { id: "눈쌀", pattern: /눈쌀/gu, replacement: "눈살", confidence: "high" },
  { id: "설레임", pattern: /설레임/gu, replacement: "설렘", confidence: "high" },
  { id: "승락", pattern: /승락/gu, replacement: "승낙", confidence: "high" },
  { id: "통채로", pattern: /통채로/gu, replacement: "통째로", confidence: "high" },
  { id: "뒤쳐지", pattern: /뒤쳐지/gu, replacement: "뒤처지", confidence: "medium" },
  { id: "일찌기", pattern: /일찌기/gu, replacement: "일찍이", confidence: "high" },
  { id: "있을런지", pattern: /있을런지/gu, replacement: "있을는지", confidence: "high" },
  { id: "갯수", pattern: /갯수/gu, replacement: "개수", confidence: "high" },
  { id: "어의없", pattern: /어의없/gu, replacement: "어이없", confidence: "high" },
  { id: "무릎쓰", pattern: /무릎쓰/gu, replacement: "무릅쓰", confidence: "high" },
  { id: "삼가해", pattern: /삼가해\s?주/gu, replacement: "삼가 주", confidence: "medium" },
  { id: "건내", pattern: /건내(?=[다어었주])/gu, replacement: "건네", confidence: "high" },
  { id: "바꼈", pattern: /바꼈/gu, replacement: "바뀌었", confidence: "high" },
  { id: "잠궈", pattern: /잠궈/gu, replacement: "잠가", confidence: "high" },
  { id: "담궈", pattern: /담궈/gu, replacement: "담가", confidence: "high" },
  { id: "틈틈히", pattern: /틈틈히/gu, replacement: "틈틈이", confidence: "high" },
  { id: "일일히", pattern: /일일히/gu, replacement: "일일이", confidence: "high" },
  { id: "곰곰히", pattern: /곰곰히/gu, replacement: "곰곰이", confidence: "high" },
  { id: "번번히", pattern: /번번히/gu, replacement: "번번이", confidence: "high" },
  { id: "깨끗히", pattern: /깨끗히/gu, replacement: "깨끗이", confidence: "high" },
  { id: "솔직이", pattern: /솔직이(?![가-힣])/gu, replacement: "솔직히", confidence: "high" },
  { id: "도데체", pattern: /도데체/gu, replacement: "도대체", confidence: "high" },
  { id: "어떻해", pattern: /어떻해/gu, replacement: "어떡해", confidence: "high" },
  { id: "문안하", pattern: /(?<![가-힣])문안하(?=[게다며])/gu, replacement: "무난하", confidence: "medium" },
  { id: "뒷처리", pattern: /뒷처리/gu, replacement: "뒤처리", confidence: "high" },
  { id: "뒷풀이", pattern: /뒷풀이/gu, replacement: "뒤풀이", confidence: "high" },
  { id: "안스러", pattern: /안스러/gu, replacement: "안쓰러", confidence: "high" },
  { id: "움추리", pattern: /움추리/gu, replacement: "움츠리", confidence: "high" },
  { id: "부시시", pattern: /부시시/gu, replacement: "부스스", confidence: "high" },
  { id: "널부러", pattern: /널부러/gu, replacement: "널브러", confidence: "high" },
  { id: "돌맹이", pattern: /돌맹이/gu, replacement: "돌멩이", confidence: "high" },
  { id: "만듬", pattern: /(?<![가-힣])만듬(?![가-힣])/gu, replacement: "만듦", confidence: "high" },
  { id: "닥달", pattern: /닥달/gu, replacement: "닦달", confidence: "high" },
  { id: "넉두리", pattern: /넉두리/gu, replacement: "넋두리", confidence: "high" },
  { id: "쉽상", pattern: /쉽상/gu, replacement: "십상", confidence: "high" },
  { id: "옛부터", pattern: /옛부터/gu, replacement: "예부터", confidence: "high" },
  { id: "눈꼽", pattern: /눈꼽/gu, replacement: "눈곱", confidence: "high" },
  { id: "서슴치", pattern: /서슴치/gu, replacement: "서슴지", confidence: "high" },
  { id: "치뤄", pattern: /치뤄/gu, replacement: "치러", confidence: "high" },
  { id: "낭떨어지", pattern: /낭떨어지/gu, replacement: "낭떠러지", confidence: "high" },
  { id: "남여", pattern: /(?<![가-힣])남여(?=[ ,.]|$)/gu, replacement: "남녀", confidence: "medium" },
  { id: "뇌졸증", pattern: /뇌졸증/gu, replacement: "뇌졸중", confidence: "high" },
  { id: "초생달", pattern: /초생달/gu, replacement: "초승달", confidence: "high" },
  { id: "구렛나루", pattern: /구렛나루/gu, replacement: "구레나룻", confidence: "high" },
  { id: "오뚜기", pattern: /(?<![가-힣])오뚜기(?![가-힣])/gu, replacement: "오뚝이", confidence: "medium" },
  { id: "년도", pattern: /(?<![가-힣0-9])년도/gu, replacement: "연도", confidence: "medium" },
  { id: "몇일간", pattern: /몇일간/gu, replacement: "며칠간", confidence: "high" },
  { id: "않되", pattern: /(?<![가-힣])않되/gu, replacement: "안 되", confidence: "high" },
];

/** Compatibility jamo left behind by an interrupted IME composition. */
const STRAY_JAMO = /(?:[가-힣][\u3131-\u318E])|(?:[\u3131-\u318E][가-힣])/u;
/**
 * 한글 맞춤법 제11항: 받침 없는 말과 ㄴ 받침 뒤에는 "율", 그 밖에는 "률".
 * A trailing particle is allowed so `확율을` is still checked, while a longer
 * compound such as `비율표` is left alone.
 */
const RATIO_PARTICLE = "은|는|이|가|을|를|의|로|으로|과|와|도|만|에|에서|까지|부터|입니다|이다|이며|과의|와의";
const RATIO_SUFFIX = new RegExp(`(?<![가-힣])([가-힣]{1,7}?)(률|율)(?:${RATIO_PARTICLE})?(?![가-힣])`, "gu");

function finalConsonant(syllable: string): number {
  const code = syllable.codePointAt(0);
  if (code === undefined || code < 0xac00 || code > 0xd7a3) return -1;
  return (code - 0xac00) % 28;
}

export function koreanSpellingFindings(unit: TextUnit, context: RuleContext): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const text = unit.text;

  for (const rule of KOREAN_SPELLING_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    const match = pattern.exec(text);
    if (!match) continue;
    if (context.dictionary.has(match[0])) continue;
    const corrected = text.replace(new RegExp(rule.pattern.source, rule.pattern.flags), rule.replacement);
    findings.push(makeFinding({
      code: "suspected-typo",
      ruleId: `writing/korean/spelling:${rule.id}`,
      category: "spelling",
      severity: "warning",
      confidence: rule.confidence,
      issue: "한글 맞춤법 오류 가능성",
      message: `"${match[0]}"을(를) "${rule.replacement}"(으)로 검토하세요.`,
      reason: "표준 국어 표기에서 벗어난 철자입니다.",
      recommendation: `원문을 "${corrected}"(으)로 교정하는 것을 검토하세요.`,
      sources: [unit.source],
      originalText: text,
      suggestedText: corrected,
      normalizedToken: match[0],
    }));
  }

  const jamo = STRAY_JAMO.exec(text);
  if (jamo) findings.push(makeFinding({
    code: "stray-jamo",
    ruleId: "writing/korean/stray-jamo",
    category: "spelling",
    severity: "warning",
    confidence: "high",
    issue: "미완성 한글 자모",
    message: `"${jamo[0]}"에 조합되지 않은 자모가 남아 있습니다.`,
    reason: "완성되지 않은 한글 낱자는 입력 도중 끊긴 오타일 가능성이 매우 높습니다.",
    recommendation: "해당 위치의 글자를 다시 입력하세요.",
    sources: [unit.source],
    originalText: text,
  }));

  for (const match of text.matchAll(RATIO_SUFFIX)) {
    const [, stem, suffix] = match;
    const word = `${stem}${suffix}`;
    if (context.dictionary.has(word)) continue;
    const last = stem.at(-1);
    if (!last) continue;
    const jong = finalConsonant(last);
    if (jong < 0) continue;
    const expected = jong === 0 || jong === 4 ? "율" : "률";
    if (expected === suffix) continue;
    const corrected = `${stem}${expected}`;
    findings.push(makeFinding({
      code: "suspected-typo",
      ruleId: "writing/korean/ratio-suffix",
      category: "spelling",
      severity: "warning",
      confidence: "high",
      issue: "율/률 표기 오류",
      message: `"${word}"은(는) "${corrected}"로 적습니다.`,
      reason: "받침이 없거나 ㄴ 받침인 말 뒤에는 '율', 그 밖의 받침 뒤에는 '률'을 씁니다.",
      recommendation: `"${corrected}" 표기로 수정하세요.`,
      sources: [unit.source],
      originalText: word,
      suggestedText: corrected,
      normalizedToken: word,
    }));
  }
  return findings;
}
