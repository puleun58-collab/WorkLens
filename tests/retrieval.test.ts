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
    expect(selected.some((node) => node.source.sheet === "운송단가" && node.text === "145000")).toBe(true);
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
});
