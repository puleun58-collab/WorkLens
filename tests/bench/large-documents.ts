/**
 * Large-document benchmark. Manual only: never wired into lint, typecheck,
 * unit tests, E2E or CI, because a single case can hold gigabytes.
 *
 * Every case runs in its own child process, so a hard wall-clock timeout can
 * kill it outright and its memory is reclaimed before the next case starts.
 * Stages are timed separately, so a slow run can be attributed to parsing,
 * evidence building, retrieval or a deterministic operation. Nothing is
 * committed and nothing is uploaded: fixtures are generated in memory.
 *
 *   bun run bench:large    # low-load fixtures, the default sweep
 *   bun run bench:stress   # 50/75/100 MiB inputs, run deliberately
 */
import { strToU8, zipSync } from "fflate";
import type { NormalizedDocument } from "@/domain/document";
import { buildEvidenceNodes } from "@/lib/ai/grounding";
import { evidenceWindow } from "@/lib/ai/prompt";
import { selectEvidence } from "@/lib/ai/retrieval";
import { buildComparison } from "@/domain/compare";
import { analyzeDocument, checkDocument, extractDocument } from "@/lib/deterministic";
import { parseDocument } from "@/lib/parsers";
import { fileKindOf, validateUploadBytes } from "@/lib/upload";
import { createPdf, createXlsx, type SheetRow } from "../fixtures";

interface Stage { name: string; ms: number }

/**
 * Per-stage budget inside a case. Asynchronous stages are raced against a real
 * timer; synchronous ones cannot be interrupted mid-CPU, so they fail
 * immediately after they overrun and the parent's hard timeout is the backstop.
 */
const STAGE_BUDGET_MS = Number(process.env.WORKLENS_BENCH_STAGE_MS ?? 120_000);

/** Hard wall-clock ceiling per case, enforced by the parent with SIGKILL. */
const CASE_TIMEOUT_MS = Number(process.env.WORKLENS_BENCH_CASE_MS ?? 300_000);

/** A case that grows past this resident size is abandoned, not benchmarked. */
const MEMORY_BUDGET_MIB = Number(process.env.WORKLENS_BENCH_MEMORY_MIB ?? 2_048);

async function withTimeout<T>(name: string, work: Promise<T> | T, budgetMs: number): Promise<T> {
  if (!(work instanceof Promise)) return work;
  let timer: Timer | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} exceeded ${budgetMs}ms`)), budgetMs);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(timer);
  }
}

async function timed<T>(name: string, run: () => Promise<T> | T, stages: Stage[]): Promise<T> {
  const started = performance.now();
  const value = await withTimeout(name, run(), STAGE_BUDGET_MS);
  const ms = Math.round(performance.now() - started);
  stages.push({ name, ms });
  const rssMiB = Math.round((process.memoryUsage?.().rss ?? 0) / MiB);
  // Progress goes to stderr: stdout carries only the machine-read result line.
  console.error(`    ${name.padEnd(16)} ${String(ms).padStart(7)}ms  rss ${String(rssMiB).padStart(5)} MiB`);
  if (ms > STAGE_BUDGET_MS) throw new Error(`${name} exceeded ${STAGE_BUDGET_MS}ms (took ${ms}ms)`);
  if (rssMiB > MEMORY_BUDGET_MIB) throw new Error(`${name} exceeded ${MEMORY_BUDGET_MIB} MiB rss (used ${rssMiB} MiB)`);
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


function pptxParts(slides: number): Record<string, Uint8Array> {
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
  return files;
}

function docxParts(paragraphs: number): Record<string, Uint8Array> {
  const body = Array.from({ length: paragraphs }, (_, index) =>
    `<w:p><w:r><w:t>운영 항목 ${index + 1}: 2026-${String((index % 12) + 1).padStart(2, "0")}-15 기준 금액은 ${130000 + index}원입니다.</w:t></w:r></w:p>`).join("");
  return {
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
  };
}

interface Measurement {
  label: string;
  bytesMiB: number;
  stages: Stage[];
  blocks: number;
  evidence: number;
  rssDeltaMiB: number;
  admitted: boolean;
}

const MiB = 1024 * 1024;

/**
 * Incompressible padding entries stand in for the media that makes a real
 * 100 MiB deck or document large. They are stored, not deflated, so the
 * archive reaches the target size without tripping a ratio guard.
 */
function mediaPadding(targetBytes: number, chunks: number): Record<string, [Uint8Array, { level: 0 }]> {
  const files: Record<string, [Uint8Array, { level: 0 }]> = {};
  const size = Math.max(1, Math.floor(targetBytes / chunks));
  for (let index = 0; index < chunks; index += 1) {
    const blob = new Uint8Array(size);
    crypto.getRandomValues(blob.subarray(0, Math.min(size, 65_536)));
    for (let offset = 65_536; offset < size; offset += 65_536) {
      blob.copyWithin(offset, 0, Math.min(65_536, size - offset));
      blob[offset] = index & 0xff;
    }
    files[`media/image${index + 1}.bin`] = [blob, { level: 0 }];
  }
  return files;
}

function wideCsv(targetBytes: number, rows: number): Uint8Array {
  const columns = Math.max(4, Math.round(targetBytes / rows / 24));
  const header = ["지역", "날짜", "금액", "코드", ...Array.from({ length: columns - 4 }, (_, index) => `항목${index + 1}`)];
  const lines = [header.join(",")];
  for (let row = 0; row < rows; row += 1) {
    const cells = [
      ["서울", "부산", "대구", "인천"][row % 4],
      `2026-${String((row % 12) + 1).padStart(2, "0")}-15`,
      String(120_000 + row),
      `WL-${row}`,
      ...Array.from({ length: columns - 4 }, (_, index) => `${row}-${index}-운영항목값`),
    ];
    lines.push(cells.join(","));
  }
  return new TextEncoder().encode(lines.join("\r\n"));
}

async function measure(label: string, bytes: Uint8Array, fileName: string): Promise<Measurement> {
  const stages: Stage[] = [];
  const before = process.memoryUsage?.().rss ?? 0;
  const kind = fileKindOf(fileName);
  let admitted = true;
  try {
    validateUploadBytes(kind, bytes);
  } catch {
    admitted = false;
  }
  const document = await timed("parse", () => parseDocument({ fileId: `bench-${label}`, fileName, bytes }), stages);
  const nodes = await timed("evidence", () => buildEvidenceNodes([document]), stages);
  await timed("retrieval(ask)", () => evidenceWindow(selectEvidence(nodes, { operation: "ask", question: "8월 서울 금액은 얼마인가요?" })), stages);
  await timed("retrieval(analyze)", () => evidenceWindow(selectEvidence(nodes, { operation: "analyze" })), stages);
  await timed("analyze", () => analyzeDocument(document), stages);
  await timed("check", () => checkDocument(document, { userTerms: [], companyTerms: [] }), stages);
  await timed("extract", () => extractDocument(document), stages);
  const after = process.memoryUsage?.().rss ?? 0;
  return {
    label,
    bytesMiB: Math.round((bytes.byteLength / MiB) * 10) / 10,
    stages,
    blocks: document.blocks.length,
    evidence: nodes.length,
    rssDeltaMiB: Math.round((after - before) / MiB),
    admitted,
  };
}

/** A fixture is only built when its case runs: 100 MiB inputs are expensive. */
interface BenchCase {
  label: string;
  fileName: string;
  build: () => Promise<Uint8Array> | Uint8Array;
}

/** Low-load sweep: shapes real documents have, sizes a laptop shrugs off. */
function baseCases(): BenchCase[] {
  return [
    { label: "csv-20k-rows", fileName: "대용량로그.csv", build: () => wideCsv(2 * MiB, 20_000) },
    { label: "xlsx-20k-cells", fileName: "대용량실적.xlsx", build: () => createXlsx(bigWorkbook(2_000, 3)) },
    {
      label: "pdf-120-pages",
      fileName: "대용량보고서.pdf",
      build: () => createPdf(Array.from({ length: 120 }, (_, index) => `Page ${index + 1}: operational summary with amount ${130000 + index} and date 2026-0${(index % 9) + 1}-15.`)),
    },
    { label: "pptx-120-slides", fileName: "대용량발표.pptx", build: () => zipSync(pptxParts(120)) },
    { label: "docx-3k-para", fileName: "대용량문서.docx", build: () => zipSync(docxParts(3_000)) },
  ];
}

/**
 * Ceiling cases, addressed individually by format and size. Nothing here runs
 * unless it is asked for by name: one 100 MiB case can hold several GiB of
 * transient memory while its fixture is built.
 */
const STRESS_FORMATS = ["csv", "xlsx", "pdf", "pptx", "docx"] as const;
const STRESS_SIZES = [50, 75, 100] as const;

type StressFormat = (typeof STRESS_FORMATS)[number];

function stressCase(format: StressFormat, size: number): BenchCase {
  const label = `${format}-${size}mib`;
  switch (format) {
    case "csv":
      return { label, fileName: `대용량로그-${size}.csv`, build: () => wideCsv(size * MiB, 90_000) };
    case "xlsx":
      // ExcelJS writes a compressed workbook, so rows — not bytes — are the
      // dial; each step tracks the byte target it stands in for.
      return { label, fileName: `대용량실적-${size}.xlsx`, build: () => createXlsx(bigWorkbook(size * 1_000, 1)) };
    case "pdf":
      return {
        label,
        fileName: `대용량보고서-${size}.pdf`,
        build: () => createPdf(Array.from({ length: size * 10 }, (_, index) => `Page ${index + 1}: operational summary with amount ${130000 + index} and date 2026-0${(index % 9) + 1}-15.`)),
      };
    case "pptx":
      return {
        label,
        fileName: `대용량발표-${size}.pptx`,
        build: () => zipSync({ ...pptxParts(200), ...mediaPadding(size * MiB, 40) }),
      };
    case "docx":
      return {
        label,
        fileName: `대용량문서-${size}.docx`,
        build: () => zipSync({ ...docxParts(20_000), ...mediaPadding(size * MiB, 40) }),
      };
  }
}

export interface StressSelection {
  cases: BenchCase[];
  /** What the caller asked for, echoed in the run header. */
  description: string;
  usage?: undefined;
}

export interface StressUsage {
  usage: string;
  cases?: undefined;
}

/**
 * Parses the stress CLI. The default is deliberately not a sweep: with no
 * arguments the caller gets usage text and nothing runs, so a mistyped
 * command cannot start a multi-gigabyte run on a small machine.
 */
export function selectStressCases(argv: readonly string[]): StressSelection | StressUsage {
  const value = (name: string): string | undefined => {
    const inline = argv.find((entry) => entry.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const all = argv.includes("--all");
  const format = value("format");
  const size = value("size");

  if (!all && !format && !size) {
    return {
      usage: [
        "bench:stress runs ceiling cases one at a time. Pick a format and a size:",
        "",
        `  bun run bench:stress -- --format=${STRESS_FORMATS.join("|")} --size=${STRESS_SIZES.join("|")}`,
        "  bun run bench:stress -- --all      # every format at every size (slow, memory heavy)",
        "",
        `Budgets: case ${CASE_TIMEOUT_MS}ms · rss ${MEMORY_BUDGET_MIB} MiB (WORKLENS_BENCH_CASE_MS, WORKLENS_BENCH_MEMORY_MIB)`,
      ].join("\n"),
    };
  }

  const formats = all || !format
    ? [...STRESS_FORMATS]
    : format.split(",").map((entry) => entry.trim()).filter((entry): entry is StressFormat =>
      (STRESS_FORMATS as readonly string[]).includes(entry));
  const sizes = all || !size
    ? [...STRESS_SIZES]
    : size.split(",").map((entry) => Number(entry.trim())).filter((entry) => (STRESS_SIZES as readonly number[]).includes(entry));
  if (formats.length === 0) return { usage: `unknown --format; expected one of ${STRESS_FORMATS.join(", ")}` };
  if (sizes.length === 0) return { usage: `unknown --size; expected one of ${STRESS_SIZES.join(", ")}` };

  const cases: BenchCase[] = [];
  for (const entry of formats) for (const bytes of sizes) cases.push(stressCase(entry, bytes));
  return { cases, description: `format=${formats.join(",")} size=${sizes.join(",")}MiB` };
}

const RESULT_PREFIX = "RESULT ";

/** Child role: build and measure exactly one case, then hand back the row. */
async function runOneCase(label: string, cases: BenchCase[]): Promise<void> {
  const benchCase = cases.find((entry) => entry.label === label);
  if (!benchCase) throw new Error(`unknown case ${label}`);
  console.error(`[stress] ${label} fixture build started`);
  const buildStarted = performance.now();
  const bytes = await withTimeout(`${label} build`, benchCase.build(), STAGE_BUDGET_MS);
  const rssMiB = Math.round((process.memoryUsage?.().rss ?? 0) / MiB);
  console.error(`    fixture          ${String(Math.round(performance.now() - buildStarted)).padStart(7)}ms  ${Math.round((bytes.byteLength / MiB) * 10) / 10} MiB  rss ${rssMiB} MiB`);
  // Building the input alone can exhaust the budget. Stop here rather than
  // entering a parse that would push the machine into swap.
  if (rssMiB > MEMORY_BUDGET_MIB) {
    throw new Error(`${label} fixture build exceeded ${MEMORY_BUDGET_MIB} MiB rss (used ${rssMiB} MiB)`);
  }
  const row = await measure(label, bytes, benchCase.fileName);
  console.info(`${RESULT_PREFIX}${JSON.stringify(row)}`);
}

/** Child role: the one comparison case, which needs two parsed documents. */
async function runCompareCase(): Promise<void> {
  const stages: Stage[] = [];
  const base = await parseDocument({ fileId: "bench-compare-a", fileName: "a.xlsx", bytes: await createXlsx(bigWorkbook(1_000, 1)) });
  const target = await parseDocument({ fileId: "bench-compare-b", fileName: "b.xlsx", bytes: await createXlsx(bigWorkbook(1_000, 1)) });
  await timed("compare", () => buildComparison(base as NormalizedDocument, target as NormalizedDocument), stages);
  const row: Measurement = {
    label: "compare-2x1000-rows",
    bytesMiB: 0,
    stages,
    blocks: base.blocks.length + target.blocks.length,
    evidence: 0,
    rssDeltaMiB: 0,
    admitted: true,
  };
  console.info(`${RESULT_PREFIX}${JSON.stringify(row)}`);
}

/**
 * Parent role: one child per case. A child that outlives its budget is killed,
 * not awaited, and a child that dies takes its memory with it.
 */
async function runCaseInChild(label: string, stressArgs: readonly string[]): Promise<Measurement | undefined> {
  const child = Bun.spawn({
    cmd: [process.execPath, import.meta.path, "--case", label, ...stressArgs],
    stdout: "pipe",
    stderr: "inherit",
    env: process.env,
  });
  const killer = setTimeout(() => child.kill("SIGKILL"), CASE_TIMEOUT_MS);
  let stdout = "";
  try {
    stdout = await new Response(child.stdout).text();
    await child.exited;
  } finally {
    clearTimeout(killer);
  }
  if (child.exitCode !== 0) {
    console.error(`    ${label} aborted (exit ${child.exitCode ?? "killed"}, hard timeout ${CASE_TIMEOUT_MS}ms)`);
    return undefined;
  }
  const line = stdout.split("\n").find((entry) => entry.startsWith(RESULT_PREFIX));
  if (!line) {
    console.error(`    ${label} produced no measurement`);
    return undefined;
  }
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as Measurement;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const stress = argv.includes("--stress");
  let cases = baseCases();
  let stressArgs: string[] = [];
  if (stress) {
    const selection = selectStressCases(argv);
    if (selection.usage !== undefined) {
      console.info(selection.usage);
      return;
    }
    cases = selection.cases;
    // The child re-derives the same selection from the same flags.
    stressArgs = argv.filter((entry, index) => entry !== "--case" && argv[index - 1] !== "--case");
    console.info(`[stress] ${selection.description} · ${cases.length} case(s)`);
  }

  const caseFlag = argv.indexOf("--case");
  if (caseFlag >= 0) {
    const label = argv[caseFlag + 1];
    if (label === "compare") await runCompareCase();
    else await runOneCase(label, cases);
    return;
  }

  const labels = [...cases.map((entry) => entry.label), ...(stress ? [] : ["compare"])];
  console.info(`bench ${stress ? "stress" : "large"}: ${labels.length} cases · stage ${STAGE_BUDGET_MS}ms · case ${CASE_TIMEOUT_MS}ms · rss ${MEMORY_BUDGET_MIB} MiB`);
  const rows: Measurement[] = [];
  let aborted = 0;
  for (const [index, label] of labels.entries()) {
    console.info(`[${index + 1}/${labels.length}] ${label}`);
    const row = await runCaseInChild(label, stressArgs);
    if (row) rows.push(row);
    else aborted += 1;
  }

  console.info("");
  for (const row of rows) {
    const timings = row.stages.map((stage) => `${stage.name} ${stage.ms}ms`).join(" · ");
    console.info(`${row.label.padEnd(26)} ${String(row.bytesMiB).padStart(6)} MiB  admitted ${row.admitted ? "yes" : "no "}  blocks ${String(row.blocks).padStart(6)}  evidence ${String(row.evidence).padStart(6)}  rssΔ ${String(row.rssDeltaMiB).padStart(4)} MiB  ${timings}`);
  }
  if (aborted > 0) console.info(`${aborted} case(s) aborted on timeout or memory budget`);
}

// Importable for unit tests: the sweep only runs when this file is the entry
// point. pdf-lib and ExcelJS leave timers behind, so the run exits explicitly.
if (import.meta.main) {
  await main();
  process.exit(0);
}
