import { describe, expect, it } from "vitest";
import { citesParent } from "@/lib/research-citations";
import { lawNamesInQuery, parseExplicitIdentities } from "@/lib/law-identity";
import { assessLawSystem, delegatingDetailBlocks } from "@/lib/law-system-evidence";
import { researchEvidenceSources, splitActionMatches, type SupplementArticle } from "@/lib/research-relevance";
import { retrieveAnnexes, type AnnexReader } from "@/server/research-annex";
import { lookupIssue, type EnrichmentSources } from "@/server/research-enrichment";
import { retrieveResearchFollowup } from "@/server/research-followup";

/**
 * Residual defects from .tmp-residual-diag/DIAGNOSIS.md §1/§2/§3, fixed in
 * the smallest general scope: no article, annex or tier is hard-coded, and
 * every positive case has a negative case beside it. Fixture excerpts are
 * the captured 제75조 / 제38조 texts, not inventions.
 */

const ARTICLE_75_EXCERPT =
  "① 식품의약품안전처장 또는 특별자치시장ㆍ특별자치도지사ㆍ시장ㆍ군수ㆍ구청장은 영업자가 다음 각 호의 어느 하나에 해당하는 경우에는 " +
  "대통령령으로 정하는 바에 따라 영업허가 또는 등록을 취소하거나 6개월 이내의 기간을 정하여 그 영업의 전부 또는 일부를 정지하거나 " +
  "영업소 폐쇄를 명할 수 있다. 다만, 식품접객영업자가 제13호를 위반한 경우로서 청소년의 신분증 위조ㆍ변조 또는 도용으로 " +
  "식품접객영업자가 청소년인 사실을 알지 못하였거나 폭행 또는 협박으로 청소년임을 확인하지 못한 사정이 인정되는 경우에는 " +
  "대통령령으로 정하는 바에 따라 해당 행정처분을 면제할 수 있다.";

const ARTICLE_38_EXCERPT =
  "① 정보주체는 제35조에 따른 열람, 제36조에 따른 정정ㆍ삭제, 제37조에 따른 처리정지 및 동의 철회를 문서 등 " +
  "대통령령으로 정하는 방법ㆍ절차에 따라 대리인에게 하게 할 수 있다. " +
  "③ 개인정보처리자는 열람등요구를 하는 자에게 대통령령으로 정하는 바에 따라 수수료와 우송료를 청구할 수 있다.";

const article75 = (overrides: Partial<SupplementArticle> = {}): SupplementArticle => ({
  law: "식품위생법", jo: "제75조", title: "허가취소 등", excerpt: ARTICLE_75_EXCERPT, matched: [], ...overrides,
});

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

describe("residual §1: split-action relevance", () => {
  it("adopts the captured 제75조 excerpt for 영업정지 요건 (split act, same sentence, authority wording)", () => {
    expect(splitActionMatches("영업정지", ARTICLE_75_EXCERPT)).toBe(true);
    const adopted = researchEvidenceSources("", "영업정지 요건", {
      supplement: { status: "found", articles: [article75()] },
    }, ["식품위생법"]);
    expect(adopted.articles).toEqual([{ law: "식품위생법", jo: "제75조" }]);
  });

  it("keeps the E behaviour: the same excerpt still adopts for 행정처분 기준", () => {
    const adopted = researchEvidenceSources("", "행정처분 기준", {
      supplement: { status: "found", articles: [article75()] },
    }, ["식품위생법"]);
    expect(adopted.articles).toEqual([{ law: "식품위생법", jo: "제75조" }]);
  });

  it("rejects halves scattered across sentences", () => {
    const excerpt = "영업자는 신고를 할 수 있다. 위반 시 정지를 명할 수 있다.";
    expect(splitActionMatches("영업정지", excerpt)).toBe(false);
    const adopted = researchEvidenceSources("", "영업정지 요건", {
      supplement: { status: "found", articles: [article75({ excerpt })] },
    }, ["식품위생법"]);
    expect(adopted.articles).toEqual([]);
  });

  it("rejects a negated act even with authority wording in the sentence", () => {
    const excerpt = "영업자는 그 영업의 전부 또는 일부를 정지하지 아니하고 과징금을 부과할 수 있다.";
    expect(splitActionMatches("영업정지", excerpt)).toBe(false);
  });

  it("rejects a split act that only appears inside a quoted citation", () => {
    const excerpt = "「영업의 전부 또는 일부를 정지할 수 있다」는 규정을 인용한다.";
    expect(splitActionMatches("영업정지", excerpt)).toBe(false);
  });

  it("rejects a split act mentioned without operative authority wording", () => {
    const excerpt = "영업의 전부 또는 일부를 정지에 관한 설명이 이어진다.";
    expect(splitActionMatches("영업정지", excerpt)).toBe(false);
  });

  it("rejects the same excerpt for a different law (law restriction unchanged)", () => {
    const adopted = researchEvidenceSources("", "식품위생법 영업정지 요건", {
      supplement: { status: "found", articles: [article75({ law: "다른법" })] },
    });
    expect(adopted.articles).toEqual([]);
  });

  it("does not create an independent 제75조 ground from a 제82조 citation alone", () => {
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

describe("residual §1: range citations", () => {
  const rangeBody = (range: string) => `법 ${range}의 규정에 따른 행정처분의 기준은 별표 23과 같다.`;
  it("reads a middle article from a repeated-prefix range", () => {
    expect(citesParent(rangeBody("제74조부터 법 제76조까지"), "제75조")).toBe(true);
    expect(citesParent(rangeBody("제74조부터 제76조까지"), "제75조")).toBe(true);
  });
  it("accepts both endpoints and rejects outside the range", () => {
    expect(citesParent(rangeBody("제74조부터 법 제76조까지"), "제74조")).toBe(true);
    expect(citesParent(rangeBody("제74조부터 법 제76조까지"), "제76조")).toBe(true);
    expect(citesParent(rangeBody("제74조부터 법 제76조까지"), "제73조")).toBe(false);
    expect(citesParent(rangeBody("제74조부터 법 제76조까지"), "제77조")).toBe(false);
  });
  it("never proves a 조의N article from a plain range, nor a 조 from a 조의N citation", () => {
    expect(citesParent(rangeBody("제74조부터 법 제76조까지"), "제75조의2")).toBe(false);
    expect(citesParent("법 제75조의1에 따라 처분한다.", "제75조")).toBe(false);
    expect(citesParent("법 제75조에 따라 처분한다.", "제75조")).toBe(true);
  });
  it("does not accept a quoted other-law range", () => {
    expect(citesParent("「다른법」 제74조부터 제76조까지에 따라 처분한다.", "제75조")).toBe(false);
  });
  it("normalizes repeated prefixes with irregular spacing", () => {
    expect(citesParent("법  제74조부터   법 제76조까지에 따라 처분한다.", "제75조")).toBe(true);
  });
});

describe("residual §2/§3: one structured law identity", () => {
  it("parses a spaced official name once, with its article, and keeps the fragment as fallback", () => {
    expect(parseExplicitIdentities("개인정보 보호법 제38조의 권리 행사 절차와 관련 시행령의 관계를 알려줘")).toEqual([
      { law: "개인정보보호법", jo: "제38조", lawAlt: "보호법" },
    ]);
    expect(lawNamesInQuery("개인정보 보호법 제38조와 시행령의 관계")).toEqual(["개인정보보호법"]);
  });
  it("pairs each 조 with its own law and leaves a bare subordinate noun out of the pair", () => {
    expect(parseExplicitIdentities("근로기준법 제76조의3과 개인정보보호법 제38조를 비교해 줘")).toEqual([
      { law: "근로기준법", jo: "제76조의3" },
      { law: "개인정보보호법", jo: "제38조" },
    ]);
    expect(parseExplicitIdentities("개인정보보호법 제38조와 그 시행령의 관계")).toEqual([
      { law: "개인정보보호법", jo: "제38조" },
    ]);
  });
  it("finds no pair when the question names no 조", () => {
    expect(parseExplicitIdentities("식품위생법상 영업정지 요건")).toEqual([]);
  });

  const article38 = (overrides: Partial<SupplementArticle> = {}): SupplementArticle => ({
    law: "개인정보 보호법", jo: "제38조", title: "권리행사의 방법 및 절차", excerpt: ARTICLE_38_EXCERPT, matched: [], ...overrides,
  });

  it("separates the article number from lexical coverage: 제38조 권리 행사 절차 adopts the captured excerpt", () => {
    const adopted = researchEvidenceSources("", "제38조 권리 행사 절차", {
      supplement: { status: "found", articles: [article38()] },
    }, ["개인정보 보호법"]);
    expect(adopted.articles).toEqual([{ law: "개인정보 보호법", jo: "제38조" }]);
  });

  it("adopts an identity-verified explicit article for a bare-시행령 issue, and nothing for its sibling number", () => {
    const explicit = article38({ explicit: true });
    const adopted = researchEvidenceSources("", "제38조 시행령", {
      supplement: { status: "found", articles: [explicit] },
    });
    expect(adopted.articles).toEqual([{ law: "개인정보 보호법", jo: "제38조" }]);
    const sibling = researchEvidenceSources("", "제39조 내용", {
      supplement: { status: "found", articles: [explicit] },
    });
    expect(sibling.articles).toEqual([]);
    const unverified = researchEvidenceSources("", "제38조 시행령", {
      supplement: { status: "found", articles: [article38()] },
    });
    expect(unverified.articles).toEqual([]);
  });

  it("lets a bare-시행령 issue qualify for the question's unique parent pair in lookupIssue", async () => {
    const sources = baseSources({
      async laws(query) { return query === "개인정보보호법" ? [{ name: "개인정보 보호법", mst: "P" }] : []; },
      async article(mst, jo) {
        return mst === "P" && jo === "제38조"
          ? { text: `제38조(권리행사의 방법 및 절차)\n${ARTICLE_38_EXCERPT}` }
          : undefined;
      },
    });
    const lookup = await lookupIssue("제38조 시행령", [], sources, () => false,
      ["개인정보보호법"], ["개인정보보호법", "제38조", "시행령", "관계"],
      parseExplicitIdentities("개인정보 보호법 제38조와 시행령의 관계"));
    expect(lookup.articles.map((a) => `${a.law} ${a.jo}`)).toContain("개인정보 보호법 제38조");
  });

  it("keeps a same-number pair ambiguous when two laws share the suffix", async () => {
    const sources = baseSources({
      async laws() { return [{ name: "개인정보 보호법", mst: "P" }, { name: "신용정보 보호법", mst: "C" }]; },
      async article() { return { text: `제38조(권리행사의 방법 및 절차)\n${ARTICLE_38_EXCERPT}` }; },
    });
    const lookup = await lookupIssue("보호법 제38조", [], sources, () => false, [], []);
    expect(lookup.articles).toEqual([]);
  });

  it("skips an empty or deleted explicit body and degrades a fetch failure to no article, never to matched", async () => {
    const deleted = baseSources({
      async laws(query) { return query === "개인정보보호법" ? [{ name: "개인정보보호법", mst: "P" }] : []; },
      async article() { return { text: "제38조(권리행사의 방법 및 절차)\n삭제" }; },
    });
    const lookupDeleted = await lookupIssue("개인정보보호법 제38조", [], deleted, () => false, [], []);
    expect(lookupDeleted.articles).toEqual([]);
    const failing = baseSources({
      async laws(query) { return query === "개인정보보호법" ? [{ name: "개인정보보호법", mst: "P" }] : []; },
      async article() { throw new Error("down"); },
    });
    const lookupFailed = await lookupIssue("개인정보보호법 제38조", [], failing, () => false, [], []);
    expect(lookupFailed.articles).toEqual([]);
    expect(lookupFailed.status).toBe("none");
  });

  it("reports a lookup timeout distinctly", async () => {
    const lookup = await lookupIssue("제38조 권리 행사 절차", [], baseSources(), () => true, [], []);
    expect(lookup.status).toBe("timeout");
  });
});

describe("residual §1/§3: followup tiers, ranges and limited chain expansion", () => {
  const article82Body = "제82조(영업정지 등의 처분에 갈음하여 부과하는 과징금 처분)\n영업자가 제75조제1항에 해당하는 경우에는 총리령으로 정하는 바에 따라 과징금을 부과할 수 있다.";
  const article75Body = `제75조(허가취소 등)\n${ARTICLE_75_EXCERPT}`;
  const rule89Body = "제89조(행정처분의 기준)\n법 제74조부터 법 제76조까지의 규정에 따른 행정처분의 기준은 별표 23과 같다.";
  const rule89Excerpt = "법 제74조부터 법 제76조까지의 규정에 따른 행정처분의 기준은 별표 23과 같다.";

  function foodSources(options: { article75?: boolean; toc89?: boolean; rule89ScoreWord?: boolean } = {}) {
    return baseSources({
      async laws(query) {
        if (query === "식품위생법") return [{ name: "식품위생법", mst: "M" }];
        if (query === "식품위생법 시행규칙") return [{ name: "식품위생법 시행규칙", mst: "R" }];
        if (query === "식품위생법 시행령") return [{ name: "식품위생법 시행령", mst: "D" }];
        return [];
      },
      async toc(mst) {
        if (mst === "R" && options.toc89) return [{ jo: "제89조", title: "행정처분의 기준" }];
        return [];
      },
      async article(mst, jo) {
        if (mst === "M" && jo === "제82조") return { text: article82Body };
        if (mst === "M" && jo === "제75조" && options.article75) return { text: article75Body };
        if (mst === "R" && jo === "제89조") return { text: rule89Body };
        return undefined;
      },
    });
  }

  it("opens the 시행규칙 tier on a 총리령 delegation and reads the middle article from its repeated-prefix range", async () => {
    const enrichment = {
      supplement: { status: "found" as const, articles: [
        { law: "식품위생법", jo: "제82조", title: "영업정지 등의 처분에 갈음하여 부과하는 과징금 처분",
          excerpt: "영업자가 제75조제1항에 해당하는 경우에는 영업정지 처분을 갈음하여 과징금을 부과할 수 있다.", matched: ["영업정지"] },
        article75(),
      ] },
    };
    const followup = await retrieveResearchFollowup("action_basis", "식품위생법 영업정지 요건", "", enrichment, foodSources({ article75: true, toc89: true }));
    expect(followup.articles.map((a) => `${a.law} ${a.jo}`)).toContain("식품위생법 시행규칙 제89조");
    const annexes = await retrieveAnnexes("식품위생법 영업정지 요건", followup.articles, (async (law, number) => ({
      isError: false,
      text: law === "식품위생법 시행규칙" && number === "23"
        ? "식품위생법 시행규칙 - 행정처분의 기준\n[별표23] 행정처분의 기준\n파일 형식: 표\n"
        : "[NOT_FOUND] 없음",
    })) as AnnexReader);
    expect(annexes.filter((a) => a.label === "별표 23" && a.status === "verified")).toHaveLength(1);
  });

  it("does not open the 시행규칙 tier on a 대통령령 delegation alone (시행령 tier only)", async () => {
    const enrichment = {
      supplement: { status: "found" as const, articles: [article75()] },
    };
    const calls: string[] = [];
    const sources = baseSources({
      async laws(query) {
        calls.push(`laws:${query}`);
        if (query === "식품위생법") return [{ name: "식품위생법", mst: "M" }];
        if (query === "식품위생법 시행령") return [{ name: "식품위생법 시행령", mst: "D" }];
        return [];
      },
      async toc() { return []; },
      async article(mst, jo) {
        if (mst === "M" && jo === "제75조") return { text: article75Body };
        return undefined;
      },
    });
    await retrieveResearchFollowup("action_basis", "식품위생법 영업정지 요건", "", enrichment, sources);
    expect(calls).not.toContain("laws:식품위생법 시행규칙");
    expect(calls).toContain("laws:식품위생법 시행령");
  });

  it("expands a chain candidate only when its preview already shows a parent citation and an annex reference", async () => {
    const enrichment = {
      supplement: { status: "found" as const, articles: [
        { law: "식품위생법", jo: "제82조", title: "영업정지 등의 처분에 갈음하여 부과하는 과징금 처분",
          excerpt: "영업자가 제75조제1항에 해당하는 경우에는 영업정지 처분을 갈음하여 과징금을 부과할 수 있다.", matched: ["영업정지"] },
        article75(),
        { law: "식품위생법 시행규칙", jo: "제89조", title: "행정처분의 기준", excerpt: rule89Excerpt, matched: [] },
      ] },
    };
    // 제75조 itself cannot be re-fetched here, so the tier path cannot
    // score 제89조 through it; only the expansion path may fetch 제89조.
    const followup = await retrieveResearchFollowup("action_basis", "식품위생법 영업정지 요건", "", enrichment, foodSources({ toc89: true }));
    expect(followup.articles.map((a) => `${a.law} ${a.jo}`)).toContain("식품위생법 시행규칙 제89조");
  });

  it("does not expand a candidate without an annex reference, without a parent citation, or from another family", async () => {
    const noAnnex = {
      supplement: { status: "found" as const, articles: [
        { law: "식품위생법", jo: "제82조", title: "영업정지 등의 처분에 갈음하여 부과하는 과징금 처분",
          excerpt: "영업자가 제75조제1항에 해당하는 경우에는 영업정지 처분을 갈음하여 과징금을 부과할 수 있다.", matched: ["영업정지"] },
        article75(),
        { law: "식품위생법 시행규칙", jo: "제90조", title: "기타", excerpt: "법 제75조에 따라 처분한다.", matched: [] },
      ] },
    };
    const outOfRange = {
      supplement: { status: "found" as const, articles: [
        { law: "식품위생법", jo: "제82조", title: "영업정지 등의 처분에 갈음하여 부과하는 과징금 처분",
          excerpt: "영업자가 제75조제1항에 해당하는 경우에는 영업정지 처분을 갈음하여 과징금을 부과할 수 있다.", matched: ["영업정지"] },
        article75(),
        { law: "식품위생법 시행규칙", jo: "제89조", title: "행정처분의 기준", excerpt: "법 제90조부터 법 제92조까지의 규정에 따른 행정처분의 기준은 별표 23과 같다.", matched: [] },
      ] },
    };
    const otherFamily = {
      supplement: { status: "found" as const, articles: [
        { law: "식품위생법", jo: "제82조", title: "영업정지 등의 처분에 갈음하여 부과하는 과징금 처분",
          excerpt: "영업자가 제75조제1항에 해당하는 경우에는 영업정지 처분을 갈음하여 과징금을 부과할 수 있다.", matched: ["영업정지"] },
        article75(),
        { law: "다른법 시행규칙", jo: "제89조", title: "행정처분의 기준", excerpt: rule89Excerpt, matched: [] },
      ] },
    };
    const sources = foodSources({ toc89: true });
    for (const enrichment of [noAnnex, outOfRange, otherFamily]) {
      const followup = await retrieveResearchFollowup("action_basis", "식품위생법 영업정지 요건", "", enrichment, sources);
      expect(followup.articles.map((a) => `${a.law} ${a.jo}`)).not.toContain("식품위생법 시행규칙 제89조");
      expect(followup.articles.map((a) => `${a.law} ${a.jo}`)).not.toContain("다른법 시행규칙 제89조");
    }
  });

  it("keeps the whole-question seeds distinct from the per-issue union (E boundary)", () => {
    const onlyAdmin = article75({ jo: "제80조", title: "행정처분", excerpt: "해당 행정처분을 면제할 수 있다." });
    const whole = researchEvidenceSources("", "식품위생법상 영업정지 요건과 행정처분 기준", {
      supplement: { status: "found", articles: [onlyAdmin] },
    }, ["식품위생법"]);
    expect(whole.articles).toEqual([]);
    const perIssue = researchEvidenceSources("", "행정처분 기준", {
      supplement: { status: "found", articles: [onlyAdmin] },
    }, ["식품위생법"]);
    expect(perIssue.articles).toEqual([{ law: "식품위생법", jo: "제80조" }]);
  });
});

describe("residual §3: law-system assessment with one identity", () => {
  const detailText = (law: string) => [
    "═══ 법체계 확인: 개인정보 보호법 ═══", "",
    "▶ 3단 비교",
    `[시행령] ${law} 시행령 제45조 (대리인의 범위 등)`,
    "법 제38조에 따라 정보주체를 대리할 수 있는 자는 다음과 같다.",
  ].join("\n");
  it("no longer drops already-retrieved 시행령 articles for a spaced official name", () => {
    const spaced = assessLawSystem(detailText("개인정보 보호법"), "개인정보 보호법 제38조와 시행령의 관계");
    expect(spaced.status).toBe("matched");
    expect(spaced.items.find((item) => item.label === "시행령")?.status).toBe("found");
    const joined = assessLawSystem(detailText("개인정보 보호법"), "개인정보보호법 제38조와 시행령의 관계");
    expect(joined.status).toBe("matched");
  });
  it("still excludes another regime that merely shares the 보호법 suffix", () => {
    const other = assessLawSystem(detailText("신용정보 보호법"), "개인정보 보호법 제38조와 시행령의 관계");
    expect(other.items.find((item) => item.label === "시행령")?.status).toBe("none");
    expect(other.status).toBe("viewed");
  });
  it("reassesses from the same final evidence set when a retry adds a delegating article", () => {
    const base = [
      "═══ 법체계 확인: 개인정보 보호법 ═══", "",
      "▶ 3단 비교",
      "[시행령] 개인정보 보호법 시행령 제12조 (기타)",
      "기타 사항에 관한 규정이다.",
    ].join("\n");
    expect(assessLawSystem(base, "개인정보 보호법 제38조와 시행령의 관계").status).toBe("viewed");
    const retryBlock = delegatingDetailBlocks(detailText("개인정보 보호법"), ["제38조"], base);
    expect(retryBlock).toContain("제45조");
    expect(assessLawSystem(base + retryBlock, "개인정보 보호법 제38조와 시행령의 관계").status).toBe("matched");
  });
});

describe("residual §1: annexes stay annex-scoped", () => {
  it("verifies a 시행규칙 별표 23 without merging it into a 시행령 별표 1", async () => {
    const read: AnnexReader = async (law, number) => ({
      isError: false,
      text: number === "23"
        ? "식품위생법 시행규칙 - 행정처분의 기준\n[별표23] 행정처분의 기준\n파일 형식: 표\n"
        : "식품위생법 시행령 - 과징금\n[별표1] 과징금\n파일 형식: 표\n",
    });
    const result = await retrieveAnnexes("식품위생법 영업정지 요건", [
      { law: "식품위생법 시행규칙", jo: "제89조", title: "행정처분의 기준", excerpt: "별표 23과 같다.", matched: [], body: "법 제74조부터 법 제76조까지의 규정에 따른 행정처분의 기준은 별표 23과 같다." },
      { law: "식품위생법 시행령", jo: "제53조", title: "과징금", excerpt: "별표 1과 같다.", matched: [], body: "과징금은 별표 1과 같다." },
    ], read);
    expect(result.map((a) => `${a.law} ${a.label} ${a.status}`)).toEqual([
      "식품위생법 시행규칙 별표 23 verified",
      "식품위생법 시행령 별표 1 verified",
    ]);
  });
  it("keeps a failed annex as failed, never as verified evidence", async () => {
    const read: AnnexReader = async () => { throw new Error("down"); };
    const result = await retrieveAnnexes("식품위생법 영업정지 요건", [
      { law: "식품위생법 시행규칙", jo: "제89조", title: "행정처분의 기준", excerpt: "별표 23과 같다.", matched: [], body: "별표 23과 같다." },
    ], read);
    expect(result[0].status).toBe("failed");
  });
});
