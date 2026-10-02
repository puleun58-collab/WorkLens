import type { SupplementCheck } from "@/domain/supplement";
import { OWNER_CUE, SCHEDULE_CUE } from "./text";

/** Concrete answers required by execution checks, shared by search and AI rebuttal. */
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
    default:
      // Other checks retain their existing meaning-level rebuttal contract.
      return true;
  }
}
