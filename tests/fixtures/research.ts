/**
 * A `legal_research` full_research response shaped like the live chain
 * (captured 2026-09): statute search hits with upstream-truncated snippets, a
 * 132-article table of contents, a precedent search reporting 67 total but
 * returning 5, a failed and a time-limited section, a detail dump, an unknown
 * section, and the MCP's own `<br/>` and tool-call guidance.
 */
export function fullResearchFixture(): string {
  const article = (law: string, number: string, jo: string, title: string, body: string[]) => [
    law, `   제${number} (${title})`, `   ${jo}(${title})`, ...body.map((line) => ` ${line}`), "   시행: 2026.08.20 | 고용노동부", "",
  ];
  const articles = [
    ...article("근로기준법", "0076조의2", "제76조의2", "직장 내 괴롭힘의 금지", ["사용자 또는 근로자는 직장에서의 지위를 이용하여 괴롭힘을 하여서는 아니 된다."]),
    ...article("근로기준법", "0076조의3", "제76조의3", "직장 내 괴롭힘 발생 시 조치", ["① 누구든지 신고할 수 있다.", "③ 사용자는 제2항에 따른 ..."]),
    ...Array.from({ length: 8 }, (_, index) => article("근로기준법", `01${String(index).padStart(2, "0")}조`, `제1${String(index).padStart(2, "0")}조`, `조문 ${index}`, ["본문<br/>둘째 줄"])).flat(),
  ];
  const toc = Array.from({ length: 132 }, (_, index) => `제${index + 1}조 조문 제목 ${index + 1}`);
  const precedents = Array.from({ length: 5 }, (_, index) => [
    `[61947${index}] 판례 제목 ${index + 1}`, `  사건번호: 2024나2513${index}`, "  법원: 광주고등법원", "  선고일: 20250612", "  판결유형: 판결", "",
  ]).flat();
  return [
    "═══ 종합 리서치: 직장 내 괴롭힘 판단 기준 ═══", "",
    "▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 10건):", "", ...articles,
    "▶ 근로기준법 본문 (관련도 낮음)", "법령명: 근로기준법", "시행일: 20260820", "", "목차 (총 132개 조문)", "", ...toc, "",
    "특정 조문 조회: get_law_text(mst=\"283457\", jo=\"제XX조\")", "",
    "▶ 관련 판례", "판례 검색 결과 (총 67건, 1페이지):", "", ...precedents,
    "검색 보정: body_search=\"직장 내 괴롭힘 판단 기준\" (본문검색)", "",
    "💡 다음: get_precedent_text(id=\"619470\") 로 판결문 전문. full=true 로 축약 해제. 유사판례 원하면 find_similar_precedents 사용.", "",
    "▶ 법령 해석례 [NOT_FOUND / FAILED]", "   ⚠️ 이 섹션은 조회 실패 — LLM은 내용을 추측/생성하지 마세요.", "   사유: [NOT_FOUND] 해석례 검색 결과가 없습니다.", "",
    "▶ 관련 판례 상세", "자동 상세조회: search_precedents -> get_precedent_text (상위 2건, full=false)", "", "[619470] 판례 제목 1", "=== 판례 제목 1 ===", "전문:", "【원고】 원고<br/>【피고】 피고", "",
    "▶ 향후 추가될 수도 있는 섹션", "새로운 형식의 내용 한 줄", "",
    "▶ AI 검색 보완 정보", "⏱ 시간 한도로 이 섹션은 수집하지 못했습니다 — 개별 도구(search_ai_law)로 조회하세요.",
  ].join("\n");
}
