import type { NormalizedDocument, SourceRef, TableCell, WorkbookSheet } from "@/domain/document";
import type { SupplementCoverage, SupplementSheetCoverage, SupplementSheetStatus } from "@/domain/supplement";
import { BENEFIT_LIKE, contentTokens, COST_LIKE, normalize } from "./text";
import type { Change, Statement } from "./engine";

/**
 * Workbook outline for 보완. Structure is read for every sheet (the
 * manifest); gap analysis only reads report areas. Raw data, lookup, config,
 * archive and hidden sheets are searched as evidence but never produce a
 * gap of their own, and no sheet leaves without a status.
 */

/** Report sheets are read up to this many rows; beyond it the sheet is 제한 분석. */
export const WORKBOOK_ANALYSIS_ROWS = 300;
/** Evidence sheets contribute at most this many text rows to the document-wide search. */
const REFERENCE_ROWS = 5_000;

type SheetRole = "summary" | "analysis" | "raw" | "lookup" | "config" | "archive" | "other";

const ROLE_LABELS: Record<SheetRole, string> = {
  summary: "요약·보고",
  analysis: "분석",
  raw: "원천 데이터",
  lookup: "참조·매핑",
  config: "설정",
  archive: "보관·이력",
  other: "기타",
};

const ROLE_NAMES: Array<[Exclude<SheetRole, "other">, RegExp]> = [
  ["archive", /(archive|history|이력|과거|old|backup|백업|보관)/iu],
  ["config", /(config|설정|param|옵션|setting)/iu],
  ["lookup", /(lookup|mapping|매핑|코드표|code|master|기준정보|참조)/iu],
  ["raw", /(raw|원본|로우|data$|데이터$|내역|명세|log|db|dump)/iu],
  ["analysis", /(분석|analysis|원인|요인|detail|세부|breakdown)/iu],
  ["summary", /(summary|요약|총괄|대시보드|dashboard|kpi|보고|현황|결과|result|실적|report)/iu],
];

export interface SheetRow {
  label: string;
  cells: TableCell[];
  source: SourceRef;
  statement: Statement;
}

export interface SheetTable {
  sheet: string;
  sheetIndex: number;
  /** Title rows above the header, e.g. "2026년 9월 물류비 현황 (단위: 백만원)". */
  title: string;
  /** One label per column; stacked header rows are joined, merged parents carried right. */
  headers: string[];
  rows: SheetRow[];
  range: string;
  source: SourceRef;
  /** On a sheet whose role is a report summary (요약·보고). */
  summary: boolean;
}

export interface WorkbookOutline {
  statements: Statement[];
  references: Statement[];
  tables: SheetTable[];
  coverage: SupplementCoverage;
}

const text = (cell: TableCell | undefined): string => normalize(cell?.display ?? "");
const isNumeric = (cell: TableCell): boolean => typeof cell.value === "number" || (cell.valueType === "formula" && typeof cell.value === "number");
const isText = (cell: TableCell): boolean => !isNumeric(cell) && text(cell).length > 0;

function roleOf(sheet: WorkbookSheet, filled: number, numericShare: number): SheetRole {
  const byName = ROLE_NAMES.find(([, pattern]) => pattern.test(sheet.name))?.[0];
  const rows = sheet.table.rows.length;
  // Content can override a generic name: a long, number-dense table is raw data.
  if (byName === undefined || byName === "summary") {
    if (rows > 1_000 && numericShare > 0.4 && byName !== "summary") return "raw";
    if (filled === 0) return "other";
  }
  return byName ?? (rows > 1_000 ? "raw" : "other");
}

function rangeSource(first: TableCell, last: TableCell, quote: string, sheet: string): SourceRef {
  const from = first.source.cellRange ?? "";
  const to = last.source.cellRange ?? "";
  const range = from === to ? from : `${from}:${to}`;
  return { ...first.source, nodeId: `${first.source.nodeId}:row`, label: `${sheet}!${range}`, cellRange: range, locator: { kind: "xlsx", sheet, range }, quote };
}

/** Header rows: consecutive mostly-text rows directly above the first numeric row. */
function tablesOf(sheet: WorkbookSheet, rows: TableCell[][], sheetIndex: number, nextIndex: () => number, fileId: string, notes: Statement[]): SheetTable[] {
  const tables: SheetTable[] = [];
  let cursor = 0;
  const titleLines: string[] = [];
  while (cursor < rows.length) {
    const row = rows[cursor];
    const filled = row.filter((cell) => text(cell));
    if (filled.length === 0) { cursor += 1; continue; }
    // A lone text line is a title, a unit note or a period line.
    if (filled.length === 1 && isText(filled[0]) && !rows[cursor + 1]?.some(isNumeric)) {
      titleLines.push(text(filled[0]));
      // A lone sentence is also content: a note, a finding, an explanation.
      const quote = text(filled[0]);
      const source: SourceRef = { ...filled[0].source, locator: { kind: "xlsx", sheet: sheet.name, range: filled[0].source.cellRange ?? "" }, quote };
      notes.push({ index: nextIndex(), fileId, text: quote, tokens: contentTokens(quote), source, unit: sheetIndex, unitLabel: `${sheet.name} / ${filled[0].source.cellRange ?? ""}`, unitTitle: sheet.name, heading: false });
      cursor += 1;
      continue;
    }
    const headerStart = cursor;
    // The first text row is the header; further text rows join it only when figures follow them (stacked headers).
    cursor += 1;
    let stacked = cursor;
    while (stacked < rows.length && rows[stacked].filter((cell) => text(cell)).length >= 1 && !rows[stacked].some(isNumeric) && stacked - headerStart < 3) stacked += 1;
    if (stacked > cursor && rows[stacked]?.some(isNumeric)) cursor = stacked;
    const headerRows = rows.slice(headerStart, cursor);
    const width = Math.max(...rows.slice(headerStart, Math.min(rows.length, cursor + 5)).map((entry) => entry.length));
    const headers = Array.from({ length: width }, () => "");
    for (const headerRow of headerRows) {
      let carried = "";
      for (let column = 0; column < width; column += 1) {
        const value = text(headerRow[column]);
        // Merged parent: its label spans the empty children to its right.
        if (value) carried = headerRow[column]?.colSpan && headerRow[column].colSpan! > 1 ? value : "";
        const label = value || carried;
        if (label) headers[column] = headers[column] ? `${headers[column]} ${label}` : label;
        if (!value && !(carried && column > 0)) carried = "";
      }
    }
    const body: SheetRow[] = [];
    while (cursor < rows.length && rows[cursor].some((cell) => text(cell))) {
      const cells = rows[cursor];
      const present = cells.filter((cell) => text(cell));
      const label = text(cells.find(isText));
      const parts = cells.map((cell, column) => {
        const value = text(cell);
        if (!value) return "";
        const header = headers[column];
        return header && value !== label ? `${header} ${value}` : value;
      }).filter(Boolean);
      const quote = parts.join(" · ");
      const source = rangeSource(present[0], present.at(-1)!, quote, sheet.name);
      body.push({
        label,
        cells,
        source,
        statement: {
          index: nextIndex(),
          fileId,
          text: quote,
          tokens: contentTokens(quote),
          source,
          unit: sheetIndex,
          unitLabel: `${sheet.name} / ${source.cellRange}`,
          unitTitle: titleLines.join(" ") || sheet.name,
          heading: false,
          tableRow: true,
        },
      });
      cursor += 1;
    }
    if (body.length > 0 || headerRows.length > 0) {
      const first = (headerRows[0] ?? body[0]?.cells)?.find((cell) => text(cell));
      const lastRow = body.at(-1)?.cells ?? headerRows.at(-1)!;
      const last = [...lastRow].reverse().find((cell) => text(cell));
      const source = first && last ? rangeSource(first, last, "", sheet.name) : sheet.table.source;
      tables.push({ sheet: sheet.name, sheetIndex, title: [sheet.name, ...titleLines].join(" "), headers, rows: body, range: source.cellRange ?? "", source, summary: false });
    }
  }
  return tables;
}

/** Percent change read from a change column, or computed from a current/previous pair. */
function rowChanges(table: SheetTable): Map<SheetRow, Array<{ change: Change; cell: TableCell }>> {
  const changeColumns = table.headers.map((header, column) => /(증감률|증감율|변동률|증가율|감소율|대비|YoY|MoM|QoQ|증감|%p)/iu.test(header) ? column : -1).filter((column) => column >= 0);
  const percentOf = (cell: TableCell | undefined): number | undefined => {
    if (!cell) return undefined;
    const display = text(cell);
    const shown = /([+\-−]?\d+(?:\.\d+)?)\s?%/u.exec(display);
    if (shown) return Number(shown[1].replace("−", "-"));
    if (typeof cell.value === "number" && /%/u.test(cell.numberFormat ?? "")) return cell.value * 100;
    return undefined;
  };
  const found = new Map<SheetRow, Array<{ change: Change; cell: TableCell }>>();
  for (const column of changeColumns) {
    const values = table.rows.map((row) => percentOf(row.cells[column]));
    // Large means large for this column: at least 10%, and at least twice the typical move of the other rows.
    table.rows.forEach((row, index) => {
      const value = values[index];
      if (value === undefined || Math.abs(value) < 10) return;
      const others = values.filter((other, position): other is number => other !== undefined && position !== index).map(Math.abs).sort((a, b) => a - b);
      const typical = others.length ? others[Math.floor((others.length - 1) / 2)] : 0;
      if (Math.abs(value) < typical * 2) return;
      // Monthly rows name a period; the metric is the column group's name.
      const metric = /^(\d{1,2}월|\d{4}[.\-/]\d{1,2}|[1-4]분기|Q[1-4]|합계|계|소계|누계|total)$/iu.test(row.label)
        ? table.headers[column].replace(/(증감률|증감율|변동률|증가율|감소율|증감|전월|전년|대비|YoY|MoM|QoQ|%p|\(%\)|%)/giu, "").trim() || table.title
        : row.label;
      const subject = contentTokens(metric)[0] ?? metric;
      if (!subject) return;
      const direction = value >= 0 ? "up" : "down";
      const costLike = COST_LIKE.test(subject);
      const benefitLike = BENEFIT_LIKE.test(subject);
      const percentText = `${Math.abs(Math.round(value * 10) / 10)}%`;
      found.set(row, [...(found.get(row) ?? []), { cell: row.cells[column], change: {
        subject,
        subjectTokens: [subject],
        percent: Math.abs(value),
        percentText,
        direction,
        adverse: costLike ? direction === "up" : benefitLike ? direction === "down" : undefined,
        ...(/(전월|전년|전분기|전기)/u.exec(table.headers[column]) ? { baselinePhrase: `${/(전월|전년|전분기|전기)/u.exec(table.headers[column])![0]} 대비` } : {}),
      } }]);
    });
  }
  return found;
}

export function outlineWorkbook(document: NormalizedDocument, fileName: string): WorkbookOutline {
  const sheets = document.workbookSheets ?? [];
  let counter = 0;
  const nextIndex = () => counter++;
  const statements: Statement[] = [];
  const references: Statement[] = [];
  const tables: SheetTable[] = [];
  const manifest: SupplementSheetCoverage[] = [];

  for (const sheet of sheets) {
    const rows = sheet.table.rows;
    let filled = 0;
    let numeric = 0;
    let formulas = 0;
    let crossSheet = 0;
    for (const row of rows) for (const cell of row) {
      if (text(cell)) filled += 1;
      if (isNumeric(cell)) numeric += 1;
      if (cell.formula) {
        formulas += 1;
        if (cell.formula.includes("!")) crossSheet += 1;
      }
    }
    const hidden = sheet.visibility !== "visible";
    const role = roleOf(sheet, filled, filled ? numeric / filled : 0);
    const base = {
      name: sheet.name,
      role: ROLE_LABELS[role],
      hidden,
      rows: rows.length,
      columns: rows[0]?.length ?? 0,
      filledCells: filled,
      formulas,
      crossSheetFormulas: crossSheet,
      merges: sheet.template?.merges.length ?? 0,
    };
    const evidenceOnly = hidden || role === "raw" || role === "lookup" || role === "config" || role === "archive";
    let status: SupplementSheetStatus;
    let note: string | undefined;
    try {
      if (filled === 0) {
        status = "structure";
        note = "빈 시트";
      } else if (evidenceOnly) {
        status = "structure";
        note = hidden ? "숨김 시트 · 근거 탐색에만 사용" : "근거 탐색에만 사용";
        // Evidence: text-bearing rows only, and aggregate rows of raw data.
        let used = 0;
        const notes: Statement[] = [];
        for (const table of tablesOf(sheet, rows.slice(0, REFERENCE_ROWS), sheet.index, nextIndex, document.fileId, notes)) {
          for (const row of table.rows) {
            if (used >= REFERENCE_ROWS) break;
            if (row.cells.some(isText)) { references.push(row.statement); used += 1; }
          }
        }
        references.push(...notes);
        if (rows.length > REFERENCE_ROWS) note = `${note} (상위 ${REFERENCE_ROWS.toLocaleString("ko-KR")}행)`;
      } else {
        const read = rows.slice(0, WORKBOOK_ANALYSIS_ROWS);
        status = rows.length > WORKBOOK_ANALYSIS_ROWS ? "limited" : "detailed";
        if (status === "limited") note = `상위 ${WORKBOOK_ANALYSIS_ROWS}행만 분석`;
        const notes: Statement[] = [];
        const sheetTables = tablesOf(sheet, read, sheet.index, nextIndex, document.fileId, notes);
        statements.push(...notes);
        for (const table of sheetTables) {
          const changes = rowChanges(table);
          for (const row of table.rows) {
            statements.push(row.statement);
            // The changed cell itself is the location a reader checks, e.g. Summary / G18.
            for (const { change, cell } of changes.get(row) ?? []) {
              const address = cell.source.cellRange ?? "";
              const source: SourceRef = { ...cell.source, locator: { kind: "xlsx", sheet: sheet.name, range: address }, quote: row.statement.text };
              statements.push({ ...row.statement, index: nextIndex(), source, unitLabel: `${sheet.name} / ${address}`, change });
            }
          }
          tables.push({ ...table, summary: role === "summary" });
        }
        if (status === "limited") {
          // The rest of a long report sheet still answers the document-wide search.
          for (const table of tablesOf(sheet, rows.slice(WORKBOOK_ANALYSIS_ROWS, REFERENCE_ROWS), sheet.index, nextIndex, document.fileId, references)) {
            references.push(...table.rows.filter((row) => row.cells.some(isText)).map((row) => row.statement));
          }
        }
      }
    } catch {
      status = "failed";
      note = "시트 내용을 해석하지 못했습니다";
    }
    manifest.push({ ...base, status, ...(note ? { note } : {}) });
  }

  // The manifest is fixed from the file's own sheet list; any sheet the loop
  // did not account for is reported as failed rather than silently dropped.
  for (const meta of document.metadata.sheets ?? []) {
    if (!manifest.some((entry) => entry.name === meta.name)) {
      manifest.push({ name: meta.name, role: ROLE_LABELS.other, status: "failed", hidden: meta.visibility !== "visible", rows: meta.rowCount, columns: meta.columnCount, filledCells: 0, formulas: 0, crossSheetFormulas: 0, merges: 0, note: "시트를 읽지 못했습니다" });
    }
  }

  const count = (status: SupplementSheetStatus) => manifest.filter((entry) => entry.status === status).length;
  const notes: string[] = [];
  const detailed = count("detailed");
  const limited = count("limited");
  const failed = count("failed");
  notes.push(`Workbook 전체 ${manifest.length}개 시트의 구조를 확인했으며, 보고용 주요 영역 ${detailed + limited}개 시트를 분석했습니다.`);
  const evidenceSheets = manifest.filter((entry) => entry.status === "structure" && entry.note !== "빈 시트").map((entry) => entry.name);
  if (evidenceSheets.length) notes.push(`${evidenceSheets.slice(0, 6).join(", ")}${evidenceSheets.length > 6 ? ` 외 ${evidenceSheets.length - 6}개` : ""} 시트는 구조 확인과 근거 탐색에만 사용했습니다.`);
  if (limited) notes.push(`${manifest.filter((entry) => entry.status === "limited").map((entry) => entry.name).join(", ")} 시트는 상위 ${WORKBOOK_ANALYSIS_ROWS}행만 분석했습니다.`);
  if (failed) notes.push(`${manifest.filter((entry) => entry.status === "failed").map((entry) => entry.name).join(", ")} 시트는 분석하지 못했습니다.`);
  if (document.warnings.includes("XLSX_EXTERNAL_REFERENCE_NO_CACHE")) notes.push("저장된 결과가 없는 외부 연결 값은 읽지 못했습니다.");

  return {
    statements,
    references,
    tables,
    coverage: {
      fileId: document.fileId,
      fileName,
      kind: "xlsx",
      unit: "시트",
      total: manifest.length,
      analyzed: detailed + limited,
      // Deliberate exclusion is disclosed, not a limitation; partial and failed reads are.
      complete: limited === 0 && failed === 0,
      notes,
      sheets: manifest,
    },
  };
}
