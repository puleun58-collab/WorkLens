import type { SupplementCheck } from "@/domain/supplement";
import { ACTION_WORD, ACTION_DONE, BASELINE_CUE, CAUSE_CUE, REASON_CUE, RESPONSE_CUE, IMPACT_CUE, TARGET_HEADER, PERIOD_EXPR, UNIT_EXPR, OWNER_CUE, SCHEDULE_CUE, KPI_TERM, KPI_VALUE, contentTokens, familyOf } from "./text";

/** Concrete evidence, shared by search and AI rebuttal. Linking remains in the engine. */
const VALUE = /\d+(?:[.,]\d+)?/u;
const FACT = /(했다|한다|된다|되었다|하였다|있다|없다|발생|확인|증가|감소|상승|하락|확대|축소|부담|지연|중단|초래|절감|개선|달성|기여|커졌|늘었|줄었)/u;
// A label followed by a value is evidence; a bare heading is not.
const content = (text: string) => VALUE.test(text) || FACT.test(text) || /[:：]\s*\S.{3,}/u.test(text);

export function suppliesImplementationCheck(check: SupplementCheck, text: string): boolean {
  switch (check) {
    case "owner":
      return OWNER_CUE.test(text)
        && /[가-힣A-Za-z]{2,}(팀|본부|센터|부서)|(?:담당|책임자|주관|주무)\s?[:：]\s?[가-힣]{2,4}(?=\s|$)|[가-힣]O{1,2}|[가-힣]{2,4}\s?(님|선임|수석|매니저|팀장|과장|부장)/u.test(text)
        && !/(관련|유관|관계)\s?(부서|팀)|담당.*(미정|추후|협의)/u.test(text);
    case "schedule":
      return SCHEDULE_CUE.test(text)
        && /\d{1,4}\s?[년월일./-]|상반기|하반기|연내|연말|월말|분기\s?말|다음\s?(주|달|분기)|\d+\s?(일|주|개월)\s?이내/u.test(text);
    case "scope":
      return /(대상|범위|설치|교체|도입)/u.test(text) && /\d+\s?(개|곳|대|명|건|층|실|종)/u.test(text);
    case "budget":
      return /\d[\d,.~～-]*\s?(조|억|천만|백만|만|천)?\s?원/u.test(text);
    case "baseline":
      return BASELINE_CUE.test(text) && content(text);
    case "target":
      return TARGET_HEADER.test(text) && content(text);
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
    case "conclusion":
      // Expectation-only text ("향후 개선이 기대된다") is not support. A concrete stated fact
      // (value + factual state) can ground a conclusion even without a cue word.
      return content(text) && (REASON_CUE.test(text) || BASELINE_CUE.test(text) || /조건|전제|경우|확인/u.test(text)
        || (VALUE.test(text) && /(있다|없다|되어|유지|확정|체결|완료|동결)/u.test(text)));
    default:
      return true;
  }
}
