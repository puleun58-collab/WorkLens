import { describe, expect, it } from "vitest";
import { claimDisplayText } from "@/lib/analysis-presentation";
import {
  expectCovers,
  expectGrounded,
  expectNoExactRepeats,
  expectNoNoise,
  runAnalyze,
  visibleTexts,
  windowTexts,
  type AnalyzeRun,
} from "./analysis-quality-harness";
import { deckFile, type DeckSlide } from "./analysis-matrix-fixtures";

/** PPTX Analyze matrix: slide titles are context, bodies and tables are content. */
const deterministic = (run: AnalyzeRun) => visibleTexts(run.fallback, run.metrics);
const slideOf = (run: AnalyzeRun, pattern: RegExp) =>
  run.documents[0].blocks.find((block) => block.type === "paragraph" && pattern.test(block.text))?.source.page;

describe("Analyze matrix · PPTX", () => {
  it("PPTX-01 report deck: problem, remedy and conclusion outrank the cover", async () => {
    const run = await runAnalyze([deckFile("s01", "개선 보고.pptx", [
      { title: "2026 물류 개선 보고", texts: ["경영지원팀", "2026.09.25"] },
      { title: "현황", texts: ["출고 오류율은 월 2.4%로 목표 1%를 넘었습니다."] },
      { title: "문제점", texts: ["바코드 없이 수기로 검수하여 오류가 반복됩니다."] },
      { title: "개선안", texts: ["모든 출고품에 바코드 검수를 적용합니다."] },
      { title: "결론", texts: ["결론적으로 10월부터 바코드 검수를 전 센터에 의무화합니다."] },
    ])]);
    const core = { status: /오류율은 월 2\.4%/u, problem: /수기로 검수/u, remedy: /바코드 검수를 적용/u, conclusion: /전 센터에 의무화/u };
    expectCovers(deterministic(run), core, "PPTX-01");
    expectNoNoise(deterministic(run), [/^경영지원팀$/u, /^2026\.09\.25$/u], "PPTX-01");
    const { presented } = run.enrich([
      { text: "10월부터 바코드 검수를 전 센터에 의무화합니다.", evidence: [/의무화/u], role: "summary" },
      { text: "수기 검수로 오류가 반복되어 바코드 검수를 적용합니다.", evidence: [/수기로 검수/u, /바코드 검수를 적용/u], role: "insight" },
    ]);
    expect(presented.summary[0].evidence[0].source.locator).toMatchObject({ kind: "pptx", slide: 5 });
    expectGrounded(presented, run.documents);
    expectNoExactRepeats(presented);
  });

  it("PPTX-02 KPI slide keeps the number and its explanation linked", async () => {
    const run = await runAnalyze([deckFile("s02", "KPI.pptx", [
      { title: "3분기 KPI", texts: ["고객 응답률: 94%", "24시간 이내 응답 비율이 전 분기 91%에서 94%로 개선되었습니다."] },
    ])]);
    expectCovers(deterministic(run), { explanation: /91%에서 94%로 개선/u }, "PPTX-02");
    expectCovers(windowTexts(run), { kpi: /3분기 KPI · 고객 응답률: 94%/u }, "PPTX-02 window");
  });

  it("PPTX-03 table slide rows are analysed with cell provenance", async () => {
    const run = await runAnalyze([deckFile("s03", "지역 실적.pptx", [
      { title: "지역별 실적", table: [["지역", "목표", "실적"], ["서울", "100", "120"], ["부산", "80", "70"]] },
    ])]);
    expectCovers(deterministic(run), { seoul: /서울 — 목표: 100 · 실적: 120/u, busan: /부산 — 목표: 80 · 실적: 70/u }, "PPTX-03");
    const busan = run.items.find((item) => item.text.startsWith("부산"));
    expect(busan?.sources.some((source) => source.locator?.kind === "pptx" && source.locator.slide === 1 && source.locator.tableCell?.row === 3)).toBe(true);
  });

  it("PPTX-04 a long multi-sentence body is not reduced to its first sentence, and a line break keeps words apart", async () => {
    const run = await runAnalyze([deckFile("s04", "정책 설명.pptx", [
      { title: "재택근무 정책", texts: [{
        text: "재택근무는 주 2회까지 허용합니다.",
        breakAfter: "단, 신규 입사자는 입사 후 3개월 동안 재택근무를 할 수 없습니다.",
        more: ["재택근무일에는 오전 10시부터 오후 4시까지 메신저 응답이 필수입니다.", "월말 결산 주간에는 전원 출근합니다."],
      }] },
    ])]);
    const paragraph = run.documents[0].blocks.find((block) => block.type === "paragraph" && /주 2회/u.test(block.text));
    expect(paragraph?.type === "paragraph" ? paragraph.text : "").toMatch(/허용합니다\.\s+단, 신규/u);
    expectCovers(deterministic(run), { base: /주 2회/u, exception: /신규 입사자.*3개월/u, response: /메신저 응답이 필수/u, closing: /월말 결산 주간/u }, "PPTX-04");
  });

  it("PPTX-05 the same title on every slide is suppressed as noise", async () => {
    const run = await runAnalyze([deckFile("s05", "업무보고.pptx", Array.from({ length: 5 }, (_, index): DeckSlide => ({
      title: "2026 업무보고",
      texts: [`${index + 1}팀은 ${["채용", "교육", "평가", "보상", "복지"][index]} 계획을 10월까지 확정합니다.`],
    })))]);
    expectNoNoise(deterministic(run), [/^2026 업무보고$/u], "PPTX-05");
    expectNoNoise(windowTexts(run), [/^2026 업무보고$/u], "PPTX-05 window");
    expectCovers(deterministic(run), { first: /1팀은 채용/u, last: /5팀은 복지/u }, "PPTX-05");
  });

  it("PPTX-06 section titles give context but are not listed as main content on their own", async () => {
    const run = await runAnalyze([deckFile("s06", "원인 분석.pptx", [
      { title: "현황", texts: ["반품률이 3%에서 5%로 올랐습니다."] },
      { title: "원인", texts: ["포장재 변경 이후 파손 반품이 늘었습니다."] },
      { title: "대책", texts: ["완충재를 두 겹으로 늘립니다."] },
      { title: "결과", texts: ["시범 센터의 반품률이 2.8%로 낮아졌습니다."] },
    ])]);
    expectNoNoise(deterministic(run), [/^(?:현황|원인|대책|결과)$/u], "PPTX-06");
    expectCovers(windowTexts(run), { context: /대책 · 완충재를 두 겹/u }, "PPTX-06 window");
  });

  it("PPTX-07 a conclusion on the last slide of an 18-slide deck is not lost", async () => {
    const slides: DeckSlide[] = Array.from({ length: 17 }, (_, index) => ({
      title: `주간 현황 ${index + 1}`,
      texts: [`${index + 1}주차 센터별 처리 현황을 공유합니다.`, `${index + 1}주차 특이사항은 없습니다.`],
    }));
    slides.push({ title: "결론", texts: ["결론적으로 11월부터 야간 출고를 중단하고 주간 2교대로 전환합니다.", "단, 냉장 화물은 야간 출고를 유지합니다."] });
    const run = await runAnalyze([deckFile("s07", "주간 보고.pptx", slides)]);
    const core = { conclusion: /야간 출고를 중단.*2교대로 전환/u, exception: /냉장 화물은 야간 출고를 유지/u };
    expectCovers(deterministic(run), core, "PPTX-07");
    expectCovers(windowTexts(run), core, "PPTX-07 window");
  });

  it("PPTX-08 base rule, exception and caution across slides are all kept", async () => {
    const run = await runAnalyze([deckFile("s08", "보안 규정.pptx", [
      { title: "기본 규칙", texts: ["외부 저장장치는 사용할 수 없습니다."] },
      { title: "예외", texts: ["단, 보안팀이 승인한 암호화 USB는 사용할 수 있습니다."] },
      { title: "주의", texts: ["승인 USB도 개인 PC에 연결하면 즉시 승인이 취소됩니다."] },
    ])]);
    expectCovers(deterministic(run), { rule: /외부 저장장치는 사용할 수 없/u, exception: /암호화 USB는 사용할 수 있/u, caution: /승인이 취소/u }, "PPTX-08");
  });

  it("PPTX-09 a process drawn as text boxes keeps its order", async () => {
    const run = await runAnalyze([deckFile("s09", "처리 흐름.pptx", [
      { title: "처리 흐름", texts: ["접수 → 검토 → 승인 → 시행", "각 단계는 이전 단계가 끝나야 시작합니다."] },
    ])]);
    expectCovers(windowTexts(run), { order: /접수 → 검토 → 승인 → 시행/u }, "PPTX-09 window");
    expectCovers(deterministic(run), { rule: /이전 단계가 끝나야/u }, "PPTX-09");
  });

  it("PPTX-10 scattered text boxes are read top-to-bottom, left-to-right, not in XML order", async () => {
    const run = await runAnalyze([deckFile("s10", "배치.pptx", [
      { title: "신청 안내", texts: [
        { text: "3. 결과는 7일 이내 문자로 안내합니다.", x: 500000, y: 3500000 },
        { text: "1. 신청서를 온라인으로 제출합니다.", x: 500000, y: 1500000 },
        { text: "2. 담당자가 서류를 검토합니다.", x: 500000, y: 2500000 },
      ] },
    ])]);
    const order = run.documents[0].blocks.flatMap((block) => block.type === "paragraph" ? [block.text] : []).filter((text) => /^\d\./u.test(text));
    expect(order.map((text) => text[0])).toEqual(["1", "2", "3"]);
    expectCovers(deterministic(run), { sequence: /신청서를 온라인으로 제출.*→.*서류를 검토.*→.*7일 이내/u }, "PPTX-10");
  });

  it("PPTX-11 a big-number emphasis slide is not taken as the document's conclusion", async () => {
    const run = await runAnalyze([deckFile("s11", "성과.pptx", [
      { title: "성과", texts: ["120억", "+20%"] },
      { title: "요약", texts: ["신규 거래처 확대로 매출이 전년 대비 20% 증가해 120억원을 기록했습니다."] },
    ])]);
    expectNoNoise(deterministic(run), [/^120억$/u, /^\+20%$/u], "PPTX-11");
    expectCovers(deterministic(run), { summary: /전년 대비 20% 증가.*120억원/u }, "PPTX-11");
  });

  it("PPTX-12 a short three-slide deck is not inflated", async () => {
    const run = await runAnalyze([deckFile("s12", "짧은 공지.pptx", [
      { title: "사무실 이전 안내", texts: ["본사는 11월 3일 신관 5층으로 이전합니다."] },
      { title: "준비 사항", texts: ["10월 31일까지 개인 짐을 이사 상자에 담아 주십시오."] },
      { title: "문의", texts: ["총무팀 내선 1234"] },
    ])]);
    expect(run.items.length).toBeLessThanOrEqual(3);
    const { presented } = run.enrich([{ text: "본사는 11월 3일 신관 5층으로 이전합니다.", evidence: [/신관 5층/u], role: "summary" }]);
    expect(presented.summary.length + presented.content.length + presented.insights.length).toBeLessThanOrEqual(3);
    expectNoExactRepeats(presented);
  });

  it("PPTX-13 footer, date and slide-number placeholders are not content", async () => {
    const run = await runAnalyze([deckFile("s13", "바닥글.pptx", Array.from({ length: 3 }, (_, index): DeckSlide => ({
      title: `점검 ${index + 1}`,
      texts: [
        `${index + 1}번 설비는 월 1회 윤활유를 교체합니다.`,
        { text: "주식회사 가상제조 · 대외비", placeholder: "ftr" },
        { text: "2026.09.25", placeholder: "dt" },
        { text: String(index + 1), placeholder: "sldNum" },
      ],
    })))]);
    expectNoNoise([...deterministic(run), ...windowTexts(run)], [/가상제조/u, /^2026\.09\.25$/u], "PPTX-13");
    expectCovers(deterministic(run), { rule: /윤활유를 교체/u }, "PPTX-13");
  });

  it("PPTX-14 AI provenance points at the exact slide for summary, insight and content", async () => {
    const run = await runAnalyze([deckFile("s14", "가격 정책.pptx", [
      { title: "기본 가격", texts: ["모든 상품은 정가로 판매합니다."] },
      { title: "할인", texts: ["10개 이상 주문하면 5% 할인합니다."] },
      { title: "제외", texts: ["할인은 행사 상품에는 적용하지 않습니다."] },
    ])]);
    const { presented } = run.enrich([
      { text: "모든 상품은 정가로 판매합니다.", evidence: [/정가로 판매/u], role: "summary" },
      { text: "10개 이상 주문하면 정가 대신 5% 할인합니다.", evidence: [/10개 이상/u, /정가로 판매/u], role: "insight" },
    ]);
    expect(presented.summary[0].evidence[0].source.page).toBe(slideOf(run, /정가로 판매/u));
    expect(presented.insights[0].evidence.map(({ source }) => source.page)).toEqual([2, 1]);
    const exclusion = presented.content.find((item) => /행사 상품/u.test(item.text));
    expect(exclusion?.sources[0].page).toBe(3);
    expect(claimDisplayText(presented.insights[0])).toMatch(/5% 할인/u);
  });
});
