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

export interface PdfLineSpec {
  text: string;
  /** Point size; a heading is simply set in a different size than the body. */
  size?: number;
}

/**
 * A PDF laid out like a real one: a cover, a heading in display type, body
 * lines that wrap, and a running footer on every page.
 */
export async function createStructuredPdf(pages: readonly PdfLineSpec[][]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = pdf.addPage([595, 842]);
    let y = 760;
    for (const line of lines) {
      const size = line.size ?? 11;
      page.drawText(line.text, { x: 56, y, size, font });
      y -= size * 1.7;
    }
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

export function createDocxParagraphs(paragraphs: readonly string[]): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`,
    ),
  });
}

export function createPptxSlides(slides: readonly string[][], untitledSlides: readonly number[] = []): Uint8Array {
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
  const untitled = new Set(untitledSlides);
  slides.forEach((texts, slideIndex) => {
    files[`ppt/slides/slide${slideIndex + 1}.xml`] = strToU8(
      `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${texts.map((text, textIndex) => `<p:sp>${textIndex === 0 && !untitled.has(slideIndex + 1) ? '<p:nvSpPr><p:cNvPr id="1" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' : ""}<p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`).join("")}</p:spTree></p:cSld></p:sld>`,
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
      '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>2026 운영 계획</a:t></a:r></a:p></p:txBody></p:sp><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:p><a:r><a:t>지역</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>예산</a:t></a:r></a:p></a:tc></a:tr><a:tr><a:tc><a:p><a:r><a:t>서울</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>5000</a:t></a:r></a:p></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:spTree></p:cSld></p:sld>',
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
      "목표주가 변화는 상승여력과 함께 검토해야 합니다.",
      "기준일 2025.05.02",
      "단위 백만 원",
      "단위 백만 원",
      "Source: 회사 공시",
      "Source: 거래소 데이터",
    ],
  ]);
}

export function createNarrativePptx(): Uint8Array {
  return createPptxSlides([
    ["안전보건협의체", "협의체 운영 목적과 참석 범위를 설명합니다."],
    ["회의 개요", "이번 회의의 일정과 안건을 공유합니다."],
    ["법적 요구 사항", "산업안전보건 관련 의무를 검토합니다."],
    ["업체별 위험요소", "협력업체 작업별 위험 요인을 정리합니다."],
    ["안전 규정", "현장 출입과 보호구 규정을 안내합니다."],
    ["작업 전 점검", "작업 시작 전 확인 절차를 설명합니다."],
    ["비상 대응", "사고 발생 시 보고 체계를 정리합니다."],
    ["교육 계획", "정기 안전교육 일정을 공유합니다."],
    ["현장 개선", "통로와 표지 개선 사항을 제안합니다."],
    ["이 문장은 제목 placeholder가 없는 본문입니다.", "임의 제목으로 승격하면 안 됩니다."],
    ["업체별 위험요소", "추가 협력업체의 위험 요인을 정리합니다."],
    ["강평", "점검 결과에 대한 의견을 공유합니다."],
    ["건의사항", "참석자 제안 사항을 정리합니다."],
    ["후속 조치", "담당자별 후속 업무를 확인합니다."],
  ], [10]);
}

export function createAnalyzePptx(): Uint8Array {
  return createPptxSlides([
    ["기업 개요", "시가총액: 3,420억원", "목표주가: 64,550원"],
    ["비용 현황", "분기 운영 비용: 52억원"],
    ["운영 판단", "비용이 늘어나면 예산을 다시 검토합니다."],
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

export function createTrainingPptx(month: "9월" | "10월"): Uint8Array {
  const september = month === "9월";
  const fields = september
    ? [
        "기준일: 2026.09.21",
        "담당부서: 인재개발팀",
        "교육명: 하반기 전사 보안교육",
        "교육일시: 2026.09.30 14:00",
        "교육장소: 본사 대강당",
        "교육대상: 전 직원 75명",
        "예산: 2,258,000원",
        "조사사항: 출석률 95% 미만 부서는 보강교육을 진행합니다.",
      ]
    : [
        "기준일: 2026.10.19",
        "담당부서: 안전관리팀",
        "교육명: 현장 안전교육",
        "교육일시: 2026.10.30 14:00",
        "교육대상: 협력사 직원 42명",
        "담당자: 박OO",
        "협조부서: 시설관리팀",
        "승인자: 이OO",
      ];
  const schedule = september
    ? [
        ["시간", "주제", "담당자", "산출물"],
        ["09:00", "정보보호 기본", "김OO", "출석부"],
        ["10:00", "사고 대응", "이OO", "확인서"],
      ]
    : [
        ["시간", "주제", "담당자", "산출물"],
        ["14:00", "위험성 평가", "박OO", "점검표"],
        ["15:00", "보호구 착용", "최OO", "확인서"],
      ];
  const textShape = (text: string, index: number, title = false) =>
    `<p:sp>${title ? `<p:nvSpPr><p:cNvPr id=\"${index + 1}\" name=\"Title\"/><p:cNvSpPr/><p:nvPr><p:ph type=\"title\"/></p:nvPr></p:nvSpPr>` : ""}<p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const table = `<a:graphic><a:graphicData><a:tbl>${schedule.map((row) =>
    `<a:tr>${row.map((cell) => `<a:tc><a:txBody><a:p><a:r><a:t>${cell}</a:t></a:r></a:p></a:txBody></a:tc>`).join("")}</a:tr>`).join("")}</a:tbl></a:graphicData></a:graphic>`;

  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    ),
    "ppt/presentation.xml": strToU8(
      '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>',
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
    ),
    "ppt/slides/slide1.xml": strToU8(
      `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${[`${month} 교육 운영 계획`, ...fields].map((text, index) => textShape(text, index, index === 0)).join("")}</p:spTree></p:cSld></p:sld>`,
    ),
    "ppt/slides/slide2.xml": strToU8(
      `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${textShape("교육 세부 일정", 0, true)}${table}</p:spTree></p:cSld></p:sld>`,
    ),
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
