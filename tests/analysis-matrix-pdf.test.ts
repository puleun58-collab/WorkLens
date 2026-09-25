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
import { h, p, pdfFile } from "./analysis-matrix-fixtures";

/**
 * PDF Analyze matrix. Each case states the meaning a reader must get
 * (concept → pattern), the noise that must stay out, and — with a mocked
 * model citing real shortlisted evidence — how roles, grounding and
 * repetition behave. Wording is never pinned; meaning is.
 */
const deterministic = (run: AnalyzeRun) => visibleTexts(run.fallback, run.metrics);

describe("Analyze matrix · PDF", () => {
  it("PDF-01 business report: purpose, result, problem and conclusion outrank examples; fabricated number and advice are rejected", async () => {
    const examples = Array.from({ length: 6 }, (_, index) => p(`예시 ${index + 1}: ${index + 3}월 둘째 주 하루 평균 ${50 + index}건을 처리했습니다.`));
    const run = await runAnalyze([await pdfFile("pdf01", "상반기 업무 보고서.pdf", [
      [h("2026 상반기 업무 보고서"), p("경영지원팀")],
      [h("목적"), p("이 보고서의 목적은 상반기 운영 성과를 점검하고 하반기 개선 방향을 결정하는 것입니다."), ...examples.slice(0, 3)],
      [h("주요 결과"), p("자동 배정 도입 이후 평균 대기시간이 3일에서 2일로 감소했습니다."), ...examples.slice(3)],
      [h("문제점"), p("야간 접수 건은 담당자 부재로 처리 지연이 반복되었습니다.")],
      [h("향후 계획"), p("결론적으로 하반기에는 야간 접수 건을 다음 영업일 오전에 우선 배정합니다.")],
    ])]);
    const core = {
      purpose: /목적은.*점검/u,
      result: /대기시간이 3일에서 2일/u,
      problem: /야간 접수.*지연/u,
      plan: /하반기.*우선 배정/u,
    };
    expectCovers(deterministic(run), core, "PDF-01 deterministic");
    expectCovers(windowTexts(run), core, "PDF-01 window");
    expect(run.items.filter((item) => /^예시 \d/u.test(item.text)).length).toBeLessThanOrEqual(2);

    const { grounded, presented } = run.enrich([
      { text: "상반기 운영 성과를 점검하고 하반기 개선 방향을 결정하기 위한 보고서입니다.", evidence: [/목적은/u], role: "summary" },
      { text: "하반기에는 야간 접수 건을 다음 영업일 오전에 우선 배정합니다.", evidence: [/우선 배정/u], role: "summary" },
      { text: "자동 배정 도입 후 평균 대기시간이 3일에서 2일로 감소했습니다.", evidence: [/대기시간/u], role: "insight" },
      { text: "하반기 처리 건수는 1,500건으로 예상됩니다.", evidence: [/대기시간/u], role: "summary" },
      { text: "야간 인력을 추가 채용해야 합니다.", evidence: [/야간 접수/u], role: "insight" },
    ]);
    expect(grounded.rejectedClaimCount).toBe(2);
    expect(presented.warnings.map((warning) => warning.code)).toContain("EVIDENCE_VALIDATION_FAILED");
    expectCovers(presented.summary.map(claimDisplayText), { purpose: /점검/u, plan: /우선 배정/u });
    expectNoNoise(visibleTexts(presented), [/1,500/u, /채용해야/u]);
    expect(presented.insights).toHaveLength(1);
    expectGrounded(presented, run.documents);
    expectNoExactRepeats(presented);
    expect(presented.summary.every((claim) => claim.evidence.every(({ source }) => source.page !== 1))).toBe(true);
  });

  it("PDF-02 regulation: scope, base rule, exception and approval step are all kept, the exception distinct from the rule", async () => {
    const run = await runAnalyze([await pdfFile("pdf02", "출장 규정.pdf", [
      [h("출장비 정산 규정"), h("목적"), p("이 규정은 출장비 정산 기준을 정하는 것을 목적으로 합니다."),
        h("적용 대상"), p("이 규정은 본사와 지사의 모든 정규직 직원에게 적용합니다."),
        h("기본 원칙"), p("출장비는 출장 종료 후 7일 이내에 영수증을 첨부하여 정산합니다.")],
      [h("예외"), p("단, 해외 출장은 출장 종료 후 14일 이내에 정산할 수 있습니다."),
        h("승인 절차"), p("정산 금액이 50만원을 초과하면 팀장 승인 후 재무팀 검토를 거쳐야 합니다.")],
    ])]);
    const core = {
      purpose: /정산 기준/u,
      scope: /정규직 직원에게 적용/u,
      rule: /7일 이내/u,
      exception: /해외 출장.*14일/u,
      approval: /50만원을 초과.*팀장 승인/u,
    };
    expectCovers(deterministic(run), core, "PDF-02");
    expectCovers(windowTexts(run), core, "PDF-02 window");
    const { presented } = run.enrich([
      { text: "출장비는 출장 종료 후 7일 이내에 영수증을 첨부해 정산합니다.", evidence: [/7일 이내/u], role: "summary" },
      { text: "해외 출장은 예외적으로 출장 종료 후 14일 이내에 정산할 수 있습니다.", evidence: [/해외 출장/u], role: "summary" },
      { text: "정산 금액이 50만원을 초과하면 팀장 승인 후 재무팀 검토를 거쳐야 합니다.", evidence: [/50만원/u], role: "insight" },
    ]);
    expectCovers(visibleTexts(presented), { rule: /7일 이내/u, exception: /14일/u, approval: /50만원/u }, "PDF-02 AI");
    // The exception and the base rule share wording but differ in scope and deadline.
    expect(presented.summary).toHaveLength(2);
    expectNoExactRepeats(presented);
    expectGrounded(presented, run.documents);
  });

  it("PDF-03 manual: five numbered steps stay one ordered, per-step grounded process", async () => {
    const steps = ["요청서를 접수합니다.", "담당자가 요청 내용을 검토합니다.", "팀장이 승인합니다.", "구매 담당자가 발주를 처리합니다.", "처리 결과를 요청자에게 통보하고 완료합니다."];
    const run = await runAnalyze([await pdfFile("pdf03", "구매 요청 매뉴얼.pdf", [[
      h("구매 요청 처리 절차"),
      p("구매 요청은 아래 순서로 처리합니다."),
      ...steps.map((step, index) => p(`${index + 1}. ${step}`)),
    ]])]);
    const process = run.items.find((item) => /접수.*→.*검토.*→.*승인.*→.*처리.*→.*완료/u.test(item.text));
    expect(process, deterministic(run).join("\n")).toBeTruthy();
    expect(new Set(process!.sources.map((source) => source.nodeId)).size).toBe(5);
    const texts = windowTexts(run).join("\n");
    const positions = ["접수", "검토", "승인", "발주", "통보"].map((word) => texts.indexOf(word));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("PDF-04 two-page table of contents never becomes main content; the body and conclusion do", async () => {
    const toc = (from: number) => Array.from({ length: 12 }, (_, index) =>
      p(`${from + index}. 운영 항목 ${from + index} ${index + 3}`));
    const run = await runAnalyze([await pdfFile("pdf04", "운영 지침.pdf", [
      [h("2026 운영 지침"), p("경영지원팀 · 2026.09.25")],
      [h("목차"), ...toc(1)],
      [h("목차"), ...toc(13)],
      [h("운영 원칙"), p("모든 요청은 접수 순서대로 처리하되 안전 관련 요청을 가장 먼저 처리합니다.")],
      [h("결론"), p("따라서 안전 요청 전담 창구를 10월부터 운영합니다.")],
    ])]);
    const texts = deterministic(run);
    expectCovers(texts, { rule: /안전 관련 요청을 가장 먼저/u, conclusion: /전담 창구.*10월/u }, "PDF-04");
    expectNoNoise(texts, [/운영 항목 \d+/u, /^목차$/u], "PDF-04");
    expectCovers(windowTexts(run), { rule: /안전 관련 요청/u, conclusion: /전담 창구/u }, "PDF-04 window");
  });

  it("PDF-05 running header, confidentiality line and page numbers repeated on every page are not selected", async () => {
    const header = (page: number): Parameters<typeof pdfFile>[2][number] => [
      { text: "주식회사 가상물류", size: 9, y: 815 },
      { text: "대외비", size: 9, y: 30 },
      { text: `- ${page} -`, size: 9, y: 18 },
    ];
    const bodies = [
      "창고 입고는 오전 9시부터 오후 4시까지 접수합니다.",
      "파손 화물은 사진을 첨부해 당일 신고합니다.",
      "반품은 출고일로부터 30일 이내에만 접수합니다.",
      "냉장 화물은 입고 즉시 냉장 구역으로 이동합니다.",
    ];
    const run = await runAnalyze([await pdfFile("pdf05", "창고 운영 기준.pdf",
      bodies.map((body, index) => [...header(index + 1), h(`기준 ${index + 1}`), p(body)]))]);
    const texts = deterministic(run);
    expectCovers(texts, { intake: /오전 9시/u, damage: /파손 화물/u, returns: /30일 이내/u, cold: /냉장 구역/u }, "PDF-05");
    expectNoNoise(texts, [/가상물류/u, /대외비/u, /^- \d+ -$/u], "PDF-05");
    expectNoNoise(windowTexts(run), [/^대외비$/u, /^- \d+ -$/u], "PDF-05 window");
  });

  it("PDF-06 report with prose and a KPI table: both the explanation and the figures are analysed", async () => {
    const run = await runAnalyze([await pdfFile("pdf06", "영업 실적 보고.pdf", [[
      h("영업 실적 보고"),
      p("영업1팀은 신규 거래처 확대로 목표를 초과 달성했고 영업2팀은 목표에 미달했습니다."),
      h("팀별 실적"),
      p("팀 목표 실적 달성률"),
      p("영업1팀 100 120 120%"),
      p("영업2팀 100 85 85%"),
    ]])]);
    expectCovers(deterministic(run), { prose: /영업1팀.*초과 달성.*영업2팀.*미달/u }, "PDF-06");
    expectCovers(windowTexts(run), { prose: /초과 달성/u, team1: /영업1팀 100 120 120%/u, team2: /영업2팀 100 85 85%/u }, "PDF-06 window");
  });

  it("PDF-07 number-heavy document: the few governing rules outrank the numeric log", async () => {
    const log = Array.from({ length: 60 }, (_, index) =>
      p(`2026-0${(index % 9) + 1}-${String((index % 27) + 1).padStart(2, "0")} 측정값 ${100 + index} 기록 ${index * 3}`));
    const pages = [];
    for (let index = 0; index < log.length; index += 20) pages.push([h("측정 기록"), ...log.slice(index, index + 20)]);
    const run = await runAnalyze([await pdfFile("pdf07", "설비 점검 기록.pdf", [
      [h("설비 점검 기준"), p("측정값이 150을 넘으면 설비 가동을 즉시 중단하고 정비팀에 보고합니다."),
        p("측정값이 120 이상 150 이하이면 다음 점검 주기를 절반으로 줄입니다.")],
      ...pages,
    ])]);
    const texts = deterministic(run);
    expectCovers(texts, { stop: /150을 넘으면.*중단/u, shorten: /120 이상 150 이하/u }, "PDF-07");
    expect(run.items.filter((item) => /측정값 \d+ 기록/u.test(item.text)).length).toBeLessThanOrEqual(2);
    expectCovers(windowTexts(run), { stop: /150을 넘으면/u, shorten: /120 이상/u }, "PDF-07 window");
  });

  it("PDF-08 short notice stays short: no more items than paragraphs and no inflated AI output", async () => {
    const run = await runAnalyze([await pdfFile("pdf08", "공지.pdf", [[
      h("주차장 공사 안내"),
      p("본관 주차장은 10월 1일부터 10월 5일까지 공사로 폐쇄됩니다."),
      p("공사 기간에는 별관 주차장을 이용해 주시기 바랍니다."),
    ]])]);
    expect(run.items.length).toBeLessThanOrEqual(2);
    expectCovers(deterministic(run), { closure: /10월 1일부터 10월 5일/u, alternative: /별관 주차장/u }, "PDF-08");
    const { presented } = run.enrich([
      { text: "본관 주차장은 10월 1일부터 10월 5일까지 폐쇄되며 별관 주차장을 이용합니다.", evidence: [/폐쇄/u, /별관/u], role: "summary" },
    ]);
    expect(presented.summary.length + presented.content.length + presented.insights.length).toBeLessThanOrEqual(3);
    expectNoExactRepeats(presented);
  });

  it("PDF-09 thirty-five-page document keeps a conclusion and exception set on its last page", async () => {
    const pages = Array.from({ length: 34 }, (_, page) => [
      h(`${page + 1}장 운영 현황`),
      ...Array.from({ length: 6 }, (_, line) => p(`${page + 1}장 ${line + 1}항: 지점별 일일 처리 현황을 기록합니다.`)),
    ]);
    const run = await runAnalyze([await pdfFile("pdf09", "연간 운영 보고서.pdf", [
      ...pages,
      [h("결론"), p("결론적으로 내년부터 모든 지점은 주간 보고를 월간 보고로 전환합니다."),
        p("단, 해외 지점은 주간 보고를 유지합니다.")],
    ])]);
    const core = { conclusion: /주간 보고를 월간 보고로 전환/u, exception: /해외 지점은 주간 보고를 유지/u };
    expectCovers(deterministic(run), core, "PDF-09");
    expectCovers(windowTexts(run), core, "PDF-09 window");
    const firstPageShare = run.window.items.filter((item) => /^1장 /u.test(item.text)).length / run.window.items.length;
    expect(firstPageShare).toBeLessThan(0.3);
  });

  it("PDF-10 the same rule restated in body, interim and final summary is shown once with every source", async () => {
    const run = await runAnalyze([await pdfFile("pdf10", "등록 절차.pdf", [
      [h("등록 절차"), p("승인 후 시스템에 등록합니다."), p("등록 담당자는 등록 결과를 요청자에게 통보합니다.")],
      [h("중간 요약"), p("시스템 등록은 승인 완료 후 진행합니다.")],
      [h("최종 요약"), p("승인이 끝나면 시스템에 등록합니다.")],
    ])]);
    const { presented } = run.enrich([
      { text: "승인이 완료된 뒤 시스템에 등록합니다.", evidence: [/^.*승인 후 시스템에 등록/u, /승인 완료 후 진행/u, /승인이 끝나면/u], role: "summary" },
      { text: "승인 후 시스템에 등록하면 등록 결과를 요청자에게 통보합니다.", evidence: [/승인 후 시스템에 등록/u, /통보/u], role: "insight" },
    ]);
    const restated = visibleTexts(presented).filter((text) => /승인.*등록|등록.*승인/u.test(text) && !/통보/u.test(text));
    expect(restated, JSON.stringify(restated)).toHaveLength(1);
    expectCovers(visibleTexts(presented), { notify: /통보/u }, "PDF-10");
    expect(new Set(presented.summary[0].evidence.map(({ source }) => source.page))).toEqual(new Set([1, 2, 3]));
  });

  it("PDF-11 base rule, conditional alternative and exclusion remain three separate facts", async () => {
    const run = await runAnalyze([await pdfFile("pdf11", "배송 기준.pdf", [[
      h("배송 기준"),
      p("기본적으로 주문은 다음 날 택배로 배송합니다."),
      p("단, 주문 금액이 100만원 이상이면 전담 기사가 직접 배송합니다."),
      p("도서 산간 지역 주문은 당일 배송 대상에서 제외합니다."),
    ]])]);
    const concepts = { base: /다음 날 택배/u, conditional: /100만원 이상이면 전담 기사/u, exclusion: /도서 산간.*제외/u };
    expectCovers(deterministic(run), concepts, "PDF-11");
    const { presented } = run.enrich([
      { text: "주문은 기본적으로 다음 날 택배로 배송합니다.", evidence: [/다음 날 택배/u], role: "summary" },
      { text: "주문 금액이 100만원 이상이면 택배 대신 전담 기사가 직접 배송합니다.", evidence: [/100만원/u, /다음 날 택배/u], role: "insight" },
    ]);
    expectCovers(visibleTexts(presented), concepts, "PDF-11 AI");
  });

  it("PDF-12 degenerate PDFs: blank pages, near-empty text and one meaningful page never crash or invent content", async () => {
    const blank = await runAnalyze([await pdfFile("pdf12a", "빈 문서.pdf", [[], []])]);
    expect(blank.items).toEqual([]);
    expect(blank.metrics).toEqual([]);
    expect(blank.window.items).toEqual([]);

    const sparse = await runAnalyze([await pdfFile("pdf12b", "거의 빈 문서.pdf", [[p("1")], [p("-")]])]);
    expect(sparse.items).toEqual([]);

    const one = await runAnalyze([await pdfFile("pdf12c", "부분 문서.pdf", [[], [p("검수 결과 불량률은 목표 이내로 확인되었습니다.")], []])]);
    expect(one.items.map((item) => item.text)).toEqual(["검수 결과 불량률은 목표 이내로 확인되었습니다."]);
    expect(one.items[0].sources[0].page).toBe(2);
  });

  it("PDF-13 parser probes: a sentence wrapped across lines rejoins; separate paragraphs and pages stay apart", async () => {
    const run = await runAnalyze([await pdfFile("pdf13", "줄바꿈.pdf", [
      [h("검토 기준"), p("신규 거래처는 사업자 등록 여부와 최근 3년간"), { text: "거래 실적을 확인한 뒤 등록합니다.", continues: true },
        p("기존 거래처는 연 1회 재검토합니다.")],
      [p("재검토 결과 부적합 거래처는 거래를 중지합니다.")],
    ])]);
    const texts = run.documents[0].blocks.flatMap((block) => block.type === "paragraph" ? [block.text] : []);
    expect(texts).toContain("신규 거래처는 사업자 등록 여부와 최근 3년간 거래 실적을 확인한 뒤 등록합니다.");
    expect(texts).toContain("기존 거래처는 연 1회 재검토합니다.");
    expectCovers(deterministic(run), { wrapped: /최근 3년간 거래 실적/u, yearly: /연 1회/u, stop: /거래를 중지/u }, "PDF-13");
  });
});
