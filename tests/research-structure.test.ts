import { describe, expect, it } from "vitest";
import {
  askCoversEffect, decideStructure, structureFollowUp, structureIssueStatus, validateAdoptionStructure, validateFactFrame,
  type EvidenceCheck, type FactFrame, type ProvisionProfile, type StructureCandidate, type StructureComparison,
} from "@/lib/research-structure";

/**
 * Structural adoption (DESIGN §3·§4). Fixed inputs only: the comparison record a
 * model would write is given, so these tests pin the server's machine checks
 * and the first-match decision table, not model quality.
 */

const candidate = (text: string, extra: Partial<StructureCandidate> = {}): StructureCandidate =>
  ({ id: "c1", kind: "article", law: "민법", text, visibleText: text, ...extra });
const verified: EvidenceCheck = { verification: "verified", shown: true };
const profile = (effectType: ProvisionProfile["effectType"], requirements: ProvisionProfile["requirements"] = [], quote = ""): ProvisionProfile =>
  ({ candidateId: "c1", regulatedParties: [], regulatedAct: quote ? { act: "행위", quote } : null, effectType, requirements });
const compare = (over: Partial<StructureComparison> = {}): StructureComparison => ({
  issueIndex: 0, candidateId: "c1",
  A: { value: "same", factPartyIds: ["p1"], quote: "" },
  B: { value: "same", factActIds: ["a1"], quote: "" },
  C: { addressesAsk: true, askId: "q1", effectType: "duty" },
  D: [], ...over,
});
const frame = (over: Partial<FactFrame> = {}): FactFrame => ({
  parties: [{ id: "p1", role: "근로자", span: "직원" }],
  relation: { type: "근로관계", span: "직원" },
  acts: [{ id: "a1", actor: "p1", act: "임금 미지급", polarity: "affirmed", span: "임금을 못 받았" }],
  conditions: [], asks: [{ id: "q1", kind: "의무", span: "지급해야 하는지" }], ...over,
});
const decide = (text: string, comparison: StructureComparison | { malformed: string } | undefined, prof: ProvisionProfile | undefined,
  query: string, facts: FactFrame = frame(), extra: Partial<StructureCandidate> = {}, evidence = verified) =>
  decideStructure({ candidate: candidate(text, extra), evidence, comparison, profile: prof, frame: facts, originalQuery: query });

describe("FactFrame server checks", () => {
  const original = "직원이 퇴사한 뒤 마지막 달 임금을 못 받았습니다. 언제까지 지급해야 하는지 궁금합니다.";
  it("keeps only spans that are actual substrings and valid enums, dropping the rest", () => {
    const { frame: kept, dropped } = validateFactFrame(original, {
      parties: [{ id: "p1", role: "근로자", span: "직원" }, { id: "p2", role: "사용자", span: "대표이사" }],
      relation: { type: "근로관계", span: "직원" },
      acts: [{ id: "a1", actor: "p1", act: "퇴사", polarity: "affirmed", span: "퇴사한 뒤" },
        { id: "a2", actor: "p1", act: "해고", polarity: "maybe", span: "퇴사한" },
        { id: "a1", actor: "p1", act: "중복", polarity: "affirmed", span: "임금" }],
      conditions: [{ id: "k1", kind: "기간", value: "마지막 달", polarity: "affirmed", span: "마지막  달" }],
      asks: [{ id: "q1", kind: "의무", span: "언제까지 지급해야" }, { id: "q2", kind: "정의", span: "임금" }],
    });
    expect(kept?.parties.map((party) => party.id)).toEqual(["p1"]);
    expect(kept?.acts.map((act) => act.id)).toEqual(["a1"]);
    // Whitespace-insensitive like the existing quote check.
    expect(kept?.conditions.map((condition) => condition.id)).toEqual(["k1"]);
    expect(kept?.asks.map((ask) => ask.id)).toEqual(["q1"]);
    expect(kept?.relation).toEqual({ type: "근로관계", span: "직원" });
    expect(dropped).toBe(4);
  });
  it("returns no frame for a non-object payload", () => {
    expect(validateFactFrame(original, "x")).toEqual({ dropped: 0 });
    expect(validateFactFrame(original, null)).toEqual({ dropped: 0 });
  });
});

describe("comparison format checks (decision rule ③)", () => {
  const text = "임금은 통화로 직접 근로자에게 그 전액을 지급하여야 한다.";
  const candidates = new Map([["c1", candidate(text)]]);
  const good = { candidateId: "c1", regulatedParties: [{ role: "사용자", quote: "근로자에게" }],
    regulatedAct: { act: "임금 지급", quote: "전액을 지급하여야 한다" }, effectType: "duty",
    requirements: [{ id: "r1", text: "임금 채권", quote: "임금은 통화로" }] };
  const pair = { issueIndex: 0, candidateId: "c1", A: { value: "same", factPartyIds: ["p1"], quote: "근로자에게" },
    B: { value: "same", factActIds: ["a1"], quote: "전액을 지급하여야 한다" }, C: { addressesAsk: true, askId: "q1", effectType: "duty" },
    D: [{ reqId: "r1", value: "satisfied", factIds: ["a1"], general: false }] };
  it("accepts a record whose quotes, enums and ids all resolve", () => {
    const result = validateAdoptionStructure({ profiles: [good], comparisons: [pair] }, frame(), candidates, 1);
    expect(result?.comparisons.get("0\0c1")).toMatchObject({ A: { value: "same" }, D: [{ reqId: "r1", value: "satisfied" }] });
  });
  it.each([
    ["invented quote", { ...pair, B: { ...pair.B, quote: "임금을 지급하지 아니할 수 있다" } }, "B.quote"],
    ["unknown fact id", { ...pair, A: { ...pair.A, factPartyIds: ["p9"] } }, "A.factPartyIds"],
    ["enum violation", { ...pair, A: { ...pair.A, value: "similar" } }, "A.format"],
    ["unknown requirement", { ...pair, D: [{ reqId: "r9", value: "satisfied", factIds: ["a1"], general: false }] }, "D.reqId"],
    ["unknown ask", { ...pair, C: { ...pair.C, askId: "q9" } }, "C.askId"],
  ])("marks only the pair malformed for %s", (_name, comparison, why) => {
    const result = validateAdoptionStructure({ profiles: [good], comparisons: [comparison] }, frame(), candidates, 1);
    expect(result?.comparisons.get("0\0c1")).toEqual({ malformed: why });
  });
  it("marks pairs of a profile with an invented requirement quote malformed", () => {
    const bad = { ...good, requirements: [{ id: "r1", text: "x", quote: "원문에 없는 요건" }] };
    const result = validateAdoptionStructure({ profiles: [bad], comparisons: [pair] }, frame(), candidates, 1);
    expect(result?.comparisons.get("0\0c1")).toEqual({ malformed: "profile.requirements" });
  });
  // §6 fix round: descriptive fields no decision rule reads are dropped per item, not allowed to void the pair.
  it("drops an unquoted regulated party or act without voiding the pair, and records the drop", () => {
    const loose = { ...good, regulatedParties: [{ role: "사용자", quote: "회사는" }, { role: "근로자", quote: "근로자에게" }],
      regulatedAct: { act: "임금 지급", quote: "월급을 줘야 한다" } };
    const result = validateAdoptionStructure({ profiles: [loose], comparisons: [pair] }, frame(), candidates, 1);
    expect(result?.profiles.get("c1")).toMatchObject({ regulatedParties: [{ role: "근로자", quote: "근로자에게" }], regulatedAct: null,
      dropped: ["regulatedParties", "regulatedAct"] });
    expect(result?.comparisons.get("0\0c1")).toMatchObject({ A: { value: "same" } });
    // The drop is an info note, never a contradiction: the pair can still reach S1.
    const decision = decideStructure({ candidate: candidates.get("c1")!, evidence: verified, comparison: result!.comparisons.get("0\0c1") as StructureComparison,
      profile: result!.profiles.get("c1"), frame: frame(), originalQuery: "회사가 임금을 지급하지 않습니다" });
    expect(decision).toMatchObject({ state: "direct", signals: ["info.profile.regulatedParties_dropped", "info.profile.regulatedAct_dropped"] });
  });
  it("still rejects a structurally invalid descriptive field and keeps A/B quotes strict", () => {
    const notArray = { ...good, regulatedParties: "사용자" };
    expect(validateAdoptionStructure({ profiles: [notArray], comparisons: [pair] }, frame(), candidates, 1)?.comparisons.get("0\0c1"))
      .toEqual({ malformed: "profile.regulatedParties" });
    expect(validateAdoptionStructure({ profiles: [good], comparisons: [{ ...pair, A: { ...pair.A, quote: "회사는" } }] }, frame(), candidates, 1)
      ?.comparisons.get("0\0c1")).toEqual({ malformed: "A.quote" });
  });
  it("reads screens per issue and ignores invalid rows", () => {
    const two = new Map([["c1", candidate(text)], ["c2", candidate("다른 조문", { id: "c2" })]]);
    const result = validateAdoptionStructure({ profiles: [], comparisons: [], screens: [
      { candidateId: "c2", issueIndexes: [0, 1, 7], basis: "party" },
      { candidateId: "c1", issueIndexes: [0], basis: "similar" },
      { candidateId: "c9", issueIndexes: [0], basis: "act" },
    ] }, frame(), two, 2);
    expect([...result!.screens.entries()]).toEqual([["0\0c2", "party"], ["1\0c2", "party"]]);
    // A payload without screens is still usable (no screens → omitted pairs become not_compared).
    expect(validateAdoptionStructure({ profiles: [], comparisons: [] }, frame(), two, 2)?.screens.size).toBe(0);
  });
  it("rejects a wholly unusable payload and ignores unknown candidates or issue indexes", () => {
    expect(validateAdoptionStructure({ comparisons: [] }, frame(), candidates, 1)).toBeUndefined();
    const result = validateAdoptionStructure({ profiles: [good], comparisons: [{ ...pair, candidateId: "c9" }, { ...pair, issueIndex: 3 }] }, frame(), candidates, 1);
    expect(result?.comparisons.size).toBe(0);
  });
});

describe("decision table (first match)", () => {
  const duty = "임금은 통화로 직접 근로자에게 그 전액을 지급하여야 한다.";
  const query = "회사가 이번 달 임금을 못 받았는데 지급해야 하는지 궁금합니다";
  const req = [{ id: "r1", text: "근로자의 임금", quote: "근로자에게" }];
  const satisfied = [{ reqId: "r1", value: "satisfied" as const, factIds: ["a1"] }];
  it("① E failures are S5 with their sub-reason, before anything else", () => {
    expect(decide(duty, compare(), profile("duty"), query, frame(), {}, { verification: "unavailable", shown: true })).toMatchObject({ state: "unverified", subReason: "verifier_unavailable", rule: 1 });
    expect(decide(duty, compare(), profile("duty"), query, frame(), { partial: true })).toMatchObject({ state: "unverified", subReason: "partial", rule: 1 });
    expect(decide(duty, compare(), profile("duty"), query, frame(), {}, { verification: "verified", shown: false })).toMatchObject({ state: "unverified", subReason: "out_of_budget" });
    expect(decide(duty, compare(), profile("duty"), query, frame(), { window: { start: 10, end: 20, total: 40 } })).toMatchObject({ state: "unverified", subReason: "window_incomplete" });
  });
  // §6 fix round (DESIGN §4.2 ②): S4 needs the model's explicit screen; an omitted pair is S5
  // not_compared, so "not reviewed" can no longer read as "not relevant".
  it("② a fully delivered original is S4 only when screened out; without any record it is S5 not_compared", () => {
    expect(decideStructure({ candidate: candidate(duty), evidence: verified, screen: "party", frame: frame(), originalQuery: query }))
      .toMatchObject({ state: "not_relevant", rule: 2, signals: ["screen.party"] });
    expect(decide(duty, undefined, undefined, query)).toMatchObject({ state: "unverified", subReason: "not_compared", rule: 2 });
    // A comparison wins over a screen for the same pair.
    expect(decideStructure({ candidate: candidate(duty), evidence: verified, comparison: compare({ D: [] }), screen: "act",
      profile: profile("duty"), frame: frame(), originalQuery: query })).toMatchObject({ state: "direct", rule: 8 });
    // E still comes first: a screened but windowed original stays S5.
    expect(decideStructure({ candidate: candidate(duty, { window: { start: 5, end: 20, total: 40 } }), evidence: verified, screen: "party",
      frame: frame(), originalQuery: query })).toMatchObject({ state: "unverified", subReason: "window_incomplete", rule: 1 });
  });
  it("a not_compared-only issue is unverified, never none", () => {
    expect(structureIssueStatus([{ state: "unverified", subReason: "not_compared", unconfirmed: [] }], "none").status).toBe("unverified");
  });
  it("③ a malformed pair or payload is S5 malformed", () => {
    expect(decide(duty, { malformed: "B.quote" }, profile("duty"), query)).toMatchObject({ state: "unverified", subReason: "malformed", rule: 3 });
    expect(decide(duty, undefined, undefined, query, frame(), {}, { verification: "malformed", shown: true })).toMatchObject({ state: "unverified", subReason: "malformed", rule: 3 });
  });
  it("④ different party/act, an unaddressed ask or a conflicting requirement is S4", () => {
    expect(decide(duty, compare({ A: { value: "different", factPartyIds: [], quote: "" } }), profile("duty"), query)).toMatchObject({ state: "not_relevant", rule: 4 });
    expect(decide(duty, compare({ B: { value: "different", factActIds: [], quote: "" } }), profile("duty"), query)).toMatchObject({ state: "not_relevant", rule: 4 });
    expect(decide(duty, compare({ C: { addressesAsk: false, askId: null, effectType: "duty" } }), profile("duty"), query)).toMatchObject({ state: "not_relevant", rule: 4 });
    expect(decide(duty, compare({ D: [{ reqId: "r1", value: "conflicting", factIds: ["a1"] }] }), profile("duty", req), query)).toMatchObject({ state: "not_relevant", rule: 4 });
  });
  it("⑤ unknown, machine signals and unconfirmed core requirements are S3 with the list", () => {
    expect(decide(duty, compare({ A: { value: "unknown", factPartyIds: [], quote: "" } }), profile("duty"), query)).toMatchObject({ state: "needs_condition", rule: 5 });
    expect(decide(duty, compare({ D: [{ reqId: "r1", value: "unconfirmed", factIds: [] }] }), profile("duty", req), query))
      .toMatchObject({ state: "needs_condition", rule: 5, unconfirmed: ["근로자의 임금"] });
    // A requirement the comparison never addressed stays unconfirmed.
    expect(decide(duty, compare(), profile("duty", req), query)).toMatchObject({ state: "needs_condition", unconfirmed: ["근로자의 임금"] });
    // satisfied without fact ids is demoted, never trusted.
    expect(decide(duty, compare({ D: [{ reqId: "r1", value: "satisfied", factIds: [] }] }), profile("duty", req), query))
      .toMatchObject({ state: "needs_condition", signals: ["D.r1.no_fact"] });
    // C effect type must match the profile.
    expect(decide(duty, compare({ C: { addressesAsk: true, askId: "q1", effectType: "right" }, D: satisfied }), profile("duty", req), query))
      .toMatchObject({ state: "needs_condition", signals: ["C.effect_mismatch"] });
  });
  it("general requirements do not block S1", () => {
    expect(decide(duty, compare({ D: [...satisfied, { reqId: "r2", value: "unconfirmed", factIds: [], general: true }] }),
      profile("duty", [...req, { id: "r2", text: "손해 발생", quote: "전액을" }]), query)).toMatchObject({ state: "direct", rule: 8 });
  });
  it("⑥ a non-operative effect the question does not ask about is S2; asked, it can be S1", () => {
    const procedure = "체불 임금등ㆍ사업주 확인서를 발급받으려는 사람은 신청서를 제출해야 한다.";
    const c = compare({ C: { addressesAsk: true, askId: "q1", effectType: "procedure" } });
    expect(decide(procedure, c, profile("procedure"), query)).toMatchObject({ state: "supporting", rule: 6 });
    expect(decide(procedure, c, profile("procedure"), "확인서 발급 절차", frame({ asks: [{ id: "q1", kind: "절차", span: "발급 절차" }] }))).toMatchObject({ state: "direct" });
  });
  it("⑦ a directly related act without a confirmed core duty is S2", () => {
    expect(decide(duty, compare({ B: { value: "directly_related", factActIds: ["a1"], quote: "" } }), profile("duty"), query)).toMatchObject({ state: "supporting", rule: 7 });
    expect(decide(duty, compare({ B: { value: "directly_related", factActIds: ["a1"], quote: "" }, D: satisfied }), profile("duty", req), query)).toMatchObject({ state: "direct", rule: 8 });
  });
  it("⑧ everything else is S1", () => {
    expect(decide(duty, compare({ D: satisfied }), profile("duty", req), query)).toMatchObject({ state: "direct", rule: 8, signals: [] });
  });
  it("a not-current original is capped at S3", () => {
    expect(decideStructure({ candidate: candidate(duty), evidence: { ...verified, currency: "not_current" }, comparison: compare({ D: satisfied }),
      profile: profile("duty", req), frame: frame(), originalQuery: query })).toMatchObject({ state: "needs_condition", signals: ["E.not_current"] });
  });
});

describe("issue status and follow-up (§4.3·§4.5)", () => {
  it("only S1 or identity is found; S3 is needs_confirmation; S2 is not covered; S5-only is never none", () => {
    expect(structureIssueStatus([{ state: "direct", unconfirmed: [] }], "none").status).toBe("found");
    expect(structureIssueStatus([{ state: "not_relevant", identity: true, unconfirmed: [] }], "none").status).toBe("found");
    expect(structureIssueStatus([{ state: "needs_condition", unconfirmed: ["퇴직 여부"] }, { state: "supporting", unconfirmed: [] }], "none"))
      .toEqual({ status: "needs_confirmation", unconfirmed: ["퇴직 여부"] });
    expect(structureIssueStatus([{ state: "supporting", unconfirmed: [] }], "none").status).toBe("none");
    expect(structureIssueStatus([{ state: "unverified", subReason: "out_of_budget", unconfirmed: [] }], "none").status).toBe("unverified");
    expect(structureIssueStatus([{ state: "unverified", subReason: "timeout", unconfirmed: [] }], undefined).status).toBe("timeout");
    expect(structureIssueStatus([], "failed").status).toBe("failed");
    expect(structureIssueStatus([{ state: "not_relevant", unconfirmed: [] }], "none").status).toBe("none");
  });
  it("asks only for the unconfirmed facts", () => {
    expect(structureFollowUp(["퇴직 여부", "퇴직 여부", "약정 기간"])).toBe("다음 적용 요건에 해당하는 사실을 알려주면 다시 확인할 수 있습니다: 퇴직 여부, 약정 기간.");
    expect(structureFollowUp([])).toBeUndefined();
  });
  it("matches non-operative effects to the asks that request them", () => {
    expect(askCoversEffect("procedure", { id: "q1", kind: "절차", span: "절차" })).toBe(true);
    expect(askCoversEffect("definition", { id: "q1", kind: "의무", span: "사용자 의무" })).toBe(false);
    expect(askCoversEffect("definition", { id: "q1", kind: "요건", span: "근로자의 뜻" })).toBe(true);
    expect(askCoversEffect("remedy_program", undefined)).toBe(false);
  });
});

/**
 * RM1 (DESIGN §5-1): PR #418 negative cases as fixed structural inputs. Each
 * comparison is what a faithful model would record; the PR's blocking regex is
 * NOT applied here — the structure alone must keep each case out of S1.
 */
describe("RM1 structural negatives (PR #418 negative cases)", () => {
  const labor = "직원이 갑자기 무단퇴사해서 연락이 안 됨";
  const laborFrame = frame({ parties: [{ id: "p1", role: "근로자", span: "직원" }], relation: { type: "근로관계", span: "직원" },
    acts: [{ id: "a1", actor: "p1", act: "무단퇴사", polarity: "affirmed", span: "무단퇴사" }], asks: [{ id: "q1", kind: "의무", span: "무단퇴사" }] });
  const sanction = "국가기관과 체결한 물품계약을 제때 이행하지 못했습니다. 입찰참가자격 제한을 받을 수 있는 요건과 처분 전 의견을 낼 수 있는 절차를 알고 싶습니다.";
  const sanctionFrame = frame({ parties: [{ id: "p1", role: "계약상대자", span: "물품계약" }, { id: "p2", role: "국가기관", span: "국가기관" }],
    relation: { type: "국가계약", span: "국가기관과 체결한 물품계약" },
    acts: [{ id: "a1", actor: "p1", act: "이행지체", polarity: "affirmed", span: "제때 이행하지 못했습니다" }],
    asks: [{ id: "q1", kind: "제재", span: "입찰참가자격 제한을 받을 수 있는 요건" }, { id: "q2", kind: "절차", span: "처분 전 의견을 낼 수 있는 절차" }] });

  it("R1: a national-contract rule for a local-government question is S4; without a stated relation it is at most S3", () => {
    const national = "국가를 당사자로 하는 계약에 관한 법률에 따른 계약의 해제는 계약담당공무원이 한다.";
    const local = frame({ relation: { type: "지방계약", span: "지자체 계약" }, parties: [{ id: "p1", role: "지방자치단체", span: "지자체" }] });
    expect(decide(national, compare({ A: { value: "different", factPartyIds: ["p1"], quote: "국가를 당사자로 하는 계약" } }), profile("power"), "지자체 계약 해제 요건", local).state).toBe("not_relevant");
    expect(decide(national, compare({ C: { addressesAsk: true, askId: "q1", effectType: "power" } }), profile("power"), "계약 해제 요건", frame({ relation: null })))
      .toMatchObject({ state: "needs_condition", signals: expect.arrayContaining(["A.relation_missing_special_regime"]) });
  });
  it("R2: an administrative-investigation objection is not the pre-disposition procedure (B different → S4)", () => {
    const investigation = "조사대상자는 제17조에 따른 사전통지의 내용에 대하여 행정기관의 장에게 의견을 제출할 수 있다.";
    expect(decide(investigation, compare({ B: { value: "different", factActIds: [], quote: "사전통지의 내용에 대하여" }, C: { addressesAsk: true, askId: "q2", effectType: "procedure" } }),
      profile("procedure"), sanction, sanctionFrame).state).toBe("not_relevant");
  });
  it("R3: pre-qualification document screening does not answer a sanction (C unaddressed → S4)", () => {
    const screening = "계약담당공무원은 입찰참가자격 사전심사 신청 서류의 내용이 불명확하거나 누락된 서류가 있는 경우에는 3일 이내의 기간을 정하여 보완을 요구할 수 있다.";
    expect(decide(screening, compare({ C: { addressesAsk: false, askId: null, effectType: "procedure" } }), profile("procedure"), sanction, sanctionFrame).state).toBe("not_relevant");
  });
  it("R4: a public-enterprise contract rule for a national-agency contract is S4 (A different)", () => {
    const enterprise = "공기업ㆍ준정부기관 계약사무규칙 기관장은 입찰참가자격을 제한하려면 미리 해당 처분의 상대방에게 의견을 진술할 기회를 주어야 한다.";
    expect(decide(enterprise, compare({ A: { value: "different", factPartyIds: ["p2"], quote: "기관장은" }, C: { addressesAsk: true, askId: "q2", effectType: "procedure" } }),
      profile("procedure"), sanction, sanctionFrame).state).toBe("not_relevant");
  });
  it("R5/D0: an aggravated wage remedy without its conditions in the question stays out of S1", () => {
    const aggravated = "근로기준법 사용자가 명백한 고의로 임금을 지급하지 아니한 경우 근로자는 미지급 임금의 3배 이내의 손해배상을 청구할 수 있다.";
    const req = [{ id: "r1", text: "명백한 고의", quote: "명백한 고의로" }, { id: "r2", text: "3배 이내", quote: "3배 이내의" }];
    expect(decide(aggravated, compare({ C: { addressesAsk: true, askId: "q1", effectType: "right" }, D: [{ reqId: "r1", value: "satisfied", factIds: ["a1"] }, { reqId: "r2", value: "satisfied", factIds: ["a1"] }] }),
      profile("right", req), "회사가 월급을 안 줬어요. 지급해야 하는지 궁금합니다")).toMatchObject({ state: "needs_condition",
      signals: expect.arrayContaining(["D.r2.numeric_unverified", "D.aggravated_condition"]) });
  });
  it("D1: a definition used for a duty question is S2, and a definition mislabelled as a duty is S3", () => {
    const definition = '이 법에서 사용하는 용어의 뜻은 다음과 같다. "사용자"란 사업주를 말한다.';
    expect(decide(definition, compare({ C: { addressesAsk: true, askId: "q1", effectType: "definition" } }), profile("definition"), "사용자 의무").state).toBe("supporting");
    expect(decide(definition, compare({ D: [] }), profile("duty"), "사용자 의무")).toMatchObject({ state: "needs_condition", signals: ["C.duty_wording_absent"] });
  });
  it("D2: retirement settlement for a still-employed monthly wage is S3 (unconfirmed) or S4 (stated employment)", () => {
    const settlement = "사용자는 근로자가 사망 또는 퇴직한 경우에는 그 지급 사유가 발생한 때부터 14일 이내에 임금, 보상금, 그 밖의 모든 금품을 지급하여야 한다.";
    const req = [{ id: "r1", text: "근로자의 사망 또는 퇴직", quote: "사망 또는 퇴직한 경우에는" }];
    expect(decide(settlement, compare({ D: [{ reqId: "r1", value: "unconfirmed", factIds: [] }] }), profile("duty", req), "월급을 못 받았어"))
      .toMatchObject({ state: "needs_condition", unconfirmed: ["근로자의 사망 또는 퇴직"] });
    const employed = frame({ conditions: [{ id: "k1", kind: "재직", value: "재직 중", polarity: "affirmed", span: "재직 중" }] });
    expect(decide(settlement, compare({ D: [{ reqId: "r1", value: "conflicting", factIds: ["k1"] }] }), profile("duty", req), "재직 중인데 월급을 못 받았어", employed).state).toBe("not_relevant");
  });
  it("D3/D4: retirement-benefit and wage-relief programmes for a wage duty question are S2", () => {
    const relief = "고용노동부장관은 근로자에게 체불 임금등에 대한 생계비 융자를 할 수 있다.";
    expect(decide(relief, compare({ C: { addressesAsk: true, askId: "q1", effectType: "remedy_program" } }), profile("remedy_program"), "회사가 월급을 주지 않습니다").state).toBe("supporting");
  });
  it("D5: the rescission exercise method for a rescission-ground question is S2", () => {
    const exercise = "계약 또는 법률의 규정에 의하여 당사자의 일방이나 쌍방이 해지 또는 해제의 권리가 있는 때에는 그 해지 또는 해제는 상대방에 대한 의사표시로 한다.";
    const rescission = frame({ asks: [{ id: "q1", kind: "요건", span: "계약 해제 요건" }] });
    expect(decide(exercise, compare({ C: { addressesAsk: true, askId: "q1", effectType: "procedure" } }), profile("procedure"), "거래처 계약 불이행 계약 해제 요건", rescission).state).toBe("supporting");
  });
  it("D6: a replacement fine for a suspension question is S2 (related act, no confirmed suspension power)", () => {
    const fine = "영업정지가 이용자에게 심한 불편을 주는 경우에는 영업정지 처분을 갈음하여 과징금을 부과할 수 있다.";
    expect(decide(fine, compare({ B: { value: "directly_related", factActIds: ["a1"], quote: "영업정지 처분을 갈음하여" }, C: { addressesAsk: true, askId: "q1", effectType: "penalty" } }),
      profile("penalty"), "영업정지 요건").state).toBe("supporting");
  });
  it("D7/D8: contract rescission or a counterparty's demand for an employee who quit is S4", () => {
    const rescission = "당사자 일방이 그 시기에 이행하지 아니한 때에는 상대방은 전조의 최고를 하지 아니하고 계약을 해제할 수 있다.";
    expect(decide(rescission, compare({ A: { value: "different", factPartyIds: ["p1"], quote: "당사자 일방이" } }), profile("right"), labor, laborFrame).state).toBe("not_relevant");
    const demand = "해제권의 행사의 기간을 정하지 아니한 때에는 상대방은 상당한 기간을 정하여 해제권행사여부의 확답을 해제권자에게 최고할 수 있다.";
    expect(decide(demand, compare({ B: { value: "different", factActIds: [], quote: "확답을 해제권자에게 최고할 수 있다" } }), profile("right"), "계약 해제 요건").state).toBe("not_relevant");
  });
  it("D9: the authority's ban on unlawful tender conditions is S4 for a contractor's sanction (regulated party differs)", () => {
    const tender = "계약담당공무원은 경쟁입찰참가자격외의 요건을 정하여 입찰참가를 제한하여서는 아니된다.";
    expect(decide(tender, compare({ A: { value: "different", factPartyIds: ["p1"], quote: "계약담당공무원은" }, C: { addressesAsk: true, askId: "q1", effectType: "prohibition" } }),
      profile("prohibition"), sanction, sanctionFrame).state).toBe("not_relevant");
  });
  it("D11: a dismissal rule cannot rest on a denied dismissal act", () => {
    const dismissal = "사용자는 근로자를 해고하려면 해고사유와 해고시기를 서면으로 통지하여야 한다.";
    const quit = frame({ acts: [{ id: "a1", actor: "p1", act: "자진 퇴사", polarity: "affirmed", span: "무단퇴사" }, { id: "a2", actor: "p2", act: "해고", polarity: "denied", span: "연락이 안 됨" }] });
    expect(decide(dismissal, compare({ B: { value: "same", factActIds: ["a2"], quote: "해고하려면" } }), profile("duty"), labor, quit))
      .toMatchObject({ state: "needs_condition", signals: expect.arrayContaining(["B.denied_act"]) });
  });
  it("D12: an N-year term rule without a stated term stays S3", () => {
    const term = "고용의 약정기간이 3년을 넘거나 당사자의 일방 또는 제삼자의 종신까지로 된 때에는 각 당사자는 3년을 경과한 후 언제든지 계약해지의 통고를 할 수 있다.";
    const req = [{ id: "r1", text: "약정기간 3년 초과", quote: "약정기간이 3년을 넘거나" }];
    expect(decide(term, compare({ C: { addressesAsk: true, askId: "q1", effectType: "right" }, D: [{ reqId: "r1", value: "satisfied", factIds: ["a1"] }] }), profile("right", req), labor, laborFrame))
      .toMatchObject({ state: "needs_condition", signals: ["D.r1.numeric_unverified"], unconfirmed: ["약정기간 3년 초과"] });
  });
  it("ungated observations: 국가계약법 제27조의5 by a requirement conflict (S4), 근로기준법 제19조 by party/act (S4/S3)", () => {
    const disqualification = "각 중앙관서의 장은 조세포탈 등으로 유죄판결이 확정된 날부터 2년이 지나지 아니한 자는 입찰에 참가할 수 없다.";
    const req = [{ id: "r1", text: "조세포탈 유죄판결 확정", quote: "조세포탈 등으로 유죄판결이 확정된" }];
    expect(decide(disqualification, compare({ C: { addressesAsk: true, askId: "q1", effectType: "requirement" }, D: [{ reqId: "r1", value: "conflicting", factIds: ["a1"] }] }),
      profile("requirement", req), sanction, sanctionFrame).state).toBe("not_relevant");
    const conditions = "근로조건이 명시된 근로조건과 다를 경우에 근로자는 근로조건 위반을 이유로 손해의 배상을 청구할 수 있으며 즉시 근로계약을 해제할 수 있다.";
    expect(decide(conditions, compare({ B: { value: "different", factActIds: ["a1"], quote: "즉시 근로계약을 해제할 수 있다" } }), profile("right"), labor, laborFrame).state).toBe("not_relevant");
    expect(decide(conditions, compare({ A: { value: "unknown", factPartyIds: [], quote: "" }, C: { addressesAsk: true, askId: "q1", effectType: "right" } }), profile("right"), labor, laborFrame).state).toBe("needs_condition");
  });
});

/**
 * RM2 (DESIGN §5-1): the PR's positive provisions stay reachable as S1 when the
 * faithful record confirms them. Texts are fixed test inputs of the provisions'
 * operative sentences.
 */
describe("RM2 structural positives (제36·43·65·390·546·548·660조)", () => {
  const cases: Array<{ name: string; law: string; text: string; query: string; facts: FactFrame; effect: ProvisionProfile["effectType"]; req: ProvisionProfile["requirements"]; satisfiedBy: string[] }> = [
    { name: "근로기준법 제36조 (퇴직 후 임금)", law: "근로기준법",
      text: "사용자는 근로자가 사망 또는 퇴직한 경우에는 그 지급 사유가 발생한 때부터 14일 이내에 임금, 보상금, 그 밖의 모든 금품을 지급하여야 한다.",
      query: "회사를 퇴사한 지 한 달인데 마지막 달 임금을 못 받았어. 언제까지 지급해야 해?",
      facts: frame({ conditions: [{ id: "k1", kind: "퇴직", value: "퇴사", polarity: "affirmed", span: "퇴사한 지" }] }),
      effect: "duty", req: [{ id: "r1", text: "근로자의 퇴직", quote: "사망 또는 퇴직한 경우에는" }], satisfiedBy: ["k1"] },
    { name: "근로기준법 제43조 (월급)", law: "근로기준법",
      text: "① 임금은 통화로 직접 근로자에게 그 전액을 지급하여야 한다.\n② 임금은 매월 1회 이상 일정한 날짜를 정하여 지급하여야 한다.",
      query: "회사가 이번 달 월급을 주지 않습니다. 지급해야 하는지 궁금합니다", facts: frame(),
      effect: "duty", req: [{ id: "r1", text: "근로자의 임금", quote: "근로자에게 그 전액을" }], satisfiedBy: ["a1"] },
    { name: "국가계약법 시행령 제65조 (설계변경)", law: "국가를 당사자로 하는 계약에 관한 법률 시행령",
      text: "각 중앙관서의 장 또는 계약담당공무원은 공사계약에 있어서 설계변경으로 인하여 공사량의 증감이 발생한 때에는 법 제19조의 규정에 의하여 당해 계약금액을 조정한다.",
      query: "국가기관과 공사계약을 체결했고 설계변경이 있었습니다. 계약금액을 변경할 수 있나요?",
      facts: frame({ parties: [{ id: "p1", role: "계약상대자", span: "공사계약" }], relation: { type: "국가계약", span: "국가기관과 공사계약" },
        acts: [{ id: "a1", actor: "p2", act: "설계변경", polarity: "affirmed", span: "설계변경이 있었습니다" }], asks: [{ id: "q1", kind: "요건", span: "계약금액을 변경할 수 있나요" }] }),
      effect: "requirement", req: [{ id: "r1", text: "공사계약의 설계변경", quote: "설계변경으로 인하여" }], satisfiedBy: ["a1"] },
    { name: "민법 제390조 (계약 불이행)", law: "민법",
      text: "채무자가 채무의 내용에 좇은 이행을 하지 아니한 때에는 채권자는 손해배상을 청구할 수 있다. 그러나 채무자의 고의나 과실없이 이행할 수 없게 된 때에는 그러하지 아니하다.",
      query: "거래처가 계약대로 물건을 납품하지 않아 손해를 입었어. 배상을 청구할 수 있어?",
      facts: frame({ parties: [{ id: "p1", role: "채권자", span: "거래처가" }], relation: { type: "계약", span: "계약대로" },
        acts: [{ id: "a1", actor: "p1", act: "불이행", polarity: "affirmed", span: "납품하지 않아" }], asks: [{ id: "q1", kind: "권리", span: "배상을 청구할 수 있어" }] }),
      effect: "right", req: [{ id: "r1", text: "채무 불이행", quote: "이행을 하지 아니한 때에는" }, { id: "r2", text: "고의·과실", quote: "고의나 과실없이" }], satisfiedBy: ["a1"] },
    { name: "민법 제546조 (이행불능 해제)", law: "민법",
      text: "채무자의 책임있는 사유로 이행이 불능하게 된 때에는 채권자는 계약을 해제할 수 있다.",
      query: "상대방 잘못으로 물건이 멸실돼 납품이 불가능해졌어. 계약을 해제할 수 있어?",
      facts: frame({ parties: [{ id: "p1", role: "채권자", span: "상대방" }], relation: { type: "계약", span: "납품" },
        acts: [{ id: "a1", actor: "p1", act: "이행불능", polarity: "affirmed", span: "납품이 불가능해졌어" }], asks: [{ id: "q1", kind: "권리", span: "계약을 해제할 수 있어" }] }),
      effect: "right", req: [{ id: "r1", text: "이행불능", quote: "이행이 불능하게 된 때에는" }], satisfiedBy: ["a1"] },
    { name: "민법 제548조 (해제 효과)", law: "민법",
      text: "① 당사자 일방이 계약을 해제한 때에는 각 당사자는 그 상대방에 대하여 원상회복의 의무가 있다. 그러나 제삼자의 권리를 해하지 못한다.",
      query: "계약을 해제했는데 이미 준 대금을 돌려받을 수 있어?",
      facts: frame({ parties: [{ id: "p1", role: "당사자", span: "계약을" }], relation: { type: "계약", span: "계약을 해제했는데" },
        acts: [{ id: "a1", actor: "p1", act: "계약 해제", polarity: "affirmed", span: "계약을 해제했는데" }], asks: [{ id: "q1", kind: "권리", span: "돌려받을 수 있어" }] }),
      effect: "duty", req: [{ id: "r1", text: "계약 해제", quote: "계약을 해제한 때에는" }], satisfiedBy: ["a1"] },
    { name: "민법 제660조 (기간 약정 없는 고용 해지)", law: "민법",
      text: "① 고용기간의 약정이 없는 때에는 당사자는 언제든지 계약해지의 통고를 할 수 있다.\n② 전항의 경우에는 상대방이 해지의 통고를 받은 날로부터 1월이 경과하면 해지의 효력이 생긴다.",
      query: "기간을 정하지 않고 일한 직원이 그만두겠다고 통보했어. 언제 효력이 생겨?",
      facts: frame({ parties: [{ id: "p1", role: "근로자", span: "직원" }], relation: { type: "고용", span: "일한 직원" },
        acts: [{ id: "a1", actor: "p1", act: "해지 통고", polarity: "affirmed", span: "그만두겠다고 통보했어" }],
        conditions: [{ id: "k1", kind: "기간 약정", value: "없음", polarity: "affirmed", span: "기간을 정하지 않고" }], asks: [{ id: "q1", kind: "권리", span: "언제 효력이 생겨" }] }),
      effect: "right", req: [{ id: "r1", text: "고용기간 약정 없음", quote: "고용기간의 약정이 없는 때에는" }], satisfiedBy: ["k1"] },
  ];
  it.each(cases)("$name stays S1", ({ law, text, query, facts, effect, req, satisfiedBy }) => {
    const D = req.map((row, index) => index === 0 ? { reqId: row.id, value: "satisfied" as const, factIds: satisfiedBy } : { reqId: row.id, value: "unconfirmed" as const, factIds: [], general: true });
    const result = decideStructure({ candidate: candidate(text, { law }), evidence: verified,
      comparison: compare({ A: { value: "same", factPartyIds: ["p1"], quote: "" }, C: { addressesAsk: true, askId: "q1", effectType: effect }, D }),
      profile: profile(effect, req), frame: facts, originalQuery: query });
    expect(result).toMatchObject({ state: "direct", rule: 8 });
    expect(result.signals).toEqual([]);
  });
});
