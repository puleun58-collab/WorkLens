import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { appendMissingLawSystemArticles, ResearchResult } from "../src/components/research/LegalResearch";
import { assessLawSystem } from "../src/lib/law-system-evidence";
import { assessActionBasis } from "../src/lib/action-basis-evidence";
import type { LawResearchData, LawResearchRequest } from "../src/lib/law-research";

const excerpt = "① 해고의 기준을 확인한다.\n② 마지막 항도 보존한다.";
const article = { law: "근로기준법", jo: "제23조", title: "해고 등의 제한", excerpt, effectiveDate: "2025.01.01", matched: ["해고"] };
const reference = { law: article.law, jo: article.jo, currency: "current" as const };
const text = `═══ 조회 결과 ═══\n▶ AI 법령검색 결과\n지능형 법령검색 결과 (법령조문, 1건):\n\n근로기준법\n   제0023조 (해고 등의 제한)\n${excerpt}\n   시행: 2025.01.01 | 고용노동부`;
function render(data: LawResearchData) {
  const before = structuredClone(data);
  const html = renderToStaticMarkup(createElement(ResearchResult, {
    data, request: { task: data.task, query: "해고" } as LawResearchRequest, onExpandSourcesChange: () => undefined,
  }));
  expect(data).toEqual(before);
  // No dangling controls, including controls leading into collapsed sources.
  for (const [, id] of html.matchAll(/aria-controls="([^"]+)"/gu)) expect(html).toContain(`id="${id}"`);
  const ids = [...html.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  return html;
}
const base = { found: true, task: "full_research", text, markers: [] } satisfies LawResearchData;

describe("research result source structure", () => {
  it("links independent action checks to retrieved originals and keeps missing requirements accessible", () => {
    const actionText = "═══ 처분 근거 확인: 식품위생법 ═══\n▶ 법령 체계\n[법률] 식품위생법 제75조 (영업정지)\n영업정지 처분을 할 수 있다.";
    const actionBasis = assessActionBasis("식품위생법 영업정지 근거와 요건", actionText);
    const html = render({ ...base, task: "action_basis", text: actionText, actionBasis });
    expect(html).toContain('data-status="partial"');
    expect(html).toMatch(/research-summary-status[^>]*data-tone="warning"[^>]*>.*?적용 요건 확인 필요/u);
    expect(html).toContain("적용 요건 추가 확인 필요");
    // Top shows label + status only: no repeated article list, no jump
    // button into the detail section below (that section is the single home).
    expect(html).not.toContain('aria-controls="research-task-evidence-');
    const lower = html.slice(html.indexOf('aria-label="항목별 법적 근거"'));
    expect(lower).toContain('id="research-task-evidence-1"');
    expect(lower).toContain('id="research-task-evidence-2"');
    expect(lower).toContain("영업정지 처분을 할 수 있다.");
    expect(lower).toContain("법제처 원문 보기");
    expect(lower).toContain("적용 대상·처분 대상 위반행위의 요건 문언을 확인하지 못했습니다.");
    expect(lower).toContain("관련 검토 항목: 처분 근거");
  });

  it("separates an identified disposition table from confirmed law and conditions", () => {
    const body = "① 영업자는 위반행위가 있는 경우 영업정지 처분을 받을 수 있다.";
    const source = { law: "식품위생법", jo: "제75조", title: "허가취소 등", excerpt: body };
    const html = render({ ...base, task: "action_basis", actionBasis: { status: "matched", items: [
      { label: "처분·허가 근거", title: "처분 근거", status: "found", basisRefs: [source] },
      { label: "적용 요건", status: "found", requirementRefs: [source] },
      { label: "세부 기준(별표)", title: "세부 처분 기준", optional: true, status: "found", detail: "식품위생법 시행규칙 별표 23" },
    ] }, annexes: [{ law: "식품위생법 시행규칙", label: "별표 23", sourceArticle: "제89조",
      citation: "법 제75조의 행정처분 기준은 별표 23과 같다.", status: "identified", relevance: "direct",
      url: "https://www.law.go.kr/법령별표서식/(식품위생법시행규칙,별표23)" }] });
    const sources = html.slice(html.indexOf('aria-label="상세 근거"'), html.indexOf('class="law-detail-source research-source"'));
    const top = html.slice(0, html.indexOf('aria-label="항목별 법적 근거"'));
    expect(top).not.toContain("식품위생법 시행규칙 별표 23");
    expect(top).toContain("기준 목록 확인 · 원문 미확보");
    expect(sources.match(/식품위생법 제75조/gu)).toHaveLength(1);
    expect(sources).toContain("처분 근거 (법적 근거 · 근거 확인)");
    expect(sources).toContain("적용 요건 (요건 문언 · 근거 확인)");
    expect(sources).toContain("별표 23");
    expect(sources).toContain("원문 일부 확인");
    expect(html).toContain("세부 처분 기준");
    expect(html).toContain("세부 기준 원문을 확인하지 못했습니다");
    expect(sources).not.toContain("별표 원문 보기");
  });

  it("does not present an unrelated annex as a confirmed disposition criterion", () => {
    const html = render({ ...base, task: "action_basis", actionBasis: { status: "viewed", items: [
      { label: "처분·허가 근거", title: "처분 근거", status: "viewed", basisRefs: [] },
    ] }, annexes: [{ law: "식품위생법 시행령", label: "별표 1", sourceArticle: "제53조",
      citation: "과징금 산정은 별표 1과 같다.", status: "verified", text: "과징금 기준", relevance: "related" }] });
    expect(html).not.toContain("세부 처분 기준");
    expect(html).toContain("직접 관련성 미확인");
  });

  it("keeps separate missing action results even when neither has a structured source", () => {
    const html = render({ ...base, task: "action_basis", actionBasis: { status: "viewed", items: [
      { label: "처분·허가 근거", status: "viewed", basisRefs: [] },
      { label: "적용 요건", status: "viewed", requirementRefs: [] },
    ] } });
    expect(html).toContain('id="research-task-evidence-1"');
    expect(html).toContain('id="research-task-evidence-2"');
    expect(html).toContain("필수 항목 추가 확인 필요");
    expect(html).not.toContain("확인된 사실: 조회 원문에");
  });

  it.each([false, true])("preserves a complete badge with reference-only gaps (lookup failure: %s)", (failed) => {
    const html = render({ ...base, task: "action_basis", actionBasis: { status: "matched", items: [
      { label: "처분·허가 근거", status: "found", basisRefs: [] },
    ] }, followup: { status: failed ? "failed" : "partial", attempted: 2, failed: failed ? 2 : 0, missing: 1, limited: true } });
    expect(html).toMatch(/research-summary-status[^>]*data-tone="success"[^>]*>.*?관련 근거 확인/u);
    expect(html).toMatch(/research-summary-notice[^>]*data-tone="info"[^>]*>.*?일부 참고 자료 미확보/u);
    expect(html).not.toContain('class="legal-analysis-title" data-status="partial"');
    if (failed) expect(html).toContain("일부 참고 자료 조회가 실패");
  });

  it("keeps failures red and preserves available bodies without asserting absence", () => {
    const html = render({ ...base, task: "action_basis", actionBasis: { status: "failed", items: [] } });
    expect(html).toMatch(/research-summary-status[^>]*data-tone="error"[^>]*>.*?조회 미완료/u);
    expect(html).toMatch(/research-summary-notice[^>]*data-tone="error"/u);
    expect(html).toContain("조회 실패는 관련 근거가 없다는 뜻이 아닙니다.");
    expect(html).toContain("② 마지막 항도 보존한다.");
    expect(html).not.toContain("확인 근거 없음");
  });

  it("uses one notice for the same missing procedure requirement", () => {
    const html = render({ ...base, task: "procedure_detail", procedure: {
      overall: "partial", incomplete: false, annexTruncated: false, annexOriginStage: "list-only", failedSections: 0, steps: [],
      requirements: [{ kind: "procedure", label: "청구 절차", status: "viewed", articles: [], annexCount: 0, annexOriginStage: "list-only", annexRelatedCandidates: [] }],
    } });
    expect(html.match(/data-slot="alert-title"/gu)).toHaveLength(1);
    expect(html).toContain("필수 항목 추가 확인 필요");
    expect(html).not.toContain("절차 상세 확인 필요");
  });

  it("names a required form-original gap once while preserving an independent retrieval failure", () => {
    const html = render({ ...base, task: "procedure_detail", procedure: {
      overall: "partial", incomplete: true, annexTruncated: false, annexOriginStage: "list-only", failedSections: 0, steps: [],
      requirements: [{ kind: "forms", label: "제출 서식", status: "found", articles: [], annexCount: 1, annexVerifiedCount: 0, annexOriginStage: "list-only", annexRelatedCandidates: [],
        classifiedForms: [{ title: "신청서", duty: "required", original: "missing", articles: [], direct: false }] }],
    }, followup: { status: "failed", attempted: 1, failed: 1, missing: 1, limited: false } });
    expect(html).toMatch(/research-summary-status[^>]*data-tone="warning"[^>]*>.*?서식 원문 확인 필요/u);
    expect(html).toContain("서식 원문 추가 확인 필요");
    expect(html).not.toContain("별표·서식 원문 미확보");
    // The retrieval failure is a different cause, named inside the one notice instead of a second box.
    expect(html.match(/data-slot="alert-title"/gu)).toHaveLength(1);
    expect(html).toContain("일부 자료 조회도 완료되지 않았습니다. 조회 실패는 근거가 없다는 뜻이 아닙니다.");
    expect(html).not.toContain("추가 자료 조회 미완료");
  });

  it.each(["law_system", "full_research"] as const)("keeps the final law-system relations accessible in %s", (task) => {
    const initial = "═══ 법체계 확인: 개인정보 보호법 ═══\n▶ 3단 비교 (법률·시행령·시행규칙)\n[시행령] 개인정보 보호법 시행령 제40조 (청구 방법)\n법 제38조에 따라 청구한다.";
    const additional = "\n▶ 위임 대조 추가 조회\n[시행령] 개인정보 보호법 시행령 제41조 (청구 기준)\n법 제38조에 따른 기준이다.\n[시행령] 개인정보 보호법 시행령 제42조 (다른 조항)\n법 제39조에 따른 기준이다.\n[시행령] 개인정보 보호법 시행령 제41조 (청구 기준)\n법 제38조에 따른 기준이다.";
    const lawSystem = assessLawSystem(initial + additional, "개인정보 보호법 제38조 위임관계");
    expect(lawSystem.items.find((item) => item.label === "시행령")?.articles).toHaveLength(3);
    const html = render({ ...base, task, text: initial, lawSystem });
    // Top: the core answer — provisions directly linked to the asked article,
    // named once, never counted; every relation stays accessible below.
    const top = html.slice(0, html.indexOf('aria-label="법령 단계별 관계"'));
    expect(top).toContain("직접 연결: 제40조(청구 방법) · 제41조(청구 기준)");
    expect(top).not.toContain("제42조");
    expect(html).toContain("위임관계 확인 필요");
    const lower = html.slice(html.indexOf('aria-label="법령 단계별 관계"'));
    for (const jo of ["제40조", "제41조", "제42조"]) expect(lower).toContain(jo);
    // A provision citing another article stays in the folded extra list, apart from the direct links.
    expect(lower.indexOf("추가 조회 조문 보기 · 1건")).toBeLessThan(lower.indexOf("법 제39조에 따른"));
    expect(lower).toContain("법 제39조에 따른");
    expect(html).not.toContain("법령 체계상의 위치");
    if (task === "full_research") {
      expect(html).toContain("최종 검증 근거 중 응답 목록에 없던 조문 2건을 보완했습니다.");
      expect(html.match(/추가 조회<\/span>/gu)).toHaveLength(2);
    } else {
      // 법체계 확인: the tier section is the single home; the raw 3단 비교 listing is not repeated.
      expect(html).not.toContain('class="research-hierarchy"');
    }
  });

  it("appends missing system provisions without deleting or counting original duplicate, foreign or unparsed rows", () => {
    const rows = [
      { level: "시행령", content: "개인정보 보호법 시행령 제40조 (청구)" },
      { level: "시행령", content: "개인정보 보호법 시행령 제40조 (청구)" },
      { level: "시행령", content: "다른법 시행령 제41조 (다른 법령)" },
      { level: "시행령", content: "식별할 수 없는 응답" },
    ];
    const evidence: NonNullable<LawResearchData["lawSystem"]> = { status: "partial", items: [{ label: "시행령", status: "found", articles: [
      { law: "개인정보 보호법 시행령", jo: "제40조", title: "청구", relation: "direct" },
      { law: "개인정보 보호법 시행령", jo: "제41조", title: "기준", relation: "related" },
    ] }] };
    const before = structuredClone({ rows, evidence });
    const result = appendMissingLawSystemArticles(rows, evidence);
    expect(result.slice(0, rows.length)).toEqual(rows);
    expect(result).toHaveLength(5);
    expect(result[4]).toMatchObject({ content: "개인정보 보호법 시행령 제41조 (기준)", appended: true });
    expect(appendMissingLawSystemArticles(result, evidence)).toEqual(result);
    expect({ rows, evidence }).toEqual(before);
  });

  it("keeps core identities visible and repeats only the reference between issues", () => {
    const html = render({ ...base, evidence: { status: "matched", articles: [reference], precedents: [], issues: [
      { label: "해고 기준", status: "found", articles: [reference], precedents: [] },
      { label: "해고 적용", status: "found", articles: [reference], precedents: [] },
    ] }, enrichment: { supplement: { status: "found", articles: [article] } } });
    expect(html.match(/aria-label="핵심 법적 근거"/gu)).toHaveLength(2);
    expect(html.match(/id="research-article-1"/gu)).toHaveLength(1);
    expect(html).toContain("공통 근거 원문 보기");
    expect(html).toContain("상세 근거에서 원문 보기");
    expect(html.match(/② 마지막 항도 보존한다。/gu)).toBeNull();
    // One adopted source and the intentionally retained complete response.
    expect(html.match(/② 마지막 항도 보존한다\./gu)).toHaveLength(2);
    expect(html).toContain('data-status="matched"');
    expect(html).not.toMatch(/class="law-detail-source research-issue-refs"[^>]*\bopen=/u);
  });

  it("retains a different law, effective version or excerpt in additional sources", () => {
    const html = render({ ...base, task: "action_basis", actionBasis: { status: "viewed", items: [] },
      enrichment: { supplement: { status: "found", articles: [
        article, { ...article, effectiveDate: "2026.01.01" }, { ...article, law: "다른 법률" },
        { ...article, excerpt: "별도 발췌" }, { ...article, jo: "제24조", explicit: true, matched: [] },
      ] } } });
    expect(html.match(/class="research-group research-task-sources"/gu)).toHaveLength(1);
    expect(html).toContain("2026.01.01");
    expect(html).toContain("다른 법률 제23조");
    expect(html).toContain("별도 발췌");
    expect(html.match(/법제처 원문 보기/gu)).toHaveLength(5);
    expect(html).toContain('data-status="viewed"');
  });

  it("does not suppress another primary version when the adopted source has the same law and article", () => {
    const html = render({ ...base, evidence: { status: "matched", articles: [reference], precedents: [], issues: [] },
      enrichment: { supplement: { status: "found", articles: [{ ...article, effectiveDate: "2026.01.01" }] } } });
    expect(html).toContain('id="research-article-1"');
    expect(html).toContain('id="research-source-0-0"');
    expect(html).toContain("2025.01.01");
    expect(html).toContain("2026.01.01");
  });

  it("keeps delegation wording and detail only in the lower verification area", () => {
    const expression = "대통령령으로 정하는 고유한 위임 문언";
    const html = render({ ...base, task: "law_system", lawSystem: { status: "partial", items: [
      { label: "시행령", status: "found", detail: "고유 검증 설명", articles: [
        { law: "근로기준법 시행령", jo: "제7조", title: "적용범위", relation: "direct", expression },
      ] }, { label: "시행규칙", status: "none", detail: "미확보" },
    ] } });
    const lower = html.indexOf('aria-label="법령 단계별 관계"');
    expect(lower).toBeGreaterThan(0);
    expect(html.slice(0, lower)).not.toContain(expression);
    expect(html.slice(0, lower)).not.toContain("고유 검증 설명");
    expect(html.slice(lower)).toContain(expression);
    expect(html.slice(lower)).not.toContain("고유 검증 설명");
    expect(html).not.toContain("상세 근거 ·");
    expect(html.slice(0, lower)).toContain("직접 연결: 제7조(적용범위)");
    const delegationTop = html.slice(0, lower);
    expect(delegationTop).not.toContain("고유 조문");
    // The top summary keeps relation phrases only (no provision count) and
    // no longer repeats the article list or its jump button; the detail
    // section below is the single home for the provision and its delegation wording.
    expect(html).not.toContain('aria-controls="research-task-evidence-');
  });

  it("moves step excerpts into the summary steps and drops the repeated procedure-evidence section", () => {
    const html = render({ ...base, task: "procedure_detail", procedure: {
      overall: "partial", incomplete: false, annexTruncated: false, annexOriginStage: "list-only", failedSections: 0,
      requirements: [{ kind: "procedure", label: "청구 절차", status: "found", articles: [{ law: article.law, jo: article.jo, title: article.title }], annexCount: 0, annexOriginStage: "list-only", annexRelatedCandidates: [] }],
      steps: [{ phase: "filing", label: "청구", articles: [{ law: article.law, jo: article.jo, title: article.title, excerpt: "고유 단계 발췌 원문" }], missing: false }],
    } });
    expect(html).not.toContain('aria-label="절차 항목별 근거"');
    expect(html).not.toContain('data-procedure-requirements');
    expect(html).not.toContain('aria-controls="research-procedure-step-');
    expect(html).not.toContain('aria-controls="research-procedure-requirement-');
    const steps = html.slice(html.indexOf('data-procedure-steps="true"'));
    expect(steps).toContain("고유 단계 발췌 원문");
    expect(steps).toContain("상세 근거에서 원문 보기");
    // The requirement article itself stays reachable in the group sections.
    expect(html).toContain("해고 등의 제한");
  });

  it("hides top issue buttons without a matching result and maps reordered labels exactly", () => {
    const html = render({ ...base, interpretation: { original: "해고", situation: "", facts: [], confidence: "high", issues: [
      { label: "표시 대상 없음", query: "없음" }, { label: "두 번째", query: "해고" }, { label: "첫 번째", query: "해고" },
    ] }, evidence: { status: "matched", articles: [reference], precedents: [], issues: [
      { label: "첫 번째", status: "found", articles: [reference], precedents: [] },
      { label: "두 번째", status: "found", articles: [reference], precedents: [] },
    ] } });
    expect(html).not.toContain('aria-controls="research-issue-3"');
    expect(html).toMatch(/aria-controls="research-issue-2"[^>]*>.*?두 번째/u);
    expect(html).toMatch(/aria-controls="research-issue-1"[^>]*>.*?첫 번째/u);
  });

  for (const task of ["full_research", "law_system", "action_basis", "dispute_prep", "amendment_track", "ordinance_compare", "procedure_detail"] as const) {
    it(`keeps supplemental source and collapsed raw response in ${task}`, () => {
      const html = render({ ...base, task, enrichment: { supplement: { status: "found", articles: [article] } } });
      expect(html).toContain("근로기준법 제23조");
      expect(html).not.toMatch(/class="law-detail-source research-source"[^>]*\bopen=/u);
      if (task === "law_system" || task === "action_basis") {
        expect(html).toContain('class="research-group research-task-sources"');
        expect(html).not.toContain('aria-label="추가 조회 자료"');
      } else expect(html).toContain('aria-label="추가 조회 자료"');
    });
  }

  it("shows verified annex text folded and keeps partial and missing annexes out of the verified block", () => {
    const html = render({ ...base, annexes: [
      { law: "식품위생법 시행규칙", label: "별표 23", sourceArticle: "제75조", citation: "별표 23", status: "verified" as const,
        title: "행정처분의 기준", text: "Ⅰ. 일반기준\n<table><tr><td>구분</td><td>위반행위</td></tr><tr><td>1차</td><td>경고</td></tr></table>",
        url: "https://example.test/annex23" },
      { law: "식품위생법 시행령", label: "별표 1", sourceArticle: "제53조", citation: "별표 1", status: "identified" as const,
        title: "과징금 산정", url: "https://example.test/annex1" },
      { law: "식품위생법 시행령", label: "별표 2", sourceArticle: "제53조", citation: "별표 2", status: "failed" as const },
    ] });
    expect(html).toContain("확인한 별표·서식 원문");
    expect(html).toContain("별표 원문 보기");
    // The table keeps its rows and columns as a real table, cell by cell.
    expect(html).toContain('<table class="research-annex-table"><tbody><tr><td>구분</td><td>위반행위</td></tr><tr><td>1차</td><td>경고</td></tr></tbody></table>');
    expect(html).not.toContain("구분 ｜ 위반행위");
    const verifiedBlock = html.indexOf("확인한 별표·서식 원문");
    const partialBlock = html.indexOf("원문 일부만 확인된 별표·서식");
    const missingBlock = html.indexOf("원문 미확보 별표·서식");
    expect(partialBlock).toBeGreaterThan(verifiedBlock);
    expect(missingBlock).toBeGreaterThan(partialBlock);
    expect(html.slice(partialBlock)).toContain("식품위생법 시행령 별표 1");
    expect(html.slice(missingBlock)).toContain("식품위생법 시행령 별표 2");
    expect(html).toContain("원문 전체가 확인되지 않았습니다");
    expect(html).toContain("원문을 확보하지 못했습니다");
  });

  it("collapses duplicate tier rows and drops the stale top-count reference", () => {
    const text = "═══ 법체계 확인: 개인정보 보호법 ═══\n▶ 3단 비교 (법률·시행령·시행규칙)\n[시행령] 개인정보 보호법 시행령 제40조 (청구 방법)\n[시행령] 개인정보 보호법 시행령 제40조 (청구 방법)\n";
    const lawSystem = { status: "partial" as const, items: [
      { label: "시행령", status: "found" as const, articles: [
        { law: "개인정보 보호법 시행령", jo: "제40조", title: "청구 방법", relation: "direct" as const },
      ] },
    ] };
    const html = render({ ...base, task: "full_research", text, lawSystem });
    expect(html).toContain("중복된 응답 행 1건을 하나로 합쳤습니다.");
    expect(html).not.toContain("상단 고유 조문 수");
    // 법체계 확인 shows the provision once in its tier section, not again in a raw listing.
    const own = render({ ...base, task: "law_system", text, lawSystem });
    expect(own).not.toContain("중복된 응답 행");
    expect(own.match(/제40조/gu)?.length).toBeGreaterThan(0);
  });

  it("lists a source linked to an assessed item once while retaining the unassessed supplement", () => {
    const html = render({ ...base, task: "action_basis", actionBasis: { status: "matched", items: [
      { label: "처분·허가 근거", status: "found", basisRefs: [{ law: article.law, jo: article.jo, title: article.title, excerpt: "① 해고의 기준을 확인한다." }] },
      { label: "적용 요건", status: "found", requirementRefs: [] },
    ] }, enrichment: { supplement: { status: "found", articles: [
      article, { ...article, jo: "제24조" },
    ] } } });
    const sources = html.slice(html.indexOf('aria-label="상세 근거"'), html.indexOf('class="law-detail-source research-source"'));
    expect(sources.match(/근로기준법 제23조/gu)).toHaveLength(1);
    expect(sources).toContain("근로기준법 제24조");
    expect(sources).toContain("관련 검토 항목: 처분·허가 근거");
  });

  it("preserves an ellipsis-cut excerpt as unconfirmed source text", () => {
    const html = render({ ...base, task: "action_basis", actionBasis: { status: "viewed", items: [
      { label: "처분·허가 근거", status: "viewed", basisRefs: [{ law: article.law, jo: article.jo, title: article.title, excerpt: "① 일부 발췌 …" }] },
    ] } });
    const lower = html.slice(html.indexOf('aria-label="상세 근거"'));
    expect(lower).toContain("① 일부 발췌 …");
    expect(lower).toContain("자료 조회");
    expect(lower).not.toContain("원문 확보");
  });
});
