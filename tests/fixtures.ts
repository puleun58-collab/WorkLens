import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { strToU8, zipSync } from "fflate";

export type SheetRow = (string | number)[];

export async function createXlsx(sheets: Record<string, SheetRow[]>): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = workbook.addWorksheet(name);
    for (const row of rows) sheet.addRow(row);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

export async function createPdf(pages: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = pdf.addPage([595, 842]);
    page.drawText(text, { x: 56, y: 760, size: 14, font });
  }
  return pdf.save();
}

export function createDocx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "word/document.xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>분기 계약 요약</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>항목</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>금액</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>운송비</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>145000</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    ),
  });
}

function createPptxSlides(slides: readonly string[][]): Uint8Array {
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
  slides.forEach((texts, slideIndex) => {
    files[`ppt/slides/slide${slideIndex + 1}.xml`] = strToU8(
      `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${texts.map((text) => `<p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`).join("")}</p:spTree></p:cSld></p:sld>`,
    );
  });
  return zipSync(files);
}

export function createPptx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    ),
    "ppt/presentation.xml": strToU8(
      '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    ),
    "ppt/slides/slide1.xml": strToU8(
      '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>2026 운영 계획</a:t></a:r></a:p></p:txBody></p:sp><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:p><a:r><a:t>지역</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>예산</a:t></a:r></a:p></a:tc></a:tr><a:tr><a:tc><a:p><a:r><a:t>서울</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>5000</a:t></a:r></a:p></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:spTree></p:cSld></p:sld>',
    ),
  });
}

export function createCheckPptx(): Uint8Array {
  return createPptxSlides([
    ["운영 현황", "향후 13주 유가 전먕", "WorkLens", "기준일 2026.09.14", "매출 1,200백만원", "거리 10 km", "TODO"],
    ["운영 현황", "향후 13주 유가 전망", "Work Lens", "기준일 2026-09-15", "매출 1,250백만원", "거리 10 KM"],
  ]);
}

/**
 * Meeting deck shaped like a real one: labelled pairs on the cover slide and
 * an action line on the second. Used by the extraction tests.
 */
export function createExtractPptx(): Uint8Array {
  return createPptxSlides([
    [
      "9월 안전보건협의체",
      "회의일시: 2026.09.15 13:00",
      "작성부서: 경영지원팀",
      "참석인원: 12명",
      "문서번호: SOP-Q3",
    ],
    [
      "조치사항",
      "조치기한: 2026.09.30",
      "담당자: 김OO",
    ],
    [
      "시장 지표",
      "목표주가 64,550원",
      "상승여력 232.4%",
      "시가총액 2,258억 원",
      "기준일 2025.05.02",
      "단위 백만 원",
      "단위 백만 원",
      "Source: 회사 공시",
      "Source: 거래소 데이터",
    ],
  ]);
}

export function createBriefPptx(): Uint8Array {
  return createPptxSlides([
    ["기업 개요", "시가총액: 3,420억원", "목표주가: 64,550원"],
    ["비용 현황", "분기 운영 비용: 52억원"],
  ]);
}

export function createDocxWithMergedTable(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "word/document.xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:body>' +
        '<w:tbl>' +
        '<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>H3</w:t></w:r></w:p></w:tc></w:tr>' +
        '<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>A3</w:t></w:r></w:p></w:tc></w:tr>' +
        '<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B3</w:t></w:r></w:p></w:tc></w:tr>' +
        '</w:tbl>' +
        '</w:body></w:document>',
    ),
  });
}

export function createDocxWithOmissions(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "word/document.xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>본문</w:t></w:r></w:p></w:body></w:document>',
    ),
    "word/media/image1.png": strToU8("fake-png-bytes"),
    "word/charts/chart1.xml": strToU8("<chart/>"),
    "word/header1.xml": strToU8("<header/>"),
    "word/footer1.xml": strToU8("<footer/>"),
  });
}

export function createDocxWithNestedTable(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "word/document.xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Outer A</w:t></w:r></w:p>' +
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Inner omitted</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
        '</w:tc><w:tc><w:p><w:r><w:t>Outer B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
        '</w:body></w:document>',
    ),
  });
}

export function createPptxWithMergedTable(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    ),
    "ppt/presentation.xml": strToU8(
      '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    ),
    "ppt/slides/slide1.xml": strToU8(
      '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        '<p:cSld><p:spTree><a:graphic><a:graphicData><a:tbl>' +
        '<a:tr><a:tc gridSpan="2"><a:txBody><a:p><a:r><a:t>Header</a:t></a:r></a:p></a:txBody></a:tc><a:tc hMerge="1"><a:txBody><a:p/></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>H3</a:t></a:r></a:p></a:txBody></a:tc></a:tr>' +
        '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>A1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>A2</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>A3</a:t></a:r></a:p></a:txBody></a:tc></a:tr>' +
        '<a:tr><a:tc vMerge="1"><a:txBody><a:p/></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>B2</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>B3</a:t></a:r></a:p></a:txBody></a:tc></a:tr>' +
        '</a:tbl></a:graphicData></a:graphic></p:spTree></p:cSld></p:sld>',
    ),
  });
}

export function createPptxWithOmissions(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    ),
    "ppt/presentation.xml": strToU8(
      '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    ),
    "ppt/slides/slide1.xml": strToU8(
      '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>슬라이드</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    ),
    "ppt/media/image1.png": strToU8("fake-png-bytes"),
    "ppt/charts/chart1.xml": strToU8("<chart/>"),
    "ppt/notesSlides/notesSlide1.xml": strToU8("<notes/>"),
  });
}

export async function createXlsxWithHiddenSheetAndFormula(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const visible = workbook.addWorksheet("집계");
  visible.addRow(["항목", "금액"]);
  visible.addRow(["합계", { formula: "1+1", result: 2 }]);
  const hidden = workbook.addWorksheet("보조", { state: "hidden" });
  hidden.addRow(["숨겨진 시트"]);
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

export const RATE_SHEET_V1: Record<string, SheetRow[]> = {
  운송단가: [
    ["지역", "단가"],
    ["SEOUL", 145000],
    ["BUSAN", 90000],
    ["DAEGU", 70000],
    ["JEJU", 0],
  ],
};

export const RATE_SHEET_V2: Record<string, SheetRow[]> = {
  운송단가: [
    ["지역", "단가"],
    ["SEOUL", 158000],
    ["BUSAN", 90000],
    ["INCHEON", 60000],
    ["JEJU", 5000],
  ],
};
