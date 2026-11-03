import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnalysisResultCard, CitationResult } from "../src/components/research/CitationEvidence";
import { AnalysisResult } from "../src/components/research/LegalAnalysis";
import { verifyCitationsResult } from "../src/lib/law-analysis-parse";

const completedAt = Date.UTC(2026, 10, 2);

describe("analysis result cards", () => {
  it.each(["확인됨", "내용 불일치", "미확인", "확인 필요"])("keeps %s as the only left-hand status", (status) => {
    const title = "아주 긴 법령명과 조문 제목이 모바일에서도 생략되지 않고 모두 표시되는 확인 대상".repeat(3);
    const html = renderToStaticMarkup(createElement(AnalysisResultCard, { status, title, meta: "판례 인용" }));
    expect(html).toContain(`<span class="legal-analysis-status">${status}</span>`);
    expect(html).toContain(title);
    expect(html).toContain('<div class="legal-analysis-result-copy">');
    expect(html).toContain('<div class="legal-analysis-result-meta">판례 인용</div>');
    expect(html).not.toContain('class="law-search-note"');
  });

  it("moves direct-support classification to metadata and retains the final verdict and help", () => {
    const parsed = verifyCitationsResult("[VERIFIED] == 인용 검증 결과 ==\n\n▶ 법령 인용\n✓ 민법 제750조(불법행위의 내용) 실존");
    const html = renderToStaticMarkup(createElement(CitationResult, {
      ...parsed, notes: null, input: "민법 제750조", verifiedAt: completedAt,
      claimSupport: [{ index: 0, verdict: "unverified", reason: "이 조문이 주장을 직접 뒷받침하는지는 확인하지 못했습니다." }],
    }));
    expect(html).toContain('<span class="legal-analysis-status">미확인</span>');
    expect(html).toContain('<div class="legal-analysis-result-meta">직접 근거</div>');
    expect(html).toContain("이 조문이 주장을 직접 뒷받침하는지는 확인하지 못했습니다.");
    expect(html).not.toContain('<span class="legal-analysis-status">직접 근거 미확인</span>');
  });

  it("keeps the impact table and hides a blue notice when no exception exists", () => {
    const text = "═══ Impact Map: 민법 제103조 ═══\n\n▶ 영향 그래프 (이 조문이 인용된 곳)\n├─ 📚 대법원 판례: 1건\n│   • [245007] 반사회적 법률행위 · 사건번호: 2023다302036\n\n▶ 총 영향 건수(경계 확인분): 1건";
    const html = renderToStaticMarkup(createElement(AnalysisResult, {
      data: { found: true, mode: "impact_map", text, markers: [] },
      request: { mode: "impact_map", lawName: "민법", jo: "제103조" }, completedAt,
    }));
    expect(html).toContain("확인 1건");
    expect(html).toContain("<table");
    expect(html).toContain('scope="col">자료 유형');
    expect(html).toContain('scope="col">검색 결과');
    expect(html).toContain('scope="col">확인 내용');
    expect(html).not.toContain("impact-citations-note");
  });

  it("does not confirm a temporal selection before its frozen source is available", () => {
    const text = "═══ 행위시법 판단: 도로교통법 @ 2026.11.02 ═══\n\n▶ 기준일에 시행 중이던 버전\n도로교통법 [시행 2026.10.13] [제22067호, 2026.10.13, 일부개정] (MST 291133)";
    const html = renderToStaticMarkup(createElement(AnalysisResult, {
      data: { found: true, mode: "applicable_law", text, markers: [] },
      request: { mode: "applicable_law", lawName: "도로교통법", date: "2026-11-02" }, completedAt,
    }));
    expect(html).not.toContain("기준일에 시행 중인 법령입니다.");
    expect(html).toContain("개별 조문의 적용 여부는 확인하지 않았습니다.");
    expect(html).toContain("적용 법령은 행위·처분 시점과 부칙 등에 따라 달라질 수 있습니다.");
  });

  it("uses complete official future metadata instead of the upstream nearest-only summary", () => {
    const text = "═══ 행위시법 판단: 도로교통법 @ 2026.11.02 ═══\n\n▶ 기준일에 시행 중이던 버전\n도로교통법 [시행 2026.10.13] (MST 291133)\n⚠️ 시행 예정 개정 4건 존재 — 시행 2027.04.14";
    const html = renderToStaticMarkup(createElement(AnalysisResult, {
      data: {
        found: true, mode: "applicable_law", text, markers: [],
        temporal: {
          futureComplete: true,
          futureVersions: [
            { lawName: "도로교통법", mst: "220", effectiveDate: "20270414", line: "2027.04.14 예정 판본" },
            { lawName: "도로교통법", mst: "217", effectiveDate: "20261203", line: "2026.12.03 예정 판본" },
          ],
        },
      },
      request: { mode: "applicable_law", lawName: "도로교통법", date: "2026-11-02" }, completedAt,
    }));
    expect(html).toContain("향후 시행 예정 버전 2건 · 가장 빠른 시행 예정일: 2026.12.03");
    expect(html.indexOf("2026.12.03 예정 판본")).toBeLessThan(html.indexOf("2027.04.14 예정 판본"));
    expect(html).not.toContain("향후 시행 예정 버전 4건");
    expect(html).not.toContain('<details class="law-detail-source" open');
  });
});
