import { describe, expect, it } from "vitest";
import {
  EMPTY_RESEARCH_DRAFT, LAW_RESEARCH_ERROR, LAW_RESEARCH_TASKS, lawResearchOutcome, lawResearchRequestFor, parseResearchArticles,
  type LawResearchDraft,
} from "@/lib/law-research";
import { isSupportingSection, researchResult } from "@/lib/law-research-parse";
import { lawDisplayText } from "@/lib/law-display";
import { fullResearchFixture } from "./fixtures/research";

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
      // An empty search ([NOT_FOUND] reason) is a normal result, never counted as partial.
      const empty = section.lines.some((line) => /사유\s*:\s*\[NOT_FOUND\]/u.test(line));
      expect(section.unavailable).toBe(marked && !empty);
      expect(section.status === "not_found").toBe(empty);
    }
    expect(result.sources[0]).toBe("법제처 국가법령정보센터 OPEN API");
  });

  it("separates failed and time-limited sections from sections that simply returned data", () => {
    const full = researchResult(FIXTURES.full_research);
    expect(full.sections.map((section) => [section.heading, section.status, section.unavailable])).toEqual([
      ["AI 법령검색 결과", "available", false], ["관련 판례", "available", false], ["법령 해석례 [NOT_FOUND / FAILED]", "not_found", false],
    ]);
    expect(full.sections[2].markers).toEqual(["NOT_FOUND"]);
    expect(researchResult(FIXTURES.procedure_detail).sections.at(-1)).toMatchObject({ status: "timeout", unavailable: true });
    expect(researchResult(FIXTURES.action_basis).sections.at(-1)).toMatchObject({ status: "failed", unavailable: true });
    expect(researchResult(FIXTURES.ordinance_compare).sections.at(-1)).toMatchObject({ status: "failed", unavailable: true });
    // A section the chain titled "…실패" but did not mark keeps its own wording instead of being reclassified.
    const review = researchResult(FIXTURES.document_review);
    expect(review.sections.at(-1)).toMatchObject({ heading: "근거 법령 검색 실패", unavailable: false, markers: ["EXTERNAL_API_ERROR"] });
    expect(review.sections[0].lines.join("\n")).toContain("발견 리스크: 1건");
  });

  it("names a second data source only when the MCP text shows it", () => {
    expect(researchResult("═══ 쟁송 대비 ═══\n\n▶ 국세청 법령해석\n[1] 서면-2023").sources).toEqual(["법제처 국가법령정보센터 OPEN API", "국세법령정보시스템"]);
  });
});

describe("legal_research structured presentation", () => {
  const result = researchResult(fullResearchFixture());
  const byKind = (kind: string) => result.sections.filter((section) => section.kind === kind);

  it("recognises statute hits, the table of contents, the precedent list and detail dumps by content", () => {
    expect(result.sections.map((section) => section.kind)).toEqual([
      "law_articles", "law_toc", "decision_search", "other", "other", "detail", "other", "other",
    ]);
    const [articles] = byKind("law_articles");
    expect(articles.articles).toHaveLength(10);
    expect(articles.articles![0]).toEqual({
      law: "근로기준법", jo: "제76조의2", title: "직장 내 괴롭힘의 금지",
      excerpt: "사용자 또는 근로자는 직장에서의 지위를 이용하여 괴롭힘을 하여서는 아니 된다.",
      effective: "2026.08.20", ministry: "고용노동부",
    });
    expect(byKind("law_toc")[0].toc).toEqual({ law: "근로기준법", count: 132 });
  });

  it("keeps the upstream search snippet's ellipsis as it is", () => {
    expect(byKind("law_articles")[0].articles![1].excerpt).toBe("① 누구든지 신고할 수 있다.\n③ 사용자는 제2항에 따른 ...");
  });

  it("reports the search total separately from the hits actually returned, inventing none", () => {
    const [search] = byKind("decision_search");
    expect(search.decisions!.total).toBe(67);
    expect(search.decisions!.entries).toHaveLength(5);
    expect(search.decisions!.entries[0]).toEqual({ id: "619470", title: "판례 제목 1", caseNumber: "2024나25130", body: "광주고등법원", date: "20250612" });
  });

  it("moves only the table of contents and detail dumps to supporting material, keeping all 132 entries", () => {
    const supporting = result.sections.filter(isSupportingSection);
    expect(supporting.map((section) => section.kind)).toEqual(["law_toc", "detail"]);
    const toc = lawDisplayText(supporting[0].lines.join("\n"));
    expect(toc.match(/^제\d+조 /gmu)).toHaveLength(132);
  });

  it("keeps failed and time-limited sections flagged, and unknown sections as they are", () => {
    expect(result.sections.filter((section) => section.unavailable).map((section) => section.heading)).toEqual(["AI 검색 보완 정보"]);
    expect(result.sections.find((section) => section.heading?.startsWith("법령 해석례"))?.status).toBe("not_found");
    const unknown = result.sections.find((section) => section.heading === "향후 추가될 수도 있는 섹션")!;
    expect(unknown.kind).toBe("other");
    expect(unknown.lines).toEqual(["새로운 형식의 내용 한 줄"]);
  });

  it("shows no <br> or MCP guidance in any displayed block", () => {
    for (const section of result.sections) {
      expect(lawDisplayText(section.lines.join("\n"))).not.toMatch(/<\s*\/?\s*br|get_|search_|find_similar|body_search|full=|LLM/u);
    }
    expect(lawDisplayText(fullResearchFixture())).not.toMatch(/<\s*\/?\s*br|get_|search_|find_similar|body_search|full=|LLM/u);
  });

  it("does not fold one search list per contract risk into a single list", () => {
    const review = researchResult(FIXTURES.document_review.replace("[1] 2015다1234", "판례 검색 결과 (총 3건, 1페이지):\n\n[1] 가\n\n[다른 위험]\n판례 검색 결과 (총 5건, 1페이지):\n\n[2] 나"));
    expect(review.sections.find((section) => section.heading === "관련 판례")!.kind).toBe("other");
    expect(review.sections.find((section) => section.heading === "문서 리스크 분석")!.kind).toBe("other");
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

describe("empty, failed and time-limited sections", () => {
  it("folds the MCP's retry hints into the empty section instead of showing them as their own block", () => {
    const result = researchResult(["═══ 쟁송 대비: x ═══", "", "▶ 행정심판례 [NOT_FOUND / FAILED]", "   사유: [NOT_FOUND] 행정심판 'x' 검색 결과가 없습니다.", "", "",
      "힌트: 법제처 API는 공백 구분 키워드를 AND 조건으로 처리합니다.", "재시도 제안...", "", "", "▶ 대법원 판례", "[1] 해고"].join("\n"));
    expect(result.sections.map((section) => [section.heading ?? null, section.status])).toEqual([["행정심판례 [NOT_FOUND / FAILED]", "not_found"], ["대법원 판례", "available"]]);
    expect(result.sections[0].lines.join("\n")).toContain("힌트:");
  });
});
