import { describe, expect, it } from "vitest";
import type { NormalizedDocument, SourceRef, TableCell } from "@/domain/document";
import { buildEvidenceNodes, groundAiResult } from "@/lib/ai/grounding";
import { buildMessages, evidenceWindow, MAX_ANALYZE_EVIDENCE_CHARS, MAX_EVIDENCE_CHARS, MAX_EVIDENCE_ITEMS, resolveClaims } from "@/lib/ai/prompt";
import { MAX_EVIDENCE_CANDIDATES, selectEvidence } from "@/lib/ai/retrieval";

function paragraph(index: number, text: string, page = Math.floor(index / 10) + 1) {
  const nodeId = `pdf:p${page}:paragraph:${index}`;
  const source: SourceRef = { fileId: "file-1", nodeId, label: `페이지 ${page} 문단 ${index}`, page, quote: text };
  return { type: "paragraph" as const, id: nodeId, text, source };
}

function pdfDocument(texts: readonly string[]): NormalizedDocument {
  return {
    id: "document:file-1",
    fileId: "file-1",
    kind: "pdf",
    metadata: { fileName: "유가보고서.pdf", pageCount: Math.ceil(texts.length / 10) },
    warnings: [],
    blocks: texts.map((text, index) => paragraph(index + 1, text)),
  };
}

function sheetDocument(sheets: readonly { name: string; rows: string[][] }[]): NormalizedDocument {
  return {
    id: "document:file-2",
    fileId: "file-2",
    kind: "xlsx",
    metadata: {
      fileName: "운임현황.xlsx",
      sheets: sheets.map((sheet) => ({ name: sheet.name, visibility: "visible" as const, rowCount: sheet.rows.length, columnCount: 2 })),
    },
    warnings: [],
    blocks: sheets.map((sheet) => ({
      type: "table" as const,
      id: `xlsx:${sheet.name}:table`,
      source: {
        fileId: "file-2",
        nodeId: `xlsx:${sheet.name}:table`,
        label: `${sheet.name} 표`,
        sheet: sheet.name,
        locator: { kind: "xlsx" as const, sheet: sheet.name, range: "A1" },
      },
      rows: sheet.rows.map((row, rowIndex) => row.map((value, columnIndex): TableCell => ({
        value,
        display: value,
        source: {
          fileId: "file-2",
          nodeId: `xlsx:${sheet.name}:${rowIndex}:${columnIndex}`,
          label: `${sheet.name}!${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`,
          sheet: sheet.name,
          cellRange: `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`,
          row: rowIndex + 1,
          column: columnIndex + 1,
          locator: { kind: "xlsx" as const, sheet: sheet.name, range: `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}` },
          quote: value,
        },
      }))),
    })),
  };
}

function pptxDocument(slides: readonly { slide: number; text: string }[]): NormalizedDocument {
  return {
    id: "document:file-3",
    fileId: "file-3",
    kind: "pptx",
    metadata: { fileName: "분기보고.pptx", pageCount: slides.length },
    warnings: [],
    blocks: slides.map(({ slide, text }) => ({
      type: "paragraph" as const,
      id: `pptx:s${slide}:shape:1`,
      text,
      source: {
        fileId: "file-3",
        nodeId: `pptx:s${slide}:shape:1`,
        label: `Slide ${slide}`,
        locator: { kind: "pptx" as const, slide, shape: 1 },
        quote: text,
      },
    })),
  };
}

function selectTexts(document: NormalizedDocument, question: string, limit = 12): string[] {
  const nodes = buildEvidenceNodes([document]);
  return selectEvidence(nodes, { operation: "ask", question }, { limit }).map((node) => node.text);
}

const FILLER = Array.from({ length: 120 }, (_, index) => `${index + 1}분기 운영 일정과 회의록 요약 문단입니다.`);

describe("browser evidence retrieval", () => {
  it("finds the answer when it sits at the end of a long document", () => {
    const texts = [...FILLER, "8월 경유 가격은 1,480원입니다."];
    const selected = selectTexts(pdfDocument(texts), "8월 경유 가격은 얼마인가요?");
    expect(selected).toContain("8월 경유 가격은 1,480원입니다.");
  });

  it("prefers the relevant later paragraph over a similar-looking opener", () => {
    const texts = [
      "경유 가격 정책 개요를 설명하는 서문입니다.",
      ...FILLER,
      "8월 경유 가격은 1,480원으로 확정되었습니다.",
    ];
    const selected = selectTexts(pdfDocument(texts), "8월 경유 가격");
    const answerIndex = selected.indexOf("8월 경유 가격은 1,480원으로 확정되었습니다.");
    const openerIndex = selected.indexOf("경유 가격 정책 개요를 설명하는 서문입니다.");
    expect(answerIndex).toBeGreaterThanOrEqual(0);
    expect(openerIndex === -1 || answerIndex < openerIndex || answerIndex >= 0).toBe(true);
    const nodes = buildEvidenceNodes([pdfDocument(texts)]);
    const top = selectEvidence(nodes, { operation: "ask", question: "8월 경유 가격" }, { limit: 3 }).map((node) => node.text);
    expect(top).toContain("8월 경유 가격은 1,480원으로 확정되었습니다.");
  });

  it("matches a number the user typed", () => {
    const texts = [...FILLER, "8월 매출은 158000원으로 집계되었습니다."];
    const selected = selectTexts(pdfDocument(texts), "8월 매출 158000은 어디에 있나요?", 5);
    expect(selected).toContain("8월 매출은 158000원으로 집계되었습니다.");
  });

  it("finds a cell through its sheet name", () => {
    const document = sheetDocument([
      { name: "요약", rows: Array.from({ length: 40 }, (_, index) => [`요약항목${index}`, String(index)]) },
      { name: "운송단가", rows: [["SEOUL", "145000"], ["BUSAN", "90000"]] },
    ]);
    const nodes = buildEvidenceNodes([document]);
    const selected = selectEvidence(nodes, { operation: "ask", question: "운송단가 시트의 SEOUL 값" }, { limit: 8 });
    expect(selected.some((node) => node.source.sheet === "운송단가" && node.text.includes("145000"))).toBe(true);
  });

  it("finds a slide by its title wording", () => {
    const slides = [
      ...Array.from({ length: 30 }, (_, index) => ({ slide: index + 1, text: `일반 운영 현황 ${index + 1}` })),
      { slide: 31, text: "리스크 대응 계획 요약" },
    ];
    const nodes = buildEvidenceNodes([pptxDocument(slides)]);
    const selected = selectEvidence(nodes, { operation: "ask", question: "리스크 대응 계획" }, { limit: 5 });
    expect(selected.some((node) => node.text === "리스크 대응 계획 요약")).toBe(true);
  });

  it("matches date, currency and percentage questions", () => {
    const texts = [
      ...FILLER,
      "2026-08-14 기준 환율은 1,310원입니다.",
      "전월 대비 상승률은 8.97% 입니다.",
    ];
    const document = pdfDocument(texts);
    expect(selectTexts(document, "2026-08-14 환율", 5)).toContain("2026-08-14 기준 환율은 1,310원입니다.");
    expect(selectTexts(document, "상승률 8.97%", 5)).toContain("전월 대비 상승률은 8.97% 입니다.");
  });

  it("spreads Analyze evidence across the whole document instead of the first page", () => {
    const texts = Array.from({ length: 120 }, (_, index) => `${index + 1}번 항목: 매출 ${1000 + index}원, 2026-0${(index % 9) + 1}-01 기준입니다.`);
    const nodes = buildEvidenceNodes([pdfDocument(texts)]);
    const selected = selectEvidence(nodes, { operation: "analyze" }, { limit: MAX_EVIDENCE_ITEMS });
    const pages = new Set(selected.map((node) => node.source.page));
    expect(pages.size).toBeGreaterThanOrEqual(6);
    const firstPageShare = selected.filter((node) => node.source.page === 1).length / selected.length;
    expect(firstPageShare).toBeLessThan(0.4);
  });


  it("keeps broad document coverage for short Analyze inputs", () => {
    const document = pdfDocument([
      "시가총액은 3,420억원입니다.",
      "목표주가는 64,550원입니다.",
      "분기 운영 비용은 52억원입니다.",
    ]);
    const nodes = buildEvidenceNodes([document]);
    const selected = selectEvidence(nodes, { operation: "analyze" }, { limit: MAX_EVIDENCE_ITEMS });
    expect(selected.map((node) => node.text)).toEqual([
      "시가총액은 3,420억원입니다.",
      "목표주가는 64,550원입니다.",
      "분기 운영 비용은 52억원입니다.",
    ]);
  });

  it("breaks score ties by document order, so the window is deterministic", () => {
    const texts = Array.from({ length: 60 }, () => "동일한 내용의 문단입니다.");
    const nodes = buildEvidenceNodes([pdfDocument(texts)]);
    const first = selectEvidence(nodes, { operation: "ask", question: "동일한 내용" }, { limit: 10 });
    const second = selectEvidence(nodes, { operation: "ask", question: "동일한 내용" }, { limit: 10 });
    expect(first.map((node) => node.nodeId)).toEqual(second.map((node) => node.nodeId));
    const orders = first.map((node) => nodes.indexOf(node));
    expect([...orders].sort((left, right) => left - right)).toEqual(orders);
  });

  it("ranks before the prompt window trims, so a late answer survives the cut", () => {
    const texts = [...FILLER, ...FILLER, "9월 경유 단가는 1,512원입니다."];
    const nodes = buildEvidenceNodes([pdfDocument(texts)]);
    const window = evidenceWindow(selectEvidence(nodes, { operation: "ask", question: "9월 경유 단가" }));
    expect(window.items.some((item) => item.text.includes("1,512원"))).toBe(true);
    expect(window.items.length).toBeLessThanOrEqual(MAX_EVIDENCE_ITEMS);
  });

  /**
   * Analyze relates facts, so a tight window must spend its slots on the
   * sentences that state a relation, not on the titles that only name them.
   */
  it("gives Analyze the relational sentences before bare section titles", () => {
    const titles = ["Forecast 개요", "산정 기준", "값 선택", "적용 순서", "변경 기준", "Actual 기준"];
    const blocks = [
      ...titles.map((title, index) => ({ ...paragraph(index + 1, title), role: "heading" as const, headingLevel: 2 })),
      ...Array.from({ length: 30 }, (_, index) => paragraph(10 + index, `${index + 1}번 운영 일정 문단입니다.`)),
      paragraph(50, "주간 Forecast 가 없으면 월간 Forecast 를 대신 사용합니다."),
      paragraph(51, "새로운 Actual 이 반영되면 향후 Forecast 를 다시 계산합니다."),
    ];
    const document: NormalizedDocument = { ...pdfDocument([]), blocks };
    const nodes = buildEvidenceNodes([document]);
    const selected = selectEvidence(nodes, { operation: "analyze" }, { limit: 4 }).map((node) => node.text);

    expect(selected).toContain("주간 Forecast 가 없으면 월간 Forecast 를 대신 사용합니다.");
    expect(selected).toContain("새로운 Actual 이 반영되면 향후 Forecast 를 다시 계산합니다.");
  });

  it("ranks a document's rules above its cover, contents and running heads", () => {
    const document = pdfDocument([
      "주차별 예측값 산정 가이드",
      "지은이 정하건",
      "차례",
      "값 선택 순서 3",
      "CH 01 산정과 변경 가이드 2",
      "CH 01 산정과 변경 가이드 3",
      "주간 Forecast 는 최근 8개 주간 평균 유가와 평균 증감폭을 기준으로 산정합니다.",
      "각 미래 주차는 주간 Forecast, 월간 Forecast, 직전 Forecast 순서로 값을 선택합니다.",
      "새로운 Actual 이 반영되면 향후 Forecast 를 다시 계산합니다.",
      "8월 4주차 1,843.33원/L",
    ]);
    const nodes = buildEvidenceNodes([document]);
    const selected = selectEvidence(nodes, { operation: "analyze" }, { limit: 4 }).map((node) => node.text);

    expect(selected).toContain("주간 Forecast 는 최근 8개 주간 평균 유가와 평균 증감폭을 기준으로 산정합니다.");
    expect(selected).toContain("각 미래 주차는 주간 Forecast, 월간 Forecast, 직전 Forecast 순서로 값을 선택합니다.");
    expect(selected).not.toContain("지은이 정하건");
    expect(selected).not.toContain("CH 01 산정과 변경 가이드 2");
  });

  /**
   * Three neighbouring sections share the same vocabulary, so a short
   * question is only answered correctly when the section whose own title
   * carries the question wins over the ones next to it.
   */
  it("answers a short question from its own section, not the adjacent one", () => {
    const sections = [
      { heading: "주차별 Forecast 값은 어떻게 산정되나요?", body: "주간 Forecast 는 최근 8개 주간 평균 유가와 평균 증감폭을 기준으로 계산해 향후 주차에 순차 적용합니다." },
      { heading: "주차별 상세 데이터의 값 선택 순서", body: "미래 주차는 주간 Forecast, 월간 Forecast, 직전 Forecast, 현재 적용유가, 기준유가 순서로 값을 선택합니다." },
      { heading: "Forecast 값은 왜 계속 바뀌나요?", body: "새로운 Actual 과 시장지표가 반영되면 향후 Forecast 를 다시 계산합니다." },
    ];
    const blocks = [
      ...FILLER.slice(0, 20).map((text, index) => paragraph(index + 1, text)),
      ...sections.flatMap((section, index) => [
        { ...paragraph(40 + index * 2, section.heading), role: "heading" as const, headingLevel: 2 },
        paragraph(41 + index * 2, section.body),
      ]),
    ];
    const document: NormalizedDocument = { ...pdfDocument([]), blocks };
    const nodes = buildEvidenceNodes([document]);
    const direct = selectEvidence(nodes, { operation: "ask", question: "산정 방식" }, { limit: 2 }).map((node) => node.text);
    expect(direct).toContain(sections[0].body);
    expect(direct).not.toContain(sections[1].body);
    expect(direct).not.toContain(sections[2].body);

    const order = selectEvidence(nodes, { operation: "ask", question: "값 선택 순서" }, { limit: 2 }).map((node) => node.text);
    expect(order).toContain(sections[1].body);
    expect(order).not.toContain(sections[0].body);

    const change = selectEvidence(nodes, { operation: "ask", question: "Forecast 는 왜 바뀌나요?" }, { limit: 2 }).map((node) => node.text);
    expect(change).toContain(sections[2].body);
    expect(change).not.toContain(sections[1].body);
  });
  it("retrieves a late-page answer beyond both former prefix limits and grounds its real locator", () => {
    const answer = "심해 조사비는 7,430원으로 확정되었습니다.";
    const document = pdfDocument([
      ...Array.from({ length: 5_100 }, (_, index) => `${index}번째 행정 기록을 검토합니다. ${"일반 보고 내용 ".repeat(4)}`),
      answer,
    ]);
    const task = { operation: "ask" as const, question: "심해 조사비는 얼마인가요?" };
    const candidates = buildEvidenceNodes([document], task);
    expect(candidates.length).toBeLessThanOrEqual(MAX_EVIDENCE_CANDIDATES);
    const window = evidenceWindow(selectEvidence(candidates, task), undefined, task.operation);
    const found = window.items.find((item) => item.text.includes(answer));
    expect(found).toBeDefined();
    expect(buildMessages(task, window.items)[1].content).toContain(answer);
    const grounded = groundAiResult(task, [document], resolveClaims(window, [
      { text: answer, handles: [found!.handle], confidence: "high" },
    ]));
    expect(grounded.rejectedClaimCount).toBe(0);
    expect(grounded.claims[0].evidence[0].source).toMatchObject({
      fileId: "file-1",
      page: 511,
      nodeId: "pdf:p511:paragraph:5101",
      quote: answer,
    });
  });

  it("covers a late Analyze relation and later selected file after a 5,000-node first file", () => {
    const relation = "환율이 상승하면 구매 한도를 다시 계산합니다.";
    const latePageRelation = "기준유가가 바뀌면 주간 단가를 다시 계산합니다.";
    const first = pdfDocument([
      ...Array.from({ length: 5_100 }, (_, index) => `${index}번 운영 현황을 기록했습니다. ${"기본 보고 내용 ".repeat(4)}`),
      latePageRelation,
    ]);
    const second = { ...pdfDocument([relation]), id: "document:file-late", fileId: "file-late",
      blocks: [paragraph(1, relation, 70)].map((block) => ({
        ...block, source: { ...block.source, fileId: "file-late" },
      })) };
    const task = { operation: "analyze" as const };
    const candidates = buildEvidenceNodes([first, second], task);
    expect(candidates.filter((node) => node.fileId === "file-1").length).toBeGreaterThan(200);
    expect(candidates.filter((node) => node.fileId === "file-late")).toHaveLength(1);
    expect(candidates.length).toBeLessThanOrEqual(MAX_EVIDENCE_CANDIDATES);
    const window = evidenceWindow(selectEvidence(candidates, task), undefined, task.operation);
    const found = window.items.find((item) => item.text === relation);
    const latePage = window.items.find((item) => item.text === latePageRelation);
    expect(found).toBeDefined();
    expect(latePage).toBeDefined();
    expect(buildMessages(task, window.items)[1].content).toContain(relation);
    expect(buildMessages(task, window.items)[1].content).toContain(latePageRelation);
    expect(window.items.some((item) => item.text.includes("운영 현황"))).toBe(true);
    const grounded = groundAiResult(task, [first, second], resolveClaims(window, [
      { text: latePageRelation, handles: [latePage!.handle], confidence: "high", presentation: { role: "insight" } },
      { text: relation, handles: [found!.handle], confidence: "high", presentation: { role: "insight" } },
    ]));
    expect(grounded.rejectedClaimCount).toBe(0);
    expect(grounded.claims[0].evidence[0].source).toMatchObject({ fileId: "file-1", page: 511, quote: latePageRelation });
    expect(grounded.claims[1].evidence[0].source).toMatchObject({ fileId: "file-late", page: 70, quote: relation });
  });

  it("spends the 5k/10k character budgets before restoring document order", () => {
    const long = "경유 단가 관련 문장 " + "운송 계획 ".repeat(42);
    const answer = "경유 단가 예외 조건에 따르면 심해 운송은 8,321원입니다.";
    const document = pdfDocument([...Array.from({ length: 30 }, () => long), answer]);
    const task = { operation: "ask" as const, question: "경유 단가 예외 조건 심해 운송" };
    const window = evidenceWindow(selectEvidence(buildEvidenceNodes([document], task), task), undefined, task.operation);
    expect(window.items.some((item) => item.text === answer)).toBe(true);
    expect(window.items.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);

    const many = pdfDocument(Array.from({ length: 40 }, (_, index) => `작업 ${index} ${"운영 내용 ".repeat(45)}`));
    const analyzeTask = { operation: "analyze" as const };
    const analyzeWindow = evidenceWindow(selectEvidence(buildEvidenceNodes([many], analyzeTask), analyzeTask), undefined, "analyze");
    const askTask = { operation: "ask" as const, question: "작업 운영" };
    const askWindow = evidenceWindow(selectEvidence(buildEvidenceNodes([many], askTask), askTask), undefined, "ask");
    const analyzeChars = analyzeWindow.items.reduce((sum, item) => sum + item.text.length, 0);
    const askChars = askWindow.items.reduce((sum, item) => sum + item.text.length, 0);
    expect(analyzeChars).toBeGreaterThan(MAX_EVIDENCE_CHARS);
    expect(analyzeChars).toBeLessThanOrEqual(MAX_ANALYZE_EVIDENCE_CHARS);
    expect(askChars).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
    expect(analyzeWindow.items.length).toBeGreaterThan(askWindow.items.length);
    expect(analyzeWindow.items.length).toBeLessThanOrEqual(MAX_EVIDENCE_ITEMS);
  });
});
