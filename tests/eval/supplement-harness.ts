import ExcelJS from "exceljs";
import { strToU8, unzipSync, zipSync } from "fflate";
import type { NormalizedDocument } from "@/domain/document";
import type { SupplementDraft, SupplementFinding, SupplementResult } from "@/domain/supplement";
import { parseDocument } from "@/lib/parsers";
import { buildSupplementDraft } from "@/lib/supplement/engine";
import { finalizeSupplement, type SupplementReviewOutcome } from "@/lib/supplement/finalize";
import { normalize } from "@/lib/supplement/text";
import { createPptxSlides, createUnicodePdf } from "../fixtures";
import type { EvalFile, Expected, SupplementEvalCase } from "./supplement-cases";
import { createSupplementDiagnostics } from "@/lib/supplement/diagnostics";

/** Failure kinds, most serious first. */
export type EvalFailureKind =
  | "unsupported-claim"
  | "wrong-linking"
  | "coverage"
  | "false-positive"
  | "false-negative"
  | "duplicate"
  | "over-suggestion"
  | "zero-result"
  | "classification";

export const FAILURE_SEVERITY: Record<EvalFailureKind, "critical" | "major" | "minor"> = {
  "unsupported-claim": "critical",
  "wrong-linking": "critical",
  coverage: "critical",
  "zero-result": "critical",
  "false-positive": "major",
  "false-negative": "major",
  classification: "major",
  duplicate: "minor",
  "over-suggestion": "minor",
};

/** Pipeline stage the failure points at, so repeated root causes show up. */
export type EvalStage = "parsing" | "classification" | "candidate" | "rebuttal" | "linking" | "deduplication" | "generation" | "coverage";

export interface EvalFailure { kind: EvalFailureKind; stage: EvalStage; detail: string }

export interface EvalOutcome {
  id: string;
  category: SupplementEvalCase["category"];
  passed: boolean;
  failures: EvalFailure[];
  truePositives: number;
  reported: number;
  expected: number;
  modelCalls: number;
  systemAffected: boolean;
  findings: Array<Pick<SupplementFinding, "check" | "scope" | "severity" | "status"> & { at: string }>;
}

/** Answers every re-check request; the offline run abstains (returns nothing). */
export type ReviewModel = (batch: SupplementDraft["reviews"][number]) => Promise<Array<{ id: string; verdict: "found" | "not_found" | "unclear"; handles: string[] }>>;

const xml = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

function docxBytes(body: NonNullable<EvalFile["docx"]>): Uint8Array {
  const paragraph = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t>${xml(text)}</w:t></w:r></w:p>`;
  const parts = body.map((entry) => typeof entry === "string" ? paragraph(entry)
    : "heading" in entry ? paragraph(entry.heading, `Heading${entry.level ?? 1}`)
      : `<w:tbl>${entry.table.map((row) => `<w:tr>${row.map((cell) => `<w:tc>${paragraph(cell)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`);
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${parts.join("")}</w:body></w:document>`),
  });
}

export async function bytesOf(file: EvalFile): Promise<Uint8Array> {
  if (file.slides) {
    const bytes = createPptxSlides(file.slides);
    if (!file.chart) return bytes;
    const parts = unzipSync(bytes);
    parts["ppt/charts/chart1.xml"] = strToU8("<c:chartSpace/>");
    return zipSync(parts);
  }
  if (file.docx) return docxBytes(file.docx);
  if (file.pages) return createUnicodePdf(file.pages.map((page) => page.map((text, index) => ({ text, size: index === 0 ? 16 : 11 }))));
  const workbook = new ExcelJS.Workbook();
  for (const spec of file.sheets ?? []) {
    const sheet = workbook.addWorksheet(spec.name, spec.hidden ? { state: "hidden" } : {});
    for (const values of spec.rows) {
      const row = sheet.addRow(values);
      for (const column of spec.percent ?? []) if (typeof row.getCell(column).value === "number") row.getCell(column).numFmt = "0.0%";
    }
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer);
}

export async function loadCase(entry: SupplementEvalCase): Promise<NormalizedDocument[]> {
  return Promise.all(entry.files.map(async (file) => parseDocument({ fileId: `${entry.id}:${file.name}`, fileName: file.name, bytes: await bytesOf(file) })));
}

/** Every text the documents contain, for checking that quotes and numbers are real. */
function corpus(documents: readonly NormalizedDocument[]): string {
  const parts: string[] = [];
  for (const document of documents) {
    parts.push(document.metadata.fileName);
    for (const block of document.blocks) {
      if (block.type === "paragraph") parts.push(block.text);
      else for (const row of block.rows) for (const cell of row) parts.push(cell.display);
    }
    for (const sheet of document.workbookSheets ?? []) {
      parts.push(sheet.name);
      for (const row of sheet.table.rows) for (const cell of row) parts.push(cell.display);
    }
  }
  return normalize(parts.join(" "));
}

/** A location names a file of the case and a slide, page or sheet that exists in it. */
function locationExists(location: string, documents: readonly NormalizedDocument[], multi: boolean): boolean {
  const [file, ...rest] = multi ? location.split(" / ") : [undefined, ...location.split(" / ")];
  const candidates = multi ? documents.filter((document) => document.metadata.fileName === file) : documents;
  if (candidates.length === 0) return false;
  const place = rest.join(" / ");
  return candidates.some((document) => {
    const slide = /^(\d+)P$/u.exec(place);
    if (slide) return document.kind === "pptx" && Number(slide[1]) <= (document.metadata.pageCount ?? 0);
    const page = /^(\d+)페이지$/u.exec(place);
    if (page) return document.kind === "pdf" && Number(page[1]) <= (document.metadata.pageCount ?? 0);
    if (document.kind === "docx") {
      // Section path, table number or paragraph number — each must exist in the document.
      const text = normalize(document.blocks.map((block) => block.type === "paragraph" ? block.text : "").join(" "));
      const tables = document.blocks.filter((block) => block.type === "table").length;
      return place.split(/\s(?:>|·)\s/u).every((piece) => {
        const table = /^표 (\d+)$/u.exec(piece);
        if (table) return Number(table[1]) <= tables;
        const block = /^문단 (\d+)$/u.exec(piece);
        if (block) return Number(block[1]) <= document.blocks.length;
        return text.includes(piece.replace(/…$/u, ""));
      });
    }
    const sheet = place.split(" / ")[0];
    return document.kind === "xlsx" && (document.metadata.sheets ?? []).some((entry) => entry.name === sheet);
  });
}

function matches(finding: SupplementFinding, expected: Expected): boolean {
  return finding.check === expected.check
    && (expected.scope === undefined || finding.scope === expected.scope)
    && (expected.status === undefined || finding.status === expected.status)
    && (expected.at === undefined || finding.locations.some((location) => location.includes(expected.at!)));
}

export async function runSupplementCase(entry: SupplementEvalCase, model?: ReviewModel): Promise<EvalOutcome & { result: SupplementResult; draft: SupplementDraft }> {
  const documents = await loadCase(entry);
  const diagnostics = createSupplementDiagnostics();
  const draft = buildSupplementDraft(documents.map((document) => ({ document, fileName: document.metadata.fileName })), diagnostics);
  const outcomes = new Map<string, SupplementReviewOutcome>();
  let modelCalls = 0;
  if (model) {
    for (const batch of draft.reviews) {
      modelCalls += 1;
      try {
        for (const answer of await model(batch)) {
          const check = batch.checks.find((item) => item.id === answer.id);
          if (check) outcomes.set(check.candidateId, { verdict: answer.verdict, sources: answer.handles.map((handle) => batch.sources[handle]).filter(Boolean) });
        }
      } catch {
        diagnostics.systemAffected = true;
      }
    }
  }
  const result = finalizeSupplement(draft, outcomes, diagnostics);
  const multi = documents.length > 1;
  const text = corpus(documents);
  const failures: EvalFailure[] = [];
  const shown = result.findings.filter((finding) => finding.severity !== "suggestion");
  // Without the model, meaning-dependent outcomes are not judged; critical checks still are.
  const judged = (!entry.needsModel || model !== undefined) && !(model && diagnostics.systemAffected);

  // Critical: every location, quote and number must come from the files.
  for (const finding of result.findings) {
    for (const location of [...finding.locations, ...(finding.evidenceLocations ?? [])]) {
      if (!locationExists(location, documents, multi)) failures.push({ kind: "unsupported-claim", stage: "generation", detail: `${finding.title}: 없는 위치 ${location}` });
    }
    const quotes = [finding.current, ...(finding.scope === "report" ? finding.additions : [])].map((quote) => normalize(quote.replace(/…$/u, "")));
    // A worksheet row is shown as "label · header value · …": every word of it must exist in the files.
    const supported = (quote: string) => text.includes(quote) || quote.split(/\s·\s|\s+/u).every((word) => !word || text.includes(word));
    for (const quote of quotes) if (quote && !supported(quote)) failures.push({ kind: "unsupported-claim", stage: "generation", detail: `${finding.title}: 자료에 없는 인용 "${quote}"` });
    for (const number of `${finding.message} ${finding.question ?? ""}`.match(/\d+(?:\.\d+)?/gu) ?? []) {
      if (!text.includes(number)) failures.push({ kind: "unsupported-claim", stage: "generation", detail: `${finding.title}: 자료에 없는 숫자 ${number}` });
    }
  }

  // Critical: evidence only from the allowed file, never from the forbidden one.
  const linked = result.findings.flatMap((finding) => finding.evidenceLocations ?? []);
  if (entry.neverLinkFrom && linked.some((location) => location.startsWith(entry.neverLinkFrom!))) {
    failures.push({ kind: "wrong-linking", stage: "linking", detail: `${entry.neverLinkFrom}를 근거로 연결` });
  }
  if (judged && entry.linkFrom && !linked.some((location) => location.startsWith(entry.linkFrom!))) {
    failures.push({ kind: "false-negative", stage: "linking", detail: `${entry.linkFrom} 근거 연결 없음` });
  }

  // Critical: the coverage shown must be the coverage that happened.
  for (const [index, expected] of (entry.coverage ?? []).entries()) {
    const actual = result.coverage[index];
    if (!actual || actual.total !== expected.total || (expected.analyzed !== undefined && actual.analyzed !== expected.analyzed) || actual.complete !== expected.complete) {
      failures.push({ kind: "coverage", stage: "coverage", detail: `범위 ${JSON.stringify(expected)} ≠ ${JSON.stringify(actual && { total: actual.total, analyzed: actual.analyzed, complete: actual.complete })}` });
    }
  }
  for (const coverage of result.coverage) {
    if (coverage.sheets && coverage.sheets.length !== coverage.total) failures.push({ kind: "coverage", stage: "coverage", detail: `${coverage.fileName}: 시트 목록 ${coverage.sheets.length} ≠ ${coverage.total}` });
  }

  if (entry.roles) {
    const roles = result.files.map((file) => file.role);
    if (roles.join() !== entry.roles.join()) failures.push({ kind: "classification", stage: "classification", detail: `역할 ${roles.join()} ≠ ${entry.roles.join()}` });
  }
  if (entry.docTypes && result.files.some((file, index) => file.docType !== entry.docTypes![index])) failures.push({ kind: "classification", stage: "classification", detail: `유형 ${result.files.map((file) => file.docType).join()} ≠ ${entry.docTypes.join()}` });
  if (judged && (entry.must?.length ?? 0) > 0 && result.findings.length === 0) failures.push({ kind: "zero-result", stage: draft.candidates.length ? "rebuttal" : "candidate", detail: "Must-Find가 있는 문서의 최종 결과 0건" });

  let truePositives = 0;
  if (judged) {
    for (const expected of entry.must ?? []) {
      if (shown.some((finding) => matches(finding, expected))) truePositives += 1;
      else {
        const candidate = draft.candidates.some((item) => item.check === expected.check);
        failures.push({ kind: "false-negative", stage: candidate ? "rebuttal" : "candidate", detail: `미탐지 ${JSON.stringify(expected)}` });
      }
    }
    const allowed = (finding: SupplementFinding) => (entry.allowed ?? []).some((expected) => matches(finding, expected))
      || (entry.must ?? []).some((expected) => matches(finding, expected));
    for (const finding of shown) {
      const banned = entry.quiet || (entry.mustNot ?? []).some((expected) => matches(finding, expected));
      if (banned && !allowed(finding)) failures.push({ kind: "false-positive", stage: "rebuttal", detail: `오탐 ${finding.check}/${finding.scope} @${finding.locations.join(",")}` });
    }
    if (entry.quiet) {
      for (const finding of result.findings.filter((item) => item.severity === "suggestion")) {
        failures.push({ kind: "over-suggestion", stage: "candidate", detail: `참고 ${finding.check} @${finding.locations.join(",")}` });
      }
    }
    // A displayed section/table can contain different rows or paragraphs with independent gaps.
    const keys = shown.map(finding => `${finding.check}:${finding.scope}:${finding.sources.map(source => `${source.fileId}:${source.nodeId}`).sort().join("|")}`);
    for (const key of new Set(keys)) if (keys.filter((item) => item === key).length > 1) failures.push({ kind: "duplicate", stage: "deduplication", detail: key });
  }

  return {
    id: entry.id,
    category: entry.category,
    passed: failures.every((failure) => FAILURE_SEVERITY[failure.kind] === "minor"),
    failures,
    truePositives,
    reported: shown.length,
    expected: judged ? (entry.must ?? []).length : 0,
    modelCalls,
    systemAffected: Boolean(model && diagnostics.systemAffected),
    findings: result.findings.map((finding) => ({ check: finding.check, scope: finding.scope, severity: finding.severity, status: finding.status, at: finding.locations[0] ?? "" })),
    result,
    draft,
  };
}

export interface EvalSummary {
  cases: number;
  passed: number;
  failed: number;
  /** Reported 중요/확인 필요 findings that match an expectation, over all reported in judged cases. */
  precision: number;
  /** Expected findings that were reported. */
  recall: number;
  byKind: Record<EvalFailureKind, number>;
  byStage: Partial<Record<EvalStage, number>>;
  modelCalls: number;
  systemAffected: number;
  failures: Array<{ id: string; kind: EvalFailureKind; stage: EvalStage; detail: string }>;
}

export function summarize(outcomes: readonly EvalOutcome[]): EvalSummary {
  const byKind = Object.fromEntries(Object.keys(FAILURE_SEVERITY).map((kind) => [kind, 0])) as Record<EvalFailureKind, number>;
  const byStage: Partial<Record<EvalStage, number>> = {};
  const failures: EvalSummary["failures"] = [];
  for (const outcome of outcomes) {
    for (const failure of outcome.failures) {
      byKind[failure.kind] += 1;
      byStage[failure.stage] = (byStage[failure.stage] ?? 0) + 1;
      failures.push({ id: outcome.id, ...failure });
    }
  }
  const falsePositives = byKind["false-positive"];
  const tp = outcomes.reduce((sum, outcome) => sum + outcome.truePositives, 0);
  const expected = outcomes.reduce((sum, outcome) => sum + outcome.expected, 0);
  return {
    cases: outcomes.length,
    passed: outcomes.filter((outcome) => outcome.passed).length,
    failed: outcomes.filter((outcome) => !outcome.passed).length,
    precision: tp + falsePositives === 0 ? 100 : Math.round((tp / (tp + falsePositives)) * 1000) / 10,
    recall: expected === 0 ? 100 : Math.round((tp / expected) * 1000) / 10,
    byKind,
    byStage,
    modelCalls: outcomes.reduce((sum, outcome) => sum + outcome.modelCalls, 0),
    systemAffected: outcomes.filter((outcome) => outcome.systemAffected).length,
    failures,
  };
}

export function formatSummary(title: string, summary: EvalSummary): string {
  const kinds = Object.entries(summary.byKind).filter(([, count]) => count > 0).map(([kind, count]) => `${kind} ${count}`).join(", ") || "없음";
  return [
    `## ${title}`,
    `총 ${summary.cases} Case · Pass ${summary.passed} · Fail ${summary.failed}`,
    `Precision ${summary.precision}% · Recall ${summary.recall}% · 모델 호출 ${summary.modelCalls}회`,
    `오류 유형: ${kinds}`,
    ...summary.failures.map((failure) => `- ${failure.id} [${FAILURE_SEVERITY[failure.kind]}/${failure.kind}/${failure.stage}] ${failure.detail}`),
  ].join("\n");
}
