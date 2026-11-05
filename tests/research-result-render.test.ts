import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { appendMissingLawSystemArticles, ResearchResult } from "../src/components/research/LegalResearch";
import { assessLawSystem } from "../src/lib/law-system-evidence";
import { assessActionBasis } from "../src/lib/action-basis-evidence";
import type { LawResearchData, LawResearchRequest } from "../src/lib/law-research";
import food from "./fixtures/law-action-basis-food-suspension.json";
import privacy from "./fixtures/law-system-privacy-38.json";
import foodAnnex from "./fixtures/law-annex-food-23.json";

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

it("shows source-grounded direct answers above one detailed original per provision", () => {
  const actionBasis = assessActionBasis(food.query, food.text, food.enrichment as Parameters<typeof assessActionBasis>[2], []);
  const html = render({ found: true, task: "action_basis", text: food.text, markers: [], actionBasis });
  const summary = html.slice(0, html.indexOf('aria-label="상세 근거"'));
  expect(summary).toContain("식품위생법 제75조");
  expect(summary).toContain("6개월 이내");
  expect(summary).toContain("개별 적용 미확정");
  expect(summary).not.toContain("처분 권한과 법정 사유의 근거 문언을 확인했습니다");
  expect(html).not.toContain("상세 검증 내용 보기");
});

it("distinguishes the two directly delegated articles from citations in the summary", () => {
  const lawSystem = assessLawSystem(privacy.text, privacy.query);
  const html = render({ found: true, task: "law_system", text: privacy.text, markers: [], lawSystem });
  const summary = html.slice(0, html.indexOf('aria-label="상세 근거"'));
  expect(summary).toContain("제38조 제1항 → 시행령 제45조");
  expect(summary).toContain("대리인의 범위와 위임장 제출에 관한 사항");
  expect(summary).toContain("제38조 제3항 → 시행령 제47조");
  expect(summary).toContain("수수료·우송료에 관한 사항");
  expect(summary).not.toContain("→ 시행령 제42조의8");
  expect(summary).toMatch(/관련 규정: 시행령 제42조의5·제42조의8/u);
  expect(summary).not.toContain("법 제38조");
  const relations = [...summary.matchAll(/class="research-law-system-relation">([\s\S]*?)<\/span><\/span>/gu)].map((match) => match[1]);
  expect(relations.some((group) => group.includes("시행령 제45조") && group.includes("대리인의 범위와 위임장 제출"))).toBe(true);
  expect(relations.some((group) => group.includes("시행령 제47조") && group.includes("수수료·우송료"))).toBe(true);
});

it("keeps the overview short and folds supporting sources and originals once", () => {
  const actionBasis = assessActionBasis(food.query, food.text, food.enrichment as Parameters<typeof assessActionBasis>[2], []);
  const html = render({ found: true, task: "action_basis", text: food.text, markers: [], actionBasis });
  const top = html.slice(0, html.indexOf('aria-label="상세 근거"'));
  const lower = html.slice(html.indexOf('aria-label="상세 근거"'), html.indexOf('class="law-detail-source research-source"'));
  expect(top).toContain("제75조 제1항 각 호");
  expect(top).not.toContain("해당 위반 항목:");
  expect(top).not.toContain("제82조");
  expect(lower).toContain('class="law-detail-source research-more research-supporting-sources"');
  expect(lower).toContain("제75조");
  expect(lower).toContain("제82조");
  expect(lower).toContain("조문 원문 보기");
  expect(lower).toContain("법제처 원문 보기");
  expect(lower).not.toContain("관련 검토 항목:");
  expect(lower).not.toContain("확인 문언:");
  expect(lower).not.toContain("공식 출처 ·");
});

  it("keeps an unresolved optional criteria item in the overview without changing the core verdict", () => {
    const html = render({ ...base, task: "action_basis", actionBasis: { status: "matched", items: [
      { label: "처분·허가 근거", title: "처분 근거", status: "found" },
      { label: "적용 요건", status: "found" },
      { label: "세부 기준(별표)", title: "세부 처분 기준", optional: true, status: "none",
        summary: "관련 기준의 원문 확인 필요", uncertainty: "별표 원문 미확보" },
    ] } });
    const criteriaStart = html.indexOf("03</span>");
    const criteria = html.slice(criteriaStart, html.indexOf("</li>", criteriaStart));
    expect(criteria).toContain("세부 처분 기준");
    expect(criteria).toContain('data-status="none"');
    expect(criteria).not.toContain("(참고)");
    expect(criteria).toContain("관련 기준의 원문 확인 필요");
    expect(html).toMatch(/research-summary-status[^>]*data-tone="success"/u);
  });

  it("folds plain statute fallback bodies but leaves explanatory or missing-source prose outside original controls", () => {
    const body = "① 위반행위를 한 자에게 벌칙을 적용한다.";
    const html = render({ ...base, task: "action_basis", text: `═══ 처분 근거 ═══\n▶ 벌칙·과태료 조항\n제93조(벌칙)\n${body}\n▶ 검토 설명\n사실관계가 없어 적용 여부를 확정하지 않습니다.\n▶ 법령 원문 확인 상태\n원문을 확인하지 못했습니다.` });
    const statute = html.slice(html.indexOf('data-kind="other"><h3>벌칙'), html.indexOf("검토 설명"));
    expect(statute).toContain("research-original-body");
    expect(statute).toContain(body);
    expect(statute).not.toMatch(/<details[^>]*\bopen=/u);
    expect(statute.match(/<details\b/gu)).toHaveLength(1);
    expect(html).toContain('검토 설명</h3><pre');
    expect(html).toContain('법령 원문 확인 상태</h3><pre');
  });
describe("research result source structure", () => {
  it("links independent action checks to retrieved originals and keeps missing requirements accessible", () => {
    const actionText = "═══ 처분 근거 확인: 식품위생법 ═══\n▶ 법령 체계\n[법률] 식품위생법 제75조 (영업정지)\n영업정지 처분을 할 수 있다.";
    const actionBasis = assessActionBasis("식품위생법 영업정지 근거와 요건", actionText);
    const html = render({ ...base, task: "action_basis", text: actionText, actionBasis });
    expect(html).toContain('data-status="partial"');
    expect(html).toMatch(/research-summary-status[^>]*data-tone="warning"[^>]*>.*?적용 요건 확인 필요/u);
    expect(html).toContain("적용 요건 추가 확인 필요");
    // The answer remains visible above the single detailed source list.
    expect(html).not.toContain('aria-controls="research-task-evidence-');
    const lower = html.slice(html.indexOf('aria-label="상세 근거"'));
    expect(lower).toContain("영업정지 처분을 할 수 있다.");
    expect(lower).toContain("법제처 원문 보기");
    expect(html).toContain("위반행위와 영업 종류가 특정되지 않으면");
    expect(lower).toContain("직접 관련 근거");
  });

  it("separates an identified disposition table from confirmed law and conditions", () => {
    const body = "① 영업자는 위반행위가 있는 경우 영업정지 처분을 받을 수 있다.";
    const source = { law: "식품위생법", jo: "제75조", title: "허가취소 등", excerpt: body };
    const html = render({ ...base, task: "action_basis", actionBasis: { status: "matched", items: [
      { label: "처분·허가 근거", title: "처분 근거", status: "found", basisRefs: [source] },
      { label: "적용 요건", status: "found", requirementRefs: [source] },
      { label: "세부 기준(별표)", title: "세부 처분 기준", optional: true, status: "viewed", uncertainty: "별표 원문 미확보" },
    ] }, annexes: [{ law: "식품위생법 시행규칙", label: "별표 23", sourceArticle: "제89조",
      citation: "법 제75조의 행정처분 기준은 별표 23과 같다.", status: "identified", relevance: "direct",
      url: "https://www.law.go.kr/법령별표서식/(식품위생법시행규칙,별표23)" }] });
    const sources = html.slice(html.indexOf('aria-label="상세 근거"'));
    const top = html.slice(0, html.indexOf('aria-label="상세 근거"'));
    expect(top).not.toContain("식품위생법 시행규칙 별표 23");
    expect(top).toContain("별표 원문 미확보");
    expect(sources.match(/식품위생법 제75조/gu)).toHaveLength(1);
    expect(sources).toContain("처분 근거 · 적용 요건");
    expect(sources).toContain("별표 23");
    expect(sources).toContain("원문 일부 확인");
    expect(html).toContain("세부 처분 기준");
    expect(html).toContain("별표 원문 미확보");
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
    expect(html).toContain("처분·허가 근거");
    expect(html).toContain("적용 요건");
    expect(html).toContain("필수 항목 추가 확인 필요");
    expect(html).not.toContain("확인된 사실: 조회 원문에");
  });

  it.each([false, true])("preserves a complete badge with reference-only gaps (lookup failure: %s)", (failed) => {
    const html = render({ ...base, task: "action_basis", actionBasis: { status: "matched", items: [
      { label: "처분·허가 근거", status: "found", basisRefs: [] },
    ] }, followup: { status: failed ? "failed" : "partial", attempted: 2, failed: failed ? 2 : 0, missing: 1, limited: true } });
    expect(html).toMatch(/research-summary-status[^>]*data-tone="success"[^>]*>.*?관련 근거 확인/u);
    expect(html).toContain(failed ? "추가 참고 자료 조회 미완료" : "추가 참고 자료 미확인");
    expect(html).not.toContain("일부 참고 자료 미확보");
    expect(html).not.toContain("시간·조회 한도");
    expect(html).not.toContain('class="legal-analysis-title" data-status="partial"');
    if (failed) expect(html).toContain("조회 실패 2건");
  });

  it("ranks three decision domains by verified body while folding missing and unrelated judgments", () => {
    const decisionText = `═══ 쟁송 대비 ═══
▶ 관련 판례
판례 검색 결과 (총 3건, 1페이지):
[100] 다른 사건
  사건번호: 2020다123
[101] 영업정지 기준
  사건번호: 2021두456
[102] 같은 사건
  사건번호: 2021두456
▶ 법령 해석례
해석례 검색 결과 (총 1건, 1페이지):
[201] 영업정지 해석례
  해석례번호: 21-0001
▶ 행정심판례
행정심판례 검색 결과 (총 1건, 1페이지):
[301] 영업정지 재결
  재결번호: 2021-01`;
    const html = render({ ...base, task: "dispute_prep", text: decisionText, enrichment: {
      decisions: {
        "precedent:100": { rank: "low", matched: [] }, "precedent:101": { rank: "direct", matched: ["영업정지"] },
        "precedent:102": { rank: "related", matched: ["영업정지"] }, "interpretation:201": { rank: "unknown", matched: [] },
        "tribunal:301": { rank: "related", matched: ["영업정지"] },
      },
    } });
    expect(html).toContain("직접 관련 자료");
    expect(html).toContain("동일 사건 조회 ID: 102");
    expect(html).toContain("추가 조회 판례");
    expect(html).toContain("추가 조회 해석례");
    expect(html).toContain("보충 행정심판례");
    expect(html).not.toContain("판시사항을 기준으로 관련성이 높은 판례부터 표시");
  });

  it("names the unresolved provision and failure reason, but never downgrades a missing core requirement to a reference gap", () => {
    const unavailable = [{ type: "조문" as const, name: "식품위생법 시행규칙 제89조", reason: "failed" as const }];
    const complete = render({ ...base, task: "action_basis", actionBasis: { status: "matched", items: [
      { label: "처분·허가 근거", status: "found" },
    ] }, followup: { status: "partial", attempted: 2, failed: 1, missing: 1, limited: false, unavailable } });
    expect(complete).toContain("추가 참고 자료 조회 미완료");
    expect(complete).not.toContain("일부 참고 자료 미확보");
    expect(complete).toContain("식품위생법 시행규칙 제89조 조문 조회 실패");
    const incomplete = render({ ...base, task: "action_basis", actionBasis: { status: "partial", items: [
      { label: "처분·허가 근거", status: "found" }, { label: "적용 요건", status: "viewed" },
    ] }, followup: { status: "partial", attempted: 2, failed: 1, missing: 1, limited: false, unavailable } });
    expect(incomplete).not.toContain("일부 참고 자료 미확보");
    expect(incomplete).toContain("식품위생법 시행규칙 제89조 조문 조회 실패");
    const noMissing = render({ ...base, task: "action_basis", actionBasis: { status: "matched", items: [
      { label: "처분·허가 근거", status: "found" },
    ] }, followup: { status: "complete", attempted: 2, failed: 0, missing: 0, limited: false } });
    expect(noMissing).not.toContain("일부 참고 자료 미확보");
  });

  it.each(["not-found", "mismatch", "incomplete"] as const)("reports an actually attempted unavailable original (%s) without exposing audit limits", (reason) => {
    const html = render({ ...base, task: "action_basis", actionBasis: { status: "matched", items: [
      { label: "처분·허가 근거", status: "found" },
    ] }, followup: { status: "partial", attempted: 1, failed: 0, missing: 1, limited: true, unavailable: [
      { type: "조문", name: "식품위생법 시행규칙 제89조", reason },
      { type: "조문", name: "미조회 후보", reason: "limited" },
    ] } });
    expect(html).toContain("일부 참고 자료 미확보");
    expect(html).toContain("핵심 근거는 확인했으며, 보충 자료 일부를 확보하지 못했습니다.");
    expect(html).toContain("식품위생법 시행규칙 제89조");
    expect(html).not.toContain("미조회 후보");
    expect(html).not.toContain("조회 한도");
  });

  it("keeps legacy unattempted and unspecified gaps distinct from unavailable originals", () => {
    for (const unavailable of [undefined, [{ type: "조문" as const, name: "미조회 후보", reason: "limited" as const }]]) {
      const html = render({ ...base, task: "action_basis", actionBasis: { status: "matched", items: [
        { label: "처분·허가 근거", status: "found" },
      ] }, followup: { status: "partial", attempted: 0, failed: 0, missing: 3, limited: true, unavailable } });
      expect(html).toContain("추가 참고 자료는 확인되지 않았습니다.");
      expect(html).not.toContain("미확보");
      expect(html).not.toContain("미조회 후보");
      expect(html).not.toContain("세부 대상 미기록");
    }
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
    expect(html).toContain("추가 자료 조회도 완료되지 않았습니다.");
    expect(html).not.toContain("추가 자료 조회 미완료");
  });

  it.each(["law_system", "full_research"] as const)("keeps the final law-system relations accessible in %s", (task) => {
    const initial = "═══ 법체계 확인: 개인정보 보호법 ═══\n▶ 3단 비교 (법률·시행령·시행규칙)\n[시행령] 개인정보 보호법 시행령 제40조 (청구 방법)\n법 제38조에 따라 청구한다.";
    const additional = "\n▶ 위임 대조 추가 조회\n[시행령] 개인정보 보호법 시행령 제41조 (청구 기준)\n법 제38조에 따른 기준이다.\n[시행령] 개인정보 보호법 시행령 제42조 (다른 조항)\n법 제39조에 따른 기준이다.\n[시행령] 개인정보 보호법 시행령 제41조 (청구 기준)\n법 제38조에 따른 기준이다.";
    const lawSystem = assessLawSystem(initial + additional, "개인정보 보호법 제38조 위임관계");
    expect(lawSystem.items.find((item) => item.label === "시행령")?.articles).toHaveLength(3);
    const html = render({ ...base, task, text: initial, lawSystem });
    // Retrieval and citation are visible, but no parent delegation was
    // supplied by this fixture: the screen must not claim a direct link.
    const lowerStart = html.indexOf(task === "law_system" ? 'aria-label="상세 근거"' : 'aria-label="항목별 법적 근거"');
    const top = html.slice(0, lowerStart);
    expect(top).toContain("직접 위임관계 미확인");
    expect(top).toContain("관련 규정: 시행령 제40조·제41조");
    expect(top).not.toContain("제42조");
    expect(html).toContain("위임관계 확인 필요");
    const lower = html.slice(lowerStart);
    for (const jo of ["제40조", "제41조", "제42조"]) expect(lower).toContain(jo);
    expect(lower).toContain("법 제39조에 따른");
    expect(html).not.toContain("법령 체계상의 위치");
    if (task === "full_research") {
      const hierarchy = html.slice(html.indexOf('class="research-hierarchy"'), html.indexOf("</dl>", html.indexOf('class="research-hierarchy"')));
      expect(hierarchy.match(/<dt>/gu)).toHaveLength(3);
      expect(hierarchy.match(/data-appended="true"/gu)).toHaveLength(2);
      for (const jo of ["제40조", "제41조", "제42조"]) expect(hierarchy).toContain(jo);
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

  it("keeps each issue's shared source original inside its own disclosure without individual navigation", () => {
    const html = render({ ...base, evidence: { status: "matched", articles: [reference], precedents: [], issues: [
      { label: "해고 기준", status: "found", articles: [reference], precedents: [] },
      { label: "해고 적용", status: "found", articles: [reference], precedents: [] },
    ] }, enrichment: { supplement: { status: "found", articles: [article] } } });
    expect(html.match(/aria-label="핵심 법적 근거"/gu)).toHaveLength(2);
    expect(html.match(/id="research-article-1"/gu)).toHaveLength(1);
    expect(html.match(/id="research-article-1-issue-2"/gu)).toHaveLength(1);
    const issues = [...html.matchAll(/class="legal-analysis-section research-issue-evidence"[\s\S]*?<\/section>/gu)].map((match) => match[0]);
    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      const core = issue.slice(issue.indexOf('aria-label="핵심 법적 근거"'), issue.indexOf("<details"));
      expect(core).not.toMatch(/<(?:button|a)\b/u);
      const detail = issue.slice(issue.indexOf("<details"));
      expect(detail).toContain(excerpt.split("\n")[1]);
      expect(detail).toContain('href="https://www.law.go.kr/');
      expect(detail).not.toContain("research-source-jump");
      expect(detail.match(/class="research-source-target"/gu)).toHaveLength(1);
    }
    expect(html).toContain('data-status="matched"');
    expect(html).not.toMatch(/class="law-detail-source research-issue-refs"[^>]*\bopen=/u);
  });

  it("counts duplicate source IDs once and preserves distinct rulings, metadata and issue attribution", () => {
    const entry = { title: "해고 기준 판결", caseNumber: "2025다71", body: "대법원", date: "2025.01.02" };
    const html = render({ ...base, text: "", evidence: { status: "matched", articles: [], precedents: ["71", "72", "73"],
      precedentEntries: { "71": entry, "72": { ...entry }, "73": { ...entry, date: "2026.01.02" } },
      precedentExcerpts: { "71": "공통 판결 원문", "72": "공통 판결 원문", "73": "별도 판결 원문" },
      issues: [
        { label: "해고 기준", status: "found", articles: [], precedents: ["71", "71", "72", "73"] },
        { label: "해고 적용", status: "found", articles: [], precedents: ["72"] },
        { label: "미확인", status: "none", articles: [], precedents: [] },
      ],
    } });
    const issues = [...html.matchAll(/class="legal-analysis-section research-issue-evidence"[\s\S]*?<\/section>/gu)].map((match) => match[0]);
    const detail = (issue: string) => issue.slice(issue.indexOf("<details"));
    expect(detail(issues[0]).match(/<li>/gu)).toHaveLength(2);
    expect(detail(issues[1]).match(/<li>/gu)).toHaveLength(1);
    expect(detail(issues[0])).toContain("별도 판결 원문");
    expect(detail(issues[1])).not.toContain("별도 판결 원문");
    expect(detail(issues[1])).toContain("공통 판결 원문");
    expect(detail(issues[1])).toContain("2025다71");
    expect(detail(issues[1])).toContain("2025.01.02");
    expect(detail(issues[1])).toContain("대법원");
    expect(detail(issues[1])).toContain("precSeq=72");
    expect(issues[2]).not.toContain("<details");
  });

  it("merges same-version excerpt ranges without merging unknown or different versions", () => {
    const html = render({ ...base, evidence: { status: "matched", articles: [reference], precedents: [],
      issues: [{ status: "found", articles: [reference], precedents: [] }] },
      enrichment: { supplement: { status: "found", articles: [
        { ...article, excerpt: "동일 시행일의 다른 항 원문" },
        { ...article, excerpt: "시행일 미상 원문", effectiveDate: undefined },
        { ...article, excerpt: "다른 시행일 원문", effectiveDate: "2026.01.01" },
      ] } } });
    const start = html.indexOf('class="legal-analysis-section research-issue-evidence"');
    const issue = html.slice(start, html.indexOf("</section>", start));
    const detail = issue.slice(issue.indexOf("<details"));
    expect(detail.match(/class="research-source-target"/gu)).toHaveLength(3);
    for (const body of [excerpt.split("\n")[1], "동일 시행일의 다른 항 원문", "시행일 미상 원문", "다른 시행일 원문"]) expect(detail).toContain(body);
    expect(html).not.toContain("research-source-jump");
  });

  it.each([
    ["법령 해석례", "해석례", "expcInfoP.do?expcSeq=101"],
    ["행정심판례", "행정심판례", "deccInfoP.do?deccSeq=101"],
  ])("does not confuse an adopted precedent with a %s sharing its numeric ID", (heading, kind, source) => {
    const html = render({ ...base, text: `═══ 조회 결과 ═══\n▶ 관련 판례\n판례 검색 결과 (총 1건, 1페이지):\n[101] 채택 판례 제목\n  사건번호: 2025다101\n  선고일: 2025.01.02\n▶ ${heading}\n${kind} 검색 결과 (총 1건, 1페이지):\n[101] 다른 도메인 제목\n  사건번호: 2026-0001`,
      evidence: { status: "matched", articles: [], precedents: ["101"], precedentExcerpts: { "101": "판례 판단 원문" },
        issues: [{ status: "found", articles: [], precedents: ["101"] }] } });
    const start = html.indexOf('class="law-detail-source research-issue-refs"');
    const detail = html.slice(start, html.indexOf("</details>", start));
    expect(detail).toContain("채택 판례 제목");
    expect(detail).toContain("2025다101");
    expect(detail).toContain("판례 판단 원문");
    expect(detail).toContain('href="https://www.law.go.kr/precInfoP.do?precSeq=101"');
    expect(detail).not.toContain("다른 도메인 제목");
    expect(detail).not.toContain(source);
    const additional = html.slice(html.indexOf("</details>", start));
    expect(additional).toContain("다른 도메인 제목");
    expect(additional).toContain(`href="https://www.law.go.kr/${source}"`);
  });

  it("keeps supporting-only sources inspectable without confirming the core issue or adopting another version", () => {
    const supporting = { ...article, excerpt: "보충 원문에 포함된 확인 문언", effectiveDate: "2026.01.01" };
    const html = render({ ...base, evidence: { status: "unverified", articles: [reference], precedents: ["71"],
      precedentEntries: { "71": { title: "보충 판례", caseNumber: "2026다71" } },
      issues: [{ label: "해고 기준", status: "none", articles: [reference], precedents: ["71"] }] },
      enrichment: { supplement: { status: "found", articles: [supporting] }, adoptionReviews: [{
        query: "해고", issueIndex: 0, verification: "verified",
        articles: [
          { ...supporting, stage: "issue", adopted: true, role: "supporting", reason: "주변 요건만 설명", quote: "확인 문언" },
          { ...article, stage: "chain", adopted: false, reason: "다른 시행 버전" },
        ],
        precedents: [{ id: "71", adopted: true, role: "supporting", reason: "보조적인 판단 기준", excerpt: "보조 판단 원문", quote: "판단" }],
      }] } });
    const start = html.indexOf('class="legal-analysis-section research-issue-evidence"');
    const issue = html.slice(start, html.indexOf("</section>", start));
    const detail = issue.slice(issue.indexOf("<details"));
    expect(issue).toContain('data-status="none"');
    expect(issue).not.toContain('data-evidence-role="direct"');
    expect(detail.match(/<li\b/gu)).toHaveLength(2);
    expect(detail).toContain("주변 요건만 설명");
    expect(detail).toContain("보조적인 판단 기준");
    expect(detail).toContain(supporting.excerpt);
    expect(detail).not.toContain(excerpt.split("\n")[1]);
    expect(detail).toContain("2026.01.01");
    expect(html).not.toMatch(/확인된 쟁점\s*<span/u);
    expect(html).not.toContain('data-status="matched"');
    // The unadopted original is still available outside issue evidence.
    expect(html.slice(html.indexOf("</section>", start))).toContain(excerpt.split("\n")[1]);
  });

  it("shows needs_confirmation as an unconfirmed requirement list, never as a confirmed direct source", () => {
    const supporting = { ...article, excerpt: "보충 원문에 포함된 확인 문언", effectiveDate: "2026.01.01" };
    const html = render({ ...base, evidence: { status: "unverified", articles: [reference], precedents: [],
      issues: [{ label: "임금 지급 기한", status: "needs_confirmation", articles: [reference], precedents: [],
        unconfirmed: ["근로자의 퇴직 여부", "근로자의 퇴직 여부", "지급 사유 발생일"] }] },
      enrichment: { supplement: { status: "found", articles: [supporting] }, adoptionReviews: [{
        query: "임금", issueIndex: 0, verification: "verified",
        articles: [{ ...supporting, stage: "issue", adopted: true, role: "supporting", reason: "주변 요건만 설명", quote: "확인 문언" }],
        precedents: [],
      }] } });
    const start = html.indexOf('class="legal-analysis-section research-issue-evidence"');
    const issue = html.slice(start, html.indexOf("</section>", start));
    expect(issue).toContain('data-status="needs_confirmation"');
    expect(issue).toContain("적용 요건 확인 필요");
    expect(issue).toContain("질문 사실만으로 확인할 수 없는 적용 요건이 있어 직접 근거로 확정하지 않았습니다.");
    expect(issue).toContain('aria-label="미확정 적용 요건"');
    expect(issue.match(/근로자의 퇴직 여부<\/li>/gu)).toHaveLength(1);
    expect(issue).toContain("다음 적용 요건에 해당하는 사실을 알려주면 다시 확인할 수 있습니다: 근로자의 퇴직 여부, 지급 사유 발생일.");
    expect(issue).not.toContain('data-evidence-role="direct"');
    expect(issue).not.toContain("근거 확인<");
    expect(html).not.toMatch(/확인된 쟁점\s*<span/u);
    expect(html).not.toContain("직접 근거 확인");
  });

  it("uses a server follow-up for needs_confirmation when one is given", () => {
    const html = render({ ...base, evidence: { status: "unverified", articles: [], precedents: [],
      issues: [{ label: "해고 기준", status: "needs_confirmation", articles: [], precedents: [], followUp: "근무 기간을 알려주세요." }] } });
    expect(html).toContain("근무 기간을 알려주세요.");
    expect(html).not.toContain('aria-label="미확정 적용 요건"');
  });

  it("attributes audited versions and role explanations independently to each issue", () => {
    const newer = { ...article, effectiveDate: "2026.01.01", excerpt: "새 시행 버전의 고유 원문" };
    const html = render({ ...base, evidence: { status: "matched", articles: [reference], precedents: [], issues: [
      { label: "해고 기준", status: "found", articles: [reference], precedents: [] },
      { label: "명시한 조문 확인", status: "found", articles: [reference], precedents: [] },
    ] }, enrichment: { supplement: { status: "found", articles: [newer] }, adoptionReviews: [
      { query: "해고", issueIndex: 0, verification: "verified", articles: [{ ...article, stage: "chain", adopted: true, role: "direct", reason: "해고 제한의 실체 요건", quote: "해고의 기준" }], precedents: [] },
      { query: "명시 조문", issueIndex: 1, verification: "verified", articles: [{ ...newer, stage: "issue", adopted: true, role: "identity", reason: "질문에 명시된 조문 원문", quote: "고유 원문" }], precedents: [] },
    ] } });
    const issues = [...html.matchAll(/class="legal-analysis-section research-issue-evidence"[\s\S]*?<\/section>/gu)].map((match) => match[0]);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain("해고 제한의 실체 요건");
    expect(issues[0]).toContain('data-evidence-role="direct"');
    expect(issues[0]).not.toContain(newer.excerpt);
    expect(issues[1]).toContain("질문에 명시된 조문 원문");
    expect(issues[1]).toContain('data-evidence-role="identity"');
    expect(issues[1]).not.toContain(excerpt.split("\n")[1]);
    for (const issue of issues) expect(issue.slice(issue.indexOf("<details")).match(/class="research-source-target"/gu)).toHaveLength(1);
  });

  it("counts and links adopted interpretation and tribunal sources by canonical domain without mixing identical numeric IDs", () => {
    const interpretation = { key: "interpretation:101", domain: "interpretation" as const, id: "101",
      title: "채택 해석례", caseNumber: "26-0101", date: "2026.01.02", body: "법제처",
      excerpt: "해석례 고유 원문", adopted: true, role: "direct" as const, reason: "쟁점 요건의 해석", quote: "요건" };
    const tribunal = { ...interpretation, key: "admin_appeal:101", domain: "admin_appeal" as const,
      title: "보충 심판례", caseNumber: "2026-101", excerpt: "심판례 고유 원문",
      role: "supporting" as const, reason: "보충 판단 기준" };
    const html = render({ ...base, text: "", evidence: { status: "partial", articles: [], precedents: ["101"],
      decisions: [interpretation.key, tribunal.key], precedentEntries: { "101": { title: "채택 판례", caseNumber: "2026다101" } },
      precedentExcerpts: { "101": "판례 고유 원문" }, issues: [
        { label: "해고 기준", status: "found", articles: [], precedents: ["101"], decisions: [interpretation.key] },
        { label: "보조 기준", status: "none", articles: [], precedents: [], decisions: [tribunal.key] },
      ] }, enrichment: { adoptionReviews: [
        { query: "해고", issueIndex: 0, verification: "verified", articles: [], precedents: [{ id: "101", excerpt: "판례 고유 원문", adopted: true, role: "direct", reason: "직접 판단 기준" }], decisions: [interpretation, interpretation] },
        { query: "보조 기준", issueIndex: 1, verification: "verified", articles: [], precedents: [], decisions: [tribunal] },
      ] } });
    const issues = [...html.matchAll(/class="legal-analysis-section research-issue-evidence"[\s\S]*?<\/section>/gu)].map((match) => match[0]);
    const firstDetail = issues[0].slice(issues[0].indexOf("<details"));
    const secondDetail = issues[1].slice(issues[1].indexOf("<details"));
    expect(firstDetail.match(/<li\b/gu)).toHaveLength(2);
    expect(firstDetail).toContain("precInfoP.do?precSeq=101");
    expect(firstDetail).toContain("expcInfoP.do?expcSeq=101");
    expect(firstDetail).toContain(interpretation.excerpt);
    expect(firstDetail).not.toContain(tribunal.excerpt);
    expect(secondDetail.match(/<li\b/gu)).toHaveLength(1);
    expect(secondDetail).toContain("deccInfoP.do?deccSeq=101");
    expect(secondDetail).toContain(tribunal.excerpt);
    expect(secondDetail).toContain('data-evidence-role="supporting"');
    expect(issues[1]).toContain('data-status="none"');
    // "심판례" contains the substring "판례"; compare whole source bodies,
    // not lexical substrings shared by otherwise distinct source domains.
    expect([...secondDetail.matchAll(/<pre class="legal-analysis-raw">([\s\S]*?)<\/pre>/gu)].map((match) => match[1])).toEqual([tribunal.excerpt]);
    expect(html.match(/확인된 쟁점\s*<span[^>]*>1건/gu)).toHaveLength(1);
  });

  it.each(["constitutional", "nlrc"] as const)("preserves the actual %s decision body and only established official original routes", (domain) => {
    const entry = { key: `${domain}:101`, domain, id: "101", title: "공식 결정 자료", body: "결정 기관", date: "2026.01.02",
      excerpt: "결정의 실제 원문", adopted: true, role: "direct" as const, reason: "해당 쟁점의 판단 기준", quote: "판단 기준" };
    const html = render({ ...base, text: "", evidence: { status: "matched", articles: [], precedents: [], decisions: [entry.key],
      issues: [{ status: "found", articles: [], precedents: [], decisions: [entry.key] }] },
      enrichment: { adoptionReviews: [{ query: "해고", issueIndex: 0, verification: "verified", articles: [], precedents: [], decisions: [entry] }] } });
    const start = html.indexOf('class="law-detail-source research-issue-refs"');
    const detail = html.slice(start, html.indexOf("</details>", start));
    expect(detail).toContain(entry.excerpt);
    expect(detail).toContain(entry.body);
    expect(detail).toContain(entry.date);
    expect(detail).toContain(`data-source-key="${entry.key}"`);
    if (domain === "constitutional") expect(detail).toContain("detcInfoP.do?detcSeq=101");
    else expect(detail).not.toContain("<a ");
  });

  it("preserves every real annex row, cell and grouped header without exposing format-only HWP text", () => {
    const html = render({ ...base, task: "action_basis", actionBasis: { status: "viewed", items: [] }, annexes: [{
      law: foodAnnex.law, label: foodAnnex.label, sourceArticle: "제89조", citation: "별표 23",
      status: "verified", relevance: "direct", text: foodAnnex.text,
    }] });
    expect(html.match(/class="research-annex-table"/gu)).toHaveLength(4);
    expect(html.match(/<tr\b/gu)).toHaveLength(316);
    expect(html.match(/<(?:th|td)(?:\s|>)/gu)).toHaveLength(1564);
    expect(html.match(/<thead>/gu)).toHaveLength(4);
    expect(html.match(/<tbody>/gu)).toHaveLength(4);
    expect(html).toMatch(/rowspan="2"/iu);
    expect(html).toMatch(/colspan="3"/iu);
    expect(html).toContain('data-column-kind="legal-basis"');
    expect(html).not.toContain("(파일형식: HWP)");
    expect(html).not.toMatch(/research-original-body"[^>]*\bopen=/u);
    expect(html).toContain("research-annex-paragraph");
  });

  it("retains distinct laws and effective versions while merging a provision's excerpt ranges", () => {
    const html = render({ ...base, task: "action_basis", actionBasis: { status: "viewed", items: [] },
      enrichment: { supplement: { status: "found", articles: [
        article, { ...article, effectiveDate: "2026.01.01" }, { ...article, law: "다른 법률" },
        { ...article, excerpt: "별도 발췌" }, { ...article, jo: "제24조", explicit: true, matched: [] },
      ] } } });
    expect(html.match(/class="research-group research-task-sources"/gu)).toHaveLength(1);
    expect(html).toContain("2026.01.01");
    expect(html).toContain("다른 법률 제23조");
    expect(html).toContain("별도 발췌");
    expect(html.match(/법제처 원문 보기/gu)).toHaveLength(4);
    expect(html).toContain('data-status="viewed"');
  });

  it("keeps two adopted effective versions as two actual sources rather than hiding one", () => {
    const html = render({ ...base, evidence: { status: "matched", articles: [reference], precedents: [], issues: [] },
      enrichment: { supplement: { status: "found", articles: [{ ...article, effectiveDate: "2026.01.01" }] } } });
    expect(html).toContain('id="research-article-1"');
    expect(html).toContain('id="research-article-2"');
    const detail = html.slice(html.indexOf('class="law-detail-source research-issue-refs"'), html.indexOf("</section>", html.indexOf('class="law-detail-source research-issue-refs"')));
    expect(detail.match(/class="research-source-target"/gu)).toHaveLength(2);
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
    const lower = html.indexOf('aria-label="상세 근거"');
    expect(lower).toBeGreaterThan(0);
    expect(html.slice(0, lower)).not.toContain(expression);
    expect(html.slice(0, lower)).not.toContain("고유 검증 설명");
    expect(html.slice(lower)).toContain(expression);
    expect(html.slice(lower)).not.toContain("고유 검증 설명");
    expect(html).not.toContain("상세 근거 ·");
    expect(html.slice(0, lower)).toContain("직접 위임관계 미확인");
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
    expect(html.match(/<table\b/gu)).toHaveLength(1);
    expect(html.match(/<tr\b/gu)).toHaveLength(2);
    expect(html.match(/<td\b/gu)).toHaveLength(4);
    for (const cell of ["구분", "위반행위", "1차", "경고"]) expect(html).toContain(`>${cell}</td>`);
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
    const hierarchyStart = html.indexOf('class="research-hierarchy"');
    const hierarchy = html.slice(hierarchyStart, html.indexOf("</dl>", hierarchyStart));
    expect(hierarchy.match(/<dt>/gu)).toHaveLength(1);
    expect(hierarchy.match(/제40조/gu)).toHaveLength(1);
    const original = html.slice(html.indexOf("<details", hierarchyStart), html.indexOf("</details>", hierarchyStart));
    expect(original.match(/제40조/gu)).toHaveLength(2);
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
    expect(sources).toContain("처분·허가 근거");
  });

  it("preserves an ellipsis-cut excerpt as unconfirmed source text", () => {
    const html = render({ ...base, task: "action_basis", actionBasis: { status: "viewed", items: [
      { label: "처분·허가 근거", status: "viewed", basisRefs: [{ law: article.law, jo: article.jo, title: article.title, excerpt: "① 일부 발췌 …" }] },
    ] } });
    const lower = html.slice(html.indexOf('aria-label="상세 근거"'));
    expect(lower).toContain("① 일부 발췌 …");
    expect(lower).toContain("보충 근거");
    expect(lower).not.toContain("원문 확보");
  });
});
