import { describe, expect, it } from "vitest";
import { lawDisplayText } from "@/lib/law-display";

describe("lawDisplayText", () => {
  it.each([
    ["문장1<br/>문장2", "문장1\n문장2"],
    ["문장1<br>문장2", "문장1\n문장2"],
    ["문장1<br />문장2", "문장1\n문장2"],
    ["문장1<BR/>문장2", "문장1\n문장2"],
    ["문장1<BR>문장2", "문장1\n문장2"],
    ["문장1<BR />문장2", "문장1\n문장2"],
    ["문장1< Br  / >문장2", "문장1\n문장2"],
    ["문장1<br/><br/>문장2", "문장1\n\n문장2"],
  ])("turns %j into real line breaks", (input, expected) => {
    expect(lawDisplayText(input)).toBe(expected);
  });

  it("trims line-end spaces, caps blank runs at two lines and trims the whole text", () => {
    expect(lawDisplayText("문장1<br/><br/><br/><br/><br/>문장2")).toBe("문장1\n\n\n문장2");
    expect(lawDisplayText("  \n판시사항:   <br/>이유:\t\r\n본문  \n\n")).toBe("판시사항:\n이유:\n본문");
  });

  it("keeps every other tag as inert text", () => {
    const input = "판시사항<br><script>alert(\"x\")</script><img src=x onerror=alert(1)><b>강조</b>";
    expect(lawDisplayText(input)).toBe("판시사항\n<script>alert(\"x\")</script><img src=x onerror=alert(1)><b>강조</b>");
  });

  it("removes MCP tool-call guidance observed in live search, text and analysis results", () => {
    const input = [
      "[618081] 건물인도",
      "  사건번호: 2025다212423",
      "",
      "검색 보정: body_search=\"민법 해지 통고 기간\" (본문검색)",
      "",
      "💡 다음: get_precedent_text(id=\"618081\") 로 판결문 전문. full=true 로 축약 해제. 유사판례 원하면 find_similar_precedents 사용.",
      "특정 조문 조회: get_law_text(mst=\"283457\", jo=\"제XX조\")",
      "여러 조문 일괄 조회: get_batch_articles 도구 사용",
      "자동 상세조회: search_precedents -> get_precedent_text (상위 2건, full=false)",
      "자동 상세조회: search_admin_appeals -> get_admin_appeal_text (상위 1건)",
      "💡 다음: get_law_text(mst=\"283457\") 로 「근로기준법」 조문 전문. 특정 조문만은 jo=\"제N조\" 추가.",
    ].join("\n");
    expect(lawDisplayText(input)).toBe([
      "[618081] 건물인도",
      "  사건번호: 2025다212423",
      "",
      "검색어를 보정해 관련 결과를 찾았습니다.",
      "",
    ].join("\n").trim());
  });

  it("keeps the useful part of a line and drops only the tool reference", () => {
    expect(lawDisplayText("🔜 「근로기준법」 개정 시행예정 (일부개정, 2026-04-07 공포 제21533호, 시행 2026-10-08) — 시행예정본 조문: get_law_text(mst=\"285279\", efYd=\"20261008\")"))
      .toBe("🔜 「근로기준법」 개정 시행예정 (일부개정, 2026-04-07 공포 제21533호, 시행 2026-10-08)");
    expect(lawDisplayText("ℹ️ 조회기준일 20260925 — 위 시행일 버전 본문. 연혁 MST로 조회한 경우 과거 버전일 수 있으니, 개정 여부가 의심되면 search_law로 [현행] MST를 재확인할 것."))
      .toBe("ℹ️ 조회기준일 20260925 — 위 시행일 버전 본문.");
    expect(lawDisplayText("   변경 신호 감지는 휴리스틱입니다. 최종 확인은 후속 판결 전문 검토(get_decision_text) 및 종합법률정보 병행을 권장합니다."))
      .toBe("변경 신호 감지는 휴리스틱입니다. 최종 확인은 후속 판결 전문 검토 및 종합법률정보 병행을 권장합니다.");
    expect(lawDisplayText("⋯ 중략 3,198자 (full=true로 전문 조회) ⋯")).toBe("⋯ 중략 3,198자 ⋯");
  });

  it("drops agent-only lines and internal identifiers seen in legal_research output, keeping the facts", () => {
    expect(lawDisplayText([
      "   ⚠️ 이 섹션은 조회 실패 — LLM은 내용을 추측/생성하지 마세요.",
      "   사유: [NOT_FOUND] 해석례 검색 결과가 없습니다.",
      "  링크: /DRF/lawService.do?OC=***&amp;target=expc&amp;ID=312454&amp;type=HTML",
      "법령ID: 011357 | MST: 283839 | 구분: 법률",
      "법령: 행정심판법 (법률) | MST: 249041",
      "시점 A: 2021.11.19 시행 | MST 232199 | 공포 제18176호, 2021.05.18 공포, 일부개정 | 126개 조문",
      "⏱ 시간 한도로 이 섹션은 수집하지 못했습니다 — 개별 도구(search_ai_law)로 조회하세요.",
      "[생략] 법령 전체 조문의 이력입니다. 조문별로 조회하세요: get_article_history(lawId=\"001805\", jo=\"제93조\")",
    ].join("\n"))).toBe([
      "사유: [NOT_FOUND] 해석례 검색 결과가 없습니다.",
      "법령ID: 011357 | 구분: 법률",
      "법령: 행정심판법 (법률)",
      "시점 A: 2021.11.19 시행 | 공포 제18176호, 2021.05.18 공포, 일부개정 | 126개 조문",
      "⏱ 시간 한도로 이 섹션은 수집하지 못했습니다",
      "[생략] 법령 전체 조문의 이력입니다.",
    ].join("\n"));
  });

  it("never touches legal prose that merely shares words with the guidance", () => {
    const prose = [
      "다음과 같이 판결한다.",
      "다음 각 호에 해당하는 경우",
      "전문위원은 다음 사항을 검토한다.",
      "ID 번호는 계약서에 기재한다.",
      "【주    문】",
      " 1. 원고의 청구를 기각한다.",
      "검색 결과 판례를 전문(全文)으로 검토하였다.",
    ].join("\n");
    expect(lawDisplayText(prose)).toBe(prose);
  });

  it("formats a long judgment with paragraph breaks, stays fast and leaves the raw string unchanged", () => {
    const raw = Array.from({ length: 400 }, (_, index) => `【${index + 1}】 판결 이유 문단입니다. 다음과 같이 판단한다.<br/><br/>`).join("")
      + "\n💡 다음: get_precedent_text(id=\"1\") 로 판결문 전문.";
    const started = performance.now();
    const shown = lawDisplayText(raw);
    expect(performance.now() - started).toBeLessThan(200);
    expect(shown).not.toMatch(/<\s*\/?\s*br|get_precedent_text/iu);
    expect(shown.split("\n\n")).toHaveLength(400);
    expect(raw).toContain("<br/><br/>");
    expect(lawDisplayText(undefined)).toBe("");
  });
});
