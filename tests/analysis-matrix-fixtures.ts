import ExcelJS from "exceljs";
import { strToU8, zipSync } from "fflate";
import { createUnicodePdf, type PdfLineSpec } from "./fixtures";
import type { MatrixFile } from "./analysis-quality-harness";

/** Deterministic PRNG (mulberry32) for seeded fixture variation. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export const pdfFile = async (fileId: string, fileName: string, pages: PdfLineSpec[][]): Promise<MatrixFile> =>
  ({ fileId, fileName, bytes: await createUnicodePdf(pages) });

/** Body paragraphs at 11pt, a section heading at 15pt. */
export const h = (text: string): PdfLineSpec => ({ text, size: 15 });
export const p = (text: string): PdfLineSpec => ({ text });

// ── XLSX ────────────────────────────────────────────────────────────────

export type Cell = string | number | null
  | { formula: string; result: number | string; numFmt?: string }
  | { value: number | string; numFmt: string };

export interface SheetSpec {
  name: string;
  rows: Cell[][];
  merges?: string[];
}

export async function xlsxFile(fileId: string, fileName: string, sheets: readonly SheetSpec[]): Promise<MatrixFile> {
  const workbook = new ExcelJS.Workbook();
  for (const spec of sheets) {
    const sheet = workbook.addWorksheet(spec.name);
    spec.rows.forEach((row, rowIndex) => {
      row.forEach((value, columnIndex) => {
        if (value === null) return;
        const cell = sheet.getCell(rowIndex + 1, columnIndex + 1);
        if (typeof value === "object" && "numFmt" in value && value.numFmt) cell.numFmt = value.numFmt;
        cell.value = (typeof value === "object" && "value" in value ? value.value
          : typeof value === "object" ? { formula: value.formula, result: value.result } : value) as ExcelJS.CellValue;
      });
    });
    for (const range of spec.merges ?? []) sheet.mergeCells(range);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return { fileId, fileName, bytes: new Uint8Array(buffer as ArrayBuffer) };
}

// ── PPTX ────────────────────────────────────────────────────────────────

export type DeckText = string | {
  text: string;
  /** Top-left offset in EMU; written as a:off when given. */
  x?: number;
  y?: number;
  placeholder?: "title" | "body" | "ftr" | "sldNum" | "dt";
  /** Extra paragraphs inside the same text box. */
  more?: string[];
  /** Visual line break inside one paragraph (a:br). */
  breakAfter?: string;
};

export interface DeckSlide {
  title?: string;
  texts?: DeckText[];
  table?: string[][];
}

const escapeXml = (text: string) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

function shapeXml(id: number, item: DeckText): string {
  const spec = typeof item === "string" ? { text: item } : item;
  const ph = spec.placeholder ? `<p:ph type="${spec.placeholder}"/>` : "";
  const xfrm = spec.x !== undefined || spec.y !== undefined
    ? `<a:xfrm><a:off x="${spec.x ?? 0}" y="${spec.y ?? 0}"/><a:ext cx="3000000" cy="600000"/></a:xfrm>`
    : "";
  const run = (text: string) => `<a:r><a:t>${escapeXml(text)}</a:t></a:r>`;
  const first = spec.breakAfter !== undefined
    ? `<a:p>${run(spec.text)}<a:br/>${run(spec.breakAfter)}</a:p>`
    : `<a:p>${run(spec.text)}</a:p>`;
  const paragraphs = [first, ...(spec.more ?? []).map((text) => `<a:p>${run(text)}</a:p>`)].join("");
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${xfrm}</p:spPr><p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp>`;
}

function tableXml(id: number, rows: string[][]): string {
  const body = rows.map((row) =>
    `<a:tr h="370840">${row.map((cell) => `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>${escapeXml(cell)}</a:t></a:r></a:p></a:txBody></a:tc>`).join("")}</a:tr>`).join("");
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

export function deckBytes(slides: readonly DeckSlide[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${slides.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`),
    "ppt/presentation.xml": strToU8(`<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join("")}</Relationships>`),
  };
  slides.forEach((slide, index) => {
    let id = 1;
    const shapes: string[] = [];
    if (slide.title !== undefined) shapes.push(shapeXml(id++, { text: slide.title, placeholder: "title" }));
    for (const text of slide.texts ?? []) shapes.push(shapeXml(id++, text));
    if (slide.table) shapes.push(tableXml(id++, slide.table));
    files[`ppt/slides/slide${index + 1}.xml`] = strToU8(`<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree>${shapes.join("")}</p:spTree></p:cSld></p:sld>`);
  });
  return zipSync(files);
}

export const deckFile = (fileId: string, fileName: string, slides: readonly DeckSlide[]): MatrixFile =>
  ({ fileId, fileName, bytes: deckBytes(slides) });

// ── One business content in three formats ───────────────────────────────

/** Shared meaning for cross-format comparison; wording adapts to each format. */
export const SAME_CONTENT = {
  goal: "프로젝트 목표는 처리시간을 20% 단축하는 것입니다.",
  baseline: "현재 평균 처리시간은 10일이며 목표는 8일입니다.",
  process: ["접수", "검토", "승인", "완료"],
  exception: "긴급 건은 선처리 후 사후 승인할 수 있습니다.",
  months: [["8월", 9], ["9월", 8]] as const,
};

export async function sameContentPdf(): Promise<MatrixFile> {
  const c = SAME_CONTENT;
  return pdfFile("same-pdf", "same-content.pdf", [[
    h("처리시간 단축 프로젝트"),
    p(c.goal),
    p(c.baseline),
    h("기본 프로세스"),
    ...c.process.map((step, index) => p(`${index + 1}. ${step} 단계를 처리합니다.`)),
    h("예외"),
    p(c.exception),
    h("월별 실적"),
    ...c.months.map(([month, days]) => p(`${month} 평균 처리시간은 ${days}일입니다.`)),
  ]]);
}

export async function sameContentXlsx(): Promise<MatrixFile> {
  const c = SAME_CONTENT;
  return xlsxFile("same-xlsx", "same-content.xlsx", [
    { name: "개요", rows: [
      ["항목", "내용"],
      ["목표", c.goal],
      ["기준", c.baseline],
      ["기본 프로세스", c.process.join(" → ")],
      ["예외", c.exception],
    ] },
    { name: "월별 실적", rows: [["월", "평균 처리시간(일)", "목표(일)"], ...c.months.map(([month, days]) => [month, days, 8])] },
  ]);
}

export function sameContentPptx(): MatrixFile {
  const c = SAME_CONTENT;
  return deckFile("same-pptx", "same-content.pptx", [
    { title: "처리시간 단축 프로젝트", texts: [c.goal, c.baseline] },
    { title: "기본 프로세스", texts: [c.process.join(" → ")] },
    { title: "예외", texts: [c.exception] },
    { title: "월별 실적", table: [["월", "평균 처리시간(일)"], ...c.months.map(([month, days]) => [month, `${days}일`])] },
  ]);
}
