/**
 * Large-document benchmark.
 *
 * Generates documents near the practical upload ceiling, then times each stage
 * separately so a slow run can be attributed to parsing, evidence building,
 * retrieval or a deterministic operation. Nothing is committed to the
 * repository and nothing is uploaded: fixtures are generated in memory.
 *
 *   bun run bench:large
 */
import { strToU8, zipSync } from "fflate";
import type { NormalizedDocument } from "@/domain/document";
import { buildEvidenceNodes } from "@/lib/ai/grounding";
import { evidenceWindow } from "@/lib/ai/prompt";
import { selectEvidence } from "@/lib/ai/retrieval";
import { buildComparison } from "@/domain/compare";
import { analyzeDocument, checkDocument, extractDocument } from "@/lib/deterministic";
import { parseDocument } from "@/lib/parsers";
import { createPdf, createXlsx, type SheetRow } from "../fixtures";

interface Stage { name: string; ms: number }

async function timed<T>(name: string, run: () => Promise<T> | T, stages: Stage[]): Promise<T> {
  const started = performance.now();
  const value = await run();
  stages.push({ name, ms: Math.round(performance.now() - started) });
  return value;
}

function bigWorkbook(rows: number, sheets: number): Record<string, SheetRow[]> {
  const workbook: Record<string, SheetRow[]> = {};
  for (let sheet = 0; sheet < sheets; sheet += 1) {
    const data: SheetRow[] = [["월", "지역", "금액", "코드"]];
    for (let row = 0; row < rows; row += 1) {
      data.push([`${(row % 12) + 1}월`, ["서울", "부산", "대구", "인천"][row % 4], 100000 + row, `WL-${sheet}-${row}`]);
    }
    workbook[`시트${sheet + 1}`] = data;
  }
  return workbook;
}

function bigCsv(rows: number): Uint8Array {
  const lines = ["지역,날짜,금액,코드"];
  for (let row = 0; row < rows; row += 1) {
    lines.push(`${["서울", "부산", "대구", "인천"][row % 4]},2026-${String((row % 12) + 1).padStart(2, "0")}-15,${120000 + row},WL-${row}`);
  }
  return new TextEncoder().encode(lines.join("\r\n"));
}

function bigPptx(slides: number): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${Array.from({ length: slides }, (_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`,
    ),
    "ppt/presentation.xml": strToU8(
      `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${Array.from({ length: slides }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: slides }, (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join("")}</Relationships>`,
    ),
  };
  for (let index = 0; index < slides; index += 1) {
    files[`ppt/slides/slide${index + 1}.xml`] = strToU8(
      `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>운영 현황 ${index + 1}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>주간 배송 건수는 ${1200 + index}건이고 매출은 ${150000 + index * 37}원입니다.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
  }
  return zipSync(files);
}

function bigDocx(paragraphs: number): Uint8Array {
  const body = Array.from({ length: paragraphs }, (_, index) =>
    `<w:p><w:r><w:t>운영 항목 ${index + 1}: 2026-${String((index % 12) + 1).padStart(2, "0")}-15 기준 금액은 ${130000 + index}원입니다.</w:t></w:r></w:p>`).join("");
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
  });
}

interface Measurement {
  label: string;
  bytesKiB: number;
  stages: Stage[];
  blocks: number;
  evidence: number;
}

async function measure(label: string, bytes: Uint8Array, fileName: string): Promise<Measurement> {
  const stages: Stage[] = [];
  const document = await timed("parse", () => parseDocument({ fileId: `bench-${label}`, fileName, bytes }), stages);
  const nodes = await timed("evidence", () => buildEvidenceNodes([document]), stages);
  await timed("retrieval(ask)", () => evidenceWindow(selectEvidence(nodes, { operation: "ask", question: "8월 서울 금액은 얼마인가요?" })), stages);
  await timed("retrieval(brief)", () => evidenceWindow(selectEvidence(nodes, { operation: "brief" })), stages);
  await timed("analyze", () => analyzeDocument(document), stages);
  await timed("check", () => checkDocument(document, { userTerms: [], companyTerms: [] }), stages);
  await timed("extract", () => extractDocument(document), stages);
  return { label, bytesKiB: Math.round(bytes.byteLength / 1024), stages, blocks: document.blocks.length, evidence: nodes.length };
}

async function main(): Promise<void> {
  const rows: Measurement[] = [];
  rows.push(await measure("xlsx-20k-cells", await createXlsx(bigWorkbook(2_000, 3)), "대용량실적.xlsx"));
  rows.push(await measure("csv-20k-rows", bigCsv(20_000), "대용량로그.csv"));
  rows.push(await measure("pdf-120-pages", await createPdf(Array.from({ length: 120 }, (_, index) => `Page ${index + 1}: operational summary with amount ${130000 + index} and date 2026-0${(index % 9) + 1}-15.`)), "대용량보고서.pdf"));
  rows.push(await measure("pptx-120-slides", bigPptx(120), "대용량발표.pptx"));
  rows.push(await measure("docx-3k-paragraphs", bigDocx(3_000), "대용량문서.docx"));

  const compareStages: Stage[] = [];
  const base = await parseDocument({ fileId: "bench-compare-a", fileName: "a.xlsx", bytes: await createXlsx(bigWorkbook(1_000, 1)) });
  const target = await parseDocument({ fileId: "bench-compare-b", fileName: "b.xlsx", bytes: await createXlsx(bigWorkbook(1_000, 1)) });
  await timed("compare", () => buildComparison(base as NormalizedDocument, target as NormalizedDocument), compareStages);

  for (const row of rows) {
    const timings = row.stages.map((stage) => `${stage.name} ${stage.ms}ms`).join(" · ");
    console.info(`${row.label.padEnd(20)} ${String(row.bytesKiB).padStart(6)} KiB  blocks ${String(row.blocks).padStart(5)}  evidence ${String(row.evidence).padStart(5)}  ${timings}`);
  }
  console.info(`compare(2 × 1000 rows)  ${compareStages[0].ms}ms`);
  const memory = process.memoryUsage?.();
  if (memory) console.info(`heapUsed ${Math.round(memory.heapUsed / 1024 / 1024)} MiB  rss ${Math.round(memory.rss / 1024 / 1024)} MiB`);
}

await main();
