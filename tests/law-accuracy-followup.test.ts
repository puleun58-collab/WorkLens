import { describe, expect, it } from "vitest";
import { assessLawSystem } from "@/lib/law-system-evidence";
import { delegatingDetailBlocks, directDelegationCount } from "@/lib/law-system-evidence";
import { mergeDuplicateAnnexSections, type ResearchSection } from "@/lib/law-research-parse";
import { lawNameRunsInText, researchEvidenceSources } from "@/lib/research-relevance";
import { integratedEvidenceStatus } from "@/lib/research-status";
import { enrichResearch, lookupIssue, type EnrichmentSources } from "@/server/research-enrichment";

function baseSources(overrides: Partial<EnrichmentSources> = {}): EnrichmentSources {
  return {
    async summary() { return undefined; },
    async laws() { return []; },
    async toc() { return []; },
    async article() { return undefined; },
    async interpretations() { return []; },
    async precedents() { return []; },
    ...overrides,
  };
}

describe("follow-up: title-subject guard sanction means", () => {
  it("adopts 식품위생법 제82조 for an 영업정지 question despite the 과징금 title token", () => {
    const adopted = researchEvidenceSources("", "영업정지 요건", {
      supplement: { status: "found", articles: [{
        law: "식품위생법", jo: "제82조", title: "영업정지 등의 처분에 갈음하여 부과하는 과징금 처분",
        excerpt: "영업자가 제75조제1항에 해당하는 경우에는 영업정지 처분을 갈음하여 과징금을 부과할 수 있다.",
        matched: ["영업정지"],
      }] },
    }, ["식품위생법"]);
    expect(adopted.articles).toEqual([{ law: "식품위생법", jo: "제82조" }]);
  });
});

describe("follow-up: precedent law restriction", () => {
  const direct = { rank: "direct" as const, matched: ["영업정지"] };
  it("withholds an unrelated-regime precedent from status while keeping a same-regime one", () => {
    const otherLaw = researchEvidenceSources("", "식품위생법 영업정지 요건", {
      precedents: { "613065": direct },
      precedentExcerpts: { "613065": "전자상거래법상 영업정지 갈음 과징금 사건의 판시사항: 영업정지 처분이 문제된다." },
    });
    expect(otherLaw.precedents).toEqual([]);
    const sameLaw = researchEvidenceSources("", "식품위생법 영업정지 요건", {
      precedents: { "1": direct },
      precedentExcerpts: { "1": "식품위생법상 영업정지 사건의 판시사항: 영업정지 처분이 문제된다." },
    });
    expect(sameLaw.precedents).toEqual(["1"]);
    const unnamed = researchEvidenceSources("", "영업정지 요건", {
      precedents: { "613065": direct },
      precedentExcerpts: { "613065": "전자상거래법상 영업정지 갈음 과징금 사건의 판시사항: 영업정지 처분이 문제된다." },
    });
    expect(unnamed.precedents).toEqual(["613065"]);
  });

  it("does not read 방법-style words as cited regimes", () => {
    expect(lawNameRunsInText("판단하는 방법에 관한 판시사항")).toEqual([]);
    expect(lawNameRunsInText("시행령에 따라 정한 기준과 관계법령에 따른 처분")).toEqual([]);
    expect(lawNameRunsInText("전자상거래법상 영업정지 사건")).toContain("전자상거래법");
  });
});

describe("follow-up: named-law supplement and citation follow-up", () => {
  const foodSources = (article82: string, article75?: string) => baseSources({
    async laws(query) { return query === "식품위생법" ? [{ name: "식품위생법", mst: "M" }] : []; },
    async toc(mst) {
      return mst === "M" ? [{ jo: "제82조", title: "영업정지 등의 처분에 갈음하여 부과하는 과징금 처분" }] : [];
    },
    async article(mst, jo) {
      if (mst !== "M") return undefined;
      if (jo === "제82조") return { text: article82, effectiveDate: "20261008" };
      if (jo === "제75조" && article75) return { text: article75, effectiveDate: "20261008" };
      return undefined;
    },
  });

  it("finds 제82조 for a named-law question whose only keyword is the generic 정지", async () => {
    const sources = foodSources(
      "제82조(영업정지 등의 처분에 갈음하여 부과하는 과징금 처분)\n영업정지 처분을 갈음하여 과징금을 부과할 수 있다.");
    const enrichment = await enrichResearch("action_basis", "식품위생법상 정지 요건", "", sources);
    expect(enrichment.supplement?.articles.map((article) => `${article.law} ${article.jo}`)).toEqual(["식품위생법 제82조"]);
  });

  it("follows 제82조's body citation to 제75조 in the same law", async () => {
    const sources = foodSources(
      "제82조(영업정지 등의 처분에 갈음하여 부과하는 과징금 처분)\n영업자가 제75조제1항에 해당하는 경우에는 영업정지 처분을 갈음하여 과징금을 부과할 수 있다.",
      "제75조(허가취소 등)\n영업정지 또는 허가취소 처분을 할 수 있다.");
    const enrichment = await enrichResearch("full_research", "영업정지 요건", "", sources, undefined, { extraNamed: ["식품위생법"] });
    expect(enrichment.supplement?.articles.map((article) => `${article.law} ${article.jo}`)).toEqual(["식품위생법 제82조", "식품위생법 제75조"]);
  });
});

describe("follow-up: explicit-pair gate for relation issues", () => {
  it("qualifies the question's own 제38조 for a 법령 위계 issue when its text states the delegation", async () => {
    const sources = baseSources({
      async laws(query) { return query === "개인정보보호법" ? [{ name: "개인정보보호법", mst: "P" }] : []; },
      async article(mst, jo) {
        return mst === "P" && jo === "제38조"
          ? { text: "제38조(대리인에 의한 권리행사)\n정보주체는 대통령령으로 정하는 방법·절차에 따라 대리인을 통하여 권리를 행사할 수 있다." }
          : undefined;
      },
    });
    const lookup = await lookupIssue("법령 위계", [], sources, () => false,
      ["개인정보보호법"], ["개인정보보호법", "제38조", "시행령", "관계"]);
    expect(lookup.articles.map((article) => `${article.law} ${article.jo}`)).toContain("개인정보보호법 제38조");
  });
});

describe("follow-up: law-system delegation blocks", () => {
  const text = [
    "═══ 법체계 확인: 개인정보 보호법 ═══", "",
    "▶ 3단 비교",
    "[시행령] 개인정보 보호법 시행령 제45조 (대리인의 범위 등)",
    "법 제38조에 따라 정보주체를 대리할 수 있는 자는 다음과 같다.",
  ].join("\n");
  it("counts the delegating article and reconstructs it once, never twice", () => {
    expect(directDelegationCount(text, ["제38조"])).toBe(1);
    expect(assessLawSystem(text, "개인정보보호법 제38조와 시행령의 관계").status).toBe("partial");
    const blocks = delegatingDetailBlocks(text, ["제38조"], "");
    expect(blocks).toContain("제45조");
    expect(blocks).toContain("대리인의 범위 등");
    expect(delegatingDetailBlocks(text, ["제38조"], text)).toBe("");
  });
});

describe("follow-up: annex duplicate rendering", () => {
  const annexSection = (heading: string, law: string): ResearchSection => ({
    heading, lines: [], status: "available", unavailable: false, markers: [], kind: "annex",
    annex: { total: 55, entries: [
      { title: "(승계)집행문 (서식)", code: "001602", law },
      { title: "간접강제 신청서 (서식)", code: "004202", law },
    ] },
  } as ResearchSection);
  it("drops a second annex section whose entries are all already shown", () => {
    const merged = mergeDuplicateAnnexSections([
      annexSection("▶ 행정심판법 별표/서식", "행정심판법 시행규칙"),
      annexSection("▶ 시행규칙 별표/서식", "행정심판법 시행규칙"),
    ]);
    expect(merged).toHaveLength(1);
    const withNew = mergeDuplicateAnnexSections([
      annexSection("▶ 행정심판법 별표/서식", "행정심판법 시행규칙"),
      { ...annexSection("▶ 다른 법령 별표/서식", "다른 법령"), annex: { total: 3, entries: [{ title: "새 서식", code: "009999", law: "다른 법령" }] } },
    ]);
    expect(withNew).toHaveLength(2);
  });
});

describe("follow-up: integrated evidence status", () => {
  it("requires an adopted article for matched and caps relation-only answers at partial", () => {
    expect(integratedEvidenceStatus(2, 2, true, false)).toBe("matched");
    expect(integratedEvidenceStatus(2, 2, false, false)).toBe("partial");
    expect(integratedEvidenceStatus(2, 2, true, true)).toBe("partial");
    expect(integratedEvidenceStatus(1, 2, true, false)).toBe("partial");
    expect(integratedEvidenceStatus(0, 2, false, false)).toBe("unverified");
  });
});
