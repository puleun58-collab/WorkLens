import type { SupplementCheck } from "@/domain/supplement";
import { ACTION_WORD, ACTION_DONE, BASELINE_CUE, CAUSE_CUE, REASON_CUE, RESPONSE_CUE, IMPACT_CUE, TARGET_HEADER, PERIOD_EXPR, UNIT_EXPR, KPI_TERM, KPI_VALUE, contentTokens, familyOf } from "./text";

/** Concrete, field-specific evidence, shared by deterministic and semantic rebuttal. Linking remains in the engine. */
const VALUE = /\d+(?:[.,]\d+)?/u;
const FACT = /(했다|한다|된다|되었다|하였다|있다|없다|발생|확인|증가|감소|상승|하락|확대|축소|부담|지연|중단|초래|절감|개선|달성|기여|커졌|늘었|줄었)/u;
// A label followed by a value is evidence; a bare heading is not.
const content = (text: string) => VALUE.test(text) || FACT.test(text) || /[:：]\s*\S.{3,}/u.test(text);

const FIELDS = {
  baseline: /기준(?:값)?|비교|전(?:월|분기|년)|이전\s?기간/u,
  target: /목표(?:값|수치)?|달성\s?기준/u,
  owner: /담당(?:자)?|책임(?:자)?|주관|주무|총괄/u,
  schedule: /일정|기한|시기|시점|완료일|착수일|추진\s?기간/u,
  scope: /범위|대상|수량/u,
  budget: /예산|비용|견적|금액|집행|정산|승인/u,
  conclusion: /근거|전제|판단\s?기준|결론/u,
} satisfies Partial<Record<SupplementCheck, RegExp>>;
type FieldCheck = keyof typeof FIELDS;
const FIELD_CHECKS = Object.keys(FIELDS) as FieldCheck[];
const UNRESOLVED = /미\s?(?:정|확정|기재|제공|결정)|(?:없(?:음|다|습니다)|있지\s?않)|(?:결정|확정|정리|지정|기재)(?:하지|되지)\s?(?:못|않)|추후.{0,15}(?:협의|결정|확정|지정|정산)|협의(?:할|를\s?거쳐|를\s?통해|후).{0,8}(?:예정|결정)|(?:협의|검토|정산|지정|결정|확정|확인)\s?(?:중|예정|필요)|확정\s?전|예정\s?없|별도\s?정산/u;
const ASSIGNED = /(?:담당|책임|주관|주무|총괄)|(?:으로|로).{0,12}(?:확정|지정|배정)/u;
const ORGANIZATION = /[가-힣A-Za-z0-9]{2,}(?:팀|본부|센터|부서)|[가-힣]O{1,2}|[가-힣]{1,4}\s?(?:대리|선임|수석|매니저|팀장|과장|부장)/u;
const DATE = /(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}\/\d{1,2}|\d{1,4}\s?[년월일]|[1-4]\s?분기|상반기|하반기|연내|연말|월말|다음\s?(?:주|달|분기)|\d+\s?(?:일|주|개월)\s?이내)/u;
const AMOUNT = /\d[\d,.~～-]*\s?(?:조|억|천만|백만|만|천)?\s?원/u;
const QUANTITY = /\d+(?:[.,]\d+)?\s?(?:%|점|건|분|시간|일|개|대|명|원|억|만|천|톤|kg|km)/u;
const COMPARISON = /목표|계획|예산|기준(?:값|치)?|대비|전(?:년|월|분기|기|주)|작년|지난|이전|벤치마크|업계|동기|YoY|MoM|QoQ|vs\.?|→|에서\s?\d|보다/iu;

/** Table fields and contrasting clauses do not lend each other values or unresolved states. */
function clauses(text: string): string[] {
  return text.split(/\s+·\s+|\s+[|｜]\s+|[;\n]|[,，]\s*(?!\d)|(?<=[.!?])\s+|(?<=었으나|였으나|했으나)|(?:하지만|그러나)/u).map(part => part.trim().replace(/[).]+$/u, "")).filter(Boolean);
}

function fieldValue(check: FieldCheck, text: string, requirement: string): boolean {
  switch (check) {
    case "baseline": {
      const cue = COMPARISON.exec(text);
      return !!cue && QUANTITY.test(text.slice(cue.index + cue[0].length));
    }
    case "target": {
      const cue = (/예산/u.test(requirement) ? TARGET_HEADER : FIELDS.target).exec(text);
      return !!cue && (QUANTITY.test(text.slice(cue.index + cue[0].length)) || /^\s*[:：]?\s*\d+(?:[.,]\d+)?\s*(?:확정)?$/u.test(text.slice(cue.index + cue[0].length)));
    }
    case "owner": {
      if (/(관련|유관|관계)\s?(부서|팀)/u.test(text) || (/정식|최종|확정/u.test(requirement) && /임시|잠정|대행/u.test(text))) return false;
      const labelled = /(?:담당(?:자)?|책임자|주관|주무|총괄)\s?[:：]?\s*(.+)/u.exec(text)?.[1];
      const named = ORGANIZATION.test(text) || (!!labelled && /^(?:IT지원|[가-힣]{2,4})(?:\s|$)/u.test(labelled));
      return named && (ASSIGNED.test(text) || /(?:팀|본부|센터|부서)(?:이|가|에서)\s|\([^()]+(?:팀|부서)(?:\s+[가-힣A-Za-z0-9]+)*$/u.test(text) || /^(?:[가-힣A-Za-z0-9]+(?:팀|본부|센터|부서)(?:\s+[가-힣A-Za-z]+)?|IT지원)$/u.test(text));
    }
    case "schedule":
      return DATE.test(text) && !/(보고|작성일|회의일|목표\s?수치)|^20\d{2}년.*(?:계획|현황|결과)$/u.test(text)
        && (FIELDS.schedule.test(text) || /완료|설치|교체|추진|시행|실행|확정|까지|이내|중|말|초/u.test(text) || /^(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}\/\d{1,2}|(?:20\d{2}년\s?)?\d{1,2}월(?:\s?\d{1,2}일)?|[1-4]분기|상반기|하반기|연내|연말|다음\s?(?:주|달|분기))(?:\s?(?:중|말|초))?$/u.test(text));
    case "scope":
      return (FIELDS.scope.test(text) || /구역|층|스캐너|설치|교체|도입/u.test(text))
        && (/\d+\s?(?:개|곳|대|명|건|층|실|종)/u.test(text) || /(?:전체|전국)\s?[가-힣]{2,}|[A-Z]\s?(?:구역|라인|공장)/u.test(text));
    case "budget":
      if (!AMOUNT.test(text)) return false;
      if (/실제|실집행|집행액|정산/u.test(requirement)) return /실제|실집행|집행액|정산/u.test(text) && !/견적|예상|예정/u.test(text);
      if (/승인|확정\s?예산/u.test(requirement)) return /승인|확정/u.test(text);
      return true;
    case "conclusion":
      return content(text) && (REASON_CUE.test(text) || BASELINE_CUE.test(text) || /조건|전제|경우|확인/u.test(text)
        || (VALUE.test(text) && /있다|없다|되어|유지|확정|체결|완료|동결/u.test(text)));
  }
}

function suppliedField(check: FieldCheck, text: string, requirement: string): boolean {
  let supplied = false;
  for (const part of clauses(text)) {
    if (check === "budget" && /추가\s?(?:예산|비용).{0,5}없/u.test(part)) continue;
    const relevant = FIELDS[check].test(part);
    // An actual-settlement statement is not a denial of an explicitly requested estimate.
    const otherCostLevel = check === "budget" && /예상|견적|산정/u.test(requirement) && /실제|실집행|집행액|정산/u.test(part);
    if (relevant && UNRESOLVED.test(part) && !otherCostLevel) supplied = false;
    else if (fieldValue(check, part, requirement)) supplied = true;
  }
  return supplied;
}

/** Explicitly unset fields trigger candidates; the words alone never establish a gap. */
export function unresolvedImplementationChecks(text: string): SupplementCheck[] {
  return FIELD_CHECKS.filter(check => clauses(text).some(part => FIELDS[check].test(part) && UNRESOLVED.test(part) && !(check === "budget" && /추가\s?(?:예산|비용).{0,5}없/u.test(part)))
    || text.split(/(?<=[.!?])\s+/u).some(part => FIELDS[check].test(part) && /관련\s?부서.{0,10}협의.{0,10}(?:결정|예정)/u.test(part)))
    .filter(check => !suppliedField(check, text, check === "budget" && /실제|집행액|정산/u.test(text) ? "실제 집행액" : ""));
}

export function suppliesImplementationCheck(check: SupplementCheck, text: string, requirement = ""): boolean {
  if (Object.hasOwn(FIELDS, check)) return suppliedField(check as FieldCheck, text, requirement);
  switch (check) {
    case "period":
      return text.split(/(?<=[.!?])\s+|\n/u).some((sentence) => PERIOD_EXPR.test(sentence)
        && (KPI_TERM.test(sentence) || contentTokens(sentence).some((token) => familyOf(token) !== undefined))
        && content(sentence.replace(PERIOD_EXPR, "")));
    case "unit":
      return text.split(/(?<=[.!?])\s+|\n/u).some((sentence) => (UNIT_EXPR.test(sentence) || KPI_VALUE.test(sentence)) && VALUE.test(sentence)
        && (KPI_TERM.test(sentence) || contentTokens(sentence).some((token) => familyOf(token) !== undefined)));
    case "cause":
      // A bare result restatement ("매출이 15% 감소했다") is not a cause: require an explicit
      // cause cue or a multi-clause explanatory construction, not just the change itself.
      return (CAUSE_CUE.test(text) || REASON_CUE.test(text) || /(면서|으며|어서|아서|여서|으나|지만|므로|기에)/u.test(text)) && content(text);
    case "impact":
      return (IMPACT_CUE.test(text) || IMPACT_CUE.test(contentTokens(text).join(" "))) && content(text);
    case "response":
      return RESPONSE_CUE.test(text) && (ACTION_WORD.test(text) || ACTION_DONE.test(text) || FACT.test(text))
        && contentTokens(text.replace(RESPONSE_CUE, "").replace(ACTION_WORD, "")).length >= 2;
    default:
      return true;
  }
}
