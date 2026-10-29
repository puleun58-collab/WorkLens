import { describe, expect, it } from "vitest";
import { assessProcedureEvidence, identifyProcedureRequirements } from "@/lib/procedure-evidence";
import { researchResult } from "@/lib/law-research-parse";
import type { SupplementArticle } from "@/lib/research-relevance";
import type { EnrichmentSources } from "@/server/research-enrichment";
import { retrieveResearchFollowup } from "@/server/research-followup";

/**
 * Round 3 (PR #347 gate A + F/G forms): smallest general fixes, no
 * article, annex or tier hard-coded. Every positive case has a negative
 * case beside it. The TOC titles below are synthetic rank fixtures: they
 * use only terms the parent body carries, so their scores are exact and
 * the 18-key read budget is what decides the 17th-ranked article.
 */

// Round-2 parent body, verbatim: it carries 처리정지, 수수료, 우송료,
// 수집, 삭제, 정정 and 대리인, but neither 범위 nor 확인.
const PARENT_BODY =
  "제38조(권리행사의 방법 및 절차)\n① 정보주체는 열람, 정정, 삭제, 처리정지, 수집에 관한 권리를 방법ㆍ절차에 따라 대리인에게 하게 할 수 있다. ③ 개인정보처리자는 대통령령으로 정하는 바에 따라 수수료와 우송료를 청구할 수 있다.";
// Scores against the parent body (방법 and 범위 are frame words and do
// not score): 7, 7, 6, 6, 6, 6, 5, 5, 5, 5, 5, 5, 4, 4, 4, 4, then 3, 3.
// Listed in rank order; equal scores keep this order (stable sort).
const TOC_TITLES: Array<{ jo: string; title: string }> = [
  { jo: "제61조", title: "처리정지의 수수료" },
  { jo: "제63조", title: "처리정지의 우송료" },
  { jo: "제76조", title: "처리정지의 수집" },
  { jo: "제77조", title: "처리정지의 삭제" },
  { jo: "제78조", title: "처리정지의 정정" },
  { jo: "제79조", title: "수수료의 우송료" },
  { jo: "제70조", title: "수집의 수수료" },
  { jo: "제71조", title: "삭제의 수수료" },
  { jo: "제72조", title: "정정의 수수료" },
  { jo: "제73조", title: "수집의 우송료" },
  { jo: "제74조", title: "삭제의 우송료" },
  { jo: "제80조", title: "정정의 우송료" },
  { jo: "제60조", title: "처리정지의 방법" },
  { jo: "제62조", title: "수집의 삭제" },
  { jo: "제64조", title: "수집의 정정" },
  { jo: "제65조", title: "삭제의 정정" },
  { jo: "제45조", title: "대리인의 범위 등" },
  { jo: "제46조", title: "대리인의 확인" },
];
const decreeBody = (jo: string, cites38: boolean) =>
  `${jo}(제목)\n${cites38 ? "법 제38조에 따라 대리인의 범위를 정한다." : "법 제35조에 따라 확인 방법을 정한다."}`;
// Competing same-law seed: carries 확인 (which lifts 제46조) but never
// 범위, so it cannot lift 제45조 itself — it can only push 제45조 down.
const SEED_BODY =
  "제11조(대리인의 확인)\n① 대리인은 열람, 정정, 삭제, 처리정지의 방법을 확인하고 수수료와 우송료를 청구할 수 있다.";
const SEED_ARTICLE: SupplementArticle = {
  law: "개인정보 보호법", jo: "제11조", title: "대리인의 확인", excerpt: SEED_BODY, matched: [], explicit: true,
};
const SEED_ENRICHMENT = {
  supplement: { status: "found" as const, articles: [SEED_ARTICLE] },
};

function sources(options: { parent38?: string | null } = {}) {
  const calls: Array<[string, string]> = [];
  const s: EnrichmentSources = {
    async summary() { return undefined; },
    async laws(query) {
      if (query === "개인정보보호법") return [{ name: "개인정보 보호법", mst: "P" }];
      if (query === "개인정보 보호법 시행령") return [{ name: "개인정보 보호법 시행령", mst: "D" }];
      return [];
    },
    async toc(mst) { return mst === "D" ? TOC_TITLES : []; },
    async article(mst, jo) {
      calls.push([mst, jo]);
      if (mst === "P" && jo === "제38조") return options.parent38 === null ? undefined : { text: options.parent38 ?? PARENT_BODY };
      if (mst === "P" && jo === "제11조") return { text: SEED_BODY };
      if (mst === "D") {
        const found = TOC_TITLES.find((entry) => entry.jo === jo);
        if (found) return { text: decreeBody(jo, jo === "제45조") };
      }
      return undefined;
    },
    async interpretations() { return []; },
    async precedents() { return []; },
  };
  return { sources: s, calls };
}
const QUERY = "개인정보보호법 제38조와 시행령의 관계";
const names = (followup: { articles: Array<{ law: string; jo: string }> }) =>
  followup.articles.map((a) => `${a.law} ${a.jo}`);

describe("round 3 §A: named pair keeps its own parent set", () => {
  it("finds the 17th-ranked citing article despite a competing seed", async () => {
    const { sources: s, calls } = sources();
    const followup = await retrieveResearchFollowup("law_system", QUERY, "", SEED_ENRICHMENT, s);
    expect(names(followup)).toContain("개인정보 보호법 시행령 제45조");
    // The seed is not a parent and is never read: 1 parent + 17 tier reads.
    expect(names(followup)).not.toContain("개인정보 보호법 제11조");
    expect(calls.filter(([mst, jo]) => mst === "P" && jo === "제11조")).toEqual([]);
    expect(calls.length).toBe(18);
    expect(followup.report.limited).toBe(true);
  });

  it("still rejects a non-citing body ranked below the citer", async () => {
    const { sources: s } = sources();
    const followup = await retrieveResearchFollowup("law_system", QUERY, "", SEED_ENRICHMENT, s);
    expect(names(followup)).not.toContain("개인정보 보호법 시행령 제46조");
  });

  it("does not substitute a seed when the named article lookup fails", async () => {
    const { sources: s, calls } = sources({ parent38: null });
    const followup = await retrieveResearchFollowup("law_system", QUERY, "", SEED_ENRICHMENT, s);
    expect(names(followup)).toEqual([]);
    expect(calls.filter(([mst, jo]) => mst === "P" && jo === "제11조")).toEqual([]);
  });

  it("keeps the seed path for a law-system question with no named pair", async () => {
    const { sources: s } = sources();
    const followup = await retrieveResearchFollowup(
      "law_system", "개인정보보호법과 시행령의 관계", "", SEED_ENRICHMENT, s);
    expect(names(followup)).toContain("개인정보 보호법 제11조");
  });

  it("keeps the seed path for other modes (scope of the restriction)", async () => {
    const { sources: s } = sources();
    const followup = await retrieveResearchFollowup("action_basis", QUERY, "", SEED_ENRICHMENT, s);
    expect(names(followup)).toContain("개인정보 보호법 제11조");
    expect(names(followup)).toContain("개인정보 보호법 제38조");
  });
});

describe("round 3 §F/G: predicate words are never subjects", () => {
  it("inherits the first subject when the second segment is only a modifier + form", () => {
    expect(identifyProcedureRequirements("행정심판 청구 절차와 필요한 서식")).toEqual([
      { label: "행정심판 청구 절차", kind: "procedure" },
      { label: "행정심판 필요한 서식", kind: "forms" },
    ]);
  });

  it("treats a trailing sentence period the same as no period", () => {
    const expected = [
      { label: "행정심판 청구 절차", kind: "procedure" },
      { label: "행정심판 청구서", kind: "procedure" },
      { label: "행정심판 청구서 서식", kind: "forms" },
    ];
    expect(identifyProcedureRequirements("행정심판 청구 절차와 제출해야 할 청구서 서식을 알려줘.")).toEqual(expected);
    expect(identifyProcedureRequirements("행정심판 청구 절차와 제출해야 할 청구서 서식을 알려줘")).toEqual(expected);
  });

  it("keeps a two-letter noun ending in 한 as a subject", () => {
    expect(identifyProcedureRequirements("행정심판 청구 절차와 기한 연장 서식")).toEqual([
      { label: "행정심판 청구 절차", kind: "procedure" },
      { label: "기한 연장 서식", kind: "forms" },
    ]);
  });

  const ARTICLE_5_DETAIL = [
    "═══ 절차/비용 안내: 행정심판 청구절차 ═══",
    "",
    "▶ 법령 체계 (절차 근거)",
    "[시행규칙] 행정심판법 시행규칙 제5조 (문서의 서식)",
    "행정심판 청구서 등 문서의 서식은 다음 각 호와 같다. 13. 법 제28조 및 영 제20조에 따른 행정심판 청구서: 별지 제30호서식. 청구인은 행정심판 청구서를 작성하여 제출하여야 한다.",
    "",
  ].join("\n");
  const assess = (query: string, text: string) =>
    assessProcedureEvidence(query, researchResult(text), text);

  it("finds the forms requirement through the 시행규칙 제5조 detail block (F)", () => {
    const evidence = assess("행정심판 청구 절차와 필요한 서식", ARTICLE_5_DETAIL);
    const forms = evidence.requirements.find((item) => item.kind === "forms")!;
    expect(forms.status).toBe("found");
    expect(forms.articles.map((article) => `${article.law} ${article.jo}`)).toContain("행정심판법 시행규칙 제5조");
  });

  it("finds the forms requirement through the 시행규칙 제5조 detail block (G, with period)", () => {
    const evidence = assess("행정심판 청구 절차와 제출해야 할 청구서 서식을 알려줘.", ARTICLE_5_DETAIL);
    const forms = evidence.requirements.find((item) => item.kind === "forms")!;
    expect(forms.status).toBe("found");
    expect(forms.articles.map((article) => `${article.law} ${article.jo}`)).toContain("행정심판법 시행규칙 제5조");
  });

  it("does not adopt a form article of an unrelated law", () => {
    const foreign = [
      "═══ 절차/비용 안내 ═══",
      "",
      "▶ 법령 체계 (절차 근거)",
      "[시행규칙] 근로기준법 시행규칙 제5조 (문서의 서식)",
      "근로기준법 관련 문서의 서식은 다음 각 호와 같다. 청구인은 신청서를 작성하여 제출하여야 한다.",
      "",
    ].join("\n");
    const evidence = assess("행정심판 청구 절차와 필요한 서식", foreign);
    const forms = evidence.requirements.find((item) => item.kind === "forms")!;
    expect(forms.status).toBe("none");
    expect(forms.articles).toEqual([]);
  });
});
