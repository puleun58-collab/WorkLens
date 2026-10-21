import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { documentHasExtractableContent, parseDocument } from "../src/lib/parsers";
import {
  createDocx,
  createDocxImageOnly,
  createDocxParagraphs,
  createDocxWithOmissions,
  createPdf,
  createPptx,
  createPptxImageOnly,
  createPptxWithOmissions,
  createXlsx,
} from "./fixtures";

/**
 * 파일 행 '확인 필요' 보완(콘텐츠 부재 판정)의 파서 신호 회귀:
 * 경고 코드가 아니라 실제 추출 결과에 내용이 있는지를 판정한다.
 * - 일반 안내(DOCX_IMAGE_OMITTED 등)만 있는 파일이라도 읽을 내용이 전혀
 *   없으면 contentEmpty 신호가 서야 한다.
 * - 반대로 내용이 있으면 숫자 0 같은 비문장 데이터도 내용으로 인정한다.
 */
const parse = (fileName: string, bytes: Uint8Array) =>
  parseDocument({ fileId: `test:${fileName}`, fileName, bytes });

const imageOnlyPdf = async (): Promise<Uint8Array> => {
  const pdf = await PDFDocument.create();
  const picture = await pdf.embedPng(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/dV0AAAAASUVORK5CYII=",
    "base64",
  ));
  const page = pdf.addPage([595, 842]);
  page.drawImage(picture, { x: 30, y: 100, width: 500, height: 600 });
  return pdf.save();
};

describe("documentHasExtractableContent — 형식별 경계", () => {
  it("일반 텍스트 DOCX는 내용이 있다", async () => {
    const doc = await parse("일반.docx", createDocx());
    expect(documentHasExtractableContent(doc)).toBe(true);
  });

  it("텍스트와 이미지가 함께 있는 DOCX는 내용이 있다 (일반 안내는 숨김 유지 대상)", async () => {
    const doc = await parse("혼합.docx", createDocxWithOmissions());
    expect(doc.warnings).toContain("DOCX_IMAGE_OMITTED");
    expect(documentHasExtractableContent(doc)).toBe(true);
  });

  it("이미지만 있는 DOCX는 내용이 없다 — 경고가 일반 안내뿐이어도 신호가 선다", async () => {
    const doc = await parse("이미지만.docx", createDocxImageOnly());
    expect(doc.warnings).toContain("DOCX_IMAGE_OMITTED");
    expect(documentHasExtractableContent(doc)).toBe(false);
  });

  it("공백만 있는 DOCX는 내용이 없다 (의미 없는 문자를 내용으로 오인하지 않음)", async () => {
    const doc = await parse("공백.docx", createDocxParagraphs(["   ", "\t "]));
    expect(documentHasExtractableContent(doc)).toBe(false);
  });

  it("텍스트 슬라이드가 있는 PPTX는 내용이 있다", async () => {
    const doc = await parse("일반.pptx", createPptx());
    expect(documentHasExtractableContent(doc)).toBe(true);
    const mixed = await parse("혼합.pptx", createPptxWithOmissions());
    expect(documentHasExtractableContent(mixed)).toBe(true);
  });

  it("이미지 슬라이드만 있는 PPTX는 내용이 없다", async () => {
    const doc = await parse("이미지만.pptx", createPptxImageOnly());
    expect(doc.warnings).toContain("PPTX_IMAGE_OMITTED");
    expect(documentHasExtractableContent(doc)).toBe(false);
  });

  it("텍스트 레이어가 있는 PDF는 내용이 있고, 스캔 PDF는 내용이 없다", async () => {
    const text = await parse("문서.pdf", await createPdf(["Quarterly results report"]));
    expect(documentHasExtractableContent(text)).toBe(true);
    const scanned = await parse("스캔.pdf", await imageOnlyPdf());
    expect(scanned.warnings).toContain("PDF_TEXT_LAYER_EMPTY");
    expect(documentHasExtractableContent(scanned)).toBe(false);
  });

  it("데이터가 있는 XLSX는 내용이 있고 숫자 0도 데이터로 인정한다", async () => {
    const doc = await parse("실적.xlsx", await createXlsx({ 데이터: [["항목", "값"], ["건수", 0]] }));
    expect(documentHasExtractableContent(doc)).toBe(true);
  });

  it("분석 가능한 데이터가 없는 XLSX(빈 시트)는 내용이 없다", async () => {
    const doc = await parse("빈시트.xlsx", await createXlsx({ 빈시트: [] }));
    expect(documentHasExtractableContent(doc)).toBe(false);
  });

  it("일반 CSV는 내용이 있고 빈 셀만 있는 CSV는 내용이 없다", async () => {
    const text = new TextEncoder().encode("항목,값\r\n금액,72000\r\n");
    const doc = await parse("데이터.csv", text);
    expect(documentHasExtractableContent(doc)).toBe(true);
    const empty = await parse("빈.csv", new TextEncoder().encode(",,\r\n,,\r\n"));
    expect(documentHasExtractableContent(empty)).toBe(false);
  });
});
