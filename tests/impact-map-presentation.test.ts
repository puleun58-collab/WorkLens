import { describe, expect, it } from "vitest";
import { impactAxisView, impactMapPresentation } from "@/lib/law-analysis-parse";
import real from "./fixtures/impact-map-real.json";
import civil103 from "./fixtures/impact-map-civil103.json";

const graph = (rows: string[], metadata = "") => [
  "═══ Impact Map: 민법 제103조 ═══", "법령: 민법 (MST 284415, 법률)", "",
  "▶ 영향 그래프 (이 조문이 인용된 곳)", ...rows, metadata, "",
  "▶ 총 영향 건수(경계 확인분): 99건",
].join("\n");

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
  it("separates the actual civil103 four verified sources from two law-level candidates", () => {
    const view = impactMapPresentation(civil103.text);
    expect(view.total).toMatchObject({
      count: 4, confirmedCount: 4, pendingCount: 2, sourceCount: 6, unexaminedCount: 0, pendingTypeCount: 1,
      headline: "확인된 인용 결과 4건",
    });
    expect(view.axes.flatMap((row) => row.records ?? []).filter((row) => row.status === "confirmed")).toHaveLength(4);
    expect(view.axes.map((row) => row.sourceCount)).toEqual([1, 3, 0, 0, 2]);
    expect(view.notes).toEqual(["조문 인용이 확인되지 않은 자치법규 2건은 확인 건수에서 제외했습니다."]);
    expect(view.related).toEqual([{ query: "민법 제103조", label: "판례 추가 검색", domain: "precedent" }]);
    expect(civil103.text).toContain("총 영향 건수(경계 확인분): 6건");
  });

  it("counts only available individual records when upstream metadata claims more", () => {
    const view = impactMapPresentation(real.civil750);
    expect(view.total).toMatchObject({ confirmedCount: 0, pendingCount: 5 });
    expect(view.total?.lines.join(" ")).toContain("검증 집계와 개별 원문 자료가 일치하지 않아");
  });

  it("deduplicates within the official collection, not across different collections", () => {
    const view = impactMapPresentation(graph([
      "├─ 📚 대법원 판례: 2건", "│ • [12] 민법 제103조", "│ • [12] 민법 제103조",
      "└─ ⚖️ 헌재 결정례: 1건", "  • [12] 민법 제103조",
    ]));
    expect(view.total).toMatchObject({ confirmedCount: 2, pendingCount: 0 });
    expect(view.axes.flatMap((row) => row.records ?? []).map((row) => row.key)).toEqual(["prec:12", "detc:12"]);
  });

  it("never counts the same source as both confirmed and pending", () => {
    const view = impactMapPresentation(graph([
      "├─ 📚 대법원 판례: 1건", "│ • [12] 민법 제103조",
      "└─ 📚 대법원 판례: 1건", "  • [12] [UNVERIFIED] 법령명 보류",
    ]));
    expect(view.total).toMatchObject({ confirmedCount: 0, pendingCount: 1 });
    expect(view.axes[0].records?.[0].status).toBe("pending");
  });

  it("keeps unexamined candidates, failed lookups and empty searches separate", () => {
    const view = impactMapPresentation(graph([
      "├─ 📚 대법원 판례: 1건 확인 (조문 불일치 9건 제외) / 검색 30건 — 표본 10건만 경계 확인",
      "│ • [12] 민법 제103조",
      "├─ ⚖️ 헌재 결정례: 조회 실패", "└─ 📑 법령해석례: 0건",
    ]));
    expect(view.total).toMatchObject({ confirmedCount: 1, pendingCount: 0, sourceCount: 1, unexaminedCount: 20, pendingTypeCount: 2 });
    expect(view.axes.map((row) => row.state)).toEqual(["partial", "failed", "empty"]);
    expect(view.axes[0].detail).toContain("검색 결과 30건 중 10건");
  });

  it("does not infer article matching from an ordinance title, but accepts explicit verified evidence", () => {
    const view = impactMapPresentation(graph([
      "└─ 🏛️ 자치법규(법령 단위·조번호 미반영): 2건",
      "  • [1] 민법 제103조 지원 조례", "  • [2] [VERIFIED] 조문 인용 확인: 민법 제103조",
    ]));
    expect(view.total).toMatchObject({ confirmedCount: 1, pendingCount: 1 });
    expect(view.axes[0].records?.map((row) => row.status)).toEqual(["pending", "confirmed"]);
  });

  it("downgrades contradictory explicit verification metadata without choosing arbitrary IDs", () => {
    const view = impactMapPresentation(graph([
      "└─ 📚 대법원 판례: 2건", "  • [1] 민법 제103조", "  • [2] 민법 제103조",
    ], "ℹ️ 법령명 대조: 확정 1건 / 보류 1건"));
    expect(view.total).toMatchObject({ confirmedCount: 0, pendingCount: 2 });
  });

  it("does not manufacture source records from a count or from a title without an official ID", () => {
    const view = impactMapPresentation(graph(["└─ 📚 대법원 판례: 4건", "  • 민법 제103조 인용"]));
    expect(view.total).toMatchObject({ confirmedCount: 0, pendingCount: 0 });
    expect(view.axes[0].items).toEqual([]);
  });

  it("keeps every shown count derived from the same source records", () => {
    for (const text of Object.values(real)) {
      const view = impactMapPresentation(text);
      expect(view.total?.confirmedCount).toBe(view.axes.reduce((sum, row) => sum + (row.confirmedCount ?? 0), 0));
      expect(view.total?.pendingCount).toBe(view.axes.reduce((sum, row) => sum + (row.pendingCount ?? 0), 0));
      expect(view.total?.sourceCount).toBe(view.axes.flatMap((row) => row.records ?? []).length);
      expect(view.total?.unexaminedCount).toBe(view.axes.reduce((sum, row) => sum + (row.unexaminedCount ?? 0), 0));
    }
  });
});
