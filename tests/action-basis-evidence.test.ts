import { describe, expect, it } from "vitest";
import { assessActionBasis } from "@/lib/action-basis-evidence";

const QUERY = "음식점 영업정지 처분의 근거와 요건";
// Verbatim shape of the live 처분 근거 chain (2026-10-27 probe): a
// detailed-format article body plus an enrichment supplement excerpt.
const BODY = `═══ 처분 근거 확인: 건강기능식품에 관한 법률 ═══

▶ 법령 체계 (법률·시행령·시행규칙)
법령명: 건강기능식품에 관한 법률

---
제32조
---

[시행령] 건강기능식품에 관한 법률 시행령 제5조 (영업정지 처분)
법 제32조제1항에 따라 영업자가 기준을 위반하면 영업정지 처분을 할 수 있다. 처분의 요건과 기준은 해당 조문에 따른다.
`;
const SUPPLEMENT = { status: "found" as const, articles: [{ law: "건강기능식품에 관한 법률", jo: "제37조",
  title: "영업정지 등의 처분을 갈음하여 부과하는 과징금 처분",
  excerpt: "영업자가 제32조제1항에 해당하면 영업정지 처분을 갈음하여 과징금을 부과할 수 있다.", matched: ["영업정지"] }] };

describe("assessActionBasis", () => {
  it("confirms basis and requirements from article bodies naming the subject", () => {
    const result = assessActionBasis(QUERY, BODY, { supplement: SUPPLEMENT });
    expect(result.status).toBe("matched");
    expect(result.items.map((item) => [item.label, item.status])).toEqual([
      ["처분·허가 근거", "found"], ["적용 요건", "found"],
    ]);
  });

  it("is partial when the basis body is confirmed but no requirement text is", () => {
    const basisOnly = BODY.replace(
      "영업자가 기준을 위반하면 영업정지 처분을 할 수 있다. 처분의 요건과 기준은 해당 조문에 따른다.",
      "영업자가 위반하면 영업정지 처분을 할 수 있다.");
    // The remaining body still names the subject and an authority phrase, but
    // no requirement word remains for the 요건 kind.
    const result = assessActionBasis(QUERY, basisOnly);
    expect(result.status).toBe("partial");
    expect(result.items.map((item) => [item.label, item.status])).toEqual([
      ["처분·허가 근거", "found"], ["적용 요건", "viewed"],
    ]);
  });

  it("does not confirm a basis from a header alone", () => {
    const headerOnly = `═══ 처분 근거 확인: 건강기능식품에 관한 법률 ═══\n\n▶ 법령 체계 (법률·시행령·시행규칙)\n법령명: 건강기능식품에 관한 법률\n`;
    expect(assessActionBasis(QUERY, headerOnly).status).toBe("viewed");
  });

  it("verifies the annex kind only from annex entries, never from a duty claim", () => {
    const withAnnex = `${BODY}\n▶ 별표 (행정처분 기준표)\n별표/서식 목록 (총 2건):\n\n1. [별표 1] 영업정지 기준\n2. [별표 2] 과태료 기준\n`;
    const result = assessActionBasis("영업정지 처분의 근거와 별표 기준", withAnnex);
    expect(result.items.find((item) => item.label === "세부 기준(별표)")?.status).toBe("viewed");
  });

  it("reports an empty search as none", () => {
    expect(assessActionBasis(QUERY, "")).toEqual({ status: "none", items: [] });
  });

  it("links a found basis to its articles instead of a bare body count", () => {
    const result = assessActionBasis(QUERY, BODY, { supplement: SUPPLEMENT });
    const basis = result.items.find((item) => item.label === "처분·허가 근거")!;
    expect(basis.status).toBe("found");
    // Detail text no longer repeats the provision list or body counts; the
    // structured refs below carry the articles.
    expect(basis.detail).toBeUndefined();
    expect(basis.basisRefs?.map((ref) => ref.jo)).toContain("제5조");
    const requirement = result.items.find((item) => item.label === "적용 요건")!;
    expect(requirement.status).toBe("found");
    expect(requirement.detail).toBeUndefined();
    expect(requirement.requirementRefs?.length).toBeGreaterThan(0);
  });

  it("counts annex entries only of the question's named law", () => {
    const mixed = `${BODY}\n▶ 별표 (행정처분 기준표)\n별표/서식 목록 (총 2건):\n\n1. [별표 1] 영업정지 기준\n   관련법령: 개인정보보호법\n\n2. [별표 9] 다른 법령 기준\n   관련법령: 식품위생법\n`;
    // Spaced official name: the token fragment ("보호법") still admits the
    // question's own law via the question-supplied prefix, but not the
    // other law.
    const named = assessActionBasis("개인정보 보호법 영업정지 처분의 근거와 별표 기준", mixed);
    const annex = named.items.find((item) => item.label === "세부 기준(별표)")!;
    expect(annex.status).toBe("viewed");
    expect(annex.uncertainty).toContain("별표 원문 미확보");
    const otherOnly = assessActionBasis("식품위생법 영업정지 처분의 근거와 별표 기준", `${BODY}\n▶ 별표 (행정처분 기준표)\n별표/서식 목록 (총 1건):\n\n1. [별표 1] 영업정지 기준\n   관련법령: 개인정보보호법\n`);
    expect(otherOnly.items.find((item) => item.label === "세부 기준(별표)")?.status).toBe("none");
  });

  it("demotes an otherwise complete result when no verified annex original matches the list", () => {
    const withAnnex = `${BODY}\n▶ 별표 (행정처분 기준표)\n별표/서식 목록 (총 1건):\n\n1. [별표 1] 영업정지 기준\n   관련법령: 건강기능식품에 관한 법률\n`;
    const query = "음식점 영업정지 처분의 근거와 요건과 별표 기준";
    expect(assessActionBasis(query, withAnnex).status).toBe("partial");
    expect(assessActionBasis(query, withAnnex, undefined, []).status).toBe("partial");
    const verified = [{ law: "건강기능식품에 관한 법률", label: "별표 1", sourceArticle: "제32조", citation: "별표 1", relevance: "direct" as const, status: "verified" as const, text: "영업정지 7일" }];
    expect(assessActionBasis(query, withAnnex, undefined, verified).status).toBe("matched");
    const foreign = [{ ...verified[0], law: "식품위생법" }];
    expect(assessActionBasis(query, withAnnex, undefined, foreign).status).toBe("partial");
  });
});

it("shortens confirmed source answers without upgrading missing annex originals or case application", () => {
  const text = `═══ 처분 근거 확인: 예시법 ═══
▶ 법령 체계
[법률] 예시법 제12조 (영업정지 등)
① 시장은 영업자가 다음 각 호의 어느 하나에 해당하는 경우 3개월 이내의 기간을 정하여 영업정지 처분을 할 수 있다. 다만, 경미한 위반은 제외한다.
1. 영업 기준을 위반한 경우
2. 시설 기준을 위반한 경우`;
  const result = assessActionBasis("예시법 영업정지 처분 근거와 요건 및 별표 기준", text);
  expect(result.items.map((entry) => [entry.status, entry.summary])).toEqual([
    ["found", "예시법 제12조 · 영업정지 등 처분 · 법정 상한 3개월 이내 · 예외 단서 있음"],
    ["found", "제12조 제1항 각 호의 위반행위 해당 여부 · 개별 적용 미확정 · 예외 단서 원문 확인 필요"],
    ["none", undefined],
  ]);
  expect(result.items[0].answer).toContain("시장은 영업자가");
  expect(result.items[1].requirementRefs?.[0].excerpt).toContain("2. 시설 기준을 위반한 경우");
  expect(result.items[2].uncertainty).toContain("별표 원문 미확보");
});

it("does not transfer a registration exception or another article's enumerated items to a permit answer", () => {
  const source = `═══ 처분 근거 확인: 식품위생법 ═══
▶ 법령 체계
[법률] 식품위생법 제37조 (영업허가 등)
① 제36조제1항 각 호에 따른 영업 중 대통령령으로 정하는 경우에는 영업을 하려는 자는 시장의 허가를 받아야 한다.
② 영업을 등록하려는 자는 등록하여야 한다. 다만, 폐업한 때에는 신고하여야 한다.`;
  const items = assessActionBasis("식품위생법 제37조 영업허가의 근거와 요건", source).items;
  expect(items[0].summary).toBe("식품위생법 제37조 · 영업허가 권한");
  expect(items[1].summary).toBe("제36조제1항 각 호에 따른 영업 범위 해당 여부 · 개별 적용 미확정");
  expect(items[0].status).toBe("found");
  expect(items[1].status).toBe("found");
});

it("returns independent structured basis and requirement references without changing detail", () => {
  const result = assessActionBasis(QUERY, BODY, { supplement: SUPPLEMENT });
  const [basis, requirement] = result.items;
  expect(basis.basisRefs).toHaveLength(2);
  expect(requirement.requirementRefs).toHaveLength(2);
  expect(basis.detail).toBeUndefined();
  expect(basis.basisRefs?.[0]).toMatchObject({ law: "건강기능식품에 관한 법률 시행령", jo: "제5조", title: "영업정지 처분", excerpt: expect.stringContaining("법 제32조") });
  const basisOnly = BODY.replace("영업자가 기준을 위반하면 영업정지 처분을 할 수 있다. 처분의 요건과 기준은 해당 조문에 따른다.", "영업자가 위반하면 영업정지 처분을 할 수 있다.");
  const independent = assessActionBasis(QUERY, basisOnly);
  expect(independent.items[0].basisRefs).toHaveLength(1);
  expect(independent.items[1].requirementRefs).toEqual([]);
  expect(independent.items[1].status).toBe("viewed");
});

it("keeps all structured sources beyond the three-reference legacy summary and deduplicates only identical excerpts", () => {
  const articles = Array.from({ length: 5 }, (_, i) => ({ ...SUPPLEMENT.articles[0], jo: `제${i + 1}조` }));
  const result = assessActionBasis(QUERY, BODY, { supplement: { status: "found", articles: [...articles, articles[0], { ...articles[0], excerpt: `${articles[0].excerpt} 별도의 원문 발췌` }] } });
  expect(result.items[0].basisRefs).toHaveLength(7);
  expect(result.items[0].detail).toBeUndefined();
  expect(new Set(result.items[0].basisRefs?.map((ref) => `${ref.law}:${ref.jo}`)).size).toBe(6);
  expect(result.items[0].basisRefs?.some((ref) => ref.excerpt.includes("별도의 원문 발췌"))).toBe(true);
});

describe("assessActionBasis accuracy hardening", () => {
  it("does not confirm a requirement from a keyword mention alone", () => {
    const mentionOnly = BODY.replace(
      "법 제32조제1항에 따라 영업자가 기준을 위반하면 영업정지 처분을 할 수 있다. 처분의 요건과 기준은 해당 조문에 따른다.",
      "법 제32조제1항에 따라 영업정지 처분의 요건에 관한 규정은 별표와 같다.");
    const result = assessActionBasis(QUERY, mentionOnly);
    expect(result.status).toBe("viewed");
    const requirement = result.items.find((item) => item.label === "적용 요건")!;
    expect(requirement.status).toBe("viewed");
    expect(requirement.detail).toContain("요건 관련 문언 확인");
    expect(result.items.find((item) => item.label === "처분·허가 근거")?.status).toBe("viewed");
  });

  it("does not confirm a direct disposition basis from a substitute-fine provision alone", () => {
    const fineOnly = `═══ 처분 근거 확인: 식품위생법 ═══

▶ 법령 체계 (법률·시행령·시행규칙)
법령명: 식품위생법

---
제82조
---

[시행령] 식품위생법 시행령 제53조 (과징금 처분)
영업자가 영업정지 처분을 갈음하여 과징금을 부과할 수 있다.
`;
    const result = assessActionBasis(QUERY, fineOnly);
    const basis = result.items.find((item) => item.label === "처분·허가 근거")!;
    expect(basis.status).toBe("viewed");
    expect(basis.detail).toContain("과징금 갈음 규정만 확인");
    expect(basis.basisRefs?.[0].note).toContain("과징금 갈음 규정");
  });

  it("confirms a substitute-fine basis when the question itself asks about the fine", () => {
    const fineOnly = `═══ 처분 근거 확인: 식품위생법 ═══

▶ 법령 체계 (법률·시행령·시행규칙)
법령명: 식품위생법

---
제82조
---

[시행령] 식품위생법 시행령 제53조 (과징금 처분)
영업자가 영업정지 처분을 갈음하여 과징금을 부과할 수 있다.
`;
    const result = assessActionBasis("영업정지 갈음 과징금 부과 근거와 요건", fineOnly);
    const basis = result.items.find((item) => item.label === "처분·허가 근거")!;
    expect(basis.status).toBe("found");
    expect(basis.basisRefs?.[0].note).toBeUndefined();
  });
});
