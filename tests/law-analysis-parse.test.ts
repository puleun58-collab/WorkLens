import { describe, expect, it } from "vitest";
import { LAW_ANALYSIS_CASE_PATTERN, LAW_ANALYSIS_ERROR, lawAnalysisOutcome, lawAnalysisRequestFor, normalizeAnalysisDate, normalizeAnalysisJo, type LawAnalysisDraft } from "@/lib/law-analysis";
import { citationOverallLabel, citeCheckResult, impactMapResult, splitAnalysisText, verifyCitationsResult } from "@/lib/law-analysis-parse";

const VERIFY = [
  "[HALLUCINATION_DETECTED] == 인용 검증 결과 ==",
  "법령 인용 6건 | ✓ 2 실존 | ✗ 2 오류 | ⌛ 1 폐지 | ⚠ 1 확인필요",
  "판례 인용 2건 | ✓ 1 실존 | ✗ 0 실존불가 | ⚠ 1 미확인",
  "",
  "▶ 법령 인용",
  "✓ 민법 제750조(불법행위의 내용) 실존",
  "✓ 근로기준법 제60조(연차 유급휴가) 제1항 실존",
  "✗ 형법 제9999조 — [NOT_FOUND] 해당 조문 없음 (존재 범위: 제1조~제372조)",
  "✗ 민법 제750조 — [CONTENT_MISMATCH] 인용 제목 '계약해제' ≠ 실제 조문제목 '불법행위의 내용' (단순 표기차이 아니면 인용 오류)",
  "⌛ 구 산업기술법 제3조 — [REPEALED] 「구 산업기술법」은(는) 폐지된 법령입니다(연혁, 최종시행 2010-01-01). 실존했으나 현행 법령이 아님 — 후속·대체 법령 확인 필요",
  "⚠ 같은 법 시행규칙 제2조 — 법령명 불명확 ('같은 법 시행규칙'은(는) 법령명으로 특정할 수 없음. 앞 문맥에 법령명 명시 필요)",
  "",
  "▶ 판례 인용",
  "✓ 2013다61381 실존 — 대법원 2018.10.30 손해배상(기)",
  "⚠ 2019가합12345 — 미확인 (법제처 수록 판례에서 검색되지 않음. 하급심·미수록 판례일 수 있어 부존재로 단정 불가)",
  "",
  "⌛ [REPEALED_REFERENCE] 1건은 폐지된 법령(연혁) 인용입니다. 실존했던 법령이라 '환각'은 아니지만 현행이 아니므로, 후속·대체 법령으로 갱신이 필요한지 확인하세요.",
  "",
  "⚠️ [HALLUCINATION_DETECTED] 2건 인용이 법제처 DB에 실존하지 않거나 인용 내용(조문 제목)이 실제와 불일치합니다.",
  "   LLM이 지어낸 인용일 가능성이 높습니다. 원문을 수정하거나 사용자에게 '인용 오류'를 명시 보고하세요.",
  "",
  "💡 ⚠ 항목은 법령명 불명확/부분 매칭/API 일시 실패 등. 법령명을 명시하거나 재시도하세요.",
  "",
  "💡 판례 '미확인'은 부존재가 아닙니다 — 법제처 수록 판례는 대법원 중심이라 하급심·미수록 판례는 검색되지 않습니다.",
].join("\n");

const CITE = [
  "═══ 판례 인용 추적 (Citator): 2013다61381 ═══",
  "대상: 대법원 2018.10.30 선고 2013다61381 전원합의체 판결",
  "사건명: 손해배상(기)",
  "",
  "📊 판정: ❌ 변경·폐기 신호 감지 — 2022다1234(판례 변경)",
  "   ⚠️ 이 판례를 현재 법리로 인용하기 전에 반드시 해당 후속 판결 전문을 확인하세요.",
  "",
  "▶ 이 판례를 인용한 후속 판례 (2건, 최신순)",
  "  1. 대법원 2024.01.25 2022다1234 ⚡전원합의체 — 손해배상",
  "  2. 대법원 2023.12.21 2019다17485 — 손해배상(기)",
  "",
  "▶ 본문 정밀 스캔 (2건, 본문 확인 불가 1건)",
  "  - 2022다1234: 🚨 판례 변경",
  "  - 2019다17485: 본문 확인 불가 (조회 실패 또는 본문 미제공, 스캔 못 함)",
  "",
  "⚠️ 한계: 법제처 수록 판례(대법원 중심) 범위 내 검색입니다. 하급심·미수록 판례의 인용은 포함되지 않으며,",
  "   변경 신호 감지는 휴리스틱입니다.",
].join("\n");

const APPLICABLE = [
  "═══ 행위시법 판단: 도로교통법 @ 2023.05.10 ═══",
  "",
  "▶ 기준일에 시행 중이던 버전",
  "  도로교통법 [시행 2023.04.04] [제19158호, 2023.01.03, 일부개정] (MST 247265)",
  "  ↳ 기준일 이후 현재까지 14차례 개정·시행됨 (현행: 시행 2026.07.01)",
  "  ⚠️ 시행 예정 개정 1건 존재 — 최근접: 시행 2027.06.03 (제21728호, 일부개정).",
  "",
  "▶ 기준일 시점 조문: 제44조",
  "제44조(술에 취한 상태에서의 운전 금지)",
  "① 누구든지 술에 취한 상태에서 운전하여서는 아니 된다.",
  "",
  "▶ 현행과 비교: △ 변경됨 — 현행 본문과 다릅니다. 인용 시 반드시 기준일 버전을 사용하세요.",
  "",
  "▶ 적용례·경과조치: [FAILED] 부칙 조회 실패 — get_law_text(mst=\"286419\")로 부칙을 직접 확인하세요.",
  "",
  "⚖️ 적용 법령 판단 시 주의",
  "  - 위 원칙은 부칙 경과규정이 우선합니다 — 위 발췌를 반드시 확인하세요. 이 도구는 발췌만 제공하며 해석하지 않습니다.",
].join("\n");

const IMPACT = [
  "═══ Impact Map: 민법 제103조 ═══",
  "법령: 민법 (MST 284415, 법률)",
  "",
  "▶ 대상 조문 본문",
  "제103조(반사회질서의 법률행위) 선량한 풍속 기타 사회질서에 위반한 사항을 내용으로 하는 법률행위는 무효로 한다.",
  "",
  "▶ 영향 그래프 (이 조문이 인용된 곳)",
  "├─ 📚 대법원 판례: 7건 확인 / 검색 42건 — 표본 10건만 경계 확인, 나머지는 미확인",
  "│   • [245007] 반사회적 법률행위 · 사건번호: 대법원-2023-다-302036",
  "├─ ⚖️ 헌재 결정례: 조회 실패 (업스트림 오류로 확인 못 함, 0건이 아님)",
  "├─ 📑 법령해석례: 0건",
  "├─ 📋 행정심판례: 0건",
  "└─ 🏛️ 자치법규(법령 단위·조번호 미반영): 2건",
  "    • [1279715] 동해시 시민법률상담 운영 조례 · 지자체: 강원특별자치도 동해시",
  "ℹ️ 법령명 대조: 확정 4건 / 보류 2건",
  "",
  "▶ 총 영향 건수(경계 확인분): 9건 — 표본을 넘는 검색 결과가 있어 실제는 더 많을 수 있음 [부분 결과: 헌재 결정례 조회 실패, 해당 축 건수 미확인] (판례 7 / 헌재 0 / 해석 0 / 행심 0 / 조례 2)",
  "⚠️ 조회 실패 축은 0건이 아니라 미확인입니다.",
].join("\n");

/** Every non-empty source line must survive in the parsed structure. */
function renderedLines(document: ReturnType<typeof splitAnalysisText>): string[] {
  return [document.title ?? "", ...document.sections.flatMap((section) => [section.heading ?? "", ...section.lines])].map((line) => line.trim()).filter(Boolean);
}

describe("legal_analysis presentation parsing", () => {
  it("keeps every source line of each mode, including sections it does not recognize", () => {
    for (const text of [VERIFY, CITE, APPLICABLE, IMPACT, `${IMPACT}\n\n▶ 새로운 축 (향후 MCP 추가)\n  새로운 정보 한 줄`]) {
      const source = text.split("\n").map((line) => line.trim()).filter(Boolean);
      const kept = renderedLines(splitAnalysisText(text)).join("\n");
      for (const line of source) expect(kept).toContain(line.replace(/^(?:\[[A-Z_]+\]\s*)?(?:═══|==|▶|━━━|⚖️)\s*|\s*(?:═══|==|━━━)$/gu, ""));
    }
  });

  it("maps citation symbols to labels no stronger than the MCP marker", () => {
    const result = verifyCitationsResult(VERIFY);
    expect(result.overallMarker).toBe("HALLUCINATION_DETECTED");
    expect(result.items.map(({ group, label, tone }) => [group, label, tone])).toEqual([
      ["law", "실존 확인", "verified"],
      ["law", "실존 확인", "verified"],
      ["law", "찾을 수 없음", "critical"],
      ["law", "내용 불일치", "critical"],
      ["law", "폐지 법령", "repealed"],
      ["law", "확인 필요", "unknown"],
      ["case", "실존 확인", "verified"],
      ["case", "미확인", "unknown"],
    ]);
    expect(result.items[2].markers).toEqual(["NOT_FOUND"]);
    expect(result.items[3].markers).toEqual(["CONTENT_MISMATCH"]);
    expect(result.items[4].markers).toEqual(["REPEALED"]);
    // ⚠ stays "needs checking"; it is never turned into a wrong-citation verdict.
    expect(result.items.filter((item) => item.symbol === "⚠").every((item) => item.tone === "unknown")).toBe(true);
    expect(result.summary).toHaveLength(2);
    expect(result.notes.flatMap((note) => note.lines).join("\n")).toContain("[REPEALED_REFERENCE]");
    expect(result.notes.flatMap((note) => note.lines).join("\n")).toContain("판례 '미확인'은 부존재가 아닙니다");
  });

  it("describes each header marker without inventing a stronger legal conclusion", () => {
    expect(citationOverallLabel("VERIFIED")).toContain("실존으로 확인");
    expect(citationOverallLabel("PARTIAL_VERIFIED")).toContain("확인이 필요한");
    expect(citationOverallLabel("REPEALED_REFERENCE")).toContain("폐지");
    expect(citationOverallLabel("HALLUCINATION_DETECTED")).toContain("실존하지 않거나");
    expect(citationOverallLabel("FUTURE_MARKER")).toBeUndefined();
    const none = verifyCitationsResult("[NO_CITATIONS_FOUND] 입력 텍스트에서 조문·판례 인용이 발견되지 않았습니다.\n\n⚠️ 이 결과는 '검증 성공'이 아니라 '검증할 인용이 없음'입니다.");
    expect(none.items).toEqual([]);
    expect([...none.summary, ...none.notes.flatMap((note) => note.lines)].join("\n")).toContain("'검증 성공'이 아니라");
  });

  it("keeps the cite_check verdict, partial scan and coverage limitation verbatim", () => {
    const result = citeCheckResult(CITE);
    expect(result.title).toBe("판례 인용 추적 (Citator): 2013다61381");
    expect(result.target).toEqual(["대상: 대법원 2018.10.30 선고 2013다61381 전원합의체 판결", "사건명: 손해배상(기)"]);
    expect(result.verdict).toEqual({ symbol: "❌", tone: "critical", text: "변경·폐기 신호 감지 — 2022다1234(판례 변경)\n⚠️ 이 판례를 현재 법리로 인용하기 전에 반드시 해당 후속 판결 전문을 확인하세요." });
    expect(result.sections.map((section) => section.heading)).toEqual(["이 판례를 인용한 후속 판례 (2건, 최신순)", "본문 정밀 스캔 (2건, 본문 확인 불가 1건)"]);
    expect(result.sections[1].lines.join("\n")).toContain("본문 확인 불가");
    expect(result.limitation.join("\n")).toContain("법제처 수록 판례(대법원 중심) 범위 내 검색");
    for (const [symbol, tone] of [["✅", "neutral"], ["⚠️", "unknown"], ["ℹ️", "muted"]] as const) {
      expect(citeCheckResult(`═══ 판례 인용 추적 (Citator): 1 ═══\n대상: x\n\n📊 판정: ${symbol} 문구`).verdict).toMatchObject({ symbol, tone, text: "문구" });
    }
  });

  it("keeps applicable_law version, comparison, upcoming amendment and failed addenda sections", () => {
    const document = splitAnalysisText(APPLICABLE);
    expect(document.title).toBe("행위시법 판단: 도로교통법 @ 2023.05.10");
    expect(document.sections.map((section) => section.heading)).toEqual([
      "기준일에 시행 중이던 버전",
      "기준일 시점 조문: 제44조",
      "현행과 비교: △ 변경됨 — 현행 본문과 다릅니다. 인용 시 반드시 기준일 버전을 사용하세요.",
      "적용례·경과조치: [FAILED] 부칙 조회 실패 — get_law_text(mst=\"286419\")로 부칙을 직접 확인하세요.",
      "적용 법령 판단 시 주의",
    ]);
    expect(document.sections[0].lines.join("\n")).toContain("시행 예정 개정 1건");
    expect(document.sections[1].lines).toEqual(["제44조(술에 취한 상태에서의 운전 금지)", "① 누구든지 술에 취한 상태에서 운전하여서는 아니 된다."]);
  });

  it("marks a failed impact axis as unknown instead of zero and keeps sampled counts as reported", () => {
    const result = impactMapResult(IMPACT);
    expect(result.axes.map(({ label, value, failed }) => [label, value, failed])).toEqual([
      ["📚 대법원 판례", "7건 확인 / 검색 42건 — 표본 10건만 경계 확인, 나머지는 미확인", false],
      ["⚖️ 헌재 결정례", "조회 실패 (업스트림 오류로 확인 못 함, 0건이 아님)", true],
      ["📑 법령해석례", "0건", false],
      ["📋 행정심판례", "0건", false],
      ["🏛️ 자치법규(법령 단위·조번호 미반영)", "2건", false],
    ]);
    expect(result.axes[0].items).toEqual(["[245007] 반사회적 법률행위 · 사건번호: 대법원-2023-다-302036"]);
    expect(result.graphNotes).toEqual(["ℹ️ 법령명 대조: 확정 4건 / 보류 2건"]);
    expect(result.sections[result.graphIndex + 1].heading).toContain("경계 확인분");
    expect(result.sections[result.graphIndex + 1].heading).toContain("실제는 더 많을 수 있음");
    const missingArticle = impactMapResult("═══ Impact Map: 민법 제9999조 ═══\n\n▶ 대상 조문 본문 [NOT_FOUND] 조문 조회 실패 — 법령명·조문번호 확인 필요\n\n▶ 영향 그래프 (이 조문이 인용된 곳)\n├─ 📚 대법원 판례: 0건");
    expect(missingArticle.sections[0].heading).toContain("[NOT_FOUND]");
  });
  it("labels an impossible case citation as '실존 불가' and keeps stray lines of a citation list", () => {
    const result = verifyCitationsResult("[HALLUCINATION_DETECTED] == 인용 검증 결과 ==\n요약\n\n▶ 판례 인용\n✗ 2099다1 — [NOT_FOUND] 실존할 수 없는 사건번호 (사건연도가 미래)\n(추가 안내 줄)");
    expect(result.items).toMatchObject([{ group: "case", label: "실존 불가", tone: "critical", markers: ["NOT_FOUND"] }]);
    expect(result.notes).toEqual([{ heading: "판례 인용", lines: ["(추가 안내 줄)"] }]);
  });

  it("keeps a verdict without a known symbol and an impact graph that lists no axes", () => {
    expect(citeCheckResult("📊 판정: 새로운 판정 문구").verdict).toEqual({ symbol: "", tone: "muted", text: "새로운 판정 문구" });
    const graph = impactMapResult("═══ Impact Map: 민법 제1조 ═══\n\n▶ 영향 그래프 (이 조문이 인용된 곳)\n│   • 축 없이 나온 항목\n새 형식 안내");
    expect(graph.axes).toEqual([]);
    expect(graph.graphNotes).toEqual(["│   • 축 없이 나온 항목", "새 형식 안내"]);
  });
});

describe("legal_analysis form input", () => {
  const draft = (changes: Partial<LawAnalysisDraft> = {}): LawAnalysisDraft => ({
    text: "", caseNumber: "", applicable: { lawName: "", date: "", jo: "" }, impact: { lawName: "", jo: "" }, ...changes,
  });

  it("normalizes loose article input to the canonical 제N조 form", () => {
    expect(["74", "74조", "제74조", " 제 74 조 ", "10조의2", ""].map(normalizeAnalysisJo)).toEqual(["제74조", "제74조", "제74조", "제74조", "제10조의2", ""]);
  });

  it("builds only the fixed per-mode request and nothing while input is incomplete", () => {
    expect(lawAnalysisRequestFor("verify_citations", draft({ text: "  민법 제750조  " }))).toEqual({ mode: "verify_citations", text: "민법 제750조" });
    expect(lawAnalysisRequestFor("verify_citations", draft({ text: "   " }))).toBeNull();
    expect(lawAnalysisRequestFor("verify_citations", draft({ text: "가".repeat(5001) }))).toBeNull();
    expect(lawAnalysisRequestFor("cite_check", draft({ caseNumber: " 2013다61381 " }))).toEqual({ mode: "cite_check", caseNumber: "2013다61381" });
    expect(lawAnalysisRequestFor("cite_check", draft({ caseNumber: "손해배상" }))).toBeNull();
    expect(lawAnalysisRequestFor("applicable_law", draft({ applicable: { lawName: " 도로교통법 ", date: "2023-05-10", jo: "44" } })))
      .toEqual({ mode: "applicable_law", lawName: "도로교통법", date: "2023-05-10", jo: "제44조" });
    expect(lawAnalysisRequestFor("applicable_law", draft({ applicable: { lawName: "도로교통법", date: "2023-05-10", jo: "" } })))
      .toEqual({ mode: "applicable_law", lawName: "도로교통법", date: "2023-05-10" });
    for (const applicable of [{ lawName: "", date: "2023-05-10", jo: "" }, { lawName: "도로교통법", date: "", jo: "" },
      { lawName: "도로교통법", date: "2023-02-30", jo: "" }, { lawName: "도로교통법", date: "2023-05-10", jo: "제0조" }, { lawName: "법".repeat(101), date: "2023-05-10", jo: "" }]) {
      expect(lawAnalysisRequestFor("applicable_law", draft({ applicable }))).toBeNull();
    }
    expect(lawAnalysisRequestFor("impact_map", draft({ impact: { lawName: "민법", jo: "103" } }))).toEqual({ mode: "impact_map", lawName: "민법", jo: "제103조" });
    for (const impact of [{ lawName: "민법", jo: "" }, { lawName: "", jo: "제103조" }, { lawName: "민법", jo: "백삼조" }]) {
      expect(lawAnalysisRequestFor("impact_map", draft({ impact }))).toBeNull();
    }
  });
});

describe("legal_analysis client contract", () => {
  it("accepts only real reference dates in both supported forms without defaulting to today", () => {
    expect(normalizeAnalysisDate("2023-05-10")).toBe("2023-05-10");
    expect(normalizeAnalysisDate("20230510")).toBe("2023-05-10");
    expect(normalizeAnalysisDate("2024-02-29")).toBe("2024-02-29");
    for (const invalid of ["", "2023-02-30", "2023-13-01", "1899-12-31", "2101-01-01", "2023/05/10", "yesterday", "2023-5-10"]) {
      expect(normalizeAnalysisDate(invalid)).toBeNull();
    }
  });

  it("accepts court case numbers and rejects free text", () => {
    for (const valid of ["2013다61381", "96누4671", "2017다360, 2017다377", "2020헌바552"]) expect(LAW_ANALYSIS_CASE_PATTERN.test(valid)).toBe(true);
    for (const invalid of ["손해배상", "2013", "2013다", "<script>", "2013다61381; DROP"]) expect(LAW_ANALYSIS_CASE_PATTERN.test(invalid)).toBe(false);
  });

  it("separates explicit absence from failures and rejects malformed success", () => {
    const found = { found: true, mode: "cite_check", text: "═══ x ═══", markers: [] };
    expect(lawAnalysisOutcome(true, { data: found })).toEqual({ kind: "found", data: found });
    const absent = { found: false, mode: "impact_map", marker: "INVALID_ARGUMENT", text: "[INVALID_ARGUMENT] 조문" };
    expect(lawAnalysisOutcome(true, { data: absent })).toEqual({ kind: "missing", data: absent });
    expect(lawAnalysisOutcome(false, { error: { message: "법령 검색 요청이 많습니다." } })).toEqual({ kind: "error", message: "법령 검색 요청이 많습니다." });
    for (const body of [null, { data: null }, { data: { ...found, mode: "legal_research" } }, { data: { ...found, markers: [1] } },
      { data: { ...found, text: 1 } }, { data: { ...absent, marker: "FAILED" } }, { data: { ...found, found: "yes" } }]) {
      expect(lawAnalysisOutcome(true, body)).toEqual({ kind: "error", message: LAW_ANALYSIS_ERROR });
    }
    expect(lawAnalysisOutcome(false, null)).toEqual({ kind: "error", message: LAW_ANALYSIS_ERROR });
  });
});
