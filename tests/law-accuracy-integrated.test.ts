import { describe, expect, it } from "vitest";
import { assessLawSystem } from "@/lib/law-system-evidence";
import { isDefinitionTitle, researchEvidenceSources } from "@/lib/research-relevance";
import { enrichResearch, type EnrichmentSources } from "@/server/research-enrichment";
import { lawDisplayText } from "@/lib/law-display";
import { articleHeadingText } from "@/lib/law-article-target";
import { researchResult } from "@/lib/law-research-parse";
import { assessProcedureEvidence } from "@/lib/procedure-evidence";
import { classifyDocument, extractKeyFacts, reviewClauses, splitClauses } from "@/lib/contract-review";

// ── 2단계: 위임 판정 — 묻는 조문과 대조 ────────────────────────────────

const DELEGATION_TEXT = `═══ 법체계 확인: 개인정보 보호법 ═══
법령명: 개인정보 보호법

▶ 3단 비교 (법률·시행령·시행규칙)
[시행령] 개인정보 보호법 시행령 제45조 (개인정보처리방침의 수립 및 공개)
법 제38조에 따라 개인정보처리자는 개인정보처리방침을 정하여 공개하여야 한다.

[시행규칙] 개인정보 보호법 시행규칙 제3조 (개인정보 보호책임자)
법 제2조에 따라 개인정보 보호책임자를 지정하여야 한다.

▶ 핵심 조문
개인정보 보호법
제38조 개인정보처리방침의 수립 및 공개
개인정보처리자는 대통령령으로 정하는 바에 따라 개인정보처리방침을 정하여야 한다.
`;

describe("assessLawSystem with the asked article", () => {
  it("counts only an anchor citing the asked article as a direct delegation", () => {
    const result = assessLawSystem(DELEGATION_TEXT, "개인정보보호법 제38조와 시행령의 관계");
    const decree = result.items.find((item) => item.label === "시행령")!;
    const rule = result.items.find((item) => item.label === "시행규칙")!;
    expect(decree.status).toBe("found");
    expect(decree.detail).toContain("법률에서 위임한 사항 확인 1건");
    expect(rule.status).toBe("viewed");
    expect(rule.detail).toContain("위임 관련 표현 발견 1건");
    expect(rule.detail).toContain("질문한 조항과 참조 조항이 다름");
    // One direct tier only: partial, never matched from a mismatched anchor.
    expect(result.status).toBe("partial");
  });

  it("does not confirm any tier from anchors citing only other articles", () => {
    const result = assessLawSystem(DELEGATION_TEXT, "개인정보보호법 제99조와 시행령의 관계");
    expect(result.status).toBe("viewed");
    expect(result.items.filter((item) => item.label !== "법률").map((item) => item.status)).toEqual(["viewed", "viewed"]);
  });

  it("accepts an explicit articles input and keeps the no-question behaviour", () => {
    const viaArticles = assessLawSystem(DELEGATION_TEXT, undefined, ["제38조"]);
    expect(viaArticles.items.find((item) => item.label === "시행령")?.status).toBe("found");
    const noQuestion = assessLawSystem(DELEGATION_TEXT);
    expect(noQuestion.status).toBe("matched");
    expect(noQuestion.items.find((item) => item.label === "시행령")?.detail).toContain("위임 연결 1건");
  });

  it("counts an unprefixed delegation phrase separately, never as a direct link", () => {
    const text = `═══ 법체계 확인: 개인정보 보호법 ═══
▶ 3단 비교 (법률·시행령·시행규칙)
[시행령] 개인정보 보호법 시행령 제45조 (개인정보처리방침의 수립 및 공개)
대통령령으로 정하는 바에 따라 개인정보처리방침을 공개하여야 한다.
▶ 핵심 조문
개인정보 보호법
`;
    const result = assessLawSystem(text, "개인정보보호법 제38조와 시행령의 관계");
    expect(result.items.find((item) => item.label === "시행령")?.status).toBe("viewed");
    expect(result.items.find((item) => item.label === "시행령")?.detail).toContain("위임 대상 조항 확인 필요 1건");
    expect(result.status).toBe("viewed");
  });
});

// ── 2단계: 핵심 근거 선택 — 정의 역할·일반 용어 단독 ────────────────────

function chainText(article: string, body: string): string {
  return [
    "═══ 종합 리서치: 식품위생법상 정지 요건 ═══", "",
    "▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 1건):", "",
    "식품위생법", `   ${article}`, `   ${article.replace(/\s+/gu, "")}`, ` ${body}`,
    "   시행: 2024.01.01 | 식품의약품안전처", "",
  ].join("\n");
}

describe("researchEvidenceSources role and generic-term rules", () => {
  it("does not adopt an article on a single generic term alone", () => {
    const text = chainText("제0075조 (영업정지)", "영업정지 처분을 할 수 있다. 정지 기간은 1개월 이내로 한다.");
    // questionTerms("식품위생법상 정지 요건") → ["식품위생법", "정지"]: one generic term only.
    expect(researchEvidenceSources(text, "식품위생법상 정지 요건").articles).toEqual([]);
    expect(hasNoAdoption(text, "식품위생법상 정지 요건")).toBe(true);
  });

  it("adopts a subject term (영업정지) when its body addresses the issue", () => {
    const text = chainText("제0075조 (영업정지)", "영업정지 처분은 위반 행위의 경중에 따라 영업정지를 명할 수 있다.");
    const sources = researchEvidenceSources(text, "식품위생법 영업정지 요건");
    expect(sources.articles).toContainEqual({ law: "식품위생법", jo: "제75조" });
  });

  it("does not adopt a definition article on its title alone", () => {
    const text = chainText("제0002조 (영업정지 정의)", "이 법에서 사용하는 용어의 뜻은 다음 각 호와 같다.");
    expect(isDefinitionTitle("영업정지 정의")).toBe(true);
    expect(researchEvidenceSources(text, "식품위생법 영업정지 요건").articles).toEqual([]);
  });
});

function hasNoAdoption(text: string, query: string): boolean {
  return researchEvidenceSources(text, query).articles.length === 0;
}

// ── 2단계: 보충 정렬 — 주제어 커버리지, 정의 뒤로 ───────────────────────

describe("supplement ordering by role", () => {
  it("ranks a substantive article before a definition article with the same matched count", async () => {
    const sources: EnrichmentSources = {
      async summary() { return undefined; },
      async laws(query) { return query === "식품위생법" ? [{ name: "식품위생법", mst: "1" }] : []; },
      async toc(mst) {
        return mst === "1" ? [
          { jo: "제2조", title: "영업정지의 정의" },
          { jo: "제75조", title: "영업정지" },
        ] : [];
      },
      async article(mst, jo) {
        if (mst !== "1") return undefined;
        return jo === "제2조"
          ? { text: "제2조(영업정지의 정의)\n① 이 법에서 사용하는 용어의 뜻은 다음과 같다.", effectiveDate: "20240101" }
          : { text: "제75조(영업정지)\n① 영업정지 처분을 할 수 있다.", effectiveDate: "20240101" };
      },
      async interpretations() { return []; },
      async precedents() { return []; },
    };
    const enrichment = await enrichResearch("full_research", "식품위생법 영업정지 요건", "", sources);
    const articles = enrichment.supplement?.articles ?? [];
    expect(articles.map((article) => article.jo)).toEqual(["제75조", "제2조"]);
    expect(articles.find((article) => article.jo === "제2조")?.role).toBe("definition");
    expect(articles.find((article) => article.jo === "제75조")?.role).toBe("other");
    expect(articles.find((article) => article.jo === "제75조")?.stage).toBe("supplement");
  });
});

// ── 3단계: 별표·서식 — 원문 단계 분리·관련 후보·코드/별지 구분 ───────────

describe("procedure annex origin stage and related candidates", () => {
  const text = `═══ 절차/비용 안내: 행정심판 제출서류 ═══

▶ 행정심판법 별표/서식
법령명: 행정심판법
별표/서식 목록 (총 55건):

1. [별지 제1호서식] 심판청구서
  관련법령: 행정심판법 시행규칙

2. [별지 제2호서식] 심판청구 보정서
  관련법령: 행정심판법 시행규칙

3. [001602] (승계)집행문 (서식)
  관련법령: 행정심판법 시행규칙
`;
  it("keeps the law-name count, adds title-correspondence candidates, and never claims an origin step", () => {
    const evidence = assessProcedureEvidence("행정심판 제출서류", researchResult(text), text);
    expect(evidence.annexOriginStage).toBe("list-only");
    expect(evidence.annexTruncated).toBe(true);
    const forms = evidence.requirements.find((item) => item.kind === "forms")!;
    expect(forms.annexCount).toBe(3);
    expect(forms.annexOriginStage).toBe("list-only");
    expect(forms.annexRelatedCandidates).toContain("별지 제1호서식 심판청구서");
    expect(forms.annexRelatedCandidates).toContain("별지 제2호서식 심판청구 보정서");
    // Overall and requirement statuses are unchanged by the additive stage.
    expect(evidence.overall).toBe("viewed");
  });

  it("keeps an upstream internal code apart from a 별지 label", () => {
    const annex = researchResult(text).sections.find((section) => section.kind === "annex")!.annex!;
    expect(annex.entries[0]).toMatchObject({ title: "심판청구서", formLabel: "별지 제1호서식" });
    expect(annex.entries[2]).toMatchObject({ title: "(승계)집행문 (서식)", code: "001602" });
    expect(annex.entries[2].formLabel).toBeUndefined();
  });
});

// ── 2단계: 문서 검토 택소노미 확장·축소 ────────────────────────────────

function docIssues(text: string) {
  const profile = classifyDocument(text);
  return { profile, ids: reviewClauses(splitClauses(text), profile).flatMap((clause) => clause.issues.map((issue) => issue.id)) };
}

describe("contract-review taxonomy fixes", () => {
  it("fires service suspension on a no-notice 정지 clause", () => {
    const { ids } = docIssues("제5조(서비스 정지) 회사는 사전 통지 없이 서비스를 일시 정지할 수 있다.");
    expect(ids).toContain("service_suspension");
  });

  it("fires exemption on 부담하지 않 wording", () => {
    const { ids } = docIssues("제8조(면책) 회사는 어떠한 경우에도 책임을 부담하지 않는다.");
    expect(ids).toContain("exemption");
  });

  it("fires data transfer for a 제휴사 recipient", () => {
    const { ids } = docIssues("제9조(개인정보 제공) 회사는 개인정보를 제휴사에게 제공할 수 있다.");
    expect(ids).toContain("data_transfer");
  });

  it("narrows policy delegation to delegation/priority wording, not a bare mention", () => {
    const bare = docIssues("제5조(준거) 이 계약의 운영정책은 별도로 게시한다.");
    expect(bare.ids).not.toContain("policy_delegation");
    const delegated = docIssues("제12조(운영정책) 이 계약에 정하지 않은 사항은 운영정책에 따르며, 최신 운영정책이 우선한다.");
    expect(delegated.ids).toContain("policy_delegation");
  });

  it("fires a separate service-monitoring issue for a B2B voice-record clause", () => {
    const text = [
      "서비스 이용계약",
      "제공자는 이용자에게 서비스를 제공하며 이용자는 이용료를 지급한다.",
      "제10조(모니터링) 제공자는 서비스 품질 향상을 위해 이용자의 음성 기록을 수집할 수 있다.",
    ].join("\n");
    const { profile, ids } = docIssues(text);
    expect(profile.type).toBe("b2b_service");
    expect(ids).toContain("service_monitoring");
  });

  it("extracts a table-form period and a 전에 deadline as key facts", () => {
    const clauses = splitClauses("제4조(계약기간) 계약기간은 다음과 같다.\n2026.10.01. ~ 2027.09.30\n제6조(해지) 고객은 30일 전에 서면으로 통지하여 해지할 수 있다.");
    const facts = extractKeyFacts(clauses);
    expect(facts).toContainEqual(expect.objectContaining({ label: "계약기간", value: "2026.10.01. ~ 2027.09.30" }));
    expect(facts.some((fact) => fact.label === "통지 기한" && fact.value.includes("30일 전"))).toBe(true);
  });
});

// ── 4단계: 표시 — 법령ID 제거·조문번호 중복 제거 ───────────────────────

describe("display unification", () => {
  it("drops 법령ID rows from default display text while keeping the law name", () => {
    expect(lawDisplayText("법령ID: 011357 | MST: 283839 | 구분: 법률")).toBe("구분: 법률");
    expect(lawDisplayText("법령명: 개인정보 보호법\n법령ID: 011357")).toBe("법령명: 개인정보 보호법");
    expect(lawDisplayText("개인정보 보호법 | 법령ID: 011357")).toBe("개인정보 보호법");
  });

  it("prints a duplicated article number once", () => {
    expect(articleHeadingText("식품위생법", "제2조", "제2조(정의)")).toBe("식품위생법 제2조(정의)");
    expect(articleHeadingText("식품위생법", "제4조의2", "제4조의2(특례)")).toBe("식품위생법 제4조의2(특례)");
    expect(articleHeadingText("식품위생법", "제75조", "영업정지")).toBe("식품위생법 제75조 영업정지");
    expect(articleHeadingText("식품위생법", "제75조", "제76조(다른 조문)")).toBe("식품위생법 제75조 제76조(다른 조문)");
  });
});
