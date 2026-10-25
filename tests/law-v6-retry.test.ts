import { describe, expect, it } from "vitest";
import { researchResult } from "@/lib/law-research-parse";
import { questionSubjectTerms, questionTerms, questionTermsSubjectLess, researchEvidenceSources } from "@/lib/research-relevance";
import { rereadShownArticles, type EnrichmentSources } from "@/server/research-enrichment";

/**
 * The composition fullResearch runs for a bare-phrase issue, with the chain
 * texts shaped like the live recordings: the bare "조사 의무" chain is led
 * by an unrelated 해양 article and holds no 76조의3, while the
 * subject-qualified retry chain holds 76조의3 behind its truncated preview.
 */

const FULL_QUESTION = "직장 내 괴롭힘이 신고되면 사용자는 어떤 의무가 있나요? 조사, 피해자 보호, 가해자 조치에 대해 알려주세요.";
const REQUEST_TERMS = [...new Set([...questionTerms(FULL_QUESTION), ...questionTerms("피해자 보호")])];

const BARE_CHAIN = [
  "═══ 종합 리서치: 조사 의무 ═══", "",
  "▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 10건):", "",
  "해양과학조사법 시행령", "   제0002조 (대한민국 영해에서의 조사에 대한 허가절차 등)", "   제2조(대한민국 영해에서의 조사에 대한 허가절차 등)",
  " ① 법 제6조제2항에 따라 조사계획서에 포함되어야 할 사항은 별표 1과 같다.",
  "   시행: 2025.01.01 | 해양수산부", "",
].join("\n");

const QUALIFIED_CHAIN = [
  "═══ 종합 리서치: 직장 내 괴롭힘 ═══", "",
  "▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 10건):", "",
  "근로기준법", "   제0076조의3 (직장 내 괴롭힘 발생 시 조치)", "   제76조의3(직장 내 괴롭힘 발생 시 조치)",
  " ① 누구든지 직장 내 괴롭힘 발생 사실을 알게 된 경우 그 사실을 사용자에게 신고할 수 있다.",
  "  ② 사용자는 제1항에 따른 신고를 접수하거나 직장 내 괴롭힘 발생 사실을 인지한 경우에는 지체 없이 당사자 등을 대상으로 그 사실 확인을 위하여 객관적으로 조사를 실시하여야 한다. <개정 2021.4.13>",
  "  ③...",
  "   시행: 2026.10.08 | 고용노동부", "",
].join("\n");

const ARTICLE_76_3 = [
  "제76조의3 직장 내 괴롭힘 발생 시 조치",
  "제76조의3(직장 내 괴롭힘 발생 시 조치)",
  "① 누구든지 직장 내 괴롭힘 발생 사실을 알게 된 경우 그 사실을 사용자에게 신고할 수 있다.",
  "② 사용자는 제1항에 따른 신고를 접수하거나 직장 내 괴롭힘 발생 사실을 인지한 경우에는 지체 없이 당사자 등을 대상으로 그 사실 확인을 위하여 객관적으로 조사를 실시하여야 한다. <개정 2021.4.13>",
  "③ 사용자는 제2항에 따른 조사 기간 동안 직장 내 괴롭힘과 관련하여 피해를 입은 근로자 또는 피해를 입었다고 주장하는 근로자(이하 \"피해근로자등\"이라 한다)를 보호하기 위하여 필요한 경우 해당 피해근로자등에 대하여 근무장소의 변경, 유급휴가 명령 등 적절한 조치를 하여야 한다. 이 경우 사용자는 피해근로자등의 의사에 반하는 조치를 하여서는 아니 된다.",
  "④ 사용자는 제2항에 따른 조사 결과 직장 내 괴롭힘 발생 사실이 확인된 때에는 피해근로자가 요청하면 근무장소의 변경, 배치전환, 유급휴가 명령 등 적절한 조치를 하여야 한다.",
].join("\n");

function stubSources(): EnrichmentSources {
  return {
    async summary() { return undefined; },
    async laws(query) { return query === "근로기준법" ? [{ name: "근로기준법", mst: "285279" }] : []; },
    async toc() { return []; },
    async article(mst, jo) {
      return mst === "285279" && jo === "제76조의3"
        ? { text: ARTICLE_76_3, name: "근로기준법", effectiveDate: "20261008" } : undefined;
    },
    async interpretations() { return []; },
    async precedents() { return []; },
  };
}

describe("bare-phrase issues and the subject-qualified retry", () => {
  it("names the request subjects for the retry phrase and flags bare phrases as subject-less", () => {
    expect(questionSubjectTerms(FULL_QUESTION)).toEqual(["직장", "괴롭힘"]);
    expect(questionTermsSubjectLess("피해자 보호")).toBe(true);
    expect(questionTermsSubjectLess("조사 의무")).toBe(true);
    expect(questionTermsSubjectLess("직장 내 괴롭힘 보호")).toBe(false);
    expect([...questionSubjectTerms(FULL_QUESTION), "피해자 보호"].join(" ")).toBe("직장 괴롭힘 피해자 보호");
  });

  it("correctly adopts nothing from the bare chain, including its unrelated 조사 article", () => {
    for (const issue of ["조사 의무", "피해자 보호", "가해자 조치"]) {
      expect(researchEvidenceSources(BARE_CHAIN, issue, undefined, REQUEST_TERMS).articles).toEqual([]);
    }
    // The re-read cannot invent the core article either: the only
    // title-matched shown article belongs to another regime's law.
    const shown = researchResult(BARE_CHAIN).sections.flatMap((section) => section.articles ?? []);
    expect(shown).toHaveLength(1);
  });

  it("recovers the core article for a bare issue from the qualified retry chain via the full-text re-read", async () => {
    const shown = researchResult(QUALIFIED_CHAIN).sections.flatMap((section) => section.articles ?? []);
    expect(shown.map((article) => `${article.law} ${article.jo}`)).toEqual(["근로기준법 제76조의3"]);
    // From the truncated preview alone the bare issue cannot adopt: the
    // preview stops before the protection clause.
    expect(researchEvidenceSources(QUALIFIED_CHAIN, "피해자 보호", undefined, REQUEST_TERMS).articles).toEqual([]);
    // The re-read returns the full-text excerpt, and the same rules then adopt it.
    const candidateTerms = [...new Set([...questionTerms("피해자 보호"), ...questionTerms(FULL_QUESTION)])];
    const reread = await rereadShownArticles(shown, candidateTerms, stubSources(), () => false);
    expect(reread).toHaveLength(1);
    expect(reread[0].excerpt).toContain("보호하기 위하여");
    const adopted = researchEvidenceSources(QUALIFIED_CHAIN, "피해자 보호",
      { supplement: { status: "found", articles: reread } }, REQUEST_TERMS);
    expect(adopted.articles).toEqual([{ law: "근로기준법", jo: "제76조의3" }]);
  });
});
