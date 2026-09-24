import { describe, expect, it } from "vitest";
import {
  EMPTY_RESEARCH_DRAFT, LAW_RESEARCH_ERROR, LAW_RESEARCH_TASKS, lawResearchOutcome, lawResearchRequestFor, parseResearchArticles,
  type LawResearchDraft,
} from "@/lib/law-research";
import { researchResult } from "@/lib/law-research-parse";

const draft = (changes: Partial<LawResearchDraft> = {}): LawResearchDraft => ({ ...EMPTY_RESEARCH_DRAFT, ...changes });

// Representative live shapes of each chain (trimmed).
const FIXTURES: Record<string, string> = {
  full_research: "═══ 종합 리서치: 직장 내 괴롭힘 판단 기준 ═══\n\n▶ AI 법령검색 결과\n근로기준법 제76조의2\n\n▶ 관련 판례\n[1] 2020다1234\n\n▶ 법령 해석례 [NOT_FOUND / FAILED]\n   ⚠️ 이 섹션은 조회 실패 — LLM은 내용을 추측/생성하지 마세요.\n   사유: [NOT_FOUND] 해석례 검색 결과가 없습니다.",
  law_system: "═══ 법체계 확인: 개인정보 보호법 ═══\n\n▶ 3단 비교 (법률·시행령·시행규칙)\n제38조 권리행사의 방법 및 절차\n  [시행령] 제41조",
  action_basis: "═══ 처분 근거 확인: 개인정보 보호법 ═══\n\n▶ 벌칙·과태료 조항\n제75조(과태료)\n\n▶ 행정심판례 [NOT_FOUND / FAILED]\n   사유: [FAILED] 업스트림 오류",
  dispute_prep: "═══ 쟁송 대비: 부당해고 구제 ═══\n\n▶ 대법원 판례\n[1] 2019두1234\n\n▶ 중앙노동위 결정\n[1] 2023부해100",
  amendment_track: "═══ 개정 추적: 근로기준법 ═══\n\n▶ 신구대조표 (최근 개정)\n제60조 …\n\n▶ Time Travel — 근로기준법 (20211119 ↔ 20251023)\n변경 조문 3건",
  ordinance_compare: "═══ 조례 비교 연구: 주차장법 관련 조례 ═══\n\n▶ 상위 법령\n주차장법 (법률) | MST: 283743\n\n▶ 전국 자치법규 검색 결과 [NOT_FOUND / FAILED]\n   사유: 조회 실패",
  procedure_detail: "═══ 절차/비용 안내: 행정심판 청구 절차와 제출서류 ═══\n\n▶ 행정심판법 별표/서식\n[별지 제30호서식] 행정심판 청구서\n\n▶ AI 검색 보완 정보\n⏱ 시간 한도로 이 섹션은 수집하지 못했습니다 — 개별 도구(search_ai_law)로 조회하세요.",
  document_review: "═══ 문서 종합 검토 ═══\n\n▶ 문서 리스크 분석\n=== 문서 리스크 분석 ===\n\n문서 유형: 일반 계약\n발견 리스크: 1건\n  검색: 계약 해지 제한\n\n▶ 관련 판례\n[계약 해지 제한]\n[1] 2015다1234\n\n▶ 근거 법령 검색 실패\n[계약 해지 제한]\n[EXTERNAL_API_ERROR] 오류",
};

describe("legal_research result parsing", () => {
  it.each(Object.entries(FIXTURES))("keeps every %s line and flags only MCP-marked unavailable sections", (_task, text) => {
    const result = researchResult(text);
    const kept = [result.title ?? "", ...result.sections.flatMap((section) => [section.heading ?? "", ...section.lines])].join("\n");
    for (const line of text.split("\n").map((value) => value.trim()).filter(Boolean)) {
      expect(kept).toContain(line.replace(/^(?:═══|▶)\s*|\s*═══$/gu, ""));
    }
    for (const section of result.sections) {
      const marked = /\[(?:NOT_FOUND \/ FAILED|FAILED)\]/u.test(section.heading ?? "") || section.lines.some((line) => line.trim().startsWith("⏱"));
      expect(section.unavailable).toBe(marked);
    }
    expect(result.sources[0]).toBe("법제처 국가법령정보센터 OPEN API");
  });

  it("separates failed and time-limited sections from sections that simply returned data", () => {
    const full = researchResult(FIXTURES.full_research);
    expect(full.sections.map((section) => [section.heading, section.unavailable])).toEqual([
      ["AI 법령검색 결과", false], ["관련 판례", false], ["법령 해석례 [NOT_FOUND / FAILED]", true],
    ]);
    expect(full.sections[2].markers).toEqual(["NOT_FOUND"]);
    expect(researchResult(FIXTURES.procedure_detail).sections.at(-1)?.unavailable).toBe(true);
    // A section the chain titled "…실패" but did not mark keeps its own wording instead of being reclassified.
    const review = researchResult(FIXTURES.document_review);
    expect(review.sections.at(-1)).toMatchObject({ heading: "근거 법령 검색 실패", unavailable: false, markers: ["EXTERNAL_API_ERROR"] });
    expect(review.sections[0].lines.join("\n")).toContain("발견 리스크: 1건");
  });

  it("names a second data source only when the MCP text shows it", () => {
    expect(researchResult("═══ 쟁송 대비 ═══\n\n▶ 국세청 법령해석\n[1] 서면-2023").sources).toEqual(["법제처 국가법령정보센터 OPEN API", "국세법령정보시스템"]);
  });
});

describe("legal_research form input", () => {
  it("offers all eight tasks with Korean names", () => {
    expect(LAW_RESEARCH_TASKS.map((task) => task.value)).toEqual([
      "full_research", "law_system", "action_basis", "dispute_prep", "amendment_track", "ordinance_compare", "procedure_detail", "document_review",
    ]);
    expect(LAW_RESEARCH_TASKS.every((task) => /[가-힣]/u.test(task.label))).toBe(true);
  });

  it("builds only the task's own fields", () => {
    const full = draft({ query: " 질문 ", text: "무시", domain: "labor", parentLaw: "주차장법", articles: "제38조", includeHistory: true });
    expect(lawResearchRequestFor("full_research", full)).toEqual({ task: "full_research", query: "질문" });
    expect(lawResearchRequestFor("procedure_detail", full)).toEqual({ task: "procedure_detail", query: "질문" });
    expect(lawResearchRequestFor("dispute_prep", full)).toEqual({ task: "dispute_prep", query: "질문", domain: "labor" });
    expect(lawResearchRequestFor("dispute_prep", draft({ query: "q" }))).toEqual({ task: "dispute_prep", query: "q" });
    expect(lawResearchRequestFor("ordinance_compare", full)).toEqual({ task: "ordinance_compare", query: "질문", parentLaw: "주차장법" });
    expect(lawResearchRequestFor("law_system", full)).toEqual({ task: "law_system", query: "질문", articles: ["제38조"] });
    expect(lawResearchRequestFor("amendment_track", full)).toEqual({ task: "amendment_track", query: "질문", includeHistory: true });
    expect(lawResearchRequestFor("document_review", draft({ query: "질문", text: "  갑은 계약 체결 즉시 대금 전액을 지급한다.  " })))
      .toEqual({ task: "document_review", text: "갑은 계약 체결 즉시 대금 전액을 지급한다." });
  });

  it("blocks incomplete or invalid input before any request", () => {
    expect(lawResearchRequestFor("full_research", draft({ query: "  " }))).toBeNull();
    expect(lawResearchRequestFor("full_research", draft({ query: "가".repeat(2001) }))).toBeNull();
    expect(lawResearchRequestFor("document_review", draft({ text: "짧은 문장" }))).toBeNull();
    expect(lawResearchRequestFor("document_review", draft({ text: "가".repeat(20_001) }))).toBeNull();
    expect(lawResearchRequestFor("law_system", draft({ query: "q", articles: "백조" }))).toBeNull();
    expect(lawResearchRequestFor("ordinance_compare", draft({ query: "q", parentLaw: "법".repeat(101) }))).toBeNull();
  });

  it("compares two real dates only in time travel, with the start not after the end", () => {
    const base = { query: "근로기준법", scenario: "time_travel" as const };
    expect(lawResearchRequestFor("amendment_track", draft({ ...base, fromDate: "2022-01-01", toDate: "2026-01-01" })))
      .toEqual({ task: "amendment_track", query: "근로기준법", scenario: "time_travel", fromDate: "2022-01-01", toDate: "2026-01-01" });
    expect(lawResearchRequestFor("amendment_track", draft({ ...base, fromDate: "2024-02-29", toDate: "2024-02-29" }))).not.toBeNull();
    for (const [fromDate, toDate] of [["", "2026-01-01"], ["2026-01-02", "2026-01-01"], ["2023-02-29", "2024-01-01"], ["2023-13-01", "2024-01-01"]]) {
      expect(lawResearchRequestFor("amendment_track", draft({ ...base, fromDate, toDate }))).toBeNull();
    }
    expect(lawResearchRequestFor("amendment_track", draft({ query: "q", scenario: "timeline", fromDate: "2022-01-01" })))
      .toEqual({ task: "amendment_track", query: "q", scenario: "timeline" });
  });

  it("normalizes article lists and rejects anything else", () => {
    expect(parseResearchArticles("38, 제39조의2 제38조")).toEqual(["제38조", "제39조의2"]);
    expect(parseResearchArticles("")).toEqual([]);
    expect(parseResearchArticles(Array.from({ length: 11 }, (_, index) => `제${index + 1}조`).join(","))).toBeNull();
  });

  it("treats only explicit NOT_FOUND as absence", () => {
    const found = { found: true, task: "law_system", text: "═══ x ═══", markers: [] };
    expect(lawResearchOutcome(true, { data: found })).toEqual({ kind: "found", data: found });
    const absent = { found: false, task: "full_research", marker: "NOT_FOUND", text: "[NOT_FOUND]" };
    expect(lawResearchOutcome(true, { data: absent })).toEqual({ kind: "missing", data: absent });
    expect(lawResearchOutcome(false, { error: { message: "요청이 많습니다." } })).toEqual({ kind: "error", message: "요청이 많습니다." });
    for (const body of [null, { data: { ...found, task: "legal_analysis" } }, { data: { ...found, markers: [1] } }, { data: { ...absent, marker: "FAILED" } }]) {
      expect(lawResearchOutcome(true, body)).toEqual({ kind: "error", message: LAW_RESEARCH_ERROR });
    }
  });
});
