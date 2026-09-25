/**
 * Contract review for 종합 리서치 › 문서 검토.
 *
 * Order matters: what the document is and what each clause governs are
 * decided first, deterministically, from the text; only then does the server
 * search 법제처 data, and only within the areas of law that fit. Nothing here
 * calls a model or invents a statute, case number or date — every citation
 * shown comes from a search result, and this module only decides which
 * searches are allowed and which results are relevant.
 */

export type DocumentType = "b2b_service" | "b2c_terms" | "employment" | "lease" | "outsourcing" | "sale" | "nda" | "unknown";
export type PartyRelationship = "business" | "consumer" | "employment" | "lease" | "unknown";
/** Area of law a statute or precedent belongs to; searches never leave the document's allowed areas. */
export type LawDomain = "civil" | "terms" | "privacy" | "procedure" | "labor" | "lease" | "consumer";
export type Severity = "high" | "medium" | "low";
export type Confidence = "high" | "medium" | "low";

export interface DocumentProfile {
  type: DocumentType;
  label: string;
  relationship: PartyRelationship;
  relationshipLabel: string;
  confidence: Confidence;
  /** Phrases in the text that support the classification; internal trace, safe to show. */
  evidence: string[];
  domains: LawDomain[];
}

export interface Clause {
  number?: string;
  title?: string;
  text: string;
}

export interface LawTarget {
  law: string;
  jo: string;
  domain: LawDomain;
  /** When the statute applies only under a premise the document alone cannot settle. */
  condition?: string;
}

export interface IssueDefinition {
  id: string;
  label: string;
  severity: Severity;
  /** What to check; worded as a review point, never as a legal conclusion. */
  point: string;
  detect: RegExp;
  /** Only documents of these types raise the issue (e.g. 해고 only in employment contracts). */
  only?: DocumentType[];
  laws: LawTarget[];
  /** Search stages, most specific first; `{doc}` becomes the document's search term. */
  queries?: string[];
  /** Precedents are accepted only if their holding mentions one of these. */
  holdingTerms?: RegExp;
  /** A holding sentence matching this is about a different question (e.g. international jurisdiction). */
  holdingExclude?: RegExp;
  /** Case titles that signal this issue directly (e.g. 이송 for jurisdiction); ranked first. */
  titleTerms?: RegExp;
  /** Issues sharing a group reuse one precedent search. */
  group?: string;
}

export interface ClauseIssue {
  id: string;
  label: string;
  severity: Severity;
  point: string;
  /** The clause text that triggered the issue, verbatim. */
  fact: string;
}

export interface ReviewedClause extends Clause {
  issues: ClauseIssue[];
}

export interface KeyFact {
  label: string;
  value: string;
  clause?: string;
}

// ── Document type and party relationship ───────────────────────────────


const TYPE_SIGNALS: Array<{ type: DocumentType; label: string; patterns: RegExp[] }> = [
  { type: "employment", label: "근로계약", patterns: [/근로계약/u, /근로자/u, /사용자/u, /임금|기본급/u, /근로시간|소정근로/u] },
  { type: "lease", label: "임대차계약", patterns: [/임대차/u, /임대인/u, /임차인/u, /보증금/u, /차임|월세/u] },
  { type: "b2c_terms", label: "소비자 대상 이용약관", patterns: [/이용약관/u, /회원/u, /개인\s*소비자|소비자/u, /청약\s*철회|환불/u, /구독료|자동\s*결제/u] },
  { type: "b2b_service", label: "서비스 이용계약", patterns: [/서비스\s*이용\s*계약|이용계약/u, /소프트웨어|클라우드|SaaS|솔루션/iu, /이용\s*요금|이용료/u, /제공자/u, /이용자/u] },
  { type: "outsourcing", label: "용역계약", patterns: [/용역\s*계약/u, /발주자|도급인/u, /수급인|수탁자/u, /납품|검수/u] },
  { type: "sale", label: "매매·공급계약", patterns: [/매매\s*계약|공급\s*계약/u, /매도인|공급자/u, /매수인/u, /대금/u] },
  { type: "nda", label: "비밀유지계약", patterns: [/비밀\s*유지/u, /비밀정보/u, /누설/u] },
];

const DOMAINS: Record<DocumentType, LawDomain[]> = {
  b2b_service: ["civil", "terms", "privacy", "procedure"],
  b2c_terms: ["civil", "terms", "consumer", "privacy", "procedure"],
  employment: ["civil", "labor", "privacy", "procedure"],
  lease: ["civil", "lease", "procedure"],
  outsourcing: ["civil", "terms", "privacy", "procedure"],
  sale: ["civil", "terms", "procedure"],
  nda: ["civil", "privacy", "procedure"],
  unknown: ["civil", "procedure"],
};

const RELATIONSHIP_LABEL: Record<PartyRelationship, string> = {
  business: "사업자 간",
  consumer: "사업자와 소비자",
  employment: "사용자와 근로자",
  lease: "임대인과 임차인",
  unknown: "확인 불가",
};

export function classifyDocument(text: string): DocumentProfile {
  const head = text.slice(0, 1500);
  const scored = TYPE_SIGNALS.map((signal) => {
    const hits = signal.patterns.filter((pattern) => pattern.test(text));
    // The title and the parties' description carry the document's own name for itself.
    const titled = signal.patterns[0].test(head.split("\n")[0] ?? "") ? 2 : 0;
    return { ...signal, hits, score: hits.length + titled };
  }).sort((left, right) => right.score - left.score);
  const [best, second] = scored;
  const decided = best.score >= 3 && best.score > (second?.score ?? 0);
  const type: DocumentType = decided ? best.type : "unknown";
  const confidence: Confidence = !decided ? "low" : best.score - (second?.score ?? 0) >= 3 ? "high" : "medium";

  const corporateParties = (head.match(/주식회사|㈜|\(주\)|유한회사|법인/gu) ?? []).length;
  const relationship: PartyRelationship = type === "employment" ? "employment"
    : type === "lease" ? "lease"
    : type === "b2c_terms" ? "consumer"
    : corporateParties >= 2 ? "business"
    : "unknown";
  const evidence = decided ? best.hits.map((pattern) => text.match(pattern)?.[0] ?? "").filter(Boolean) : [];
  if (relationship === "business") evidence.push(`계약 당사자 ${corporateParties}곳이 법인`);
  return {
    type,
    label: decided ? best.label : "유형 확인 불가",
    relationship,
    relationshipLabel: RELATIONSHIP_LABEL[relationship],
    confidence,
    evidence,
    domains: DOMAINS[type],
  };
}

/** Term the precedent search uses for this document; generic when the type is unknown. */
export function documentSearchTerm(profile: DocumentProfile): string {
  switch (profile.type) {
    case "b2b_service": return "서비스 이용계약";
    case "b2c_terms": return "이용약관";
    case "employment": return "근로계약";
    case "lease": return "임대차";
    case "outsourcing": return "용역계약";
    case "sale": return "매매계약";
    case "nda": return "비밀유지계약";
    case "unknown": return "계약";
  }
}

// ── Clauses ──────────────────────────────────────────────────────────────

const CLAUSE_HEAD = /^\s*(제\s*\d+\s*조(?:의\s*\d+)?)\s*(?:\(([^)]{1,40})\))?\s*/u;

export function splitClauses(text: string): Clause[] {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n")
    // A line break lost in copying can leave "…한다. 제2조(해지) …" on one line; an article
    // heading right after a sentence end starts a new clause, a cross-reference mid-sentence does not.
    .flatMap((line) => line.split(/(?<=[.다])\s+(?=제\s*\d+\s*조(?:의\s*\d+)?\s*\()/u))
    .map((line) => line.trim()).filter(Boolean);
  const clauses: Clause[] = [];
  for (const line of lines) {
    const head = CLAUSE_HEAD.exec(line);
    if (head) {
      clauses.push({ number: head[1].replace(/\s+/gu, ""), ...(head[2] ? { title: head[2] } : {}), text: line.slice(head[0].length).trim() });
    } else if (clauses.length && clauses.at(-1)!.number) {
      clauses.at(-1)!.text += ` ${line}`;
    } else {
      clauses.push({ text: line });
    }
  }
  // Without numbered articles every sentence is its own unit.
  if (!clauses.some((clause) => clause.number)) {
    return clauses.flatMap((clause) => clause.text.split(/(?<=[.다])\s+/u).filter(Boolean).map((sentence) => ({ text: sentence })));
  }
  return clauses.filter((clause) => clause.number);
}

// ── Issue taxonomy ─────────────────────────────────────────────────────

const TERMS_ACT = "약관의 규제에 관한 법률";
const TERMS_CONDITION = "이 계약이 약관(여러 상대방과 계약하기 위해 미리 마련한 계약 내용)에 해당하는 경우에 적용됩니다.";

export const ISSUES: IssueDefinition[] = [
  {
    id: "auto_renewal", label: "자동 갱신", severity: "low",
    point: "갱신 거절 통지 기한과 방법이 명확한지, 갱신 전 고지 절차가 있는지 확인이 필요합니다.",
    // "자동 연장" and paraphrases: "해지 의사가 없는 경우 … 갱신된다", "종료 의사 표시가 없으면 … 연장된다".
    detect: /자동\s*(?:으로\s*)?(?:갱신|연장)|(?:통지|의사\s*표시|의사|이의)[^.]{0,15}(?:없|아니)[^.]{0,40}(?:갱신|연장)(?:된다|한다|되는|하는)/u,
    laws: [{ law: TERMS_ACT, jo: "제12조", domain: "terms", condition: TERMS_CONDITION }],
    queries: ["{doc} 자동갱신 해지 통지", "자동갱신 조항 해지 고지", "계약 자동연장 갱신거절 통지"],
    holdingTerms: /자동\s*(?:갱신|연장)|갱신거절|묵시적\s*갱신|의사표시의\s*의제/u,
  },
  {
    id: "price_change", label: "일방적 요금 변경", severity: "high",
    point: "한쪽 당사자가 요금을 임의로 변경할 수 있게 한 조항은 효력이 제한될 수 있어 변경 요건·통지·해지권 보장 여부를 확인할 필요가 있습니다.",
    detect: /(?:요금|대금|가격|이용료|구독료|단가)[^.]{0,50}(?:변경|인상|조정)할\s*수\s*있/u,
    laws: [{ law: TERMS_ACT, jo: "제10조", domain: "terms", condition: TERMS_CONDITION }],
    queries: ["{doc} 일방적 요금 변경 약관", "약관 사업자 일방적 급부 변경", "일방적 계약조건 변경 약관 무효"],
    holdingTerms: /일방적[^.]{0,20}(?:변경|결정)|급부[^.]{0,10}변경|요금[^.]{0,10}변경|약관의\s*규제에\s*관한\s*법률\s*제10조/u,
    group: "unilateral_change",
  },
  {
    id: "service_suspension", label: "통지 없는 서비스 변경·중단", severity: "high",
    point: "사전 통지 없이 서비스를 변경·중단할 수 있게 하고 그 책임을 배제한 부분의 범위가 과도하지 않은지 검토가 필요합니다.",
    detect: /(?:사전\s*)?통지\s*없이[^.]{0,60}(?:변경|중단|중지)|서비스[^.]{0,40}(?:중단|중지)할\s*수\s*있/u,
    laws: [{ law: TERMS_ACT, jo: "제10조", domain: "terms", condition: TERMS_CONDITION }],
    queries: ["{doc} 서비스 중단 면책 약관", "약관 서비스 일방적 중단", "일방적 급부 중단 약관 무효"],
    holdingTerms: /서비스[^.]{0,20}(?:중단|중지)|급부[^.]{0,10}(?:중지|중단|변경)|일방적[^.]{0,20}중단/u,
    group: "unilateral_change",
  },
  {
    id: "exemption", label: "광범위한 면책", severity: "high",
    point: "어떠한 경우에도 책임을 지지 않는다는 취지의 면책은 고의·중과실까지 포함하는지에 따라 효력이 제한될 수 있어 범위 확인이 필요합니다.",
    detect: /(?:어떠한|일체의|모든)?[^.]{0,20}책임(?:도|을)?\s*지지\s*않|면책/u,
    laws: [
      { law: TERMS_ACT, jo: "제7조", domain: "terms", condition: TERMS_CONDITION },
      { law: "민법", jo: "제103조", domain: "civil" },
    ],
    queries: ["{doc} 면책조항 효력", "면책약관 고의 중과실 효력", "면책조항 무효 약관"],
    holdingTerms: /면책\s*(?:약관|조항|특약|약정)|책임을?\s*(?:배제|면제|제한)하는\s*(?:약관|조항|특약|약정)|약관의\s*규제에\s*관한\s*법률\s*제7조/u,
    group: "exemption",
  },
  {
    id: "liability_cap", label: "손해배상 한도", severity: "medium",
    point: "손해배상 한도가 실제 손해에 비해 지나치게 낮게 정해져 있는지, 고의·중과실에도 적용되는지 확인이 필요합니다.",
    detect: /(?:손해배상|배상)\s*책임[^.]{0,60}한도|한도로\s*한다|간접\s*손해/u,
    laws: [{ law: TERMS_ACT, jo: "제7조", domain: "terms", condition: TERMS_CONDITION }],
    queries: ["{doc} 손해배상 한도 약관", "손해배상 책임 제한 약관 효력"],
    holdingTerms: /(?:배상|책임)[^.]{0,10}(?:한도|상한)[^.]{0,30}(?:약관|조항|약정)|책임을?\s*제한하는\s*(?:약관|조항|약정)|약관의\s*규제에\s*관한\s*법률\s*제7조/u,
    group: "exemption",
  },
  {
    id: "unilateral_termination", label: "일방적 즉시 해지권", severity: "medium",
    point: "한쪽 당사자에게만 최고 없는 즉시 해지권을 둔 부분은 해지 사유가 구체적인지, 상대방에게도 균형 있는 해지권이 있는지 확인이 필요합니다.",
    detect: /(?:즉시|최고\s*없이|별도의\s*최고\s*없이)[^.]{0,30}(?:해지|해제)/u,
    laws: [
      { law: TERMS_ACT, jo: "제9조", domain: "terms", condition: TERMS_CONDITION },
      { law: "민법", jo: "제544조", domain: "civil" },
    ],
    queries: ["{doc} 일방적 해지 조항 효력", "약관 사업자 일방적 해지권", "최고 없는 계약 해지 약정 효력"],
    holdingTerms: /해지권|해제권|최고\s*없이|일방적[^.]{0,10}해지|약관의\s*규제에\s*관한\s*법률\s*제9조/u,
    group: "termination",
  },
  {
    id: "termination_restriction", label: "중도해지 제한", severity: "medium",
    point: "이용자의 중도해지를 전면 금지한 부분이 상대방의 해지권을 부당하게 제한하는지 검토가 필요합니다.",
    detect: /해지할\s*수\s*없|해지하지\s*못|해지를\s*(?:금지|제한)/u,
    laws: [{ law: TERMS_ACT, jo: "제9조", domain: "terms", condition: TERMS_CONDITION }],
    queries: ["{doc} 중도해지 제한 약관", "고객 해지권 제한 약관 무효"],
    holdingTerms: /해지권[^.]{0,10}(?:제한|배제|박탈)|중도\s*해지|약관의\s*규제에\s*관한\s*법률\s*제9조/u,
    group: "termination",
  },
  {
    id: "penalty", label: "위약금·손해배상 예정", severity: "high",
    point: "위약금이 손해배상 예정액으로서 부당히 과다한지 검토가 필요합니다. 과다한 경우 법원이 감액할 수 있습니다.",
    detect: /위약금|위약벌|손해배상액?의\s*예정/u,
    laws: [
      { law: "민법", jo: "제398조", domain: "civil" },
      { law: TERMS_ACT, jo: "제8조", domain: "terms", condition: TERMS_CONDITION },
    ],
    queries: ["{doc} 위약금 과다 감액", "위약금 손해배상 예정액 감액", "손해배상 예정액 부당히 과다"],
    // A penalty holding must be about the amount being excessive or reduced, not e.g. its limitation period.
    holdingTerms: /(?:위약금|위약벌|손해배상\s*(?:액의|의)\s*예정|예정\s*배상액)[^.]{0,80}(?:감액|과다|부당히)|(?:감액|과다|부당히)[^.]{0,80}(?:위약금|위약벌|손해배상\s*(?:액의|의)\s*예정|예정\s*배상액)|민법\s*제398조\s*제2항/u,
  },
  {
    id: "data_transfer", label: "개인정보·업무 데이터 제3자 제공", severity: "high",
    point: "제3자 제공 대상이 개인정보인지 업무 데이터인지, 제공인지 처리위탁인지, 법적 근거나 동의 예외가 있는지 문서만으로는 확인되지 않아 추가 확인이 필요합니다.",
    detect: /(?:개인정보|업무\s*데이터|이용자\s*정보|정보)[^.]{0,80}제3자에게[^.]{0,30}제공|제3자에게[^.]{0,40}(?:개인정보|정보)/u,
    laws: [
      { law: "개인정보 보호법", jo: "제17조", domain: "privacy" },
      { law: "개인정보 보호법", jo: "제26조", domain: "privacy" },
    ],
    queries: ["개인정보 제3자 제공 동의 없이", "개인정보 제3자 제공 처리위탁 구별"],
    holdingTerms: /개인정보[^.]{0,20}(?:제3자|제공|위탁)|처리위탁/u,
  },
  {
    id: "contract_change", label: "일방적 계약 내용 변경", severity: "high",
    point: "상대방의 동의 없이 계약 내용을 변경할 수 있도록 한 조항은 계약 유형과 적용 법령에 따라 효력이 제한될 수 있어 추가 확인이 필요합니다.",
    detect: /(?:계약|약관)(?:의)?\s*(?:내용|조건)?[^.]{0,20}변경할\s*수\s*있/u,
    laws: [{ law: TERMS_ACT, jo: "제10조", domain: "terms", condition: TERMS_CONDITION }],
    queries: ["{doc} 일방적 계약조건 변경", "약관 사업자 일방적 계약 변경", "일방적 계약조건 변경 약관 무효"],
    holdingTerms: /일방적[^.]{0,20}변경|계약\s*(?:내용|조건)[^.]{0,10}변경|약관[^.]{0,10}변경/u,
    group: "unilateral_change",
  },
  {
    id: "policy_delegation", label: "운영정책 포괄 위임", severity: "medium",
    point: "계약에 정하지 않은 사항을 한쪽이 수시로 바꿀 수 있는 운영정책에 맡긴 부분은 실질적으로 계약 내용을 일방적으로 정하게 되는지 확인이 필요합니다.",
    detect: /운영\s*정책|별도로\s*정하는[^.]{0,20}(?:정책|기준|규정)에\s*따르/u,
    laws: [{ law: TERMS_ACT, jo: "제6조", domain: "terms", condition: TERMS_CONDITION }],
    group: "unilateral_change",
  },
  {
    id: "jurisdiction", label: "전속 관할", severity: "low",
    point: "한쪽 당사자의 소재지 법원을 전속 관할로 정한 부분이 상대방에게 부당하게 불리한지 확인이 필요합니다.",
    detect: /전속\s*관할|관할\s*법원으로\s*한다|본점\s*소재지를\s*관할/u,
    laws: [
      { law: "민사소송법", jo: "제29조", domain: "procedure" },
      { law: TERMS_ACT, jo: "제14조", domain: "terms", condition: TERMS_CONDITION },
    ],
    holdingExclude: /국제\s*재판\s*관할|외국\s*법원/u,
    titleTerms: /이송|관할/u,
    queries: ["{doc} 전속관할 합의 효력", "관할합의 약관 고객 불리"],
    holdingTerms: /관할\s*합의|전속\s*관할|합의\s*관할|약관의\s*규제에\s*관한\s*법률\s*제14조/u,
  },
  // Document-type-specific issues: raised only when the document itself is of that kind.
  {
    id: "dismissal", label: "예고 없는 해고", severity: "high", only: ["employment"],
    point: "예고 없이 즉시 해고할 수 있게 한 부분이 해고 예고 및 정당한 이유 요건과 맞는지 확인이 필요합니다.",
    detect: /해고/u,
    laws: [
      { law: "근로기준법", jo: "제23조", domain: "labor" },
      { law: "근로기준법", jo: "제26조", domain: "labor" },
    ],
    queries: ["근로계약 즉시 해고 예고", "해고예고 없는 해고 효력"],
    holdingTerms: /해고/u,
  },
  {
    id: "lease_renewal", label: "계약갱신 요구 거절", severity: "high", only: ["lease"],
    point: "임차인의 계약갱신 요구를 거절할 수 있게 한 부분이 임차인의 갱신요구권과 맞는지 확인이 필요합니다.",
    detect: /갱신\s*요구[^.]{0,20}거절|갱신을\s*거절/u,
    laws: [{ law: "상가건물 임대차보호법", jo: "제10조", domain: "lease" }],
    queries: ["상가건물 임대차 계약갱신요구 거절", "임차인 갱신요구권 배제 특약"],
    holdingTerms: /갱신\s*요구|갱신요구권|갱신거절/u,
  },
  {
    id: "restoration", label: "원상복구 범위", severity: "medium", only: ["lease"],
    point: "원상복구 범위가 임차인이 설치한 부분을 넘어 과도하게 정해져 있는지 확인이 필요합니다.",
    detect: /원상\s*(?:으로\s*)?복구/u,
    laws: [{ law: "민법", jo: "제654조", domain: "civil" }],
    queries: ["임대차 원상복구 범위", "임차인 원상회복의무 범위"],
    holdingTerms: /원상\s*(?:복구|회복)/u,
  },
  {
    id: "withdrawal_restriction", label: "청약철회·환불 제한", severity: "high", only: ["b2c_terms"],
    point: "결제 후 어떠한 경우에도 청약철회·환불을 할 수 없게 한 부분이 소비자의 청약철회권과 맞는지 확인이 필요합니다.",
    detect: /청약\s*(?:을\s*)?철회|환불[^.]{0,20}(?:요청할\s*수\s*없|불가)/u,
    laws: [{ law: "전자상거래 등에서의 소비자보호에 관한 법률", jo: "제17조", domain: "consumer" }],
    queries: ["청약철회 제한 약관 효력", "디지털콘텐츠 청약철회 제한"],
    holdingTerms: /청약\s*철회|환불/u,
  },
];

const SEVERITY_WEIGHT: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export interface LawReference {
  key: string;
  law: string;
  jo: string;
  /** Article title exactly as 법제처 returned it; empty when the response had none. */
  title: string;
  excerpt: string;
  effectiveDate?: string;
  condition?: string;
}

export interface PrecedentReference {
  key: string;
  id: string;
  title?: string;
  caseNumber?: string;
  court?: string;
  date?: string;
  /** The 판시사항 sentence that addresses this clause's issue, verbatim. */
  holding: string;
  /** Only the compact 판시사항 view was read, never the full judgment. */
  scope: "판시사항";
}

export type SourceStatus = "found" | "none" | "failed" | "not_searched";

export interface ReviewedIssue extends ClauseIssue {
  laws: string[];
  precedents: string[];
  lawStatus: SourceStatus;
  precedentStatus: SourceStatus;
}

export interface ContractReview {
  document: DocumentProfile;
  risk: ReturnType<typeof documentRisk>;
  facts: KeyFact[];
  clauses: Array<Clause & { issues: ReviewedIssue[] }>;
  laws: Record<string, LawReference>;
  precedents: Record<string, PrecedentReference>;
  /** Diagnostics for development; not shown to users. */
  stats: { calls: number; queries: number; excludedPrecedents: number; excludedLaws: number };
}

/** The sentence of the clause that triggered the issue, verbatim. */
function triggeringSentence(text: string, pattern: RegExp): string {
  const sentences = text.split(/(?<=[.다])\s+/u);
  return (sentences.find((sentence) => pattern.test(sentence)) ?? text).trim();
}
export function reviewClauses(clauses: readonly Clause[], profile: DocumentProfile): ReviewedClause[] {
  return clauses.map((clause) => ({
    ...clause,
    issues: ISSUES.filter((issue) => (!issue.only || issue.only.includes(profile.type)) && issue.detect.test(clause.text))
      .map((issue) => ({ id: issue.id, label: issue.label, severity: issue.severity, point: issue.point, fact: triggeringSentence(clause.text, issue.detect) })),
  }));
}

/** Statutes an issue may cite in this document: only those in the document's areas of law. */
export function lawTargets(issue: IssueDefinition, profile: DocumentProfile): LawTarget[] {
  return issue.laws.filter((law) => profile.domains.includes(law.domain));
}

/**
 * Risk of the document's own clauses: each distinct issue counts once, by
 * severity. How many statutes or precedents were found never changes it.
 */
export function documentRisk(clauses: readonly ReviewedClause[]): { score: number; level: "높음" | "보통" | "낮음"; high: number; medium: number; low: number } {
  const seen = new Map<string, Severity>();
  for (const clause of clauses) for (const issue of clause.issues) seen.set(issue.id, issue.severity);
  const counts = { high: 0, medium: 0, low: 0 };
  let score = 0;
  for (const severity of seen.values()) {
    counts[severity] += 1;
    score += SEVERITY_WEIGHT[severity];
  }
  const level = counts.high >= 3 || score >= 12 ? "높음" : counts.high >= 1 || score >= 5 ? "보통" : "낮음";
  return { score, level, ...counts };
}

// ── Key facts: verbatim spans, never rewritten ─────────────────────────

const FACT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "계약기간", pattern: /\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일\s*부터\s*\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일\s*까지/gu },
  { label: "금액", pattern: /(?:(?:연간|월|월\s*기본급은?|월\s*차임은?|임대차보증금은?)\s*)?(?:[가-힣]+\s+)?(?:금\s*)?\d{1,3}(?:,\d{3})+\s*원(?:\s*\([^)]{1,20}\))?/gu },
  { label: "위약금·비율", pattern: /[가-힣]+(?:\s[가-힣]+){0,4}의\s*\d+(?:\.\d+)?\s*%/gu },
  { label: "통지 기한", pattern: /[가-힣]+(?:\s[가-힣]+){0,2}\s*\d+\s*일\s*전까지/gu },
];

export function extractKeyFacts(clauses: readonly Clause[]): KeyFact[] {
  const facts: KeyFact[] = [];
  const seen = new Set<string>();
  for (const clause of clauses) {
    for (const { label, pattern } of FACT_PATTERNS) {
      for (const match of clause.text.matchAll(pattern)) {
        // "이용자는 잔여 … 200%" → "잔여 … 200%": the subject is not part of the value.
        const value = match[0].trim().replace(/^[가-힣]+(?:은|는|이|가)\s+(?=\S+\s)/u, "");
        if (seen.has(value)) continue;
        seen.add(value);
        facts.push({ label, value, ...(clause.number ? { clause: clause.number } : {}) });
      }
    }
  }
  return facts;
}

// ── Search terms and relevance ─────────────────────────────────────────

export function precedentQueries(issue: IssueDefinition, profile: DocumentProfile): string[] {
  const term = documentSearchTerm(profile);
  return (issue.queries ?? []).map((query) => query.replace("{doc}", term));
}

/** Case subjects that belong to areas of law the document is not about. */
const OFF_DOMAIN_CASE: Array<{ domain: LawDomain | "tax" | "criminal"; pattern: RegExp }> = [
  { domain: "labor", pattern: /해고|근로|임금|퇴직금|부당노동|징계|산업재해|노동/u },
  { domain: "lease", pattern: /임대차|임차|임대인|건물\s*(?:인도|명도)|토지\s*인도|명도|보증금|차임/u },
  { domain: "consumer", pattern: /청약\s*철회|소비자\s*분쟁|방문판매|할부거래/u },
  // Never a contract-review area: tax rulings and criminal cases share contract words by accident.
  { domain: "tax", pattern: /부가가치세|과세|세무서|영세율|소득세|법인세|체납|국세|기타소득|익금|손금/u },
  // "…법위반" alone is not excluded: 개인정보보호법위반 holdings define in-scope statutes.
  { domain: "criminal", pattern: /사기(?:\b|$|·)|횡령|배임|특정경제범죄|공직선거|정치자금/u },
];

export function offDomain(text: string, profile: DocumentProfile): string | undefined {
  return OFF_DOMAIN_CASE.find((entry) => !(profile.domains as string[]).includes(entry.domain) && entry.pattern.test(text))?.domain;
}

/** First gate, on search metadata only: the case subject must not belong to an excluded area. */
export function passesMetadataGate(entry: { title?: string; summary?: string }, profile: DocumentProfile): boolean {
  const text = `${entry.title ?? ""} ${entry.summary ?? ""}`;
  return Boolean(text.trim()) && !offDomain(text, profile);
}

/**
 * Second gate, on the fetched 판시사항: the holding must itself address the
 * clause's issue, and not be mainly about an excluded area of law. Returns
 * the holding sentence that shows the relevance, or undefined.
 */
export function holdingRelevance(holding: string, issue: IssueDefinition, profile: DocumentProfile): string | undefined {
  if (!issue.holdingTerms || !holding.trim()) return undefined;
  const parts = holding.split(/\s*(?=[\[［]\d+[\]］])|\s*\/\s*|(?<=[.다])\s+|\n+/u).map((part) => part.trim()).filter(Boolean);
  return parts.find((part) => issue.holdingTerms!.test(part) && !issue.holdingExclude?.test(part)
    && !FOREIGN_OR_SPECIAL_REGIME.test(part) && !offDomain(part, profile));
}

/** Holdings decided under foreign law, treaties or special transport regimes answer a different question. */
const FOREIGN_OR_SPECIAL_REGIME = /영국법|미국법|외국법|준거법|바르샤바|몬트리올|국제\s*재판\s*관할|해상운송|운송인|실화책임/u;

export function issueDefinition(id: string): IssueDefinition | undefined {
  return ISSUES.find((issue) => issue.id === id);
}
