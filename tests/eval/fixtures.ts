import { strToU8, zipSync } from "fflate";
import type { NormalizedDocument } from "@/domain/document";
import { parseDocument } from "@/lib/parsers";
import { createPdf, createXlsx, type SheetRow } from "../fixtures";

/**
 * Evaluation fixtures.
 *
 * These are deliberately closer to real working documents than the unit-test
 * fixtures: multiple sheets, many months, slides with titles and numbers, a
 * contract with dates and amounts. The eval suite needs documents where the
 * answer is genuinely hard to find by position alone.
 */
export const MONTHS = ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"] as const;
export const REGIONS = ["서울", "부산", "대구", "인천"] as const;

/** Sales per month and region: 서울 8월 = 158000, and every value is unique. */
export function salesValue(monthIndex: number, regionIndex: number): number {
  return 100000 + monthIndex * 7000 + regionIndex * 1300;
}

export function forecastValue(monthIndex: number): number {
  return 90000 + monthIndex * 6100;
}

function salesRows(): SheetRow[] {
  const rows: SheetRow[] = [["월", ...REGIONS]];
  MONTHS.forEach((month, monthIndex) => {
    rows.push([month, ...REGIONS.map((_, regionIndex) => salesValue(monthIndex, regionIndex))]);
  });
  rows.push(["합계", ...REGIONS.map((_, regionIndex) =>
    MONTHS.reduce((sum, _month, monthIndex) => sum + salesValue(monthIndex, regionIndex), 0))]);
  return rows;
}

function forecastRows(): SheetRow[] {
  const rows: SheetRow[] = [["월", "예상", "달성률"]];
  MONTHS.forEach((month, monthIndex) => {
    rows.push([month, forecastValue(monthIndex), `${(80 + monthIndex).toFixed(1)}%`]);
  });
  return rows;
}

export const EVAL_WORKBOOK: Record<string, SheetRow[]> = {
  매출: salesRows(),
  Forecast: forecastRows(),
  운송단가: [
    ["지역", "단가", "기준일"],
    ["서울", 145000, "2026-08-01"],
    ["부산", 90000, "2026-08-01"],
    ["대구", 70000, "2026-08-01"],
    ["인천", 60000, "2026-08-01"],
  ],
};

export function evalCsv(): string {
  const header = "지역,날짜,금액,코드\r\n";
  const rows = REGIONS.flatMap((region, regionIndex) =>
    MONTHS.map((_month, monthIndex) =>
      `${region},2026-${String(monthIndex + 1).padStart(2, "0")}-15,${salesValue(monthIndex, regionIndex)},WL-${regionIndex}${monthIndex}`));
  return header + rows.join("\r\n") + "\r\n";
}

/** English contract: the PDF fixture font has no Korean glyphs. */
export function evalPdfPages(): string[] {
  const pages = [
    "WorkLens Logistics Service Agreement",
    "Article 1 Scope: nationwide freight for the Seoul, Busan, Daegu and Incheon hubs.",
    "Article 2 Term: this agreement runs from 2026-03-01 until 2026-12-31.",
    "Article 3 Fees: the monthly base fee is 145000 KRW and the late penalty rate is 2.5%.",
  ];
  for (let index = 0; index < 20; index += 1) {
    pages.push(`Appendix ${index + 1}: operational notes, escalation contacts and review schedule.`);
  }
  pages.push("Article 9 Termination: either party may terminate with 60 days written notice.");
  return pages;
}

function paragraph(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

export function evalDocx(): Uint8Array {
  const body = [
    paragraph("2026년 3분기 운영 보고서"),
    paragraph("작성일 2026-09-15"),
    ...Array.from({ length: 24 }, (_, index) => paragraph(`운영 세부 항목 ${index + 1}: 정기 점검과 회의록 요약입니다.`)),
    paragraph("리스크 항목"),
    paragraph("리스크 항목에는 유가 변동, 인력 부족, 창고 임대료 상승이 있습니다."),
    paragraph("계약 금액"),
    paragraph("연간 계약 금액은 1,740,000원이며 지급일은 매월 25일입니다."),
    "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>항목</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>금액</w:t></w:r></w:p></w:tc></w:tr>"
    + "<w:tr><w:tc><w:p><w:r><w:t>운송비</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>145000</w:t></w:r></w:p></w:tc></w:tr>"
    + "<w:tr><w:tc><w:p><w:r><w:t>보관비</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>52000</w:t></w:r></w:p></w:tc></w:tr></w:tbl>",
  ].join("");
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
  });
}

export function evalPptxSlides(): string[][] {
  const filler = Array.from({ length: 18 }, (_, index) => [
    `운영 현황 ${index + 1}`,
    `주간 배송 건수는 ${1200 + index * 17}건입니다.`,
  ]);
  return [
    ["2026 3분기 사업 계획", "작성 2026-09-15"],
    ...filler,
    ["향후 13주 유가 전망", "유가는 배럴당 82.4달러 수준을 유지할 전망입니다."],
    ["리스크 대응", "리스크 대응 계획은 대체 운송사 확보와 재고 분산입니다."],
    ["8월 실적 요약", "8월 서울 매출은 158000원입니다.", "달성률 87.0%"],
  ];
}

function pptx(slides: readonly string[][]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${slides.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`,
    ),
    "ppt/presentation.xml": strToU8(
      `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join("")}</Relationships>`,
    ),
  };
  slides.forEach((texts, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = strToU8(
      `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${texts.map((text) => `<p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`).join("")}</p:spTree></p:cSld></p:sld>`,
    );
  });
  return zipSync(files);
}

export type EvalFormat = "xlsx" | "csv" | "pdf" | "docx" | "pptx";

let cache: Map<EvalFormat, NormalizedDocument> | undefined;

/** Parses every eval fixture once; the suite runs against real parser output. */
export async function evalDocuments(): Promise<Map<EvalFormat, NormalizedDocument>> {
  if (cache) return cache;
  const built = new Map<EvalFormat, NormalizedDocument>();
  built.set("xlsx", await parseDocument({ fileId: "eval-xlsx", fileName: "실적보고.xlsx", bytes: await createXlsx(EVAL_WORKBOOK) }));
  built.set("csv", await parseDocument({ fileId: "eval-csv", fileName: "지역실적.csv", bytes: new TextEncoder().encode(evalCsv()) }));
  built.set("pdf", await parseDocument({ fileId: "eval-pdf", fileName: "contract.pdf", bytes: await createPdf(evalPdfPages()) }));
  built.set("docx", await parseDocument({ fileId: "eval-docx", fileName: "운영보고서.docx", bytes: evalDocx() }));
  built.set("pptx", await parseDocument({ fileId: "eval-pptx", fileName: "사업계획.pptx", bytes: pptx(evalPptxSlides()) }));
  cache = built;
  return built;
}
