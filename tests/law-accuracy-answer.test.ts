import { describe, expect, it } from "vitest";
import { assessLawSystem } from "@/lib/law-system-evidence";
import { annexCriteriaForQuestion, assessActionBasis } from "@/lib/action-basis-evidence";
import { retrieveResearchFollowup } from "@/server/research-followup";
import type { EnrichmentSources } from "@/server/research-enrichment";
import privacy from "./fixtures/law-system-privacy-38.json";
import food from "./fixtures/law-action-basis-food-suspension.json";
import foodAnnex from "./fixtures/law-annex-food-23.json";

const privacyResult = () => assessLawSystem(privacy.text, privacy.query);
const foodResult = () => assessActionBasis(food.query, food.text, food.enrichment as Parameters<typeof assessActionBasis>[2],
  food.annexes as Parameters<typeof assessActionBasis>[3]);

describe("공식 원문 대조: 법률과 시행령 관계", () => {
  it("recognizes both 38조 delegation targets, not the related citations", () => {
    const result = privacyResult();
    const decree = result.items.find((item) => item.label === "시행령")!;
    expect(decree.articles?.filter((item) => item.relation === "twoWay").map((item) => item.jo).sort()).toEqual(["제45조", "제47조"]);
    expect(decree.articles?.filter((item) => item.relation === "twoWay").map((item) => item.jo)).not.toContain("제42조의5");
    expect(decree.articles?.filter((item) => item.relation === "twoWay").map((item) => item.jo)).not.toContain("제42조의8");
    expect(privacyResult()).toEqual(result);
  });

  it("separates explicit parent paragraphs rather than promoting every citation of article 38", () => {
    const first = assessLawSystem(privacy.text, "개인정보 보호법 제38조제1항과 시행령의 관계");
    const third = assessLawSystem(privacy.text, "개인정보 보호법 제38조제3항과 시행령의 관계");
    expect(first.items.find((item) => item.label === "시행령")?.articles?.filter((article) => article.relation === "twoWay").map((article) => article.jo)).toEqual(["제45조"]);
    expect(third.items.find((item) => item.label === "시행령")?.articles?.filter((article) => article.relation === "twoWay").map((article) => article.jo)).toEqual(["제47조"]);
  });

  it("does not promote a citation when the parent clause does not delegate its subject", () => {
    const source = `═══ 법체계 확인: 예시법 ═══\n▶ 추가 조회 조문\n[법률] 예시법 제8조 (수수료)\n제8조(수수료)\n① 수수료는 대통령령으로 정한다.\n[시행령] 예시법 시행령 제9조 (이의신청)\n① 법 제8조에 따라 이의신청을 받는다.`;
    const result = assessLawSystem(source, "예시법 제8조와 시행령 관계");
    expect(result.items.find((item) => item.label === "시행령")?.articles?.[0].relation).toBe("citation");
    expect(result.status).not.toBe("matched");
  });

  it("preserves retrieved material and states uncertainty if the decree retrieval fails", () => {
    const withoutDecree = privacy.text.replace(/\[시행령\][\s\S]*?(?=\n\[|\n▶|$)/gu, "");
    const result = assessLawSystem(`${withoutDecree}\n▶ 추가 조문 조회 [NOT_FOUND / FAILED]\n사유: [FAILED] 시행령 조회 실패`, privacy.query);
    expect(result.items.find((item) => item.label === "법률")?.status).toBe("found");
    expect(result.items.find((item) => item.label === "시행령")?.status).not.toBe("found");
    expect(result.status).not.toBe("matched");
  });
});

describe("공식 원문 대조: 식품위생법 처분·허가", () => {
  it("answers authority and requirements from 75조, keeps 82조 as supporting and table list apart", () => {
    const result = foodResult();
    const basis = result.items.find((item) => item.label === "처분·허가 근거")!;
    expect(basis.answer).toContain("식품위생법 제75조");
    expect(basis.answer).toContain("6개월 이내");
    expect(basis.answer).not.toContain("제82조");
    expect(basis.basisRefs?.find((ref) => ref.jo === "제82조")?.note).toContain("과징금");
    expect(result.items.find((item) => item.label === "적용 요건")?.uncertainty).toContain("위반행위와 영업 종류");
    expect(foodResult()).toEqual(result);
  });

  it("does not certify a list or an identity-only annex as detailed criteria", () => {
    const result = assessActionBasis("식품위생법 영업정지 별표 기준", food.text, food.enrichment as Parameters<typeof assessActionBasis>[2],
      [{ law: "식품위생법 시행규칙", label: "별표 23", sourceArticle: "제89조", citation: "행정처분 기준은 별표 23과 같다.", relevance: "direct", status: "identified" }]);
    const criteria = result.items.find((item) => item.label === "세부 기준(별표)")!;
    expect(criteria.status).toBe("viewed");
    expect(criteria.uncertainty).toContain("별표 원문 미확보");
    expect(result.status).not.toBe("matched");
  });

  it("never promotes revocation power to a grant of permission", () => {
    const result = assessActionBasis("식품위생법 영업허가 요건", food.text, food.enrichment as Parameters<typeof assessActionBasis>[2]);
    expect(result.items.find((item) => item.label === "처분·허가 근거")?.answer).toBeUndefined();
  });
});

  it("matches only a unique original table row and an explicitly stated offence count", () => {
    const row = annexCriteriaForQuestion("식품위생법 식품제조·가공업 온도 기준을 위반한 경우 영업정지 1차 위반 기준", foodAnnex.text);
    expect(row).toContain("온도 기준을 위반한 경우");
    expect(row).toContain("1차 위반: 영업정지 7일");
    expect(annexCriteriaForQuestion("식품위생법 식품제조·가공업 보존 및 유통기준의 온도 기준 1차 위반", foodAnnex.text))
      .toContain("러. 보존 및 유통기준을 위반한 경우로서");
    expect(annexCriteriaForQuestion("식품위생법 영업정지 기준", foodAnnex.text)).toBeUndefined();
    expect(annexCriteriaForQuestion("식품위생법 식품제조·가공업 온도 기준을 위반한 경우 영업정지 4차 위반 기준", foodAnnex.text)).toBeUndefined();
  });

it("searches official criteria even when a specific offence did not pass whole-query adoption", async () => {
  const source: EnrichmentSources = {
    async summary() { return undefined; },
    async laws(name) {
      if (name === "식품위생법") return [{ name, mst: "L" }];
      if (name === "식품위생법 시행규칙") return [{ name, mst: "R" }];
      return [];
    },
    async toc(mst) { return mst === "R" ? [{ jo: "제89조", title: "행정처분의 기준" }] : []; },
    async article(mst, jo) {
      if (mst === "L" && jo === "제75조") return { text: `제75조(허가취소 등)\n${food.enrichment.supplement.articles.find((entry) => entry.jo === "제75조")!.excerpt}\n⑤ 제1항에 따른 행정처분의 세부기준은 총리령으로 정한다.` };
      if (mst === "R" && jo === "제89조") return { text: "제89조(행정처분의 기준)\n법 제74조부터 법 제76조까지에 따른 행정처분의 기준은 별표 23과 같다." };
      return undefined;
    },
    async interpretations() { return []; },
    async precedents() { return []; },
  };
  const result = await retrieveResearchFollowup("action_basis", "식품위생법 식품제조·가공업 온도 기준을 위반한 경우 영업정지 1차 위반 기준", food.text,
    food.enrichment as Parameters<typeof retrieveResearchFollowup>[3], source);
  expect(result.articles.map((article) => article.jo)).toContain("제89조");
});

it("uses a verified action source to search when the question names only the regulated business", async () => {
  const article = food.enrichment.supplement.articles.find((entry) => entry.jo === "제75조")!;
  const source: EnrichmentSources = {
    async summary() { return undefined; },
    async laws(name) {
      if (name === "식품위생법") return [{ name, mst: "L" }];
      if (name === "식품위생법 시행규칙") return [{ name, mst: "R" }];
      return [];
    },
    async toc(mst) { return mst === "R" ? [{ jo: "제89조", title: "행정처분의 기준" }] : []; },
    async article(mst, jo) {
      if (mst === "L" && jo === "제75조") return { text: `제75조(허가취소 등)\n${article.excerpt}\n⑤ 제1항에 따른 행정처분의 세부기준은 총리령으로 정한다.` };
      if (mst === "R" && jo === "제89조") return { text: "제89조(행정처분의 기준)\n법 제75조에 따른 행정처분의 기준은 별표 23과 같다." };
      return undefined;
    },
    async interpretations() { return []; },
    async precedents() { return []; },
  };
  const result = await retrieveResearchFollowup("action_basis", "식품제조·가공업 온도 기준 위반 1차 영업정지 처분 기준", food.text,
    food.enrichment as Parameters<typeof retrieveResearchFollowup>[3], source);
  expect(result.articles.map((entry) => entry.jo)).toContain("제89조");
});