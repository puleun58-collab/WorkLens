import { describe, expect, it } from "vitest";
import {
  classifyDocument, documentRisk, extractKeyFacts, holdingRelevance, issueDefinition, lawTargets, passesMetadataGate,
  precedentQueries, reviewClauses, splitClauses,
} from "@/lib/contract-review";
import { reviewContract, type ReviewSources } from "@/server/contract-review";
import {
  B2B_SERVICE_CONTRACT, CONSUMER_TERMS, EMPLOYMENT_CONTRACT, LEASE_CONTRACT, MIXED_SERVICE_CONTRACT, NDA_CONTRACT,
  OUTSOURCING_CONTRACT, SUPPLY_CONTRACT,
} from "./fixtures/contracts";

const LABOR = /근로|해고|임금/u;
const LEASE = /임대차|임차|갱신거절권|보증금/u;

function issuesOf(text: string) {
  const profile = classifyDocument(text);
  return { profile, clauses: reviewClauses(splitClauses(text), profile) };
}

describe("document type and party relationship come first", () => {
  it.each([
    [B2B_SERVICE_CONTRACT, "b2b_service", "business"],
    [EMPLOYMENT_CONTRACT, "employment", "employment"],
    [LEASE_CONTRACT, "lease", "lease"],
    [CONSUMER_TERMS, "b2c_terms", "consumer"],
  ])("classifies each fixture by its own text", (text, type, relationship) => {
    const profile = classifyDocument(text);
    expect([profile.type, profile.relationship]).toEqual([type, relationship]);
    expect(profile.evidence.length).toBeGreaterThan(0);
  });

  it("does not force a type on a document without enough signals", () => {
    const profile = classifyDocument("제1조(목적) 이 문서는 협력 사항을 정한다.\n제2조(기간) 기간은 1년으로 한다.");
    expect(profile.type).toBe("unknown");
    expect(profile.relationship).toBe("unknown");
    expect(profile.domains).not.toContain("labor");
    expect(profile.domains).not.toContain("lease");
  });
});

describe("B2B service contract review candidates", () => {
  const { profile, clauses } = issuesOf(B2B_SERVICE_CONTRACT);
  const found = new Set(clauses.flatMap((clause) => clause.issues.map((issue) => issue.id)));

  it("surfaces every clause the brief lists as a review candidate", () => {
    for (const id of ["auto_renewal", "price_change", "service_suspension", "exemption", "unilateral_termination",
      "termination_restriction", "penalty", "liability_cap", "data_transfer", "contract_change", "jurisdiction", "policy_delegation"]) {
      expect(found, id).toContain(id);
    }
  });

  it("never raises labor or lease issues, statutes or search terms for a service contract", () => {
    expect(found).not.toContain("dismissal");
    expect(found).not.toContain("lease_renewal");
    for (const id of found) {
      const issue = issueDefinition(id)!;
      for (const law of lawTargets(issue, profile)) expect(law.law, id).not.toMatch(/근로기준법|임대차/u);
      for (const query of precedentQueries(issue, profile)) {
        expect(query, id).not.toMatch(LABOR);
        expect(query, id).not.toMatch(LEASE);
      }
    }
  });

  it("builds staged queries from the document type and the issue, most specific first", () => {
    expect(precedentQueries(issueDefinition("unilateral_termination")!, profile)[0]).toBe("서비스 이용계약 일방적 해지 조항 효력");
    expect(precedentQueries(issueDefinition("auto_renewal")!, profile)).toEqual([
      "서비스 이용계약 자동갱신 해지 통지", "자동갱신 조항 해지 고지", "계약 자동연장 갱신거절 통지",
    ]);
  });

  it("keeps key facts verbatim instead of shortening them", () => {
    const values = extractKeyFacts(splitClauses(B2B_SERVICE_CONTRACT)).map((fact) => fact.value);
    expect(values).toContain("2026년 1월 1일부터 2026년 12월 31일까지");
    expect(values).toContain("잔여 계약기간 이용요금 전액의 200%");
    expect(values).not.toContain("2026년");
  });

  it("words review points without unconditional legal conclusions", () => {
    for (const clause of clauses) for (const issue of clause.issues) {
      expect(issue.point, issue.id).not.toMatch(/무효입니다|위법입니다|불법입니다|효력이 없습니다/u);
    }
    const privacy = clauses.flatMap((clause) => clause.issues).find((issue) => issue.id === "data_transfer")!;
    expect(privacy.fact).toContain("별도의 동의를 받지 않을 수 있다");
    expect(privacy.point).toMatch(/처리위탁/u);
  });
});

describe("the same areas of law stay available where the document is about them", () => {
  it("allows labor statutes and dismissal review for an employment contract", () => {
    const { profile, clauses } = issuesOf(EMPLOYMENT_CONTRACT);
    const dismissal = issueDefinition("dismissal")!;
    expect(clauses.flatMap((clause) => clause.issues.map((issue) => issue.id))).toContain("dismissal");
    expect(lawTargets(dismissal, profile).map((law) => law.law)).toContain("근로기준법");
  });

  it("allows lease statutes for a lease and consumer statutes for B2C terms", () => {
    const lease = issuesOf(LEASE_CONTRACT);
    expect(lease.clauses.flatMap((clause) => clause.issues.map((issue) => issue.id))).toEqual(["lease_renewal", "restoration"]);
    expect(lawTargets(issueDefinition("lease_renewal")!, lease.profile).map((law) => law.law)).toEqual(["상가건물 임대차보호법"]);
    const consumer = issuesOf(CONSUMER_TERMS);
    expect(consumer.clauses.flatMap((clause) => clause.issues.map((issue) => issue.id))).toContain("withdrawal_restriction");
  });
});

describe("other business contract types, paraphrases and broken layout", () => {
  const ids = (text: string) => issuesOf(text).clauses.map((clause) => `${clause.number}:${clause.issues.map((issue) => issue.id).join("+")}`);

  it.each([
    [OUTSOURCING_CONTRACT, "outsourcing", ["제2조:penalty", "제3조:unilateral_termination", "제4조:jurisdiction"]],
    [SUPPLY_CONTRACT, "sale", ["제2조:price_change", "제3조:exemption"]],
    [NDA_CONTRACT, "nda", ["제3조:penalty", "제4조:auto_renewal"]],
    [MIXED_SERVICE_CONTRACT, "b2b_service", ["제1조:data_transfer", "제2조:liability_cap", "제3조:penalty", "제4조:jurisdiction", "제5조:auto_renewal"]],
  ])("classifies %#, raises its clause issues and keeps labor and lease out", (text, type, expected) => {
    const { profile, clauses } = issuesOf(text);
    expect(profile.type).toBe(type);
    expect(profile.relationship).toBe("business");
    expect(profile.domains).not.toContain("labor");
    expect(profile.domains).not.toContain("lease");
    for (const entry of expected) expect(ids(text)).toContain(entry);
    expect(clauses.flatMap((clause) => clause.issues.map((issue) => issue.id))).not.toContain("dismissal");
  });

  it("reads renewal written without 자동, and ignores sentences that only mention renewal", () => {
    const renewal = issueDefinition("auto_renewal")!.detect;
    for (const text of ["별도 통지가 없으면 1년 자동 연장한다.", "계약 만료 전 해지 의사가 없는 경우 동일 조건으로 갱신된다.",
      "종료 의사 표시가 없으면 계약기간이 연장된다."]) expect(renewal.test(text), text).toBe(true);
    for (const text of ["임대인은 임차인의 갱신 요구가 없는 한 계약을 연장하지 아니한다.", "통지 없이 계약을 연장할 수 없다."]) {
      expect(renewal.test(text), text).toBe(false);
    }
  });

  it("starts a new clause at an article heading left mid-line by a lost line break, not at a cross-reference", () => {
    const clauses = splitClauses("제1조(목적) 제공자는 서비스를\n제공한다. 제2조(해지) 이용자는 계약기간 중\n해지할 수 없다.\n제3조(책임) 제5조(손해배상)에 따른 책임은 제7조(면책)에 우선한다.");
    expect(clauses.map((clause) => clause.number)).toEqual(["제1조", "제2조", "제3조"]);
    expect(clauses[1].text).toBe("이용자는 계약기간 중 해지할 수 없다.");
  });
});

describe("relevance gates", () => {
  const b2b = classifyDocument(B2B_SERVICE_CONTRACT);
  const lease = classifyDocument(LEASE_CONTRACT);

  it("drops precedents from excluded areas on metadata alone, but only where excluded", () => {
    for (const title of ["건물인도", "토지인도", "임대차보증금", "해고무효확인", "부가가치세 부과처분 무효확인"]) {
      expect(passesMetadataGate({ title }, b2b), title).toBe(false);
    }
    expect(passesMetadataGate({ title: "건물명도(인도)" }, lease)).toBe(true);
    expect(passesMetadataGate({ title: "손해배상(기)" }, b2b)).toBe(true);
  });

  it("accepts a holding only when it addresses the clause's own issue", () => {
    const penalty = issueDefinition("penalty")!;
    expect(holdingRelevance("[1] 위약금 약정이 손해배상액의 예정으로서 부당히 과다한 경우 법원이 감액할 수 있는지 여부(적극)", penalty, b2b))
      .toMatch(/부당히 과다/u);
    // Same keyword, different question: the limitation period of a penalty claim.
    expect(holdingRelevance("[2] 운송계약상의 위약금 채권에 대하여 단기소멸시효를 적용한 사례", penalty, b2b)).toBeUndefined();
    const jurisdiction = issueDefinition("jurisdiction")!;
    expect(holdingRelevance("[1] 외국법원을 관할법원으로 하는 전속적인 국제재판관할합의가 유효하기 위한 요건", jurisdiction, b2b)).toBeUndefined();
  });
});

function fakeSources(overrides: Partial<ReviewSources> = {}): ReviewSources & { calls: Record<string, string[]> } {
  const calls: Record<string, string[]> = { findLaw: [], article: [], searchPrecedents: [], holding: [] };
  return {
    calls,
    async findLaw(name) { calls.findLaw.push(name); return { mst: `mst-${name}` }; },
    async article(mst, jo) {
      calls.article.push(`${mst}:${jo}`);
      return `법령명: 테스트\n시행일: 20240807\n\n${jo} 조문 제목\n${jo}의 본문입니다.\n`;
    },
    async searchPrecedents(query) {
      calls.searchPrecedents.push(query);
      if (/위약금/u.test(query)) {
        return [
          { domain: "precedent", id: "1", title: "건물인도", caseNumber: "2025다1" },
          { domain: "precedent", id: "2", title: "위약금등청구", caseNumber: "2024다2", court: "대법원", date: "20240101" },
          { domain: "precedent", id: "3", title: "손해배상(기)", caseNumber: "2023다3" },
        ];
      }
      return [{ domain: "precedent", id: "9", title: "손해배상(기)", caseNumber: "2020다9" }];
    },
    async holding(id) {
      calls.holding.push(id);
      if (id === "2") return "[1] 위약금이 손해배상액의 예정으로서 부당히 과다한 경우 감액할 수 있는지 여부(적극)";
      if (id === "3") return "[1] 위약금이 손해배상액의 예정으로서 부당히 과다한 경우 감액할 수 있는지 여부(적극)";
      return "[1] 불법행위로 인한 손해배상청구권의 소멸시효 기산점";
    },
    ...overrides,
  };
}

describe("reviewContract pipeline", () => {
  it("links clause → statute → precedent, shows no-precedent state instead of filling with unrelated cases", async () => {
    const sources = fakeSources();
    const review = await reviewContract(B2B_SERVICE_CONTRACT, sources);
    const penalty = review.clauses.flatMap((clause) => clause.issues).find((issue) => issue.id === "penalty")!;
    expect(penalty.precedentStatus).toBe("found");
    // One holding repeated by a companion case is shown once.
    expect(penalty.precedents).toEqual(["precedent:2"]);
    expect(review.precedents["precedent:2"]).toMatchObject({ caseNumber: "2024다2", court: "대법원", date: "20240101", scope: "판시사항" });
    expect(review.laws[penalty.laws[0]]).toMatchObject({ law: "민법", jo: "제398조", title: "조문 제목", effectiveDate: "20240807" });
    const renewal = review.clauses.flatMap((clause) => clause.issues).find((issue) => issue.id === "auto_renewal")!;
    expect(renewal.precedentStatus).toBe("none");
    expect(renewal.precedents).toEqual([]);
    // The excluded-area case was never opened; its holding was not fetched.
    expect(sources.calls.holding).not.toContain("1");
  });

  it("never searches or opens anything twice", async () => {
    const sources = fakeSources();
    await reviewContract(B2B_SERVICE_CONTRACT, sources);
    for (const [name, list] of Object.entries(sources.calls)) expect(new Set(list).size, name).toBe(list.length);
  });

  it("keeps the clause review when law or precedent search fails, and reports only that section as failed", async () => {
    const review = await reviewContract(B2B_SERVICE_CONTRACT, fakeSources({
      async findLaw() { throw new Error("upstream down"); },
      async searchPrecedents() { throw new Error("upstream down"); },
    }));
    const issues = review.clauses.flatMap((clause) => clause.issues);
    expect(issues.length).toBeGreaterThanOrEqual(12);
    expect(issues.every((issue) => issue.lawStatus === "failed" && issue.precedentStatus === "failed")).toBe(true);
    expect(review.risk.level).toBe("높음");
  });

  it("computes risk from the clauses only, not from how many citations were found", async () => {
    const rich = await reviewContract(B2B_SERVICE_CONTRACT, fakeSources());
    const empty = await reviewContract(B2B_SERVICE_CONTRACT, fakeSources({ async searchPrecedents() { return []; }, async findLaw() { return undefined; } }));
    expect(rich.risk).toEqual(empty.risk);
    expect(rich.risk).toEqual(documentRisk(reviewClauses(splitClauses(B2B_SERVICE_CONTRACT), classifyDocument(B2B_SERVICE_CONTRACT))));
  });

  it("stops starting new lookups once the time budget is spent", async () => {
    let clock = 0;
    const sources = fakeSources({ async article(mst, jo) { clock += 60_000; return `${jo} 제목\n본문`; } });
    const review = await reviewContract(B2B_SERVICE_CONTRACT, sources, () => clock);
    expect(review.clauses.length).toBeGreaterThan(0);
    expect(sources.calls.holding.length + sources.calls.searchPrecedents.length).toBeLessThan(20);
  });

  it("sends the MCP only statute names, article numbers, issue search terms and case ids, never the document's own sentences", async () => {
    for (const text of [B2B_SERVICE_CONTRACT, MIXED_SERVICE_CONTRACT, CONSUMER_TERMS]) {
      const sources = fakeSources();
      await reviewContract(text, sources);
      const sent = Object.values(sources.calls).flat();
      // Any 12-character run of a clause (names, amounts, periods, wording) would mean document text left WorkLens.
      const fragments = splitClauses(text).flatMap((clause) => {
        const body = clause.text.replace(/\s+/gu, " ");
        return Array.from({ length: Math.max(0, body.length - 11) }, (_, index) => body.slice(index, index + 12));
      });
      for (const value of sent) for (const fragment of fragments) expect(value.includes(fragment), `${value} ⊃ ${fragment}`).toBe(false);
    }
  });

  it("does not search for renewal statutes where the document's area excludes them, and says so", async () => {
    const review = await reviewContract(NDA_CONTRACT, fakeSources());
    const renewal = review.clauses.flatMap((clause) => clause.issues).find((issue) => issue.id === "auto_renewal")!;
    expect(renewal.lawStatus).toBe("not_searched");
    expect(renewal.laws).toEqual([]);
  });

  it("searches labor statutes for an employment contract", async () => {
    const sources = fakeSources();
    await reviewContract(EMPLOYMENT_CONTRACT, sources);
    expect(sources.calls.findLaw).toContain("근로기준법");
    const b2b = fakeSources();
    await reviewContract(B2B_SERVICE_CONTRACT, b2b);
    expect(b2b.calls.findLaw.filter((name) => /근로기준법|임대차/u.test(name))).toEqual([]);
    expect(b2b.calls.searchPrecedents.filter((query) => LABOR.test(query) || LEASE.test(query))).toEqual([]);
  });
});
