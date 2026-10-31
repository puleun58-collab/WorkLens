import { describe, expect, it } from "vitest";
import { actionBasisTitle, actionTerms, assessActionBasis } from "@/lib/action-basis-evidence";
import { assessLawSystem } from "@/lib/law-system-evidence";
import type { AnnexEvidence } from "@/lib/research-annex";
import type { ResearchEnrichment } from "@/lib/research-relevance";
import { retrieveAnnexes, type AnnexReader } from "@/server/research-annex";
import type { FollowupArticle } from "@/server/research-followup";
import food from "./fixtures/law-action-basis-food-suspension.json";
import privacy from "./fixtures/law-system-privacy-38.json";

const refs = (item: { basisRefs?: { law: string; jo: string; note?: string }[]; requirementRefs?: { law: string; jo: string; note?: string }[] } | undefined, kind: "basisRefs" | "requirementRefs") =>
  [...new Set((item?.[kind] ?? []).map((ref) => `${ref.law} ${ref.jo}${ref.note ? " (보충)" : ""}`))];

describe("처분 근거·적용 요건: live 식품위생법 영업정지 응답", () => {
  const annexes = (food.annexes as AnnexEvidence[]).map((annex) => ({ ...annex, relevance: "direct" as const }));
  const result = assessActionBasis(food.query, food.text, food.enrichment as ResearchEnrichment, annexes);
  const basis = result.items.find((item) => item.label === "처분·허가 근거");
  const requirement = result.items.find((item) => item.label === "적용 요건");

  it("names the basis by the question's act and adopts 제75조 as the direct disposition basis", () => {
    expect(basis?.title).toBe("처분 근거");
    expect(basis?.status).toBe("found");
    const basisRefs = refs(basis, "basisRefs");
    expect(basisRefs.filter((ref) => !ref.endsWith("(보충)"))).toEqual(["식품위생법 제75조"]);
    // 과징금 갈음(제82조) is shown only as a supporting provision, never as the direct basis.
    expect(basisRefs).toContain("식품위생법 제82조 (보충)");
  });

  it("keeps requirements to the act's own conditions: no hygiene-handling or residue-limit provisions", () => {
    expect(requirement?.status).toBe("found");
    const requirementRefs = refs(requirement, "requirementRefs");
    expect(requirementRefs.filter((ref) => !ref.endsWith("(보충)"))).toEqual(["식품위생법 제75조"]);
    expect(requirementRefs.join("\n")).not.toContain("시행규칙 제2조");
    expect(requirementRefs.join("\n")).not.toMatch(/제5조의[23]/u);
  });

  it("shows the verified 별표 23 as optional detailed criteria that never sets the verdict", () => {
    const criteria = result.items.find((item) => item.label === "세부 기준(별표)");
    expect(criteria).toMatchObject({ title: "세부 처분 기준", optional: true, status: "found" });
    expect(criteria?.detail).toContain("식품위생법 시행규칙 별표 23");
    expect(result.status).toBe("matched");
    // Without the annex, the verdict is unchanged (it never depended on it).
    expect(assessActionBasis(food.query, food.text, food.enrichment as ResearchEnrichment, []).status).toBe("matched");
  });
});

describe("처분 근거 관련성: 법령명·일반어만 같은 본문은 근거가 아니다", () => {
  const text = "═══ 조회 결과 ═══\n▶ 상세\n[시행규칙] 식품위생법 시행규칙 제2조 (식품등의 위생적인 취급에 관한 기준)\n「식품위생법」 제3조제3항에 따른 위생적인 취급에 관한 기준은 별표 1과 같다. 해당하는 경우에는 그 기준에 따라야 한다.\n";
  it("does not confirm a basis or requirement from a body that only quotes the law name", () => {
    const result = assessActionBasis("식품위생법상 영업정지 요건", text);
    expect(result.items.find((item) => item.label === "처분·허가 근거")?.status).not.toBe("found");
    expect(result.items.find((item) => item.label === "적용 요건")?.status).not.toBe("found");
    expect(result.status).not.toBe("matched");
  });
});

describe("법적 행위와 표시 명칭", () => {
  it.each([
    ["식품위생법상 영업정지 요건", "처분 근거"],
    ["식품위생법상 영업허가 요건", "허가 근거"],
    ["식품위생법상 영업정지 갈음 과징금", "과징금 부과 근거"],
    ["개인정보 보호법상 과징금 부과 요건", "과징금 부과 근거"],
    ["건축법상 건축허가 요건", "허가 근거"],
    ["근로기준법상 해고 제한", "법적 근거"],
  ])("%s → %s", (query, title) => {
    expect(actionBasisTitle(query)).toBe(title);
  });
  it("splits a compound act into its object and act parts", () => {
    expect(actionTerms("식품위생법상 영업정지 요건")).toEqual([{ term: "영업정지", head: "영업", core: "정지" }]);
  });
});

describe("별표 관련성: 질문한 법적 행위가 인용한 별표만 읽는다", () => {
  const article = (law: string, jo: string, body: string): FollowupArticle => ({ law, jo, title: "", excerpt: body, matched: [], body });
  const articles = [
    article("식품위생법 시행령", "제53조", "법 제82조제1항에 따라 영업정지 등의 처분에 갈음하여 부과하는 과징금의 산정기준은 별표 1과 같다."),
    article("식품위생법 시행규칙", "제89조", "법 제71조, 법 제72조, 법 제74조부터 법 제76조까지 및 법 제80조에 따른 행정처분의 기준은 별표 23과 같다."),
  ];
  const reads: string[] = [];
  const read: AnnexReader = async (law, number) => {
    reads.push(`${law} 별표 ${number}`);
    return { isError: false, text: `${law} - 기준\n[별표${number}] 기준\n파일 형식: HWP\n본문` };
  };

  it("skips the 과징금 산정기준 for a plain 영업정지 question and reads the 행정처분 기준", async () => {
    reads.length = 0;
    const result = await retrieveAnnexes("식품위생법상 영업정지 요건", articles, read, "action_basis");
    expect(reads).toEqual(["식품위생법 시행규칙 별표 23"]);
    expect(result.map((annex) => [annex.label, annex.relevance])).toEqual([["별표 23", "direct"]]);
  });

  it("reads the 과징금 산정기준 when the question asks about the substitute fine", async () => {
    reads.length = 0;
    await retrieveAnnexes("식품위생법상 영업정지 갈음 과징금", articles, read, "action_basis");
    expect(reads).toContain("식품위생법 시행령 별표 1");
  });

  it("keeps lexical ranking for other research tasks", async () => {
    reads.length = 0;
    await retrieveAnnexes("식품위생법상 영업정지 요건", articles, read, "procedure_detail");
    expect(reads.sort()).toEqual(["식품위생법 시행규칙 별표 23", "식품위생법 시행령 별표 1"]);
  });
});

describe("법체계: 질문한 법령 단계만 필수 — live 개인정보 보호법 제38조 응답", () => {
  it("does not require the unasked 시행규칙 when the question asks about the decree", () => {
    const result = assessLawSystem(privacy.text, privacy.query);
    expect(result.items.map((item) => item.label)).toEqual(["법률", "시행령"]);
    expect(result.items.find((item) => item.label === "시행령")?.status).toBe("found");
    expect(result.status).toBe("matched");
  });
  it("still requires every tier the question names", () => {
    const result = assessLawSystem(privacy.text, "개인정보 보호법 제38조와 시행령·시행규칙의 관계");
    expect(result.items.map((item) => item.label)).toEqual(["법률", "시행령", "시행규칙"]);
    expect(result.status).toBe("partial");
  });
});
