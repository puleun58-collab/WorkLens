/**
 * Korean business-report vocabulary for 보완. Every pattern here is a cue for
 * a kind of information, never a verdict on its own: detection pairs a cue with
 * the subject it is about, and the document-wide search decides.
 */

const PARTICLES = [
  "에서는", "으로는", "에서의", "에게서", "이라는", "에서", "으로", "까지", "부터", "에게", "이며", "이고", "으며",
  "보다", "처럼", "만큼", "에는", "와의", "과의", "로의", "은", "는", "이", "가", "을", "를", "의", "에", "도", "와", "과", "로", "만",
];

/** Words that never name what a sentence is about. */
const STOP: Readonly<Record<string, true>> = Object.fromEntries([
  "당사", "회사", "전사", "올해", "금년", "이번", "이번달", "금월", "당월", "전월", "전년", "전년도", "작년", "지난달", "전분기", "당분기", "분기", "전기", "당기",
  "전주", "금주", "동기", "대비", "기준", "현재", "현황", "주요", "관련", "대한", "통해", "위해", "따라", "경우", "부분", "내용", "사항", "결과", "기간", "대상",
  "전체", "해당", "각각", "모든", "일부", "약", "총", "누계", "합계", "소계", "증감", "증감률", "증감율", "변동", "변동률", "비율", "전망", "향후", "예상", "예정",
  "및", "또는", "그리고", "하지만", "따라서", "그러나", "또한", "이에", "것으로", "것", "수", "등", "중", "내", "후", "전", "월", "주차", "연간", "상반기", "하반기",
  ].map((word) => [word, true]));

/**
 * Metric families. Grouping uses any member; relating two lines needs one side
 * to be the family's general word, so 운송비 and 인건비 never explain each other.
 */
const FAMILIES: ReadonlyArray<{ key: string; label: string; generic: RegExp; test: (token: string) => boolean }> = [
  { key: "cost", label: "비용", generic: /^(비용|원가|경비|지출|cost|costs|expense|expenses)$/u, test: (token) => /^(비용|원가|경비|지출|운임|단가|물류비용|운송비용|cost|costs|expense|expenses|freight|logistics)$/u.test(token) || (/비$/u.test(token) && token.length >= 2 && !/^(대비|준비|장비|설비|구비|경비율)$/u.test(token)) },
  { key: "revenue", label: "매출", generic: /^(매출|매출액|수익|sales|revenue)$/u, test: (token) => /^(매출|매출액|판매|판매량|판매액|수주|수주액|수익|sales|revenue)$/u.test(token) },
  { key: "profit", label: "이익", generic: /^(이익|손익)$/u, test: (token) => /^(이익|영업이익|순이익|손익|마진|이익률|영업이익률)$/u.test(token) },
  { key: "delivery", label: "납기", generic: /^납기$/u, test: (token) => /^(납기|출하|배송|납품|지연)$/u.test(token) },
  { key: "quality", label: "품질", generic: /^품질$/u, test: (token) => /^(불량|불량률|품질|결함|클레임|반품)$/u.test(token) },
];

export const normalize = (value: string): string => value.normalize("NFKC").replace(/\s+/gu, " ").trim();

function stripParticle(token: string): string {
  for (const particle of PARTICLES) {
    if (token.length - particle.length >= 2 && token.endsWith(particle)) return token.slice(0, -particle.length);
  }
  return token;
}

/** Content words: nouns worth matching across locations, particles removed. */
export function contentTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of normalize(text).split(/[^가-힣A-Za-z]+/u)) {
    if (raw.length < 2) continue;
    // Verb and adjective forms carry no subject.
    if (/(습니다|합니다|됩니다|입니다|했다|한다|된다|하며|하고|하여|했고|되어|되었|있음|없음|했음|는데|지만)$/u.test(raw)) continue;
    const token = stripParticle(raw).toLocaleLowerCase("ko-KR");
    if (token.length < 2 || Object.hasOwn(STOP, token)) continue;
    tokens.push(token);
  }
  return tokens;
}

export function familyOf(token: string): { key: string; label: string } | undefined {
  const found = FAMILIES.find((family) => family.test(token));
  return found ? { key: found.key, label: found.label } : undefined;
}

/**
 * Two content-token sets name the same thing: a shared word, a word prefix, or
 * a metric family where one side uses the family's general word (비용 ↔ 물류비).
 */
export function tokensRelate(subject: readonly string[], other: readonly string[]): boolean {
  if (subject.length === 0 || other.length === 0) return false;
  const generic = (token: string) => FAMILIES.find((family) => family.test(token))?.generic.test(token) === true;
  return subject.some((token) => other.some((candidate) =>
    candidate === token
    || (token.length >= 2 && candidate.length >= 2 && (candidate.startsWith(token) || token.startsWith(candidate)))
    || (familyOf(token) !== undefined && familyOf(token)!.key === familyOf(candidate)?.key && (generic(token) || generic(candidate)))));
}

/** Mutually exclusive market segments: a figure for one is never explained by a line about another. */
const SEGMENTS: ReadonlyArray<{ key: string; pattern: RegExp }> = [
  { key: "domestic", pattern: /(?<![가-힣])(국내|내수)(?![가-힣외])/u },
  { key: "overseas", pattern: /(?<![가-힣])(해외|수출)(?![가-힣])/u },
  { key: "online", pattern: /(?<![가-힣])온라인(?![가-힣])/u },
  { key: "offline", pattern: /(?<![가-힣])오프라인(?![가-힣])/u },
  { key: "b2b", pattern: /(?<![A-Za-z])B2B(?![A-Za-z])/iu },
  { key: "b2c", pattern: /(?<![A-Za-z])B2C(?![A-Za-z])/iu },
];
/** Lettered or numbered groups of the same kind: 제품군 A ≠ 제품군 B, A라인 ≠ B라인. */
const GROUP_KIND: ReadonlyArray<[RegExp, string]> = [[/^(제품군|제품|모델)$/u, "product"], [/^(사업부|사업|부문)$/u, "division"], [/^라인$/u, "line"], [/^(브랜드)$/u, "brand"], [/^(채널)$/u, "channel"], [/^(공장)$/u, "plant"]];
const groupKind = (word: string) => GROUP_KIND.find(([pattern]) => pattern.test(word))?.[1];

/**
 * Named parties a figure belongs to: 고객사 A, A사, 서울지점, 알파 프로젝트,
 * a market segment (국내 · 해외) or a lettered group (제품군 B, A라인).
 * Only coded or explicitly suffixed names count; "고객 클레임" names nobody.
 */
export function entitiesOf(text: string): string[] {
  const found = new Set<string>();
  const value = normalize(text);
  const patterns = [
    /(?:고객사|고객|거래처|프로젝트)\s?([A-Z0-9][A-Za-z0-9-]*)(?![A-Za-z0-9])/gu,
    /(?<![A-Za-z0-9])([A-Z][A-Za-z0-9-]*)\s?(?:사|법인|지점)(?=\s|$|[^가-힣])/gu,
    /(?<![가-힣])([가-힣]{1,6})(?:법인|지점|센터)(?=\s|$|[^가-힣])/gu,
    /(?<![가-힣])([가-힣A-Za-z0-9]{1,10})\s프로젝트/gu,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const name = match[1].toLocaleLowerCase("ko-KR");
      if (!/^(주요|해당|전체|신규|기존|각|당|본|전|타|이|그|물류|고객)$/u.test(name)) found.add(name);
    }
  }
  for (const segment of SEGMENTS) if (segment.pattern.test(value)) found.add(`segment:${segment.key}`);
  for (const match of value.matchAll(/(?<![가-힣])(제품군|제품|모델|사업부|사업|부문|라인|브랜드|채널|공장)\s?([A-Z0-9])(?![A-Za-z0-9])/gu)) {
    found.add(`${groupKind(match[1])}:${match[2].toLocaleLowerCase("ko-KR")}`);
  }
  for (const match of value.matchAll(/(?<![A-Za-z0-9])([A-Z])\s?(제품군|라인|사업부|브랜드|공장|모델)(?![가-힣])/gu)) {
    found.add(`${groupKind(match[2])}:${match[1].toLocaleLowerCase("ko-KR")}`);
  }
  return [...found];
}

/** Both lines name a party and none is shared: they are about different customers or projects. */
export function differentParties(a: string, b: string): boolean {
  const left = entitiesOf(a);
  const right = entitiesOf(b);
  return left.length > 0 && right.length > 0 && !left.some((name) => right.includes(name));
}

export interface Period { year?: number; month?: number; quarter?: number; cumulative?: true }

/** The reporting period a text states, normalized; relative words (전월) are not a period. */
export function periodOf(text: string): Period | undefined {
  const value = normalize(text);
  const period: Period = {};
  const dated = /(20\d{2})\s?(?:[.\-/]\s?(\d{1,2})(?!\d)|년\s?(\d{1,2})\s?월)/u.exec(value);
  const year = dated?.[1] ?? /(20\d{2})\s?년?/u.exec(value)?.[1];
  if (year) period.year = Number(year);
  const month = dated?.[2] ?? dated?.[3] ?? /(?<![\d.])(\d{1,2})\s?월(?!\s?(말|초|중))/u.exec(value)?.[1];
  if (month && Number(month) >= 1 && Number(month) <= 12) period.month = Number(month);
  const quarter = /([1-4])\s?분기|Q([1-4])/u.exec(value);
  if (quarter) period.quarter = Number(quarter[1] ?? quarter[2]);
  if (/YTD|누적|누계|\d{1,2}\s*[~～–-]\s*\d{1,2}\s?월/iu.test(value)) period.cumulative = true;
  return Object.keys(period).length ? period : undefined;
}

/** Unknown on either side is compatible; stated periods must agree (a month sits inside its quarter). */
export function periodsCompatible(a: Period | undefined, b: Period | undefined): boolean {
  if (!a || !b) return true;
  if (a.year && b.year && a.year !== b.year) return false;
  if (!!a.cumulative !== !!b.cumulative) return false;
  if (a.month && b.month) return a.month === b.month;
  if (a.quarter && b.quarter) return a.quarter === b.quarter;
  if (a.month && b.quarter) return Math.ceil(a.month / 3) === b.quarter;
  if (a.quarter && b.month) return Math.ceil(b.month / 3) === a.quarter;
  return true;
}

export function periodLabel(period: Period | undefined): string | undefined {
  if (!period) return undefined;
  const parts = [period.year ? `${period.year}년` : "", period.month ? `${period.month}월` : period.quarter ? `${period.quarter}분기` : "", period.cumulative ? "누적" : ""].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

const UNIT_WON: Record<string, number> = { 조: 1e12, 억: 1e8, 억원: 1e8, 천만원: 1e7, 백만원: 1e6, 만원: 1e4, 천원: 1e3, 원: 1 };

/**
 * Money amounts in won. A bare number takes the unit stated around it (단위: 백만원);
 * without a stated unit it is not an amount, so 1,200 is never guessed.
 */
export function amountsInWon(text: string, context = ""): number[] {
  const hint = /단위\s?[:：]?\s?(조|억원|억|천만원|백만원|만원|천원|원)/u.exec(context)?.[1] ?? /\((조|억원|억|천만원|백만원|만원|천원|원)\)/u.exec(context)?.[1];
  const amounts: number[] = [];
  for (const match of normalize(text).matchAll(/(\d[\d,]*(?:\.\d+)?)\s?(조|억원|억|천만원|백만원|만원|천원|원)?(?![\d%.,])/gu)) {
    const unit = match[2] ?? hint;
    if (!unit) continue;
    const value = Number(match[1].replace(/,/gu, "")) * UNIT_WON[unit];
    if (Number.isFinite(value) && value >= 1e4) amounts.push(value);
  }
  return amounts;
}

export function sameAmount(a: readonly number[], b: readonly number[]): boolean {
  return a.some((left) => b.some((right) => Math.abs(left - right) <= Math.max(left, right) * 0.005));
}

/** Items that rise are bad news for these metrics. */
export const COST_LIKE = /(비용|원가|경비|지출|비$|불량|결함|지연|클레임|민원|사고|장애|이직|손실|적자|부채|오류|반품|폐기|누락|재고|단가|운임)/u;
/** Items that fall are bad news for these metrics. */
export const BENEFIT_LIKE = /(매출|이익|수익|판매|수주|만족|점유|달성|수율|가동률|생산성|정시|준수|참여|가입|유입|처리율)/u;

export const PERCENT = /([+\-−▲▼△]\s?)?(\d{1,3}(?:[.,]\d+)?)\s?(%p|%|퍼센트|포인트)/u;
export const UP_WORD = /(증가|상승|늘어|늘었|확대|급증|급등|오름|올라|초과|↑|▲|\+)/u;
export const DOWN_WORD = /(감소|하락|줄어|줄었|축소|급감|급락|내림|떨어|미달|↓|▼|−|-\s?\d)/u;
export const PERIOD_BASELINE = /(전년\s?동기|전년|전월|전분기|직전\s?분기|전기|전주|작년|지난달|지난해|전년도)\s?(대비|比|보다)?/u;

/** A comparison anchor that lets a reader judge a figure. */
export const BASELINE_CUE = /(목표|계획|예산|기준(값|치)?|대비|전년|전월|전분기|전기|전주|작년|지난|이전|평균|벤치마크|업계|동기|YoY|MoM|QoQ|vs\.?|→|에서\s?\d|보다)/iu;

/** Explicit reasons, or "A 증가로 B 확대" constructions without the word 원인. */
export const CAUSE_CUE = /(원인|요인|때문|영향으로|영향을\s?받|영향에|기인|(?:으)?로\s?인해|인하여|인한|에\s?따른|에\s?따라|덕분|견인|주도|반영|탓|사유|배경|이유|(?:영향|요인|기여도?)\s?[:：]?\s?[+\-−]?\d|[가-힣]{2,}(?:으)?로\s+(?:[가-힣A-Za-z]+\s+){0,3}(?:증가|확대|상승|감소|하락|축소|늘|줄|급증|급감|악화|개선))/u;

export const IMPACT_CUE = /(영향|손실|피해|파급|차질|지체상금|패널티|위약금|기회\s?비용|추가\s?비용|매출\s?감소|고객\s?불만|고객\s?이탈|생산\s?중단|출하\s?지연|리스크\s?금액|손해)/u;

export const RESPONSE_CUE = /(조치|대응|대책|개선|방안|재발\s?방지|시정|보완|해결|복구|재협상|협의|교체|강화|점검|교육|추진|예정|계획|도입|전환|확보|조정)/u;

/** Occurrence of a problem, risk or shortfall. */
export const ISSUE_WORD = /(지연|장애|불량|사고|클레임|민원|결함|차질|중단|누락|오류|이슈|문제|리스크|위험|미달|부족|이탈|실패|위반|미준수|미흡|미비|적발|반려|고장|결품|초과\s?근무)/u;
/** Evidence the problem actually happened or is expected, not just a heading. */
export const ISSUE_OCCURRENCE = /(\d+\s?(건|회|명|일|주|개월|시간|개|%)|발생|확인(됨|되었|했)|증가|지속|우려|예상|반복|심화|확대|초래)/u;
export const ISSUE_RESOLVED = /(없음|없었|없습니다|해결(됨|되었|했|완료)|정상화(됨|되었|완료)|이상\s?없|무사고|0\s?건|완료했|완료되었|해소)/u;

/** Forward-looking commitments. Completed work carries no owner/schedule gap. */
export const ACTION_WORD = /(예정|추진|하겠|할\s?계획|계획임|계획입니다|착수|진행\s?중|진행할|시행할|도입할|검토\s?중|조치\s?중|개선\s?중|실시\s?예정|재협상|적용할|강화할|확대할)/u;
export const ACTION_DONE = /(완료(했|하였|됨|되었)|실시(했|하였)|하였습니다|했습니다)$/u;
export const ACTION_HEADING = /(향후\s?(계획|과제|조치)|대응|조치|대책|실행\s?계획|개선\s?(계획|방안|과제)|추진\s?계획|결정\s?사항|후속\s?조치|액션\s?아이템|action|next\s?step)/iu;

export const OWNER_CUE = /(담당|책임자|주관|주무|PM\b|오너|owner|팀장|파트장|과장|부장|대리|차장|매니저|[가-힣]{1,6}(?:팀|본부|센터|부서|실)(?=$|[^가-힣]|[이은는을를에의과와도장])|[가-힣]O{1,2}|[가-힣]{2,4}\s?(님|책임|선임|수석))/iu;
export const SCHEDULE_CUE = /(\d{4}\s?[.\-/년]\s?\d{1,2}|\d{1,2}\s?월|\d{1,2}\/\d{1,2}|[1-4]\s?분기|Q[1-4]|상반기|하반기|연내|연말|월말|분기\s?말|주차|W\d{1,2}|까지|이내|기한|일정|D-\d+|내년|다음\s?(주|달|분기)|\d{1,2}일)/iu;

/** Performance indicators whose level means nothing without a reference. */
export const KPI_TERM = /(만족도|점수|지수|NPS|달성률|가동률|수율|불량률|이직률|정시율|정시\s?납기율|준수율|점유율|전환율|재구매율|응답률|처리율|충원율|리드타임|처리\s?시간|평균\s?대기|해지율|이탈률)/iu;
export const KPI_VALUE = /\d+(?:[.,]\d+)?\s?(점|%|일|시간|분|초|회|건)/u;

export const CONCLUSION_HEADING = /(결론|종합|시사점|요약|맺음|결어|총평|제언|summary|conclusion)/iu;
export const CONCLUSION_MARKER = /^(결론|종합하면|요약하면|따라서|결과적으로|결론적으로|이에\s?따라|종합적으로)/u;
/** A forecast or judgement: the kind of statement that needs support. */
export const JUDGEMENT = /(것으로\s?(예상|판단|전망|보입니다|보임)|로\s?판단|예상됩니다|전망됩니다|판단됩니다|보입니다|제한적일|문제\s?없을|충분할|타당하|바람직)/u;
export const REASON_CUE = /(때문|로\s?인해|으로\s?인해|덕분|근거|따라|반영|확보|체결|고정|계약|완료|헤지|분산|상쇄|예산\s?내|범위\s?내)/u;

const DIGIT_BATCHIM = [true, true, false, true, false, false, true, true, true, false];

/** Picks the particle that follows `word`; falls back to the paired form. */
export function josa(word: string, pair: "이/가" | "은/는" | "을/를" | "과/와"): string {
  const [withBatchim, without] = pair.split("/");
  const last = word.replace(/['"’”)\]\s]+$/u, "").slice(-1);
  if (!last) return `${withBatchim}(${without})`;
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? without : withBatchim;
  if (/\d/u.test(last)) return DIGIT_BATCHIM[Number(last)] ? withBatchim : without;
  if (last === "%") return without;
  return `${withBatchim}(${without})`;
}

export function clip(text: string, max: number): string {
  const value = normalize(text);
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** A worksheet row whose explanation column is filled (비고 · 원인 · 사유 …). */
export const EXPLANATION_FIELD = /(비고|원인|사유|코멘트|설명|요인|메모|comment|remark|note|reason)\s[^\s·]/iu;
/** Any statement of the period a figure belongs to. */
export const PERIOD_EXPR = /(\d{4}\s?년|\d{4}[.\-/]\d{1,2}|\d{1,2}\s?월|[1-4]\s?분기|Q[1-4]|YTD|누계|기준일|FY\s?\d*|반기|상반기|하반기|주차|W\d{1,2}|20\d{2}|당월|금월|전월|전년|금년|월별|분기별|연간|기간)/iu;
/** Any statement of the unit a figure is in. */
export const UNIT_EXPR = /(단위|\(\s?(원|천원|만원|백만원|억원|억|%|건|EA|개|명|톤|kg|km|달러|USD|KRW)\s?\)|천원|백만원|억원|만원|₩|\$|USD|KRW|EUR|\d\s?원)/iu;
/** Money-like measures, where 1,200 means nothing without its unit. */
export const MONEY_LABEL = /(매출|비용|금액|원가|이익|예산|단가|운임|경비|지출|수익|손익|cost|sales|revenue|amount|비$|액$)/iu;
export const TARGET_HEADER = /(목표|계획|예산|기준|target|plan|budget)/iu;
export const ATTAINMENT_HEADER = /(달성률|달성율|달성도|진척률|진도율)/u;
