import type { SourceRef } from "@/domain/document";
import type { CheckFinding } from "@/domain/operations";
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

export function englishSpellingFindings(unit: TextUnit, context: RuleContext): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const reported = new Set<string>();
  for (const match of unit.text.matchAll(WORD)) {
    const word = match[0];
    const lower = word.toLocaleLowerCase();
    const replacement = ENGLISH_MISSPELLINGS[lower];
    if (!replacement || reported.has(lower)) continue;
    if (context.dictionary.has(word)) continue;
    reported.add(lower);
    const cased = word[0] === word[0].toLocaleUpperCase()
      ? replacement[0].toLocaleUpperCase() + replacement.slice(1)
      : replacement;
    findings.push(makeFinding({
      code: "english-spelling",
      ruleId: `writing/english/spelling:${lower}`,
      category: "spelling",
      severity: "warning",
      confidence: "high",
      issue: "영문 철자 오류 가능성",
      message: `"${word}"의 철자를 확인하세요.`,
      reason: "표준 영어 사전에 없는 형태이며 알려진 오타 패턴과 일치합니다.",
      recommendation: `"${cased}"(으)로 교정하세요.`,
      sources: [unit.source],
      originalText: unit.text,
      suggestedText: unit.text.replace(word, cased),
      normalizedToken: word,
    }));
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
