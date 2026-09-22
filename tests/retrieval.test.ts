import { describe, expect, it } from "vitest";
import type { NormalizedDocument, SourceRef, TableCell } from "@/domain/document";
import { buildEvidenceNodes } from "@/lib/ai/grounding";
import { evidenceWindow, MAX_EVIDENCE_ITEMS } from "@/lib/ai/prompt";
import { selectEvidence } from "@/lib/ai/retrieval";

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

  it("spreads Brief evidence across the whole document instead of the first page", () => {
    const texts = Array.from({ length: 120 }, (_, index) => `${index + 1}번 항목: 매출 ${1000 + index}원, 2026-0${(index % 9) + 1}-01 기준입니다.`);
    const nodes = buildEvidenceNodes([pdfDocument(texts)]);
    const selected = selectEvidence(nodes, { operation: "brief" }, { limit: MAX_EVIDENCE_ITEMS });
    const pages = new Set(selected.map((node) => node.source.page));
    expect(pages.size).toBeGreaterThanOrEqual(6);
    const firstPageShare = selected.filter((node) => node.source.page === 1).length / selected.length;
    expect(firstPageShare).toBeLessThan(0.4);
  });

  it("does not treat summary formatting or emphasis instructions as retrieval queries", () => {
    const document = pptxDocument(Array.from({ length: 14 }, (_, index) => ({
      slide: index + 1,
      text: index === 9 ? "위험요소: 고소 작업 추락 방지 조치" : `회의 핵심 ${index + 1}: 안전 규정과 후속 조치`,
    })));
    const nodes = buildEvidenceNodes([document]);
    const formatted = selectEvidence(nodes, { operation: "brief", summaryInstruction: "임원 보고용으로 핵심만 5줄" }, { limit: MAX_EVIDENCE_ITEMS });
    const emphasized = selectEvidence(nodes, { operation: "brief", summaryInstruction: "위험요소를 강조" }, { limit: MAX_EVIDENCE_ITEMS });

    expect(formatted).toEqual(nodes);
    expect(emphasized).toEqual(nodes);
  });

  it("applies an explicit page range before balancing Brief evidence", () => {
    const nodes = buildEvidenceNodes([pptxDocument(Array.from({ length: 8 }, (_, index) => ({
      slide: index + 1,
      text: `슬라이드 ${index + 1} 핵심 내용`,
    })))]);
    const selected = selectEvidence(nodes, { operation: "brief", summaryInstruction: "3페이지 이후만 요약" }, { limit: MAX_EVIDENCE_ITEMS });

    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every((node) => node.source.locator?.kind === "pptx" && node.source.locator.slide >= 3)).toBe(true);
    expect(selected.some((node) => node.source.locator?.kind === "pptx" && node.source.locator.slide === 3)).toBe(true);
  });

  it("keeps broad document coverage when Brief has no focus instruction", () => {
    const document = pdfDocument([
      "시가총액은 3,420억원입니다.",
      "목표주가는 64,550원입니다.",
      "분기 운영 비용은 52억원입니다.",
    ]);
    const nodes = buildEvidenceNodes([document]);
    const selected = selectEvidence(nodes, { operation: "brief" }, { limit: MAX_EVIDENCE_ITEMS });
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

  it("ranks an emphasis higher without dropping the rest of the document", () => {
    const document = pptxDocument(Array.from({ length: 30 }, (_, index) => ({
      slide: index + 1,
      text: index === 20
        ? "Actual 이 확보되면 해당 주차는 Actual 로 전환됩니다."
        : `슬라이드 ${index + 1}: 주간 운영 일정과 후속 조치를 공유합니다.`,
    })));
    const nodes = buildEvidenceNodes([document]);
    const emphasized = selectEvidence(nodes, { operation: "brief", summaryInstruction: "Actual 중심" }, { limit: 10 });
    const restricted = selectEvidence(nodes, { operation: "brief", summaryInstruction: "Actual 관련 내용만" }, { limit: 10 });

    expect(emphasized.some((node) => node.text.includes("Actual 로 전환"))).toBe(true);
    expect(emphasized.some((node) => !node.text.includes("Actual"))).toBe(true);
    expect(restricted.every((node) => node.text.includes("Actual"))).toBe(true);
  });

  it("keeps a section heading with the paragraph that answers it", () => {
    const blocks = Array.from({ length: 40 }, (_, index) => {
      const node = paragraph(index + 1, `${index + 1}번 문단: 운영 일정과 회의 기록을 정리합니다.`);
      return index === 25
        ? { ...node, text: "Forecast 값은 왜 계속 바뀌나요?", role: "heading" as const, headingLevel: 1 }
        : index === 26
          ? { ...node, text: "새로운 Actual 데이터가 들어오면 향후 Forecast 를 다시 계산합니다." }
          : node;
    });
    const document: NormalizedDocument = { ...pdfDocument([]), blocks };
    const nodes = buildEvidenceNodes([document]);
    const selected = selectEvidence(nodes, { operation: "brief" }, { limit: 8 });
    const texts = selected.map((node) => node.text);

    expect(texts).toContain("Forecast 값은 왜 계속 바뀌나요?");
    expect(texts).toContain("새로운 Actual 데이터가 들어오면 향후 Forecast 를 다시 계산합니다.");
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
    const selected = selectEvidence(nodes, { operation: "brief" }, { limit: 4 }).map((node) => node.text);

    expect(selected).toContain("주간 Forecast 는 최근 8개 주간 평균 유가와 평균 증감폭을 기준으로 산정합니다.");
    expect(selected).toContain("각 미래 주차는 주간 Forecast, 월간 Forecast, 직전 Forecast 순서로 값을 선택합니다.");
    expect(selected).not.toContain("지은이 정하건");
    expect(selected).not.toContain("CH 01 산정과 변경 가이드 2");
  });
});
