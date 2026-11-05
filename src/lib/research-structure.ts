import { directConditionsSupported, relationshipSupported } from "./research-relevance";

/**
 * Structural adoption (DESIGN §3·§4). The model only writes comparison records;
 * the server checks every span/quote, enum and reference, adds machine signals,
 * and a first-match decision table assigns one of five states per
 * (issue, candidate). Pure functions: no I/O, no model calls.
 *
 * Shadow mode (§5-1 ①) computes these states next to the existing gates and
 * records the differences only; nothing here changes an operational result.
 */

export const ASK_KINDS = ["의무", "권리", "요건", "절차", "구제", "제재"] as const;
export const EFFECT_TYPES = ["duty", "right", "prohibition", "power", "requirement", "definition", "procedure",
  "remedy_program", "penalty", "purpose", "delegation"] as const;
export const POLARITIES = ["affirmed", "denied", "asked"] as const;
export const PARTY_MATCH = ["same", "compatible", "different", "unknown"] as const;
export const ACT_MATCH = ["same", "directly_related", "different", "unknown"] as const;
export const REQUIREMENT_MATCH = ["satisfied", "unconfirmed", "conflicting"] as const;
/** `not_compared`: the complete original was shown but the model left the pair without any record (neither comparison nor screen). */
export const S5_REASONS = ["fetch_failed", "timeout", "partial", "out_of_budget", "window_incomplete", "verifier_unavailable", "malformed", "not_compared"] as const;
/** Why a screened pair is plainly out of scope: different party, act, unaddressed ask, or a requirement the facts contradict. */
export const SCREEN_BASES = ["party", "act", "ask", "requirement"] as const;
export type ScreenBasis = (typeof SCREEN_BASES)[number];

export type AskKind = (typeof ASK_KINDS)[number];
export type EffectType = (typeof EFFECT_TYPES)[number];
export type Polarity = (typeof POLARITIES)[number];
export type S5Reason = (typeof S5_REASONS)[number];

/** S1 direct / S2 supporting / S3 needs_condition / S4 not_relevant / S5 unverified. */
export type StructureState = "direct" | "supporting" | "needs_condition" | "not_relevant" | "unverified";

export interface FactFrame {
  parties: Array<{ id: string; role: string; span: string }>;
  relation: { type: string; span: string } | null;
  acts: Array<{ id: string; actor: string; act: string; polarity: Polarity; span: string }>;
  conditions: Array<{ id: string; kind: string; value: string; polarity: Polarity; span: string }>;
  asks: Array<{ id: string; kind: AskKind; span: string }>;
}

export interface ProvisionProfile {
  candidateId: string;
  /** Descriptive only (not a decision-table input; A carries its own verified quote). */
  regulatedParties: Array<{ role: string; quote: string }>;
  /** Descriptive only (not a decision-table input; B carries its own verified quote). */
  regulatedAct: { act: string; quote: string } | null;
  effectType: EffectType;
  /** Applicability conditions only (facts the provision needs), never the provision's own effect. */
  requirements: Array<{ id: string; text: string; quote: string }>;
  /** Descriptive fields whose quote was not in the original and were dropped (recorded as info signals). */
  dropped?: Array<"regulatedParties" | "regulatedAct">;
}

export interface StructureComparison {
  issueIndex: number;
  candidateId: string;
  A: { value: (typeof PARTY_MATCH)[number]; factPartyIds: string[]; quote: string };
  B: { value: (typeof ACT_MATCH)[number]; factActIds: string[]; quote: string };
  C: { addressesAsk: boolean; askId: string | null; effectType: EffectType };
  D: Array<{ reqId: string; value: (typeof REQUIREMENT_MATCH)[number]; factIds: string[]; general?: boolean }>;
}

/** Model-facing JSON schema additions; the server re-validates everything below. */
export const FACT_FRAME_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    parties: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false,
      properties: { id: { type: "string" }, role: { type: "string" }, span: { type: "string" } }, required: ["id", "role", "span"] } },
    relation: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false,
      properties: { type: { type: "string" }, span: { type: "string" } }, required: ["type", "span"] }] },
    acts: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false,
      properties: { id: { type: "string" }, actor: { type: "string" }, act: { type: "string" },
        polarity: { type: "string", enum: POLARITIES }, span: { type: "string" } },
      required: ["id", "actor", "act", "polarity", "span"] } },
    conditions: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false,
      properties: { id: { type: "string" }, kind: { type: "string" }, value: { type: "string" },
        polarity: { type: "string", enum: POLARITIES }, span: { type: "string" } },
      required: ["id", "kind", "value", "polarity", "span"] } },
    asks: { type: "array", maxItems: 5, items: { type: "object", additionalProperties: false,
      properties: { id: { type: "string" }, kind: { type: "string", enum: ASK_KINDS }, span: { type: "string" } },
      required: ["id", "kind", "span"] } },
  },
  required: ["parties", "relation", "acts", "conditions", "asks"],
} as const;

const quoted = { type: "string" } as const;
export const ADOPTION_STRUCTURE_JSON_SCHEMA = {
  profiles: { type: "array", maxItems: 40, items: { type: "object", additionalProperties: false,
    properties: {
      candidateId: { type: "string" },
      regulatedParties: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false,
        properties: { role: { type: "string" }, quote: quoted }, required: ["role", "quote"] } },
      regulatedAct: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false,
        properties: { act: { type: "string" }, quote: quoted }, required: ["act", "quote"] }] },
      effectType: { type: "string", enum: EFFECT_TYPES },
      requirements: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false,
        properties: { id: { type: "string" }, text: { type: "string" }, quote: quoted }, required: ["id", "text", "quote"] } },
    },
    required: ["candidateId", "regulatedParties", "regulatedAct", "effectType", "requirements"] } },
  comparisons: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false,
    properties: {
      issueIndex: { type: "integer" }, candidateId: { type: "string" },
      A: { type: "object", additionalProperties: false, properties: { value: { type: "string", enum: PARTY_MATCH },
        factPartyIds: { type: "array", items: { type: "string" } }, quote: quoted }, required: ["value", "factPartyIds", "quote"] },
      B: { type: "object", additionalProperties: false, properties: { value: { type: "string", enum: ACT_MATCH },
        factActIds: { type: "array", items: { type: "string" } }, quote: quoted }, required: ["value", "factActIds", "quote"] },
      C: { type: "object", additionalProperties: false, properties: { addressesAsk: { type: "boolean" },
        askId: { type: ["string", "null"] }, effectType: { type: "string", enum: EFFECT_TYPES } }, required: ["addressesAsk", "askId", "effectType"] },
      D: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false,
        properties: { reqId: { type: "string" }, value: { type: "string", enum: REQUIREMENT_MATCH },
          factIds: { type: "array", items: { type: "string" } }, general: { type: "boolean" } },
        required: ["reqId", "value", "factIds", "general"] } },
    },
    required: ["issueIndex", "candidateId", "A", "B", "C", "D"] } },
  // Compact negative record: one row per candidate, the issues it is plainly out of scope for, and why.
  screens: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false,
    properties: { candidateId: { type: "string" }, issueIndexes: { type: "array", items: { type: "integer" } },
      basis: { type: "string", enum: SCREEN_BASES } },
    required: ["candidateId", "issueIndexes", "basis"] } },
} as const;

export const FACT_FRAME_INSTRUCTION = "factFrame에는 사용자 원문에서 확인되는 당사자(parties: id p1…, 역할), 당사자 관계(relation, 없으면 null), 행위(acts: id a1…, 행위자 id 또는 역할, polarity는 실제로 있었으면 affirmed·없었다고 했으면 denied·묻기만 했으면 asked), 조건(conditions: id k1…, 기간·금액·횟수·재직/퇴직·국가/지방 등), 질문 유형(asks: id q1…, 의무|권리|요건|절차|구제|제재)을 적으세요. 사용자가 쓴 당사자 표현(회사·직원·거래처·기관 등)은 parties에, 질문이 전제로 삼는 행위(예: '해지하려면', '돌려받을 수 있나요')도 acts에 polarity asked로 적으세요. 모든 span은 사용자 원문을 한 글자도 바꾸지 않은 실제 부분 문자열이어야 하며, 원문에 없는 사실은 적지 마세요.";

/**
 * Shadow-only addition to the single adoption call. Examples deliberately use
 * provisions outside the §6 question set (lease), so the prompt is not tuned to
 * the private answer key.
 */
export const ADOPTION_STRUCTURE_INSTRUCTION = [
  // Record duty (cause 2: an omitted pair is no longer read as "not relevant").
  "기록 의무: selections에 넣은 모든 (issueIndex, candidateId) 쌍은 comparisons에 반드시 기록하세요. window가 없고 partial=false인 나머지 후보도 쟁점마다 comparisons 또는 screens 중 한 곳에 반드시 기록하세요(생략 금지). screens는 당사자(party)·행위(act)·질문 유형(ask)이 분명히 다르거나 사용자 사실과 양립할 수 없는 요건(requirement)이 있는 후보를 후보당 한 줄 {candidateId, issueIndexes, basis}로 적습니다. 애매하면 screens가 아니라 comparisons에 unknown으로 적으세요.",
  "profiles에는 comparisons에 적은 후보마다 한 건(같은 후보를 여러 쟁점과 비교해도 한 건)씩 수범자(regulatedParties), 규율 행위(regulatedAct), 효과 유형(effectType), 적용 요건(requirements: id r1…)을 적으세요.",
  // Verbatim quotes (cause 3).
  "모든 quote는 그 candidateId의 candidate.text에서 그대로 복사한 연속 구간입니다. 조사·어미·숫자·괄호·기호까지 원문 그대로 쓰고, 요약·바꿔 쓰기·생략부호·떨어진 구간 이어 붙이기를 하지 말며, 사용자 원문·factFrame·issue·다른 후보의 표현을 쓰지 마세요. 한 구절(80자 이내)로 짧게 인용하세요. 예: 원문 '임차인은 임대차가 종료한 때에는 목적물을 반환하여야 한다'라면 regulatedParties는 [{role:'임차인', quote:'임차인은'}]입니다. 조문에 수범자가 쓰여 있지 않으면 regulatedParties는 빈 배열, 규율 행위 문구가 없으면 regulatedAct는 null입니다.",
  // Requirement = applicability condition, not the provision's effect (cause 4).
  "requirements에는 그 조문이 적용되기 위해 사실로 갖춰져야 하는 조건만 적습니다: 조문이 전제로 삼는 당사자·행위·상황('…한 때', '…한 경우', '…로 인하여'), 예: '임대차가 종료한 때'. 조문 자체가 정하는 효과—의무·권리·금지의 내용, 기한·금액·횟수·이자·방법(예: '목적물을 반환하여야 한다', '1개월 이내에 지급하여야 한다')—는 requirements가 아니며 effectType과 C로 나타냅니다. 전제 조건 없이 적용되는 조문은 requirements를 빈 배열로 두세요. requirement quote는 그 조건 구절만 인용하세요.",
  "comparisons에는 쟁점×후보마다 A(당사자: same|compatible|different|unknown, 대응 factFrame party id), B(행위: same|directly_related|different|unknown, 대응 act id), C(질문 유형 대응 여부와 ask id, effectType), D를 적으세요. B=same은 조문이 사용자가 말한 바로 그 행위나 그 행위의 불이행(예: 보증금 미반환 ↔ 보증금 반환 의무)을 규율할 때, directly_related는 그 앞뒤의 부수 행위(신청·확인·통지 등)를 규율할 때입니다. A·B의 quote도 candidate.text 그대로이며 unknown일 때만 빈 문자열을 씁니다.",
  "D는 같은 candidateId의 profiles requirements id만 써서 요건마다 한 행입니다. satisfied는 그 조건을 진술한 factFrame 사실 id(질문이 전제로 묻는 행위는 polarity asked 사실)가 있을 때, conflicting은 사실이 그 조건과 양립할 수 없을 때만 씁니다(예: 임대차가 계속 중이라는 사실 ↔ '임대차가 종료한 때'). 사실이 조건을 뒷받침하면 conflicting이 아닙니다. 확인할 사실이 없으면 unconfirmed이고, 손해 발생·고의과실처럼 그 조문의 일반 성립요건은 general=true입니다.",
  "판정 결론을 쓰지 말고 비교만 기록하세요. 확인되지 않으면 unknown·unconfirmed로 두고 fact id 없이 satisfied·conflicting을 쓰지 마세요.",
].join(" ");

const compact = (text: string) => text.replace(/\s+/gu, "");
const contains = (haystack: string, needle: string) => {
  const target = compact(needle);
  return target.length > 0 && compact(haystack).includes(target);
};
const isString = (value: unknown): value is string => typeof value === "string";
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every(isString) ? value : undefined;
const member = <T extends string>(values: readonly T[], value: unknown): value is T => isString(value) && (values as readonly string[]).includes(value);

/**
 * Keep only FactFrame items whose span is an actual substring of the original
 * (whitespace-insensitive, the same rule as quote checks) and whose enums and
 * ids are valid. Invalid items are dropped, never repaired.
 */
export function validateFactFrame(original: string, raw: unknown): { frame?: FactFrame; dropped: number } {
  const input = record(raw);
  if (!input) return { dropped: 0 };
  let dropped = 0;
  const ids = new Set<string>();
  const keep = <T>(items: unknown, check: (item: Record<string, unknown>) => T | undefined): T[] => {
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      const value = record(item);
      const kept = value ? check(value) : undefined;
      if (!kept) { dropped += 1; return []; }
      return [kept];
    });
  };
  const fresh = (id: unknown) => isString(id) && id.trim() && !ids.has(id) ? (ids.add(id), id) : undefined;
  const span = (value: unknown) => isString(value) && contains(original, value) ? value : undefined;
  const parties = keep(input.parties, (item) => {
    if (!span(item.span) || !isString(item.role) || !item.role.trim()) return undefined;
    const id = fresh(item.id);
    return id ? { id, role: item.role, span: item.span as string } : undefined;
  });
  const acts = keep(input.acts, (item) => {
    if (!span(item.span) || !isString(item.act) || !isString(item.actor) || !member(POLARITIES, item.polarity)) return undefined;
    const id = fresh(item.id);
    return id ? { id, actor: item.actor, act: item.act, polarity: item.polarity, span: item.span as string } : undefined;
  });
  const conditions = keep(input.conditions, (item) => {
    if (!span(item.span) || !isString(item.kind) || !isString(item.value) || !member(POLARITIES, item.polarity)) return undefined;
    const id = fresh(item.id);
    return id ? { id, kind: item.kind, value: item.value, polarity: item.polarity, span: item.span as string } : undefined;
  });
  const asks = keep(input.asks, (item) => {
    if (!span(item.span) || !member(ASK_KINDS, item.kind)) return undefined;
    const id = fresh(item.id);
    return id ? { id, kind: item.kind, span: item.span as string } : undefined;
  });
  const relationInput = record(input.relation);
  let relation: FactFrame["relation"] = null;
  if (relationInput) {
    if (isString(relationInput.type) && span(relationInput.span)) relation = { type: relationInput.type, span: relationInput.span as string };
    else dropped += 1;
  }
  return { frame: { parties, relation, acts, conditions, asks }, dropped };
}

export interface StructureCandidate {
  id: string;
  kind: "article" | "precedent" | "decision";
  law?: string;
  title?: string;
  /** Complete obtained original. */
  text: string;
  /** Model-visible text (equals `text` unless a window was applied). */
  visibleText: string;
  partial?: boolean;
  window?: { start: number; end: number; total: number };
}

export type ValidatedStructure = {
  profiles: Map<string, ProvisionProfile>;
  /** Keyed `${issueIndex}\0${candidateId}`; `"malformed"` marks a pair whose record failed a format check. */
  comparisons: Map<string, StructureComparison | { malformed: string }>;
  /** Keyed like comparisons: the model's explicit "plainly out of scope" record for a pair. */
  screens: Map<string, ScreenBasis>;
};

/**
 * Format checks (decision rule ③): a quote must exist in the model-visible
 * original, enums must be valid, ids must resolve. A failing profile or
 * comparison marks only its own pairs malformed; a wholly unusable payload
 * returns undefined (the caller treats it as verifier_unavailable/malformed).
 *
 * regulatedParties/regulatedAct are descriptive: no decision-table rule reads
 * them (A and B carry their own quotes, which stay strict). An item whose quote
 * is not in the original is dropped and recorded, not allowed to void the
 * pair (§6: 28 of 41 malformed pairs failed only here). Requirement quotes stay
 * strict: dropping a requirement could hide an unconfirmed condition.
 */
export function validateAdoptionStructure(raw: unknown, frame: FactFrame | undefined, candidates: ReadonlyMap<string, StructureCandidate>,
  issueCount: number): ValidatedStructure | undefined {
  const input = record(raw);
  if (!input || !Array.isArray(input.profiles) || !Array.isArray(input.comparisons)) return undefined;
  const profiles = new Map<string, ProvisionProfile>();
  const badProfiles = new Map<string, string>();
  for (const entry of input.profiles) {
    const item = record(entry);
    const candidate = item && isString(item.candidateId) ? candidates.get(item.candidateId) : undefined;
    if (!item || !candidate) continue;
    const fail = (why: string) => { badProfiles.set(candidate.id, why); };
    if (!Array.isArray(item.regulatedParties)) { fail("profile.regulatedParties"); continue; }
    if (item.regulatedAct !== null && !record(item.regulatedAct)) { fail("profile.regulatedAct"); continue; }
    const dropped: NonNullable<ProvisionProfile["dropped"]> = [];
    const parties = item.regulatedParties.map(record).filter((party): party is Record<string, unknown> & { role: string; quote: string } =>
      Boolean(party && isString(party.role) && isString(party.quote) && contains(candidate.visibleText, party.quote)));
    if (parties.length < item.regulatedParties.length) dropped.push("regulatedParties");
    let act = item.regulatedAct === null ? null : record(item.regulatedAct)!;
    if (act && (!isString(act.act) || !isString(act.quote) || !contains(candidate.visibleText, act.quote))) { act = null; dropped.push("regulatedAct"); }
    if (!member(EFFECT_TYPES, item.effectType)) { fail("profile.effectType"); continue; }
    const requirements = Array.isArray(item.requirements) ? item.requirements.map(record) : undefined;
    const reqIds = new Set<string>();
    if (!requirements || requirements.some((req) => !req || !isString(req.id) || !req.id.trim() || reqIds.has(req.id) || (reqIds.add(req.id), false)
      || !isString(req.text) || !isString(req.quote) || !contains(candidate.visibleText, req.quote))) { fail("profile.requirements"); continue; }
    profiles.set(candidate.id, {
      candidateId: candidate.id,
      regulatedParties: parties.map((party) => ({ role: party.role, quote: party.quote })),
      regulatedAct: act ? { act: act.act as string, quote: act.quote as string } : null,
      effectType: item.effectType,
      requirements: requirements.map((req) => ({ id: req!.id as string, text: req!.text as string, quote: req!.quote as string })),
      ...(dropped.length ? { dropped } : {}),
    });
  }
  // Screens are negative-only records: an invalid row is ignored (the pair then has no record → S5 not_compared).
  const screens: ValidatedStructure["screens"] = new Map();
  for (const entry of Array.isArray(input.screens) ? input.screens : []) {
    const item = record(entry);
    const candidate = item && isString(item.candidateId) ? candidates.get(item.candidateId) : undefined;
    if (!item || !candidate || !member(SCREEN_BASES, item.basis) || !Array.isArray(item.issueIndexes)) continue;
    for (const issueIndex of item.issueIndexes) {
      if (typeof issueIndex === "number" && Number.isInteger(issueIndex) && issueIndex >= 0 && issueIndex < issueCount) {
        screens.set(`${issueIndex}\0${candidate.id}`, item.basis);
      }
    }
  }
  const partyIds = new Set(frame?.parties.map((party) => party.id));
  const actIds = new Set(frame?.acts.map((act) => act.id));
  const factIds = new Set([...partyIds, ...actIds, ...(frame?.conditions.map((condition) => condition.id) ?? [])]);
  const askIds = new Set(frame?.asks.map((ask) => ask.id));
  const comparisons: ValidatedStructure["comparisons"] = new Map();
  for (const entry of input.comparisons) {
    const item = record(entry);
    if (!item || typeof item.issueIndex !== "number" || !Number.isInteger(item.issueIndex) || !isString(item.candidateId)) continue;
    const candidate = candidates.get(item.candidateId);
    if (!candidate || item.issueIndex < 0 || item.issueIndex >= issueCount) continue;
    const key = `${item.issueIndex}\0${candidate.id}`;
    const fail = (why: string) => { comparisons.set(key, { malformed: why }); };
    if (badProfiles.has(candidate.id)) { fail(badProfiles.get(candidate.id)!); continue; }
    const profile = profiles.get(candidate.id);
    if (!profile) { fail("profile.missing"); continue; }
    const a = record(item.A), b = record(item.B), c = record(item.C);
    const aIds = stringList(a?.factPartyIds), bIds = stringList(b?.factActIds);
    if (!a || !member(PARTY_MATCH, a.value) || !aIds || !isString(a.quote)) { fail("A.format"); continue; }
    if (aIds.some((id) => !partyIds.has(id))) { fail("A.factPartyIds"); continue; }
    if (a.value !== "unknown" && !contains(candidate.visibleText, a.quote)) { fail("A.quote"); continue; }
    if (!b || !member(ACT_MATCH, b.value) || !bIds || !isString(b.quote)) { fail("B.format"); continue; }
    if (bIds.some((id) => !actIds.has(id))) { fail("B.factActIds"); continue; }
    if (b.value !== "unknown" && !contains(candidate.visibleText, b.quote)) { fail("B.quote"); continue; }
    if (!c || typeof c.addressesAsk !== "boolean" || !(c.askId === null || isString(c.askId)) || !member(EFFECT_TYPES, c.effectType)) { fail("C.format"); continue; }
    if (isString(c.askId) && !askIds.has(c.askId)) { fail("C.askId"); continue; }
    if (!Array.isArray(item.D)) { fail("D.format"); continue; }
    const requirements = new Set(profile.requirements.map((req) => req.id));
    const d: StructureComparison["D"] = [];
    let bad: string | undefined;
    for (const row of item.D.map(record)) {
      const ids = stringList(row?.factIds);
      if (!row || !isString(row.reqId) || !member(REQUIREMENT_MATCH, row.value) || !ids) { bad = "D.format"; break; }
      if (!requirements.has(row.reqId)) { bad = "D.reqId"; break; }
      if (ids.some((id) => !factIds.has(id))) { bad = "D.factIds"; break; }
      d.push({ reqId: row.reqId, value: row.value, factIds: ids, ...(row.general === true ? { general: true } : {}) });
    }
    if (bad) { fail(bad); continue; }
    comparisons.set(key, {
      issueIndex: item.issueIndex, candidateId: candidate.id,
      A: { value: a.value, factPartyIds: aIds, quote: a.quote },
      B: { value: b.value, factActIds: bIds, quote: b.quote },
      C: { addressesAsk: c.addressesAsk, askId: isString(c.askId) ? c.askId : null, effectType: c.effectType },
      D: d,
    });
  }
  return { profiles, comparisons, screens };
}

/** E (official source) inputs, all server-owned. */
export interface EvidenceCheck {
  /** Candidate original was obtained and complete; the model saw all of it. */
  verification: "verified" | "unavailable" | "malformed";
  /** Model-visible set; undefined when the verifier was not reached. */
  shown: boolean;
  currency?: "current" | "upcoming" | "not_current" | "unconfirmed";
}

const NON_OPERATIVE_EFFECTS: ReadonlySet<EffectType> = new Set(["definition", "procedure", "remedy_program", "purpose", "delegation"]);
const CORE_EFFECTS: ReadonlySet<EffectType> = new Set(["duty", "right", "prohibition", "power", "requirement", "penalty"]);
const OPERATIVE_WORDING = /하여야|해야|해서는아니|하여서는아니|할수있다|할수없다|지급한다|금지|아니된다|처한다|부과한다|명할수|의무가있다|의무를진다/u;
const DEFINITION_WORDING = /용어의뜻|이란[^。\n]{0,120}(?:말한다|뜻한다)|"[^"]{1,30}"란/u;
const NUMERIC = /\d|[일이삼사오육칠팔구십백]+\s*(?:년|개월|일|배|회|퍼센트)/u;

/** Does the referenced ask actually ask for this non-operative effect (rule ⑥ exception)? */
export function askCoversEffect(effect: EffectType, ask: FactFrame["asks"][number] | undefined): boolean {
  if (!ask) return false;
  const span = compact(ask.span);
  switch (effect) {
    case "procedure": return ask.kind === "절차" || /절차|방법|신청|신고|통지|의견/u.test(span);
    case "remedy_program": return ask.kind === "구제" || /구제|대지급|체당|융자|확인서|지원/u.test(span);
    case "definition": return /정의|뜻|의미|범위|해당/u.test(span);
    case "purpose": return /목적|취지/u.test(span);
    case "delegation": return /위임|시행령|시행규칙|하위/u.test(span);
    default: return true;
  }
}

export interface StructureDecision {
  state: StructureState;
  subReason?: S5Reason;
  /** First decision-table rule that matched (1–8). */
  rule: number;
  signals: string[];
  /** Core requirements left unconfirmed (S3 follow-up material). */
  unconfirmed: string[];
}

/**
 * Decision table, first match (DESIGN §4.2):
 * ① E fails → S5 ② no comparison ∧ complete original delivered → S4 if the
 * model screened the pair out, otherwise S5 not_compared (an omission is not a
 * negative judgement) ③ format error → S5 malformed
 * ④ A/B different ∨ ¬addressesAsk ∨ D conflicting → S4
 * ⑤ A/B unknown ∨ machine contradiction ∨ core requirement unconfirmed → S3
 * ⑥ non-operative effect not asked for → S2 ⑦ B directly_related without a confirmed core duty → S2 ⑧ S1.
 * `info.` signals are descriptive notes and never count as contradictions.
 */
export function decideStructure(input: {
  candidate: StructureCandidate;
  evidence: EvidenceCheck;
  comparison?: StructureComparison | { malformed: string };
  /** Explicit negative record for the pair (screens). Ignored when a comparison exists. */
  screen?: ScreenBasis;
  profile?: ProvisionProfile;
  frame?: FactFrame;
  originalQuery: string;
}): StructureDecision {
  const { candidate, evidence, comparison, screen, profile, frame, originalQuery } = input;
  const s5 = (subReason: S5Reason, rule: number, signals: string[] = []): StructureDecision => ({ state: "unverified", subReason, rule, signals, unconfirmed: [] });
  // ① E: official, complete, model-visible original; a failed verifier call is an E failure.
  if (evidence.verification === "unavailable") return s5("verifier_unavailable", 1);
  if (candidate.partial) return s5("partial", 1);
  if (!evidence.shown) return s5("out_of_budget", 1);
  if (candidate.window && (candidate.window.start > 0 || candidate.window.end < candidate.window.total)) return s5("window_incomplete", 1);
  // A structurally unusable payload (selections still parsed) is a format failure of every pair.
  if (evidence.verification === "malformed") return s5("malformed", 3, ["payload"]);
  // ② The model saw the whole original and wrote no comparison: S4 only on its explicit screen.
  if (!comparison) return screen ? { state: "not_relevant", rule: 2, signals: [`screen.${screen}`], unconfirmed: [] } : s5("not_compared", 2);
  // ③ Format.
  if ("malformed" in comparison) return s5("malformed", 3, [comparison.malformed]);
  if (!profile) return s5("malformed", 3, ["profile.missing"]);

  const signals: string[] = (profile.dropped ?? []).map((field) => `info.profile.${field}_dropped`);
  const acts = new Map(frame?.acts.map((act) => [act.id, act]));
  const conditions = new Map(frame?.conditions.map((condition) => [condition.id, condition]));
  const spanOf = (id: string) => acts.get(id)?.span ?? conditions.get(id)?.span ?? frame?.parties.find((party) => party.id === id)?.span ?? "";
  const denied = (id: string) => acts.get(id)?.polarity === "denied" || conditions.get(id)?.polarity === "denied";
  const requirementText = new Map(profile.requirements.map((req) => [req.id, req]));
  // D machine checks: satisfied/conflicting need fact ids; numeric requirements need a numeric fact; denied facts cannot satisfy.
  const requirements = comparison.D.map((row) => {
    let value = row.value;
    if ((value === "satisfied" || value === "conflicting") && !row.factIds.length) { value = "unconfirmed"; signals.push(`D.${row.reqId}.no_fact`); }
    const req = requirementText.get(row.reqId);
    if (value === "satisfied" && req && NUMERIC.test(`${req.text}${req.quote}`) && !row.factIds.some((id) => NUMERIC.test(spanOf(id)))) {
      value = "unconfirmed"; signals.push(`D.${row.reqId}.numeric_unverified`);
    }
    if (value === "satisfied" && row.factIds.some(denied)) { value = "unconfirmed"; signals.push(`D.${row.reqId}.denied_fact`); }
    return { ...row, value };
  });
  // Requirements the profile lists but the comparison never addressed stay unconfirmed.
  for (const req of profile.requirements) {
    if (!requirements.some((row) => row.reqId === req.id)) requirements.push({ reqId: req.id, value: "unconfirmed", factIds: [] });
  }
  // ④ Clear mismatch.
  if (comparison.A.value === "different" || comparison.B.value === "different" || !comparison.C.addressesAsk
    || requirements.some((row) => row.value === "conflicting")) {
    return { state: "not_relevant", rule: 4, signals, unconfirmed: [] };
  }
  // Machine contradiction signals.
  const fullScope = `${candidate.law ?? ""} ${candidate.text}`;
  if (!relationshipSupported(fullScope, originalQuery)) signals.push("A.regime_marker");
  if (!frame?.relation && /국가를\s*당사자로|지방자치단체를\s*당사자로|공기업|준정부기관|조달청/u.test(candidate.text)) signals.push("A.relation_missing_special_regime");
  if (!directConditionsSupported(fullScope, originalQuery)) signals.push("D.aggravated_condition");
  if (comparison.B.value !== "unknown" && comparison.B.factActIds.some((id) => acts.get(id)?.polarity === "denied")) signals.push("B.denied_act");
  if (comparison.C.effectType !== profile.effectType) signals.push("C.effect_mismatch");
  const body = compact(candidate.text);
  const definitionText = DEFINITION_WORDING.test(body) && !OPERATIVE_WORDING.test(body);
  if ((profile.effectType === "duty" || profile.effectType === "prohibition") && (definitionText || !OPERATIVE_WORDING.test(body))) signals.push("C.duty_wording_absent");
  if (profile.effectType === "definition" && !DEFINITION_WORDING.test(body)) signals.push("C.definition_wording_absent");
  if (candidate.kind === "article" && candidate.title?.replace(/\s+/gu, "") === "목적" && profile.effectType !== "purpose") signals.push("C.purpose_title");
  const unconfirmed = requirements.filter((row) => row.value === "unconfirmed" && !row.general)
    .map((row) => requirementText.get(row.reqId)?.text.trim() || row.reqId);
  // ⑤ Not confirmable from the user's facts.
  const contradiction = (signal: string) => !signal.startsWith("info.") && (!signal.startsWith("D.") || /aggravated/u.test(signal));
  if (comparison.A.value === "unknown" || comparison.B.value === "unknown" || signals.some(contradiction) || unconfirmed.length) {
    return { state: "needs_condition", rule: 5, signals, unconfirmed };
  }
  if (evidence.currency === "not_current") return { state: "needs_condition", rule: 5, signals: [...signals, "E.not_current"], unconfirmed };
  // ⑥ Non-operative effect the question does not ask about.
  const ask = frame?.asks.find((entry) => entry.id === comparison.C.askId);
  if (NON_OPERATIVE_EFFECTS.has(profile.effectType) && !askCoversEffect(profile.effectType, ask)) {
    return { state: "supporting", rule: 6, signals, unconfirmed: [] };
  }
  // ⑦ Related act without a confirmed core duty.
  const coreConfirmed = CORE_EFFECTS.has(profile.effectType) && requirements.some((row) => row.value === "satisfied" && !row.general);
  if (comparison.B.value === "directly_related" && !coreConfirmed) return { state: "supporting", rule: 7, signals, unconfirmed: [] };
  // ⑧
  return { state: "direct", rule: 8, signals, unconfirmed: [] };
}

/** S3 follow-up: ask only for the unconfirmed facts, never a generic "자세히". */
export function structureFollowUp(unconfirmed: readonly string[]): string | undefined {
  const items = [...new Set(unconfirmed.map((item) => item.trim()).filter(Boolean))].slice(0, 3);
  return items.length ? `다음 적용 요건에 해당하는 사실을 알려주면 다시 확인할 수 있습니다: ${items.join(", ")}.` : undefined;
}

export type ShadowIssueStatus = "found" | "needs_confirmation" | "none" | "failed" | "timeout" | "unverified";

/**
 * Issue state from its (issue, candidate) decisions (§4.3·§4.5). Only S1 or a
 * complete user-named identity makes `found`; S3 → needs_confirmation; S5-only
 * issues are failed/timeout/unverified, never none.
 */
export function structureIssueStatus(decisions: ReadonlyArray<{ state: StructureState; subReason?: S5Reason; identity?: boolean; unconfirmed: string[] }>,
  lookup: "found" | "none" | "failed" | "timeout" | undefined): { status: ShadowIssueStatus; unconfirmed: string[] } {
  if (decisions.some((decision) => decision.state === "direct" || decision.identity)) return { status: "found", unconfirmed: [] };
  const conditional = decisions.filter((decision) => decision.state === "needs_condition");
  if (conditional.length) return { status: "needs_confirmation", unconfirmed: [...new Set(conditional.flatMap((decision) => decision.unconfirmed))] };
  if (decisions.some((decision) => decision.state === "supporting")) return { status: "none", unconfirmed: [] };
  if (lookup === "failed" || lookup === "timeout") return { status: lookup, unconfirmed: [] };
  const unverified = decisions.filter((decision) => decision.state === "unverified");
  if (unverified.length && !decisions.some((decision) => decision.state === "not_relevant")) {
    return { status: unverified.some((decision) => decision.subReason === "timeout") ? "timeout"
      : unverified.every((decision) => decision.subReason === "fetch_failed") ? "failed" : "unverified", unconfirmed: [] };
  }
  if (unverified.length) return { status: "unverified", unconfirmed: [] };
  return { status: "none", unconfirmed: [] };
}
