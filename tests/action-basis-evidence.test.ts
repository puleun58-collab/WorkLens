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
    expect(result.items.find((item) => item.label === "세부 기준(별표)")?.status).toBe("found");
  });

  it("reports an empty search as none", () => {
    expect(assessActionBasis(QUERY, "")).toEqual({ status: "none", items: [] });
  });
});
