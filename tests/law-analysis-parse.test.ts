import { describe, expect, it } from "vitest";
import { LAW_ANALYSIS_CASE_PATTERN, LAW_ANALYSIS_ERROR, lawAnalysisOutcome, lawAnalysisRequestFor, normalizeAnalysisDate, normalizeAnalysisJo, type LawAnalysisDraft } from "@/lib/law-analysis";
import { applicableLawPresentation, citationGroupLine, citationOverallLabel, citeCheckResult, impactMapResult, splitAnalysisText, verifyCitationsResult } from "@/lib/law-analysis-parse";

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

  it("maps citation symbols to reader labels no stronger than the MCP marker", () => {
    const result = verifyCitationsResult(VERIFY);
    expect(result.overallMarker).toBe("HALLUCINATION_DETECTED");
    expect(result.empty).toBe(false);
    expect(result.items.map(({ group, label, tone }) => [group, label, tone])).toEqual([
      ["law", "확인됨", "verified"],
      ["law", "확인됨", "verified"],
      ["law", "찾을 수 없음", "critical"],
      ["law", "내용 불일치", "critical"],
      ["law", "폐지 법령", "repealed"],
      ["law", "확인 필요", "unknown"],
      ["case", "확인됨", "verified"],
      ["case", "확인되지 않음", "unknown"],
    ]);
    expect(result.items[2].markers).toEqual(["NOT_FOUND"]);
    expect(result.items[3].markers).toEqual(["CONTENT_MISMATCH"]);
    expect(result.items[4].markers).toEqual(["REPEALED"]);
    // ⚠ stays "needs checking"; it is never turned into a wrong-citation verdict.
    expect(result.items.filter((item) => item.symbol === "⚠").every((item) => item.tone === "unknown")).toBe(true);
  });

  it("separates each citation from what the lookup found without existence jargon", () => {
    const result = verifyCitationsResult(VERIFY);
    expect(result.items.map(({ citation, detail }) => [citation, detail])).toEqual([
      ["민법 제750조(불법행위의 내용)", "법제처 법령 자료에서 조문 확인"],
      ["근로기준법 제60조(연차 유급휴가) 제1항", "법제처 법령 자료에서 조문 확인"],
      ["형법 제9999조", "해당 조문 없음 (존재 범위: 제1조~제372조)"],
      ["민법 제750조", "인용 제목 '계약해제' ≠ 실제 조문제목 '불법행위의 내용' (단순 표기차이 아니면 인용 오류)"],
      ["구 산업기술법 제3조", "「구 산업기술법」은(는) 폐지된 법령입니다(연혁, 최종시행 2010-01-01). 현행 법령이 아님 — 후속·대체 법령 확인 필요"],
      ["같은 법 시행규칙 제2조", "법령명 불명확 ('같은 법 시행규칙'은(는) 법령명으로 특정할 수 없음. 앞 문맥에 법령명 명시 필요)"],
      ["2013다61381", "대법원 2018.10.30 손해배상(기)"],
      ["2019가합12345", "미확인 (법제처 수록 판례에서 검색되지 않음. 하급심·미수록 판례일 수 있어 부존재로 단정 불가)"],
    ]);
    const shown = result.items.flatMap(({ label, citation, detail }) => [label, citation, detail]).join("\n");
    expect(shown).not.toMatch(/실존|\[[A-Z_]+\]/u);
  });

  it("summarises only statuses that occurred and restates agent notes for the reader", () => {
    const result = verifyCitationsResult(VERIFY);
    expect(result.groups.map(citationGroupLine)).toEqual([
      "법령 인용 6건 · 확인 2건 · 찾을 수 없음 1건 · 내용 불일치 1건 · 폐지 법령 1건 · 확인 필요 1건",
      "판례 인용 2건 · 확인 1건 · 확인되지 않음 1건",
    ]);
    const verified = verifyCitationsResult("[VERIFIED] == 인용 검증 결과 ==\n법령 인용 1건 | ✓ 1 실존 | ✗ 0 오류 | ⌛ 0 폐지 | ⚠ 0 확인필요\n판례 인용 0건 | ✓ 0 실존 | ✗ 0 실존불가 | ⚠ 0 미확인\n\n▶ 법령 인용\n✓ 민법 제750조(불법행위의 내용) 실존");
    expect(verified.groups.map(citationGroupLine)).toEqual(["법령 인용 1건 · 확인 1건", "판례 인용 없음"]);
    expect(verified.notes).toEqual([]);
    const notes = result.notes.flatMap((note) => note.lines).join("\n");
    // Banners restated by the overall verdict and agent-only instructions do not reach the reader.
    expect(notes).not.toMatch(/REPEALED_REFERENCE|HALLUCINATION_DETECTED|LLM|실존|API/u);
    expect(notes).toContain("확인되지 않은 판례가 존재하지 않는다는 뜻은 아닙니다");
    expect(notes).toContain("자료 조회가 일시적으로 실패한 경우");
  });

  it("distinguishes lookup failure, the lookup cap and not-in-collection for cases", () => {
    const result = verifyCitationsResult("[PARTIAL_VERIFIED] == 인용 검증 결과 ==\n▶ 판례 인용\n⚠ 2020다1 — 미확인 (조회 실패: timeout)\n⚠ 2020다2 — 미확인 (법제처 수록 판례에서 검색되지 않음. 하급심·미수록 판례일 수 있어 부존재로 단정 불가)\n⚠ 사건번호 2건은 확인 상한(15건)을 넘어 검증하지 않았습니다 — 미검증입니다: 2020다3, 2020다4");
    expect(result.items.map((item) => [item.label, item.tone])).toEqual([["조회 실패", "unknown"], ["확인되지 않음", "unknown"], ["검증하지 않음", "unknown"]]);
  });

  it("describes each header marker without inventing a stronger legal conclusion", () => {
    expect(citationOverallLabel("VERIFIED")).toBe("추출된 인용이 모두 확인되었습니다.");
    expect(citationOverallLabel("PARTIAL_VERIFIED")).toContain("확인이 필요한");
    expect(citationOverallLabel("REPEALED_REFERENCE")).toContain("폐지");
    expect(citationOverallLabel("HALLUCINATION_DETECTED")).toContain("확인되지 않거나");
    expect(citationOverallLabel("FUTURE_MARKER")).toBeUndefined();
    const none = verifyCitationsResult("[NO_CITATIONS_FOUND] 입력 텍스트에서 조문·판례 인용이 발견되지 않았습니다.\n\n⚠️ 이 결과는 '검증 성공'이 아니라 '검증할 인용이 없음'입니다.");
    expect(none).toMatchObject({ empty: true, items: [], notes: [], groups: [] });
  });

  it("words each citator verdict as could-not-confirm, never as absence or settled validity", () => {
    const result = citeCheckResult(CITE);
    expect(result.title).toBe("판례 인용 추적 (Citator): 2013다61381");
    expect(result.target).toEqual(["대상: 대법원 2018.10.30 선고 2013다61381 전원합의체 판결", "사건명: 손해배상(기)"]);
    expect(result.verdict).toMatchObject({ symbol: "❌", tone: "critical", lines: [
      "후속 판례에서 변경·폐기 정황이 발견되었습니다: 2022다1234(판례 변경)",
      "이 판례를 현재 법리로 인용하기 전에 해당 후속 판결 원문을 반드시 확인해 주세요.",
    ] });
    expect(result.sections.map((section) => section.heading)).toEqual(["이 판례를 인용한 후속 판례 (2건, 최신순)", "후속 판결 본문 확인 (2건, 본문 확인 불가 1건)"]);
    expect(result.sections[1].lines.join("\n")).toContain("본문 확인 불가 (조회 실패 또는 본문 미제공)");
    expect(result.limitation).toEqual(["후속 판례를 기준으로 자동 확인한 결과입니다. 법제처에 수록된 판례(대법원 중심)만 확인하며 하급심·미수록 판례의 인용은 포함되지 않습니다. 최종 판단이 필요한 경우 후속 판결 원문과 종합법률정보를 함께 확인해 주세요."]);
    const verdict = (line: string) => citeCheckResult(`═══ 판례 인용 추적 (Citator): 1 ═══\n대상: x\n\n📊 판정: ${line}`).verdict;
    expect(verdict("✅ 후속 인용 15건, 변경·폐기 신호 미감지 — 계속 인용되는 것으로 추정 (전원합의체 1건 포함 정밀 스캔 완료)")).toMatchObject({ tone: "neutral", lines: [
      "후속 인용 15건에서 변경·폐기 정황을 확인하지 못했습니다. 현재까지 계속 인용되는 것으로 보입니다. (후속 전원합의체 판결 1건 포함 본문 확인)",
    ] });
    expect(verdict("✅ 후속 인용 3건, 변경·폐기 신호 미감지 — 계속 인용되는 것으로 추정")?.lines).toEqual(["후속 인용 3건에서 변경·폐기 정황을 확인하지 못했습니다. 현재까지 계속 인용되는 것으로 보입니다."]);
    expect(verdict("⚠️ 미스캔 전원합의체 후속 판결 2건 존재 — 법리 변경 여부 본문 확인 권장 (2020다1, 2021다2)")).toMatchObject({ tone: "unknown", lines: [
      "본문을 확인하지 못한 후속 전원합의체 판결이 2건 있습니다 (2020다1, 2021다2). 법리 변경 여부는 해당 판결 원문에서 확인해 주세요.",
    ] });
    expect(verdict("⚠️ 후속 인용 7건, 정밀 스캔 대상 3건 중 1건 본문 확인 불가: 변경·폐기 여부 미확정 (2020다1). get_decision_text 로 해당 판결 전문을 확인하세요.")?.lines).toEqual([
      "후속 인용 7건 중 본문 확인 대상 3건에서 1건의 본문을 확인하지 못해 변경·폐기 여부를 확정하지 못했습니다 (2020다1). 해당 판결 원문을 확인해 주세요.",
    ]);
    expect(verdict("ℹ️ 법제처 수록 범위 내 후속 인용 없음 — 미수록 판례의 인용 가능성은 배제 못 함")).toMatchObject({ tone: "muted", lines: [
      "법제처 수록 범위에서 이 판례를 인용한 후속 판례를 찾지 못했습니다. 수록되지 않은 판례에서 인용되었을 가능성은 있습니다.",
    ] });
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

  it("separates applicable-law decision from actual statute text and preserves transition states", () => {
    const failed = applicableLawPresentation(APPLICABLE);
    expect(failed.mst).toBe("247265");
    expect(failed.jo).toBe("제44조");
    expect(failed.sections.flatMap(({ heading, lines }) => [heading, ...lines]).join("\n")).toContain("시행 예정 개정 1건");
    expect(failed.sections.flatMap(({ heading, lines }) => [heading, ...lines]).join("\n")).toContain("부칙 조회에 실패했습니다.");
    expect(failed.sections.flatMap(({ heading, lines }) => [heading, ...lines]).join("\n")).not.toMatch(/get_law_text|술에 취한 상태에서의 운전 금지/u);
    expect(failed.excerpts.map(({ heading, lines }) => `${heading}\n${lines.join("\n")}`).join("\n")).toContain("① 누구든지 술에 취한 상태에서 운전하여서는 아니 된다.");

    const unconfirmed = applicableLawPresentation(APPLICABLE.replace(
      "적용례·경과조치: [FAILED] 부칙 조회 실패 — get_law_text(mst=\"286419\")로 부칙을 직접 확인하세요.",
      "적용례·경과조치: 관련 부칙에서 경과규정 신호 미발견 — 부칙 원문 확인: get_law_text",
    ));
    expect(unconfirmed.sections.map((section) => section.heading)).toContain("적용례·경과조치: 관련 부칙에서 경과규정을 확인하지 못했습니다. 부칙 원문을 확인해 주세요.");
    expect(unconfirmed.excerpts).toEqual([{ heading: "조문 원문", lines: ["제44조(술에 취한 상태에서의 운전 금지)", "① 누구든지 술에 취한 상태에서 운전하여서는 아니 된다."] }]);
    const lineStatus = applicableLawPresentation(APPLICABLE.replace(
      "▶ 적용례·경과조치: [FAILED] 부칙 조회 실패 — get_law_text(mst=\"286419\")로 부칙을 직접 확인하세요.",
      "▶ 적용례·경과조치\n부칙 원문 확인: get_law_text",
    ));
    expect(lineStatus.sections.map((section) => section.heading)).toContain("적용례·경과조치: 관련 부칙에서 경과규정을 확인하지 못했습니다. 부칙 원문을 확인해 주세요.");
    expect(lineStatus.excerpts).toHaveLength(1);

    const withAddenda = applicableLawPresentation(APPLICABLE.replace(
      "▶ 적용례·경과조치: [FAILED] 부칙 조회 실패 — get_law_text(mst=\"286419\")로 부칙을 직접 확인하세요.",
      "▶ 적용례·경과조치 발췌 (기준일 사건에 영향 가능)\n  ◆ 부칙 <제20864호, 2025.04.01>\n  제2조(적용례) 종전 규정을 적용한다.",
    ));
    expect(withAddenda.sections.map((section) => section.heading)).toContain("적용례·경과조치: 관련 부칙 발췌를 원문에서 확인해 주세요.");
    expect(withAddenda.excerpts[1].lines).toContain("  제2조(적용례) 종전 규정을 적용한다.");
    const noAddenda = applicableLawPresentation(APPLICABLE.replace(
      "적용례·경과조치: [FAILED] 부칙 조회 실패 — get_law_text(mst=\"286419\")로 부칙을 직접 확인하세요.",
      "적용례·경과조치: [NOT_FOUND] 관련 부칙 없음",
    ));
    expect(noAddenda.sections.map((section) => section.heading)).toContain("적용례·경과조치: 관련 부칙을 찾지 못했습니다.");
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
  it("labels an impossible case number as unconfirmable and keeps stray lines of a citation list", () => {
    const result = verifyCitationsResult("[HALLUCINATION_DETECTED] == 인용 검증 결과 ==\n요약\n\n▶ 판례 인용\n✗ 2099다1 — [NOT_FOUND] 실존할 수 없는 사건번호 (사건연도가 미래)\n(추가 안내 줄)");
    expect(result.items).toMatchObject([{ group: "case", label: "확인할 수 없음", tone: "critical", markers: ["NOT_FOUND"], citation: "2099다1", detail: "유효하지 않은 사건번호 (사건연도가 미래)" }]);
    expect(result.notes).toEqual([{ lines: ["요약"] }, { heading: "판례 인용", lines: ["(추가 안내 줄)"] }]);
  });

  it("keeps a verdict without a known symbol and an impact graph that lists no axes", () => {
    expect(citeCheckResult("📊 판정: 새로운 판정 문구").verdict).toEqual({ symbol: "", tone: "muted", text: "새로운 판정 문구", lines: ["새로운 판정 문구"] });
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
    const absent = { found: false, mode: "impact_map", marker: "NOT_FOUND", text: "[NOT_FOUND] 조문" };
    expect(lawAnalysisOutcome(true, { data: absent })).toEqual({ kind: "missing", data: absent });
    expect(lawAnalysisOutcome(false, { error: { message: "법령 검색 요청이 많습니다." } })).toEqual({ kind: "error", message: "법령 검색 요청이 많습니다." });
    for (const body of [null, { data: null }, { data: { ...found, mode: "legal_research" } }, { data: { ...found, markers: [1] } },
      { data: { ...found, text: 1 } }, { data: { ...absent, marker: "INVALID_ARGUMENT" } }, { data: { ...absent, marker: "FAILED" } }, { data: { ...found, found: "yes" } }]) {
      expect(lawAnalysisOutcome(true, body)).toEqual({ kind: "error", message: LAW_ANALYSIS_ERROR });
    }
    expect(lawAnalysisOutcome(false, null)).toEqual({ kind: "error", message: LAW_ANALYSIS_ERROR });
  });
});
