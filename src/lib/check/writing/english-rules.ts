import type { SourceRef } from "@/domain/document";
import type { CheckConfidence, CheckFinding } from "@/domain/operations";
import { isProtectedToken, type TermDictionary } from "../dictionary";
import { makeFinding, type RuleContext, type TextUnit } from "../types";

/**
 * High-confidence English misspellings. Every key is a non-word in standard
 * English, so a match is a typo regardless of context.
 */
export const ENGLISH_MISSPELLINGS: Record<string, string> = {
  teh: "the", adress: "address", accomodate: "accommodate", acheive: "achieve",
  acheived: "achieved", aquire: "acquire", agressive: "aggressive", apparant: "apparent",
  arguement: "argument", basicly: "basically", becuase: "because", beleive: "believe",
  buisness: "business", calender: "calendar", catagory: "category", cheif: "chief",
  collegue: "colleague", comming: "coming", commited: "committed", comparision: "comparison",
  completly: "completely", concious: "conscious", curiousity: "curiosity", decison: "decision",
  definately: "definitely", dependant: "dependent", developement: "development", diffrent: "different",
  dilema: "dilemma", dissapoint: "disappoint", effeciency: "efficiency", embarass: "embarrass",
  enviroment: "environment", equipement: "equipment", excercise: "exercise", existance: "existence",
  experiance: "experience", explaination: "explanation", familar: "familiar", febuary: "February",
  finaly: "finally", forcast: "forecast", foriegn: "foreign", fourty: "forty",
  freind: "friend", garantee: "guarantee", goverment: "government", grammer: "grammar",
  harrass: "harass", immediatly: "immediately", independant: "independent", intrest: "interest",
  knowlege: "knowledge", liason: "liaison", libary: "library", maintainance: "maintenance",
  managment: "management", neccessary: "necessary", noticable: "noticeable", occassion: "occasion",
  occured: "occurred", occurence: "occurrence", oppurtunity: "opportunity", orginal: "original",
  paralell: "parallel", paticular: "particular", perfomance: "performance", persistant: "persistent",
  personel: "personnel", posession: "possession", prefered: "preferred", priviledge: "privilege",
  probaly: "probably", proccess: "process", publically: "publicly", questionaire: "questionnaire",
  recieve: "receive", recieved: "received", recomend: "recommend", refered: "referred",
  refrence: "reference", relevent: "relevant", remeber: "remember", requirment: "requirement",
  responsability: "responsibility", rythm: "rhythm", sceduled: "scheduled", seperate: "separate",
  seperately: "separately", similiar: "similar", sincerly: "sincerely", speach: "speech",
  succesful: "successful", sucess: "success", supercede: "supersede", suprise: "surprise",
  tommorow: "tomorrow", truely: "truly", untill: "until", usefull: "useful",
  wierd: "weird", writting: "writing",
};

const WORD = /\b[A-Za-z][A-Za-z'-]{1,}\b/gu;
const PLAIN_WORD = /^[A-Za-z]{3,}$/u;

/** Optimal string alignment distance: substitution, insertion, deletion and adjacent transposition each cost 1. */
function editDistance(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => [index, ...new Array<number>(right.length).fill(0)]);
  for (let column = 1; column <= right.length; column += 1) rows[0][column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      rows[row][column] = Math.min(rows[row - 1][column] + 1, rows[row][column - 1] + 1, rows[row - 1][column - 1] + cost);
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        rows[row][column] = Math.min(rows[row][column], rows[row - 2][column - 2] + 1);
      }
    }
  }
  return rows[left.length][right.length];
}

/**
 * How certain a word-level English correction is, whichever detector proposed
 * it. `clear` is a concrete, stable correction (a known typo, or a candidate
 * one or two letters away: doubled, missing, swapped or mistyped letters);
 * `uncertain` still needs the author's intent. Returns `protected` for
 * dictionary terms and `undefined` when the pair is not a spelling correction
 * at all: phrases, case-only changes (a consistency matter), or inflection
 * and word-form edits (`show`→`shows`, `send`→`sent`) that are grammar.
 */
export function classifyEnglishCorrection(
  original: string,
  replacement: string,
  dictionary: TermDictionary,
): "clear" | "uncertain" | "protected" | undefined {
  if (!PLAIN_WORD.test(original) || !PLAIN_WORD.test(replacement)) return undefined;
  const from = original.toLocaleLowerCase();
  const to = replacement.toLocaleLowerCase();
  if (from === to) return undefined;
  if (dictionary.has(original)) return "protected";
  if (ENGLISH_MISSPELLINGS[from] === to) return "clear";
  if (to.startsWith(from) || from.startsWith(to)) return undefined;
  const distance = editDistance(from, to);
  if (distance === 1 && from.length === to.length && from.slice(0, -1) === to.slice(0, -1)) return undefined;
  if (distance > 2 || (distance === 2 && from.length < 6)) return undefined;
  return isProtectedToken(original, dictionary) ? "uncertain" : "clear";
}

function matchCase(word: string, replacement: string): string {
  return word[0] === word[0].toLocaleUpperCase() ? replacement[0].toLocaleUpperCase() + replacement.slice(1) : replacement;
}

export interface EnglishSpellingInput {
  word: string;
  replacement: string;
  certainty: "clear" | "uncertain";
  sources: SourceRef[];
  /** Text the word was found in; the suggested text replaces the word there. */
  originalText: string;
  /** Only used for uncertain corrections; a clear correction is always high confidence. */
  confidence?: CheckConfidence;
}

/**
 * The one English spelling finding every detector produces. Severity and
 * wording follow the correction's certainty, never the detector: a clear
 * typo is a warning with a concrete fix, an uncertain one a suggestion that
 * asks the author to confirm the spelling.
 */
export function englishSpellingFinding(input: EnglishSpellingInput): CheckFinding {
  const { word, certainty } = input;
  const lower = word.toLocaleLowerCase();
  const cased = matchCase(word, input.replacement);
  const clear = certainty === "clear";
  return makeFinding({
    code: "english-spelling",
    ruleId: `writing/english/spelling:${lower}`,
    category: "spelling",
    severity: clear ? "warning" : "suggestion",
    confidence: clear ? "high" : input.confidence ?? "low",
    issue: "영문 철자 오류 가능성",
    message: clear ? `"${word}"의 철자를 확인하세요.` : `"${word}" 표기가 맞는지 확인하세요.`,
    reason: !clear
      ? "교정 후보가 확실하지 않아 원문 의도를 확인해야 합니다."
      : ENGLISH_MISSPELLINGS[lower] === input.replacement.toLocaleLowerCase()
        ? "표준 영어 사전에 없는 형태이며 알려진 오타 패턴과 일치합니다."
        : "교정 후보와 한두 글자만 다른 명확한 철자 오류 형태입니다.",
    recommendation: clear ? `"${cased}"(으)로 교정하세요.` : `"${cased}" 표기인지 확인하세요.`,
    sources: input.sources,
    originalText: input.originalText,
    ...(clear ? { suggestedText: input.originalText.replace(new RegExp(`\\b${word}\\b`, "u"), cased) } : {}),
    normalizedToken: word,
  });
}

export function englishSpellingFindings(unit: TextUnit, context: RuleContext): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const reported = new Set<string>();
  for (const match of unit.text.matchAll(WORD)) {
    const word = match[0];
    const lower = word.toLocaleLowerCase();
    const replacement = ENGLISH_MISSPELLINGS[lower];
    if (!replacement || reported.has(lower)) continue;
    const certainty = classifyEnglishCorrection(word, replacement, context.dictionary);
    if (certainty !== "clear" && certainty !== "uncertain") continue;
    reported.add(lower);
    findings.push(englishSpellingFinding({ word, replacement, certainty, sources: [unit.source], originalText: unit.text }));
  }
  return findings;
}

/**
 * Casing drift for terms the company dictionary owns: `worklens` next to
 * `WorkLens` is a terminology issue, not a spelling one.
 */
export function companyTermCasingFindings(units: readonly TextUnit[], context: RuleContext): CheckFinding[] {
  const offenders = new Map<string, { canonical: string; sources: SourceRef[]; used: string }>();
  for (const unit of units) {
    for (const match of unit.text.matchAll(/\b[A-Za-z][A-Za-z0-9.&-]{1,}\b/gu)) {
      const canonical = context.dictionary.canonical(match[0]);
      if (!canonical || canonical === match[0]) continue;
      if (context.dictionary.scopeOf(match[0]) !== "company") continue;
      const entry = offenders.get(`${canonical}\0${match[0]}`) ?? { canonical, used: match[0], sources: [] };
      entry.sources.push(unit.source);
      offenders.set(`${canonical}\0${match[0]}`, entry);
    }
  }
  return [...offenders.values()].map((entry) => makeFinding({
    code: "terminology-inconsistency",
    ruleId: `consistency/company-term-casing:${entry.canonical}`,
    category: "terminology",
    severity: "suggestion",
    confidence: "high",
    issue: "공용 용어 표기 불일치",
    message: `공용 용어 "${entry.canonical}"이(가) "${entry.used}"로 표기되었습니다.`,
    reason: "회사 공용 용어 사전에 등록된 표기와 대소문자가 다릅니다.",
    recommendation: `"${entry.canonical}" 표기로 통일하세요.`,
    sources: entry.sources,
    originalText: entry.used,
    suggestedText: entry.canonical,
  }));
}
