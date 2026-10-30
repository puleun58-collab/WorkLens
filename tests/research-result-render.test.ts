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
    expect(lower).toContain("이 항목의 직접 근거 문언을 확인하지 못했습니다.");
    expect(lower).toContain("요건 충족 여부는 판단하지 않았습니다.");
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
    expect(html.match(/data-slot="alert-title"/gu)).toHaveLength(2);
    expect(html).toMatch(/research-summary-notice[^>]*data-tone="error"[^>]*>.*?추가 자료 조회 미완료/u);
  });

  it.each(["law_system", "full_research"] as const)("keeps the final law-system count and every relation accessible in %s", (task) => {
    const initial = "═══ 법체계 확인: 개인정보 보호법 ═══\n▶ 3단 비교 (법률·시행령·시행규칙)\n[시행령] 개인정보 보호법 시행령 제40조 (청구 방법)\n법 제38조에 따라 청구한다.";
    const additional = "\n▶ 위임 대조 추가 조회\n[시행령] 개인정보 보호법 시행령 제41조 (청구 기준)\n법 제38조에 따른 기준이다.\n[시행령] 개인정보 보호법 시행령 제42조 (다른 조항)\n법 제39조에 따른 기준이다.\n[시행령] 개인정보 보호법 시행령 제41조 (청구 기준)\n법 제38조에 따른 기준이다.";
    const lawSystem = assessLawSystem(initial + additional, "개인정보 보호법 제38조 위임관계");
    expect(lawSystem.items.find((item) => item.label === "시행령")?.articles).toHaveLength(3);
    const html = render({ ...base, task, text: initial, lawSystem });
    expect(html).toContain("고유 조문 3건 · 직접 위임 확인됨 · 추가 확인 필요");
    expect(html).toContain("위임관계 확인 필요");
    expect(html).toContain("최종 검증 근거 중 응답 목록에 없던 조문 2건을 보완했습니다.");
    expect(html.match(/추가 조회<\/span>/gu)).toHaveLength(2);
    const lower = html.slice(html.indexOf('aria-label="항목별 법적 근거"'));
    for (const jo of ["제40조", "제41조", "제42조"]) expect(lower).toContain(jo);
    expect(lower).toContain("법 제39조에 따른");
    expect(html).toContain("중복·다른 법령·미식별 행 포함");
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
    expect(html.match(/상세 근거에서 원문 보기/gu)).toHaveLength(1);
    expect(html).toContain("2026.01.01");
    expect(html).toContain("다른 법률 제23조");
    expect(html).toContain("별도 발췌");
    // Additional-source excerpts fold by default: the title stays visible, the excerpt opens on demand.
    expect(html).toContain("조문 발췌 보기");
    expect(html).not.toMatch(/class="law-detail-source research-more"[^>]*\bopen=/u);
    expect(html).toContain("제목에 질문 용어가 포함된 조문");
    expect(html).toContain('class="research-meta">4건');
    expect(html).toContain("추가로 조회한 조문");
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
    const lower = html.indexOf('aria-label="항목별 법적 근거"');
    expect(lower).toBeGreaterThan(0);
    expect(html.slice(0, lower)).not.toContain(expression);
    expect(html.slice(0, lower)).not.toContain("고유 검증 설명");
    expect(html.slice(lower)).toContain(expression);
    expect(html.slice(lower)).toContain("고유 검증 설명");
    expect(html).not.toContain("상세 근거 ·");
    expect(html).toContain("고유 조문 1건 · 직접 위임 확인됨");
    // The top summary keeps the count line but no longer repeats the
    // article list or its jump button; the detail section below is the
    // single home for the provision and its delegation wording.
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
    it(`uses the same additional-source wording and collapsed raw source in ${task}`, () => {
      const html = render({ ...base, task, enrichment: { supplement: { status: "found", articles: [article] } } });
      expect(html).toContain("제목에 질문 용어가 포함된 조문");
      expect(html).toContain("조문 제목에 질문 용어가 포함된 자료를 추가로 조회했습니다.");
      expect(html).not.toContain("질문 용어가 제목에 있는 조문");
      expect(html).not.toMatch(/class="law-detail-source research-source"[^>]*\bopen=/u);
      expect(html.indexOf('class="law-detail-source research-source"')).toBeLessThan(html.indexOf('aria-label="추가 조회 자료"'));
    });
  }
});
