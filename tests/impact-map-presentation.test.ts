import { describe, expect, it } from "vitest";
import { impactAxisView, impactMapPresentation } from "@/lib/law-analysis-parse";
import real from "./fixtures/impact-map-real.json";

const axis = (label: string, value: string, failed = false) => impactAxisView({ label, value, failed, items: [] });

describe("impact map reader states", () => {
  it("says 관련 결과 없음 only when every search result was checked and none matched", () => {
    expect(axis("📑 법령해석례", "0건 (조문 불일치 2건 제외)")).toMatchObject({ state: "none", headline: "관련 결과 없음", detail: "검색 결과 2건을 모두 확인했으나 해당 조문과 일치하지 않았습니다." });
  });

  it("keeps unchecked results visible when only part was checked and nothing matched", () => {
    const view = axis("📚 대법원 판례", "0건 확인 (조문 불일치 10건 제외) / 검색 54건 — 표본 10건만 경계 확인, 나머지는 미확인");
    expect(view).toMatchObject({ state: "partial", headline: "확인된 결과 0건" });
    expect(view.detail).toBe("검색 결과 54건 중 10건을 확인했습니다. 확인한 10건은 해당 조문과 일치하지 않았습니다.");
    expect(view.headline).not.toBe("관련 결과 없음");
  });

  it("reports matches and the checked range when part was checked", () => {
    expect(axis("⚖️ 헌재 결정례", "3건 확인 (조문 불일치 7건 제외) / 검색 12건 — 표본 10건만 경계 확인, 나머지는 미확인")).toMatchObject({
      state: "partial", headline: "확인된 결과 3건", detail: "검색 결과 12건 중 10건을 확인했습니다. 확인한 결과 중 조문 불일치 7건을 제외했습니다.",
    });
  });

  it("separates no search results, a failed lookup and law-level ordinances", () => {
    expect(axis("📋 행정심판례", "0건")).toMatchObject({ state: "empty", headline: "검색 결과 없음" });
    expect(axis("⚖️ 헌재 결정례", "조회 실패 (업스트림 오류로 확인 못 함, 0건이 아님)", true)).toMatchObject({ state: "failed", headline: "조회 실패" });
    expect(axis("🏛️ 자치법규(법령 단위·조번호 미반영)", "2건")).toMatchObject({
      state: "law_only", label: "자치법규", headline: "2건", detail: expect.stringContaining("조문 단위의 일치 여부는 확인되지 않았습니다"),
    });
  });
});

describe("impact map presentation of real 법제처 results", () => {
  it("drops internal wording and counts only article-confirmed citations", () => {
    const view = impactMapPresentation(real.civil1);
    expect(view.law).toBe("민법 · 법률");
    expect(view.total).toEqual({ headline: "확인된 인용 결과 0건", lines: [
      "아직 확인하지 않은 검색 결과가 있어 실제로는 더 많을 수 있습니다.",
      "판례 0 · 헌재 결정례 0 · 법령해석례 0 · 행정심판례 0",
      "자치법규 2건은 조문 단위로 확인되지 않아 이 건수에 포함하지 않았습니다.",
    ] });
    expect(view.notes).toEqual(["법령 일치 확인: 확인 0건 · 추가 확인 필요 2건 (약칭·표기 차이로 같은 법령인지 판단하지 못한 결과도 제외하지 않고 포함했습니다.)"]);
    expect(view.related.filter((item) => item.domain)).toEqual([
      { query: "민법 제1조", label: "판례 상세", domain: "precedent" },
      { query: "민법 제1조", label: "해석례 상세", domain: "interpretation" },
    ]);
    const shown = JSON.stringify({ ...view, sources: [] });
    expect(shown).not.toMatch(/표본|강제|부분 일치|보류|미반영|영향 그래프|총 영향 건수|인용 법령: 0개|MST/u);
  });

  it("keeps each row's numbers consistent with the 법제처 summary", () => {
    for (const text of Object.values(real)) {
      const view = impactMapPresentation(text);
      const confirmed = view.axes.filter((row) => row.state !== "law_only")
        .reduce((sum, row) => sum + Number(/확인된 결과 (\d+)건/u.exec(row.headline)?.[1] ?? 0), 0);
      expect(view.total?.headline).toBe(`확인된 인용 결과 ${confirmed}건`);
    }
  });
});
