import { readFileSync } from "node:fs";
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
import {
  AMBIGUOUS_NOTICE, CLEAN_WORK_RULES, EMPLOYMENT_CONTRACT_2, PRIVACY_CCTV_GUIDELINE, REMOTE_WORK_GUIDELINE,
} from "./fixtures/review-scenarios";

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

describe("company work rules are reviewed as employment documents without being called contracts", () => {
  // Verbatim reproduction that was classified "유형 확인 불가" with no issues.
  const GUIDELINE = readFileSync(new URL("./fixtures/employee-work-info-guideline.md", import.meta.url), "utf8");
  const ids = (text: string) => issuesOf(text).clauses.flatMap((clause) => clause.issues.map((issue) => issue.id));

  it("labels the guideline as internal rules between employer and employees, with labor review", () => {
    const { profile, clauses } = issuesOf(GUIDELINE);
    expect(profile).toMatchObject({ type: "work_rules", label: "근로·인사 관련 내부 규정", relationshipLabel: "사용자와 근로자" });
    expect(profile.label).not.toContain("근로계약");
    expect(profile.domains).toEqual(expect.arrayContaining(["labor", "privacy"]));
    expect(clauses.map((clause) => [clause.number, clause.title])).toContainEqual(["제7조", "인사 및 징계"]);
    // A statute cited inside a clause is not a new clause.
    expect(clauses.map((clause) => clause.number)).not.toContain("제23조");
  });

  it("finds each kind of review point the guideline contains", () => {
    expect(ids(GUIDELINE)).toEqual(expect.arrayContaining([
      "overtime_pay", "working_hours", "annual_leave", "employee_monitoring", "cctv_audio", "data_transfer",
      "overseas_storage", "retention_period", "penalty", "dismissal", "rules_change", "deemed_consent", "rules_precedence",
    ]));
  });

  it("drops markdown bold wherever it sits in a line", () => {
    expect(splitClauses("### 제1조 목적\n회사는 **모든** 직원에게 **즉시** 적용한다.")).toEqual([
      { number: "제1조", title: "목적", text: "회사는 모든 직원에게 즉시 적용한다." },
    ]);
  });

  it("reads the same points when they are phrased differently", () => {
    const variant = GUIDELINE
      .replace("별도의 수당을 지급하지 않는다", "추가 임금 지급 대상에서 제외한다")
      .replace("해외 서버에 저장할 수도 있다", "국외 데이터센터에서 처리할 수 있다")
      .replace("공지 후 3일이 지나면 모든 직원이 변경 내용에 동의한 것으로 본다", "별도 이의가 없는 경우 변경에 동의한 것으로 간주한다")
      .replace("실제 손해액과 관계없이 5천만 원의 손해배상금을 청구할 수 있다", "발생한 실제 손해와 무관하게 정액 5천만 원을 배상한다")
      .replace("직원이 본 지침에 동의하고 근무를 계속하는 경우 이러한 정보 수집에 동의한 것으로 본다.", "");
    expect(variant).not.toBe(GUIDELINE);
    const found = issuesOf(variant).clauses;
    const at = (number: string) => found.find((clause) => clause.number === number)!.issues.map((issue) => issue.id);
    expect(at("제2조")).toContain("overtime_pay");
    expect(at("제8조")).toContain("overseas_storage");
    expect(at("제9조")).toContain("deemed_consent");
    expect(at("제6조")).toContain("penalty");
  });

  it("leaves ordinary rule sentences alone", () => {
    const plain = [
      "취업규칙",
      "제1조(연차) 연차휴가는 근로기준법 및 회사 취업규칙에 따라 부여한다.",
      "제2조(보호) 회사는 개인정보 보호를 위해 접근권한을 최소화한다.",
      "제3조(CCTV) CCTV는 시설 안전사고 예방을 위해 관련 법령에 따라 운영한다.",
      "제4조(해고) 직원의 해고는 근로기준법이 정한 절차에 따른다.",
      "제5조(근무) 직원의 근무시간과 휴게시간은 근로기준법에 따른다.",
    ].join("\n");
    expect(classifyDocument(plain).type).toBe("work_rules");
    expect(ids(plain)).toEqual([]);
  });

  it("keeps an employment contract an employment contract", () => {
    expect(classifyDocument(EMPLOYMENT_CONTRACT).type).toBe("employment");
    for (const text of [B2B_SERVICE_CONTRACT, NDA_CONTRACT, OUTSOURCING_CONTRACT, SUPPLY_CONTRACT, LEASE_CONTRACT, CONSUMER_TERMS]) {
      expect(classifyDocument(text).type).not.toBe("work_rules");
    }
  });
});

describe("classification and detection across document kinds", () => {
  const GUIDELINE = readFileSync(new URL("./fixtures/employee-work-info-guideline.md", import.meta.url), "utf8");
  // [document, type, relationship, must find, must not find]
  const cases: Array<[string, string, string, string, string[], string[]]> = [
    ["인사·복무 운영지침", GUIDELINE, "work_rules", "employment", ["overtime_pay", "annual_leave", "dismissal", "rules_precedence"], ["contract_change", "withdrawal_restriction", "lease_renewal"]],
    ["재택근무·근태 지침", REMOTE_WORK_GUIDELINE, "work_rules", "employment", ["overtime_pay", "employee_monitoring", "annual_leave", "rules_change", "deemed_consent"], ["contract_change", "cctv_audio"]],
    ["개인정보·CCTV 규정", PRIVACY_CCTV_GUIDELINE, "work_rules", "employment", ["cctv_audio", "data_transfer", "overseas_storage", "retention_period", "dismissal"], ["overtime_pay", "annual_leave"]],
    ["근로계약서", EMPLOYMENT_CONTRACT, "employment", "employment", ["dismissal"], ["rules_change", "contract_change"]],
    ["근로계약서(다른 표현)", EMPLOYMENT_CONTRACT_2, "employment", "employment", ["overtime_pay", "dismissal"], ["annual_leave", "rules_precedence"]],
    ["정상 복무규정", CLEAN_WORK_RULES, "work_rules", "employment", [], ["overtime_pay", "annual_leave", "dismissal", "data_transfer", "cctv_audio", "employee_monitoring"]],
    ["B2B 서비스 계약", B2B_SERVICE_CONTRACT, "b2b_service", "business", ["price_change", "data_transfer", "contract_change"], ["dismissal", "overtime_pay", "rules_change", "cctv_audio"]],
    ["B2B 서비스 계약(개인정보 포함)", MIXED_SERVICE_CONTRACT, "b2b_service", "business", ["data_transfer", "penalty"], ["dismissal", "employee_monitoring", "rules_change"]],
    ["소비자 이용약관", CONSUMER_TERMS, "b2c_terms", "consumer", ["withdrawal_restriction"], ["dismissal", "rules_change"]],
    ["용역계약", OUTSOURCING_CONTRACT, "outsourcing", "business", ["penalty"], ["dismissal", "overtime_pay"]],
    ["임대차계약", LEASE_CONTRACT, "lease", "lease", ["lease_renewal"], ["dismissal", "data_transfer"]],
    ["공급계약", SUPPLY_CONTRACT, "sale", "business", ["price_change"], ["dismissal", "annual_leave"]],
    ["비밀유지계약", NDA_CONTRACT, "nda", "business", ["penalty"], ["dismissal", "overseas_storage"]],
    ["애매한 안내문", AMBIGUOUS_NOTICE, "unknown", "unknown", [], ["dismissal", "data_transfer"]],
  ];

  it.each(cases)("%s", (_name, text, type, relationship, present, absent) => {
    const { profile, clauses } = issuesOf(text);
    expect([profile.type, profile.relationship]).toEqual([type, relationship]);
    // Labor review follows an employment relationship; nothing else gains it.
    expect(profile.domains.includes("labor")).toBe(relationship === "employment");
    const found = clauses.flatMap((clause) => clause.issues.map((issue) => issue.id));
    expect(found).toEqual(expect.arrayContaining(present));
    for (const id of absent) expect(found).not.toContain(id);
    // Every statute an issue may cite stays inside the document's areas of law.
    for (const id of new Set(found)) for (const law of lawTargets(issueDefinition(id)!, profile)) expect(profile.domains).toContain(law.domain);
    if (!present.length) expect(documentRisk(clauses).level).toBe("낮음");
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

describe("documents without article numbers", () => {
  it("folds a bare heading into the sentence it titles, so one clause raises one issue", () => {
    const text = "서비스 이용 계약\n소프트웨어 서비스 이용계약\n면책\n회사는 고의 또는 중대한 과실이 없는 한 손해에 책임지지 않는다.";
    const clauses = splitClauses(text);
    expect(clauses).toEqual([{ title: "면책", text: "회사는 고의 또는 중대한 과실이 없는 한 손해에 책임지지 않는다." }]);
    expect(reviewClauses(clauses, classifyDocument(text)).flatMap((clause) => clause.issues.map((issue) => issue.id))).toEqual(["exemption"]);
  });

  it("pairs several headings with their own bodies", () => {
    const text = ["소프트웨어 서비스 이용계약", "계약기간", "별도 통지가 없으면 계약은 1년 자동 연장한다.", "자동갱신",
      "종료 의사 표시가 없으면 계약기간이 연장된다.", "해지", "이용자는 계약기간 중 해지할 수 없다.", "면책", "제공자는 일체의 책임을 지지 않는다."].join("\n");
    expect(splitClauses(text).map((clause) => clause.title)).toEqual(["계약기간", "자동갱신", "해지", "면책"]);
  });

  it("keeps short statements, amounts, check marks and a trailing heading as their own lines", () => {
    expect(splitClauses("을은 동의한다.\n보증금 1,000,000원\n□ 확인\n비고").map((clause) => clause.text))
      .toEqual(["을은 동의한다.", "보증금 1,000,000원", "□ 확인", "비고"]);
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

  it("shows a verified article body once when the source repeats its heading", async () => {
    const text = [
      "서비스 이용계약서",
      "제1조(위약금) 이용자는 잔여기간 이용요금의 200%를 위약금으로 지급한다.",
    ].join("\n");
    const review = await reviewContract(text, fakeSources({
      async article(_mst, jo) {
        return `법령명: 테스트\n시행일: 20240807\n\n${jo}(배상액의 예정)\n${jo}(배상액의 예정)\n① 손해배상의 예정액이 부당히 과다한 경우 법원은 감액할 수 있다.`;
      },
    }));
    const issue = review.clauses.flatMap((clause) => clause.issues).find((item) => item.id === "penalty")!;
    const law = review.laws[issue.laws[0]];
    expect(law.title).toBe("배상액의 예정");
    expect(law.excerpt).toBe("① 손해배상의 예정액이 부당히 과다한 경우 법원은 감액할 수 있다.");
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
    expect(issues.every((issue) => issue.lawStatus === "failed"
      && (issue.precedentStatus === "failed" || issue.precedentStatus === "not_searched"))).toBe(true);
    expect(issues.some((issue) => issue.precedentStatus === "not_searched")).toBe(true);
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

describe("cross-document review regressions", () => {
  it.each([
    ["서비스 계약", B2B_SERVICE_CONTRACT, "b2b_service", "제6조", "penalty", "민법", "제398조"],
    ["근로계약", EMPLOYMENT_CONTRACT, "employment", "제4조", "dismissal", "근로기준법", "제23조"],
    ["임대차", LEASE_CONTRACT, "lease", "제3조", "lease_renewal", "상가건물 임대차보호법", "제10조"],
    ["소비자 약관", CONSUMER_TERMS, "b2c_terms", "제3조", "withdrawal_restriction", "전자상거래 등에서의 소비자보호에 관한 법률", "제17조"],
    ["개발 용역", OUTSOURCING_CONTRACT, "outsourcing", "제2조", "penalty", "민법", "제398조"],
    ["공급 계약", SUPPLY_CONTRACT, "sale", "제2조", "price_change", "약관의 규제에 관한 법률", "제10조"],
    ["근태 지침", REMOTE_WORK_GUIDELINE, "work_rules", "제2조", "overtime_pay", "근로기준법", "제56조"],
    ["비밀유지", NDA_CONTRACT, "nda", "제3조", "penalty", "민법", "제398조"],
  ])("%s keeps its own issue attached to a verified statute", async (_name, text, type, number, id, law, jo) => {
    const review = await reviewContract(text, fakeSources());
    expect(review.document.type).toBe(type);
    const clause = review.clauses.find((entry) => entry.number === number);
    const issue = clause?.issues.find((entry) => entry.id === id);
    expect(issue?.lawStatus).toBe("found");
    expect(issue?.laws).toContain(`${law}\0${jo}`);
    expect(review.laws[`${law}\0${jo}`]).toMatchObject({ law, jo, excerpt: `${jo}의 본문입니다.` });
    expect(issue?.fact).toBeTruthy();
    expect(issue?.suggestion).toMatch(/\S/u);
    expect(issue?.suggestion).not.toMatch(/무효입니다|위법입니다|불법입니다/u);
  });

  it("distinguishes high, medium and clean reviews from distinct issues, not repeated clauses or citation counts", async () => {
    const mediumText = [
      ...B2B_SERVICE_CONTRACT.split("\n").slice(0, 2),
      B2B_SERVICE_CONTRACT.split("\n")[3], // auto renewal
      B2B_SERVICE_CONTRACT.split("\n")[6], // termination restriction
      B2B_SERVICE_CONTRACT.split("\n")[12], // jurisdiction
    ].join("\n");
    const [high, medium, clean] = await Promise.all([
      reviewContract(B2B_SERVICE_CONTRACT, fakeSources({ async findLaw() { return undefined; }, async searchPrecedents() { return []; } })),
      reviewContract(mediumText, fakeSources()),
      reviewContract(CLEAN_WORK_RULES, fakeSources()),
    ]);
    expect(high.risk.level).toBe("높음");
    expect(medium.risk.level).toBe("보통");
    expect(medium.risk.high).toBe(0);
    expect(clean.document.type).toBe("work_rules");
    expect(clean.risk).toMatchObject({ level: "낮음", score: 0 });
    expect(clean.clauses).toEqual([]);
    expect(high.clauses.find((clause) => clause.number === "제4조")?.issues.map((issue) => issue.id))
      .toEqual(expect.arrayContaining(["service_suspension", "exemption"]));
    expect(high.risk).toEqual(documentRisk(reviewClauses(splitClauses(B2B_SERVICE_CONTRACT), classifyDocument(B2B_SERVICE_CONTRACT))));
  });

  it("keeps unnumbered privacy rules, short and long clauses, duplicate issues and an ambiguous notice separate", () => {
    const privacy = issuesOf(PRIVACY_CCTV_GUIDELINE);
    expect(privacy.profile.type).toBe("work_rules");
    expect(privacy.clauses.filter((clause) => clause.issues.some((issue) => issue.id === "cctv_audio")).map((clause) => clause.text))
      .toContain("영상정보처리기기에는 음성 녹음 기능을 함께 사용할 수 있다.");
    const b2bHead = B2B_SERVICE_CONTRACT.split("\n").slice(0, 2).join("\n");
    const repeated = `${b2bHead}\n제1조(위약금) ${NDA_CONTRACT.split("\n")[4].replace(/^제3조\(위약벌\)\s*/u, "")}\n제2조(위약금) ${NDA_CONTRACT.split("\n")[4].replace(/^제3조\(위약벌\)\s*/u, "")}`;
    const repeatedIssues = issuesOf(repeated).clauses.flatMap((clause) => clause.issues);
    expect(repeatedIssues.map((issue) => issue.id)).toEqual(["penalty", "penalty"]);
    expect(documentRisk(issuesOf(repeated).clauses).high).toBe(1);
    const long = `${b2bHead}\n제1조(목적) ${"서비스의 제공 범위와 대가를 정한다. ".repeat(30)}\n제2조(위약금) 이용자는 잔여 이용료의 200%를 위약금으로 지급한다.`;
    expect(issuesOf(long).clauses.find((clause) => clause.number === "제2조")?.issues.map((issue) => issue.id)).toContain("penalty");
    expect(issuesOf("비밀유지계약서\n갑 주식회사 알파와 을 주식회사 베타는 비밀정보의 보호에 합의한다.\n위약벌\n위반 시 위약벌로 1억 원을 지급한다.").clauses
      .find((clause) => clause.title === "위약벌")?.issues.map((issue) => issue.id)).toContain("penalty");
    expect(issuesOf(AMBIGUOUS_NOTICE).profile.type).toBe("unknown");
    expect(issuesOf(AMBIGUOUS_NOTICE).clauses.flatMap((clause) => clause.issues)).toEqual([]);
  });

  it("does not confuse numbered headings, in-text article references or conflicting safe and risky terms", () => {
    const text = [
      ...B2B_SERVICE_CONTRACT.split("\n").slice(0, 2),
      "제1조(기준) 서비스는 관련 법령 제7조(책임)에 따라 제공한다.",
      "제2조(이용요금) 제공자는 이용요금을 변경할 수 있다. 변경 시에는 이용자에게 사전에 통지한다.",
      "제3조(책임) 제공자는 어떠한 경우에도 책임을 지지 않는다.",
    ].join("\n");
    const clauses = issuesOf(text).clauses;
    expect(clauses.map((clause) => clause.number)).toEqual(["제1조", "제2조", "제3조"]);
    expect(clauses[0].issues).toEqual([]);
    expect(clauses[1].issues.map((issue) => issue.id)).toContain("price_change");
    expect(clauses[2].issues.map((issue) => issue.id)).toContain("exemption");
    expect(issuesOf(CLEAN_WORK_RULES).clauses.flatMap((clause) => clause.issues)).toEqual([]);
  });

  it("retains article suffixes while splitting a copied run-on document and leaves a cross-reference inside its clause", () => {
    const text = [
      ...B2B_SERVICE_CONTRACT.split("\n").slice(0, 2),
      "제1조(목적) 제공자는 서비스를 공급한다. 제2조의2(요금) 제공자는 이용요금을 변경할 수 있다.",
      "제3조(책임) 제2조의2(요금)에 따른 통지 절차는 유지한다. 제공자는 어떠한 경우에도 책임을 지지 않는다.",
    ].join("\n");
    const clauses = issuesOf(text).clauses;
    expect(clauses.map((clause) => clause.number)).toEqual(["제1조", "제2조의2", "제3조"]);
    expect(clauses[0].issues).toEqual([]);
    expect(clauses[1].issues.map((issue) => issue.id)).toContain("price_change");
    expect(clauses[2].issues.map((issue) => issue.id)).toEqual(["exemption"]);
  });

  it("distinguishes verified both, statute-only, precedent-only, irrelevant and absent evidence without changing a review point", async () => {
    const penaltyText = [...B2B_SERVICE_CONTRACT.split("\n").slice(0, 2), B2B_SERVICE_CONTRACT.split("\n")[7]].join("\n");
    const variants = {
      both: fakeSources(),
      statute: fakeSources({ async searchPrecedents() { return []; } }),
      precedent: fakeSources({ async findLaw() { return undefined; } }),
      irrelevant: fakeSources({
        async searchPrecedents() { return [{ domain: "precedent", id: "irrelevant", title: "위약금등청구", caseNumber: "2020다9" }]; },
        async holding() { return "[1] 위약금 채권의 단기소멸시효 기산점"; },
      }),
      none: fakeSources({ async findLaw() { return undefined; }, async searchPrecedents() { return []; } }),
    };
    const entries = await Promise.all(Object.entries(variants).map(async ([name, sources]) => [name, await reviewContract(penaltyText, sources)] as const));
    const results = Object.fromEntries(entries);
    const issue = (name: keyof typeof variants) => results[name].clauses[0].issues.find((entry) => entry.id === "penalty")!;
    expect(issue("both")).toMatchObject({ lawStatus: "found", precedentStatus: "found", precedents: ["precedent:2"] });
    expect(issue("statute")).toMatchObject({ lawStatus: "found", precedentStatus: "none", precedents: [] });
    expect(issue("precedent")).toMatchObject({ lawStatus: "none", precedentStatus: "found", laws: [] });
    expect(issue("irrelevant")).toMatchObject({ precedentStatus: "none", precedents: [] });
    expect(issue("none")).toMatchObject({ lawStatus: "none", precedentStatus: "none", laws: [], precedents: [] });
    for (const result of Object.values(results)) {
      const found = result.clauses[0].issues[0];
      expect(found.fact).toContain("200%");
      expect(found.suggestion).toBe(issue("both").suggestion);
      for (const key of found.laws) expect(result.laws[key]?.key).toBe(key);
      for (const key of found.precedents) expect(result.precedents[key]?.key).toBe(key);
      expect(result.risk).toEqual(results.both.risk);
    }
    expect(results.irrelevant.stats.excludedPrecedents).toBeGreaterThan(0);
    expect(results.irrelevant.precedents).toEqual({});
  });

  it("adopts each relevant holding for two different high issues sharing a former search group", async () => {
    const text = [
      ...B2B_SERVICE_CONTRACT.split("\n").slice(0, 2),
      B2B_SERVICE_CONTRACT.split("\n")[4], // price change
      "제4조(서비스 중단) 제공자는 사전 통지 없이 서비스를 중단할 수 있다.",
    ].join("\n");
    const sources = fakeSources({
      async searchPrecedents(query) {
        if (query.includes("일방적 요금")) return [{ domain: "precedent", id: "price", title: "요금 변경 약정", caseNumber: "2024다1" }];
        if (query.includes("서비스 중단")) return [{ domain: "precedent", id: "suspension", title: "서비스 중단 약정", caseNumber: "2024다2" }];
        return [];
      },
      async holding(id) {
        return id === "price" ? "[1] 사업자의 일방적 요금 변경 약관의 효력" : "[1] 서비스 중단 약정의 효력";
      },
    });
    const review = await reviewContract(text, sources);
    const byId = Object.fromEntries(review.clauses.flatMap((clause) => clause.issues.map((issue) => [issue.id, issue] as const)));
    expect(byId.price_change?.precedents).toEqual(["precedent:price"]);
    expect(byId.service_suspension?.precedents).toEqual(["precedent:suspension"]);
    expect(review.precedents["precedent:price"]?.holding).toContain("요금 변경");
    expect(review.precedents["precedent:suspension"]?.holding).toContain("서비스 중단");
  });
  it("does not merge clauses across sampled gaps, and merges repeated findings with all their locations", async () => {
    const segments = [
      { text: "서비스 이용계약 제1조(계약 기간) 당사자는 1년의 기간을 정한다.", batch: 0 },
      { text: "위약금 30%를 지급한다.", batch: 1 },
      { text: "위약금 30%를 지급한다.", batch: 2 },
      { text: "제200조(종료) 자동 연장 1년으로 한다.", batch: 3 },
    ];
    const sources = fakeSources();
    const review = await reviewContract(segments, sources);
    const penalty = review.clauses.flatMap((clause) => clause.issues).filter((issue) => issue.id === "penalty");
    expect(penalty).toHaveLength(1);
    expect(penalty[0].segments).toEqual([1, 2]);
    expect(review.clauses.flatMap((clause) => clause.issues).find((issue) => issue.id === "auto_renewal")?.segments).toEqual([3]);
    for (const list of Object.values(sources.calls)) expect(new Set(list).size).toBe(list.length);
  });

  it("cancels queued lookups instead of reporting an aborted source as absent", async () => {
    const controller = new AbortController();
    const pending = reviewContract(B2B_SERVICE_CONTRACT, fakeSources({
      async findLaw() { controller.abort(); throw new Error("cancelled"); },
    }), Date.now, controller.signal);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("labels incomplete source coverage even if another applicable article was found", async () => {
    const review = await reviewContract("서비스 이용계약. 제1조(면책) 회사는 어떠한 경우에도 책임을 지지 않는다.", fakeSources({
      async findLaw(name) { if (name === "민법") throw new Error("offline"); return { mst: name }; },
    }));
    const exemption = review.clauses.flatMap((clause) => clause.issues).find((issue) => issue.id === "exemption");
    expect(exemption?.lawStatus).toBe("partial");
    expect(exemption?.laws.some((key) => key.startsWith("약관의 규제에 관한 법률") && key.endsWith("제7조"))).toBe(true);
  });
});
